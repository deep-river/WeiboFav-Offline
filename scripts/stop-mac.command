#!/usr/bin/env bash
# Double-click in Finder or run: ./scripts/stop-mac.command
set -euo pipefail

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PID_FILE="$PROJECT_DIR/.weibofav-server.pid"
PORT_FILE="$PROJECT_DIR/.weibofav-server.port"

if [[ ! -f "$PID_FILE" ]]; then
  echo 'No WeiboFav Offline service was started by this project.'
  exit 0
fi

SERVER_PID="$(<"$PID_FILE")"
if kill -0 "$SERVER_PID" 2>/dev/null && [[ "$(ps -p "$SERVER_PID" -o command=)" == *'library_server.py'* ]]; then
  kill "$SERVER_PID"
  echo "WeiboFav Offline stopped (PID $SERVER_PID)."
else
  echo "The recorded service (PID $SERVER_PID) is no longer running."
fi
rm -f "$PID_FILE" "$PORT_FILE"
