#!/usr/bin/env bash
# Double-click in Finder or run: ./scripts/start-mac.command
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.weibofav-server.pid"
PORT_FILE="$PROJECT_DIR/.weibofav-server.port"
LOG_DIR="$PROJECT_DIR/data/logs"

cd "$PROJECT_DIR"
mkdir -p "$LOG_DIR"

# A normal standalone installation uses Node.js and pnpm from the user's PATH.
# Codex desktop provides a local Node runtime as a development-only fallback so
# this checked-out project can still be launched before Node is installed.
CODEX_RUNTIME="$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies"
if { ! command -v node >/dev/null || ! command -v pnpm >/dev/null; } && [[ -x "$CODEX_RUNTIME/node/bin/node" ]] && [[ -x "$CODEX_RUNTIME/bin/fallback/pnpm" ]]; then
  export PATH="$CODEX_RUNTIME/bin/fallback:$CODEX_RUNTIME/node/bin:$PATH"
  echo 'Using the local Codex Node runtime. Install Node.js and pnpm for standalone use.'
fi

if [[ -f "$PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null; then
  if [[ "$(ps -p "$(<"$PID_FILE")" -o command=)" == *'library_server.py'* ]]; then
    PORT=4319
    [[ -f "$PORT_FILE" ]] && PORT="$(<"$PORT_FILE")"
    [[ "$PORT" =~ ^[0-9]+$ ]] || PORT=4319
    URL="http://127.0.0.1:$PORT"
    echo "WeiboFav Offline is already running: $URL"
    open "$URL"
    exit 0
  fi
fi
rm -f "$PID_FILE" "$PORT_FILE"

command -v node >/dev/null || { echo 'Node.js 22+ is required. Install it from https://nodejs.org/.'; exit 1; }
command -v pnpm >/dev/null || { echo 'pnpm is required. Install it with: corepack enable && corepack prepare pnpm@latest --activate'; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required. Install Python 3 first.'; exit 1; }

PORT=4319
while lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; do
  PORT=$((PORT + 1))
  if (( PORT > 65535 )); then
    echo 'Could not find a free local TCP port.'
    exit 1
  fi
done
URL="http://127.0.0.1:$PORT"

if [[ ! -d node_modules ]]; then
  pnpm install --frozen-lockfile
fi
pnpm build
nohup python3 library_server.py --port "$PORT" >"$LOG_DIR/library-server.log" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"
printf '%s\n' "$PORT" > "$PORT_FILE"

for _ in {1..10}; do
  if curl -fsS "$URL/api/posts?page=1&pageSize=10" >/dev/null 2>&1; then
    open "$URL"
    echo "WeiboFav Offline is running: $URL"
    exit 0
  fi
  sleep 0.5
done

kill "$SERVER_PID" 2>/dev/null || true
rm -f "$PID_FILE" "$PORT_FILE"
echo "The service did not start. See $LOG_DIR/library-server.log"
exit 1
