#!/usr/bin/env python3
"""
MyOCR — Grounding Test Script
=============================
Author: Sergio Ferraro
Repository: https://github.com/sergioferraro/MyOCR

Test script: validate Qwen-VL grounding capabilities through LM Studio.
================================================================================

Purpose:
  1. Verify that <box>(x1,y1,x2,y2)</box> tokens pass through LM Studio API
  2. Test OCR + grounding combined prompt
  3. Test semi-structured output format (parseable without full JSON mode)

Usage:
  python3 test_grounding.py                          # test all pages of default PDF
  python3 test_grounding.py --page 3                  # test page 3 only
  python3 test_grounding.py --pdf other_file.pdf      # use a different PDF
  python3 test_grounding.py --test 1                  # run only test 1
  python3 test_grounding.py --test 2,3                # run tests 2 and 3

The script renders the selected PDF page(s) to PNG, sends them to
qwen/qwen3-vl-30b via LM Studio, and prints the raw response so we can
inspect whether <box> tokens are present.

NOTE: This script does NOT modify any production code.
"""

import argparse
import base64
import json
import sys
from pathlib import Path

from openai import OpenAI
import fitz  # pymupdf

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
LM_STUDIO_URL = "http://localhost:1234"
MODEL = "qwen/qwen3-vl-30b"
DPI = 150
BASE_DIR = Path(__file__).parent

DEFAULT_PDF = BASE_DIR / "(Analisi Matematica I)Esercizi svolti e richiami di successioni reali e serie numeriche.pdf"
# DEFAULT_PDF = BASE_DIR / "Springer - Mathematical Problems in Image Processing.pdf"

client = OpenAI(base_url=f"{LM_STUDIO_URL}/v1", api_key="not-needed")

# ---------------------------------------------------------------------------
# Prompts
# ---------------------------------------------------------------------------

PROMPT_TEST1_GROUNDING = """
You are a document analysis assistant. Your task is to identify and locate
all visual elements in the provided image that are NOT regular text.

Visual elements include: charts, graphs, diagrams, figures, tables with
complex formatting, mathematical illustrations, logos, photographs, or
any region that cannot be accurately represented as plain text/markdown.

For EACH visual element you detect, output a bounding box using the
<box>(x1,y1,x2,y2)</box> tag format, where coordinates are normalized
to 0-1000.

After listing all bounding boxes, provide a brief description of each
detected element.

If the page contains ONLY regular text (no charts, graphs, or images),
simply state: "No visual elements detected - page contains only text."

IMPORTANT: You MUST use the <box>(x1,y1,x2,y2)</box> format for every
visual element you find. Do not skip this format.
"""

PROMPT_TEST2_OCR_GROUNDING = """
Convert this document page into Markdown text. Perform high-accuracy OCR
on all textual content, preserving document structure (headers, lists,
tables, math).

HOWEVER, when you encounter regions that contain charts, graphs, diagrams,
figures, or any visual content that cannot be accurately converted to
text, do the following:

1. Insert a placeholder in the markdown at the appropriate location:
   ![description](IMAGE_REF_N)

2. After the markdown, list all image references with their bounding
   boxes using this format:
   BOX_N: <box>(x1,y1,x2,y2)</box> - description

Where coordinates are normalized to 0-1000.

Example output structure:
---
# Header text here

Some paragraph text...

![bar chart showing revenue](IMAGE_REF_1)

More text below the chart...

---
BOX_1: <box>(200,400,800,700)</box> - bar chart showing quarterly revenue

Do NOT attempt to describe charts/graphs in text — always use the
placeholder + bounding box format instead.
"""

PROMPT_TEST3_STRUCTURED = """
Analyze this document page and return a structured response.

RULES:
- Extract ALL text as markdown
- Detect visual elements (charts, graphs, diagrams, figures) that
  cannot be converted to text
- For each visual element, provide its bounding box and a description

Return your response in this EXACT format:

===TEXT_START===
(markdown text here, with ![desc](IMG_N) placeholders for visual regions)
===TEXT_END===

===BOXES_START===
N|<box>(x1,y1,x2,y2)</box>|description
(one line per detected visual element, N starts at 1)
===BOXES_END===

If no visual elements are detected, leave the BOXES section empty:
===BOXES_START===
===BOXES_END===

IMPORTANT: Always include all four delimiters (===TEXT_START===,
===TEXT_END===, ===BOXES_START===, ===BOXES_END===).
"""

