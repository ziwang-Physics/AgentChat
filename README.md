# AgentChat — Gemini Web Automation

Chrome CDP + Playwright 驱动的 Gemini Web 自动化交互系统。

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
