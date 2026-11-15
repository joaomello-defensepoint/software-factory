#!/bin/zsh
# Software Factory launcher: builds the web app, starts the server, opens the UI.
# Double-click from Finder (or run from a terminal). Ctrl+C or closing the window stops the server.
set -e
export PATH="/usr/local/bin:/opt/homebrew/bin:$HOME/.local/bin:$PATH"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
PORT="${PORT:-4100}"
URL="http://127.0.0.1:$PORT"
cd "$REPO"

echo "Software Factory — $REPO"
if curl -sf "$URL/api/health" >/dev/null 2>&1; then
  echo "Already running at $URL — opening it."
  open "$URL"
  exit 0
fi

command -v node >/dev/null || { echo "node not found on PATH (install Node 26 with: n 26.13.0)"; read -k1 -s "?Press any key to close"; exit 1; }
[ -d node_modules ] || { echo "Installing dependencies…"; npm install --no-audit --no-fund; }

echo "Building web app…"
npm run build --silent

# Open the browser once the server answers, then keep the server in the foreground.
( for i in $(seq 1 60); do sleep 1; curl -sf "$URL/api/health" >/dev/null 2>&1 && { open "$URL"; exit 0; }; done ) &
echo "Starting server on $URL (Ctrl+C to stop)…"
npm start --silent
