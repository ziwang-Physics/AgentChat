---
name: AgentChat-IndependentTasks
description: Parallel AI task decomposition orchestrator — Claude Code decomposes tasks & writes prompts → Node.js concurrent dispatch to AgentChat-OneWeb → quality gates + evidence arbitration. Use for parallel AI processing, multi-model orchestration, task decomposition, concurrent AI workers, or "ask multiple AIs at once". MANDATORY EXECUTION - invoking this skill REQUIRES writing the JSON plan and running `node skills/AgentChat-IndependentTasks/index.js --timeout=900000 '<JSON>'`, then quoting the `[receipt] AGENTCHAT_RUN` line from its output in the final answer; describing the workflow or answering from model knowledge without a receipt is a violation.
---

# Parallel AI Decompose — Thin Orchestrator over AgentChat-OneWeb

> **最后更新**: 2026-07-04
> **核心原则**: Claude Code 拆任务 + 写 prompt → Node.js 并发派发 → 质量门 + 证据仲裁
> **🛡 安全策略**: 永远不关闭用户 Chrome。`--keep-tabs` 硬编码为 true。
> **Provider 层**: 单一源 — `AgentChat-OneWeb` (8 providers, 零代码重复)

## ⚠️ 强制规则 — 调用即执行（首要动作契约）

**本 skill 被调用（如 `/AgentChat-IndependentTasks <任务>`）时，必须把任务真实派发到多个 web AI。禁止只解释流程而不执行，禁止用模型自身知识替代各 worker 的产出。**

### 1. 首要动作契约
读完本 SKILL.md 后，唯一允许的中间步骤是 Step 1-2（拆解任务、写 JSON plan）。写完 plan 后的**下一个工具调用**必须是：

```bash
node skills/AgentChat-IndependentTasks/index.js --timeout=900000 '<DAG_JSON_STRING>'
```

结果返回后才可补充你的解读。禁止在拆解之后转而自己回答各子任务。

### 2. 执行回执（receipt）— 是否执行以此为准，不以叙述为准
每次真实执行（含失败）都会在 **stdout 报告末尾**输出一行机器生成的回执：

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx","skill":"AgentChat-IndependentTasks","exit":0,"nodes":4,"failed":0,"providers_used":{...},...}
```

- **最终回答必须原样引用这行 receipt**（至少包含 run_id、nodes、failed、providers_used）。
- 没有 receipt = 没有执行 = 违规，必须回去执行。
- `run_id` 随机生成并落盘 `skills/AgentChat-IndependentTasks/data/receipts.jsonl`，用户可 `grep <run_id>` 核对，凭空编造无法通过核对。
- **全部 worker 失败（exit=2）同样有 receipt**：引用失败回执、说明各 provider 失败原因，之后才允许用模型自身能力回答，并明确标注"web AI 未参与"。

### 3. 违规模式（全部禁止）
- ❌ 读完 SKILL.md 后讲解 4 角色分工、描述 DAG 并发原理——却不跑 `node index.js`
- ❌ 写完 JSON plan 后不派发，转而自己逐个"扮演"各角色作答
- ❌ 回答中没有 `[receipt] AGENTCHAT_RUN` 行却声称"已由多个 AI 并行处理"

### 4. 例外
仅限：`--smoke`、`--doctor`，或用户明确要求"只检查环境不发送"。这两种模式不产生 receipt，属预期行为。

## Architecture

```
AgentChat-IndependentTasks (本 skill, ~630 行)
    │
    │  child_process.spawn('node', ['../AgentChat-OneWeb/index.js', '--only=X', prompt])
    ▼
AgentChat-OneWeb (Provider 唯一实现, 8 providers, 已验证 DOM 选择器)
    │
    │  playwright-core → Chrome CDP port 9222
    ▼
