#!/bin/bash
# ============================================================
# Chrome Debug Mode Launcher (idempotent)
#
# Uses Playwright to launch Chromium, navigates to Gemini,
# and keeps CDP port open for external interaction.
#
# Safe to run multiple times — skips if already running.
#
# Environment variables (all optional):
#   CDP_PORT          CDP debug port (default: 9222)
#   PROXY_SERVER      HTTP/SOCKS5 proxy (default: http://127.0.0.1:7897)
#
# Usage:
#   bash start-chrome-debug.sh
#   CDP_PORT=9223 bash start-chrome-debug.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Config ----
CDP_PORT="${CDP_PORT:-9222}"
PROXY="${PROXY_SERVER:-http://127.0.0.1:7897}"
LOG_FILE="${LOG_FILE:-/tmp/chrome-debug.log}"
DAEMON_SCRIPT="$SCRIPT_DIR/start-chrome-debug.py"

# ---- Check if already running ----
if curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
    echo "[OK] Chrome debug already running on port $CDP_PORT"
    exit 0
fi

# ---- Ensure proxy is reachable ----
PROXY_HOST=$(echo "$PROXY" | sed 's|http[s]*://||' | cut -d: -f1)
PROXY_PORT=$(echo "$PROXY" | sed 's|.*:||')
if ! curl -s --connect-timeout 2 "http://$PROXY_HOST:$PROXY_PORT" > /dev/null 2>&1; then
    echo "[WARN] Proxy $PROXY not reachable. Attempting to start clash-verge..."
    if command -v clash-verge &> /dev/null; then
        nohup clash-verge &> /dev/null &
        sleep 2
    else
        echo "[WARN] clash-verge not found. Please ensure your proxy is running."
    fi
fi

# ---- Kill stale Chrome ----
pkill -9 -f "chrome.*remote-debugging-port=$CDP_PORT" 2>/dev/null || true
pkill -9 -f "start-chrome-debug.py" 2>/dev/null || true
sleep 2

# ---- Launch Playwright daemon ----
if [ ! -f "$DAEMON_SCRIPT" ]; then
    echo "❌ Daemon not found: $DAEMON_SCRIPT"
    exit 1
fi

echo "[INFO] Launching Chrome daemon..."
nohup python3 "$DAEMON_SCRIPT" > "$LOG_FILE" 2>&1 &

# ---- Wait for CDP ----
echo -n "[INFO] Waiting for CDP"
for i in $(seq 1 30); do
    sleep 1
    if curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo " READY"

        # Wait for Gemini to load
        echo -n "[INFO] Waiting for Gemini page"
        for j in $(seq 1 20); do
            sleep 1
            TITLE=$(curl -s "http://127.0.0.1:$CDP_PORT/json/list" 2>/dev/null | \
                    python3 -c "import json,sys; pages=json.load(sys.stdin); [print(p.get('title','')) for p in pages if 'gemini' in p.get('url','').lower()]" 2>/dev/null || true)
            if [ -n "$TITLE" ] && [ "$TITLE" != "about:blank" ]; then
                echo " DONE (title: $TITLE)"
                exit 0
            fi
            echo -n "."
        done
        echo " (page may still be loading)"
        exit 0
    fi
    echo -n "."
done

echo " FAILED"
echo "Check: $LOG_FILE"
tail -10 "$LOG_FILE" 2>/dev/null || true
exit 1
