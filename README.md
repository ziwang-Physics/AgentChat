# AgentChat — Multi-AI CDP Automation

Chrome CDP + Playwright 驱动的多 AI Web 自动化系统。支持 6 个 AI provider，含自动降级链和并行编排。

## Skills

| Skill | 语言 | 功能 |
|-------|------|------|
| **AgentChat-WebExtended** | Node.js | 6-Provider Fallback Chain：Gemini→ChatGPT→Claude→Qwen→Kimi→MiniMax。自动降级、quota 检测、遥测 |
| **AgentChat-FreeSubAgent** | Node.js | 并行编排器：任务分解→4 worker 并发→证据仲裁。委托 WebExtended 执行 AI 调用 |
| **gemini-web-extended-thinking** | Node.js | Gemini Pro Extended Thinking 激活。单 provider，高深度推理专用 |

## 为什么用这个？

### 1. DeepSeek 的需求力 × Gemini 的回答力

DeepSeek 擅长理解意图、拆解任务、规划步骤，但在专业领域（如计算化学、材料科学）
的知识深度不如 Gemini Pro。Gemini 擅长长链条推理和深度思考，但缺乏主动规划和执行能力。

**AgentChat 将两者桥接**：DeepSeek（或 Claude Code）作为 Planner 制定策略 →
通过 CDP 将组合好的 prompt 注入 AI Web → 取回思考结果。
这是 **"思考者 + 执行者"的协同模式**。

### 2. 极致的 Token 节省

网页版 AI 对用户**免费**，生成的思考 token 不占用任何 API 费用。
而 DeepSeek 生成问题的 token 消耗极低（通常仅几十到几百 token 用于 prompt 拼接和规划）。

对比传统全 API 方案：
- **API 方案**：每轮对话的输入 + 输出 token 全部计费，长链条推理成本指数级增长
- **AgentChat 方案**：DeepSeek 只消耗少量规划 token → AI Web 免费生成 → 近乎零成本的深度推理

**这就是"免费大脑"模式**：用最便宜的模型做规划，用最强大的免费 Web 端做推理。

### 3. 不止于 Gemini

这个架构的本质是 **"用 CDP 桥接任何 LLM 到任何 Web 应用"**。同样的思路可以：
- 接入 **ChatGPT Web**、**Claude Web**、**Kimi**、**Qwen**、**MiniMax**（已实现）
- 批量操作 Google Scholar、PubMed、arXiv 等学术网站
- 自动化 ACS、RSC 等期刊的文献检索和下载
- 构建多模型协作工作流（Gemini 负责推理 → Claude 负责写代码 → DeepSeek 负责审阅）

## 🚀 快速开始 (新机器, 5 分钟)

```bash
# 1. 克隆
git clone https://github.com/ziwang-Physics/AgentChat.git
cd AgentChat

# 2. 安装 Python 依赖 (Chrome daemon)
pip3 install playwright websocket-client
python3 -m playwright install chromium

# 3. 安装 Node.js 依赖 (AI bridge skills)
(cd skills/gemini-web-extended-thinking && npm install)
(cd skills/AgentChat-WebExtended && npm install)

# 4. 配置 (可选, 默认可直接使用)
cp .env.example .env
# 编辑 .env 修改代理地址等

# 5. 环境检查
bash scripts/setup.sh

# 6. 启动
bash scripts/start-chrome-debug.sh   # 启动 Chrome + Gemini
bash scripts/connect-gemini.sh       # 一键连接 Gemini
```

## 环境要求

