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
  demo/webextended.html               # 🔗 降级链交互 · 会话模式自动传递上下文
  demo/freesubagent.html              # ⚡ 并行编排交互 · 4 Worker 并发分析
  demo/workflow.html                  # 🔄 串行管道交互 · 搜索→推理→审查
  demo/mcp.html                       # 🔌 MCP Server 文档 + CDP 实时状态
  demo/python.html                    # 🐍 Python SDK API 文档 + 代码示例
  demo/locales.html                   # 🌐 4 语言对照表 + 技术细节
  demo/shared.css                     # 统一深色主题 (73 行)
  scripts/demo_server.js              # HTTP 服务器 · 零外部依赖 · CDP 自动启动
  scripts/lib/session_context.js      # 🆕 会话上下文管理器 · 降级时传递对话历史
  DEMO.md                             # 30 秒启动指南 + 演示要点
  DEMO_PITFALLS.md                    # 12 个踩坑与解决方案
```

13 个新文件。

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

## 🆕 多轮对话上下文传递

### 解决的痛点

```
用户第1轮 → Gemini ✅ "帮我分析A股"
用户第2轮 → Gemini ❌ (配额/错误) → ChatGPT
           ChatGPT 只看到"这些板块哪些最值得关注？"
           没有第1轮的上下文 → 答非所问
```

**修复后**：降级时自动将历史对话注入 fallback 的 prompt 开头，AI 能基于完整上下文续答。

### 架构

```
┌─ scripts/lib/session_context.js (180行) ──────────────────┐
│                                                             │
│  短对话 (<4轮): 完整 Q&A 注入 fallback prompt               │
│  长对话 (≥4轮): Kimi 生成摘要 → 存 .json → fallback 注入    │
│                 "摘要 + 最近 2 轮"                          │
│                                                             │
│  存储: ~/.agentchat/sessions/{sessionId}.json               │
│  缓存: 内存 Map + 文件双持久化                               │
└─────────────────────────────────────────────────────────────┘
```

### 使用方式

**前端**（降级链页面自动开启）：

页面加载时自动生成 `sessionId`，每轮请求携带。降级成功时 UI 显示「已传递 N 轮对话历史」。点击「新建」按钮重置会话。

**API**：

```json
POST /api/ask
{
  "prompt": "哪些板块最值得关注？",
  "provider": "gemini",
  "sessionId": "sess_abc123"   // ← 新增可选字段
}
```

**新增端点**：

| 方法 | 路径 | 功能 |
|------|------|------|
| `GET` | `/api/sessions` | 列出所有会话（ID / 轮数 / 是否有摘要） |
| `DELETE` | `/api/sessions/:id` | 清除指定会话 |

### 工具函数 (`scripts/lib/session_context.js`)

```js
getContext(sessionId)        // → "[背景: 第1轮 Q&A]\n\n当前问题: ..."
addTurn(sessionId, Q, A)     // 保存一轮对话
generateSummary(sessionId)   // 异步生成摘要（调用 Kimi）
clearSession(sessionId)      // 清除会话
```

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

---

## 🛠️ 开发中踩过的坑（12 个）

> 详见 [DEMO_PITFALLS.md](DEMO_PITFALLS.md)，下方为摘要。

| # | 问题 | 根因 | 修复 |
|---|------|------|------|
| 1 | 中文响应变乱码 | HTTP `Content-Type` 缺 `charset=utf-8` → 客户端用 Latin-1 解码 | 全局添加 `charset=utf-8` |
| 2 | 中文 prompt 变问号 | `stdin` 管道经 Windows cmd 层被 GBK 干扰 | 改为 CLI 参数传 prompt |
| 3 | Gemini 总被跳过 | smoke check 残留 8 个 AI tab → 后续请求全 `tab_already_open` | 每次请求前 `closeOldProviderTabs()` |
| 4 | 冷启动找不到模型按钮 | `isVisible({ timeout:400 })` < Angular Shadow DOM 2-3s 渲染 | 升到 4000ms(L1)/2500ms(L2) |
| 5 | Pro Extended 验证失败 | `modelVerify: 'Pro扩展'` 不匹配实际 `"Pro 扩展"` (有空格) | 改为 `/Pro\s*扩展/` |
| 6 | Pro 模式发送按钮无效 | Angular 重渲染后 zone.js 事件绑定有异步窗口期，6 种点击方案全失效 | `AGENTCHAT_SKIP_MODEL_SWITCH=1` 跳过模型切换 |
| 7 | Chrome 拒绝 CDP | 不能在系统 `User Data` 目录启用远程调试 | 回退 `.chrome-debug-profile` |
| 8 | Chrome 启动后秒退 | Windows 关闭最后一个 tab → 进程退出，而 macOS 不会 | 保留 `about:blank` 暖 tab |
| 9 | 标签页来回重启 | 页面每 30s `setInterval` 调 `/api/smoke` (开 8 个 tab) | 去掉轮询，只在加载时检查 |
| 10 | API 500 但页面显示成功 | 只检查 HTTP 200，没读 `d.success` 字段 | 加 `d.success !== false` 判断 |
| 11 | EADDRINUSE 端口占用 | 上次 node 进程未正确终止 | `server.on('error')` 自动 netstat→kill→重试 |
| 12 | 模板 prompt 被截断 | `replace(/[^。]*。$/,'')` 正则删除中文句末逻辑错误 | 改为追加而非替换 |
