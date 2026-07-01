# AI Fallback Chain — Multi-Provider CDP Bridge

> **最后更新**: 2026-07-02
> **核心功能**: 按优先级链自动降级，确保始终有一个可用的大模型
> **最近修复**:
> - Kimi 响应检测: 字符串相等比较 → 元素计数+文本长度增长, 修复同文本不匹配 bug
> - Kimi 新建会话: 每次调用前点击 `.new-chat-btn` 清空旧 DOM, 避免检测干扰
> - Kimi 问候语识别: `oldCount===1 && oldText<30chars` → 视为空白页
> - Kimi 稳定性窗口: 自适应 (5s/30s/20s/15s/8s), 短文不再等 30s
> - Kimi 串行超时: selector 60s → 10s each, 45s 最坏 → 30s
> - Gemini Pro Extended 长 prompt 超时: stop button 可见=仍在思考, 延长等待+120s
> - Claude "Thinking" 占位符: 过滤 Thinking/Analyzing 空响应, 多重停止检测
> - Promise.allSettled: FreeSubAgent 单 worker 异常不再影响其他 worker

## Trigger

Use this skill when:
- The user asks to send a prompt to "any available AI"
- Gemini quota is known to be exhausted and a fallback is needed
- The user wants automatic provider failover without manual switching
- Running batch prompts where individual provider reliability matters

Do NOT use for: interactive conversations that need multi-turn context (each provider has independent session state).

**When to use THIS skill vs gemini-web-extended-thinking:**
- **THIS skill**: Multi-provider with automatic fallback. Use for reliability, batch processing, or when you don't care which AI answers.
- **gemini-web-extended-thinking**: Gemini-specific, Pro Extended Thinking guaranteed. Use when you need MAX reasoning depth from Gemini.

---

## Fallback Chain (Priority Order)

```
┌──────────┐    quota/Pro不可用    ┌──────────┐    quota用尽    ┌──────────┐
│  Gemini  │ ───────────────────→ │ ChatGPT  │ ──────────────→ │  Claude  │
│ Pro延長  │                      │  (Web)   │                 │  (Web)   │
└────┬─────┘                      └────┬─────┘                 └────┬─────┘
     │ 成功                            │ 成功                       │ 成功
     ▼                                 ▼                           ▼
  返回结果                          返回结果                     返回结果

     quota用尽    ┌──────────┐    quota用尽    ┌──────────┐    quota用尽    ┌──────────┐
  ──────────────→ │   Qwen   │ ──────────────→ │   Kimi   │ ──────────────→ │ MiniMax  │
                  │ (通义千问) │                 │ (月之暗面) │                 │          │
                  └────┬─────┘                 └────┬─────┘                 └────┬─────┘
                       │ 成功                       │ 成功                       │ 成功
                       ▼                            ▼                            ▼
                    返回结果                     返回结果                     返回结果

     quota用尽    ┌──────────┐    quota用尽    ┌──────────┐
  ──────────────→ │   MiMo   │ ──────────────→ │ DeepSeek │
                  │ (小米)    │                 │          │
                  └────┬─────┘                 └────┬─────┘
                       │ 成功                       │ 成功
                       ▼                            ▼
                    返回结果                     返回结果

  全部不可用 → ERR_ALL_EXHAUSTED (exit code 9)
```

**核心规则**:
- 每次调用**只使用一个** provider — 第一个可用的就返回
- 只有确认当前 provider 不可用（quota 用尽/模型不可用/未登录）时才降级
- 不会因为网络瞬断就跳过 — 每个 provider 有独立的重试逻辑

---

## Provider Availability Detection

每个 provider 在发送 prompt 前会经过 3 层检查：

| 检查层 | 检测内容 | 失败行为 |
|--------|---------|---------|
| **L1: 可达性** | 页面能否加载、是否需要登录 | 跳过 → 下一个 provider |
| **L2: 可用性** | 输入框是否可编辑、是否被限流 | 跳过 → 下一个 provider |
| **L3: 模型质量** | Pro/高级模型是否可用 | Gemini 特有，其他 provider 跳过 |