# ---------------------------------------------------------------------------
# Test 4 — Optimized: best of Test 2 (OCR quality) + delimiters + inline placeholders
# ---------------------------------------------------------------------------

PROMPT_TEST4_OPTIMIZED = """
Convert this document page into Markdown text. Perform high-accuracy OCR
on all textual content, preserving document structure: headers, lists,
tables, and math formulas (use LaTeX with $...$ and $$...$$).

IMPORTANT RULES:

1. IGNORE any UI elements, sidebars, toolbars, navigation icons, or
   interface artifacts that are NOT part of the document content itself.
   (e.g. numbered page buttons, arrow icons, pencil icons, question mark
   icons along the edges of the page). If the page has ONLY such UI
   artifacts and no real document content to preserve as images,
   leave the BOXES section EMPTY.

2. When you encounter a chart, graph, diagram, figure, photograph, or
   any visual element that cannot be accurately represented as text,
   insert a placeholder at the appropriate location in the markdown:
   ![brief description](IMG_N)
   where N is a sequential number starting from 1.

3. MATHEMATICAL FORMULAS AND EQUATIONS ARE NOT VISUAL ELEMENTS.
   They MUST be transcribed as LaTeX math in the markdown text.
   Do NOT create bounding boxes for formulas, equations, or any
   mathematical notation. Only create boxes for charts, graphs,
   diagrams, photographs, and illustrative figures.

4. Limit the number of visual elements to at most 5 per page.
   If you find more, only report the most significant ones.

5. After the markdown content, add a BOXES section with delimiters.
   Each box entry MUST use this exact format:
   <box>(x1,y1,x2,y2)</box> | IMG_N | description

   Coordinates are normalized to 0-1000.
   The IMG_N label MUST match the placeholder number used in the text.

6. If the page contains ONLY text (no charts/graphs/figures to preserve),
   output the text and an empty BOXES section.

OUTPUT FORMAT (follow this structure exactly):

===TEXT_START===
# Your markdown here

Some text...

![bar chart showing quarterly data](IMG_1)

More text below...
===TEXT_END===

===BOXES_START===
<box>(200,400,800,700)</box> | IMG_1 | bar chart showing quarterly data
===BOXES_END===

Do NOT add greetings, explanations, or remarks outside the delimiters.
"""

TESTS = [
    {
        "id": 1,
        "name": "Grounding base — <box> token detection",
        "system": "You are a helpful document analysis assistant.",
        "user": PROMPT_TEST1_GROUNDING,
        "description": (
            "Verifica che LM Studio non strip-pi i <box>(x1,y1,x2,y2)</box> tokens "
            "e che il modello sappia localizzare elementi visivi."
        ),
    },
    {
        "id": 2,
        "name": "OCR + grounding combinato",
        "system": (
            "Convert this image into Markdown text format. "
            "Preserve document structure. Do not add greetings or explanations."
        ),
        "user": PROMPT_TEST2_OCR_GROUNDING,
        "description": (
            "Verifica che il modello faccia OCR del testo E segnali grafici "
            "con placeholder + bounding box."
        ),
    },
    {
        "id": 3,
        "name": "Output semi-strutturato (delimitatori)",
        "system": (
            "You are a document analysis assistant. Return structured output "
            "with delimiters. Be precise and concise."
        ),
        "user": PROMPT_TEST3_STRUCTURED,
        "description": (
            "Verifica che il modello rispetti il formato con delimitatori "
            "===TEXT_START=== / ===BOXES_START=== ecc."
        ),
    },
    {
        "id": 4,
        "name": "OPTIMIZED v2 — OCR + inline placeholders + delimiters + ignore UI + math-safe",
        "system": (
            "You are a document OCR assistant. Extract text as markdown. "
            "Use LaTeX for math. Use placeholders for non-text visual elements. "
            "Ignore UI/sidebar artifacts. Math formulas are NOT visual elements."
        ),
        "user": PROMPT_TEST4_OPTIMIZED,
        "description": (
            "v2: aggiunta regola esplicita 'formule matematiche NON sono elementi "
            "visivi' + limite max 5 box/pagina + box vuoti se solo icone UI. "
            "Qualità OCR del Test 2 + placeholder inline + delimitatori + <box>()."
        ),
    },
]



# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def render_page_to_png(pdf_path: Path, page_num: int, dpi: int = DPI) -> bytes:
    """Render a single PDF page (1-based) to PNG bytes."""
    doc = fitz.open(str(pdf_path))
    page = doc[page_num - 1]
    pix = page.get_pixmap(dpi=dpi)
    img_bytes = pix.tobytes("png")
    doc.close()
    return img_bytes


