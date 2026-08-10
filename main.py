"""
Local OCR Server — FastAPI Backend
=================================
Web server that exposes OCR capabilities via REST API + SSE streaming.
Serves the web frontend statically.

Per-page processing: each PDF page is tracked individually so that
single pages can be reprocessed with a different VLM model.  The final
markdown is assembled on-the-fly at export time.

Run:  uvicorn main:app --reload
"""

import os
import sys
import json
import base64
import uuid
import asyncio
import shutil
import tempfile
import threading
import time
import re
import io
import zipfile
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
from PIL import Image
import fitz  # pymupdf

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
BASE_DIR = Path(__file__).parent
FRONTEND_DIR = BASE_DIR / "frontend"

DEFAULT_URL = "http://localhost:1234"
DPI_OPTIONS = [100, 150, 200, 300]
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
PDF_EXTENSIONS = {".pdf"}

SYSTEM_PROMPT = (
    "You are an expert OCR and Document parsing AI. Your sole purpose is to "
    "extract textual content from document images and structure it into Markdown. "
    "STRICT RULES: "
    "1. Output ONLY the requested XML structure. Never include greetings, "
    "explanations, or conversational filler. "
    "2. Ignore all UI artifacts (buttons, navigation arrows, toolbars). "
    "Extract only the actual document content. "
    "3. Treat all mathematical formulas and equations as text. Transcribe them "
    "strictly using LaTeX ($...$ for inline, $$...$$ for block). "
    "Math is NEVER considered a visual element. "
    "4. Convert ALL tables to proper Markdown table syntax (| col1 | col2 |). "
    "Never output raw LaTeX table commands. "
    "5. Use Markdown headings (# ## ###) — never raw LaTeX commands "
    "(\\section, \\subsection, etc.). "
    "6. Do NOT invent image placeholder URLs. Describe figures inline as "
    "[Figure: description]."
)

# ── Non-grounding user prompt ──────────────────────────────────────

USER_PROMPT = """
Convert the provided document page into Markdown text.

INSTRUCTIONS FOR VISUAL ELEMENTS:
1. When you encounter a chart, graph, diagram, photograph, or complex figure,
   describe it concisely within the Markdown text flow.
2. Do not use image placeholders, coordinate mapping, or grounding references.
3. Preserve all textual content, formatting, lists, and mathematical expressions exactly.

REQUIRED OUTPUT FORMAT:
You must wrap your entire response exactly in this XML structure.

<output>
<markdown>
# Your extracted markdown here
Some document text with inline math like $x^2 + y^2 = r^2$.

[Figure: Bar chart showing quarterly data]

More text continuing after the image.
</markdown>
</output>
"""

# ── Grounding prompts (XML-structured output) ─────────────────────

GROUNDING_SYSTEM_PROMPT = (
    "You are an expert OCR and Document parsing AI. Your sole purpose is to "
    "extract textual content from document images and structure it into Markdown. "
    "STRICT RULES: "
    "1. Output ONLY the requested XML structure. Never include greetings, "
    "explanations, or conversational filler. "
    "2. Ignore all UI artifacts (buttons, navigation arrows, toolbars). "
    "Extract only the actual document content. "
    "3. Treat all mathematical formulas and equations as text. Transcribe them "
    "strictly using LaTeX ($...$ for inline, $$...$$ for block). "
    "Math is NEVER considered a visual element."
)

GROUNDING_USER_PROMPT = """
Convert the provided document page into Markdown text.

INSTRUCTIONS FOR VISUAL ELEMENTS:
1. When you encounter a chart, graph, diagram, photograph, or complex figure,
   replace it (and its caption) with a placeholder in the text:
   `![brief description](IMG_N)` where N starts at 1.
2. Limit placeholders to a maximum of 5 per page (prioritize the most
   significant ones).
3. For every `IMG_N` placeholder in your text, you must create a matching
   entry in the `<boxes>` section using normalized coordinates (0-1000).

REQUIRED OUTPUT FORMAT:
You must wrap your entire response exactly in this XML structure. For the
entries inside the `<boxes>` tag, use plain text separated by the pipe
character `|`. Do NOT use any brackets or parentheses for the coordinates.

<output>
<markdown>
# Your extracted markdown here
Some document text with inline math like $x^2 + y^2 = r^2$.

![bar chart showing quarterly data](IMG_1)

More text continuing after the image.
</markdown>
<boxes>
IMG_1 | 200,400,800,700 | bar chart showing quarterly data
</boxes>
</output>

NOTE: If the page contains only text and formulas with no figures to
preserve, output the `<markdown>` section normally and leave the
`<boxes>` section empty (<boxes></boxes>).
"""

GROUNDING_MAX_TOKENS = 32000

