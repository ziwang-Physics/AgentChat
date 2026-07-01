# Gemini Web Extended Thinking

> **最后更新**: 2026-06-25 — 完整诊断 Chrome 导航失败的根因并修复

## Trigger

Use this skill when the user asks to:
- Discuss a complex topic with Gemini Web (research, code review, architecture)
- Run a prompt through Gemini Pro Extended Thinking mode
- Send content to `gemini.google.com` for deep reasoning

**When to use THIS skill vs AgentChat-WebExtended:**
- **THIS skill**: Single prompt → Gemini only, Pro Extended Thinking guaranteed. Use when you need MAX reasoning depth from Gemini specifically.
- **AgentChat-WebExtended**: Multi-provider fallback chain. Use when provider reliability matters more than specific model choice, or when Gemini quota may be exhausted.

Do NOT use for: simple Q&A, quick lookups, or when the user hasn't explicitly asked for Gemini Web.

---

## Chrome 启动架构 (v3 — 2026-06-25 修复)

### 为什么之前的方案会失败 (3 层级联故障)

经过 8 小时深度诊断，确认 Chrome 无法导航到任何网页（含 Gemini）的根因：

```
Layer 1: SSL 握手失败
  Chrome 启动 → 向 Google 云端发起 10+ HTTPS 初始化请求
    ├─ 无代理：GFW DPI → RST 注入 → net_error -100 (ERR_CONNECTION_CLOSED)
    └─ 有代理(mihomo VLESS Reality)：TLS spoofing(servername=python.org)
       与 Chrome BoringSSL 冲突 → 同样 SSL 失败

Layer 2: 安全组件初始化失败
  Safe Browsing / Component Updater / Data Protection DLP / Optimization Guide
  全部依赖 Google 云端后端 → 因 Layer 1 全部无法初始化

Layer 3: 防失效(fail-safe)阻断所有导航
  DataProtectionNavigationObserver: "URL to scan: https://xxx"
    → 云端不可达 → 阻断所有出站导航
    → HTTP:  ERR_BLOCKED_BY_CLIENT
    → HTTPS: 静默挂死 (无超时, 无错误码)
```

### 为什么 Playwright 能工作而原始 raw CDP 不能

Playwright 在启动 Chromium 时注入了关键 Feature Flag，切断了 Chrome 对 Google 云端的依赖链：

| 关键 Flag | 效果 |
|-----------|------|
| `--disable-features=OptimizationHints` | 禁用 Optimization Guide，阻止 AI 模型下载 |
| `--disable-features=HttpsUpgrades` | 禁用 HTTPS 自动升级，防止死锁 |
| `--disable-features=Translate` | 禁用翻译服务，减少 Google 后端依赖 |
| `--disable-background-networking` | 阻断所有后台网络请求 |
| `--disable-field-trial-config` | 禁用 Finch 实验，不连接 Google 配置服务 |
| `--disable-client-side-phishing-detection` | 禁用客户端钓鱼检测 |
| `--ozone-platform=headless` | 使用 headless 渲染平台 |

**核心逻辑**: 这些 flag 在 Chrome 启动时就切断了 Google 云端的依赖。
Layer 1 的请求根本不会发出 → Layer 2 不会失败 → Layer 3 的 fail-safe 不触发。

### 浏览器选择

| 浏览器 | 可用性 | 说明 |
|--------|--------|------|
| ~~Chrome for Testing (CfT) v150~~ | ❌ 不推荐 | 网络栈精简，TLS 处理与标准版巨大差异 |
| ~~标准 Chrome v149 (dpkg 提取)~~ | ⚠️ 可用但不稳定 | 无 GUI 时需 `--headless=new`，raw CDP 导航不可靠 |
| **Playwright Chromium v149** | ✅ 推荐 | 自动检测 (`~/.cache/ms-playwright/chromium-*/chrome-linux64/chrome`) |
| Playwright Python API | ✅ 最稳定 | `launch()` 或 `launch_persistent_context()` 管理生命周期 |

### 脚本架构

```
scripts/start-chrome-debug.sh   ← Shell 入口 (idempotent)
    └─ scripts/start-chrome-debug.py  ← Playwright daemon (Chrome 生命周期管理)
scripts/connect-gemini.sh       ← 验证/创建 Gemini tab (Playwright connect_over_cdp + raw CDP 回退)
```

## Prerequisites (verify before execution)

