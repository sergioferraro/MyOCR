"""
Local OCR — Vision Language Model
=================================
Desktop application that OCRs PDFs and images into structured Markdown
using a local VLM via LM Studio (OpenAI-compatible API).

Single-file architecture. All GUI updates flow through a thread-safe
event queue — worker threads never touch Tk widgets directly.
"""

# ---------------------------------------------------------------------------
# Imports & Constants
# ---------------------------------------------------------------------------
import os
import sys
import base64
import queue
import shutil
import tempfile
import threading
from dataclasses import dataclass
from tkinter import filedialog, messagebox

import customtkinter as ctk
import fitz  # pymupdf
from openai import OpenAI

# Application constants
DEFAULT_URL = "http://localhost:1234"
DPI_OPTIONS = ["100", "150", "200", "300"]
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
# Event Queue (thread-safe)
# ---------------------------------------------------------------------------

@dataclass
class Event:
    """Thread-safe event dispatched from worker threads to the GUI."""
    event_type: str   # "log", "progress", "success", "error", "models_ready"
    message: str      # human-readable text
    data: object = None  # extra payload (e.g. model list)


# Global queue shared between worker threads and the main GUI thread
event_queue: queue.Queue[Event] = queue.Queue()

# ---------------------------------------------------------------------------
# Worker Functions (run in background threads)
# ---------------------------------------------------------------------------

def _get_client(url: str) -> OpenAI:
    """Create an OpenAI-compatible client pointing at *url*."""
    return OpenAI(base_url=f"{url}/v1", api_key="not-needed")


def _send_page_to_vlm(image_bytes: bytes, model: str, url: str) -> str:
    """
    Send a single image (raw bytes) to the VLM and return the text response.

    Parameters
    ----------
    image_bytes : bytes
        Raw image data (PNG or JPEG).
    model : str
        Model identifier on the remote server.
    url : str
        Base URL of the LM Studio / OpenAI-compatible server.

    Returns
    -------
    str
        The model's Markdown text response.
    """
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


def _refresh_models_worker(url: str):
    """Fetch available models from the server and push them onto the event queue."""
    try:
        client = _get_client(url)
        models = client.models.list()
        model_ids = [m.id for m in models]
        event_queue.put(Event("models_ready", "Models fetched successfully", model_ids))
        event_queue.put(Event("log", f"[Info] Found {len(model_ids)} model(s)"))
    except Exception as exc:
        event_queue.put(Event("error", f"[Error] Could not fetch models: {exc}"))


def _process_image_worker(filepath: str, model: str, url: str):
    """
    OCR a single image file and write *_extracted.md* alongside the source.
    """
    try:
        event_queue.put(Event("log", "[Start] Processing image..."))
        with open(filepath, "rb") as fh:
            image_bytes = fh.read()
        result = _send_page_to_vlm(image_bytes, model, url)
        output_path = filepath.rsplit(".", 1)[0] + "_extracted.md"
        with open(output_path, "w", encoding="utf-8") as fh:
            fh.write(result)
        event_queue.put(Event("success", f"[Success] File saved to\n{output_path}"))
    except Exception as exc:
        event_queue.put(Event("error", f"[Error] {exc}"))


def _is_text_page(page: fitz.Page) -> bool:
    """
    Return True if the page contains meaningful native text.
    A page is considered "text" when ``get_text()`` yields at least
    ``MIN_TEXT_CHARS`` non-whitespace characters.
    """
    MIN_TEXT_CHARS = 20
    raw = page.get_text("text")
    return len(raw.strip()) >= MIN_TEXT_CHARS


def _process_pdf_worker(filepath: str, dpi: str, model: str, url: str, force_vlm: bool = False):
    """
    Process every page of a PDF and write *_extracted.md*.

    Strategy
    --------
    * Pages with native text → extract directly via PyMuPDF (fast, cheap).
    * Scanned pages (no native text) → render to image and send to the VLM.

    This hybrid approach saves VLM tokens/time on text-only PDFs while
    still handling scanned documents correctly.

    When *force_vlm* is True, all pages are rendered to images and sent
    to the VLM regardless of native text presence.
    """
    tmpdir = None
    try:
        tmpdir = tempfile.mkdtemp(prefix="myocr_")
        doc = fitz.open(filepath)
        pages = len(doc)

        if pages == 0:
            event_queue.put(Event("error", "[Error] PDF has 0 pages — nothing to process."))
            return

        event_queue.put(Event("log", f"[Start] Processing PDF ({pages} page(s))..."))

        all_text: list[str] = []
        vlm_pages = 0
        text_pages = 0

        for i in range(pages):
            page = doc[i]

            if not force_vlm and _is_text_page(page):
                # ── Native text: extract directly (no VLM needed) ──
                text = page.get_text("text").strip()
                all_text.append(text)
                text_pages += 1
                event_queue.put(Event("log", f"[{i + 1}/{pages}] Page {i + 1}: text extracted directly"))
            else:
                # ── Scanned page (or force VLM): render → VLM ──
                vlm_pages += 1
                event_queue.put(Event("log", f"[{i + 1}/{pages}] Converting page {i + 1} to image..."))
                pix = page.get_pixmap(dpi=int(dpi))
                page_path = os.path.join(tmpdir, f"page_{i + 1}.png")
                pix.save(page_path)

                event_queue.put(Event("log", f"[{i + 1}/{pages}] Sending page {i + 1} to VLM..."))
                with open(page_path, "rb") as fh:
                    page_bytes = fh.read()
                result = _send_page_to_vlm(page_bytes, model, url)
                all_text.append(result)

        # Summary line so the user knows how much was saved
        event_queue.put(Event(
            "log",
            f"[Info] Done — {text_pages} page(s) via text extraction, "
            f"{vlm_pages} page(s) via VLM."
        ))

        # Join pages with double newlines for separation
        full_text = "\n\n".join(all_text)
        output_path = filepath.rsplit(".", 1)[0] + "_extracted.md"
        with open(output_path, "w", encoding="utf-8") as fh:
            fh.write(full_text)

        event_queue.put(Event("success", f"[Success] File saved to\n{output_path}"))
    except Exception as exc:
        event_queue.put(Event("error", f"[Error] {exc}"))
    finally:
        # Always clean up temp directory
        if tmpdir and os.path.exists(tmpdir):
            shutil.rmtree(tmpdir)

