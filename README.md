# Local OCR — Vision Language Model

A desktop application that performs Optical Character Recognition (OCR) on **PDFs** and **images** using a **local Vision Language Model** served via [LM Studio](https://lmstudio.ai/). The output is structured Markdown saved alongside the source file.

---

## Features

- 📄 **PDF support** — renders each page to an image at configurable DPI (100–300)
- 🖼️ **Image support** — PNG, JPG, WebP
- 🤖 **Local AI** — no cloud API keys needed; uses LM Studio's OpenAI-compatible endpoint
- 🌙 **Dark theme** — built with `customtkinter`
- 🧵 **Non-blocking** — all heavy work runs in background threads; the GUI never freezes

---

## Prerequisites

1. **Python 3.10+** installed
2. **LM Studio** running locally with a vision-capable model loaded (e.g. `llava`, `bakllava`, `moondream`, or any multimodal model)
   - Default server URL: `http://localhost:1234`
   - Start LM Studio → Local Server → load a model → start the server

---

## Installation

```bash
cd myocr
pip install -r requirements.txt
```

### Dependencies

| Package | Purpose |
|---|---|
| `customtkinter` | Modern dark-themed Tkinter widgets |
| `pymupdf` | PDF rendering (page → image) |
| `openai` | Client for OpenAI-compatible APIs (LM Studio) |

> **Note:** `pymupdf` is licensed under AGPL. This is fine for personal/local use.

---

## Usage

```bash
python main.py
```

1. **Select a file** — click *Select File* and choose a PDF or image
2. **Configure settings** — ensure the server URL is correct, click *Refresh Models* to populate the model dropdown
3. **Choose a model** — pick from the list or type a model name manually
4. **Set DPI** (PDFs only) — higher DPI = better OCR quality but slower processing
5. **Click "Start OCR"** — the app processes the file and saves `_extracted.md` next to the source

---

## Output

For a file named `document.pdf`, the output will be `document_extracted.md` in the same directory. Multi-page PDFs are joined with blank lines between pages.

---

## Troubleshooting

| Problem | Solution |
|---|---|
| "Could not fetch models" | Make sure LM Studio server is running on the configured port |
| "Connection refused" | Check that LM Studio's local server is started |
| Model not recognised | Type the exact model ID shown in LM Studio |
| Slow processing | Lower the DPI setting for PDFs |
| Large images fail | Try a smaller image or lower DPI |

---

## Architecture

The application uses a **single-file** design (`main.py`) with:

- **Thread-safe event queue** — worker threads post events; the main GUI thread polls and dispatches
- **No direct Tkinter calls from background threads** — all UI updates flow through the queue
- **Daemon threads** — clean exit on app close

See `IMPLEMENTATION_PLAN.md` for the full technical specification.
