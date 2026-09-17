#!/usr/bin/env bash
# Double-click in Finder or run: ./scripts/start-mac.command
set -euo pipefail
export PATH="/usr/sbin:/usr/bin:/bin:$PATH"

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.weibofav-server.pid"
API_PID_FILE="$PROJECT_DIR/.weibofav-api.pid"
PORT_FILE="$PROJECT_DIR/.weibofav-server.port"
API_PORT_FILE="$PROJECT_DIR/.weibofav-api.port"
LOG_DIR="$PROJECT_DIR/data/logs"

cd "$PROJECT_DIR"
mkdir -p "$LOG_DIR"

if [[ -f "$PID_FILE" && -f "$API_PID_FILE" ]] && kill -0 "$(<"$PID_FILE")" 2>/dev/null && kill -0 "$(<"$API_PID_FILE")" 2>/dev/null; then
  if [[ "$(ps -p "$(<"$PID_FILE")" -o command=)" == *'vinext'* ]] && [[ "$(ps -p "$(<"$API_PID_FILE")" -o command=)" == *'library_server.py'* ]]; then
    PORT=4319
    [[ -f "$PORT_FILE" ]] && PORT="$(<"$PORT_FILE")"
    [[ "$PORT" =~ ^[0-9]+$ ]] || PORT=4319
    URL="http://127.0.0.1:$PORT"
    echo "WeiboFav Offline is already running: $URL"
    open "$URL"
    exit 0
  fi
fi

# Replace launch records written by older versions, which started only the API
# service and therefore could not render the Vinext production page.
for stale_pid_file in "$PID_FILE" "$API_PID_FILE"; do
  if [[ -f "$stale_pid_file" ]] && kill -0 "$(<"$stale_pid_file")" 2>/dev/null; then
    stale_command="$(ps -p "$(<"$stale_pid_file")" -o command=)"
    if [[ "$stale_command" == *'library_server.py'* || "$stale_command" == *'vinext'* ]]; then
      kill "$(<"$stale_pid_file")"
    fi
  fi
done
rm -f "$PID_FILE" "$API_PID_FILE" "$PORT_FILE" "$API_PORT_FILE"

command -v node >/dev/null || { echo 'Node.js 22+ is required. On macOS, run: brew install node pnpm'; exit 1; }
command -v pnpm >/dev/null || { echo 'pnpm 12.4.2 is required. On macOS, run: brew install pnpm'; exit 1; }
command -v python3 >/dev/null || { echo 'Python 3 is required. Install Python 3 first.'; exit 1; }

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
PNPM_MAJOR="$(pnpm --version | cut -d. -f1)"
[[ "$NODE_MAJOR" =~ ^[0-9]+$ && "$NODE_MAJOR" -ge 22 ]] || { echo "Node.js 22+ is required; found $(node --version)."; exit 1; }
[[ "$PNPM_MAJOR" =~ ^[0-9]+$ && "$PNPM_MAJOR" -ge 12 ]] || { echo "pnpm 12.4.2+ is required; found $(pnpm --version)."; exit 1; }

next_free_port() {
  local port="$1"
  while lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; do
    port=$((port + 1))
    if (( port > 65535 )); then
    echo 'Could not find a free local TCP port.'
    exit 1
    fi
  done
  printf '%s\n' "$port"
}
PORT="$(next_free_port 4319)"
API_PORT="$(next_free_port "$((PORT + 1))")"
URL="http://127.0.0.1:$PORT"
API_URL="http://127.0.0.1:$API_PORT"

pnpm install --frozen-lockfile
NEXT_PUBLIC_WEIBOFAV_LIBRARY_URL="$API_URL" pnpm build
nohup python3 library_server.py --port "$API_PORT" >"$LOG_DIR/library-server.log" 2>&1 &
API_PID=$!
printf '%s\n' "$API_PID" > "$API_PID_FILE"
printf '%s\n' "$API_PORT" > "$API_PORT_FILE"

for _ in {1..10}; do
  if curl -fsS "$API_URL/api/posts?page=1&pageSize=10" >/dev/null 2>&1; then break; fi
  sleep 0.5
done
if ! curl -fsS "$API_URL/api/posts?page=1&pageSize=10" >/dev/null 2>&1; then
  kill "$API_PID" 2>/dev/null || true
  rm -f "$API_PID_FILE" "$API_PORT_FILE"
  echo "The local API did not start. See $LOG_DIR/library-server.log"
  exit 1
fi

nohup pnpm exec vinext start --port "$PORT" >"$LOG_DIR/web-server.log" 2>&1 &
SERVER_PID=$!
printf '%s\n' "$SERVER_PID" > "$PID_FILE"
printf '%s\n' "$PORT" > "$PORT_FILE"

for _ in {1..10}; do
  if curl -fsS "$URL/" >/dev/null 2>&1; then
    open "$URL"
    echo "WeiboFav Offline is running: $URL"
    exit 0
  fi
  sleep 0.5
done

kill "$SERVER_PID" 2>/dev/null || true
kill "$API_PID" 2>/dev/null || true
rm -f "$PID_FILE" "$API_PID_FILE" "$PORT_FILE" "$API_PORT_FILE"
echo "The web service did not start. See $LOG_DIR/web-server.log"
exit 1