def send_to_vlm(image_bytes: bytes, system_prompt: str, user_prompt: str) -> str:
    """Send an image + prompts to the VLM and return the response text."""
    b64 = base64.b64encode(image_bytes).decode("utf-8")
    response = client.chat.completions.create(
        model=MODEL,
        messages=[
            {"role": "system", "content": system_prompt},
            {"role": "user", "content": [
                {"type": "text", "text": user_prompt},
                {"type": "image_url", "image_url": {"url": f"data:image/png;base64,{b64}"}},
            ]},
        ],
        max_tokens=8192,
    )
    return response.choices[0].message.content


def print_separator(title: str):
    width = 80
    print(f"\n{'=' * width}")
    print(f"  {title}")
    print(f"{'=' * width}")


def analyze_response(text: str):
    """Print a quick analysis of the raw response."""
    import re

    has_box = "<box>" in text
    box_count = text.count("<box>")
    has_text_delim = "===TEXT_START===" in text and "===TEXT_END===" in text
    has_boxes_delim = "===BOXES_START===" in text and "===BOXES_END===" in text
    has_placeholder = "![" in text and "IMG_" in text

    # Also detect malformed boxes (missing opening paren)
    malformed = re.findall(r"<box>\s*\d+,\d+,\d+,\d+\)</box>", text)

    print(f"\n  [Analysis]")
    print(f"  Response length:     {len(text)} chars")
    print(f"  Contains <box>:      {has_box}")
    print(f"  <box> count:         {box_count}")
    print(f"  Malformed <box>:     {len(malformed)}")
    print(f"  Has text delimiters: {has_text_delim}")
    print(f"  Has boxes delimiters:{has_boxes_delim}")
    print(f"  Has ![] placeholders:{has_placeholder}")

    if has_box:
        boxes = re.findall(r"<box>\((\d+),(\d+),(\d+),(\d+)\)</box>", text)
        if boxes:
            print(f"\n  Detected bounding boxes:")
            for b in boxes:
                print(f"    ({b[0]}, {b[1]}, {b[2]}, {b[3]})")


def validate_test4_format(text: str, test_id: int):
    """
    Validate the optimized Test 4 output format.
    Checks:
      - Delimiters present
      - Inline placeholders match box entries
      - Box coordinates are valid (0-1000)
      - No malformed <box> tokens
    """
    import re

    if test_id != 4:
        return

    print(f"\n  [Test 4 Validation]")

    # 1. Check delimiters
    has_text = "===TEXT_START===" in text and "===TEXT_END===" in text
    has_boxes = "===BOXES_START===" in text and "===BOXES_END===" in text
    print(f"    Delimiters TEXT:  {'OK' if has_text else 'MISSING'}")
    print(f"    Delimiters BOXES: {'OK' if has_boxes else 'MISSING'}")

    if not (has_text and has_boxes):
        print(f"    SKIP: delimiters missing, cannot validate further")
        return

    # 2. Extract sections (robust regex — handles whitespace variations)
    text_section = ""
    if has_text:
        m = re.search(r"===TEXT_START===\s*\n?(.*?)\n?=+=+TEXT_END=+=+", text, re.DOTALL)
        if m:
            text_section = m.group(1)

    boxes_section = ""
    if has_boxes:
        m = re.search(r"===BOXES_START===\s*\n?(.*?)\n?=+=+BOXES_END=+=+", text, re.DOTALL)
        if m:
            boxes_section = m.group(1)

    # 3. Parse inline placeholders from text
    placeholders = re.findall(r"!\[([^\]]*)\]\(IMG_(\d+)\)", text_section)
    print(f"    Inline placeholders: {len(placeholders)}")
    for desc, num in placeholders:
        print(f"      IMG_{num}: {desc.strip()}")

    # 4. Parse box entries (robust — handles spaces around |)
    box_pattern = re.compile(
        r"<box>\s*\(?\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*\)?\s*</box>"
        r"\s*\|\s*IMG_(\d+)\s*\|\s*(.+)"
    )
    box_entries = box_pattern.findall(boxes_section)
    print(f"    Box entries:       {len(box_entries)}")

    valid_coords = True
    for x1, y1, x2, y2, img_num, desc in box_entries:
        coords_valid = all(0 <= int(c) <= 1000 for c in (x1, y1, x2, y2))
        if not coords_valid:
            valid_coords = False
        print(f"      IMG_{img_num}: ({x1},{y1},{x2},{y2}) — {desc.strip()}")

    print(f"    Coords 0-1000:     {'OK' if valid_coords else 'OUT OF RANGE'}")

    # 5. Cross-reference: every placeholder has a matching box?
    placeholder_nums = {n for _, n in placeholders}
    box_nums = {n for _, _, _, _, n, _ in box_entries}
    unmatched_ph = placeholder_nums - box_nums
    unmatched_box = box_nums - placeholder_nums

    if unmatched_ph:
        print(f"    WARNING: placeholders without box: {unmatched_ph}")
    if unmatched_box:
        print(f"    WARNING: boxes without placeholder: {unmatched_box}")
    if not unmatched_ph and not unmatched_box and placeholders:
        print(f"    Cross-reference:    OK (all placeholders matched)")
    if not placeholders and not box_entries:
        print(f"    Cross-reference:    OK (no visual elements — text-only page)")

    # 6. Check for malformed boxes in the full text
    malformed = re.findall(r"<box>\s*\d+,\d+,\d+,\d+\)</box>", text)
    if malformed:
        print(f"    WARNING: {len(malformed)} malformed <box> tokens detected")
    else:
        print(f"    Malformed tokens:   none")

    # 7. Check for hallucinated boxes (too many)
    if len(box_entries) > 10:
        print(f"    WARNING: {len(box_entries)} boxes detected — possible hallucination loop")


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------

