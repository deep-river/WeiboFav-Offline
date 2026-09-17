#!/usr/bin/env bash
# Double-click in Finder or run: ./scripts/stop-mac.command
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.weibofav-server.pid"
API_PID_FILE="$PROJECT_DIR/.weibofav-api.pid"
PORT_FILE="$PROJECT_DIR/.weibofav-server.port"
API_PORT_FILE="$PROJECT_DIR/.weibofav-api.port"

if [[ ! -f "$PID_FILE" && ! -f "$API_PID_FILE" ]]; then
  echo 'No WeiboFav Offline service was started by this project.'
  exit 0
fi

for pid_file in "$PID_FILE" "$API_PID_FILE"; do
  [[ -f "$pid_file" ]] || continue
  process_pid="$(<"$pid_file")"
  if kill -0 "$process_pid" 2>/dev/null; then
    kill "$process_pid"
    echo "WeiboFav Offline stopped (PID $process_pid)."
  fi
done
rm -f "$PID_FILE" "$API_PID_FILE" "$PORT_FILE" "$API_PORT_FILE"