# ---------------------------------------------------------------------------
# GUI Class (customtkinter)
# ---------------------------------------------------------------------------

class App(ctk.CTk):
    """Main application window."""

    def __init__(self):
        super().__init__()
        self.title("Local OCR — Vision Language Model")
        self.geometry("700x650")
        self.minsize(500, 450)

        # State
        self._selected_file: str | None = None

        # Start the queue poller immediately
        self.after(100, self._poll_queue)

        # Build the UI
        self._build_ui()

    # ------------------------------------------------------------------
    # Queue polling & event dispatching
    # ------------------------------------------------------------------

    def _poll_queue(self):
        """
        Drains all available events from the shared queue and dispatches
        each one.  Re-schedules itself via Tk's ``.after()`` mechanism.
        """
        while True:
            try:
                event = event_queue.get_nowait()
                self._handle_event(event)
            except queue.Empty:
                break
        self.after(100, self._poll_queue)

    def _handle_event(self, event: Event):
        """Dispatch an event by type."""
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
        # Unknown event types are silently ignored

    def _log(self, msg: str):
        """Append a line to the log textbox and auto-scroll."""
        self._log_box.configure(state="normal")
        self._log_box.insert("end", msg + "\n")
        self._log_box.see("end")
        self._log_box.configure(state="disabled")

    def _finish_processing(self, success: bool):
        """Restore the UI to its idle state after a job completes."""
        self._start_btn.configure(
            state="normal",
            text="Start OCR",
        )
        self._progress_bar.stop()
        self._progress_bar.set(0)

    # ------------------------------------------------------------------
    # Actions
    # ------------------------------------------------------------------

    def _select_file(self):
        """Open a file dialog and store the chosen path."""
        filepath = filedialog.askopenfilename(
            title="Select file to OCR",
            filetypes=[
                ("Supported files", "*.pdf *.png *.jpg *.jpeg *.webp"),
                ("PDF files", "*.pdf"),
                ("Image files", "*.png *.jpg *.jpeg *.webp"),
                ("All files", "*.*"),
            ],
        )
        if filepath:
            self._selected_file = filepath
            self._file_label.configure(text=filepath)

    def _refresh_models(self):
        """Kick off a background thread to fetch available models."""
        url = self._url_entry.get().rstrip("/")
        if not url:
            messagebox.showwarning("No URL", "Please enter the server URL first.")
            return
        threading.Thread(
            target=_refresh_models_worker,
            args=(url,),
            daemon=True,
        ).start()

    def _start_ocr(self):
        """Main entry point: validate inputs, then launch the appropriate worker."""
        if not self._selected_file:
            messagebox.showwarning("No file", "Please select a file first.")
            return

        model = self._model_combo.get()
        url = self._url_entry.get().rstrip("/")
        dpi = self._dpi_menu.get()

        if not model:
            messagebox.showwarning("No model", "Please select or enter a model.")
            return
        if not url:
            messagebox.showwarning("No URL", "Please enter the server URL.")
            return

        # Disable UI to prevent concurrent operations
        self._start_btn.configure(
            state="disabled",
            text="Processing, please wait...",
        )
        self._progress_bar.start()

        ext = os.path.splitext(self._selected_file)[1].lower()
        if ext in IMAGE_EXTENSIONS:
            threading.Thread(
                target=_process_image_worker,
                args=(self._selected_file, model, url),
                daemon=True,
            ).start()
        elif ext in PDF_EXTENSIONS:
            threading.Thread(
                target=_process_pdf_worker,
                args=(self._selected_file, dpi, model, url, self._force_vlm_var.get()),
                daemon=True,
            ).start()
        else:
            messagebox.showwarning(
                "Unsupported format",
                f"File type '{ext}' is not supported.\nSupported: PDF, PNG, JPG, WebP",
            )
            self._finish_processing(success=False)

    # ------------------------------------------------------------------
    # Helpers
    # ------------------------------------------------------------------

    def _populate_model_dropdown(self, model_ids: list[str]):
        """Update the model combo-box with fetched model identifiers."""
        self._model_combo.configure(values=model_ids)
        if model_ids and not self._model_combo.get():
            self._model_combo.set(model_ids[0])
        self._log(f"[Info] Populated {len(model_ids)} model(s)")

    # ------------------------------------------------------------------
    # UI construction
    # ------------------------------------------------------------------

    def _build_ui(self):
        """Lay out all widgets using grid geometry."""
        # Row 0 — title
        title = ctk.CTkLabel(
            self,
            text="Local OCR",
            font=ctk.CTkFont(size=22, weight="bold"),
        )
        title.grid(row=0, column=0, padx=20, pady=(15, 5), sticky="w")

        # Row 1 — File selection frame
        file_frame = ctk.CTkFrame(self)
        file_frame.grid(row=1, column=0, padx=20, pady=10, sticky="ew")

        self._select_btn = ctk.CTkButton(
            file_frame,
            text="Select File",
            command=self._select_file,
        )
        self._select_btn.pack(side="left", padx=(0, 10), pady=10)

        self._file_label = ctk.CTkLabel(
            file_frame,
            text="No file selected",
            wraplength=550,
            anchor="w",
        )
        self._file_label.pack(side="left", fill="x", expand=True, pady=10)

        # Row 2 — Settings frame
        settings_frame = ctk.CTkFrame(self)
        settings_frame.grid(row=2, column=0, padx=20, pady=10, sticky="ew")
        settings_frame.columnconfigure(1, weight=1)

        # Server URL
        ctk.CTkLabel(settings_frame, text="Server URL:").grid(
            row=0, column=0, padx=(10, 5), pady=(10, 5), sticky="e"
        )
        self._url_entry = ctk.CTkEntry(settings_frame, placeholder_text=DEFAULT_URL)
        self._url_entry.insert(0, DEFAULT_URL)
        self._url_entry.grid(row=0, column=1, padx=(0, 5), pady=(10, 5), sticky="ew")

        # Refresh Models button
        self._refresh_btn = ctk.CTkButton(
            settings_frame,
            text="Refresh Models",
            command=self._refresh_models,
            width=120,
        )
        self._refresh_btn.grid(row=0, column=2, padx=(5, 10), pady=(10, 5))

        # Model selector
        ctk.CTkLabel(settings_frame, text="Model:").grid(
            row=1, column=0, padx=(10, 5), pady=(0, 10), sticky="e"
        )
        self._model_combo = ctk.CTkComboBox(
            settings_frame,
            values=[],
            state="normal",  # editable so user can type a model name
        )
        self._model_combo.grid(row=1, column=1, columnspan=2, padx=(0, 10), pady=(0, 10), sticky="ew")

        # DPI selector
        ctk.CTkLabel(settings_frame, text="PDF DPI:").grid(
            row=2, column=0, padx=(10, 5), pady=(0, 10), sticky="e"
        )
        self._dpi_menu = ctk.CTkOptionMenu(
            settings_frame,
            values=DPI_OPTIONS,
            command=lambda v: None,  # value read at OCR time
        )
        self._dpi_menu.set("150")
        self._dpi_menu.grid(row=2, column=1, columnspan=2, padx=(0, 10), pady=(0, 10), sticky="ew")

        # Force VLM checkbox
        self._force_vlm_var = ctk.BooleanVar(value=False)
        self._force_vlm_cb = ctk.CTkCheckBox(
            settings_frame,
            text="Force VLM (send all pages to VLM)",
            variable=self._force_vlm_var,
        )
        self._force_vlm_cb.grid(row=3, column=0, columnspan=3, padx=(10, 10), pady=(0, 10), sticky="w")

        # Row 3 — Start button
        self._start_btn = ctk.CTkButton(
            self,
            text="Start OCR",
            command=self._start_ocr,
        )
        self._start_btn.grid(row=3, column=0, padx=20, pady=15)

        # Row 4 — Progress bar
        self._progress_bar = ctk.CTkProgressBar(self, mode="indeterminate")
        self._progress_bar.grid(row=4, column=0, padx=20, pady=(0, 5), sticky="ew")

        # Row 5 — Log textbox (expandable)
        log_label = ctk.CTkLabel(self, text="Log:")
        log_label.grid(row=5, column=0, padx=20, pady=(10, 0), sticky="w")

        self._log_box = ctk.CTkTextbox(
            self,
            wrap="word",
            font=ctk.CTkFont(family="Consolas", size=11),
        )
        self._log_box.grid(row=6, column=0, padx=20, pady=(0, 15), sticky="nsew")
        self._log_box.configure(state="disabled")

        # Make the log area expandable
        self.grid_rowconfigure(6, weight=1)
        self.grid_columnconfigure(0, weight=1)

# ---------------------------------------------------------------------------
# Main Block
# ---------------------------------------------------------------------------

def main():
    """Application entry point."""
    ctk.set_appearance_mode("Dark")
    ctk.set_default_color_theme("blue")
    app = App()
    app.mainloop()


if __name__ == "__main__":
    main()
