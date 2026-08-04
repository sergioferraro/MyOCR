# Local OCR — Vision Language Model

A modern web application for Optical Character Recognition (OCR) on **PDFs** and **images** using a **local Vision Language Model** served via [LM Studio](https://lmstudio.ai/) or any OpenAI-compatible API.

The output is structured Markdown saved in the `outputs/` directory.

---

## Features

- 📄 **PDF support** — renders pages to images at configurable DPI (100–300)
- 🖼️ **Image support** — PNG, JPG, WebP
- 📷 **Webcam capture** — scan physical documents directly from camera (multi-page)
- 🔍 **Hybrid processing** — extracts text from searchable PDFs, uses VLM only for scanned pages
- 🌐 **Modern web UI** — responsive split-pane layout with preview + markdown rendering
- 🤖 **Local AI** — no cloud API keys needed; uses LM Studio's OpenAI-compatible endpoint
- 🧵 **Real-time progress** — SSE streaming shows processing status per page
- 📑 **Per-page management** — view, reprocess individual pages with different models
- 📊 **Page selection** — process specific pages (e.g., `1-5,8`)
- ⌨️ **Keyboard navigation** — arrow keys to browse PDF pages
- 📐 **Math rendering** — KaTeX support via `zero-md` for formulas and equations

---

## Prerequisites

1. **Python 3.10+** installed
2. **LM Studio** (or other OpenAI-compatible VLM server) running locally
   - Default server URL: `http://localhost:1234`
   - Load a vision-capable model in LM Studio (e.g., `llava`, `bakllava`, `moondream`, `qwen-vl`)

---

## Installation

```bash
cd myocr
pip install -r requirements.txt
```

### Dependencies

| Package | Purpose |
|---|---|
| `fastapi` | Modern web framework for the API server |
| `uvicorn[standard]` | ASGI server for FastAPI |
| `python-multipart` | File upload support (multipart/form-data) |
| `pymupdf` | PDF rendering (page → image) + native text extraction |
| `openai` | Client for OpenAI-compatible APIs (LM Studio) |

> **Note:** `pymupdf` is licensed under AGPL. This is fine for personal/local use.

---

## Usage

### Start the server

```bash
./run.sh
```

or manually:

```bash
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
```

Then open [http://localhost:8765](http://localhost:8765) in your browser.

---

### Workflow

1. **Configure settings** — ensure the server URL is correct, click *Refresh Models* (⟳) to populate the model dropdown
2. **Select a file** — drag & drop or use the file picker; supports PDF, PNG, JPG, WebP
3. **Choose a model** — pick from the list or type a model name manually
4. **Set options**:
   - **DPI** for PDF rendering (higher = better quality but slower)
   - **Force VLM** — skip text extraction and use VLM on all pages
   - **Pagine da processare** — select "Tutte" or specify a range like `1-5,8`
5. **Start OCR** — watch real-time progress in the sidebar log
6. **Review results** — split-pane view shows source document left, rendered Markdown right
7. **Manage pages** — click individual pages in the sidebar to inspect or reprocess with a different model
8. **Download** — save the merged markdown file

### Webcam workflow

1. Click *Scatta Foto (Webcam)*
2. Grant camera access
3. Take photos of document pages
4. Add more pages as needed (multi-page capture)
5. Enter an output filename
6. Photos are assembled into a PDF and processed like any other file

---

## Output

Files are saved in the `outputs/` directory with names derived from the source filename.

Examples:
- `document.pdf` → `outputs/document.md`
- `scan.png` → `outputs/scan.md`

For multi-page PDFs, all pages are merged into a single Markdown file.

### Hybrid Processing

The application intelligently handles searchable vs. scanned pages:

1. **Searchable pages** (with ≥20 selectable characters): Uses PyMuPDF's native text extraction — fast and accurate
2. **Scanned pages**: Renders to image and sends to VLM for OCR

Result: Faster processing and better quality for mixed documents.

---

## Per-Page Management

After processing a multi-page PDF, you can:

- **View individual page results** in the sidebar panel (shows method: VLM/TXT, model used, status)
- **Reprocess a single page** with a different model (useful if VLM misinterpreted a page)
- **Navigate** between pages using the preview pane or sidebar (synced bidirectionally)
- **Download** the full merged document at any time (regenerated from latest page results)

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Cannot reach VLM server" | Ensure LM Studio is running with a vision model loaded |
| "Connection refused" | Check LM Studio's local server port (default: 1234) |
| Model not in list | Type the exact model ID shown in LM Studio |
| Slow processing | Lower DPI; enable "Force VLM" only if needed |
| Large PDFs fail | Process in smaller page ranges (e.g., "1-50") |
| Output file missing | Check `outputs/` directory |
| Webcam not working | Requires HTTPS or localhost; check browser camera permissions |

---

## Architecture

The application uses a **client-server** design:

```
myocr/
├── main.py                       # FastAPI backend
│   ├── /api/* endpoints          # REST + SSE streaming
│   ├── OCR core engine           # PDF/image processing, VLM calls
│   ├── Per-page result tracking  # PageResult + JobState
│   └── Job workers               # Background tasks
├── frontend/                     # Single-page web app
│   ├── index.html                # Layout + modals + zero-md
│   ├── js/app.js                 # UI logic, API calls, event handlers
│   └── css/style.css             # Responsive dark theme
└── outputs/                      # OCR results (Markdown files)
```

### Backend (FastAPI)

- **State management**: In-memory `jobs` dict with per-page tracking (`threading.Lock`)
- **Concurrency**: `BackgroundTasks` for long-running OCR jobs
- **Streaming**: SSE (`/api/stream/{job_id}`) for real-time updates (500ms polling)
- **Hybrid processing**: `_is_text_page()` detects searchable PDF pages (≥20 chars threshold)
- **Lazy loading**: PDF thumbnails generated on-demand for pages beyond initial batch

### Frontend (Vanilla JS)

- Split-pane layout: source preview left, markdown result right
- `zero-md` for rendering Markdown with KaTeX math and syntax highlighting
- Lazy-loading thumbnails for large PDFs (initial 20 pages, rest on-demand)
- Modal dialogs for webcam capture, reprocessing, filename customization
- SSE with fallback polling for progress updates
- Keyboard navigation (← → ↑ ↓) for PDF page browsing

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Server health check |
| `GET` | `/api/models?url=...` | List available VLM models |
| `POST` | `/api/preview` | Upload file, get thumbnails |
| `GET` | `/api/pdf-info?filename=...` | Total page count for cached PDF |
| `GET` | `/api/pdf-page?filename=...&page_num=N` | Single page thumbnail (lazy-load) |
| `POST` | `/api/ocr` | Start OCR job |
| `GET` | `/api/status/{job_id}` | Job status + logs |
| `GET` | `/api/pages/{job_id}` | Per-page results |
| `POST` | `/api/reprocess/{job_id}` | Reprocess a single page |
| `GET` | `/api/stream/{job_id}` | SSE events stream |
| `GET` | `/api/download/{job_id}` | Download merged markdown |

---

## Version History

- **v2.1** (current) — FastAPI web server + modern frontend with webcam, preview, per-page management
- **v1.x** — Original Tkinter desktop app (`customtkinter` GUI, single-file, output alongside source)

---

*This is a local, privacy-focused OCR solution. No data leaves your machine.*