# ── Sampling params per risposte deterministiche ────────────────
# temperature=0 → massimo determinismo (nessuna casualità)
# top_p=0.1 → nucleus sampling molto stretto
# seed fisso → stessa risposta per lo stesso input (riproducibilità)
OCR_TEMPERATURE = 0.0
OCR_TOP_P = 0.1
OCR_SEED = 42

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def parse_page_spec(spec: str, total_pages: int) -> list[int]:
    """
    Parse a page specification string into a list of 1-based page numbers.

    Supported formats:
      "all"           -> every page
      "1,3,5-8,12"    -> pages 1, 3, 5, 6, 7, 8, 12
      "5"             -> page 5 only
      ""              -> all pages (default)
    """
    if not spec or spec.strip().lower() == "all":
        return list(range(1, total_pages + 1))

    pages: set[int] = set()
    for part in spec.split(","):
        part = part.strip()
        if not part:
            continue
        if "-" in part:
            tokens = part.split("-", 1)
            try:
                start, end = int(tokens[0]), int(tokens[1])
            except ValueError:
                raise ValueError(f"Invalid page range: '{part}'")
            if start < 1 or end < 1 or start > end:
                raise ValueError(f"Invalid page range: '{part}'")
            pages.update(range(start, end + 1))
        else:
            try:
                p = int(part)
            except ValueError:
                raise ValueError(f"Invalid page number: '{part}'")
            if p < 1:
                raise ValueError(f"Invalid page number: '{part}'")
            pages.add(p)

    pages = {p for p in pages if 1 <= p <= total_pages}
    if not pages:
        raise ValueError(
            f"No valid pages in '{spec}' for a document with {total_pages} page(s)"
        )
    return sorted(pages)


def _make_output_filename(original_filename: str) -> str:
    """Derive output .md filename from the original input filename."""
    stem = Path(original_filename).stem
    stem = "".join(c for c in stem if c not in ("/", "\\", ":", "*", "?", '"', "<", ">", "|"))
    return f"{stem}.md"


# ---------------------------------------------------------------------------
# Per-Page Result Tracking
# ---------------------------------------------------------------------------

@dataclass
class PageResult:
    """Stores the OCR result for a single page."""
    page_num: int               # 1-based page number
    markdown: str = ""          # extracted markdown text
    model: str = ""             # model used for this page
    method: str = ""            # "text_extract" | "vlm" | "vlm_grounding" | ""
    status: str = "pending"     # pending | processing | done | error
    error_msg: str = ""

    # Nuovi campi grounding
    grounding_images: list[dict] = field(default_factory=list)
    # Ogni entry: {
    #   "id": "IMG_1",
    #   "description": "bar chart showing quarterly revenue",
    #   "bbox": [x1, y1, x2, y2],       # normalizzate 0-1000
    #   "image_filename": "p1_IMG_1.png",  # page-prefixed, salvato in images/
    # }
    grounding_enabled: bool = False
    page_image_bytes: bytes = b""   # PNG bytes della pagina intera (per crop differito)

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_num": self.page_num,
            "markdown": self.markdown,
            "model": self.model,
            "method": self.method,
            "status": self.status,
            "error_msg": self.error_msg,
            "grounding_images": self.grounding_images,
            "grounding_enabled": self.grounding_enabled,
        }


# ---------------------------------------------------------------------------
# Job State Management
# ---------------------------------------------------------------------------

@dataclass
class JobState:
    job_id: str
    status: str = "pending"       # pending | processing | done | error
    filename: str = ""
    total_pages: int = 0
    processed_pages: int = 0
    message: str = ""
    output_path: str = ""
    logs: list[str] = field(default_factory=list)
    created_at: float = field(default_factory=time.time)

    # Per-page processing
    file_bytes: bytes = b""       # stored PDF bytes for reprocessing
    page_results: dict[int, PageResult] = field(default_factory=dict)

    # Grounding
    grounding_enabled: bool = False
    output_dir: str = ""          # path alla cartella grounding (se applicabile)

    def to_dict(self) -> dict[str, Any]:
        return {
            "job_id": self.job_id,
            "status": self.status,
            "filename": self.filename,
            "total_pages": self.total_pages,
            "processed_pages": self.processed_pages,
            "message": self.message,
            "output_path": self.output_path,
            "logs": self.logs,
            "created_at": self.created_at,
            "grounding_enabled": self.grounding_enabled,
            "output_dir": self.output_dir,
            "page_results": {
                str(k): v.to_dict() for k, v in self.page_results.items()
            },
        }


# In-memory job store (thread-safe dict)
jobs: dict[str, JobState] = {}
jobs_lock = threading.Lock()


def _add_log(job_id: str, msg: str):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].logs.append(msg)


def _progress(job_id: str, processed: int, total: int):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].processed_pages = processed
            jobs[job_id].total_pages = total


def _set_status(job_id: str, status: str, message: str = ""):
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].status = status
            if message:
                jobs[job_id].message = message
                if status == "done" and os.path.isfile(message):
                    jobs[job_id].output_path = message


def _ensure_page_result(job_id: str, page_num: int):
    """Ensure a PageResult exists for the given page."""
    with jobs_lock:
        if job_id in jobs:
            if page_num not in jobs[job_id].page_results:
                jobs[job_id].page_results[page_num] = PageResult(page_num=page_num)


def _update_page_result(job_id: str, page_num: int, **kwargs):
    """Update fields on an existing PageResult."""
    with jobs_lock:
        if job_id in jobs and page_num in jobs[job_id].page_results:
            pr = jobs[job_id].page_results[page_num]
            for k, v in kwargs.items():
                if hasattr(pr, k):
                    setattr(pr, k, v)


# ---------------------------------------------------------------------------
# OCR Core
# ---------------------------------------------------------------------------

