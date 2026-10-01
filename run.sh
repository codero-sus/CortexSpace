#!/usr/bin/env bash
# MyWorkspace AI — start with one command. No Docker, no node, no build step.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -d .venv ]; then
  echo "==> Creating virtualenv (.venv)..."
  python3 -m venv .venv
fi

# shellcheck disable=SC1091
source .venv/bin/activate
pip install --quiet --disable-pip-version-check -r requirements.txt

PORT="${PORT:-8787}"
echo "==> MyWorkspace AI starting on http://0.0.0.0:${PORT}"
exec uvicorn app.main:app --host 0.0.0.0 --port "${PORT}"
