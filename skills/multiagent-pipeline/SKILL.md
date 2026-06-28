# MultiAgent: 3-Mode DAG Pipeline + DeepSeek One-Shot Judge

> **最后更新**: 2026-06-28 — CONSENSUS One-Shot Judge + Condorcet 门控 + 选择性备选激活
> **模型**: Claude Code (powered by DeepSeek LLM, local inference — no web browser needed for P1/P3)
> **验证**: 20+ 轮 loop 迭代，100+ 次独立专家评估，完全收敛

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
   RoutingState 评估器: 三维特征 {complexity, uncertainty, structure_need}
   模式选择: PARALLEL(默认，>90%查询) / SIMPLE(罕见，简单事实) / CONSENSUS(升级)
   Output: $WORKDIR/prompts.json  (WORKDIR = mktemp -d)
   ⚡ No browser — instant
     │
     ▼
🟡 Phase 2: 3 Expert Nodes — CONCURRENT FIRE-AND-COLLECT (Playwright → Chrome tabs)
   $ python3 orchestrator.py phase2 --file $WORKDIR/prompts.json --json
   ┌──────────┬──────────┬──────────┐
   │ ChatGPT  │ Kimi     │ Gemini   │
   │ 工程实践  │ 文献基准  │ 推理深度  │
   └──────────┴──────────┴──────────┘
   Gemini auto-enables Pro Extended Thinking. Kimi/Qianwen thinking-selector
   prevents mid-generation extraction. 3 tabs, shared Chrome context.
   Hard timeout: 60s per platform. asyncio.wait() convergence. ~50s.
     │
     ├─ 一致性 ≥ 2/3 AND 置信 ≥ 0.7 → 跳过 P4，直接输出
     │
     └─ 一致性 < 2/3 OR 置信 < 0.7 → 进入 P3
     │
     ▼
🟠 Phase 3: Claude Code — DIRECT REASONING
   Compress into structured matrix: 共识区/特色区/冲突区 H2 sections.
   Output: $WORKDIR/matrix.md  ⚡ No browser — instant
     │
     ▼
🔴 Phase 4: DeepSeek V4 Pro API — ONE-SHOT SCORING-SYNTHESIS JUDGE
   $ python3 orchestrator.py phase4 --file $WORKDIR/matrix.md --prompts-file $WORKDIR/prompts.json
   
   内部流程 (单次 API 调用):
     1. Independence Check Gate — 检测共享幻觉
     2. Scoring (0-10 per worker) + Conflict Graph + Arbitration
     3. Synthesis — 最大自洽子图选边 + 融合
   
   ⚡ API call, ~5-15s. Zero DOM dependency.
     │
     ├─ 置信 < 阈值 → Condorcet 门控:
     │   ├─ p < 0.5 (困难任务): P4 Long CoT 深度思考
     │   └─ p > 0.5: 选择性激活 Claude → 再跑一轮 → P4
     │
     ▼
   Final Output (presented by Claude to user)
```

**DAG 升级路径 (单向不可逆)**:
```
SIMPLE ──→ PARALLEL ──→ CONSENSUS
(极罕见)   (默认>90%)   (高冲突/低置信时)
                │            │
                │ 2/3一致    │ Condorcet p<0.5 → P4 深度思考
                │ → 直出     │ Condorcet p>0.5 → +Claude → P4 One-Shot