### Gemini 特殊处理
Gemini 是 chain 中唯一要求 **Pro Extended Thinking** 的 provider。
如果 Pro Extended 无法激活（ERR_MODEL_DEGRADED），直接降级到 ChatGPT，
**绝不**使用 Gemini Flash 模式。

### 各 Provider 降级触发条件

| Provider | 降级条件 |
|----------|---------|
| **Gemini** | ① rate-limit (editor locked) ② Pro Extended 激活失败 ③ 未登录 |
| **ChatGPT** | ① "达到限额" ② "Upgrade to Plus" ③ 输入框只读 ④ 未登录 |
| **Claude** | ① "Rate limit exceeded" ② "out of messages" ③ 未登录 |
| **Qwen** | ① 输入框不可编辑 ② 配额提示 ③ 未登录 |
| **Kimi** | ① "高峰期算力不足" ② "Kimi有点累了" ③ 未登录 |
| **MiniMax** | ① 输入框不可编辑 ② 配额提示 ③ 未登录 |

---

## Prerequisites

```bash
# 0. ⚠️ CRITICAL: 必须使用系统 Chrome + 含登录态的 profile
#    复制并编辑项目 .env 文件：
#      cp .env.example .env
#    关键配置:
#      CHROMIUM_PATH=/usr/bin/google-chrome-stable  (REQUIRED — 必须设为系统 Chrome，留空会报错退出；拒绝 ms-playwright 路径)
#      CHROME_PROFILE=~/.chrome-debug-profile
#    如果未配置，所有 AI 网站的登录态会丢失！

# 1. Chrome debug 在端口 9222 运行
pgrep -f "start-chrome-debug" || bash scripts/start-chrome-debug.sh

# 2. CDP 可达
curl -s http://127.0.0.1:9222/json/version | python3 -c "import json,sys; print(json.load(sys.stdin).get('Browser','FAIL'))"

# 3. playwright-core (npm, ~3MB) — 在各 skill 目录安装
(cd skills/AgentChat-WebExtended && npm install)
(cd skills/gemini-web-extended-thinking && npm install)

# 4. 至少一个 AI service 已登录 (Chrome profile 中)
#    各 service 登录 URL:
#    Gemini:  https://gemini.google.com/u/0/app
#    ChatGPT: https://chatgpt.com/
#    Claude:  https://claude.ai/
#    Qwen:    https://www.qianwen.com/?source=tongyigw
#    Kimi:    https://kimi.moonshot.cn/
#    MiniMax: https://agent.minimaxi.com/
```

---

## Invocation

```bash
# 基本用法 — 自动遍历 fallback chain（默认保留浏览器标签）
node skills/AgentChat-WebExtended/index.js "Your prompt"

# 执行完毕后自动清理浏览器标签
node skills/AgentChat-WebExtended/index.js --close "Your prompt"

# 指定超时 (ms)
node skills/AgentChat-WebExtended/index.js --timeout=600000 "Long prompt..."

# 从 stdin 读取
echo "Prompt from pipe" | node skills/AgentChat-WebExtended/index.js

# 环境检查 (不发送 prompt)
node skills/AgentChat-WebExtended/index.js --smoke

# CDP 连通性检查
node skills/AgentChat-WebExtended/index.js --doctor

# 强制指定起始 provider (跳过前面的)
node skills/AgentChat-WebExtended/index.js --from=ChatGPT "prompt"
```

### CLI Flags

