"""
Local OCR Server — FastAPI Backend
=================================
Web server that exposes OCR capabilities via REST API + SSE streaming.
Serves the web frontend statically.

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
        }


# In-memory job store (thread-safe dict)
jobs: dict[str, JobState] = {}
jobs_lock = threading.Lock()


def _add_log(job_id: str, msg: str):
    """Append a log line to a job."""
    with jobs_lock:
        if job_id in jobs:
            jobs[job_id].logs.append(msg)


def _progress(job_id: str, processed: int, total: int):
    """Update progress counters."""
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
                # If status is "done" and message is a valid file path, store it as output_path
                if status == "done" and os.path.isfile(message):
                    jobs[job_id].output_path = message


# ---------------------------------------------------------------------------
# OCR Core (moved from Tkinter workers)
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


def _make_output_filename(original_filename: str) -> str:
    """Derive output .md filename from the original input filename."""
    stem = Path(original_filename).stem
    # Sanitize: remove any path separators or dangerous chars
    stem = "".join(c for c in stem if c not in ("/", "\\", ":", "*", "?", '"', "<", ">", "|"))
    return f"{stem}.md"


def process_image(
    file_bytes: bytes,
    model: str,
    url: str,
    job_id: str,
    filename: str,
) -> str:
    """
    OCR a single image. Returns the output .md file path.
    """
    _add_log(job_id, "[Start] Processing image...")
    result = _send_page_to_vlm(file_bytes, model, url)

    # Write to temp output dir
    output_dir = BASE_DIR / "outputs"
    output_dir.mkdir(exist_ok=True)
    output_path = str(output_dir / _make_output_filename(filename))
    with open(output_path, "w", encoding="utf-8") as fh:
        fh.write(result)

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
):
    """
    Process a PDF — hybrid text extraction + VLM for scanned pages.
    Returns the output .md file path.
    """
    tmpdir = None
    output_dir = BASE_DIR / "outputs"
    output_dir.mkdir(exist_ok=True)

    try:
        tmpdir = tempfile.mkdtemp(prefix="myocr_")
        doc = fitz.open(stream=file_bytes, filetype="pdf")
        pages = len(doc)

        if pages == 0:
            _add_log(job_id, "[Error] PDF has 0 pages")
            _set_status(job_id, "error", "PDF has 0 pages")
            return ""

        _progress(job_id, 0, pages)
        _add_log(job_id, f"[Start] Processing PDF ({pages} page(s))...")

        all_text: list[str] = []
        vlm_pages = 0
        text_pages = 0

        for i in range(pages):
            page = doc[i]

            if not force_vlm and _is_text_page(page):
                text = page.get_text("text").strip()
                all_text.append(text)
                text_pages += 1
                _progress(job_id, i + 1, pages)
                _add_log(job_id, f"[{i + 1}/{pages}] Page {i + 1}: text extracted directly")
            else:
                vlm_pages += 1
                _add_log(job_id, f"[{i + 1}/{pages}] Converting page {i + 1} to image...")
                pix = page.get_pixmap(dpi=dpi)
                page_path = os.path.join(tmpdir, f"page_{i + 1}.png")
                pix.save(page_path)

                _add_log(job_id, f"[{i + 1}/{pages}] Sending page {i + 1} to VLM...")
                with open(page_path, "rb") as fh:
                    page_bytes = fh.read()
                result = _send_page_to_vlm(page_bytes, model, url)
                all_text.append(result)
                _progress(job_id, i + 1, pages)

        full_text = "\n\n".join(all_text)
        output_path = str(output_dir / _make_output_filename(filename))
        with open(output_path, "w", encoding="utf-8") as fh:
            fh.write(full_text)

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
):
    """
    Top-level worker: dispatch to image or PDF handler.
    Called from a BackgroundTasks (asyncio threadpool).
    """
    _set_status(job_id, "processing")

    try:
        if ext in IMAGE_EXTENSIONS:
            output = process_image(file_bytes, model, url, job_id, filename)
            _set_status(job_id, "done", output)
            _progress(job_id, 1, 1)
        elif ext in PDF_EXTENSIONS:
            output = process_pdf(file_bytes, dpi, model, url, force_vlm, job_id, filename)
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
    version="2.0.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Serve frontend static files
if (FRONTEND_DIR / "index.html").exists():
    app.mount("/static", StaticFiles(directory=str(FRONTEND_DIR)), name="static")


# ── Frontend ──────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def serve_frontend():
    """Serve the web frontend."""
    index_path = FRONTEND_DIR / "index.html"
    if index_path.exists():
        return index_path.read_text(encoding="utf-8")
    return HTMLResponse("<h1>Local OCR Server</h1><p>Frontend not found.</p>")


# ── Health ────────────────────────────────────────────────────────────────

@app.get("/api/health")
async def health():
    return {"status": "ok", "version": "2.0.0"}


# ── Models ────────────────────────────────────────────────────────────────

@app.get("/api/models")
async def list_models(url: str = DEFAULT_URL):
    """Fetch available models from the VLM server."""
    try:
        client = _get_client(url)
        models = client.models.list()
        return {"models": [m.id for m in models]}
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Cannot reach VLM server: {exc}")


# ── OCR Job ───────────────────────────────────────────────────────────────

@app.post("/api/ocr")
async def start_ocr(
    file: UploadFile = File(...),
    model: str = Form(""),
    url: str = Form(DEFAULT_URL),
    dpi: int = Form(150),
    force_vlm: bool = Form(False),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    """
    Upload a file and start an OCR job.
    Returns a job_id to poll for status.
    """
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
    )

    return {"job_id": job_id}


# ── Job Status ────────────────────────────────────────────────────────────

@app.get("/api/status/{job_id}")
async def get_job_status(job_id: str):
    """Poll the status of an OCR job."""
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail="Job not found")
    return job.to_dict()


# ── SSE Stream (real-time progress) ───────────────────────────────────────

async def event_stream(job_id: str):
    """
    Server-Sent Events stream: push job updates to the client
    until the job finishes or errors.
    """
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
    """SSE endpoint for real-time job progress."""
    return StreamingResponse(
        event_stream(job_id),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
        },
    )


# ── Download result ───────────────────────────────────────────────────────

@app.get("/api/download/{job_id}")
async def download_result(job_id: str):
    """Download the OCR output file for a completed job."""
    with jobs_lock:
        job = jobs.get(job_id)
    if not job:
        raise HTTPException(status_code=404, detail=f"Job '{job_id}' not found. The server may have restarted.")
    if job.status in ("pending", "processing"):
        raise HTTPException(status_code=409, detail=f"Job '{job_id}' is still {job.status}. Please wait.")
    if job.status == "error":
        raise HTTPException(status_code=422, detail=f"Job failed: {job.message}")
    if not job.output_path or not os.path.isfile(job.output_path):
        raise HTTPException(status_code=404, detail="No output file available. The file may have been cleaned up.")

    filename = os.path.basename(job.output_path)
    return FileResponse(
        path=job.output_path,
        filename=filename,
        media_type="text/markdown",
    )


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8765, reload=True)
