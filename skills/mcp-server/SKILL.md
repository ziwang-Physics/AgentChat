# AgentChat MCP Server

> **最后更新**: 2026-07-06
> **核心原则**: 将 AgentChat 的 8 个 AI Provider 暴露为 MCP 工具，任何 MCP 兼容客户端可直接调用
> **Provider 层**: `AgentChat-OneWeb`（单源真相）
> **安全策略**: 永不关闭用户 Chrome

## 是什么

MCP（Model Context Protocol）Server 包装层。让 Claude Desktop、Cursor、Continue.dev 等 MCP 客户端直接发现并调用 AgentChat 的 AI Provider 降级链。

## 架构

```
Claude Desktop / Cursor / 任何 MCP 客户端
    │
    │  MCP Protocol (stdio JSON-RPC)
    ▼
AgentChat MCP Server (本 skill, ~200 行)
    │
    │  child_process.spawn('node', ['AgentChat-OneWeb/index.js', ...])
    ▼
AgentChat-OneWeb (8 个 Provider)
    │
    │  playwright-core → Chrome CDP port 9222
    ▼
Chrome → Gemini / ChatGPT / Claude / Qwen / Kimi / MiniMax / MiMo / DeepSeek
```

## 提供的工具

| 工具 | 功能 | 参数 |
|------|------|------|
| `gemini_think` | Pro Extended Thinking 深度推理 | `prompt` (必需), `timeout_ms` (可选) |
| `gemini_chat` | 多轮对话（复用 tab，保留上下文） | `prompt` (必需) |
| `web_ask` | 通过降级链调用任意 Provider | `prompt` (必需), `provider` (可选), `timeout_ms` (可选) |
| `web_smoke` | 检查 8 个 Provider 可达性 | 无参数 |

## 配置方式

### Claude Desktop

```json
// claude_desktop_config.json
{
  "mcpServers": {
    "agentchat": {
      "command": "node",
      "args": ["path/to/AgentChat/skills/mcp-server/index.mjs"]
    }
  }
}
```

### Cursor / Continue.dev

```json
{
  "mcpServers": {
    "agentchat": {
      "command": "node",
      "args": ["skills/mcp-server/index.mjs"],
      "cwd": "path/to/AgentChat"
    }
  }
}
```

## 前提条件

- Chrome CDP 必须在 9222 端口运行
- 至少一个 Provider 已在 Chrome 中登录
- Node.js >= 18

## 依赖

| 依赖 | 说明 |
|------|------|
| `@modelcontextprotocol/sdk` | MCP 协议实现 |
| `AgentChat-OneWeb` | Provider 实现（同一仓库内） |