| Flag | 说明 |
|------|------|
| `--timeout=N` | 总超时 (ms)，包含所有 provider 尝试时间，默认 600000 |
| `--timeout-per-provider=N` | 单个 provider 超时 (ms)，默认取 `timeout / 2` 或 180000 |
| `--from=NAME` | 从指定 provider 开始，跳过链中前面的。NAME 可缩写不区分大小写 |
| `--smoke` | 环境检查：遍历所有 provider 确认至少一个可达 |
| `--doctor` | CDP 端口连通性检查 |
| `--close` / `--close-browser` | 执行完毕后关闭所有 tab 和浏览器连接（默认保留） |

---

## Output & Telemetry

- **stdout**: 成功时输出 AI 响应原文
- **stderr**: 诊断日志，`[fallback]` 前缀
- **telemetry**: 写入 `skills/AgentChat-WebExtended/fallback-telemetry.jsonl`

```json
{
  "timestamp": "2026-07-01T...",
  "provider_used": "ChatGPT",
  "providers_tried": ["Gemini"],
  "fallback_reasons": {"Gemini": "ERR_RATE_LIMITED"},
  "prompt_length_chars": 1500,
  "response_length_chars": 3200,
  "total_ms": 45000,
  "exit_code": 0
}
```

---

## Exit Codes

| Exit | Code | Meaning |
|------|------|---------|
| 0 | — | Success — response on stdout |
| 1 | `ERR_NO_CDP` | Chrome CDP 端口不可达 |
| 2 | `ERR_NO_PROVIDER` | 所有 provider 不可用 (未登录/页面加载失败) |
| 3 | `ERR_SAFETY_REJECTED` | 当前 provider 安全过滤拒绝 (已尝试所有) |
| 4 | `ERR_INTERNAL` | 内部错误 (Node 异常、CDP 断开等) |
| 5 | `ERR_RATE_LIMITED` | 所有 provider 均被限流 |
| 9 | `ERR_ALL_EXHAUSTED` | 遍历了全部 provider，全部不可用 |
| 10 | `ERR_TIMEOUT` | 总超时，无完整响应 |

---

## Architecture

```
index.js
├── main()                    — CLI 入口，解析参数
├── tryAllProviders()         — 按链遍历 provider，返回第一个成功
├── providers/ (inline)
│   ├── tryGemini()           — Gemini Pro Extended (复用已验证的 DOM selector)
│   ├── tryChatGPT()          — ChatGPT Web
│   ├── tryClaude()           — Claude Web
│   ├── tryQwen()             — 通义千问 Web
│   ├── tryKimi()             — Kimi/月之暗面 Web
│   ├── tryMiniMax()          — MiniMax Web
│   ├── tryMiMo()             — 小米 MiMo Studio Web
│   └── tryDeepSeek()         — DeepSeek Web
├── helpers/
│   ├── log() / startTimer()  — 终端输出
│   ├── connectWithRetry()    — CDP 连接 + 重试
│   ├── detectAuthRedirect()  — 检测是否跳转到登录页
│   └── recordTelemetry()     — JSONL telemetry
└── constants/
    ├── PROVIDER_CHAIN        — 优先级顺序 + URL
    └── QUOTA_PATTERNS        — 各 provider 的配额用尽关键词
```

### 核心设计决策

1. **One page per invocation** — 每次调用创建独立 tab，默认保留浏览器不关闭（`--close` 可启用自动清理）。
2. **New tab per provider** — 每个 provider 尝试使用独立 tab（通过 `context.newPage()`）。
   失败后关闭当前 tab，为下一个 provider 创建新 tab。
3. **Quota detection via DOM** — 不依赖 HTTP 状态码，而是检查页面 DOM 内容判断是否被限流。
4. **No cross-provider context** — 不对不同 provider 之间传递上下文。每次都是独立的 prompt。
5. **Pro Extended mandatory for Gemini** — Gemini 必须激活 Pro Extended 才使用，否则直接降级。

---

## Provider-Specific Implementation Notes

### Gemini
- 复用 `gemini-web-extended-thinking` skill 的已验证 DOM selector
- `ensureProExtended()` 函数逻辑与原始 skill 一致
- 检测：`contenteditable="false"` → rate limited