# ── Regex for non-grounding XML parsing ─────────────────────────────
_NON_GROUNDING_MD_RE = re.compile(
    r'<markdown>\s*\n?(.*?)\n?\s*</markdown>',
    re.DOTALL,
)


def _parse_non_grounding_response(response_text: str) -> str:
    """
    Extract the <markdown>...</markdown> content from a non-grounding VLM response.

    On parsing failure (no XML tags found), returns the raw response as-is
    so the pipeline never breaks.
    """
    match = _NON_GROUNDING_MD_RE.search(response_text)
    if match:
        return match.group(1).strip()
    # Fallback: return raw text (model ignored XML wrapping)
    return response_text.strip()


def _get_client(url: str) -> OpenAI:
    return OpenAI(base_url=f"{url}/v1", api_key="not-needed")


def _send_page_to_vlm(image_bytes: bytes, model: str, url: str) -> str:
    client = _get_client(url)
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": USER_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]},
        ],
        max_tokens=8192,
        temperature=OCR_TEMPERATURE,
        top_p=OCR_TOP_P,
        seed=OCR_SEED,
    )
    return _parse_non_grounding_response(response.choices[0].message.content)


def _send_page_to_vlm_grounding(image_bytes: bytes, model: str, url: str) -> str:
    """Send page to VLM with grounding prompt (detects charts/figures + bounding boxes)."""
    client = _get_client(url)
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": GROUNDING_SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": GROUNDING_USER_PROMPT},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]},
        ],
        max_tokens=GROUNDING_MAX_TOKENS,
        temperature=OCR_TEMPERATURE,
        top_p=OCR_TOP_P,
        seed=OCR_SEED,
    )
    return response.choices[0].message.content


def _is_text_page(page: fitz.Page) -> bool:
    MIN_TEXT_CHARS = 20
    raw = page.get_text("text")
    return len(raw.strip()) >= MIN_TEXT_CHARS


def _process_single_page(
    doc: fitz.Document,
    page_idx: int,
    dpi: int,
    model: str,
    url: str,
    force_vlm: bool,
    job_id: str,
    grounding: bool = False,
) -> None:
    """
    Process a single PDF page and store the result in page_results.
    page_idx is 0-based.
    When grounding=True, uses the grounding prompt and parses bounding boxes.
    """
    page_num = page_idx + 1
    _ensure_page_result(job_id, page_num)
    _update_page_result(job_id, page_num, status="processing")

    page = doc[page_idx]

    try:
        if grounding:
            # ── Grounding mode ──────────────────────────────────────
            _add_log(job_id, f"[{page_num}/{doc.page_count}] Converting page {page_num} to image (grounding)...")
            pix = page.get_pixmap(dpi=dpi)
            page_bytes = pix.tobytes("png")

            _add_log(job_id, f"[{page_num}/{doc.page_count}] Sending page {page_num} to VLM ({model}, grounding)...")
            result = _send_page_to_vlm_grounding(page_bytes, model, url)

            markdown, img_metadata = parse_grounding_response(result, page_num)

            _update_page_result(
                job_id, page_num,
                markdown=markdown, model=model,
                method="vlm_grounding", status="done",
                grounding_images=img_metadata,
                grounding_enabled=True,
                page_image_bytes=page_bytes,
            )
            if img_metadata:
                _add_log(job_id, f"[{page_num}/{doc.page_count}] Grounding: {len(img_metadata)} image(s) detected")
            else:
                _add_log(job_id, f"[{page_num}/{doc.page_count}] Grounding: no visual elements (text-only)")

        elif not force_vlm and _is_text_page(page):
            text = page.get_text("text").strip()
            _update_page_result(
                job_id, page_num,
                markdown=text, model="(text-extract)",
                method="text_extract", status="done",
            )
            _add_log(job_id, f"[{page_num}/{doc.page_count}] Page {page_num}: text extracted directly")
        else:
            _add_log(job_id, f"[{page_num}/{doc.page_count}] Converting page {page_num} to image...")
            pix = page.get_pixmap(dpi=dpi)
            page_bytes = pix.tobytes("png")

            _add_log(job_id, f"[{page_num}/{doc.page_count}] Sending page {page_num} to VLM ({model})...")
            result = _send_page_to_vlm(page_bytes, model, url)
            _update_page_result(
                job_id, page_num,
                markdown=result, model=model,
                method="vlm", status="done",
            )
    except Exception as exc:
        _update_page_result(job_id, page_num, status="error", error_msg=str(exc))
        _add_log(job_id, f"[Error] Page {page_num}: {exc}")


