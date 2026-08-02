#!/usr/bin/env bash
# ── Local OCR — Quick Start ─────────────────────────────
# Usage: ./run.sh
# ────────────────────────────────────────────────────────

cd "$(dirname "$0")"

source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
