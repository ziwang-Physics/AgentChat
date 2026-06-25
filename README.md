# AgentChat — Gemini Web Automation

Chrome CDP + Playwright 驱动的 Gemini Web 自动化交互系统。

## 为什么用这个？

### 1. DeepSeek 的需求力 × Gemini 的回答力

DeepSeek 擅长理解意图、拆解任务、规划步骤，但在专业领域（如计算化学、材料科学）
的知识深度不如 Gemini Pro。Gemini 擅长长链条推理和深度思考，但缺乏主动规划和执行能力。

**AgentChat 将两者桥接**：DeepSeek（或 Claude Code）作为 Planner 制定策略 →
通过 CDP 将组合好的 prompt 注入 Gemini Web → 取回 Gemini 的思考结果。
这是 **"思考者 + 执行者"的协同模式**，单独使用任何一个都无法达到。

### 2. 赋予 DeepSeek 多模态能力

DeepSeek 纯文本模型缺乏图像理解、网页浏览、复杂 UI 操作等多模态能力。
AgentChat 通过 Chrome CDP 让任何 LLM 都能：

- 📸 **截图分析** — `Page.captureScreenshot` → base64 → 传给 Gemini 做 OCR/图表分析
- 🌐 **网页浏览** — 让 Gemini 阅读在线文档、论文、代码仓库
- 🖱️ **UI 操作** — 点击、输入、文件上传等完整的浏览器交互
- 📄 **文件处理** — CSV 图表、分子结构图、PDF 截图 → Gemini 解读

### 3. 极致的 Token 节省

网页版 Gemini 对用户**免费**，生成的思考 token 不占用任何 API 费用。
而 DeepSeek 生成问题的 token 消耗极低（通常仅几十到几百 token 用于 prompt 拼接和规划）。

对比传统全 API 方案：
- **API 方案**：每轮对话的输入 + 输出 token 全部计费，长链条推理成本指数级增长
- **AgentChat 方案**：DeepSeek 只消耗少量规划 token → Gemini Web 免费生成 → 近乎零成本的深度推理

**这就是"免费大脑"模式**：用最便宜的模型做规划，用最强大的免费 Web 端做推理。

### 4. 抛砖引玉：不止于 Gemini

这个架构的本质是 **"用 CDP 桥接任何 LLM 到任何 Web 应用"**。同样的思路可以：

- 接入 **ChatGPT Web**（同样的 CDP 输入/读取模式）
- 接入 **Claude Web**（claude.ai 的 Artifact 和 Project 功能）
- 批量操作 Google Scholar、PubMed、arXiv 等学术网站
- 自动化 ACS、RSC 等期刊的文献检索和下载
- 构建多模型协作工作流（Gemini 负责推理 → Claude 负责写代码 → DeepSeek 负责审阅）

AgentChat 提供了最难的第一个环节 — 在中国网络环境下可靠地驱动 Chrome + Gemini Web。
其余 Web 应用的接入只需修改 DOM 选择器即可复用全部基础设施。

## 🚀 快速开始 (新机器, 5 分钟)

```bash
# 1. 克隆
git clone https://github.com/ziwang-Physics/AgentChat.git
cd AgentChat

# 2. 安装依赖
pip3 install playwright websocket-client
python3 -m playwright install chromium

# 3. 配置 (可选, 默认可直接使用)
cp .env.example .env
# 编辑 .env 修改代理地址等

# 4. 环境检查
bash scripts/setup.sh

# 5. 启动
bash scripts/start-chrome-debug.sh   # 启动 Chrome + Gemini
bash scripts/connect-gemini.sh       # 一键连接
```

## 环境要求

| 依赖 | 安装 |
|------|------|
| Python 3.8+ | 系统自带 |
| Playwright (Python) | `pip3 install playwright` |
| Playwright Chromium | `python3 -m playwright install chromium` |
| websocket-client | `pip3 install websocket-client` |
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
只需 `cp .env.example .env` → 编辑 `.env` → 直接运行脚本。

## 目录结构