def main():
    parser = argparse.ArgumentParser(description="Test Qwen-VL grounding via LM Studio")
    parser.add_argument("--pdf", type=str, default=None,
                        help="Path to PDF file (default: Analisi Matematica PDF in repo)")
    parser.add_argument("--page", type=int, default=None,
                        help="Test only this page number (1-based)")
    parser.add_argument("--test", type=str, default=None,
                        help="Comma-separated test IDs to run (default: all). e.g. '1,3'")
    parser.add_argument("--dpi", type=int, default=DPI,
                        help=f"Render DPI (default: {DPI})")
    args = parser.parse_args()

    pdf_path = Path(args.pdf) if args.pdf else DEFAULT_PDF
    if not pdf_path.exists():
        print(f"ERROR: PDF not found: {pdf_path}")
        sys.exit(1)

    # Select which tests to run
    if args.test:
        selected_tests = [int(t.strip()) for t in args.test.split(",")]
    else:
        selected_tests = [t["id"] for t in TESTS]

    # Determine pages to test
    doc = fitz.open(str(pdf_path))
    total_pages = len(doc)
    print(f"\nPDF: {pdf_path.name} ({total_pages} pages)")
    print(f"Model: {MODEL}")
    print(f"Tests: {', '.join(map(str, selected_tests))}")

    if args.page:
        pages_to_test = [args.page]
    else:
        # Test first 3 pages (enough to see variety)
        pages_to_test = list(range(1, min(total_pages + 1, 4)))

    print(f"Pages: {pages_to_test}")
    doc.close()

    # Run tests
    for test in TESTS:
        if test["id"] not in selected_tests:
            continue

        print_separator(f"TEST {test['id']}: {test['name']}")
        print(f"  {test['description']}")

        for page_num in pages_to_test:
            print(f"\n  --- Page {page_num} ---")

            try:
                img_bytes = render_page_to_png(pdf_path, page_num, args.dpi)
                print(f"  Rendered page {page_num} to PNG ({len(img_bytes)} bytes)")

                print(f"  Sending to VLM...")
                response = send_to_vlm(
                    img_bytes,
                    test["system"],
                    test["user"],
                )

                print(f"\n  [Raw Response]")
                print(f"  {'-' * 76}")
                print(response)
                print(f"  {'-' * 76}")

                analyze_response(response)
                validate_test4_format(response, test["id"])

            except Exception as exc:
                print(f"  ERROR on page {page_num}: {exc}")

    print_separator("All tests complete")
    print("\nReview the raw responses above and check:")
    print("  1. Are <box>(x1,y1,x2,y2)</box> tokens present?")
    print("  2. Do coordinates look reasonable (0-1000 range)?")
    print("  3. Does the model distinguish text vs visual elements?")
    print("  4. Test 3: are the delimiters respected?")
    print("  5. Test 4 (OPTIMIZED):")
    print("     - Inline ![desc](IMG_N) placeholders in text?")
    print("     - Placeholders matched to <box> entries?")
    print("     - UI icons ignored?")
    print("     - OCR quality comparable to Test 2?")


if __name__ == "__main__":
    main()
