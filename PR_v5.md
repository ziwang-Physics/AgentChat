# PR v5: 可视化演示平台 — 9 页面 · 10 API · 零依赖

> 向 [ziwang-Physics/AgentChat](https://github.com/ziwang-Physics/AgentChat) 提交

---

## 概述

AgentChat 的功能很强，但展示方式只有 CLI 输出。本 PR 新增一个**零安装、浏览器打开就能交互演示**的可视化平台。

一条命令启动，Chrome CDP 自动管理：

```powershell
node scripts/demo_server.js
# 浏览器打开 http://localhost:3456
```

---

## 改动清单

```
新增:
  demo/index.html                     # 导航首页 · 6 技能卡片 + 统计数据
  demo/architecture.html              # 4 层架构全景图 + 数据流 + 贡献时间线
  demo/webextended.html               # 🔗 降级链交互 · 选 Provider → 实时回复
  demo/freesubagent.html              # ⚡ 并行编排交互 · 4 Worker 并发分析
  demo/workflow.html                  # 🔄 串行管道交互 · 搜索→推理→审查
  demo/mcp.html                       # 🔌 MCP Server 文档 + CDP 实时状态
  demo/python.html                    # 🐍 Python SDK API 文档 + 代码示例
  demo/locales.html                   # 🌐 4 语言对照表 + 技术细节
  demo/shared.css                     # 统一深色主题 (73 行)
  scripts/demo_server.js              # HTTP 服务器 · 零外部依赖 · CDP 自动启动 (570 行)
  DEMO.md                             # 30 秒启动指南 + 演示要点
```

11 个新文件，约 2,200 行净增。零新依赖（仅 Node.js 内置 http/fs/path/child_process）。向后兼容。

---

## 功能详情

### 10 个 API 端点

| 方法 | 路径 | 功能 | 调用的 Skill |
|------|------|------|------------|
| `GET` | `/api/health` | CDP 连接状态 | — |
| `GET` | `/api/smoke` | 8 Provider 可达性检查 | `AgentChat-OneWeb --smoke` |
| `GET` | `/api/stats` | 服务器运行统计 | — |
| `POST` | `/api/ask` | 单 Provider 问答 | `AgentChat-OneWeb --from=X` |
| `POST` | `/api/parallel` | 4 Worker 并行编排 | `AgentChat-OneWeb` ×4 |
| `POST` | `/api/search-web` | Kimi 联网搜索 | `AgentChat-OneWeb --from=kimi` |
| `POST` | `/api/deep-reason` | Gemini 深度推理 | `AgentChat-OneWeb --from=gemini` |
| `POST` | `/api/review` | ChatGPT 交叉审查 | `AgentChat-OneWeb --from=chatgpt` |
| `POST` | `/api/verify` | Qwen 事实核查 | `AgentChat-OneWeb --from=qwen` |

### 9 个前端页面

| 页面 | 类型 | 功能 |
|------|------|------|
| `index.html` | 静态导航 | 6 技能卡片 + 8/6/4/2 统计 |
| `architecture.html` | 静态文档 | 4 层架构 + 数据流 + 时间线 |
| `webextended.html` | **交互式** | 选 Provider → 发送 → 回复 + 降级链 |
| `freesubagent.html` | **交互式** | 预设模板/自定义主题 → 4 Worker 并行 |
| `workflow.html` | **交互式** | 搜索 → 推理 → 审查 串行管道 |
| `mcp.html` | 文档+状态 | 4 MCP 工具 + Claude Desktop 配置 |
| `python.html` | 文档 | Python SDK API 完整文档 |
| `locales.html` | 文档 | 4 语言对照表 + RegExp 传递细节 |

### 关键设计决策

**1. 零外部依赖** — 用 Node.js 内置 `http` 模块而非 Express，`git clone` 后立即运行。

**2. CDP 自动启动** — 检测 CDP 不在线 → `spawn('chrome.exe', ...)` → 轮询 `/json/version` → 就绪。用户不需要手动启动 Chrome。

**3. prompt 通过 CLI 参数传递** — 不通过 stdin。原因是 MINGW64 bash 环境下 `child.stdin.write(中文)` 会出现 UTF-8 → GBK 编码破坏。`args.push(prompt)` → AgentChat-OneWeb 通过 `remaining.join(' ')` 读取，不受终端编码影响。

**4. smoke 后清理 AI 网站 tab** — `callSmoke()` 打开 8 个 Provider tab 查可达性。如果没有清理，后续 `/api/ask` 检测到 `tab_already_open` 会跳过全部 Provider。每次请求前通过 CDP `/json/close/{id}` 关闭残留 AI tab，但保留 `about:blank`（Chrome 需要一个暖 tab 防止进程退出）。

**5. 端口占用自动恢复** — `server.on('error', ...)` 检测 `EADDRINUSE` → `netstat` 找 PID → `kill` → 重试。

### 编码问题修复

测试过程中发现并修复了 3 个中文编码 bug：

| # | 问题 | 修复 |
|---|------|------|
| HTTP body `+=` 拼接 | UTF-8 多字节字符跨 TCP 分片被截断 | `Buffer.concat(chunks).toString('utf8')` |
| `Content-Type: application/json` | 缺少 charset → 客户端 Latin-1 解码 | 全局添加 `charset=utf-8` |
| `child.stdin.write(prompt)` | Windows 下编码不确定 | 改为 CLI 参数传递 |

---

## 验证方式

```powershell
# 1. 启动
node scripts/demo_server.js

# 2. 验证 API
curl http://localhost:3456/api/health     # → {"cdp":"online","port":9222,"server":"running"}
curl http://localhost:3456/api/smoke       # → 8/8 Provider 可达性
curl -X POST http://localhost:3456/api/ask -H "Content-Type: application/json" \
  -d '{"prompt":"用一句话回答：中国的首都是哪里？","provider":"chatgpt"}'
# → {"response":"中国的首都是北京。","provider":"ChatGPT","success":true}

# 3. 浏览器打开 http://localhost:3456/webextended.html
#    选 Provider → 发送 → 查看实时回复与降级链
```

---

## 与已有 PR 的关系

| PR | 内容 | 状态 |
|----|------|------|
| PR #2 | Windows + zh-CN + 三级降级 | ✅ 已合并 |
| PR #4 | Locales + Python SDK + MCP Server | ✅ 已合并 |
| **PR #5** | **可视化演示平台** | 本次提交 |

本 PR 独立于 #2 和 #4，可单独合并，无依赖冲突。
