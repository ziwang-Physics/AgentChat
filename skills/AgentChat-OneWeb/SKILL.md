---
name: AgentChat-OneWeb
description: Multi-provider CDP bridge with automatic fallback (Gemini->ChatGPT->Claude->Qwen->Kimi->MiniMax->MiMo->DeepSeek). Use for AI provider failover, fallback chain, multi-provider routing, or "send to any available AI". MANDATORY EXECUTION - invoking this skill REQUIRES running `node ~/.claude/skills/AgentChat-OneWeb/index.js "<prompt>"` as the FIRST action and quoting its `[receipt] AGENTCHAT_RUN` line in the final answer; explaining the skill or answering from model knowledge without a receipt is a violation.
---

# AI Fallback Chain — Multi-Provider CDP Bridge

> **最后更新**: 2026-07-17
> **核心功能**: 按优先级链自动降级，确保始终有一个可用的大模型
> **变更日志**: 见 [CHANGELOG.md](CHANGELOG.md)

## ⚠️ 强制规则 — 调用即执行（首要动作契约）

**本 skill 被调用（如 `/AgentChat-OneWeb <问题>`）时，必须执行 `node` 命令把用户问题发送到 web AI。禁止只解释用法而不执行，禁止用模型自身知识替代 web AI 的回答。**

### 1. 首要动作契约
读完本 SKILL.md 之后的**下一个工具调用**必须是：

```bash
node ~/.claude/skills/AgentChat-OneWeb/index.js "<用户prompt>"
```

中间不允许插入文件浏览、架构分析、"我将会…"式的规划叙述（至多一行说明即将执行的命令）。web AI 返回结果后，才可补充你自己的分析。

### 2. 执行回执（receipt）— 是否执行以此为准，不以叙述为准
每次真实执行（含失败）都会在 **stderr** 输出一行机器生成的回执：

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx","skill":"AgentChat-OneWeb","exit":0,"provider_used":"Gemini",...}
```

- **最终回答末尾必须原样引用这行 receipt**（至少包含 run_id、provider_used、exit）。
- 没有 receipt = 没有执行 = 违规，必须回去执行。
- `run_id` 为随机生成并同步落盘到 `~/.claude/skills/AgentChat-OneWeb/data/receipts.jsonl`，用户可用 `grep <run_id>` 核对——凭空编造无法通过核对。
- **执行失败（exit≠0）同样有 receipt**：必须引用失败回执并说明原因（限流/未登录/超时…），在此之后才允许用模型自身能力回答，且必须明确标注"web AI 未参与本次回答"。

### 3. 违规模式（全部禁止）
- ❌ 读完 SKILL.md 后描述 fallback 链、罗列 CLI 参数、讲解架构——却不跑 `node index.js`
- ❌ 以"问题太简单/我已经知道答案"为由跳过执行，直接用模型知识回答
- ❌ 回答中没有 `[receipt] AGENTCHAT_RUN` 行却声称"已通过 web AI 处理"

### 4. 例外
仅限：`--smoke`、`--doctor`，或用户明确要求"只检查环境不发送"。这两种模式不产生 receipt，属预期行为。

## 📐 输出排版规范 — 最终回答强制格式

约束对象是 Claude Code 撰写的**最终落地文本**；worker 原始输出、代码块、diff、表格与 receipt 行不受约束。

1. **结论先行**：开头第一段为 ≤50 字的核心结论（TL;DR），直接回答用户根本诉求，无客套话、无方法论铺垫。
2. **标题层级**：主模块用 `##`，子观点用 `###`，禁止一级标题 `#`。维度按逻辑聚类为 3–5 块（如：背景/现状/分析/结论），禁止按检索顺序写流水账。
3. **视觉焦点**：数据、时间、专有名词、核心论点用 `**加粗**` 标出；加粗仅用于焦点引导，每个自然段不超过 2 处。
4. **列表纪律**：只允许单层无序列表 `*`，禁止任何多级嵌套列表（保证终端/聊天框阅读体验）。
5. **文本密度**：叙述性自然段 ≤3 句，新逻辑分支必须换行分段；禁止"总而言之""基于以上搜索结果""作为一个人工智能"等无实质信息的过渡句。
6. **信息隔离**：引用 web AI 原文片段或外部链接时必须放入 `>` 引用块并标注来源 provider，与自己的分析严格区分。
7. **豁免条款（优先级高于第 1–6 条）**：
   * `[receipt] AGENTCHAT_RUN {...}` 行（或各步 run_id 清单）必须原样保留在回答末尾的代码块中，禁止改写、加粗、省略——受强制规则 §2 约束。
   * 降级/失败披露（如"N 个角色降级""web AI 未参与本次回答"）属流程透明性要求，不算冗余过渡句，不得删除。
   * 代码块、diff、表格不受段落长度与列表层级限制。

