# Local OCR — Web Application Specification

> **Version 2.1** — FastAPI web server + modern frontend.  
> This document describes the **current** system architecture and behavior.

---

## Overview

A local, privacy-focused web application for converting PDFs and images to structured Markdown using a **Vision Language Model** (VLM) served via [LM Studio](https://lmstudio.ai/) or any OpenAI-compatible API.

All processing happens locally — no data leaves the machine.

---

## Technical Stack

### Backend
- **Framework**: `FastAPI` (ASGI, async support, automatic OpenAPI docs)
- **Server**: `uvicorn[standard]` (with auto-reload in development)
- **PDF Engine**: `pymupdf` (`fitz`) — page rendering, text extraction, thumbnail generation
- **AI Client**: `openai` Python SDK — connected to LM Studio's OpenAI-compatible endpoint
- **Streaming**: Server-Sent Events (SSE) via `fastapi.responses.StreamingResponse`
- **Concurrency**: `BackgroundTasks` for long-running OCR jobs; `threading.Lock` for shared state

### Frontend
- **Language**: Vanilla HTML5 + CSS3 + JavaScript (ES6+)
- **Markdown Rendering**: [`zero-md`](https://github.com/rtCamp/zero-md) web component
  - KaTeX for math rendering
  - Mermaid for diagrams
  - Highlight.js for syntax highlighting
- **PDF Generation** (webcam): [`jsPDF`](https://github.com/parallax/jsPDF)
- **Theme**: Custom dark theme using CSS custom properties

---

## System Requirements

1. **Python 3.10+** installed
2. **LM Studio** (or compatible VLM server) running locally
   - Default URL: `http://localhost:1234`
   - Must have a vision-capable model loaded (e.g., `llava`, `moondream`, `qwen-vl`)
3. **Modern browser** (Chrome, Firefox, Edge, Safari) for the web interface

---

## Core Features

### 1. File Processing

**Supported formats:**
- PDF (multi-page, hybrid text/VLM processing)
- Images: PNG, JPG, JPEG, WebP

**Hybrid processing pipeline:**
```
For each PDF page:
  ├─ Has selectable text? (≥20 chars via page.get_text())
  │   ├─ YES → Extract text directly (fast, no VLM call)
  │   └─ NO  → Render to PNG at configured DPI → Send to VLM
  └─ Force VLM enabled? → Always use VLM (skip text extraction)
```

### 2. Page Selection

Users can specify which pages to process:
- **"Tutte"** — process all pages (default)
- **"Intervallo"** — custom range, e.g., `1-5,8` or `3,7-12`

Skipped pages are marked with `method="skipped"` and excluded from the merged output.

### 3. Per-Page Management

Each page is tracked individually with:
- `page_num` — 1-based page number
- `markdown` — extracted/generated text
- `model` — model used (or `"(text-extract)"` for native extraction)
- `method` — `"text_extract"`, `"vlm"`, `"skipped"`
- `status` — `"pending"`, `"processing"`, `"done"`, `"error"`
- `error_msg` — error details if processing failed

**Reprocessing:**
Any page can be reprocessed with a different model without re-uploading the file. The original PDF bytes are cached in memory.

### 4. Real-Time Progress

**SSE (Server-Sent Events):**
- Frontend connects to `/api/stream/{job_id}`
- Server pushes job state every 500ms
- Includes: progress percentage, log messages, per-page status
- Auto-closes when job reaches `"done"` or `"error"`

**Fallback:**
If SSE connection drops, frontend falls back to polling `/api/status/{job_id}` every 1 second.

### 5. PDF Preview

- Initial upload generates thumbnails for first 20 pages (at 100 DPI)
- Additional pages loaded on-demand via `/api/pdf-page` (lazy-load)
- Navigation: buttons + keyboard arrows (← → ↑ ↓)
- PDF bytes cached in memory for the session

### 6. Webcam Capture

- Live preview with camera switching (front/back)
- Multi-page capture: take multiple photos, review thumbnails
- Photos assembled into a PDF via `jsPDF` (client-side)
- Custom output filename before processing
- Fallback to single image if only one photo is taken

### 7. Output

- Merged markdown saved in `outputs/` directory
- Filename derived from source: `document.pdf` → `outputs/document.md`
- Special characters in filenames are sanitized
- Download triggered on-demand (regenerates merge from latest page results)

---

## API Contract

### Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/` | Serve frontend |
| `GET` | `/api/health` | Health check |
| `GET` | `/api/models` | List VLM models |
| `POST` | `/api/preview` | Generate file preview |
| `GET` | `/api/pdf-info` | PDF page count |
| `GET` | `/api/pdf-page` | Single page thumbnail |
| `POST` | `/api/ocr` | Start OCR job |
| `GET` | `/api/status/{id}` | Job status |
| `GET` | `/api/pages/{id}` | Per-page results |
| `POST` | `/api/reprocess/{id}` | Reprocess a page |
| `GET` | `/api/stream/{id}` | SSE status stream |
| `GET` | `/api/download/{id}` | Download result |

### System Prompt (VLM)

```
Convert this image into Markdown text format. Your task is to perform
high-accuracy Optical Character Recognition (OCR). Preserve the document's
structure as accurately as possible: headers, lists, and tables. Do not add
any greetings, explanations, or introductory/concluding remarks. Output only
the raw recognized text.
```

### VLM Request Format

Each page sent to the VLM uses the standard OpenAI vision API format:

```python
client.chat.completions.create(
    model=model,
    messages=[
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": [
            {"type": "text", "text": "Extract the text from this image."},
            {"type": "image_url", "image_url": {"url": "data:image/png;base64,..."}},
        ]},
    ],
    max_tokens=8192,
)
```

---

## Configuration

| Parameter | Default | Options | Description |
|---|---|---|---|
| Server URL | `http://localhost:1234` | Any OpenAI-compatible URL | LM Studio / VLM server |
| DPI | `150` | `100`, `150`, `200`, `300` | PDF → image rendering quality |
| Force VLM | `false` | `true` / `false` | Bypass native text extraction |
| Page spec | `all` | e.g., `1-5,8` | Pages to process |
| Max preview pages | `20` | — | Initial thumbnail batch size |
| Preview DPI | `100` | — | Thumbnail resolution |
| Min text chars | `20` | — | Threshold for "text page" detection |

---

## Dependencies

| Package | Purpose |
|---|---|
| `fastapi>=0.104.0` | Web framework (API + static files) |
| `uvicorn[standard]>=0.24.0` | ASGI server |
| `python-multipart>=0.0.6` | File upload support |
| `pymupdf>=1.23.0` | PDF rendering and text extraction |
| `openai>=1.0.0` | OpenAI-compatible API client |

> **Note:** `pymupdf` is licensed under AGPL. This is fine for personal/local use.

---

## Security Considerations

- **CORS**: Currently allows all origins (`allow_origins=["*"]`) — appropriate for local use
- **No authentication**: Designed for local/private network use only
- **No data leaves the machine**: All VLM calls go to the local LM Studio server
- **In-memory storage**: Job state and PDF bytes are held in RAM (lost on restart)

---

## Limitations & Known Issues

| Limitation | Notes |
|---|---|
| In-memory job store | Jobs are lost on server restart |
| Large PDFs in memory | Full PDF bytes cached for reprocessing |
| No cancellation | Running jobs cannot be cancelled mid-process |
| Single worker | Only one OCR job at a time per user |
| No file persistence | Output files are in `outputs/` but not tracked |
| No user accounts | Single-user design |

---

## Future Enhancements (Backlog)

- [ ] Job cancellation endpoint
- [ ] Persistent job storage (SQLite / JSON)
- [ ] Batch processing (queue multiple files)
- [ ] OCR result editing before download
- [ ] Multiple output formats (HTML, TXT, DOCX)
- [ ] Configuration file for defaults
- [ ] Docker containerization
- [ ] Mobile-responsive improvements

---

*Local, private, accurate. No data leaves your machine.*