### ChatGPT
- URL: `https://chatgpt.com/`
- Editor: `[contenteditable="true"][role="textbox"]` 或 `#prompt-textarea`
- 模型检查：默认使用可用模型，不强制切换（免费用户无模型选择权）
- 限流检测：页面文本含 "limit" / "quota" / "upgrade"
- 发送：Enter 键（ChatGPT 的 Angular 与 Gemini 类似）

### Claude
- URL: `https://claude.ai/`
- Editor: `[contenteditable="true"]` (ProseMirror)
- 限流检测：页面文本含 "rate limit" / "exceeded" / "messages remaining"
- 发送：Enter 或 button[aria-label="Send Message"]

### Qwen (通义千问)
- URL: `https://www.qianwen.com/?source=tongyigw`
- Editor: `[contenteditable="true"][role="textbox"]` (Tailwind, 类名 `chat-input-editor` 风格)
- Send: Enter 键 (没有可识别的 send 按钮类名，全为 Tailwind 通用类)
- Response: `[class*="message-select-wrapper-answer"]` / `[class*="chat-answers-card-wrap"]`
- 加载检测: `[class*="loading"][class*="navigator"]`
- 限流检测：页面含 "额度" / "quota" / "次数"
- 注意：SPA 需要额外 3s 等待 React 渲染；需去 Qwen3.7-Max 模型名前缀

### Kimi (月之暗面)
- URL: `https://kimi.moonshot.cn/` (重定向至 `www.kimi.com`)
- Editor: `[contenteditable="true"][role="textbox"]` (类名 `chat-input-editor`)
- Send: `div.send-button-container` (输入文字后失去 "disabled" 类名)
- Response: `[class*="chat-content-item-assistant"]` / `[class*="segment-content"]`
- 响应检测: 元素计数 (`curCount > oldCount`) + 文本长度增长 (`txtLen > effectiveOldLen`)，**NOT** 字符串相等
- 新建会话: 每次调用前通过 `page.evaluate()` 点击 `.new-chat-btn`，带 fallback 文本搜索
- 问候语识别: `oldCount === 1 && oldText.length < 30` → `effectiveOldLen = 0`，避免 Kimi 默认问候语干扰
- 串行超时: 每 selector 10s（vs 旧版 60s），3 个 selector 最坏 30s
- 稳定性窗口: 自适应 — `<50 chars → 5s`, `<150 → 30s`, `<500 → 20s`, `<1500 → 15s`, `≥1500 → 8s`
- 限流检测：页面含 "高峰期算力不足" / "Kimi有点累了" / "聊的人太多了" — 注意限流消息在发送后才出现
- 注意：SPA 需要额外 4s 等待 React 渲染

### MiniMax
- URL: `https://agent.minimaxi.com/`
- Editor: TipTap/ProseMirror `div.tiptap.ProseMirror` (JS 异步挂载，需 `waitForTimeout(4000)`)
- Send: `<div aria-label="发送消息">`（非 `<button>`）
- Response: `[class*="message-content"]` / `[class*="matrix-markdown"]`
- 限流检测：页面含 "额度" / "quota" / "次数"

---

## Adding a New Provider

1. 在 `PROVIDER_CHAIN` 数组中添加 entry
2. 实现 `try<ProviderName>(page, prompt, timeout)` 函数
3. 函数返回 `{success: true, response: string}` 或 `{success: false, reason: string}`
4. `reason` 必须是以下之一: `"quota"` | `"auth"` | `"error"` | `"timeout"`
   - `"quota"` → 继续降级链
   - `"auth"` → 继续降级链
   - `"error"` → 继续降级链
   - `"timeout"` → 继续降级链

---

## Code Location

- `index.js` — 完整实现 (~2370 lines, 8 providers)
- `SKILL.md` — this file (AI-facing operational guide)
- `package.json` — npm metadata (playwright-core)
