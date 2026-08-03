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
from pathlib import Path
from dataclasses import dataclass, field
from typing import Any

from fastapi import FastAPI, UploadFile, File, Form, HTTPException, BackgroundTasks, Request
from fastapi.responses import FileResponse, HTMLResponse, StreamingResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from openai import OpenAI
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
    "Convert this image into Markdown text format. Your task is to perform "
    "high-accuracy Optical Character Recognition (OCR). Preserve the document's "
    "structure as accurately as possible: headers, lists, and tables. Do not add "
    "any greetings, explanations, or introductory/concluding remarks. Output only "
    "the raw recognized text."
)

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
    method: str = ""            # "text_extract" | "vlm" | ""
    status: str = "pending"     # pending | processing | done | error
    error_msg: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "page_num": self.page_num,
            "markdown": self.markdown,
            "model": self.model,
            "method": self.method,
            "status": self.status,
            "error_msg": self.error_msg,
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
                {"type": "text", "text": "Extract the text from this image."},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]},
        ],
        max_tokens=8192,
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
) -> None:
    """
    Process a single PDF page and store the result in page_results.
    page_idx is 0-based.
    """
    page_num = page_idx + 1
    _ensure_page_result(job_id, page_num)
    _update_page_result(job_id, page_num, status="processing")

    page = doc[page_idx]

    try:
        if not force_vlm and _is_text_page(page):
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

            _process_single_page(doc, i, dpi, model, url, force_vlm, job_id)

            with jobs_lock:
                pr = jobs[job_id].page_results.get(pn)
            if pr and pr.method == "vlm":
                vlm_pages += 1
            elif pr and pr.method == "text_extract":
                text_pages += 1

            processed += 1
            _progress(job_id, processed, pages)

        # Merge and write output
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
):
    """Top-level worker: dispatch to image or PDF handler."""
    _set_status(job_id, "processing")

    try:
        if ext in IMAGE_EXTENSIONS:
            output = process_image(file_bytes, model, url, job_id, filename)
            _set_status(job_id, "done", output)
            _progress(job_id, 1, 1)
        elif ext in PDF_EXTENSIONS:
            output = process_pdf(file_bytes, dpi, model, url, force_vlm, job_id, filename, page_spec)
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

        return {
            "type": "pdf",
            "filename": file.filename,
            "pages": total,
            "thumbnails": thumbnails,
        }
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Preview error: {exc}")


# ── OCR Job ───────────────────────────────────────────────────────────────

@app.post("/api/ocr")
async def start_ocr(
    file: UploadFile = File(...),
    model: str = Form(""),
    url: str = Form(DEFAULT_URL),
    dpi: int = Form(150),
    force_vlm: bool = Form(False),
    page_spec: str = Form("all"),
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

    # Open the stored PDF and process the requested page
    try:
        doc = fitz.open(stream=job.file_bytes, filetype="pdf")
        page_idx = page_num - 1

        _add_log(job_id, f"[Reprocess] Page {page_num} with model {model}...")
        _ensure_page_result(job_id, page_num)
        _update_page_result(job_id, page_num, status="processing")

        page = doc[page_idx]
        pix = page.get_pixmap(dpi=dpi)
        page_bytes = pix.tobytes("png")

        result = _send_page_to_vlm(page_bytes, model, url)
        _update_page_result(
            job_id, page_num,
            markdown=result, model=model,
            method="vlm", status="done",
        )
        _add_log(job_id, f"[Success] Page {page_num} reprocessed with {model}")

        # Rewrite merged output
        output_path = _write_merged_output(job_id)
        _add_log(job_id, f"[Success] Merged output saved to {output_path}")

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
    Download the OCR output.  The merged markdown is regenerated on-the-fly
    from all per-page results so that any reprocessed pages are included.
    """
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found.")
    if job.status in ("pending", "processing"):
        raise HTTPException(status_code=409, detail=f"Job '{job_id}' is still {job.status}.")
    if job.status == "error":
        raise HTTPException(status_code=422, detail=f"Job failed: {job.message}")

    # Regenerate merged output from current page results
    output_path = _write_merged_output(job_id)
    if not output_path or not os.path.isfile(output_path):
        raise HTTPException(status_code=404, detail="No output file available.")

    filename = os.path.basename(output_path)
    return FileResponse(
        path=output_path,
        filename=filename,
        media_type="text/markdown",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=True)