| 依赖 | 安装 |
|------|------|
| **Node.js 18+** | [nodejs.org](https://nodejs.org/) 或 `apt install nodejs` |
| Python 3.8+ | 系统自带 |
| Playwright (Python) | `pip3 install playwright` |
| Playwright Chromium | `python3 -m playwright install chromium` |
| websocket-client | `pip3 install websocket-client` |
| playwright-core (npm) | `npm install` 在各 skill 目录 |
| HTTP/SOCKS5 代理 | Clash Verge / v2ray 等 (中国大陆必需) |
| Google 账号 | 用于登录 Gemini (可选, 免登录也支持基础对话) |

## 配置

复制 `.env.example` 为 `.env` 并按需修改：

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `CDP_PORT` | `9222` | Chrome DevTools Protocol 端口 |
| `PROXY_SERVER` | `http://127.0.0.1:7897` | 代理地址 (中国大陆用户**必须**) |
| `GEMINI_URL` | `https://gemini.google.com/u/0/app` | Gemini 目标 URL |
| `CHROME_PROFILE` | `~/.chrome-debug-profile` | Chrome 持久化 Profile (保存 Google 登录) |
| `CHROMIUM_PATH` | 自动检测 | 手动指定 Chromium 路径 (一般无需设置) |
| `LOG_FILE` | `/tmp/chrome-debug.log` | 诊断日志输出路径 |

脚本启动时会**自动加载**项目根目录的 `.env` 文件，无需手动 `source`。

## 🔐 登录 Google 账号（重要）

Gemini Web 需要 Google 账号才能使用 Pro Extended Thinking。免登录模式仅支持基础 Flash 模型。

Chrome 的登录状态保存在 `CHROME_PROFILE` 目录（默认 `~/.chrome-debug-profile`），只需登录一次：

```bash
# 启动带窗口的 Chrome（正常显示登录页面）
python3 -c "
import os
from playwright.sync_api import sync_playwright
with sync_playwright() as p:
    ctx = p.chromium.launch_persistent_context(
        user_data_dir=os.path.expanduser(os.environ.get('CHROME_PROFILE', '~/.chrome-debug-profile')),
        headless=False,
        proxy={'server': os.environ.get('PROXY_SERVER', 'http://127.0.0.1:7897')},
        args=['--no-sandbox','--disable-gpu']
    )
    ctx.pages[0].goto('https://gemini.google.com/u/0/app')
    input('登录完成后按 Enter 关闭浏览器...')
    ctx.close()
"
```

**验证登录状态**
```bash
curl -s http://127.0.0.1:9222/json/list | python3 -c "
import json,sys
for p in json.load(sys.stdin):
    if 'gemini' in p.get('url',''): print(p['title'])
"
# 成功 → Google Gemini   失败 → 显示「登录」字样
```

## 目录结构

```
AgentChat/
├── .env.example                         # 配置文件模板
├── .gitignore
├── README.md
├── scripts/
│   ├── setup.sh                         # 环境检查 (新用户必跑)
│   ├── start-chrome-debug.sh            # Chrome daemon 启动 (idempotent)
│   ├── start-chrome-debug.py            # Playwright daemon (Chrome 生命周期)
│   └── connect-gemini.sh                # 一键连接 Gemini
└── skills/
    ├── gemini-web-extended-thinking/    # JS: Gemini Pro Extended 激活
    │   ├── SKILL.md                     # AI 操作指南
    │   ├── index.js                     # Playwright/CDP 实现
    │   └── package.json                 # playwright-core 依赖
    ├── AgentChat-WebExtended/           # JS: 6-Provider Fallback Chain
    │   ├── SKILL.md                     # AI 操作指南 + Provider 文档
    │   ├── index.js                     # 完整实现 (~1700 lines)
    │   └── package.json                 # playwright-core 依赖
    └── AgentChat-FreeSubAgent/          # JS: 并行编排器
        ├── SKILL.md                     # AI 操作指南 + 角色分工
        └── index.js                     # 薄编排器 (~490 lines, 零provider代码)
```

## 使用示例

```bash
# 单 prompt → 自动选择 provider (fallback chain)
node skills/AgentChat-WebExtended/index.js "什么是量子点？"

# 指定 provider
node skills/AgentChat-WebExtended/index.js --from=Kimi "解释量子限域效应"

# 并行 4 worker 编排
node skills/AgentChat-FreeSubAgent/index.js --timeout=900 "对比分析 Pt、Pd、Ru 三种催化剂的CO氧化活性"

# Gemini Pro Extended Thinking
node skills/gemini-web-extended-thinking/index.js "深度分析以下反应路径..."
```

## Chrome 导航问题 (中国网络环境)

在中国网络环境下，Chrome 启动时会向 Google 云端发起 SSL 请求，被 GFW 阻断 →
Chrome 安全组件初始化失败 → 进入 **fail-safe 模式** → 所有用户导航被阻断。

**症状**：Gemini tab URL 正确但 `title=about:blank`, `window.location.href="about:blank"`。
**修复**：Playwright daemon 注入关键 feature flags 在启动时切断 Google 依赖链。

详见 `skills/gemini-web-extended-thinking/SKILL.md` → "Chrome 启动架构" 章节。

### 常见故障

| 症状 | 原因 | 修复 |
|------|------|------|
| Gemini tab `about:blank` | Chrome 3-layer fail-safe | `pkill -9 chrome && bash scripts/start-chrome-debug.sh` |
| `ERR_BLOCKED_BY_CLIENT` | Safe Browsing | 检查 flags 含 `--disable-features=OptimizationHints` |
| SSL `net_error -100` | GFW RST 或 Reality TLS 冲突 | 使用 HTTP/SOCKS5 代理，不要用 VLESS Reality |
| `MODULE_NOT_FOUND: playwright-core` | 未安装 npm 依赖 | `cd skills/... && npm install` |

## 在其他服务器上使用

1. `git clone` 此仓库
2. 确保代理 (HTTP/SOCKS5, **非 VLESS Reality**) 可达
3. `cp .env.example .env` 并修改代理地址
4. `bash scripts/setup.sh` 检查环境
5. 安装 npm 依赖: `(cd skills/gemini-web-extended-thinking && npm install) && (cd skills/AgentChat-WebExtended && npm install)`
6. `bash scripts/start-chrome-debug.sh` 启动
7. CDP 端口 9222 开放后即可通过 WebSocket 自动化交互

> ⚠️ **代理警告**: 必须使用标准 HTTP/SOCKS5 代理。VLESS Reality 协议的
> TLS spoofing (伪装 servername) 与 Chrome BoringSSL 冲突，会导致 SSL 握手失败。

## 手动管理

```bash
# 查看 daemon 状态
curl -s http://127.0.0.1:9222/json/list | python3 -c "
import json,sys
[print(f'{p[\"title\"]} | {p[\"url\"]}') for p in json.load(sys.stdin) if p.get('type')=='page']
"

# 查看日志
cat /tmp/chrome-debug.log

# 重启
pkill -9 -f "start-chrome-debug.py" && pkill -9 chrome
sleep 2
bash scripts/start-chrome-debug.sh
```

## License

MIT
