#!/bin/bash
# ============================================================
# Chrome Debug Mode Launcher (idempotent)
#
# Uses Playwright to launch Chromium, navigates to Gemini,
# and keeps CDP port 9222 open for external interaction.
#
# Safe to run multiple times — skips if already running.
# ============================================================

set -euo pipefail

DEBUG_PORT=9222
DAEMON_SCRIPT="/home/wangzi/start-chrome-debug.py"
LOG_FILE="/tmp/chrome-debug.log"

# ---- Check if already running ----
if curl -s "http://127.0.0.1:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
    echo "[OK] Chrome debug already running on port $DEBUG_PORT"
    exit 0
fi

# ---- Ensure clash-verge is running ----
if ! pgrep -f verge-mihomo > /dev/null 2>&1; then
    echo "[INFO] Starting clash-verge..."
    nohup clash-verge &> /dev/null &
    sleep 2
fi

# ---- Kill stale Chrome ----
pkill -9 -f "chrome.*remote-debugging-port=$DEBUG_PORT" 2>/dev/null || true
pkill -9 -f "start-chrome-debug.py" 2>/dev/null || true
sleep 2

# ---- Launch Playwright daemon ----
echo "[INFO] Launching Chrome daemon..."
nohup python3 "$DAEMON_SCRIPT" > "$LOG_FILE" 2>&1 &

# ---- Wait for CDP ----
echo -n "[INFO] Waiting for CDP"
for i in $(seq 1 30); do
    sleep 1
    if curl -s "http://127.0.0.1:$DEBUG_PORT/json/version" > /dev/null 2>&1; then
        echo " READY"

        # ---- Wait for Gemini tab to fully load ----
        echo -n "[INFO] Waiting for Gemini page to load"
        for j in $(seq 1 20); do
            sleep 1
            TITLE=$(curl -s "http://127.0.0.1:$DEBUG_PORT/json/list" | \
                    python3 -c "import json,sys; pages=json.load(sys.stdin); [print(p.get('title','')) for p in pages if 'gemini' in p.get('url','').lower()]" 2>/dev/null)
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
tail -10 "$LOG_FILE"
exit 1