def _merge_page_results(job_id: str) -> str:
    """
    Merge all page results (in page order) into a single markdown string.
    Returns the merged text.
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return ""

    parts: list[str] = []
    for pn in sorted(job.page_results.keys()):
        pr = job.page_results[pn]
        if pr.markdown:
            parts.append(pr.markdown)
        elif pr.status == "error":
            parts.append(f"\n\n<!-- Page {pn}: error — {pr.error_msg} -->\n\n")
        else:
            parts.append(f"\n\n<!-- Page {pn}: not processed -->\n\n")
    return "\n\n".join(parts)


def _write_merged_output(job_id: str) -> str:
    """Merge page results and write to outputs/ directory. Returns file path."""
    merged = _merge_page_results(job_id)
    output_dir = BASE_DIR / "outputs"
    output_dir.mkdir(exist_ok=True)

    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return ""

    out_filename = _make_output_filename(job.filename)
    output_path = str(output_dir / out_filename)
    with open(output_path, "w", encoding="utf-8") as fh:
        fh.write(merged)
    return output_path


# ---------------------------------------------------------------------------
# Grounding: parsing, cropping, output
# ---------------------------------------------------------------------------

_BOX_ENTRY_RE = re.compile(
    r'IMG_(\d+)\s*\|\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\|\s*(.+?)\s*$',
    re.MULTILINE,
)

# Regex to extract <markdown>...</markdown> and <boxes>...</boxes> sections
_XML_MARKDOWN_RE = re.compile(
    r'<markdown>\s*\n?(.*?)\n?\s*</markdown>',
    re.DOTALL,
)
_XML_BOXES_RE = re.compile(
    r'<boxes>\s*\n?(.*?)\n?\s*</boxes>',
    re.DOTALL,
)


def parse_grounding_response(response_text: str, page_num: int = 1) -> tuple[str, list[dict]]:
    """
    Parse the XML-structured grounding response from the VLM.

    Expected format:
    <output>
    <markdown>...markdown text...</markdown>
    <boxes>
      IMG_1 | x1,y1,x2,y2 | description
    </boxes>
    </output>

    Returns (markdown_text, list_of_image_metadata).
    On any parsing failure, falls back to (response_text, []) — i.e. classic OCR.

    Each image gets a page-prefixed filename (e.g. p1_IMG_1.png) so that
    IMG_1 on page 1 and IMG_1 on page 2 never collide.
    """
    # 1. Extract <markdown> section
    md_match = _XML_MARKDOWN_RE.search(response_text)
    if not md_match:
        # No XML delimiters → fallback to classic OCR
        return (response_text, [])

    markdown = md_match.group(1).strip()

    # 2. Extract <boxes> section
    boxes_match = _XML_BOXES_RE.search(response_text)
    if not boxes_match:
        # No boxes section → text only, no images
        return (markdown, [])

    boxes_text = boxes_match.group(1).strip()
    if not boxes_text:
        return (markdown, [])

    # 3. Parse box entries — use page-prefixed filenames to avoid cross-page collisions
    entries: list[dict] = []
    for m in _BOX_ENTRY_RE.finditer(boxes_text):
        img_num, x1, y1, x2, y2, desc = m.groups()
        x1, y1, x2, y2 = int(x1), int(y1), int(x2), int(y2)

        # Validate coordinates in range 0-1000
        if not all(0 <= c <= 1000 for c in (x1, y1, x2, y2)):
            print(f"[Grounding] Warning: coords out of range IMG_{img_num}, skipping")
            continue

        img_id = f"IMG_{img_num}"
        # Page-prefixed filename: p1_IMG_1.png, p2_IMG_1.png, etc.
        prefixed_filename = f"p{page_num}_{img_id}.png"
        entries.append({
            "id": img_id,
            "description": desc.strip(),
            "bbox": [x1, y1, x2, y2],
            "image_filename": prefixed_filename,
        })

    # 4. Safety: max 5 boxes per page
    if len(entries) > 5:
        print(f"[Grounding] Warning: {len(entries)} boxes, truncating to 5")
        entries = entries[:5]

    # 5. Cross-reference: every placeholder in markdown should have a box
    placeholder_nums = {m.group(1) for m in re.finditer(r"IMG_(\d+)", markdown)}
    box_nums = {e["id"] for e in entries}
    unmatched = placeholder_nums - {e["id"].split("_")[1] for e in entries}
    if unmatched:
        print(f"[Grounding] Warning: placeholders without box: {unmatched}")

    return (markdown, entries)


def crop_page_image(page_bytes: bytes, bbox: tuple, dpi: int) -> bytes:
    """
    Crop a page PNG using normalized bbox coordinates (0-1000).

    Returns PNG bytes of the cropped region.
    On error, returns the full page as fallback.
    """
    try:
        img = Image.open(io.BytesIO(page_bytes))
        W, H = img.size

        x1, y1, x2, y2 = bbox

        # Map normalized coords to pixel coords
        px1 = int(x1 / 1000 * W)
        py1 = int(y1 / 1000 * H)
        px2 = int(x2 / 1000 * W)
        py2 = int(y2 / 1000 * H)

        # Apply 5% padding for safety margin
        pad_x = int((px2 - px1) * 0.05)
        pad_y = int((py2 - py1) * 0.05)
        px1 = max(0, px1 - pad_x)
        py1 = max(0, py1 - pad_y)
        px2 = min(W, px2 + pad_x)
        py2 = min(H, py2 + pad_y)

        # Clamp to image bounds
        px1, py1 = max(0, px1), max(0, py1)
        px2, py2 = min(W, px2), min(H, py2)

        cropped = img.crop((px1, py1, px2, py2))
        buf = io.BytesIO()
        cropped.save(buf, format="PNG")
        return buf.getvalue()

    except Exception as exc:
        print(f"[Grounding] Crop error: {exc} — returning full page as fallback")
        return page_bytes


def _write_grounding_output(job_id: str) -> str:
    """
    Write grounding output: crop images from bounding boxes and assemble
    extracted.md with placeholders. Returns path to the output directory.

    Images are saved with page-prefixed filenames (p1_IMG_1.png, p2_IMG_1.png…)
    so that the VLM's per-page numbering never collides across pages.
    No global rename map is needed.
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        return ""

    output_base = BASE_DIR / "outputs"
    stem = Path(job.filename).stem
    stem = "".join(c for c in stem if c not in ("/", "\\", ":", "*", "?", '"', "<", ">", "|"))
    out_dir = output_base / f"{stem}_grounding"
    images_dir = out_dir / "images"
    images_dir.mkdir(parents=True, exist_ok=True)

    # ── Phase 1: crop and save all grounding images ──────────────────────
    # Build a lookup: page_num -> { "IMG_1": "p1_IMG_1.png", … }
    # so we can replace placeholders in markdown per-page.
    page_img_map: dict[int, dict[str, str]] = {}

    for pn in sorted(job.page_results.keys()):
        pr = job.page_results[pn]
        if not pr.grounding_enabled or not pr.grounding_images:
            continue

        page_img_map[pn] = {}
        for entry in pr.grounding_images:
            img_id = entry["id"]            # e.g. "IMG_1" (VLM per-page label)
            out_filename = entry["image_filename"]  # e.g. "p1_IMG_1.png"
            bbox = tuple(entry["bbox"])

            # Crop from stored page image bytes
            if pr.page_image_bytes:
                cropped_bytes = crop_page_image(pr.page_image_bytes, bbox, 150)
            else:
                cropped_bytes = b""  # fallback: empty

            # Save cropped image with page-prefixed name
            out_path = images_dir / out_filename
            with open(out_path, "wb") as fh:
                fh.write(cropped_bytes)

            page_img_map[pn][img_id] = out_filename

    # ── Phase 2: assemble markdown, replacing placeholders per-page ──────
    md_parts: list[str] = []
    for pn in sorted(job.page_results.keys()):
        pr = job.page_results[pn]
        if pr.markdown:
            page_md = pr.markdown
            # Replace ](IMG_N) → ](images/pN_IMG_N.png) only for this page
            if pn in page_img_map:
                for old_id, out_filename in page_img_map[pn].items():
                    page_md = re.sub(
                        rf"\]\(({re.escape(old_id)})\)",
                        f"](images/{out_filename})",
                        page_md,
                    )
            md_parts.append(page_md)
        elif pr.status == "error":
            md_parts.append(f"\n\n<!-- Page {pn}: error — {pr.error_msg} -->\n\n")

    markdown_text = "\n\n".join(md_parts)

    # Write extracted.md
    md_path = out_dir / "extracted.md"
    with open(md_path, "w", encoding="utf-8") as fh:
        fh.write(markdown_text)

    with jobs_lock:
        job.output_dir = str(out_dir)

    return str(out_dir)


