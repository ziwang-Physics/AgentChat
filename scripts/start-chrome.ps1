# ============================================================
# AgentChat — Chrome CDP 启动器 (Windows PowerShell)
#
# Idempotent — 安全多次运行。首次使用 -FirstLogin 登录 Gemini。
#
# 用法:
#   .\scripts\start-chrome.ps1                 # headless 模式（日常）
#   .\scripts\start-chrome.ps1 -FirstLogin      # 可视化窗口登录 Gemini
#   .\scripts\start-chrome.ps1 -Stop            # 停止所有 Chrome 进程
#
# 环境变量 (.env 文件会自动加载):
#   CDP_PORT        CDP 调试端口 (默认: 9222)
#   CHROMIUM_PATH   自定义 Chrome 路径 (默认: 自动检测)
#   CHROME_PROFILE  Profile 目录 (默认: %USERPROFILE%\.chrome-debug-profile)
#   PROXY_SERVER    HTTP/SOCKS5 代理 (如 http://127.0.0.1:7897)
#   GEMINI_URL      Gemini 目标 URL
# ============================================================

param(
    [switch]$FirstLogin,
    [switch]$Stop
)

$ErrorActionPreference = "Stop"

# ── 加载 .env 文件 ────────────────────────────────────────────────────────
$ProjectDir = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
$EnvFile = Join-Path $ProjectDir ".env"
if (Test-Path $EnvFile) {
    Get-Content $EnvFile | ForEach-Object {
        $line = $_.Trim()
        if ($line -and $line -notmatch '^\s*#' -and $line -match '(.+?)=(.+)') {
            $key = $Matches[1].Trim()
            $val = $Matches[2].Trim()
            # 展开 %VAR% 环境变量
            $val = [Environment]::ExpandEnvironmentVariables($val)
            [Environment]::SetEnvironmentVariable($key, $val, "Process")
        }
    }
}

# ── 配置（env vars 覆盖默认值）──────────────────────────────────────────
$CDP_PORT      = if ($env:CDP_PORT) { [int]$env:CDP_PORT } else { 9222 }
$PROFILE_DIR   = if ($env:CHROME_PROFILE) { $env:CHROME_PROFILE } else { "$env:USERPROFILE\.chrome-debug-profile" }
$GEMINI_URL    = if ($env:GEMINI_URL) { $env:GEMINI_URL } else { "https://gemini.google.com/u/0/app" }
$PROXY_SERVER  = if ($env:PROXY_SERVER) { $env:PROXY_SERVER } else { "" }

# ── -Stop 模式 ──────────────────────────────────────────────────────────
if ($Stop) {
    Write-Host "[INFO] Stopping all Chrome processes..."
    $count = (Get-Process -Name "chrome" -ErrorAction SilentlyContinue).Count
    Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force
    Start-Sleep -Seconds 2
    Write-Host "[OK] Stopped $count chrome process(es)"
    exit 0
}

# ── 自动检测 Chrome 路径 ─────────────────────────────────────────────────
function Find-Chrome {
    if ($env:CHROMIUM_PATH -and (Test-Path $env:CHROMIUM_PATH)) {
        return $env:CHROMIUM_PATH
    }
    $candidates = @(
        "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
        "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
        "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe",
        "$env:ProgramFiles\Chromium\Application\chrome.exe"
    )
    foreach ($c in $candidates) {
        if (Test-Path $c) { return $c }
    }
    return $null
}

$CHROME_PATH = Find-Chrome
if (-not $CHROME_PATH) {
    Write-Host "[ERROR] Chrome not found." -ForegroundColor Red
    Write-Host "  Install Chrome from https://www.google.com/chrome/"
    Write-Host "  Or set CHROMIUM_PATH in .env to your chrome.exe location"
    exit 1
}
Write-Host "[INFO] Chrome: $CHROME_PATH"

# ── 如果已在运行则跳过 ──────────────────────────────────────────────────
try {
    $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 2 -UseBasicParsing
    Write-Host "[OK] Chrome CDP already running on port $CDP_PORT"
    exit 0
} catch {}

# ── 清理残留 ─────────────────────────────────────────────────────────────
Write-Host "[INFO] Cleaning up stale Chrome processes..."
Get-Process -Name "chrome" -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 3

