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
- 🤖 **Local AI** — uses LM Studio's OpenAI-compatible endpoint (default)
- ☁️ **OpenAI cloud** — set `OPENAI_API_KEY` to use GPT-4o / GPT-4o-mini instead
- 🧵 **Real-time progress** — SSE streaming shows processing status per page
- ⏹ **Stop OCR** — cancel a running job at any time (stops after current page)
- 📑 **Per-page management** — view, reprocess individual pages with different models
- 📊 **Page selection** — process specific pages (e.g., `1-5,8`)
- ⌨️ **Keyboard navigation** — arrow keys to browse PDF pages
- 📐 **Math rendering** — KaTeX support via `zero-md` for formulas and equations
- 🖼️ **VLM Grounding** — detect, crop and preserve charts, graphs and figures as separate images
- 🪄 **Post-processing** — compact text (resolve line breaks) and fix hyphenation
- 🎛️ **VLM tuning** — temperature, top-p and seed for deterministic or creative output
- 💾 **Config persistence** — save settings to `config.json` and restore on next launch

---

## Prerequisites

1. **Python 3.10+** installed
2. **LM Studio** (or other OpenAI-compatible VLM server) running locally
   - Default server URL: `http://localhost:1234`
   - Load a vision-capable model in LM Studio (e.g., `llava`, `bakllava`, `moondream`, `qwen-vl`)

### Optional: OpenAI API (Cloud VLM)

Set the `OPENAI_API_KEY` environment variable to use OpenAI's Vision models
(e.g. `gpt-4o`, `gpt-4o-mini`) instead of a local VLM:

```bash
export OPENAI_API_KEY="sk-proj-..."
./run.sh
```

When the key is present at startup:
- The default VLM endpoint switches to `https://api.openai.com`
- The default model is set to `gpt-4o`
- A cloud indicator (☁️) appears in the UI header

You can still override the URL and model in the Settings dialog if needed.

> **Tip:** Use `gpt-4o-mini` for faster/cheaper processing, or `gpt-4o` for
> higher accuracy on complex documents (math, tables, dense text).

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
| `openai` | Client for OpenAI-compatible APIs (LM Studio / OpenAI) |
| `Pillow` | Image processing (cropping for grounding output) |

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

1. **Configure settings** — click ⚙️ Settings to open the settings modal:
   - **Server URL** — LM Studio or any OpenAI-compatible endpoint
   - **Model** — click *Refresh Models* (⟳) to populate the dropdown
   - **DPI** — PDF rendering quality (100–300)
   - **Force VLM** — skip text extraction and use VLM on all pages
   - **Grounding** — detect and preserve charts/figures as separate images
   - **Temperature / Top-P / Seed** — control VLM determinism
   - **Pages to process** — "All" or custom range (e.g. `1-5,8`)
   - Click **💾 Save Settings** to persist to `config.json`
2. **Select a file** — drag & drop or use the file picker; supports PDF, PNG, JPG, WebP
3. **Preview** — the left pane shows page thumbnails before processing
4. **Start OCR** — watch real-time progress in the sidebar log
5. **Stop OCR** — click ⏹ Stop OCR to cancel (stops after the current page finishes)
6. **Review results** — split-pane view shows source document left, rendered Markdown right
7. **Manage pages** — click individual pages in the sidebar to inspect or reprocess with a different model
8. **Post-process** — use 🪄 Compact and ✂️ Hyphenation buttons to clean up the output
9. **Download** — save the merged markdown file (or ZIP with grounding images)

### Webcam workflow

1. Click *📷 Take Photo (Webcam)*
2. Grant camera access
3. Take photos of document pages
4. Add more pages as needed (multi-page capture)
5. Switch camera (front/rear) if needed
6. Enter an output filename
7. Photos are assembled into a PDF and processed like any other file

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

### VLM Grounding (Charts & Figures Preservation)

When **Grounding** is enabled in Settings, the VLM uses an XML-structured prompt that:

1. Extracts all text as Markdown (as usual)
2. Detects charts, graphs, diagrams and photographs
3. Replaces each visual element with an inline placeholder: `![description](IMG_N)`
4. Returns normalized bounding-box coordinates (0–1000) for each image
5. The backend crops each region from the page PNG and saves it in `images/`

**Output format:** a folder `outputs/<name>_grounding/` containing:
- `extracted.md` — Markdown with `![desc](images/p1_IMG_1.png)` references
- `images/` — cropped PNG files (page-prefixed to avoid cross-page collisions)

**Download:** clicking ⬇ Download returns a ZIP of the entire grounding directory.

> Grounding is useful for textbooks, technical papers, and any document where
> preserving charts and figures alongside the text is important.

### Post-Processing

After OCR completes, two post-processing options are available:

| Button | Action |
|---|---|
| 🪄 **Compact** | Resolve spurious line breaks within paragraphs (single-page view) |
| ✂️ **Hyphenation** | Rejoin words split across lines by hyphenation |
| 🪄 **Compact All Text** | Apply compact to every page and persist changes |
| ✂️ **Fix Hyphenation** | Apply hyphenation fix to every page and persist changes |

Changes are saved to the in-memory page results and reflected in the download.

### VLM Sampling Parameters

