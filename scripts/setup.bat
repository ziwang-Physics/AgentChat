@echo off
REM ============================================================
REM AgentChat — Windows 一键环境安装脚本
REM
REM 检查并安装所有依赖：Python, Node.js, Playwright, Chrome
REM 用法: 双击运行或在命令行执行 scripts\setup.bat
REM ============================================================

setlocal enabledelayedexpansion
title AgentChat Setup

echo ========================================
echo   AgentChat — Environment Setup
echo ========================================
echo.

REM ── 检查 Python ──────────────────────────────────────────────────────
echo [1/4] Checking Python...
where python >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   MISSING: Python 3.8+ required
    echo   Install from: https://www.python.org/downloads/
    echo   Or run: winget install Python.Python.3.12
    goto :check_node
)
python --version 2>&1
echo   OK

REM ── 安装 Python 依赖 ─────────────────────────────────────────────────
echo   Installing Python dependencies...
pip install playwright websocket-client -q 2>&1
python -m playwright install chromium 2>&1
echo   OK

:check_node
REM ── 检查 Node.js ──────────────────────────────────────────────────────
echo [2/4] Checking Node.js...
where node >nul 2>&1
if %ERRORLEVEL% NEQ 0 (
    echo   MISSING: Node.js 18+ required
    echo   Install from: https://nodejs.org/
    echo   Or run: winget install OpenJS.NodeJS.LTS
    echo   Alternatively, download portable zip and add to PATH
    goto :check_chrome
)
node --version 2>&1
echo   OK

REM ── 安装 npm 依赖 ────────────────────────────────────────────────────
echo   Installing npm dependencies...
cd /d "%~dp0..\skills\gemini-web-extended-thinking"
call npm install --registry=https://registry.npmmirror.com 2>&1
cd /d "%~dp0"
echo   OK

:check_chrome
REM ── 检查 Chrome ───────────────────────────────────────────────────────
echo [3/4] Checking Chrome...
set CHROME_FOUND=0
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if exist "%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe" set CHROME_FOUND=1
if %CHROME_FOUND% EQU 1 (
    echo   OK
) else (
    echo   MISSING: Google Chrome required
    echo   Install from: https://www.google.com/chrome/
)

REM ── 检查配置文件 ─────────────────────────────────────────────────────
echo [4/4] Checking config...
if not exist "%~dp0..\.env" (
    echo   Creating .env from .env.example...
    copy "%~dp0..\.env.example" "%~dp0..\.env" >nul
    echo   Please edit .env if you need a proxy or custom paths
) else (
    echo   .env already exists
)

echo.
echo ========================================
echo   Setup Complete!
echo ========================================
echo.
echo   Next steps:
echo     1. Edit .env if you need proxy settings
echo     2. Run: powershell .\scripts\start-chrome.ps1 -FirstLogin
echo     3. Log in to Gemini in the Chrome window
echo     4. Test: node skills\gemini-web-extended-thinking\index.js --smoke
echo.
pause
