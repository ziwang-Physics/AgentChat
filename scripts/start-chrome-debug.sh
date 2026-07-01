#!/bin/bash
# ============================================================
# Chrome Debug Mode Launcher (idempotent)
#
# Uses Playwright daemon to launch Chromium with CDP port open.
# Safe to run multiple times — skips if already running.
#
# P0 security fix (2026-06-29): 5-round multi-AI review consensus
#   - Replaced `source .env` with safe KEY=VALUE parser (prevents RCE)
#   - Replaced `pkill -9` with PID file + SIGTERM (prevents cross-process kills)
#   - Chrome startup args are managed by start-chrome-debug.py daemon
#
# v3 (2026-07-02): Chrome PID tracking for precise browser cleanup
#   - Reads /tmp/chrome-debug.chrome.pid written by daemon v3
#   - Kills Chrome browser separately from daemon process
#
# Environment variables (all optional):
#   CDP_PORT          CDP debug port (default: 9222)
#   PROXY_SERVER      HTTP/SOCKS5 proxy (default: http://127.0.0.1:7897)
#   HEADLESS          "1"/"true" for headless, default false (visible GUI)
#
# Usage:
#   bash start-chrome-debug.sh                    # visible window (default)
#   HEADLESS=1 bash start-chrome-debug.sh         # headless mode
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Safe .env loader (P0 fix: NO source — prevents arbitrary code execution) ----
# Only parses strict KEY=VALUE lines.  Strips optional single/double quotes.
# Blocks: PATH, PYTHONPATH, LD_PRELOAD, LD_LIBRARY_PATH injection.
_safe_load_env() {
    local env_file="$1"
    if [ ! -f "$env_file" ]; then
        return 0
    fi
    while IFS='=' read -r key value; do
        # Skip blank lines and comments
        [[ -z "$key" || "$key" =~ ^[[:space:]]*# ]] && continue
        # Only allow safe variable names: uppercase letters, digits, underscore
        if [[ ! "$key" =~ ^[A-Z_][A-Z0-9_]*$ ]]; then
            echo "[WARN] .env: skipping unsafe key '$key'" >&2
            continue
        fi
        # Block injection of dangerous path variables
        case "$key" in
            PATH|PYTHONPATH|LD_PRELOAD|LD_LIBRARY_PATH|PYTHONSTARTUP|BASH_ENV|PROMPT_COMMAND)
                echo "[WARN] .env: blocked dangerous key '$key'" >&2
                continue
                ;;
        esac
        # Strip surrounding quotes (single or double)
        value="${value#\"}"; value="${value%\"}"
        value="${value#\'}"; value="${value%\'}"
        export "$key=$value"
    done < "$env_file"
}

# Load .env from home dir first, then project dir (project overrides)
if [ -f "$HOME/.env" ]; then
    _safe_load_env "$HOME/.env"
fi
if [ -f "$PROJECT_DIR/.env" ]; then
    _safe_load_env "$PROJECT_DIR/.env"
fi

# ---- Config (env vars override defaults) ----
CDP_PORT="${CDP_PORT:-9222}"
PROXY="${PROXY_SERVER:-http://127.0.0.1:7897}"
HEADLESS="${HEADLESS:-false}"
export CDP_PORT PROXY_SERVER PROXY HEADLESS
LOG_FILE="${LOG_FILE:-/tmp/chrome-debug.log}"
DAEMON_PID_FILE="$HOME/.local/state/agentchat/chrome-debug.pid"
CHROME_PID_FILE="/tmp/chrome-debug.chrome.pid"
DAEMON_SCRIPT="$SCRIPT_DIR/start-chrome-debug.py"

# ---- Check if already running (PID file + process verification) ----
if [ -f "$DAEMON_PID_FILE" ]; then
    _old_pid=$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)
    if [ -n "$_old_pid" ] && kill -0 "$_old_pid" 2>/dev/null; then
        # Verify it's actually the Chrome daemon (not a PID reuse)
        _cmd=$(ps -p "$_old_pid" -o args= 2>/dev/null || true)
        if echo "$_cmd" | grep -q "start-chrome-debug"; then
            echo "[OK] Chrome daemon already running (PID $_old_pid)"
            exit 0
        fi
    fi
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

# ---- Clean up stale Chrome browser (v3: precise PID, not pkill -9) ----
if [ -f "$CHROME_PID_FILE" ]; then
    _chrome_pid=$(cat "$CHROME_PID_FILE" 2>/dev/null || true)
    if [ -n "$_chrome_pid" ] && kill -0 "$_chrome_pid" 2>/dev/null; then
        echo "[INFO] Stopping stale Chrome browser (PID $_chrome_pid)..."
        kill -TERM "$_chrome_pid" 2>/dev/null || true
        sleep 1
        kill -0 "$_chrome_pid" 2>/dev/null && kill -9 "$_chrome_pid" 2>/dev/null || true
    fi
    rm -f "$CHROME_PID_FILE"
fi

# ---- Graceful shutdown of existing daemon (SIGTERM before SIGKILL) ----
if [ -f "$DAEMON_PID_FILE" ]; then
    _pid=$(cat "$DAEMON_PID_FILE" 2>/dev/null || true)
    if [ -n "$_pid" ] && kill -0 "$_pid" 2>/dev/null; then
        echo "[INFO] Stopping existing daemon (PID $_pid)..."
        kill -TERM "$_pid" 2>/dev/null || true
        # Wait up to 5s for graceful shutdown
        for i in $(seq 1 50); do
            if ! kill -0 "$_pid" 2>/dev/null; then
                echo "[INFO] Daemon stopped gracefully"
                break
            fi
            sleep 0.1
        done
        # Force kill if still alive
        if kill -0 "$_pid" 2>/dev/null; then
            echo "[WARN] Daemon did not stop — force killing"
            kill -9 "$_pid" 2>/dev/null || true
        fi
    fi
    rm -f "$DAEMON_PID_FILE"
fi

sleep 1

# ---- Launch Playwright daemon ----
if [ ! -f "$DAEMON_SCRIPT" ]; then
    echo "❌ Daemon not found: $DAEMON_SCRIPT"
    exit 1
fi

# Use flock to prevent two instances racing to start
exec 200>/tmp/chrome-debug.lock
flock -n 200 || { echo "❌ Another chrome-debug launcher is running"; exit 1; }

echo "[INFO] Launching Chrome daemon..."
nohup python3 "$DAEMON_SCRIPT" > "$LOG_FILE" 2>&1 &
DAEMON_PID=$!
echo "[INFO] Daemon PID: $DAEMON_PID"

# ---- Wait for CDP ----
echo -n "[INFO] Waiting for CDP"
for i in $(seq 1 30); do
    sleep 1
    if curl -s "http://127.0.0.1:$CDP_PORT/json/version" > /dev/null 2>&1; then
        echo " READY"
        exit 0
    fi
    # Check if daemon is still alive
    if ! kill -0 "$DAEMON_PID" 2>/dev/null; then
        echo " DAEMON DIED"
        echo "Check: $LOG_FILE"
        tail -20 "$LOG_FILE" 2>/dev/null || true
        exit 1
    fi
    echo -n "."
done

echo " FAILED"
echo "Check: $LOG_FILE"
tail -20 "$LOG_FILE" 2>/dev/null || true
exit 1
