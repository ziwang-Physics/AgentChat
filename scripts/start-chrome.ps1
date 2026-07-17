# ============================================================
# AgentChat — Chrome CDP 启动器 (Windows PowerShell)
#
# Idempotent — 安全多次运行。首次使用 -FirstLogin 登录 Gemini。
#
# 用法:
#   .\scripts\start-chrome.ps1                  # 启动 (默认: 可见窗口)
#   .\scripts\start-chrome.ps1 -FirstLogin      # 打开 Gemini 登录页并等待登录
#   .\scripts\start-chrome.ps1 -Headless        # headless 模式 (profile 必须已登录)
#   .\scripts\start-chrome.ps1 -Stop            # 停止本脚本管理的 Chrome
#
# 环境变量 (.env 文件会自动加载):
#   CDP_PORT        CDP 调试端口 (默认: 9222)
#   CHROMIUM_PATH   自定义 Chrome 路径 (默认: 自动检测)
#   CHROME_PROFILE  Profile 目录 (默认: %USERPROFILE%\.chrome-debug-profile)
#   PROXY_SERVER    HTTP/SOCKS5 代理 (如 http://127.0.0.1:7897)
#   GEMINI_URL      Gemini 目标 URL
#   HEADLESS        1/true/yes = headless (等价于 -Headless)
#
# v15 变更 (Windows/workbuddy 修复):
#   [P0] 端口等待循环耗尽后不再假装成功 — 现在 exit 1 并输出诊断
#        (旧版失败时照样打印 "Chrome CDP running"，上游 agent 以为就绪，
#        随后 skill ECONNREFUSED — 正是 workbuddy 上反复出现的现象)
#   [P0] CHROME_PROFILE=~/... 的 `~` 现在展开为 $HOME —
#        旧版 PowerShell 自己的 Test-Path 会解析 ~，但传给 Chrome 的
#        --user-data-dir Chrome 不展开 → Chrome 在 CWD 建字面 `~` 目录，
#        登录态写进错误 profile，每次都要求重新登录
#   [P1] Start-Process 参数改为显式引号拼接 —
#        旧写法用 $OFS 隐式 join 数组再内插，含空格路径下参数被拆散
#   [P1] 默认模式 headless → headful，与 .env.example 的 HEADLESS=false
#        默认值及 Linux daemon 行为一致；headless 下 Gemini 未登录 profile
#        无法交互登录，且更易触发风控
#   [P1] 启动后检测 Chrome 进程是否立即退出 (flag 错误/profile 被占用)，
#        失败时输出 netstat 端口占用诊断
# ============================================================