```

**模式分配**:
- **PARALLEL (默认)**: 3 路并发，lens prompt，覆盖 >90% 查询。一致性 ≥2/3 直接返回
- **SIMPLE**: 仅极简单事实查询 (complexity<0.3 AND uncertainty<0.3)，1 worker
- **CONSENSUS**: PARALLEL 分歧后升级，One-Shot Judge + Condorcet 选择性扩展

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

### Step 1: Decompose & Route (Claude Code — no browser)

**RoutingState 评估器**: 分析请求，输出三维特征 `{complexity, uncertainty, structure_need}` + 模式选择。

- **PARALLEL (默认，>90% 查询)**: 生成 3 个 lens prompt。`complexity ≥ 0.3 OR uncertainty ≥ 0.3 → PARALLEL`
- **SIMPLE (极罕见)**: 1 worker 直接回答。`complexity < 0.3 AND uncertainty < 0.3` (如 "1+1=?" / "北京在哪")
- **CONSENSUS (升级触发，非初始选择)**: 仅由 P3 检测 PARALLEL 分歧后升级

**Sandwich Prompt Template (PARALLEL 模式)**:

```
Layer 1 — Core Question (完全同化, ~80%):  所有平台一字不差的核心问题，占 prompt 主体
Layer 2 — Primary Lens  (特性锐度, ~15%):  一句简短视角指令，轻微引导分析方向
Layer 3 — Cross-Coverage (交叉补位, ~5%):  一个短语提示覆盖其他维度，仅作兜底
```

**Rationale**: Core Question 占 80% 确保所有 AI 围绕相同的核心问题回答——这是 P3 共识/冲突提取的前提。3 个视角（工程/文献/推理）互补无重叠。Primary Lens 仅提供方向性微调。Cross-Coverage 降为一个短语，覆盖其余 2 个视角。

**Sandwich Prompt Template:**

```json
{
  "task_core": "one-sentence summary (max 120 chars)",
  "worker_prompts": {
    "chatgpt": "【核心问题】<完全相同的 question，占主体> （附加视角：侧重工程实践与代码效率。简略带过文献基准、推理深度。）",
    "kimi": "【核心问题】<完全相同的 question，占主体> （附加视角：侧重学术文献与基准测试，请搜索网页验证。简略带过工程实践、推理深度。）",
    "gemini": "【核心问题】<完全相同的 question，占主体> （附加视角：侧重推理深度与逻辑一致性。简略带过工程实践、文献基准。）"
  }
}
```

**Why 3 workers (not 5)**: 实测数据 — ChatGPT ~100% 可用, Kimi ~95%, Gemini ~80%。Claude 免费额度 ~85% 不可用；Qianwen 安全视角在非安全场景中边际贡献极低。3 视角 (工程/文献/推理) 互补无重叠，降低 CDP 并发内存 40%，P2 耗时从 ~75s 降到 ~50s，共识判定从 2/5 弱共识变 2/3 强共识。

**Replacement rules for `<完全相同的 question>`:**
- Insert the user's actual question verbatim, NOT a rephrased version
- If the question is long (>200 chars), use the `task_core` summary instead
- The question block is identical across all 4 platforms — no variation

**Cross-Coverage weight rule:**
- Cross-coverage is a single parenthetical phrase after the core question — one sentence total
- Total cross-coverage ≤ 5% of prompt length — the core question dominates
- Primary Lens is ~15% — one clause steering the angle, not a full paragraph
- If the AI ignores Lens/Cross-Coverage entirely, the core question answer alone is still complete

Write to `$WORKDIR/prompts.json`.

### Step 2: Dispatch (browser automation)
```bash
python3 ~/.claude/skills/multiagent/orchestrator.py phase2 \
  --file "$WORKDIR/prompts.json" --timeout 60 --json > "$WORKDIR/p2_results.json"
```

### Step 3: Compress (Claude Code — no browser)
Read `$WORKDIR/p2_results.json`. Produce matrix with **共识区/特色区/冲突区** H2 sections. Write to `$WORKDIR/matrix.md`.

### Step 3.5: Early Exit (PARALLEL consensus check)

Before P3 compression, check if P4 is even needed:

```
if consensus_ratio >= 2/3 AND synthesis_confidence >= 0.7:
    → 跳过 P3+P4，直接输出多数答案
else:
    → 进入 P3 矩阵压缩 → P4 裁决
```

### Step 4: Adjudicate — One-Shot Scoring-Synthesis Judge (DeepSeek V4 Pro API)

Single API call. Internal steps executed in one prompt:

1. **Independence Check Gate**: 检测 3 个 worker 输出语义相似度 >0.85 → 判定"伪多数"，阻断合成
2. **Scoring**: 每 worker 评分 0-10 (正确性/完整性/一致性/简洁性)
3. **Conflict Graph**: 提取事实断言建矛盾图 → 最大自洽子图选边 → 不做平均/妥协
4. **Synthesis**: 融合高置信片段 → 输出最终答案 + 证据链 + 弃用观点+原因

**CONSENSUS 升级 (P4 置信不足时)**:

```
P4 confidence < 0.7:
    │
    ├─ Condorcet 门控: 评估任务难度 → p 值
    │   p < 0.5 (困难): 禁止横向扩展
    │       → P4 切换 Long CoT / Tree of Thoughts 深度推理
    │   p > 0.5: 选择性激活备选池
    │       → +Claude (Sonnet 4.6)
    │       → 3 core + 1 spare = 4 workers 重跑一轮
    │       → 最多扩展至 5 (含 MiniMax，排除豆包 deprecated)
    │
    └─ 新结果 → P4 One-Shot Judge 再次裁决 → 最终输出
