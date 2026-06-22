#!/bin/bash
# ============================================================
# connect-gemini.sh — 一键连接 Gemini（可靠版）
#
# 用法: bash ~/connect-gemini.sh
#
# 解决之前遇到的三个 CDP 坑：
#   1. GET→PUT：用 WebSocket 直接发 CDP 命令，不走 HTTP CRUD
#   2. URL 不编码：用 JSON params 传 URL，由 CDP 协议处理
#   3. 创建不导航：用 Target.createTarget 一步创建+导航
# ============================================================

set -euo pipefail

DEBUG_PORT=9222
GEMINI_URL="https://gemini.google.com/u/0/app"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"

# ---- 1. 确保 Chrome debug 运行 ----
echo "[1/3] Ensuring Chrome debug is running..."
bash "$SCRIPT_DIR/start-chrome-debug.sh"

# ---- 2. 用 CDP Target.createTarget 一步创建并导航 ----
echo "[2/3] Creating tab & navigating to Gemini via CDP WebSocket..."
python3 << 'PYEOF'
import websocket
import json
import sys

DEBUG_PORT = 9222
GEMINI_URL = "https://gemini.google.com/u/0/app"

# Step A: Get the browser-level WebSocket URL from /json/version
import urllib.request
resp = urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/version")
version_info = json.loads(resp.read())
browser_ws = version_info.get("webSocketDebuggerUrl")
if not browser_ws:
    print("❌ Cannot get browser WebSocket URL", file=sys.stderr)
    sys.exit(1)

# Step B: Connect to browser-level WS and send Target.createTarget
# This creates a NEW tab AND navigates to the URL in one CDP command
ws = websocket.create_connection(browser_ws)

# Target.createTarget — no URL encoding issues because URL is a JSON string value
create_cmd = json.dumps({
    "id": 1,
    "method": "Target.createTarget",
    "params": {"url": GEMINI_URL}
})
ws.send(create_cmd)

# Wait for response
ws.settimeout(5)
result = None
for _ in range(10):
    msg = ws.recv()
    data = json.loads(msg)
    if data.get("id") == 1:
        if "error" in data:
            print(f"❌ CDP error: {data['error']}", file=sys.stderr)
            ws.close()
            sys.exit(1)
        result = data["result"]
        break

ws.close()

if not result:
    print("❌ No response from CDP", file=sys.stderr)
    sys.exit(1)

target_id = result.get("targetId", "unknown")
print(f"✅ Tab created: {target_id}")
PYEOF

# ---- 3. 确认页面加载 ----
echo "[3/3] Verifying page loaded..."
python3 << 'PYEOF'
import json
import sys
import time
import urllib.request

DEBUG_PORT = 9222
GEMINI_URL = "https://gemini.google.com/u/0/app"

# Wait for page to load (Target.createTarget is async — page needs time)
time.sleep(2)

# Simply check /json/list — if URL matches, we're good
resp = urllib.request.urlopen(f"http://127.0.0.1:{DEBUG_PORT}/json/list")
pages = json.loads(resp.read())

found = False
for p in pages:
    url = p.get("url", "")
    title = p.get("title", "")
    if "gemini.google.com" in url:
        print(f"✅ Gemini tab confirmed: {title or '(loading)'} — {url}")
        found = True
        break

if not found:
    # Show all non-blank tabs for debugging
    print("⚠️  Gemini URL not yet resolved — showing all tabs:")
    for p in pages:
        if "about:blank" not in p.get("url", ""):
            print(f"   {p.get('title', '?')[:60]} | {p.get('url', '?')[:100]}")
PYEOF

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "✅ Done — Gemini should be open in Chrome"
echo "   URL: $GEMINI_URL"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