param(
    [switch]$FirstLogin,
    [switch]$Headless,
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

# v15 [P0]: 展开 `~` — .env.example 的默认值是 ~/.chrome-debug-profile，
# Windows 用户照抄后 Chrome 收到字面 `~`。PowerShell cmdlet 解析 ~ 但
# Chrome 不解析，两边看到的 profile 不是同一个目录。
if ($PROFILE_DIR -match '^~[\\/]') {
    $PROFILE_DIR = Join-Path $env:USERPROFILE $PROFILE_DIR.Substring(2)
} elseif ($PROFILE_DIR -eq '~') {
    $PROFILE_DIR = $env:USERPROFILE
}
# 归一化为绝对路径（相对路径会随调用方 CWD 漂移 — workbuddy 的 CWD 不可控）
$PROFILE_DIR = [System.IO.Path]::GetFullPath($PROFILE_DIR)

# HEADLESS env 等价于 -Headless（与 Linux daemon 的 .env 语义一致）
if ($env:HEADLESS -match '^(1|true|yes)$') { $Headless = $true }

$CHROME_PID_FILE = Join-Path $env:TEMP "chrome-debug.chrome.pid"

function Test-CdpPort {
    param([int]$TimeoutSec = 2)
    try {
        $null = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/version" -TimeoutSec $TimeoutSec -UseBasicParsing
        return $true
    } catch { return $false }
}

# Stop ONLY the managed Chrome recorded in the PID file. Returns $true if a
# process was stopped. POLICY: never touch the user's own Chrome windows.
function Stop-ManagedChrome {
    if (-not (Test-Path $CHROME_PID_FILE)) { return $false }
    $managedPid = Get-Content $CHROME_PID_FILE -ErrorAction SilentlyContinue | Select-Object -First 1
    $stopped = $false
    if ($managedPid) {
        $proc = Get-Process -Id $managedPid -ErrorAction SilentlyContinue
        if ($proc -and $proc.ProcessName -match "chrome") {
            Write-Host "[INFO] Stopping managed Chrome (PID $managedPid)..."
            Stop-Process -Id $managedPid -Force -ErrorAction SilentlyContinue
            $stopped = $true
        }
    }
    Remove-Item $CHROME_PID_FILE -Force -ErrorAction SilentlyContinue
    return $stopped
}

# ── -Stop 模式 ──────────────────────────────────────────────────────────
if ($Stop) {
    if (Stop-ManagedChrome) {
        Start-Sleep -Seconds 2
        Write-Host "[OK] Managed Chrome stopped"
    } else {
        Write-Host "[INFO] No managed Chrome running — nothing to stop"
    }
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
        "$env:ProgramFiles\Chromium\Application\chrome.exe",
        "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe"
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
Write-Host "[INFO] Chrome:  $CHROME_PATH"
Write-Host "[INFO] Profile: $PROFILE_DIR"
Write-Host "[INFO] Port:    $CDP_PORT"

# ── 如果已在运行则跳过 ──────────────────────────────────────────────────
if (Test-CdpPort) {
    Write-Host "[OK] Chrome CDP already running on port $CDP_PORT"
    exit 0
}

# ── 清理残留（只清理我们自己启动的 Chrome — PID 精确定位）────────────────
if (Stop-ManagedChrome) {
    Start-Sleep -Seconds 3
}

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
# v15 [P1]: 参数以数组维护、末尾统一显式引号拼接为单一命令行字符串。
# 旧版 -ArgumentList 依赖 $OFS 隐式 join 数组内插，
# 含空格值在 PS 5.1 / 7 下解析行为不一致。
$ChromeArgs = @(
    "--remote-debugging-port=$CDP_PORT",
    "--remote-debugging-address=127.0.0.1",
    # SECURITY: no --remote-allow-origins=* (parity with Linux daemon fix)
    "--user-data-dir=$PROFILE_DIR",
    # 切断 Google 云端依赖链（中国网络环境必须）
    "--disable-features=OptimizationHints,Translate,HttpsUpgrades",
    "--disable-background-networking",
    "--disable-client-side-phishing-detection",
    "--disable-field-trial-config",
    "--disable-component-update",
    "--disable-sync",
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
    # SECURITY: no --ignore-certificate-errors (parity with Linux daemon fix)
    "--disable-dev-shm-usage"
)

if ($PROXY_SERVER) {
    $ChromeArgs += "--proxy-server=$PROXY_SERVER"
    Write-Host "[INFO] Proxy: $PROXY_SERVER"
}

if ($Headless -and -not $FirstLogin) {
    $ChromeArgs += @("--headless=new", "--disable-gpu", "--window-size=1920,1080")
    Write-Host "[INFO] Mode: headless"
} else {
    Write-Host "[INFO] Mode: headful (visible window)"
}

# 显式引号拼接：值含空格的参数整体加引号
function Quote-Arg([string]$a) {
    if ($a -match '\s') {
        if ($a -match '^(--[A-Za-z0-9-]+)=(.*)$') { return "$($Matches[1])=`"$($Matches[2])`"" }
        return "`"$a`""
    }
    return $a
}
$ArgString = (($ChromeArgs | ForEach-Object { Quote-Arg $_ }) + (Quote-Arg $GEMINI_URL)) -join ' '

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
    Write-Host "    4. LEAVE the window open — AgentChat drives this browser" -ForegroundColor Yellow
    Write-Host ""
}

$chromeProc = Start-Process -FilePath $CHROME_PATH -ArgumentList $ArgString -PassThru
Set-Content -Path $CHROME_PID_FILE -Value $chromeProc.Id

# v15 [P1]: 立即退出检测 — flag 错误 / profile 被另一实例占用时 Chrome 秒退，
# 旧版会傻等 30s 然后（更糟地）假装成功。
Start-Sleep -Milliseconds 1500
$alive = Get-Process -Id $chromeProc.Id -ErrorAction SilentlyContinue
if (-not $alive) {
    # Chrome 单例机制：若同 profile 已有实例，新进程把 URL 转交后退出 —
    # 此时端口可能仍会由旧实例提供。先探测一次再判死刑。
    if (-not (Test-CdpPort -TimeoutSec 3)) {
        Write-Host "[ERROR] Chrome exited immediately after launch." -ForegroundColor Red
        Write-Host "  Common causes:"
        Write-Host "   - profile dir locked by another Chrome using the same --user-data-dir"
        Write-Host "   - antivirus blocking chrome.exe with debug flags"
        Write-Host "  Diagnose port ${CDP_PORT}:"
        netstat -ano | Select-String ":$CDP_PORT " | ForEach-Object { Write-Host "   $_" }
        exit 1
    }
}

# ── 等待 CDP 端口就绪 ────────────────────────────────────────────────────
$WaitSec = if ($FirstLogin) { 60 } else { 30 }
Write-Host -NoNewline "[WAIT] Waiting for CDP port"
$ready = $false
for ($i = 1; $i -le $WaitSec; $i++) {
    Start-Sleep -Seconds 1
    if (Test-CdpPort) { $ready = $true; break }
    Write-Host -NoNewline "."
}

if (-not $ready) {
    # v15 [P0]: 旧版在这里不设防地滑向成功输出。失败必须响亮。
    Write-Host " TIMEOUT" -ForegroundColor Red
    Write-Host "[ERROR] CDP port $CDP_PORT did not open within ${WaitSec}s." -ForegroundColor Red
    Write-Host "  Diagnose:"
    Write-Host "   1. Is another process holding the port?"
    netstat -ano | Select-String ":$CDP_PORT " | ForEach-Object { Write-Host "      $_" }
    Write-Host "   2. Is chrome.exe alive?  (managed PID: $($chromeProc.Id))"
    Get-Process -Id $chromeProc.Id -ErrorAction SilentlyContinue | ForEach-Object { Write-Host "      alive: $($_.ProcessName) $($_.Id)" }
    Write-Host "   3. Check %TEMP%\chrome-debug.chrome.pid and retry with -Stop first"
    exit 1
}
Write-Host " READY"

# ── Gemini 页面确认（尽力而为，不阻塞成功退出）───────────────────────────
Write-Host -NoNewline "[WAIT] Waiting for Gemini page"
$loginNeeded = $false
for ($i = 1; $i -le 20; $i++) {
    Start-Sleep -Seconds 1
    try {
        $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$CDP_PORT/json/list" -TimeoutSec 2 -UseBasicParsing
        $pages = $resp.Content | ConvertFrom-Json
        $hit = $pages | Where-Object { $_.url -match "gemini" -and $_.title -and $_.title -ne "about:blank" }
        if ($hit) {
            Write-Host " DONE"
            $t = ($hit | Select-Object -First 1).title
            $u = ($hit | Select-Object -First 1).url
            Write-Host "[OK] Gemini page: $t"
            if ($u -match "accounts\.google\.com|signin|ServiceLogin") { $loginNeeded = $true }
            break
        }
        Write-Host -NoNewline "."
    } catch { Write-Host -NoNewline "." }
}

Write-Host ""
Write-Host "================================================"
Write-Host "  Chrome CDP: http://127.0.0.1:$CDP_PORT"
if ($loginNeeded) {
    Write-Host "  ⚠ Gemini is showing a LOGIN page — sign in before using AgentChat" -ForegroundColor Yellow
    Write-Host "    (re-run with -FirstLogin for guided login)"
} else {
    Write-Host "  Ready for AgentChat!"
}
Write-Host "================================================"
exit 0
