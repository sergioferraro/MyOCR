# Implementation Plan — Local OCR Web Application

> Current architecture: FastAPI backend + vanilla JS frontend.  
> This document describes the **existing** architecture, not a future plan.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Backend — FastAPI Server](#2-backend--fastapi-server)
3. [Frontend — Single-Page Web App](#3-frontend--single-page-web-app)
4. [API Endpoints Reference](#4-api-endpoints-reference)
5. [Data Flow](#5-data-flow)
6. [Concurrency Model](#6-concurrency-model)
7. [File Map](#7-file-map)
8. [Migration Notes (v1.x → v2.x)](#8-migration-notes-v1x--v2x)

---

## 1. Architecture Overview

| Aspect | Detail |
|---|---|
| **Goal** | Web app that OCRs PDFs/images → structured Markdown via a local VLM (LM Studio) |
| **Backend** | `FastAPI` (ASGI) served by `uvicorn` |
| **Frontend** | Vanilla HTML/CSS/JS — single-page app with split-pane layout |
| **PDF Engine** | `pymupdf` (`fitz`) — page rendering, text extraction, thumbnail generation |
| **AI Client** | `openai` Python SDK (OpenAI-compatible endpoint, LM Studio) |
| **Streaming** | Server-Sent Events (SSE) for real-time progress updates |
| **Concurrency** | `BackgroundTasks` (FastAPI) + `threading` for job state management |
| **Output** | Markdown files saved in `outputs/` directory |
| **Markdown Rendering** | `zero-md` web component (KaTeX math, Mermaid diagrams, syntax highlighting) |

---

## 2. Backend — FastAPI Server

### 2.1 Core Modules (`main.py`)

```
main.py (~550 lines)
├── Constants & Configuration
│   ├── DEFAULT_URL = "http://localhost:1234"
│   ├── DPI_OPTIONS = [100, 150, 200, 300]
│   ├── IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
│   ├── PDF_EXTENSIONS = {".pdf"}
│   └── SYSTEM_PROMPT = "Convert this image into Markdown text format..."
│
├── Per-Page Result Tracking
│   ├── PageResult dataclass (page_num, markdown, model, method, status, error_msg)
│   └── JobState dataclass (job_id, status, page_results dict, file_bytes, logs)
│
├── In-Memory Job Store
│   ├── jobs: dict[str, JobState]  (thread-safe via threading.Lock)
│   └── Helper functions: _add_log, _progress, _set_status, _ensure_page_result, _update_page_result
│
├── OCR Core Engine
│   ├── _get_client(url) → OpenAI client
│   ├── _send_page_to_vlm(image_bytes, model, url) → str
│   ├── _is_text_page(page) → bool  (hybrid detection: ≥20 chars = searchable)
│   ├── _process_single_page()      (per-page processing with status tracking)
│   ├── _merge_page_results()       (assemble final markdown from per-page results)
│   └── _write_merged_output()      (write to outputs/)
│
├── Job Workers
│   ├── run_ocr_job()               (top-level dispatcher)
│   ├── process_image()             (single image → VLM)
│   └── process_pdf()               (multi-page PDF with hybrid text/VLM)
│
├── FastAPI Application
│   ├── app = FastAPI(title="Local OCR Server", version="2.1.0")
│   ├── CORS middleware (allow_all)
│   └── Static file serving (/static → frontend/)
│
└── API Endpoints (see Section 4)
```

### 2.2 Key Design Decisions

**Per-Page Result Tracking:**
Each PDF page is tracked individually via `PageResult` objects stored in `JobState.page_results`. This enables:
- Reprocessing individual pages with different models
- Mixed methods (text-extract + VLM) within the same document
- On-the-fly merge at download time (always reflects latest state)

**File Bytes Caching:**
The original PDF bytes are stored in `JobState.file_bytes` after the first upload, enabling reprocessing without re-uploading.

**Hybrid Processing:**
`_is_text_page()` checks if a PDF page has ≥20 characters of selectable text:
- **Yes** → native text extraction via `page.get_text("text")` (fast, accurate)
- **No** → render to image at configured DPI, send to VLM
- **Force VLM** checkbox bypasses this check entirely

**Lazy-Load Thumbnails:**
PDF previews are cached in `preview_cache` (filename → file_bytes). Initial preview returns first 20 pages; additional pages are loaded on-demand via `/api/pdf-page`.

---

## 3. Frontend — Single-Page Web App

### 3.1 File Structure

```
frontend/
├── index.html          # Layout, modals, zero-md integration
├── css/style.css       # Responsive dark theme, CSS custom properties
└── js/app.js           # UI controller, API calls, state management
```

### 3.2 Layout

```
┌──────────────────────────────────────────────────────────────┐
│  🔍 Local OCR — Vision Language Model — LM Studio            │
├──────────┬───────────────────────────────────────────────────┤
│ SIDEBAR  │  MAIN AREA (Split View)                           │
│          │                                                   │
│ ⚙️ Settings│  ┌─────────────┐  ┌─────────────────────────┐  │
│           │  │  📄 Sorgente │  │ ✅ Risultato Markdown   │  │
│ 📄 File   │  │  (preview)   │  │  (zero-md rendered)     │  │
│           │  │  ◀ nav ▶    │  │                         │  │
│ 📊 Progress│  └─────────────┘  └─────────────────────────┘  │
│           │                                                   │
│ 📋 Log    │  Keyboard nav: ← → ↑ ↓                           │
│           │                                                   │
│ 📑 Pages  │  Per-page sync: preview ↔ sidebar ↔ markdown     │
│           │                                                   │
│ ⬇ Download│                                                   │
│ 🔄 New OCR│                                                   │
├──────────┴───────────────────────────────────────────────────┤
│  Local OCR v2.0 · FastAPI + VLM                              │
└──────────────────────────────────────────────────────────────┘
```

### 3.3 State Management (Client-Side)

Key state variables in `app.js`:

| Variable | Purpose |
|---|---|
| `selectedFile` | Currently selected file (File object) |
| `currentJobId` | Active OCR job ID |
| `eventSource` | SSE connection for streaming updates |
| `previewThumbnails[]` | Loaded thumbnail data-URIs |
| `previewPage` | Current preview page index (0-based) |
| `pageResults[]` | Per-page processing results |
| `isViewingAll` | `true` = merged view, `false` = single page |
| `webcamCapturedPages[]` | Captured webcam images (blob + dataUrl) |

### 3.4 Modals

| Modal | Purpose |
|---|---|
| `webcamModal` | Live webcam preview, capture, camera switch |
| `addPagesModal` | Thumbnail grid of captured pages, "add more" |
| `renameModal` | Custom output filename before OCR start |
| `reprocessModal` | Select model for single-page reprocessing |

### 3.5 Webcam → PDF Pipeline

1. User captures photo(s) via webcam
2. Multiple captures stored in `webcamCapturedPages[]`
3. On "Ho finito", `jsPDF` assembles all images into a PDF blob
4. The generated PDF is treated as a normal file upload
5. Fallback: if only 1 image, sent as `.jpg` directly

---

## 4. API Endpoints Reference

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/` | Serve frontend (index.html) |
| `GET` | `/api/health` | Health check (`{"status": "ok", "version": "2.1.0"}`) |
| `GET` | `/api/models?url=...` | List available VLM models from server |
| `POST` | `/api/preview` | Upload file → thumbnails (max 20 initial pages) |
| `GET` | `/api/pdf-info?filename=...` | Total page count for cached PDF |
| `GET` | `/api/pdf-page?filename=...&page_num=N` | Single page thumbnail (lazy-load) |
| `POST` | `/api/ocr` | Start OCR job (multipart: file + params) |
| `GET` | `/api/status/{job_id}` | Job status + logs + per-page results |
| `GET` | `/api/pages/{job_id}` | Detailed per-page results |
| `POST` | `/api/reprocess/{job_id}` | Reprocess single page with different model |
| `GET` | `/api/stream/{job_id}` | SSE event stream (real-time updates) |
| `GET` | `/api/download/{job_id}` | Download merged markdown (regenerated on-the-fly) |

### 4.1 SSE Event Format

Each SSE event contains a JSON-serialized `JobState.to_dict()`:

```json
{
  "job_id": "a1b2c3d4",
  "status": "processing",
  "filename": "document.pdf",
  "total_pages": 10,
  "processed_pages": 5,
  "message": "",
  "output_path": "",
  "logs": ["[Start] Processing PDF...", "[1/10] Page 1: text extracted", ...],
  "created_at": 1234567890.0,
  "page_results": {
    "1": {"page_num": 1, "markdown": "...", "model": "(text-extract)", "method": "text_extract", "status": "done", "error_msg": ""},
    "2": {"page_num": 2, "markdown": "...", "model": "llava:13b", "method": "vlm", "status": "done", "error_msg": ""}
  }
}
```

### 4.2 OCR Request Parameters

```
POST /api/ocr  (multipart/form-data)
├── file: UploadFile (required)
├── model: str (required)
├── url: str (default: "http://localhost:1234")
├── dpi: int (default: 150)
├── force_vlm: bool (default: false)
└── page_spec: str (default: "all")
```

---

## 5. Data Flow

### 5.1 Normal OCR Flow

```
Browser                          FastAPI Server                    LM Studio
   │                                 │                                │
   │  POST /api/preview (file)       │                                │
   │────────────────────────────────>│                                │
   │                                 │  fitz.open(stream)             │
   │  ← thumbnails (max 20)         │                                │
   │<────────────────────────────────│                                │
   │                                 │                                │
   │  POST /api/ocr (file + params)  │                                │
   │────────────────────────────────>│                                │
   │  ← { job_id }                  │                                │
   │<────────────────────────────────│                                │
   │                                 │  BackgroundTasks.add_task()    │
   │  GET /api/stream/{job_id}       │                                │
   │────────────────────────────────>│                                │
   │                                 │  For each page:                │
   │  SSE: status updates            │    _is_text_page()?            │
   │<───────────────────────────────│    ├─ Yes: get_text()          │
   │                                 │    └─ No: get_pixmap()         │
   │  [done]                         │              │                 │
   │                                 │              │  chat.completions.create()
   │                                 │              │─────────────────>│
   │                                 │              │<─────────────────│
   │  GET /api/pages/{job_id}        │                                │
   │────────────────────────────────>│                                │
   │  ← per-page results             │                                │
   │<────────────────────────────────│                                │
   │                                 │                                │
   │  GET /api/download/{job_id}     │                                │
   │────────────────────────────────>│                                │
   │  ← merged .md file              │                                │
   │<────────────────────────────────│                                │
```

### 5.2 Reprocess Flow

```
Browser                          FastAPI Server                    LM Studio
   │                                 │                                │
   │  POST /api/reprocess/{job_id}   │                                │
   │  (page_num, model, url, dpi)    │                                │
   │────────────────────────────────>│                                │
   │                                 │  fitz.open(stored file_bytes)   │
   │                                 │  page.get_pixmap(dpi)          │
   │                                 │              │                 │
   │                                 │              │  chat.completions.create()
   │                                 │              │─────────────────>│
   │  ← { status: "ok", ... }       │              │<─────────────────│
   │<────────────────────────────────│                                │
   │                                 │  _update_page_result()         │
   │                                 │  _write_merged_output()        │
```

---

## 6. Concurrency Model

```
┌─────────────────────────────────────────────────────────────┐
│  FastAPI (async event loop)                                  │
│                                                              │
│  ┌─ Request Handlers (async) ────────────────────────────┐   │
│  │  - /api/ocr → creates JobState, queues BackgroundTask │   │
│  │  - /api/stream/{id} → SSE generator (async)           │   │
│  │  - /api/status/{id} → reads jobs dict (sync, locked)  │   │
│  │  - /api/reprocess/{id} → sync handler (blocks briefly)│   │
│  └───────────────────────────────────────────────────────┘   │
│                                                              │
│  ┌─ BackgroundTasks (run in thread pool) ─────────────────┐  │
│  │  - run_ocr_job() → process_pdf() or process_image()    │  │
│  │    └─ _process_single_page() (per page, sequential)    │  │
│  │       └─ _send_page_to_vlm() (HTTP call to LM Studio) │  │
│  └───────────────────────────────────────────────────────┘  │
│                                                              │
│  ┌─ Shared State (thread-safe) ───────────────────────────┐  │
│  │  - jobs: dict[str, JobState]                            │  │
│  │  - jobs_lock: threading.Lock                            │  │
│  │  - preview_cache: dict[str, tuple[bytes, str]]          │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

**Key points:**
- OCR jobs run in FastAPI `BackgroundTasks` (thread pool executor)
- Job state is protected by `threading.Lock`
- SSE stream polls job state every 500ms (non-blocking, async)
- Reprocess endpoint is synchronous (blocks until page is reprocessed)
- No two OCR jobs for the same `job_id` can run simultaneously

---

## 7. File Map

```
myocr/
├── main.py                       # FastAPI backend (all-in-one)
│   ├── Constants & helpers
│   ├── PageResult / JobState dataclasses
│   ├── OCR core engine
│   ├── Job workers
│   └── FastAPI app + endpoints
│
├── frontend/                     # Single-page web application
│   ├── index.html               # Layout + modals + zero-md
│   ├── js/app.js                # UI controller (~800 lines)
│   └── css/style.css            # Responsive dark theme
│
├── outputs/                      # OCR results (git-ignored)
│   └── *.md                     # One per processed document
│
├── requirements.txt              # Python dependencies
├── run.sh                        # Quick-start script
├── .gitignore                    # Excludes outputs/, .venv/, __pycache__/
├── README.md                     # User documentation
├── Local_OCR.md                  # Original v1.x specification (historical)
├── IMPLEMENTATION_PLAN.md        # This file (v2.x architecture)
└── IOS_PORTING_ANALYSIS.md       # iOS port analysis (historical)
```

---

## 8. Migration Notes (v1.x → v2.x)

### What Changed

| Feature | v1.x (Tkinter) | v2.x (Web) |
|---|---|---|
| **GUI Framework** | `customtkinter` (desktop) | FastAPI + vanilla JS (web) |
| **Concurrency** | `threading` + `queue.Queue` + `.after()` polling | `BackgroundTasks` + SSE streaming |
| **Output Location** | `_extracted.md` alongside source file | `outputs/` directory |
| **Page Processing** | All-or-nothing (entire PDF) | Per-page tracking + reprocessing |
| **Preview** | None (black-box processing) | PDF thumbnails + lazy-load + navigation |
| **Webcam** | Not supported | Full support with multi-page capture |
| **Page Selection** | All pages only | Custom ranges (e.g., "1-5,8") |
| **Force VLM** | Not available | Checkbox to bypass text extraction |
| **Real-time Feedback** | Log textbox via event queue | SSE streaming + progress bar |
| **Markdown Rendering** | Not rendered (file saved only) | `zero-md` with math/syntax highlighting |
| **Download** | File auto-saved to disk | On-demand download via API |
| **Architecture** | Single-file monolithic app | Client-server (backend + frontend) |

### Backward Compatibility

- `pymupdf` and `openai` SDK usage is identical
- System prompt and VLM interaction logic unchanged
- LM Studio server URL and model selection work the same way
- The `customtkinter` dependency was removed from `requirements.txt`

---

*This document describes the current v2.1 architecture. For the original v1.x specification, see `Local_OCR.md`.*