# ---------------------------------------------------------------------------
# Job Workers
# ---------------------------------------------------------------------------

def process_image(
    file_bytes: bytes,
    model: str,
    url: str,
    job_id: str,
    filename: str,
) -> str:
    """OCR a single image file."""
    _add_log(job_id, "[Start] Processing image...")
    _ensure_page_result(job_id, 1)
    _update_page_result(job_id, 1, status="processing")

    try:
        result = _send_page_to_vlm(file_bytes, model, url)
        _update_page_result(
            job_id, 1,
            markdown=result, model=model,
            method="vlm", status="done",
        )
        _add_log(job_id, "[Success] Image processed")
    except Exception as exc:
        _update_page_result(job_id, 1, status="error", error_msg=str(exc))
        _add_log(job_id, f"[Error] Image processing failed: {exc}")

    # Write merged output (just 1 page)
    output_path = _write_merged_output(job_id)
    _add_log(job_id, f"[Success] File saved to {output_path}")
    return output_path


def process_pdf(
    file_bytes: bytes,
    dpi: int,
    model: str,
    url: str,
    force_vlm: bool,
    job_id: str,
    filename: str,
    page_spec: str,
    grounding: bool = False,
):
    """
    Process a PDF — hybrid text extraction + VLM for scanned pages.
    Each page result is stored individually in page_results.
    """
    tmpdir = None
    try:
        tmpdir = tempfile.mkdtemp(prefix="myocr_")
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        pages = len(doc)

        if pages == 0:
            _add_log(job_id, "[Error] PDF has 0 pages")
            _set_status(job_id, "error", "PDF has 0 pages")
            return ""

        # Store file bytes for potential reprocessing
        with jobs_lock:
            if job_id in jobs:
                jobs[job_id].file_bytes = file_bytes
                jobs[job_id].grounding_enabled = grounding

        _progress(job_id, 0, pages)
        _add_log(job_id, f"[Start] Processing PDF ({pages} page(s))...")

        selected_pages = parse_page_spec(page_spec, pages)
        if len(selected_pages) < pages:
            _add_log(job_id, f"[Info] Selected pages: {selected_pages} (of {pages})")
        else:
            _add_log(job_id, f"[Info] Processing all {pages} pages")

        # Initialize all pages as pending
        for i in range(pages):
            pn = i + 1
            _ensure_page_result(job_id, pn)
            if pn not in selected_pages:
                _update_page_result(job_id, pn, status="done", markdown="", method="skipped")
                _add_log(job_id, f"[{pn}/{pages}] Page {pn}: skipped")

        vlm_pages = 0
        text_pages = 0
        processed = 0

        for i in range(pages):
            pn = i + 1
            if pn not in selected_pages:
                processed += 1
                _progress(job_id, processed, pages)
                continue

            _process_single_page(doc, i, dpi, model, url, force_vlm, job_id, grounding)

            with jobs_lock:
                pr = jobs[job_id].page_results.get(pn)
            if pr and pr.method == "vlm":
                vlm_pages += 1
            elif pr and pr.method == "text_extract":
                text_pages += 1

            processed += 1
            _progress(job_id, processed, pages)

        # Merge and write output
        if grounding:
            output_path = _write_grounding_output(job_id)
            _add_log(job_id, (
                f"[Info] Done (grounding) — {text_pages} page(s) via text extraction, "
                f"{vlm_pages} page(s) via VLM."
            ))
        else:
            output_path = _write_merged_output(job_id)
            _add_log(job_id, (
                f"[Info] Done — {text_pages} page(s) via text extraction, "
                f"{vlm_pages} page(s) via VLM."
            ))
        _add_log(job_id, f"[Success] File saved to {output_path}")
        _set_status(job_id, "done", output_path)
        return output_path

    except Exception as exc:
        _add_log(job_id, f"[Error] {exc}")
        _set_status(job_id, "error", str(exc))
        return ""
    finally:
        if tmpdir and os.path.exists(tmpdir):
            shutil.rmtree(tmpdir)


