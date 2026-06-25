# AgentChat — Gemini Web Automation

Chrome CDP + Playwright 驱动的 Gemini Web 自动化交互系统。

## 目录结构

```
skills/
  gemini-web-extended-thinking/   ← Gemini Web Extended Thinking skill
  five-agent-gemini-cli/          ← GemiNode Swarm 5-Agent 架构
scripts/
  start-chrome-debug.sh           ← Chrome daemon 启动 (idempotent)
  start-chrome-debug.py           ← Playwright daemon (Chrome 生命周期)
  connect-gemini.sh               ← 一键连接 Gemini
```

## 关键更新 (2026-06-25)

经过 8 小时深度诊断，确认并修复了 Chrome 在中国网络环境下无法导航的根因：
**3 层级联故障 (SSL → 安全组件 → fail-safe 阻断)**

详见 `skills/gemini-web-extended-thinking/SKILL.md` 中的 "Chrome 启动架构" 章节。
