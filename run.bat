@echo off
REM ── MyOCR — Quick Start ─────────────────────────────────
REM Author: Sergio Ferraro
REM Repository: https://github.com/sergioferraro/MyOCR
REM Usage: run.bat
REM ────────────────────────────────────────────────────────

cd /d "%~dp0"

REM Create virtual environment if it doesn't exist
if not exist ".venv" (
    echo Creating virtual environment...
    python -m venv .venv
    echo Installing dependencies...
    pip install -r requirements.txt
)

call .venv\Scripts\activate
uvicorn main:app --host 0.0.0.0 --port 8765 --reload
deactivate