## 🖼️ 图片生成协议 (Image Generation Protocol)

### 触发条件

当用户请求涉及以下任一关键词时，触发图片生成协议：

* **生成类**: 生成图片、画图、制图、绘制、作图、生成图、create image、generate image、make image
* **图表类**: 流程图、架构图、示意图、思维导图、图表、拓扑图、chart、diagram、flowchart、mindmap、Mermaid
* **可视化类**: 可视化、visualization、illustration、infographic、DALL·E、Imagen、Midjourney

### 1. Prompt 自动增强（强制 — 传 `--image` flag，v14 起由 index.js 内置）

检测到图片生成请求时，**必须**在命令中加入 `--image` flag：

```bash
node ~/.claude/skills/AgentChat-OneWeb/index.js --image "<用户原始prompt>"
```

index.js 会在进程内把标准增强指令（"请使用你的图片生成模型/工具主动生成…"）追加到 prompt 末尾，并在 telemetry 中记录 `image_prompt_enhanced: true`。**禁止手工改写 prompt 来替代 `--image`** —— 手工追加是纯 prose 约束，属于 receipt 机制要消灭的那类"叙述性合规"；flag 路径是机器可验证的（telemetry 可查）。

如果用户已明确指定 `--from=ChatGPT`（DALL·E）或 `--from=Gemini`（Imagen），优先使用该 provider 的生图能力：`--image --from=Gemini`。

### 2. 图片自动下载（强制 — index.js 内置）

index.js 在收到 web AI 响应后，**自动执行**以下步骤：

1. 扫描响应文本中的图片 URL：
   * Markdown 语法：`![alt](url)`
   * HTML 标签：`<img src="url">`
   * 直链：以 `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.svg` 结尾的 URL
2. 将每张图片下载到 **当前工作目录**（`process.cwd()`，即用户执行 skill 时所在的目录）
3. 文件名格式：`ai-image-{YYYYMMDD-HHmmss}-{pid}-{序号}.{ext}`（v14 加入 pid，避免并发 worker 同秒写同名互相覆盖）
4. 下载结果摘要（`## 📥 Downloaded Images` 段落）：**stdout 为 TTY 时**（人类直接运行）附加在响应末尾；**stdout 为管道时**（execute.js / Python SDK / MCP server 消费）摘要只走 stderr，stdout 保持"AI 响应原文"机器契约不被污染，成功/失败计数记入 receipt（`images_ok` / `images_failed`）。

**v14 硬限制**（下载 URL 来自 web AI 响应这一不可信文本，可被 prompt injection 操控）：
* 每次响应最多下载 **20 张**，超出部分在摘要中明确标记为 skipped
* 单张 **30MB** 上限；下载阶段总预算 **120s**；tier-2 页面内 fetch 带 25s AbortSignal（此前无超时——一个挂起的图片端点会让整个进程永不退出）
* 所有 tier 均做 **payload 嗅探**：HTTP 200 返回的 HTML 错误页判定为下载失败，不再落盘为损坏的 `.png`
* **拒绝 loopback / link-local / RFC1918 私网地址**（如 `http://127.0.0.1:9222/...` —— 注入的 URL 曾可把 CDP 调试端点数据写进用户目录）；内网/测试环境可用 `AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS=1` 放行
* 相对 `Location:` 重定向与 303 已正确跟随；重定向目标同样过 blocked-host 检查

如果响应中无图片 URL，该步骤为零开销 no-op。

### 3. 下载目录说明

下载目标始终为 **用户当前工作目录**（shell 的 `$PWD`），而非 skill 安装目录。例如：
* 用户在 `~/Project/` 下调用 `/AgentChat-OneWeb 帮我画流程图` → 图片下载到 `~/Project/`
* 用户在 `~/Data_Project/` 下调用 → 图片下载到 `~/Data_Project/`

可通过 `--no-download-images` 标志禁用自动下载。

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
#    v15 起 index.js 会在端口不通时自动执行本平台启动脚本（一次，等待 45s；
#    AGENTCHAT_NO_AUTOSTART=1 关闭）。手动预启动仍然更快：
#    Linux/macOS:
pgrep -f "start-chrome-debug" || bash scripts/start-chrome-debug.sh
#    Windows (PowerShell；首次使用加 -FirstLogin 登录 Gemini):
#      powershell -ExecutionPolicy Bypass -File scripts\start-chrome.ps1
#    WSL2 注意: WSL 内 127.0.0.1 是 VM 而非 Windows 宿主。Chrome 跑在
#    Windows 侧时需设 CDP_HOST=<Windows 宿主 IP>（见 .env.example）。