```bash
# 1. Chrome debug 必须在端口 9222 运行 (Playwright daemon 管理)
pgrep -f "start-chrome-debug" || bash scripts/start-chrome-debug.sh

# 2. 确认 CDP 可用
curl -s http://127.0.0.1:9222/json/version | python3 -c "import json,sys; print(json.load(sys.stdin).get('Browser','FAIL'))"

# 3. 确认 Gemini tab 已加载 (title != about:blank)
curl -s http://127.0.0.1:9222/json/list | python3 -c "
import json,sys
pages=json.load(sys.stdin)
for p in pages:
    if 'gemini' in p.get('url','').lower() and p.get('title','') not in ('','about:blank'):
        print(f'✅ Gemini: {p[\"title\"]}')
        break
else:
    print('❌ Gemini not loaded')
"

# 4. playwright-core (npm) — CDP 连接用 (~3MB, 不需要浏览器二进制)
(cd skills/gemini-web-extended-thinking && npm install)

# 5. playwright (pip) — Chrome daemon 启动用 (~60MB, 管理浏览器生命周期)
python3 -c "from playwright.sync_api import sync_playwright" 2>/dev/null || pip3 install playwright
```

## Pro Extended 模型切换 (每次对话前必须执行)

Gemini 默认使用 Flash 模型。复杂任务必须切换到 **Pro 延長** 模式。
以下代码经 2026-06-25 实战验证，适用于 Gemini 当前 UI (3.1 版本菜单)。

```python
from playwright.sync_api import sync_playwright
import time

def ensure_pro_extended(page):
    """激活 Pro 延長 模式。idempotent — 如已激活则跳过。"""
    
    # 1. 检查当前状态
    label = page.locator('button[aria-label*="開啟模式挑選器"]').first
    current = label.get_attribute('aria-label') or ''
    if '延長' in current:
        return  # 已经激活，跳过
    
    # 2. 打开模型选择器
    label.click()
    time.sleep(1.5)
    
    # 3. 确保选中 Pro (非 Flash/Flash-Lite)
    items = page.evaluate("""() => [...document.querySelectorAll('gem-menu-item')]
        .map((el,i) => ({i, text: el.innerText?.trim()}))""")
    
    for item in items:
        if 'Pro' in item['text'] and '進階' in item['text']:
            page.locator('gem-menu-item').nth(item['i']).click()
            time.sleep(1)
            break
    
    # 4. 展开思考程度子菜单
    time.sleep(0.5)
    items = page.evaluate("""() => [...document.querySelectorAll('gem-menu-item')]
        .map((el,i) => ({i, text: el.innerText?.trim()}))""")
    
    for item in items:
        if '思考程度' in item['text'] or 'Thinking' in item['text']:
            page.locator('gem-menu-item').nth(item['i']).click()
            time.sleep(1.5)
            break
    
    # 5. 选择「延長」
    items = page.evaluate("""() => [...document.querySelectorAll('gem-menu-item')]
        .map((el,i) => ({i, text: el.innerText?.trim()}))""")
    
    for item in items:
        if '延長' in item['text'] and '標準' not in item['text']:
            page.locator('gem-menu-item').nth(item['i']).click()
            time.sleep(1)
            break
    
    # 6. 关闭菜单 + 验证
    page.keyboard.press("Escape")
    time.sleep(1)
    
    label = page.locator('button[aria-label*="開啟模式挑選器"]').first
    current = label.get_attribute('aria-label') or ''
    assert '延長' in current, f"Pro Extended activation FAILED. Current: {current}"
```

### 消息发送注意事项

**Angular 变更检测陷阱**：Gemini 输入框是 Angular rich-textarea。`Input.insertText` 和
`page.fill()` 对大文本（>5K chars）有时不触发 Angular zone.js，导致发送按钮不出现。

**可靠方案**（按优先级）：
1. ≤5K chars: `page.fill()` + `page.keyboard.press("Enter")` — 最可靠
2. >5K chars: 用 clipboard 粘贴法 — `keyboard.type(',')` 触发 Angular → `navigator.clipboard.writeText()` → `Ctrl+v` → `Backspace` 删逗号
3. 发送前验证：检查 `button[aria-label="发送"]` 是否可见且 `disabled=false`

### 会话管理 (多轮交互最佳实践)

**绝对不要每次交互都开新对话**。频繁创建新标签页会：
- 丢失上下文（历史对话中的代码、决策、约定）
- 触发 Google 的安全验证
- 浪费 token（每次都要重新描述背景）

**正确做法**：