```

**动态 p 阈值**: 基于任务域历史精度 (JudgeBench 基准: GPT-4o 跨域精度 Knowledge 44.2% ~ Math 66.1%)。零样本 log-probability 作为实例级代理。固定 0.5 不可行——跨域差 >20pp。

> **P1 upgrade (2026-06-28)**: Replaced Gemini Web CDP with DeepSeek V4 Pro API.
> Zero DOM dependency, 100% injection success, second-level latency.
> API key from `$DEEPSEEK_API_KEY` env var.

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
| P2 | 1+ platform crash/exception | Continue with remaining workers |
| P2 | ALL 3 fail | Report to user: "All 3 expert nodes failed. Check network/proxy. Retry? (y/n)" |
| P3 | — | Claude can still reason over partial P2 results |
| P3.5 | PARALLEL consensus ≥2/3 → skip P4 | Early exit, majority answer returned directly |
| P4 | DeepSeek API unreachable / 5xx | Retry with exponential backoff (3 attempts), then present P3 matrix |
| P4 | DEEPSEEK_API_KEY not set | Present P3 matrix, note degradation |
| P4 | confidence < 0.7 + Condorcet p>0.5 | Selective escalation: +Claude → rerun → P4 again |
| P4 | confidence < 0.7 + Condorcet p<0.5 | No expansion: P4 Long CoT deep reasoning |
| Escalation | Claude 免费额度耗尽 | Fall back to original 3-worker P4 result，note partial coverage |

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
│   ├── chatgpt.py            # ChatGPTAdapter (P2 worker: 工程实践)
│   ├── kimi.py               # KimiAdapter (P2 worker: 文献基准)
│   ├── gemini.py             # GeminiAdapter (P2 worker: 推理深度 + P4 fallback)
│   ├── claude.py             # ClaudeAdapter (首选备选 — CONSENSUS升级时选择性激活)
│   ├── qianwen.py            # QianwenAdapter (备用，默认不启用 — 非安全场景边际低)
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

## P1 Upgrades (2026-06-28 — continued)

16. **Qianwen Deep Thinking 自动开启**: `ensure_thinking_mode()` 基于 aria-pressed 幂等守卫，每次 P2 千问 tab 自动点击"思考"按钮启用深度推理模式
17. **BaseAdapter.ensure_thinking_mode()**: 通用 no-op hook，各平台按需覆盖 (Qianwen 点击 toggle，Gemini 委托 `ensure_pro_extended`，其他平台默认跳过)

## P1 Upgrades (2026-06-28 — continued #2)

18. **P4 裁决者切换 DeepSeek V4 Pro API**: 替换 Gemini Web CDP → 直接 API 调用 (Anthropic-compatible Messages endpoint)，零 DOM 依赖/零注入失败/秒级延迟，API key 从 `$DEEPSEEK_API_KEY` 环境变量读取
19. **P2 新增 Gemini 3.1 Pro Extended Thinking Worker**: 第 5 个 P2 并行节点，角色"推理深度与逻辑一致性"，利用 Extended Thinking 的链式推理能力补足 Claude 免费额度经常不可用的防御架构视角

## P1 Upgrades (2026-06-28 — continued #3)

20. **P2 Workers 5→3 精简**: 基于 7 轮实测数据 — Claude ~85% 不可用，Qianwen 非安全场景边际极低。保留 ChatGPT(~100%) + Kimi(~95%) + Gemini(~80%)。CDP 内存降 40%，P2 从 ~75s→~50s。Claude/Qianwen adapter 保留备用。

## P1 Upgrades (2026-06-28 — continued #4)

21. **CONSENSUS One-Shot Scoring-Synthesis Judge**: P4 DeepSeek 单次调用内完成 Independence Check → Scoring → Conflict Graph → Synthesis。不做多轮辩论，O(1) 收敛。≤40 行实现。
22. **Condorcet 选择性门控**: P4 置信 <0.7 时：p<0.5(困难) → P4 Long CoT；p>0.5 → +Claude 扩展。动态 p 阈值，最多扩展至 5 worker。CARGO 文献证实选择性激活省 40% 计算。
23. **PARALLEL 默认模式**: >90% 查询走 PARALLEL(3 路并发 lens prompt)。SIMPLE 仅极简单事实查询。CONSENSUS 仅 PARALLEL 分歧 <2/3 时触发。
24. **Early Exit**: PARALLEL 一致性 ≥2/3 AND 置信 ≥0.7 → 跳过 P3+P4，直接输出多数答案。
25. **Thinking Selector 提取时机修复**: `base.py` stability fallback 加 thinking 标识检测。Kimi (`[class*="typing"]`)、Qianwen (`button[aria-label*="停止"]`)、Gemini (`mat-spinner`) 各定义 `THINKING_SELECTOR`。阻断搜索/思考中间态被误判为完成。