# 2. CDP 可达
curl -s http://127.0.0.1:9222/json/version | python3 -c "import json,sys; print(json.load(sys.stdin).get('Browser','FAIL'))"

# 3. playwright-core (npm, ~3MB)
(cd ~/.claude/skills/AgentChat-OneWeb && npm install)
#    ⚠️ 本 skill 依赖同级 skills/lib/ 共享库（require('../lib/…')）——
#    安装到 ~/.claude/skills/ 时必须整棵拷贝：AgentChat-OneWeb/ 与 lib/ 并排。
#    只拷 AgentChat-OneWeb/ 会在启动时报出带修复指引的 FATAL（v14 起，不再是裸 MODULE_NOT_FOUND）。

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
node ~/.claude/skills/AgentChat-OneWeb/index.js "Your prompt"

# 执行完毕后自动清理浏览器标签
node ~/.claude/skills/AgentChat-OneWeb/index.js --close "Your prompt"

# 指定超时 (ms)
node ~/.claude/skills/AgentChat-OneWeb/index.js --timeout=600000 "Long prompt..."

# 从 stdin 读取
echo "Prompt from pipe" | node ~/.claude/skills/AgentChat-OneWeb/index.js

# 环境检查 (不发送 prompt)
node ~/.claude/skills/AgentChat-OneWeb/index.js --smoke

# CDP 连通性检查
node ~/.claude/skills/AgentChat-OneWeb/index.js --doctor

# 强制指定起始 provider (跳过前面的)
node ~/.claude/skills/AgentChat-OneWeb/index.js --from=ChatGPT "prompt"
```

### CLI Flags

| Flag | 说明 |
|------|------|
| `--timeout=N` | 总超时 (ms)，包含所有 provider 尝试时间，默认 600000 |
| `--timeout-per-provider=N` | 单个 provider 超时 (ms)，默认取 `timeout / 2` 或 180000 |
| `--from=NAME` | 从指定 provider 开始，跳过链中前面的。NAME 可缩写不区分大小写 |
| `--single` | 只尝试 `--from` 指定的那一个 provider，失败即返回，不级联到链中后续 provider。给需要自己做跨 provider 降级+加锁的调用方用（如 AgentChat-IndependentTasks），避免子进程内部级联绕开调用方的互斥锁 |
| `--only=NAME` | `--from=NAME --single` 的合并简写（程序化调用方使用；未知 NAME 会 fail loudly 而非静默回退） |
| `--locale=xx_XX` | 强制 Gemini UI 语言 profile（`zh_CN` / `zh_TW` / `en` / `ja`），跳过自动检测。Python SDK 的 `locale=` 参数即透传此 flag |
| `--smoke` | 环境检查：遍历所有 provider 确认至少一个可达 |
| `--doctor` | CDP 端口连通性检查 |
| `--close` / `--close-browser` | 执行完毕后关闭所有 tab 和浏览器连接（默认保留） |
| `--image` | 图片生成意图：index.js 进程内追加标准生图增强指令并记录 `image_prompt_enhanced` telemetry（见图片协议 §1） |
| `--no-download-images` | 禁用图片自动下载（默认启用，从响应中提取图片 URL 下载到当前工作目录） |

> 未识别的 `--flag` 会打 `WARN` 日志后忽略（v14 起；此前静默丢弃，是 `--locale` 空转数月、`--keep-tabs` 曾被拼进 prompt 这一类 bug 的根源）。`--from=` / `--only=` 空值会以 exit 64 硬失败。`--only`/`--single` 下 provider 名必须**精确匹配** key 或显示名（子串匹配仅在级联路径作为人类便利保留）。

---

## Output & Telemetry

- **stdout**: 成功时输出 AI 响应原文
- **stderr**: 诊断日志，`[fallback]` 前缀
- **telemetry**: 写入 `~/.claude/skills/AgentChat-OneWeb/data/fallback-telemetry.jsonl`

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
| 64 | `EX_USAGE` | 用法错误（空 prompt / `--from=`、`--only=` 空值）。v14 前误用 exit 1，与 ERR_NO_CDP 冲突，会让编排方把调用方 bug 当成"浏览器挂了"终止整条链。用法错误同样产生 receipt |

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
- `lib/providers/chain.js` — 优先级顺序 (与 IndependentTasks 共享的单一真相源)
- `SKILL.md` — AI-facing operational guide
- `package.json` — npm metadata (playwright-core)
