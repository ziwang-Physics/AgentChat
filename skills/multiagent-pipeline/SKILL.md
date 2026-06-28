# MultiAgent: 4-Phase Expert Pipeline with Gemini Final Adjudication

> **最后更新**: 2026-06-28 — 自优化 (common.py 去重, 竞态修复, adapters/ 模块化)
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
🟡 Phase 2: 4 Expert Nodes — CONCURRENT FIRE-AND-COLLECT (Playwright → Chrome tabs)
   $ python3 orchestrator.py phase2 --file $WORKDIR/prompts.json --json
   ┌──────────┬──────────┬──────────┬──────────┐
   │ ChatGPT  │ Claude   │ Kimi     │ Qianwen  │
   │ 代码效率  │ 防御架构  │ 文献基准  │ 安全审计  │
   └──────────┴──────────┴──────────┴──────────┘
   P1: fire-and-collect — each worker fires independently, no Barrier sync.
   Hard timeout: 60s per platform. asyncio.wait() convergence.
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

---

## Grand Orchestrator Workflow (MANDATORY)

### Pre-flight check:
```bash
# 1. CDP token must exist
test -f ~/.chrome-debug-profile/.cdp_token || { echo "ERROR: Chrome CDP token not found. Run: bash ~/connect-gemini.sh"; exit 1; }
export CHROME_CDP_TOKEN=$(cat ~/.chrome-debug-profile/.cdp_token)
# 2. Token file permissions must be 0600
test "$(stat -c %a ~/.chrome-debug-profile/.cdp_token)" = "600" || chmod 600 ~/.chrome-debug-profile/.cdp_token
# 3. CDP must bind to localhost only (P1: DNS rebinding hardened check)
python3 -c "from common import verify_cdp_safe; ok, msg = verify_cdp_safe(); print(msg); exit(0 if ok else 1)" || { echo "ERROR: CDP unsafe — must bind 127.0.0.0/8 only"; exit 1; }
# 4. /tmp disk space >= 10MB
test $(df -m /tmp | awk 'NR==2{print $4}') -ge 10 || { echo "ERROR: /tmp disk full"; exit 1; }
```

### Step 1: Decompose (Claude Code — no browser)

Analyze the request. Generate 4 prompts using the **Sandwich Prompt Structure** (三明治结构):

```
Layer 1 — Core Question (完全同化, ~30%):  所有平台一字不差的核心问题
Layer 2 — Primary Lens  (特性锐度, ~50%):  各平台独特视角, 最重的分析权重
Layer 3 — Cross-Coverage (交叉补位, ~20%): 简要覆盖其他 3 个平台的视角, 确保单点故障不丢视角
```

**Rationale**: Web Claude 频繁免费额度耗尽, 单一视角 prompt 导致该维度完全丢失。
Cross-coverage 使每个 AI 的回答包含 60% 主视角 + 40% 补位视角, 任一平台故障时其他 3 家合起来能覆盖 ≥80% 的缺失维度。

**Sandwich Prompt Template:**

```json
{
  "task_core": "one-sentence summary (max 120 chars)",
  "worker_prompts": {
    "chatgpt": "【核心问题】<完全相同的 question> 【你的主视角：代码效率与算法优化】请重点从计算复杂度、IO 瓶颈、并发效率、缓存策略角度深入分析——这是你最擅长的维度。 【交叉补位】也请简要从防御架构(1句)、文献基准(1句)、安全审计(1句)角度补充, 确保回答的维度完整性。",
    "claude": "【核心问题】<完全相同的 question> 【你的主视角：防御性架构与错误处理】请重点从降级链完整性、边界条件覆盖、状态一致性、故障恢复角度深入分析——这是你最擅长的维度。 【交叉补位】也请简要从代码效率(1句)、文献基准(1句)、安全审计(1句)角度补充, 确保回答的维度完整性。",
    "kimi": "【核心问题】<完全相同的 question> 【你的主视角：学术文献与基准测试】请重点从 SOTA 文献支撑、LLM-as-Judge 基准、多 Agent 编排标准角度深入分析, 引用具体文献或框架——这是你最擅长的维度。 【交叉补位】也请简要从代码效率(1句)、防御架构(1句)、安全审计(1句)角度补充, 确保回答的维度完整性。",
    "qianwen": "【核心问题】<完全相同的 question> 【你的主视角：安全审计与漏洞分析】请重点从注入攻击面、竞态条件、权限最小化、审计追溯完整性角度深入分析——这是你最擅长的维度。 【交叉补位】也请简要从代码效率(1句)、防御架构(1句)、文献基准(1句)角度补充, 确保回答的维度完整性。"
  }
}
```

**Replacement rules for `<完全相同的 question>`:**
- Insert the user's actual question verbatim, NOT a rephrased version
- If the question is long (>200 chars), use the `task_core` summary instead
- The question block is identical across all 4 platforms — no variation

**Cross-Coverage weight rule:**
- Each cross-coverage item is 1 sentence max
- Total cross-coverage ≤ 40% of total response attention
- If the AI ignores cross-coverage entirely, the primary lens answer alone is still valuable