def run_ocr_job(
    job_id: str,
    file_bytes: bytes,
    ext: str,
    model: str,
    url: str,
    dpi: int,
    force_vlm: bool,
    filename: str,
    page_spec: str,
    grounding: bool = False,
):
    """Top-level worker: dispatch to image or PDF handler."""
    _set_status(job_id, "processing")

    try:
        if ext in IMAGE_EXTENSIONS:
            output = process_image(file_bytes, model, url, job_id, filename)
            _set_status(job_id, "done", output)
            _progress(job_id, 1, 1)
        elif ext in PDF_EXTENSIONS:
            output = process_pdf(file_bytes, dpi, model, url, force_vlm, job_id, filename, page_spec, grounding)
        else:
            _set_status(job_id, "error", f"Unsupported file type: {ext}")
    except Exception as exc:
        _add_log(job_id, f"[Error] {exc}")
        _set_status(job_id, "error", str(exc))


# ---------------------------------------------------------------------------
# FastAPI Application
# ---------------------------------------------------------------------------

app = FastAPI(
    title="Local OCR Server",
    description="OCR via local Vision Language Model (LM Studio)",
    version="2.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

if (FRONTEND_DIR / "index.html").exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ── Frontend ──────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return index_path.read_text(encoding="utf-8")
    return HTMLResponse("<h1>Local OCR Server</h1><p>Frontend not found.</p>")


# ── Health ────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "2.1.0"}


# ── Models ────────────────────────────────────────────────────────────────

@app.get("/api/models")
async def list_models(url: str = DEFAULT_URL):
    try:
        client = _get_client(url)
        models = client.models.list()
        return {"models": [m.id for m in models]}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cannot reach VLM server: {exc}")


# ── File Preview ──────────────────────────────────────────────────────────

PREVIEW_DPI = 100
MAX_PREVIEW_PAGES = 20

# In-memory cache per PDF preview (job_id -> (file_bytes, ext))
preview_cache: dict[str, tuple[bytes, str]] = {}


@app.post("/api/preview")
async def preview_file(file: UploadFile = File(...)):
    contents = await file.read()
    ext = os.path.splitext(file.filename or "")[1].lower()

    if ext not in IMAGE_EXTENSIONS and ext not in PDF_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}'")

    if ext in IMAGE_EXTENSIONS:
        b64 = base64.b64encode(contents).decode("utf-8")
        return {
            "type": "image",
            "filename": file.filename,
            "pages": 1,
            "thumbnails": [f"data:image/png;base64,{b64}"],
        }

    try:
        doc = fitz.open(stream=contents, filetype="pdf")
        total = len(doc)
        count = min(total, MAX_PREVIEW_PAGES)
        thumbnails: list[str] = []

        for i in range(count):
            page = doc[i]
            pix = page.get_pixmap(dpi=PREVIEW_DPI)
            img_bytes = pix.tobytes("png")
            b64 = base64.b64encode(img_bytes).decode("utf-8")
            thumbnails.append(f"data:image/png;base64,{b64}")

        # Cache PDF bytes for on-demand thumbnail generation
        preview_cache[file.filename] = (contents, ext)

        return {
            "type": "pdf",
            "filename": file.filename,
            "pages": total,
            "thumbnails": thumbnails,
            "total_pages": total,
            "preview_pages": count,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Preview error: {exc}")


# ── PDF Info (total pages) ──────────────────────────────────────

@app.get("/api/pdf-info")
async def pdf_info(filename: str):
    """Return total page count for a cached PDF."""
    if filename not in preview_cache:
        raise HTTPException(status_code=404, detail="PDF not found in cache")
    file_bytes, ext = preview_cache[filename]
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        total = len(doc)
        return {"filename": filename, "total_pages": total}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"PDF error: {exc}")


# ── Single Page Thumbnail (lazy load) ───────────────────────────