1. **复用已有标签页**：用 `connect_over_cdp` 找到现有 Gemini tab，在同一对话中继续
   ```python
   for ctx in browser.contexts:
       for pg in ctx.pages:
           if 'gemini' in pg.url and pg.title() != 'about:blank':
               page = pg; break  # 复用已有对话
   ```

2. **遇到问题时刷新页面，不要新建**：
   ```python
   # 页面卡住、输入无响应 → reload 而非 new_page()
   page.reload()
   page.wait_for_selector('[role="textbox"]', timeout=15000)
   ```

3. **只有在以下情况才开新对话**：
   - 对话历史超过 25 轮（Session Rotation）
   - 页面崩溃（`page.is_closed()` 或 `TargetClosedError`）
   - 主题完全切换，旧上下文会干扰新任务

4. **发送前验证**：每次发送前检查发送按钮状态
   ```python
   send = page.locator('button[aria-label="发送"]')
   if send.count() == 0 or not send.is_enabled():
       # Angular 检测未触发 → 重新聚焦 + 键入逗号触发
       page.locator('[role="textbox"]').click()
       page.keyboard.type(',')
       page.keyboard.press('Backspace')
       time.sleep(0.5)
   ```

## Invocation

```bash
node index.js "PROMPT"
node index.js --timeout=300000 "PROMPT"
echo "Long prompt" | node index.js
node index.js --smoke      # verify environment without submitting
node index.js --doctor     # check Chrome CDP connectivity only
```

- `--timeout=N` — absolute execution deadline in ms (covers mode switch + typing + thinking + extraction). Default 600000 (10 min).
- `--smoke` — verify environment is healthy without sending a prompt. Exit 0 if OK.
- `--doctor` — check CDP port connectivity only. Does not require a Gemini tab.
- Response on stdout, diagnostics + elapsed timer spinner on stderr (`[gemini]` prefix).
- Telemetry written to `gemini-telemetry.jsonl` (JSON Lines format).

## Execution Guarantees (v2)

1. **Isolated tabs** — `acquireIsolatedPage` spawns a dedicated tab per invocation → parallel-safe.
2. **Action Toolbar detection** — `waitForResponse` anchors on Copy/Thumbs buttons appearing (only when generation AND rendering are complete).
3. **15s stability fallback** — `Date.now()`-bound innerText check if toolbar doesn't appear.
4. **Tiered recovery** — soft (stop generation + clear editor) → hard (page reload). Target crashes propagated, not swallowed.
5. **CDP reconnect** — `connectWithRetry` with `disconnected` event listener.
6. **Adaptive input** — `insertText` (≤50KB) / clipboard paste (>50KB) with payload integrity verification.
7. **Rate-limit detection** — checks `contenteditable` state before typing; exits code 5 if editor is locked.
8. **Session expiry watch** — verifies page URL hasn't redirected mid-generation.

## Error Recovery

| Exit | Error code | Meaning | Action |
|------|-----------|---------|--------|
| 1 | `ERR_NOT_AUTHENTICATED` | Gemini requires sign-in | Open gemini.google.com in Chrome and log in |
| 1 | — | Chrome CDP not reachable | Run `scripts/start-chrome-debug.sh` |
| 2 | `ERR_MODEL_DEGRADED` | Pro Extended failed to activate | **Stop.** Do NOT retry. Report to user. |
| 3 | `ERR_SAFETY_REJECTED` | Safety filter rejected prompt | Skip prompt. Do NOT retry. |
| 4 | `ERR_EDITOR_NOT_FOUND` | Input editor not in DOM (UI changed?) | Update selectors in index.js |
| 4 | `ERR_INPUT_CORRUPTED` | WebSocket dropped input frames | Retry (handled internally) |
| 5 | `ERR_RATE_LIMITED` | Editor locked — quota exceeded | Orchestrator should `sleep 3600` before retrying |
| 6 | `ERR_SESSION_EXPIRED` | Google auth expired mid-generation | Re-authenticate in Chrome, then retry |
| 7 | `ERR_TARGET_CRASHED` | Chrome tab crashed (OOM?) | Restart Chrome, increase resource limits |
| 8 | `ERR_BLANK_PAGE` | Gemini tab URL 正确但 title=about:blank | Chrome 导航失败 (3层 fail-safe)。Kill Chrome → 重启 daemon |
| 10 | `ERR_TIMEOUT` | Max timeout reached — response incomplete | Partial output discarded; retry or increase `--timeout` |

### Err 8 诊断流程 (Gemini tab about:blank)