# ── 准备 Profile 目录 ───────────────────────────────────────────────────
if (-not (Test-Path $PROFILE_DIR)) {
    New-Item -ItemType Directory -Path $PROFILE_DIR -Force | Out-Null
    Write-Host "[INFO] Created profile: $PROFILE_DIR"
}

# 清理锁文件
@("SingletonLock", "SingletonSocket", "SingletonCookie", "Lockfile") | ForEach-Object {
    $lp = Join-Path $PROFILE_DIR $_
    if (Test-Path $lp) { Remove-Item $lp -Force -ErrorAction SilentlyContinue }
}

# ── Chrome 启动参数（最小必要 Flag 集）──────────────────────────────────
$ChromeArgs = @(
    "--remote-debugging-port=$CDP_PORT",
    "--remote-debugging-address=127.0.0.1",
    "--remote-allow-origins=*",
    "--user-data-dir=`"$PROFILE_DIR`"",
    # 切断 Google 云端依赖链（中国网络环境必须）
    "--disable-features=OptimizationHints,Translate,HttpsUpgrades",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-field-trial-config",
    "--disable-component-update",
    "--disable-sync",
    # 减少非必要后台活动
    "--disable-extensions",
    "--disable-default-apps",
    "--disable-breakpad",
    "--disable-hang-monitor",
    "--disable-popup-blocking",
    "--disable-renderer-backgrounding",
    "--no-first-run",
    "--no-default-browser-check",
    "--noerrdialogs",
    "--hide-scrollbars",
    "--mute-audio",
    "--ignore-certificate-errors",
    "--disable-dev-shm-usage"
)

if ($PROXY_SERVER) {
    $ChromeArgs += "--proxy-server=$PROXY_SERVER"
    Write-Host "[INFO] Proxy: $PROXY_SERVER"
}

# ── 启动 Chrome ──────────────────────────────────────────────────────────
if ($FirstLogin) {
    Write-Host ""
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host "  First Login Mode — visible Chrome window" -ForegroundColor Cyan
    Write-Host "============================================================" -ForegroundColor Cyan
    Write-Host ""
    Write-Host "  In the Chrome window that opens:" -ForegroundColor Yellow
    Write-Host "    1. Google will prompt you to sign in"
    Write-Host "    2. Log in with your Google account"
    Write-Host "    3. Confirm you can see the Gemini chat interface"
    Write-Host "    4. Close the Chrome window when done" -ForegroundColor Yellow
    Write-Host ""

    Start-Process -FilePath $CHROME_PATH -ArgumentList "$ChromeArgs $GEMINI_URL"

    Write-Host -NoNewline "[WAIT] Waiting for CDP port..."
    for ($i = 1; $i -le 60; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 2 -UseBasicParsing
            Write-Host " READY"
            break
        } catch { Write-Host -NoNewline "." }
    }
} else {
    # Headless 模式
    $HeadlessArgs = $ChromeArgs + @("--headless=new", "--disable-gpu", "--window-size=1920,1080")
    $null = Start-Process -FilePath $CHROME_PATH -ArgumentList "$HeadlessArgs $GEMINI_URL" -PassThru

    Write-Host -NoNewline "[WAIT] Waiting for CDP port..."
    for ($i = 1; $i -le 30; $i++) {
        Start-Sleep -Seconds 1
        try {
            $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec 2 -UseBasicParsing
            Write-Host " READY"
            break
        } catch { Write-Host -NoNewline "." }
    }

    Write-Host -NoNewline "[WAIT] Waiting for Gemini page..."
    for ($i = 1; $i -le 20; $i++) {
        Start-Sleep -Seconds 1
        try {
            $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/list" -TimeoutSec 2 -UseBasicParsing
            $pages = $resp.Content | ConvertFrom-Json
            foreach ($p in $pages) {
                if ($p.url -match "gemini" -and $p.title -ne "about:blank" -and $p.title) {
                    Write-Host " DONE"
                    Write-Host "[OK] Gemini page: $($p.title)"
                    Write-Host ""
                    Write-Host "================================================"
                    Write-Host "  Chrome CDP: http://127.0.0.1:$CDP_PORT"
                    Write-Host "  Ready for AgentChat!"
                    Write-Host "================================================"
                    exit 0
                }
            }
            Write-Host -NoNewline "."
        } catch { Write-Host -NoNewline "." }
    }
    Write-Host " (page may still be loading)"
}

Write-Host ""
Write-Host "Chrome CDP running at http://127.0.0.1:$CDP_PORT"
