# Implementation Plan — Local LLM-powered OCR

> Based on the specification in `Local_OCR.md`.  
> This plan breaks the project into phases, modules, and individual tasks with clear acceptance criteria.

---

## Table of Contents

1. [Project Overview](#1-project-overview)
2. [Module Architecture](#2-module-architecture)
3. [Phase 1 — Project Scaffolding](#3-phase-1--project-scaffolding)
4. [Phase 2 — Core Worker Engine (Thread-Safe Queue)](#4-phase-2--core-worker-engine-thread-safe-queue)
5. [Phase 3 — File Processing (PDF + Image)](#5-phase-3--file-processing-pdf--image)
6. [Phase 4 — LM Studio Integration (Vision API)](#6-phase-4--lm-studio-integration-vision-api)
7. [Phase 5 — GUI Layout & Widgets](#7-phase-5--gui-layout--widgets)
8. [Phase 6 — Event Wiring & Integration](#8-phase-6--event-wiring--integration)
9. [Phase 7 — Testing & Polish](#9-phase-7--testing--polish)
10. [Risk Register & Mitigations](#10-risk-register--mitigations)
11. [File Map](#11-file-map)

---

## 1. Project Overview

| Aspect | Detail |
|---|---|
| **Goal** | Desktop app that OCRs PDFs/images → structured Markdown via a local VLM (LM Studio) |
| **GUI Framework** | `customtkinter` (dark theme) |
| **PDF Engine** | `pymupdf` (`fitz`) |
| **AI Client** | `openai` Python SDK (OpenAI-compatible endpoint) |
| **Concurrency** | `threading` + `queue.Queue`; single worker at a time; main thread polls via `.after()` |
| **Output** | `_extracted.md` placed alongside the source file |

---

## 2. Module Architecture

```
myocr/
├── Local_OCR.md                  # Original spec
├── IMPLEMENTATION_PLAN.md        # This file
├── main.py                       # Application entry point (single-file app)
├── requirements.txt              # Python dependencies
└── README.md                     # User-facing docs (future)
```

> **Design decision:** The entire application lives in a single `main.py` file. The spec calls for a "complete, ready-to-run" application, and keeping it monolithic avoids import complexity for end-users. The file is internally structured into clear sections:

```
main.py
├── Imports & Constants
│   ├── System imports (tkinter, threading, queue, tempfile, os, base64, io, etc.)
│   ├── customtkinter
│   ├── pymupdf (fitz)
│   └── openai
├── Constants
│   ├── DEFAULT_URL = "http://localhost:1234"
│   ├── DPI_OPTIONS = ["100", "150", "200", "300"]
│   ├── IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp"}
│   └── SYSTEM_PROMPT = "Convert this image into Markdown text format..."
├── Event Queue (thread-safe)
│   ├── Event dataclass (type, message, data)
│   └── Global Queue instance
├── Worker Functions (run in background thread)
│   ├── _refresh_models_worker()
│   ├── _process_image_worker()
│   ├── _process_pdf_worker()
│   └── _send_page_to_vlm(page_bytes) → str
├── GUI Class (CTk)
│   ├── __init__(): configure theme, create queue poller
│   ├── _build_ui(): layout all widgets
│   ├── _poll_queue(): .after() callback for queue processing
│   ├── _handle_event(): dispatch by event type
│   ├── _select_file(): file dialog
│   ├── _refresh_models(): kick off model fetch
│   ├── _start_ocr(): main processing entry
│   └── _log(msg): append to log textbox + autoscroll
├── Main Block
│   └── app = App(); app.mainloop()
```

---

## 3. Phase 1 — Project Scaffolding

### Task 1.1 — Create `requirements.txt`
```
customtkinter>=5.2.0
pymupdf>=1.23.0
openai>=1.0.0
```

### Task 1.2 — Create skeleton `main.py`
- Import block
- `if __name__ == "__main__":` guard
- Verify all imports resolve (dry run)

**Acceptance criteria:**
- [ ] `pip install -r requirements.txt` succeeds
- [ ] `python main.py` runs without import errors (even if GUI is empty)

---

## 4. Phase 2 — Core Worker Engine (Thread-Safe Queue)

### Task 2.1 — Define Event Dataclass

```python
from dataclasses import dataclass

@dataclass
class Event:
    event_type: str   # "log", "progress", "success", "error", "models_ready"
    message: str      # human-readable text
    data: any = None  # extra payload (e.g., model list)
```

### Task 2.2 — Create Global Queue

```python
import queue
event_queue = queue.Queue()
```

### Task 2.3 — Implement Queue Poller in GUI Class

- `self.after(100, self._poll_queue)` called from `__init__`
- `_poll_queue()` drains all available events via `queue.get_nowait()` in a loop
- Each event is dispatched to `_handle_event(event)`
- After processing, schedule next poll with `.after(100, ...)`

### Task 2.4 — Implement Event Dispatcher

```python
def _handle_event(self, event):
    if event.event_type == "log":
        self._log(event.message)
    elif event.event_type == "success":
        self._log(event.message)
        self._finish_processing(success=True)
        messagebox.showinfo("Success", event.message)
    elif event.event_type == "error":
        self._log(event.message)
        self._finish_processing(success=False)
        messagebox.showerror("Error", event.message)
    elif event.event_type == "models_ready":
        self._populate_model_dropdown(event.data)
    # ... etc
```

### Task 2.5 — Implement `_finish_processing()`

- Re-enable "Start OCR" button
- Stop progress bar animation
- Reset button text

**Acceptance criteria:**
- [ ] Workers never touch Tk widgets directly
- [ ] All GUI updates flow through the queue
- [ ] Only one background thread runs at a time (enforced by button disable)

---

## 5. Phase 3 — File Processing (PDF + Image)

### Task 3.1 — File Selection Handler

- `filedialog.askopenfilename()` with filters for PDF + image types
- Store selected path in `self._selected_file`
- Update filename label

### Task 3.2 — Image Processing Worker

```python
def _process_image_worker(filepath):
    try:
        event_queue.put(Event("log", "[Start] Processing image..."))
        with open(filepath, "rb") as f:
            image_bytes = f.read()
        result = _send_page_to_vlm(image_bytes)
        output_path = filepath.rsplit(".", 1)[0] + "_extracted.md"
        with open(output_path, "w") as f:
            f.write(result)
        event_queue.put(Event("success", f"[Success] File saved to {output_path}"))
    except Exception as e:
        event_queue.put(Event("error", f"[Error] {str(e)}"))
```

### Task 3.3 — PDF Processing Worker

```python
def _process_pdf_worker(filepath, dpi):
    tmpdir = None
    try:
        tmpdir = tempfile.mkdtemp()
        doc = fitz.open(filepath)
        pages = len(doc)
        event_queue.put(Event("log", f"[Start] Processing PDF ({pages} pages)..."))

        all_text = []
        for i in range(pages):
            event_queue.put(Event("log", f"[{i+1}/{pages}] Converting page {i+1} to image..."))
            page = doc[i]
            pix = page.get_pixmap(dpi=int(dpi))
            page_path = os.path.join(tmpdir, f"page_{i+1}.png")
            pix.save(page_path)

            event_queue.put(Event("log", f"[{i+1}/{pages}] Sending page {i+1} to LM Studio..."))
            with open(page_path, "rb") as f:
                page_bytes = f.read()
            result = _send_page_to_vlm(page_bytes)
            all_text.append(result)

        # Join pages with double newlines
        full_text = "\n\n".join(all_text)
        output_path = filepath.rsplit(".", 1)[0] + "_extracted.md"
        with open(output_path, "w") as f:
            f.write(full_text)

        event_queue.put(Event("success", f"[Success] File saved to {output_path}"))
    except Exception as e:
        event_queue.put(Event("error", f"[Error] {str(e)}"))
    finally:
        if tmpdir and os.path.exists(tmpdir):
            import shutil
            shutil.rmtree(tmpdir)
```

**Acceptance criteria:**
- [ ] Image files are sent directly to VLM without intermediate disk writes
- [ ] PDF pages are rendered at user-selected DPI
- [ ] Temp directory is always cleaned up (even on error) via `finally`
- [ ] Output `.md` file is placed alongside source with `_extracted.md` suffix
- [ ] Multi-page PDFs produce combined Markdown with page separation

---

## 6. Phase 4 — LM Studio Integration (Vision API)

### Task 6.1 — VLM Client Helper

```python
def _get_client(url):
    return openai.OpenAI(base_url=f"{url}/v1", api_key="not-needed")
```

### Task 6.2 — Send Page to VLM

```python
SYSTEM_PROMPT = """Convert this image into Markdown text format. Your task is to perform high-accuracy Optical Character Recognition (OCR). Preserve the document's structure as accurately as possible: headers, lists, and tables. Do not add any greetings, explanations, or introductory/concluding remarks. Output only the raw recognized text."""

def _send_page_to_vlm(image_bytes, model, url):
    client = _get_client(url)
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": [
                {"type": "text", "text": "Extract the text from this image."},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}}
            ]}
        ],
        max_tokens=8192,
    )
    return response.choices[0].message.content
```

### Task 6.3 — Model Refresh Worker

```python
def _refresh_models_worker(url):
    try:
        client = openai.OpenAI(base_url=f"{url}/v1", api_key="not-needed")
        models = client.models.list()
        model_ids = [m.id for m in models]
        event_queue.put(Event("models_ready", "Models fetched", model_ids))
    except Exception as e:
        event_queue.put(Event("error", f"[Error] Could not fetch models: {str(e)}"))
```

**Acceptance criteria:**
- [ ] Model list fetch does not freeze the GUI
- [ ] Failed model fetch shows error but does not crash the app
- [ ] System prompt is passed verbatim as specified
- [ ] Images are sent as `data:image/png;base64,...` in the vision request
- [ ] `max_tokens` is set high enough for large pages (8192)

---

## 7. Phase 5 — GUI Layout & Widgets

### Task 7.1 — Application Shell

```python
import customtkinter as ctk

ctk.set_appearance_mode("Dark")
ctk.set_default_color_theme("blue")  # or "dark-blue"

class App(ctk.CTk):
    def __init__(self):
        super().__init__()
        self.title("Local OCR — Vision Language Model")
        self.geometry("700x650")
        self.minsize(500, 450)
        # ...
```

### Task 7.2 — Layout Structure (using `CTkFrame` containers)

```
┌──────────────────────────────────────────────┐
│  Title / App Header                           │
├──────────────────────────────────────────────┤
│  ┌─ File Selection ───────────────────────┐   │
│  │  [Select File]   /path/to/file.pdf     │   │
│  └────────────────────────────────────────┘   │
│  ┌─ Settings ─────────────────────────────┐   │
│  │  Server URL: [http://localhost:1234 ]  │   │
│  │  Models:    [▼ Refresh Models]        │   │
│  │           [ qwen/qwen3.6-27b      ▼ ]  │   │
│  │  PDF DPI:   [ 150              ▼ ]     │   │
│  └────────────────────────────────────────┘   │
│  ┌────────────────────────────────────────┐   │
│  │       [   Start OCR   ] (accented)     │   │
│  └────────────────────────────────────────┘   │
│  ┌─ Progress ─────────────────────────────┐   │
│  │  ████████████████░░░░░░░░░░░░░░░░░░░░  │   │
│  └────────────────────────────────────────┘   │
│  ┌─ Log ──────────────────────────────────┐   │
│  │  [Start]                               │   │
│  │  [1/3] Converting...                   │   │
│  │  [2/3] Sending page 1 to LM Studio...  │   │
│  │  ...                                   │   │
│  └────────────────────────────────────────┘   │
└──────────────────────────────────────────────┘
```

### Task 7.3 — Widget Specifications

| Widget | Type | Properties |
|---|---|---|
| File button | `CTkButton` | text="Select File", command=`_select_file` |
| File label | `CTkLabel` | wraps text, shows selected filename |
| Server URL | `CTkEntry` | default="http://localhost:1234" |
| Refresh Models | `CTkButton` | text="Refresh Models", command=`_refresh_models` |
| Model selector | `CTkComboBox` | state="combobox" (editable), populated dynamically |
| DPI selector | `CTkOptionMenu` | values=["100","150","200","300"], default="150" |
| Start OCR | `CTkButton` | fg_color=accent, large padding, command=`_start_ocr` |
| Progress bar | `CTkProgressBar` | mode="indeterminate", hidden until processing |
| Log textbox | `CTkTextbox` | font=("Consolas", 11) or system monospace, state="normal" |

### Task 7.4 — Responsive Layout

- Use `.grid()` with `rowconfigure`/`columnconfigure` weights for expandable areas
- Log textbox gets `sticky="nsew"` and `rowconfigure(weight=1)` so it grows/shrinks
- Use `ctk.CTkScrollableFrame` for settings if needed on small windows

### Task 7.5 — Log Textbox Autoscroll

```python
def _log(self, msg):
    self._log_box.insert("end", msg + "\n")
    self._log_box.see("end")
```

**Acceptance criteria:**
- [ ] Dark theme is active by default
- [ ] All widgets render correctly at minimum window size (500×450)
- [ ] Layout is responsive — log area expands when window is resized
- [ ] Monospace font on log textbox
- [ ] Log textbox auto-scrolls to bottom on new entries

---

## 8. Phase 6 — Event Wiring & Integration

### Task 8.1 — `_start_ocr()` Entry Point

```python
def _start_ocr(self):
    if not self._selected_file:
        messagebox.showwarning("No file", "Please select a file first.")
        return

    model = self._model_combo.get()
    url = self._url_entry.get().rstrip("/")
    dpi = self._dpi_menu.get()

    if not model:
        messagebox.showwarning("No model", "Please select or enter a model.")
        return

    # Disable UI
    self._start_btn.configure(state="disabled", text="Processing, please wait...")
    self._progress_bar.start()
    self._selected_file_path = None  # prevent re-select

    ext = os.path.splitext(self._selected_file)[1].lower()
    if ext in IMAGE_EXTENSIONS:
        threading.Thread(target=_process_image_worker,
                         args=(self._selected_file,),
                         daemon=True).start()
    else:  # PDF
        threading.Thread(target=_process_pdf_worker,
                         args=(self._selected_file, dpi),
                         daemon=True).start()
```

### Task 8.2 — `_refresh_models()` Entry Point

```python
def _refresh_models(self):
    url = self._url_entry.get().rstrip("/")
    threading.Thread(target=_refresh_models_worker,
                     args=(url,),
                     daemon=True).start()
```

### Task 8.3 — `_populate_model_dropdown(model_ids)`

- Clear existing values
- Set `values=model_ids` on the combo box
- If first load and list is non-empty, set default to first model

### Task 8.4 — Error Handling & UI Recovery

- All worker exceptions are caught and reported via `Event("error", ...)`
- `_finish_processing()` always re-enables the button regardless of outcome
- Model fetch failure does not clear existing dropdown entries

**Acceptance criteria:**
- [ ] "Start OCR" is disabled during processing
- [ ] Progress bar runs in indeterminate mode during processing
- [ ] Only one background operation runs at a time
- [ ] Button text changes to "Processing, please wait..."
- [ ] UI recovers to normal state after success or error
- [ ] Native `messagebox` popups appear on completion/error

---

## 9. Phase 7 — Testing & Polish

### Task 9.1 — Manual Test Scenarios

| # | Scenario | Expected Result |
|---|---|---|
| 1 | Launch app, no file selected, click "Start OCR" | Warning messagebox |
| 2 | Select a .png image, start OCR | Image sent to VLM, `_extracted.md` created |
| 3 | Select a multi-page PDF at 300 DPI | Each page rendered, combined result saved |
| 4 | Click "Refresh Models" with unreachable server | Error message in log, no crash |
| 5 | Click "Refresh Models" with running server | Dropdown populated with model list |
| 6 | Manually type a model name (not in list), start OCR | Request sent with typed model name |
| 7 | Close app while processing | Clean exit (daemon threads) |
| 8 | Resize window to minimum | No widget clipping |
| 9 | Select file, change URL, start OCR | Uses new URL |
| 10 | Process PDF, check temp dir is cleaned | No leftover temp files |

### Task 9.2 — Edge Cases

- [ ] Empty PDF (0 pages) → graceful error message
- [ ] Very large image → ensure base64 encoding doesn't exceed model context
- [ ] Network timeout during VLM call → caught, reported, UI recovers
- [ ] Output file already exists → overwrite (spec doesn't mention preservation)
- [ ] Non-standard image format → rejected at file selection

### Task 9.3 — Code Quality

- [ ] All worker functions have try/except/finally as needed
- [ ] No Tk calls from background threads
- [ ] Temp files always cleaned up
- [ ] Code is well-commented (docstrings on major functions)
- [ ] `requirements.txt` versions pinned with minimums

### Task 9.4 — Documentation

- [ ] `README.md` with install instructions, usage guide, and LM Studio setup notes

---

## 10. Risk Register & Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| LM Studio server unavailable | User can't process files | Clear error messages; manual model entry still works |
| Large PDFs (100+ pages) | Long processing time, potential OOM | Progress logging keeps user informed; consider adding a "cancel" in future |
| VLM context window exceeded | Truncated output | `max_tokens=8192` should handle most pages; could add chunking later |
| `customtkinter` version incompatibility | GUI crashes | Pin minimum version in `requirements.txt` |
| `pymupdf` licensing (AGPL) | Legal concern for redistribution | Fine for personal/local use; noted in README |
| Base64 image too large for API | Request rejected | Could add image resizing as future enhancement |

---

## 11. File Map (Final)

```
myocr/
├── Local_OCR.md                  # Original specification
├── IMPLEMENTATION_PLAN.md        # This plan
├── main.py                       # Complete application (~350-450 lines)
├── requirements.txt              # Dependencies
└── README.md                     # User documentation
```

---

## Implementation Order Summary

```
Phase 1: Scaffolding        → 15 min
Phase 2: Worker Engine      → 20 min
Phase 3: File Processing    → 25 min
Phase 4: LM Studio API      → 20 min
Phase 5: GUI Layout         → 30 min
Phase 6: Event Wiring       → 20 min
Phase 7: Testing & Polish   → 20 min
─────────────────────────────────────
Total estimated effort: ~2.5 hours
```

---

*This plan is designed to be executed sequentially. Each phase builds on the previous one, and acceptance criteria provide clear checkpoints. The single-file architecture keeps the project simple to distribute and run.*
