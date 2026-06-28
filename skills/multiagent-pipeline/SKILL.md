# MultiAgent: 4-Phase Expert Pipeline with Gemini Final Adjudication

> **最后更新**: 2026-06-28 — P0 安全审计修订 (CDP token, 竞态修复, 文档工程化)
> **模型**: Claude Code (powered by DeepSeek LLM, local inference — no web browser needed for P1/P3)

## Prerequisites

| Dependency | Minimum Version | Check Command |
|-----------|----------------|---------------|
| Python | ≥ 3.10 | `python3 --version` |
| Playwright | ≥ 1.45 | `python3 -m playwright --version` |
| Chromium | ≥ 125 (for CDP token) | `chromium --version` |
| Chrome Debug Profile | `~/.chrome-debug-profile/` | `ls ~/.chrome-debug-profile/.cdp_token` |
| CHROME_CDP_TOKEN | auto-generated on Chrome start | `cat ~/.chrome-debug-profile/.cdp_token` |

**First-time setup**: `python3 -m playwright install chromium`

---

## Trigger

### Activate this skill when:

**Explicit triggers** (user mentions any of these):
- "问所有 AI" / "同时问 X 个平台" / "多平台对比" / "多AI"
- "综合所有回答" / "多角度分析" / "cross-reference with other AIs"
- "ask all AIs" / "compare platforms" / "multi-model" / "multi-agent"
- "/multiagent" slash command

**Implicit triggers** (auto-activate when the question matches these patterns):
- Complex reasoning with competing valid approaches (architecture trade-offs, method selection)
- Questions where different AI platforms are known to give materially different answers
- Research strategy / paper publication strategy questions (multi-angle expert analysis needed)
- System design questions with security + performance + correctness trade-offs

### Do NOT trigger for:
- Simple factual lookup (e.g., "what is the capital of France")
- Single-sentence answers ("一句话说说量子点")
- Code syntax questions with one correct answer
- Questions answerable by reading a single file or config

### Priority rule:
- This skill has priority over single-model QA skills when the question matches implicit triggers
- If another skill already handles the request type (e.g., HPC cluster operations), do NOT override

---

## Architecture

```
User Question
     │
     ▼
🟢 Phase 1: Claude Code (powered by DeepSeek LLM) — DIRECT REASONING
   Analyzes request → generates 4 specialized prompts (JSON)
   Roles: chatgpt(代码效率), claude(防御架构), kimi(文献基准), qianwen(安全审计)
   Output: $WORKDIR/prompts.json  (WORKDIR = mktemp -d)
   ⚡ No browser — instant
     │
     ▼
🟡 Phase 2: 4 Expert Nodes — CONCURRENT (Playwright → Chrome tabs)
   $ python3 orchestrator.py phase2 --file $WORKDIR/prompts.json --json
   ┌──────────┬──────────┬──────────┬──────────┐
   │ ChatGPT  │ Claude   │ Kimi     │ Qianwen  │
   │ 代码效率  │ 防御架构  │ 文献基准  │ 安全审计  │
   └──────────┴──────────┴──────────┴──────────┘
   Hard timeout: 60s per platform. asyncio.Condition Barrier sync.
   🌐 Browser required — ~2 min
     │
     ▼
🟠 Phase 3: Claude Code (powered by DeepSeek LLM) — DIRECT REASONING
   Reads Phase 2 results → compresses into structured matrix.
   MUST contain these EXACT H2 headings:
     ## 共识区 | Consensus  — all-agreed points, cite sources per item
     ## 特色区 | Features   — unique contributions, cite platform per item
     ## 冲突区 | Conflicts  — disagreements, cite BOTH sides per item
   Output: $WORKDIR/matrix.md
   ⚡ No browser — instant
     │
     ▼
🔴 Phase 4: Gemini 3.1 Pro Web — Playwright → Chrome tab
   $ python3 orchestrator.py phase4 --file $WORKDIR/matrix.md --task-core "SUMMARY"
   Extended Thinking → final judgment:
     - 综合结论 / 争议裁决 / 缝合方案 / 可信度评估
   🌐 Browser required — ~3-5 min
     │
     ▼
   Final Output (presented by Claude to user)
```

**Design principle**: Claude Code runs the pipeline. P1 + P3 are direct LLM reasoning (no browser). P2 (4 web platforms) + P4 (Gemini web) use Playwright CDP browser automation via `orchestrator.py`.

---

## Grand Orchestrator Workflow (MANDATORY)

When `/multiagent` is invoked, Claude MUST execute this sequence.

**Pre-flight check** (run before any phase):
```bash
# Verify Chrome is running with CDP token
test -f ~/.chrome-debug-profile/.cdp_token || { echo "ERROR: Chrome CDP token not found. Run: bash ~/connect-gemini.sh"; exit 1; }
export CHROME_CDP_TOKEN=$(cat ~/.chrome-debug-profile/.cdp_token)
# Check disk space on /tmp (need >= 10MB)
test $(df -m /tmp | awk 'NR==2{print $4}') -ge 10 || { echo "ERROR: /tmp disk full"; exit 1; }
```

### Step 1: Decompose (Claude Code — no browser)

Analyze the user's request. Generate 4 specialized prompts, one per expert angle.
Create a session-specific working directory:

```bash
export WORKDIR=$(mktemp -d -t multiagent-XXXXXX)
chmod 700 "$WORKDIR"
```

Write prompts JSON. Required schema:

```json
{
  "task_core": "one-sentence summary (max 120 chars)",
  "worker_prompts": {
    "chatgpt": "从代码效率、算法优化、性能最佳实践角度回答...",
    "claude": "从防御性架构、错误处理、边界条件角度回答...",
    "kimi": "从学术文献、技术标准、基准测试角度回答...",
    "qianwen": "从安全审计、漏洞分析、竞态条件角度回答..."
  }
}
```

Write to `$WORKDIR/prompts.json`.

### Step 2: Dispatch (browser automation)

```bash
python3 ~/.claude/skills/multiagent/orchestrator.py phase2 \
  --file "$WORKDIR/prompts.json" --timeout 60 --json > "$WORKDIR/p2_results.json"
```

**Output schema** (`p2_results.json`):
```json
{
  "success": true,
  "success_count": 3,
  "timeout_count": 0,
  "results": [
    {
      "platform": "chatgpt",
      "success": true,
      "response": "<cleaned answer text>",
      "length": 1234,
      "timeout": false,
      "quality": "OK"
    }
  ]
}
```

### Step 3: Compress (Claude Code — no browser)

Read `$WORKDIR/p2_results.json`. Extract `results[].response` for each successful platform.
Produce a matrix with these **mandatory** H2 sections (exact headings required):

```markdown
## 共识区 | Consensus
- [ChatGPT][Kimi] 所有平台一致同意的观点...
- 每条必须标注来源平台

## 特色区 | Features
- [ChatGPT] 某平台独有的贡献...
- 标注具体来源

## 冲突区 | Conflicts
- [ChatGPT] 观点A vs [Qianwen] 观点B
- 清晰呈现双方立场
```

Write to `$WORKDIR/matrix.md`.

### Step 4: Adjudicate (browser automation)

```bash
python3 ~/.claude/skills/multiagent/orchestrator.py phase4 \
  --file "$WORKDIR/matrix.md" --task-core "$(python3 -c "import json; print(json.load(open('$WORKDIR/prompts.json'))['task_core'])")"
```

> **Security note**: All dynamic parameters use `--flag` form, never bare positional args.
> The `task_core` value comes from the Phase 1 JSON, not raw user input.

### Step 5: Present + Cleanup

Read Gemini's final output. Present to user. Optionally add meta-commentary about which platform contributed what.

```bash
rm -rf "$WORKDIR"  # clean up session temp files
```

---

## Phase 2 Output Schema Reference

For programmatic consumers of `p2_results.json`:

| Field | Type | Description |
|-------|------|-------------|
| `results[].platform` | string | "chatgpt" / "claude" / "kimi" / "qianwen" |
| `results[].success` | bool | true if response passes validation |
| `results[].response` | string | cleaned answer text (always present, even if !success) |
| `results[].length` | int | character count |
| `results[].timeout` | bool | true if hard timeout triggered |
| `results[].quality` | string | "OK" / "UI_CHROME_DOMINANT" / "ERROR_PATTERN_DETECTED" / "FATAL" |

---

## Degradation Chain

| Phase | Failure | Fallback |
|-------|---------|----------|
| Pre-flight | Chrome not running / token missing | Run `bash ~/connect-gemini.sh`, retry once |
| Pre-flight | /tmp disk < 10MB | Alert user, suggest `export TMPDIR=/var/tmp` |
| P1 | — | Claude generates default angle-prefixed prompts |
| P2 | 1+ platform timeout | Partial text extraction, prefix `[WARNING: NODE_TIMEOUT_TRUNCATED]`, continue |
| P2 | 1+ platform crash/exception | `barrier.abort()` releases waiters, continue with remaining |
| P2 | ALL 4 fail | Report to user: "All 4 expert nodes failed. Check network/proxy. Retry? (y/n)" |
| P3 | — | Claude can still reason over partial P2 results |
| P4 | Gemini unreachable / timeout | Present Phase 3 matrix directly as final output, note degradation |
| P4 | Pro Extended switch fails | Proceed with default Gemini mode, log warning |

---

## Quick Reference (non-normative — for human reference only)

```bash
# Phase 2: dispatch 4 prompts concurrently
python3 orchestrator.py phase2 --file "$WORKDIR/prompts.json" --timeout 45 --json

# Phase 4: Gemini adjudication
python3 orchestrator.py phase4 --file "$WORKDIR/matrix.md" --task-core "summary"
```

---

## File Structure

```
~/.claude/skills/multiagent/
├── SKILL.md           # This file (Claude-as-Orchestrator workflow)
├── orchestrator.py    # Phase 2 + Phase 4 browser automation
├── main.py            # Original flat 7-platform controller (backward compat)
├── adapters.py        # BaseAdapter + 7 concrete adapters (CDP token secured)
└── requirements.txt   # playwright>=1.45
```

---

## Platform Maturity (Reference only — not required for execution)

| Platform | Status | DOM Injection | Extraction | Pipeline Role |
|----------|--------|---------------|------------|---------------|
| **Gemini** | ⭐⭐⭐⭐⭐ | ✅ insertText | ✅ model-message | P4 终审裁决 |
| **ChatGPT** | ⭐⭐⭐⭐ | ✅ insertText | ✅ assistant role | P2 代码效率专家 |
| **DeepSeek** | — | — | — | P1+P3 via Claude Code (no web) |
| **Kimi** | ⭐⭐⭐ | ✅ insertText | ✅ chat-content-item | P2 文献基准专家 |
| **Qianwen** | ⭐⭐⭐ | ✅ insertText | ✅ [class*=message] | P2 安全审计专家 |
| **Claude** | ⭐⭐⭐ | ✅ insertText | ⚠️ fallback | P2 防御架构 (free tier rate-limit) |
| ~~Doubao~~ | 🚫 | — | — | Deprecated 2026-06-27 |