@app.get("/api/pdf-page")
async def pdf_page(filename: str, page_num: int, dpi: int = PREVIEW_DPI):
    """
    Return a single page thumbnail as a data-URI.
    Used for lazy-loading pages beyond the initial preview batch.
    page_num is 1-based.
    """
    if filename not in preview_cache:
        raise HTTPException(status_code=404, detail="PDF not found in cache")
    file_bytes, ext = preview_cache[filename]
    try:
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        total = len(doc)
        if page_num < 1 or page_num > total:
            raise HTTPException(
                status_code=400,
                detail=f"Page {page_num} out of range (1-{total})",
            )
        page = doc[page_num - 1]
        pix = page.get_pixmap(dpi=dpi)
        img_bytes = pix.tobytes("png")
        b64 = base64.b64encode(img_bytes).decode("utf-8")
        return {"page_num": page_num, "data_uri": f"data:image/png;base64,{b64}"}
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Page render error: {exc}")


# ── OCR Job ───────────────────────────────────────────────────────────────

@app.post("/api/ocr")
async def start_ocr(
    file: UploadFile = File(...),
    model: str = Form(""),
    url: str = Form(DEFAULT_URL),
    dpi: int = Form(150),
    force_vlm: bool = Form(False),
    page_spec: str = Form("all"),
    grounding: bool = Form(False),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    if not model:
        raise HTTPException(status_code=400, detail="Model is required")

    contents = await file.read()
    ext = os.path.splitext(file.filename or "")[1].lower()

    if ext not in IMAGE_EXTENSIONS and ext not in PDF_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Supported: PDF, PNG, JPG, JPEG, WebP",
        )

    job_id = str(uuid.uuid4())[:8]
    with jobs_lock:
        jobs[job_id] = JobState(
            job_id=job_id,
            filename=file.filename or "unknown",
        )

    background_tasks.add_task(
        run_ocr_job,
        job_id=job_id,
        file_bytes=contents,
        ext=ext,
        model=model,
        url=url,
        dpi=dpi,
        force_vlm=force_vlm,
        filename=file.filename or "unknown",
        page_spec=page_spec,
        grounding=grounding,
    )

    return {"job_id": job_id}


# ── Job Status ────────────────────────────────────────────────────────────

@app.get("/api/status/{job_id}")
async def get_job_status(job_id: str):
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


# ── Per-Page Status ───────────────────────────────────────────────────────

