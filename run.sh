#!/usr/bin/env bash
# ── MyOCR — Quick Start ─────────────────────────────────
# Author: Sergio Ferraro
# Repository: https://github.com/sergioferraro/MyOCR
# Usage: ./run.sh
# ────────────────────────────────────────────────────────

cd "$(dirname "$0")"

source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
