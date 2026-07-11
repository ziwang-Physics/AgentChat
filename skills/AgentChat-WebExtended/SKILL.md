---
name: AgentChat-WebExtended
description: Multi-provider CDP bridge with automatic fallback (Gemini->ChatGPT->Claude->Qwen->Kimi->MiniMax->MiMo->DeepSeek). Use for AI provider failover, fallback chain, multi-provider routing, or "send to any available AI".
---

# AI Fallback Chain — Multi-Provider CDP Bridge

> **最后更新**: 2026-07-04
> **核心功能**: 按优先级链自动降级，确保始终有一个可用的大模型
> **变更日志**: 见 [CHANGELOG.md](CHANGELOG.md)

## ⚠️ 强制规则 — 调用即执行

**本 skill 被调用时，必须执行 `node` 命令将用户问题发送到 web AI。禁止只解释用法而不执行。**

- ❌ 禁止：读完 SKILL.md 后描述 fallback 链、罗列 CLI 参数、讲解架构——却不跑 `node index.js`
- ✅ 必须：`node skills/AgentChat-WebExtended/index.js "<用户prompt>"` 作为首要动作。web AI 返回结果后，才可补充你的分析
- 例外：`--smoke`、`--doctor`，或用户明确要求"只检查环境不发送"

---

## Trigger

Use this skill when:
- The user asks to send a prompt to "any available AI"
- Gemini quota is known to be exhausted and a fallback is needed
- The user wants automatic provider failover without manual switching
- Running batch prompts where individual provider reliability matters

Do NOT use for: interactive conversations that need multi-turn context (each provider has independent session state).

**When to use THIS skill**:
- Multi-provider with automatic fallback. Use for reliability, batch processing, or when you don't care which AI answers.
- For Gemini-specific Max reasoning depth, use `--from=Gemini` to force Gemini first in the chain.

---

## Fallback Chain (Priority Order)

```
Gemini → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek
(Pro Extended)                                                  (last resort)
```

First available provider wins. Each step falls through ONLY on confirmed unavailability (quota/auth/model-degraded), never on transient network errors.

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
模型激活分三层降级：
1. **Pro Extended Thinking**（需 Gemini Pro 订阅）— 首选
2. **Flash 模式**（免费 tier 兜底）— Pro Extended 不可用时自动切换
3. 两者都失败 → `ERR_MODEL_DEGRADED`，降级到 ChatGPT

降级触发条件由各 adapter 的 `quotaPatterns` 定义（`lib/providers/adapters/<name>.js`），
是权威来源。SKILL.md 不再维护第二份副本（过去已出现与代码不一致的漂移）。

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

# 3. playwright-core (npm, ~3MB)
(cd skills/AgentChat-WebExtended && npm install)

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
| `--single` | 只尝试 `--from` 指定的那一个 provider，失败即返回，不级联到链中后续 provider。给需要自己做跨 provider 降级+加锁的调用方用（如 AgentChat-FreeSubAgent），避免子进程内部级联绕开调用方的互斥锁 |
| `--only=NAME` | `--from=NAME --single` 的合并简写（程序化调用方使用；未知 NAME 会 fail loudly 而非静默回退） |
| `--locale=xx_XX` | 强制 Gemini UI 语言 profile（`zh_CN` / `zh_TW` / `en` / `ja`），跳过自动检测。Python SDK 的 `locale=` 参数即透传此 flag |
| `--smoke` | 环境检查：遍历所有 provider 确认至少一个可达 |
| `--doctor` | CDP 端口连通性检查 |
| `--close` / `--close-browser` | 执行完毕后关闭所有 tab 和浏览器连接（默认保留） |

---

## Output & Telemetry

- **stdout**: 成功时输出 AI 响应原文
- **stderr**: 诊断日志，`[fallback]` 前缀
- **telemetry**: 写入 `skills/AgentChat-WebExtended/data/fallback-telemetry.jsonl`

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
| 2 | `ERR_NO_PROVIDER` | 所有 provider 不可用 (全部未登录/需认证) |
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
├── RUNNERS (factory-built)   — 8 provider runners via createProviderRunner()
│   ├── gemini                — config: lib/providers/adapters/gemini.js
│   ├── chatgpt               — config: lib/providers/adapters/chatgpt.js
│   ├── claude                — config: lib/providers/adapters/claude.js
│   ├── qwen                  — config: lib/providers/adapters/qwen.js
│   ├── kimi                  — config: lib/providers/adapters/kimi.js
│   ├── minimax               — config: lib/providers/adapters/minimax.js
│   ├── mimo                  — config: lib/providers/adapters/mimo.js
│   └── deepseek              — config: lib/providers/adapters/deepseek.js
├── helpers/
│   ├── isProviderTabOpen()   — tab dedup (shared with smokeTest)
│   ├── log() / startTimer()  — 终端输出 (lib/terminal.js)
│   └── connectWithRetry()    — CDP 连接 + 重试 (lib/cdp.js)
└── constants/
    └── PROVIDER_CHAIN        — 优先级顺序 + URL
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

每个 provider 的特殊行为定义在 `lib/providers/adapters/<name>.js` 中（配置驱动，非硬编码），SKILL.md 仅保留关键差异供 AI 调用参考：

| Provider | 关键差异 | 详见 |
|----------|---------|------|
| **Gemini** | Pro Extended 强制激活、bursty 输出检测、120s stop-btn 延长、Action Toolbar 完成锚点 | `adapters/gemini.js` |
| **ChatGPT** | 3 层输入策略 (clipboard→simulated paste→chunked keyboard)、React 发送按钮状态验证 | `adapters/chatgpt.js` |
| **Claude** | ProseMirror 编辑器、"Thinking" 占位符过滤、嵌入搜索块剥离 | `adapters/claude.js` |
| **Qwen** | React SPA 3s 延迟、stop-btn detached 模式、模型名前缀剥离 | `adapters/qwen.js` |
| **Kimi** | 每次调用新建会话、send-button-container disabled 检测、自适应稳定性窗口 (5-30s) | `adapters/kimi.js` |
| **MiniMax** | TipTap/ProseMirror 异步挂载 4s 延迟、`<div aria-label="发送消息">` 非 button 发送 | `adapters/minimax.js` |
| **MiMo** | React SPA 4s 延迟、DOM 遍历定位发送按钮 (无可靠 CSS selector) | `adapters/mimo.js` |
| **DeepSeek** | 标准管线、ds-markdown 响应 | `adapters/deepseek.js` |

---

## Adding a New Provider

1. 创建 `lib/providers/adapters/<name>.js` 导出 config 对象（参考现有 adapter）
2. 在 `PROVIDER_CHAIN` 数组中添加 entry
3. 在 `PROVIDER_KEYS` 数组中添加 key（自动注册到 RUNNERS）
4. Config 的关键字段: `url`, `authDomains`, `editorSelectors`, `sendSelectors`/`sendFallback`, `responseSelectors`
5. 函数返回 `{success: true, response: string}` 或 `{success: false, reason: string}`
   - `reason` 必须是: `"quota"` | `"auth"` | `"error"` | `"timeout"`

---

## Code Location

- `index.js` — CLI 入口 + fallback 编排器
- `lib/providerFactory.js` — 10-step config-driven pipeline (所有 8 个 provider 共享)
- `lib/providers/adapters/<name>.js` — 各 provider 差异配置
- `lib/providers/chain.js` — 优先级顺序 (与 FreeSubAgent 共享的单一真相源)
- `SKILL.md` — AI-facing operational guide
- `package.json` — npm metadata (playwright-core)
