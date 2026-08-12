#!/usr/bin/env bash
# ── MyOCR — Quick Start ─────────────────────────────────
# Author: Sergio Ferraro
# Repository: https://github.com/sergioferraro/MyOCR
# Usage: ./run.sh
# ────────────────────────────────────────────────────────

cd "$(dirname "$0")"

# Create virtual environment if it doesn't exist
if [ ! -d ".venv" ]; then
    echo "Creating virtual environment..."
    python3 -m venv .venv
    echo "Installing dependencies..."
    pip install -r requirements.txt
fi

source .venv/bin/activate
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
deactivate
