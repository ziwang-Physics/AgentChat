#!/bin/bash
# ============================================================
# Chrome Debug Mode Launcher (idempotent)
# Keeps Chrome running with remote debugging on port 9222.
# Safe to run multiple times — skips if already running.
#
# Profile is PERSISTED across restarts so Google login
# session is preserved. No need to re-login to Gemini.
# ============================================================

set -euo pipefail

CHROME="/home/wangzi/soft/chrome/opt/google/chrome/chrome"
PROFILE_DIR="/home/wangzi/.chrome-debug-profile"
DEBUG_PORT=9222
PROXY="http://127.0.0.1:7897"
LOG_FILE="/tmp/chrome-debug.log"
URL="${1:-about:blank}"

# ---- Check if already running ----
if curl -s "http://127.0.0.1:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
    echo "[OK] Chrome debug already running on port $DEBUG_PORT"
    exit 0
fi

# ---- Ensure clash-verge is running ----
if ! pgrep -f verge-mihomo > /dev/null 2>&1; then
    echo "[INFO] Starting clash-verge..."
    clash-verge &> /dev/null &
    sleep 2
fi

# ---- Kill stale Chrome processes that might hold the port ----
STALE=$(pgrep -f "chrome.*remote-debugging-port=$DEBUG_PORT" 2>/dev/null || true)
if [ -n "$STALE" ]; then
    echo "[INFO] Killing stale Chrome..."
    pkill -9 -f "chrome.*remote-debugging-port=$DEBUG_PORT" 2>/dev/null || true
    sleep 2
fi

# ---- Ensure profile exists (NEVER clean it — preserves login) ----
mkdir -p "$PROFILE_DIR"

# ---- Launch Chrome ----
echo "[INFO] Starting Chrome debug mode..."
nohup "$CHROME" \
    --remote-debugging-port="$DEBUG_PORT" \
    --remote-allow-origins=* \
    --no-sandbox \
    --disable-gpu \
    --disable-sync \
    --disable-background-networking \
    --disable-component-update \
    --disable-default-apps \
    --no-first-run \
    --no-default-browser-check \
    --disable-breakpad \
    --disable-quic \
    --proxy-server="$PROXY" \
    --user-data-dir="$PROFILE_DIR" \
    "$URL" &> "$LOG_FILE" &

CPID=$!

# ---- Wait for CDP ----
echo -n "[INFO] Waiting for CDP"
for i in $(seq 1 10); do
    sleep 1
    if curl -s "http://127.0.0.1:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
        echo " READY (PID $CPID)"
        exit 0
    fi
    echo -n "."
done

echo " FAILED"
echo "Check: $LOG_FILE"
tail -10 "$LOG_FILE"
exit 1