Three parameters control the VLM's output determinism:

| Parameter | Default | Effect |
|---|---|---|
| **Temperature** | `0.0` | `0` = fully deterministic; higher = more creative |
| **Top-P** | `0.1` | Nucleus sampling — lower = more focused output |
| **Seed** | `42` | Fixed seed = reproducible results for the same input |

These are accessible in the Settings modal and persisted to `config.json`.

---

## Per-Page Management

After processing a multi-page PDF, you can:

- **View individual page results** in the sidebar panel (shows method: VLM/TXT, model used, status)
- **Reprocess a single page** with a different model (useful if VLM misinterpreted a page)
- **Navigate** between pages using the preview pane or sidebar (synced bidirectionally)
- **Download** the full merged document at any time (regenerated from latest page results)
- **View grounding thumbnails** — image entries appear below each page in the sidebar

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Cannot reach VLM server" | Ensure LM Studio is running with a vision model loaded |
| "Connection refused" | Check LM Studio's local server port (default: 1234) |
| Model not in list | Type the exact model ID shown in LM Studio |
| Slow processing | Lower DPI; enable "Force VLM" only if needed |
| Large PDFs fail | Process in smaller page ranges (e.g. "1-50") |
| Output file missing | Check `outputs/` directory |
| Webcam not working | Requires HTTPS or localhost; check browser camera permissions |
| Grounding images missing | Ensure the VLM supports vision; check logs for parse errors |

---

## Architecture

The application uses a **client-server** design:

```
myocr/
├── main.py                       # FastAPI backend
│   ├── /api/* endpoints          # REST + SSE streaming
│   ├── OCR core engine           # PDF/image processing, VLM calls
│   ├── Per-page result tracking  # PageResult + JobState
│   ├── Grounding pipeline        # XML parsing, image cropping
│   └── Job workers               # Background tasks
├── frontend/                     # Single-page web app
│   ├── index.html                # Layout + modals + zero-md
│   ├── js/app.js                 # UI logic, API calls, event handlers
│   └── css/style.css             # Responsive dark theme
├── config.json                   # Persisted VLM settings (auto-generated)
├── config.json.example           # Template for config
└── outputs/                      # OCR results (Markdown files + grounding dirs)
```

### Backend (FastAPI)

- **State management**: In-memory `jobs` dict with per-page tracking (`threading.Lock`)
- **Concurrency**: `BackgroundTasks` for long-running OCR jobs
- **Streaming**: SSE (`/api/stream/{job_id}`) for real-time updates (500ms polling)
- **Hybrid processing**: `_is_text_page()` detects searchable PDF pages (≥20 chars threshold)
- **Lazy loading**: PDF thumbnails generated on-demand for pages beyond initial batch
- **Grounding**: XML-structured VLM response parsing → bounding-box extraction → Pillow cropping
- **Config**: `config.json` persistence via `/api/config` endpoints
- **Cancel support**: `/api/cancel/{job_id}` marks jobs for graceful stop

### Frontend (Vanilla JS)

- Split-pane layout: source preview left, markdown result right
- `zero-md` for rendering Markdown with KaTeX math and syntax highlighting
- Lazy-loading thumbnails for large PDFs (initial 20 pages, rest on-demand)
- Modal dialogs for settings, webcam capture, reprocessing, filename customization
- SSE with fallback polling for progress updates
- Keyboard navigation (← → ↑ ↓) for PDF page browsing
- Post-processing: compact text and hyphenation fix (persisted to page results)
- VLM mode detection: shows ☁️ badge when OpenAI API key is active

---

## API Endpoints

| Method | Endpoint | Description |
|---|---|---|
| `GET` | `/api/health` | Server health check (includes `openai_mode` flag) |
| `GET` | `/api/models?url=...` | List available VLM models |
| `GET` | `/api/config` | Get current server configuration |
| `POST` | `/api/config` | Save server configuration to `config.json` |
| `POST` | `/api/preview` | Upload file, get thumbnails |
| `GET` | `/api/pdf-info?filename=...` | Total page count for cached PDF |
| `GET` | `/api/pdf-page?filename=...&page_num=N` | Single page thumbnail (lazy-load) |
| `POST` | `/api/ocr` | Start OCR job |
| `GET` | `/api/status/{job_id}` | Job status + logs |
| `POST` | `/api/cancel/{job_id}` | Cancel a running OCR job |
| `GET` | `/api/pages/{job_id}` | Per-page results |
| `POST` | `/api/reprocess/{job_id}` | Reprocess a single page |
| `GET` | `/api/stream/{job_id}` | SSE events stream |
| `GET` | `/api/download/{job_id}` | Download merged markdown (or ZIP for grounding) |
| `GET` | `/api/download-image/{job_id}/{img}` | Download a single grounding image |

---

## Version History

- **v2.1** (current) — FastAPI web server + modern frontend with webcam, preview, per-page management, grounding, post-processing, OpenAI API support
- **v1.x** — Original Tkinter desktop app (`customtkinter` GUI, single-file, output alongside source)

---

*This is a local, privacy-focused OCR solution. When using LM Studio, no data leaves your machine. When using OpenAI API (`OPENAI_API_KEY`), images are sent to OpenAI's servers.*