Write to `$WORKDIR/prompts.json`.

### Step 2: Dispatch (browser automation)
```bash
python3 ~/.claude/skills/multiagent/orchestrator.py phase2 \
  --file "$WORKDIR/prompts.json" --timeout 60 --json > "$WORKDIR/p2_results.json"
```

### Step 3: Compress (Claude Code — no browser)
Read `$WORKDIR/p2_results.json`. Produce matrix with **共识区/特色区/冲突区** H2 sections. Write to `$WORKDIR/matrix.md`.

### Step 4: Adjudicate (browser automation)

> **P0 fix (2026-06-28)**: task_core is now auto-extracted from the prompts JSON
> via `--prompts-file` — no shell command substitution. Eliminates RCE vector.

```bash
python3 ~/.claude/skills/multiagent/orchestrator.py phase4 \
  --file "$WORKDIR/matrix.md" \
  --prompts-file "$WORKDIR/prompts.json"
```

### Step 5: Present + Cleanup
Read Gemini's output. Present to user. Run `rm -rf "$WORKDIR"`.

---

## Degradation Chain

| Phase | Failure | Fallback |
|-------|---------|----------|
| Pre-flight | Chrome not running / token missing | Run `bash ~/connect-gemini.sh`, retry once |
| Pre-flight | /tmp disk < 10MB | Alert user, suggest `export TMPDIR=/var/tmp` |
| P1 | — | Claude generates default angle-prefixed prompts |
| P2 | 1+ platform timeout | Partial text extraction, `[WARNING: NODE_TIMEOUT_TRUNCATED]` prefix, continue |
| P2 | 1+ platform crash/exception | `barrier.abort()` releases waiters, continue with remaining |
| P2 | ALL 4 fail | Report to user: "All 4 expert nodes failed. Check network/proxy. Retry? (y/n)" |
| P3 | — | Claude can still reason over partial P2 results |
| P4 | Gemini unreachable / timeout | Present Phase 3 matrix directly as final output, note degradation |
| P4 | Pro Extended switch fails | Proceed with default Gemini mode, log warning |

---

## File Structure

```
~/.claude/skills/multiagent/
├── SKILL.md                  # This file (workflow)
├── common.py                 # Shared: cdp_url(), AbortableBarrier, setup_logging()
├── orchestrator.py           # Phase 2 + Phase 4 browser automation
├── main.py                   # Standalone 7-platform controller (backward compat)
├── adapters.py.bak           # Pre-optimization monolithic file (kept for reference)
├── requirements.txt          # playwright>=1.45
├── adapters/                 # Per-platform adapter package
│   ├── __init__.py           # Registry + exports
│   ├── base.py               # BaseAdapter (connect/inject/extract/validate)
│   ├── gemini.py             # GeminiAdapter (P4 adjudicator)
│   ├── chatgpt.py            # ChatGPTAdapter (P2 code expert)
│   ├── claude.py             # ClaudeAdapter (P2 architecture expert)
│   ├── kimi.py               # KimiAdapter (P2 literature expert)
│   ├── qianwen.py            # QianwenAdapter (P2 security expert)
│   ├── deepseek.py           # DeepSeekAdapter (Expert + Deep Think)
│   └── _deprecated.py        # DoubaoAdapter (manual opt-in only)
└── reference/
    └── platform-maturity.md  # Platform maturity levels + adapter details
```

## P0 Fixes Applied (2026-06-28)

1. **Barrier.abort() 竞态条件**: `abort()` 改为 async，内部持有 `Condition` 锁后设标志 + `notify_all()`
2. **CDP token 三处重复去重**: 统一到 `common.cdp_url()`
3. **main.py Barrier 升级**: 使用 `AbortableBarrier` (带 timeout + abort)
4. **adapters.py 模块化**: 33KB 拆分为 8 个 per-platform 文件
5. **clean_response() 误伤修复**: 噪声模式匹配增加行长度守卫
6. **inject_prompt() 短提示修复**: <50 字符跳过完整性检查
7. **P4 裁决提示去 HPC 化**: 使用通用裁决原则
8. **硬编码延迟常量化**: 统一在 `common.py` 定义

## P1 Production Upgrades (2026-06-28)

9. **verify_cdp_safe DNS rebinding 防护**: 解析 localhost → 验证 IP ∈ 127.0.0.0/8 或 ::1
10. **innerText → textContent 迁移**: 无 Reflow + Shadow DOM 穿透 + 更高性能
11. **safe_page() RAII 上下文管理器**: 三层清理 page.close → suppress(PlaywrightError)
12. **Fire-and-collect 替代 Barrier**: asyncio.wait() 独立 worker，消除人工同步点
13. **Gemini Pro Extended v3**: gem-menu-item 选择器 + Angular CDK polling + aria-label 幂等守卫
14. **Shell 注入消除**: --prompts-file 替代 shell 命令替换
15. **CLAUDE.md 凭据清除**: 硬编码密码 → 环境变量引用
