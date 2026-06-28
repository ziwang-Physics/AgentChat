# ============================================================
# AgentChat — Gemini Tab 验证/创建 (Windows PowerShell)
#
# 确保 Chrome CDP 运行且 Gemini 页面已加载。
# 用法: .\scripts\connect-gemini.ps1
# ============================================================

$CDP_PORT   = if ($env:CDP_PORT) { $env:CDP_PORT } else { "9222" }
$GEMINI_URL = if ($env:GEMINI_URL) { $env:GEMINI_URL } else { "https://gemini.google.com/u/0/app" }

Write-Host "[1/3] Checking Chrome CDP..."
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 3 -UseBasicParsing
    Write-Host "       OK — CDP reachable"
} catch {
    Write-Host "       Not running, starting..."
    & "$PSScriptRoot\start-chrome.ps1"
    Start-Sleep -Seconds 5
}

Write-Host "[2/3] Checking Gemini tab..."
$ready = $false
try {
    $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/list" -TimeoutSec 3 -UseBasicParsing
    $pages = $resp.Content | ConvertFrom-Json
    foreach ($p in $pages) {
        if ($p.url -match "gemini.google.com") {
            if ($p.title -and $p.title -ne "about:blank") {
                Write-Host "       OK — $($p.title)"
                $ready = $true
                break
            } else {
                Write-Host "       WARNING — about:blank (login required?)"
            }
        }
    }
    if (-not $ready) {
        $pageCount = ($pages | Where-Object { $_.type -eq "page" }).Count
        Write-Host "       No active Gemini tab ($pageCount pages total)"
    }
} catch {
    Write-Host "       ERROR: $_"
}

if (-not $ready) {
    Write-Host "[3/3] Creating Gemini tab via Playwright..."
    $pyScript = @"
from playwright.sync_api import sync_playwright
import sys

with sync_playwright() as p:
    b = p.chromium.connect_over_cdp('http://127.0.0.1:$CDP_PORT')
    for ctx in b.contexts:
        for pg in ctx.pages:
            if 'gemini.google.com' in pg.url:
                print(f'Found tab: {pg.url}')
                pg.reload()
                pg.wait_for_load_state('domcontentloaded', timeout=15000)
                print(f'Title: {pg.title()}')
                b.close()
                sys.exit(0)

    pg = b.contexts[0].new_page() if b.contexts else b.new_page()
    resp = pg.goto('$GEMINI_URL', timeout=30000, wait_until='domcontentloaded')
    print(f'Created: status={resp.status} title={pg.title()}')
    b.close()
"@
    $result = python -c $pyScript 2>&1
    Write-Host "       $result"
} else {
    Write-Host "[3/3] Gemini tab already loaded — skip"
}

Write-Host ""
Write-Host "CDP: http://127.0.0.1:$CDP_PORT  |  Gemini: ready"
