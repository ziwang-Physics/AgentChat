# Platform Maturity Reference

Last DOM probe: 2026-06-27.

| Platform | Status | DOM Injection | Extraction | Pipeline Role |
|----------|--------|---------------|------------|---------------|
| **Gemini** | ⭐⭐⭐⭐⭐ | ✅ insertText | ✅ model-message | P4 终审裁决 |
| **ChatGPT** | ⭐⭐⭐⭐ | ✅ insertText | ✅ assistant role | P2 代码效率专家 |
| **DeepSeek** | — | — | — | P1+P3 via Claude Code (no web) |
| **Kimi** | ⭐⭐⭐ | ✅ insertText | ✅ chat-content-item | P2 文献基准专家 |
| **Qianwen** | ⭐⭐⭐ | ✅ insertText | ✅ [class*=message] | P2 安全审计专家 |
| **Claude** | ⭐⭐⭐ | ✅ insertText | ⚠️ fallback | P2 防御架构 (free tier rate-limit) |
| ~~Doubao~~ | 🚫 | — | — | Deprecated 2026-06-27 |

## Adapter Details

| Adapter | File | Key Features |
|---------|------|--------------|
| GeminiAdapter | `adapters/gemini.py` | Pro Extended switch, fresh-conversation detection |
| ChatGPTAdapter | `adapters/chatgpt.py` | data-testid selectors, assistant message extraction |
| ClaudeAdapter | `adapters/claude.py` | ProseMirror editor, free-tier rate-limit patterns |
| KimiAdapter | `adapters/kimi.py` | chat-content-item messages, React SPA |
| QianwenAdapter | `adapters/qianwen.py` | [class*=message] containers, "Qwen3.7-Max" prefix |
| DeepSeekAdapter | `adapters/deepseek.py` | Expert mode + Deep Think toggles |
| DoubaoAdapter | `adapters/_deprecated.py` | CSS-module hashed classes, manual opt-in only |
