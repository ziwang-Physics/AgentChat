#!/bin/bash
# ============================================================
# connect-gemini.sh — 一键连接 Gemini (可移植版)
#
# Chrome 由 start-chrome-debug.sh (Playwright daemon) 管理。
# 本脚本负责验证 Gemini tab 状态，必要时创建/刷新。
#
# Environment variables:
#   CDP_PORT       (default: 9222)
#   GEMINI_URL     (default: https://gemini.google.com/u/0/app)
#
# Usage:
#   bash connect-gemini.sh
# ============================================================

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

# ---- Auto-load .env from project root ----
if [ -f "$PROJECT_DIR/.env" ]; then
    set -a
    source "$PROJECT_DIR/.env"
    set +a
fi

# ---- Config (env vars override defaults) ----
CDP_PORT="${CDP_PORT:-9222}"
GEMINI_URL="${GEMINI_URL:-https://gemini.google.com/u/0/app}"
START_SCRIPT="$SCRIPT_DIR/start-chrome-debug.sh"

# ---- 1. 确保 Chrome 运行 ----
echo "[1/3] Ensuring Chrome is running..."
bash "$START_SCRIPT"

# ---- 2. 检查 Gemini tab ----
echo "[2/3] Checking Gemini tab..."
STATUS=$(CDP_PORT="$CDP_PORT" python3 << 'PYEOF'
import json, urllib.request, os

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))

resp = urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/list")
pages = json.loads(resp.read())

for p in pages:
    url = p.get("url", "")
    title = p.get("title", "")
    if "gemini.google.com" in url:
        if title and title != "about:blank":
            print("READY")
            print(f"   Title: {title}")
            print(f"   URL: {url}")
            exit(0)
        else:
            print("LOADING")
            exit(0)

print("MISSING")
PYEOF
)

echo "   $STATUS"

# ---- 3. 如果缺失则用 Playwright 导航 ----
if echo "$STATUS" | grep -q "MISSING\|LOADING"; then
    echo "[3/3] Creating/navigating Gemini tab..."

    export CDP_PORT GEMINI_URL
    python3 << 'PYEOF'
from playwright.sync_api import sync_playwright
import os, sys, json as j, urllib.request, websocket

CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
GEMINI_URL = os.environ.get("GEMINI_URL", "https://gemini.google.com/u/0/app")

try:
    with sync_playwright() as p:
        browser = p.chromium.connect_over_cdp(f"http://127.0.0.1:{CDP_PORT}")

        for ctx in browser.contexts:
            for page in ctx.pages:
                if 'gemini.google.com' in page.url:
                    print(f"✅ Found existing tab: {page.url}")
                    page.reload()
                    page.wait_for_load_state("domcontentloaded", timeout=15000)
                    print(f"   Title: {page.title()}")
                    browser.close()
                    sys.exit(0)

        page = browser.contexts[0].new_page() if browser.contexts else browser.new_page()
        resp = page.goto(GEMINI_URL, timeout=30000, wait_until="domcontentloaded")
        print(f"✅ Gemini: status={resp.status} url={page.url}")
        browser.close()

except Exception as e:
    print(f"⚠️  Playwright: {e}")
    print("Falling back to raw CDP...")
    resp = urllib.request.urlopen(f"http://127.0.0.1:{CDP_PORT}/json/version")
    browser_ws = j.loads(resp.read())["webSocketDebuggerUrl"]
    ws = websocket.create_connection(browser_ws, timeout=10)
    ws.send(j.dumps({"id": 1, "method": "Target.createTarget", "params": {"url": GEMINI_URL}}))
    ws.settimeout(10)
    for _ in range(10):
        d = j.loads(ws.recv())
        if d.get("id") == 1:
            if "error" in d:
                print(f"❌ CDP error: {d['error']}")
            else:
                print(f"✅ Tab created: {d['result']['targetId']}")
            break
    ws.close()
PYEOF
else
    echo "[3/3] Gemini tab already loaded."
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Gemini is ready"
echo "   CDP: http://127.0.0.1:$CDP_PORT"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