当 `/json/list` 显示的 Gemini tab URL 正确但 `window.location.href === "about:blank"`：

```bash
# 1. 确认症状
curl -s http://127.0.0.1:9222/json/list | python3 -c "
import json,sys
pages=json.load(sys.stdin)
for p in pages:
    if 'gemini' in p.get('url','').lower():
        print(f'URL={p[\"url\"]} title={p[\"title\"]}')
        # 如果 title=about:blank → 确认问题
"

# 2. 重启 Chrome daemon
pkill -9 chrome
sleep 2
bash scripts/start-chrome-debug.sh

# 3. 验证修复 (title 应为 "Google Gemini")
bash scripts/connect-gemini.sh
```

### Chrome Daemon 手动管理

```bash
# 查看 daemon 状态
cat /tmp/chrome-debug.pid 2>/dev/null && echo "Daemon PID: $(cat /tmp/chrome-debug.pid)"
pgrep -c chrome && echo "Chrome 进程运行中"

# 查看日志
cat /tmp/chrome-debug.log

# 重启 daemon
pkill -9 -f "start-chrome-debug.py"
pkill -9 chrome
sleep 2
bash scripts/start-chrome-debug.sh
```

## Key Architecture Decisions

- **Playwright daemon over raw Chrome launch** — raw CDP `Page.navigate`/`Target.createTarget` 在 Chrome 安全组件 fail-safe 下不可靠。Playwright 的 `page.goto()` 通过注入关键 feature flags 和正确的浏览器生命周期管理可靠导航。
- **Critical Chrome flags** — `--disable-features=OptimizationHints,Translate,HttpsUpgrades` + `--disable-background-networking` + `--disable-client-side-phishing-detection` 必须在 Chrome 启动时注入，否则 Google 云端依赖链会导致 3 层 fail-safe。
- **Playwright Chromium over Chrome for Testing** — CfT 的网络栈精简导致 TLS 处理差异；Playwright 自带的 Chromium (v149) 是标准构建，与 Playwright API 的兼容性最好。
- **Action Toolbar as completion anchor** — avoids false truncation when Extended Thinking pauses >6s mid-reasoning.
- **Tab isolation over page reuse** — prevents concurrent runs from corrupting each other's input.
- **Escape-to-dismiss** — more reliable than `body.click()` for Angular CDK overlays.
- **Partial state handling** — `ensureProExtended` checks if Extended is already visible before toggling accordion.
- **playwright-core (npm)** — CDP 连接 (index.js) 只需 ~3MB 的 playwright-core，不需要完整 playwright (~300MB)。
- **playwright (pip)** — Chrome daemon 启动 (start-chrome-debug.py) 需要 Python playwright 包管理浏览器生命周期。

## Code Location

- `index.js` — Playwright/CDP implementation (~550 lines, commented DOM selectors)
- `SKILL.md` — this file (AI-facing operational guide)
- `package.json` — npm package manifest with `playwright-core` dependency

## Chrome Launch Flags — 完整参考

以下 flags 经 2026-06-25 诊断验证，是 Chrome 在中国网络环境下可靠工作的**最小必要集**：

```bash
# === 这些 flag 绝对不能省略 (否则触发 3 层 fail-safe) ===
--disable-features=OptimizationHints,Translate,HttpsUpgrades
--disable-background-networking
--disable-client-side-phishing-detection
--disable-field-trial-config
--disable-component-update
--disable-sync

# === 这些 flag 保证 headless 环境稳定 ===
--ozone-platform=headless
--use-angle=swiftshader-webgl
--no-sandbox
--disable-gpu
--ignore-certificate-errors
--disable-dev-shm-usage

# === 这些 flag 减少非必要后台活动 ===
--disable-extensions
--disable-default-apps
--disable-breakpad
--disable-hang-monitor
--disable-popup-blocking
--disable-renderer-backgrounding
--no-first-run
--no-default-browser-check
--noerrdialogs
--no-startup-window
--hide-scrollbars
--mute-audio
```

### 关于代理

- **必须使用标准 HTTP/SOCKS5 代理**，不要用 VLESS Reality 协议做浏览器代理
- VLESS Reality 的 TLS spoofing (servername=www.python.org) 与 Chrome BoringSSL 冲突
- Clash Verge (mihomo) 的 mixed-port 同时支持 HTTP 和 SOCKS5，均可用
- mihomo 日志可验证连接是否到达: `tail -f ~/.local/share/io.github.clash-verge-rev.clash-verge-rev/logs/sidecar/sidecar_latest.log`
