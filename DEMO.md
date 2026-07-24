# AgentChat 可视化演示指南

## 30 秒启动

```powershell
# 一条命令 — Chrome CDP 自动启动，无需手动管理
node scripts/demo_server.js
```

浏览器打开 **http://localhost:3456**，即可访问完整的演示平台。

---

## 演示平台全景

```
http://localhost:3456/
├── 🏠 首页              — 6 个 Skill 的卡片导航 + 实时 CDP 状态
├── 📐 架构全景           — 4 层技术栈 + 数据流图 + 贡献时间线
├── 🔗 降级链 (交互)     — 点击 8 个 Provider → 输入问题 → 实时回复
├── ⚡ 并行编排 (交互)   — 预设模板 + 自定义主题 → 4 Worker 并行分析
├── 🔄 串行管道 (交互)   — 输入主题 → Kimi搜索→Gemini推理→ChatGPT审查
├── 🔌 MCP Server        — 4 工具展示 + Claude Desktop 配置指南
├── 🐍 Python SDK        — 完整 API 表格 + 代码示例
└── 🌐 多语言             — 4 语言对照表 + 技术细节
```

---

## 各页面交互功能

| 页面 | 交互功能 | API |
|------|---------|-----|
| **降级链** | 选 Provider → 输入问题 → 发送 → 查看回复与降级链 | `POST /api/ask` |
| **并行编排** | 选模板 + 自定义主题 → 4 个 AI 分别执行不同维度分析 | `POST /api/ask` ×4 |
| **串行管道** | 输入主题 → 自动跑 Kimi搜索→Gemini推理→ChatGPT审查 | `POST /api/ask` ×3 |
| **MCP Server** | 实时显示 CDP 连接状态 | `GET /api/health` |

---

## 可用 API

| 方法 | 路径 | 功能 |
|------|------|------|
| `POST` | `/api/ask` | 单 Provider 问答 `{prompt, provider}` |
| `POST` | `/api/parallel` | 4 Worker 并行编排 `{tasks: [{id,role,prompt,provider}]}` |
| `POST` | `/api/search-web` | Kimi 联网搜索 `{query}` |
| `POST` | `/api/deep-reason` | Gemini 深度推理 `{prompt, context?}` |
| `POST` | `/api/review` | ChatGPT 交叉审查 `{content}` |
| `POST` | `/api/verify` | Qwen 事实核查 `{content}` |
| `GET` | `/api/smoke` | Provider 可达性检查 |
| `GET` | `/api/health` | CDP 健康检查 |
| `GET` | `/api/stats` | 服务器统计 |

---

## 环境要求

| 项目 | 最低要求 |
|------|---------|
| Node.js | >= 18 |
| Chrome | 最新稳定版 |
| 磁盘 | 200MB |
| 网络 | 可访问 gemini.google.com |
| Google 账号 | 推荐 Gemini Pro 订阅 |

## 给面试官的讲解要点

1. **开场**："这是一个通过 Chrome CDP 驱动 8 个 AI 服务的自动化平台，点击任意 Provider 就能实时调用。"
2. **降级链**：发送一个问题，展示 Gemini Pro Extended → ChatGPT 的自动降级。
3. **并行编排**：用预设模板跑一次 4 Worker 并行分析，展示不同 AI 的互补角色。
4. **串行管道**：输入一个研究主题，展示 Kimi 搜→Gemini 推理→ChatGPT 审查的完整链路。
5. **收尾**：打开 Python SDK 页面，展示 `from agentchat import GeminiSession` 的代码示例。