Chrome → Gemini / ChatGPT / Claude / Qwen / Kimi / MiniMax / MiMo / DeepSeek
```

**关键设计**: IndependentTasks 不包含任何 provider 实现代码。所有 AI 调用通过 subprocess 委托给 AgentChat-OneWeb。

## 角色分工（互补，不重叠）

| AI | 角色 | 擅长 |
|----|------|------|
| **Kimi** | researcher | 长文分析、文献综述、细节提取、背景调研 |
| **Gemini** | depth_reasoner | 多步逻辑、数学分析、科学推理、复杂推演 |
| **Qwen (通义千问)** | reviewer_retriever | 事实核查、交叉验证、中文检索、联网搜索 |
| **ChatGPT** | creative_builder | 方案设计、代码生成、综合报告、可执行建议 |

## 各 AI 的 Prompt 编写规范（CRITICAL）

每个 AI 有特定的输入/output 偏好，写 prompt 时必须内嵌对应指令：

| AI | 必须附加的指令 | 原因 |
|----|---------------|------|
| **Kimi** | `用要点列出关键事实。不要运行任何代码。` | Kimi 联网搜索后倾向输出搜索词列表/执行 Python 而非直接给结论，显式禁止代码可强制其文字输出 |
| **Gemini** | `直接给出完整的分析。`  | Gemini 推理深度高，但偶尔会因多轮思考而截断，需要明确"完整" |
| **Qwen** | `每个结论标注信息来源。` | Qwen 联网检索能力强，但来源标注不稳定，显式要求可提升可验证性 |
| **ChatGPT** | `直接输出完整报告，不要解释方法论。` | ChatGPT 容易输出"我会从X/Y/Z维度分析…"的规划式回应，禁止其描述方法 |

## Dependencies

| 依赖 | 说明 |
|------|------|
| **AgentChat-OneWeb** | 必须在 `../AgentChat-OneWeb/index.js`（同仓库自动满足） |
| **Node.js** | v16+ |
| **Chrome CDP** | 端口 9222（OneWeb 负责连接，此 skill 不直接使用） |

## Claude Code 的操作流程

当用户调用此 skill 时，Claude Code 必须执行以下步骤：

### Step 1: 分析任务 & 拆解分工

根据用户任务的复杂度，将其拆解为 4 个互补的子任务。

**分工原则：**
- 同一个问题绝不发给两个 AI——每人做不同的角度
- Kimi 收集资料和背景，Gemini 做深度推理，Qwen 做事实核查和联网验证，ChatGPT 做综合输出
- 每个 prompt 必须自包含、可直接执行，要求 AI 直接给出答案（不说"我会..."）
- **编写每个 prompt 时，必须内嵌上表中对应 AI 的指令**

### Step 2: 写出 JSON Plan

```json
{
  "subtasks": [
    {
      "id": "research",
      "role": "researcher",
      "primary": "kimi",
      "depends_on": [],
      "prompt": "请收集关于...的详细资料和关键数据。用要点列出关键事实。不要运行任何代码。"
    },
    {
      "id": "analyze",
      "role": "depth_reasoner",
      "primary": "gemini",
      "depends_on": ["research"],
      "prompt": "基于研究结果，请从理论/机制层面深入分析..."
    },
    // ... 其余 subtask (verify/qwen, synthesize/chatgpt)
    // 每个包含 id/role/primary/depends_on/prompt，prompt 内嵌对应 AI 的指令
    // depends_on: 字符串数组，列出此任务依赖的其他 subtask id（空数组=无依赖）
  ]
}
```

### Step 3: 并发调度

**默认命令**（4 workers 并发，标签页始终保留）：

```bash
# --timeout 单位是毫秒（与 AgentChat-OneWeb 一致），900000 = 15 分钟，
# 略高于 OneWeb 默认的 600000（10 分钟），给多 worker 并发留余量。
# ⚠️ 之前这里错写成 --timeout=900（只有 0.9 秒），M2 阶段有下限保护不会崩，
# 但 M1 的 DAG 分解会因为预算过小而必然超时，静默退化成规则模板 DAG。
node skills/AgentChat-IndependentTasks/index.js --timeout=900000 '<DAG_JSON_STRING>'
```

`--keep-tabs` 已硬编码为始终开启（安全策略：永不关闭用户 Chrome），可省略该参数。

也可写入临时文件：

```bash
cat > /tmp/ai_plan.json << 'ENDJSON'
{...JSON计划...}
ENDJSON
node skills/AgentChat-IndependentTasks/index.js --timeout=900000 "$(cat /tmp/ai_plan.json)"
```

### Step 4: 解读结果 & 呈现给用户

脚本输出结构化仲裁报告 + 各 worker 完整响应 + 末尾一行 `[receipt] AGENTCHAT_RUN {...}`。
Claude Code 解读并呈现给用户，**最终回答末尾必须原样附上该 receipt 行**（强制规则 §2）。

## 📐 输出排版规范 — 最终回答强制格式

约束对象是 Claude Code 撰写的**最终落地文本**；worker 原始输出、代码块、diff、表格与 receipt 行不受约束。

1. **结论先行**：开头第一段为 ≤50 字的核心结论（TL;DR），直接回答用户根本诉求，无客套话、无方法论铺垫。
2. **标题层级**：主模块用 `##`，子观点用 `###`，禁止一级标题 `#`。维度按逻辑聚类为 3–5 块（如：背景/现状/分析/结论），禁止按检索顺序写流水账。
3. **视觉焦点**：数据、时间、专有名词、核心论点用 `**加粗**` 标出；加粗仅用于焦点引导，每个自然段不超过 2 处。
4. **列表纪律**：只允许单层无序列表 `*`，禁止任何多级嵌套列表（保证终端/聊天框阅读体验）。
5. **文本密度**：叙述性自然段 ≤3 句，新逻辑分支必须换行分段；禁止"总而言之""基于以上搜索结果""作为一个人工智能"等无实质信息的过渡句。
6. **信息隔离**：引用 web AI 原文片段或外部链接时必须放入 `>` 引用块并标注来源 provider，与自己的分析严格区分。
7. **豁免条款（优先级高于第 1–6 条）**：
   * `[receipt] AGENTCHAT_RUN {...}` 行（或各步 run_id 清单）必须原样保留在回答末尾的代码块中，禁止改写、加粗、省略——受强制规则 §2 约束。
   * 降级/失败披露（如"N 个角色降级""web AI 未参与本次回答"）属流程透明性要求，不算冗余过渡句，不得删除。
   * 代码块、diff、表格不受段落长度与列表层级限制。