```
AgentChat/
├── .env.example                    # 配置文件模板
├── scripts/
│   ├── setup.sh                    # 环境检查 (新用户必跑)
│   ├── start-chrome-debug.sh       # Chrome daemon 启动 (idempotent)
│   ├── start-chrome-debug.py       # Playwright daemon (Chrome 生命周期)
│   └── connect-gemini.sh           # 一键连接 Gemini
└── skills/
    ├── gemini-web-extended-thinking/   # Gemini Web Extended Thinking
    │   ├── SKILL.md                    # AI 操作指南
    │   ├── index.js                    # Playwright/CDP 实现
    │   └── package.json
    └── five-agent-gemini-cli/          # GemiNode Swarm 5-Agent 架构
        └── SKILL.md                    # 完整架构文档
```

## 脚本说明

### `setup.sh` — 环境检查
检查所有依赖，输出 通过/失败/需修复 状态。新机器第一件事就是跑这个。

### `start-chrome-debug.sh` — 启动 Chrome
- Idempotent — 多次运行安全 (如已运行则跳过)
- 自动检测代理可达性
- 等待 CDP 端口 + Gemini 页面完全加载
- 管理 Playwright daemon 进程

### `connect-gemini.sh` — 连接 Gemini
- 验证 Gemini tab 已加载 (title ≠ about:blank)
- 缺失时通过 Playwright `connect_over_cdp` 创建
- Playwright 失败时回退到 raw CDP `Target.createTarget`

### `start-chrome-debug.py` — Playwright Daemon
- 自动检测 Chromium 二进制 (Playwright → 系统 Chrome)
- 注入关键 feature flags 绕过 Google 云端依赖
- 导航到 Gemini 并 sleep forever (保持浏览器存活)

## Chrome 导航问题根因 (2026-06-25)

在中国网络环境下，Chrome 启动时会向 Google 云端发起 SSL 请求：
`accounts.google.com`, `update.googleapis.com`, `safebrowsingohttpgateway.googleapis.com` 等。

这些请求被 GFW 阻断 → Chrome 安全组件 (Safe Browsing / Data Protection DLP /
Optimization Guide) 初始化失败 → 进入 **fail-safe 模式** → 所有用户导航被阻断。

**症状**：Gemini tab URL 正确但 `title=about:blank`, `window.location.href="about:blank"`。
**修复**：Playwright 注入关键 feature flags 在启动时切断 Google 依赖链。

详见 `skills/gemini-web-extended-thinking/SKILL.md` → "Chrome 启动架构" 章节。

### Chrome 关键 Flags

```
--disable-features=OptimizationHints,Translate,HttpsUpgrades
--disable-background-networking
--disable-client-side-phishing-detection
--disable-field-trial-config
--disable-component-update
--disable-sync
--ozone-platform=headless
--use-angle=swiftshader-webgl
--ignore-certificate-errors
```

### 常见故障

| 症状 | 原因 | 修复 |
|------|------|------|
| Gemini tab `about:blank` | 3-layer fail-safe | `pkill -9 chrome && bash scripts/start-chrome-debug.sh` |
| `ERR_BLOCKED_BY_CLIENT` | Safe Browsing | 检查 flags 含 `--disable-features=OptimizationHints` |
| SSL `net_error -100` | GFW RST 或 Reality TLS 冲突 | 使用 HTTP/SOCKS5 代理，不要用 VLESS Reality |
| 输入文字后发送按钮不出现 | Angular 变更检测未触发 | 先键入逗号→粘贴→删逗号→发送 |

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

## 在其他服务器上使用

1. `git clone` 此仓库
2. 确保代理 (HTTP/SOCKS5, **非 VLESS Reality**) 可达
3. `cp .env.example .env` 并修改代理地址
4. `bash scripts/setup.sh` 检查环境
5. `bash scripts/start-chrome-debug.sh` 启动
6. CDP 端口 9222 开放后即可通过 WebSocket 自动化交互

> ⚠️ **代理警告**: 必须使用标准 HTTP/SOCKS5 代理。VLESS Reality 协议的
> TLS spoofing (伪装 servername) 与 Chrome BoringSSL 冲突，会导致 SSL 握手失败。

## License

MIT