@app.get("/api/pages/{job_id}")
async def get_page_results(job_id: str):
    """
    Return per-page processing results for a job.
    Each entry contains: page_num, markdown, model, method, status, error_msg.
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    results = []
    for pn in sorted(job.page_results.keys()):
        results.append(job.page_results[pn].to_dict())
    return {"job_id": job_id, "total_pages": job.total_pages, "pages": results}


# ── Reprocess Single Page ────────────────────────────────────────────────

@app.post("/api/reprocess/{job_id}")
async def reprocess_page(
    job_id: str,
    page_num: int = Form(1),
    model: str = Form(""),
    url: str = Form(DEFAULT_URL),
    dpi: int = Form(150),
):
    """
    Reprocess a single page of an existing PDF job with a (possibly different) model.
    The page's markdown result is replaced in-place.
    Respects the original job's grounding setting: if the job was grounding-enabled,
    the reprocessed page is sent through the grounding VLM pipeline and the
    grounding output directory is rewritten so downloads reflect the change.
    """
    if not model:
        raise HTTPException(status_code=400, detail="Model is required")

    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")

    if not job.file_bytes:
        raise HTTPException(status_code=400, detail="No PDF data available for reprocessing")

    if page_num < 1 or page_num > job.total_pages:
        raise HTTPException(
            status_code=400,
            detail=f"Page {page_num} is out of range (1-{job.total_pages})",
        )

    grounding = job.grounding_enabled

    # Open the stored PDF and process the requested page
    try:
        doc = fitz.open(stream=job.file_bytes, filetype="pdf")
        page_idx = page_num - 1

        _add_log(job_id, f"[Reprocess] Page {page_num} with model {model}{' (grounding)' if grounding else ''}...")
        _ensure_page_result(job_id, page_num)
        _update_page_result(job_id, page_num, status="processing")

        page = doc[page_idx]
        pix = page.get_pixmap(dpi=dpi)
        page_bytes = pix.tobytes("png")

        if grounding:
            # ── Grounding mode: use grounding VLM + rewrite grounding output ──
            result = _send_page_to_vlm_grounding(page_bytes, model, url)
            markdown, img_metadata = parse_grounding_response(result, page_num)

            _update_page_result(
                job_id, page_num,
                markdown=markdown, model=model,
                method="vlm_grounding", status="done",
                grounding_images=img_metadata,
                grounding_enabled=True,
                page_image_bytes=page_bytes,
            )
            if img_metadata:
                _add_log(job_id, f"[Reprocess] Grounding: {len(img_metadata)} image(s) detected")
            else:
                _add_log(job_id, f"[Reprocess] Grounding: no visual elements (text-only)")

            # Rewrite the grounding output directory so downloads are up-to-date
            output_path = _write_grounding_output(job_id)
            _add_log(job_id, f"[Success] Page {page_num} reprocessed (grounding) → {output_path}")
        else:
            # ── Classic (non-grounding) mode ──────────────────────────────
            result = _send_page_to_vlm(page_bytes, model, url)
            _update_page_result(
                job_id, page_num,
                markdown=result, model=model,
                method="vlm", status="done",
            )

            # Rewrite merged output
            output_path = _write_merged_output(job_id)
            _add_log(job_id, f"[Success] Page {page_num} reprocessed with {model} → {output_path}")

        return {
            "status": "ok",
            "page_num": page_num,
            "model": model,
            "output_path": output_path,
        }
    except Exception as exc:
        _add_log(job_id, f"[Error] Reprocess page {page_num}: {exc}")
        _update_page_result(job_id, page_num, status="error", error_msg=str(exc))
        raise HTTPException(status_code=500, detail=f"Reprocess failed: {exc}")


# ── SSE Stream ────────────────────────────────────────────────────────────

async def event_stream(job_id: str):
    end_statuses = {"done", "error"}
    while True:
        with jobs_lock:
            job = jobs.get(job_id)
        if not job:
            yield f"data: {json.dumps({'type': 'error', 'message': 'Job not found'})}\n\n"
            break
        if job.status in end_statuses:
            yield f"data: {json.dumps(job.to_dict())}\n\n"
            break
        yield f"data: {json.dumps(job.to_dict())}\n\n"
        await asyncio.sleep(0.5)


@app.get("/api/stream/{job_id}")
async def stream_status(job_id: str):
    return StreamingResponse(
        event_stream(job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Download result (merged on-the-fly) ───────────────────────────────────

@app.get("/api/download/{job_id}")
async def download_result(job_id: str):
    """
    Download the OCR output.
    - Grounding jobs: returns a ZIP containing extracted.md + images/
    - Classic jobs: returns the .md file directly
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    if job.status in ("pending", "processing"):
        raise HTTPException(status_code=409, detail=f"Job '{job_id}' is still {job.status}.")
    if job.status == "error":
        raise HTTPException(status_code=422, detail=f"Job failed: {job.message}")

    if job.grounding_enabled and job.output_dir and os.path.isdir(job.output_dir):
        # Return ZIP of the grounding output directory
        stem = Path(job.filename).stem
        stem = "".join(c for c in stem if c not in ("/", "\\", ":", "*", "?", '"', "<", ">", "|"))
        zip_filename = f"{stem}_grounding.zip"

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
            out_dir = Path(job.output_dir)
            for fpath in out_dir.rglob("*"):
                if fpath.is_file():
                    arcname = str(fpath.relative_to(out_dir))
                    zf.write(fpath, arcname)
        buf.seek(0)

        return StreamingResponse(
            buf,
            media_type="application/zip",
            headers={"Content-Disposition": f"attachment; filename={zip_filename}"},
        )

    # Classic: regenerate merged output from current page results
    output_path = _write_merged_output(job_id)
    if not output_path or not os.path.isfile(output_path):
        raise HTTPException(status_code=404, detail="No output file available.")

    filename = os.path.basename(output_path)
    return FileResponse(
        path=output_path,
        filename=filename,
        media_type="text/markdown",
    )


# ── Download single grounding image ──────────────────────────────────────

@app.get("/api/download-image/{job_id}/{img_filename}")
async def download_grounding_image(
    job_id: str,
    img_filename: str,
    page_num: int = 0,  # 0 = auto-search; N = specific page (1-based)
):
    """
    Return a single cropped image from a grounding job.
    Used by the frontend to render images inline in the markdown preview.

    When page_num > 0, crops directly from that page (avoids IMG_N collisions
    across pages — the VLM always starts numbering from IMG_1 per page).
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")

    if not job.grounding_enabled:
        raise HTTPException(status_code=400, detail="Grounding not enabled for this job.")

    # ── Case 1: specific page requested → crop on-the-fly ─────────
    if page_num > 0:
        pr = job.page_results.get(page_num)
        if pr and pr.grounding_images and pr.page_image_bytes:
            for entry in pr.grounding_images:
                if entry["image_filename"] == img_filename:
                    cropped = crop_page_image(
                        pr.page_image_bytes, tuple(entry["bbox"]), 150,
                    )
                    return StreamingResponse(
                        io.BytesIO(cropped),
                        media_type="image/png",
                        headers={"Content-Disposition": f"inline; filename={img_filename}"},
                    )

    # ── Case 2: look in output directory (post-job) ──────────────
    if job.output_dir and os.path.isdir(job.output_dir):
        img_path = Path(job.output_dir) / "images" / img_filename
        if img_path.is_file():
            return FileResponse(
                path=str(img_path),
                media_type="image/png",
                filename=img_filename,
            )

    # ── Case 3: search all pages (fallback) ──────────────────────
    for pn, pr in job.page_results.items():
        if pr.grounding_images and pr.page_image_bytes:
            for entry in pr.grounding_images:
                if entry["image_filename"] == img_filename:
                    cropped = crop_page_image(
                        pr.page_image_bytes, tuple(entry["bbox"]), 150,
                    )
                    return StreamingResponse(
                        io.BytesIO(cropped),
                        media_type="image/png",
                        headers={"Content-Disposition": f"inline; filename={img_filename}"},
                    )

    raise HTTPException(status_code=404, detail=f"Image '{img_filename}' not found.")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=True)