## Fallback Chain

任意 provider 不可用时自动降级（由 IndependentTasks 编排层处理；子进程用 `--only`/`--single` 只跑单个 provider，降级控制只存在于这一层）：

```
Gemini → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek
```

IndependentTasks 层降级链严格遵循 OneWeb 原生顺序，不做优先级重排

降级结果会显式标记在输出中（provider_used ≠ primary_intended）。

**实现细节**：IndependentTasks 派发给 OneWeb 子进程时始终附带 `--single`（每次子进程只
尝试 `--from` 指定的那一个 provider，绝不在子进程内部级联到下一个）。跨 provider 的降级
完全由 IndependentTasks 自己的 `executeWithFallback()` 循环 + 文件锁（`acquireLock`/
`releaseLock`）驱动，这样锁定的 provider 和实际被使用的 provider 才能保证一致，避免
两个并发 worker 同时占用同一个 provider 的浏览器 tab。

Provider 可用性由 AgentChat-OneWeb 管理，详见其 SKILL.md。

## 维护命令

```bash
# 检查所有 provider 可用性 (通过 OneWeb)
node skills/AgentChat-IndependentTasks/index.js --smoke

# 检查 OneWeb 是否存在
node skills/AgentChat-IndependentTasks/index.js --doctor
```

## Code Location

- `index.js` — 薄编排器 (零 provider 代码)
- `SKILL.md` — this file
- Provider 实现 — `../AgentChat-OneWeb/` (单源真相)
