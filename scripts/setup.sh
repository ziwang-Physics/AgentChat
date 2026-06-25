#!/bin/bash
# ============================================================
# AgentChat — 环境检查与初始化脚本
#
# 用法: bash setup.sh
#
# 检查所有依赖，帮助新用户快速搭建 Chrome CDP 环境。
# ============================================================

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

pass_count=0
fail_count=0
warn_count=0

check() {
    local desc="$1"
    local cmd="$2"
    local fix="${3:-}"
    printf "  %-50s " "$desc"
    if eval "$cmd" > /dev/null 2>&1; then
        echo -e "${GREEN}✅${NC}"
        ((pass_count++))
    else
        if [ -n "$fix" ]; then
            echo -e "${YELLOW}⚠️  修复: $fix${NC}"
            ((warn_count++))
        else
            echo -e "${RED}❌${NC}"
            ((fail_count++))
        fi
    fi
}

echo "========================================"
echo "  AgentChat 环境检查"
echo "========================================"
echo ""

# --- 基础依赖 ---
echo "📦 基础依赖:"
check "python3 >= 3.8" \
    "python3 -c 'import sys; assert sys.version_info >= (3,8)'"

check "pip3" \
    "which pip3" \
    "apt install python3-pip"

check "playwright (Python)" \
    "python3 -c 'from playwright.sync_api import sync_playwright'" \
    "pip3 install playwright"

check "Playwright Chromium" \
    "python3 -c 'from playwright.sync_api import sync_playwright; p=__import__(\"playwright\").sync_api.sync_playwright().start(); print(p.chromium.executable_path); p.stop()' 2>/dev/null | grep -q chromium" \
    "python3 -m playwright install chromium"

check "websocket-client" \
    "python3 -c 'import websocket'" \
    "pip3 install websocket-client"

check "playwright-core (npm)" \
    "[ -d /tmp/node_modules/playwright-core ] || [ -d node_modules/playwright-core ]" \
    "cd /tmp && npm install playwright-core"

echo ""

# --- 代理 ---
echo "🌐 代理:"
PROXY="${PROXY_SERVER:-http://127.0.0.1:7897}"
PROXY_HOST=$(echo "$PROXY" | sed 's|http[s]*://||' | cut -d: -f1)
PROXY_PORT=$(echo "$PROXY" | sed 's|.*:||')

check "代理端口 ${PROXY_HOST}:${PROXY_PORT} 可达" \
    "curl -s --connect-timeout 3 --proxy '$PROXY' https://www.google.com -o /dev/null -w '%{http_code}' | grep -q 200" \
    "启动代理软件 (Clash Verge / v2ray / etc) 并确认端口正确"

echo ""

# --- Chrome CDP ---
echo "🔧 Chrome CDP:"
CDP_PORT="${CDP_PORT:-9222}"

check "Chrome CDP 端口 ${CDP_PORT}" \
    "curl -s http://127.0.0.1:${CDP_PORT}/json/version > /dev/null" \
    "bash scripts/start-chrome-debug.sh"

check "Gemini 可达 (通过代理)" \
    "curl -s --connect-timeout 5 --proxy '$PROXY' https://gemini.google.com -o /dev/null -w '%{http_code}' | grep -q 200"

echo ""

# --- 磁盘空间 ---
echo "💾 磁盘:"
check "可用空间 > 2GB" \
    "test \$(df /tmp --output=avail | tail -1) -gt 2000000"

echo ""
echo "========================================"
printf "  结果: ${GREEN}%d 通过${NC}, ${YELLOW}%d 需修复${NC}, ${RED}%d 失败${NC}\n" $pass_count $warn_count $fail_count
echo "========================================"

if [ $fail_count -gt 0 ]; then
    echo ""
    echo "请修复上述 ❌ 项目后重新运行 bash setup.sh"
    exit 1
fi

echo ""
echo "✅ 环境就绪! 运行以下命令连接 Gemini:"
echo "   bash scripts/start-chrome-debug.sh"
echo "   bash scripts/connect-gemini.sh"
