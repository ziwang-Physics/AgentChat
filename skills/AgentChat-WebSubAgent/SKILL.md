---
name: AgentChat-WebSubAgent
description: Sequential 6-step AI pipeline — Claude Code plans→Kimi searches→(complex? Gemini reasons)→Claude synthesizes→ChatGPT reviews→Claude fixes. Use for complex software engineering tasks needing web research + deep reasoning + quality review. MANDATORY EXECUTION - invoking this skill REQUIRES actually running `node skills/AgentChat-WebSubAgent/index.js` for Step 2 (--search) and Step 5 (--review) unconditionally (Step 3 --reason if complex), and listing each step's receipt.run_id from the returned JSON in the final report; narrating the pipeline or answering from model knowledge without receipts is a violation.
---

# AgentChat-WebSubAgent

> **核心原则**: Claude Code 大脑 → Kimi 搜索 → (复杂? Gemini 推理) → Claude 合成 → ChatGPT 审查 → Claude 修复
> **Provider 层**: `AgentChat-OneWeb`，零代码重复
> **安全策略**: 永不关闭用户 Chrome

## ⚠️ 强制规则 — 调用即执行

**本 skill 被调用时，必须依次执行 Step 1→6。Step 2 和 Step 5 无条件执行，Step 3 由复杂度决定。禁止跳过任何步骤，禁止只解释流程而不执行。**

核心约束:
- ❌ 禁止：读了 SKILL.md 后描述流水线、解释角色分工、分析架构——却不跑 `node index.js`
- ❌ 禁止：以"任务太简单/纯本地/不需要搜索"为由跳过 Step 2 (`--search`)
- ❌ 禁止：以"产出很简单/不需要审查"为由跳过 Step 5 (`--review`)
- ❌ 禁止：用本地文件读取、代码分析、或 Claude 自身知识替代 `node index.js` 调用
- ✅ 必须：Step 2 和 Step 5 **无条件执行**。复杂度判定仅影响 Step 3（Gemini 推理）是否跳过
- ✅ 必须：每步产生可验证的 `node index.js` JSON 输出，结果返回后才可补充你的解读

### 执行回执（receipt）— 是否执行以此为准，不以叙述为准
每次 `node index.js --search/--reason/--review` 的输出 JSON 中都包含机器生成的 `receipt` 字段
（同时 stderr 打印一行 `[receipt] AGENTCHAT_RUN {...}`）：

```json
"receipt": { "run_id": "ac-xxxxxxxxxxxx", "skill": "AgentChat-WebSubAgent", "mode": "search", "exit": 0, "provider_used": "kimi", ... }
```

- **最终报告必须逐步列出每次执行的 `receipt.run_id`**（Step 2 一个；Step 3 如执行一个；Step 5 一个）。
- 缺少某一步的 run_id = 该步没有执行 = 违规，必须补跑。
- run_id 随机生成并落盘 `skills/AgentChat-WebSubAgent/data/receipts.jsonl`，用户可 `grep <run_id>` 核对，凭空编造无法通过核对。
- **失败执行（exit≠0）同样有 receipt**：引用失败回执、说明降级/失败原因后，才允许以模型自身能力继续该步，并明确标注"web AI 未参与该步"。

**反绕过原则**: 如果某个步骤"看起来不需要 web AI"，正确的做法是仍然通过 `node index.js` 把本地发现发给 web AI 做验证/补充/交叉检查——而不是跳过该步骤。Step 2 的搜索 prompt 和 Step 5 的审查内容必须包含 Claude 已做的本地分析结果，让 web AI 做二次确认。

**自检清单** (Claude Code 在最终输出前必须确认全部完成):
- [ ] Step 2: `node index.js --search` 已执行，返回了 JSON？receipt.run_id = ______
- [ ] Step 3: (复杂时) `node index.js --reason` 已执行？receipt.run_id = ______ (简单时) 已明确记录跳过理由？
- [ ] Step 5: `node index.js --review` 已执行，返回了 JSON？receipt.run_id = ______
- [ ] Step 6: 审查意见已逐条处理？
- [ ] 最终报告已列出以上全部 run_id？

例外: `--smoke`、`--doctor`，或用户明确要求"只检查环境不发送"

## 架构

```
用户需求 → [1.Claude 规划] → [2.Kimi 搜索] →{复杂?}→ [3.Gemini 推理] → [4.Claude 合成] → [5.ChatGPT 审查] → [6.Claude 修复] → 最终产出
                                              └── 简单: 跳过 ──┘
```

串行管道 + 条件分支。Claude Code 全程担任大脑，仅在 Step 2/3/5 通过 index.js 调 OneWeb。

## 角色与 Prompt 规范

| 步骤 | AI | 角色 | 必须内嵌的指令 |
|------|-----|------|---------------|
| 2 | Kimi | 联网检索 | `请进行联网搜索，用要点列出关键事实和数据。不要运行代码。` |
| 3 | Gemini Pro | 深度推理 (条件) | `直接给出完整的分析。不需要搜索新资料，基于已有信息推理。` |
| 5 | ChatGPT | 交叉审查 | `请逐一审查以下内容，列出所有问题点并给出具体修改建议。不要重写整个方案。` |

## 复杂度判定 (Step 1)

**仅决定 Step 3 (Gemini 推理) 是否执行。不影响 Step 2 和 Step 5 的强制执行。**

**不确定时倾向判定为"复杂"**。

**复杂** (触发 Step 3，满足 ≥2 项):
- 需综合多个信息源才能得出结论
- 涉及多步逻辑推理或数学推演
- 有非平凡架构/设计决策，或需多文件代码
- 问题域需要领域专长
- 用户要求"深度分析"或"全面方案"

**简单** (跳过 Step 3，但 Step 2 和 Step 5 仍然必须执行):
- 单事实查询、≤50 行直观代码、格式转换等机械工作

---

## 操作流程

### Step 1: 规划与分发

1. 理解需求，快速浏览相关本地文件
2. 判定复杂度（仅决定 Step 3 是否执行）
3. **编写综合搜索 prompt** — 必须包含:
   - 用户原始需求
   - Claude 已做的本地分析摘要（文件内容、项目结构等发现）
   - 需要 web AI 补充/验证的领域背景或最新进展
   - **即使问题看似纯本地，也必须构造搜索 prompt**——至少让 Kimi 验证本地发现、补充领域最新动态、或交叉检查 Claude 的判断
4. 向用户报告：复杂度 + 搜索查询 + 预期产出

### Step 2: 联网检索 (无条件执行)

⚠️ **无论任务类型，此步骤不可跳过。** 即使问题 100% 是本地文件理解，也必须执行搜索——价值在于补充领域背景、验证本地发现、发现 README 没有的最新进展。

```bash
node skills/AgentChat-WebSubAgent/index.js --search "综合搜索 prompt"
```

输出为 JSON。`response` 字段即 Kimi 完整搜索结果。Claude Code 完整阅读后提取关键事实。

Fallback: Kimi → Qwen

### Step 3: 深度推理 (仅复杂任务)

将搜索摘要 + 原始需求组装为一个推理 prompt。摘要关键信息即可，不要贴原始全文。

```bash
node skills/AgentChat-WebSubAgent/index.js --reason "原始需求: ...搜索摘要: ...请从[角度]深度分析，直接给出完整推理。不需要搜索新资料。" --timeout=300000
```

Fallback: Gemini → ChatGPT → Claude

### Step 4: 核心生成

汇总搜索事实 + 推理结论(如有) + 原始需求，生成最终交付物（代码/文档/报告）。自检：所有搜索事实已纳入？推理结论已被吸收？需求要点全覆盖？

### Step 5: 交叉审查 (无条件执行)

⚠️ **无论任务类型，此步骤不可跳过。** 将 Step 4 产出全文发给 ChatGPT。审查维度：正确性、安全性、性能、可维护性。

即使产出"很简单"，审查的价值在于：发现 Claude 可能忽略的错误、验证事实准确性、检查逻辑一致性。简单产出的审查可能很快（"无问题"也是有效结果），但必须执行。

```bash
node skills/AgentChat-WebSubAgent/index.js --review "原始需求: ...待审查产出: ...请从正确性、安全性、性能、可维护性逐一审查，列出问题并给修改建议。不要重写方案。"
```

Fallback: ChatGPT → Claude → Qwen

收到审查意见后逐条评估：合理→Step 6 修复 / 不适用→记录原因 / 需澄清→标注。

### Step 6: 修复与输出

逐条应用审查意见，输出最终文件。向用户报告：步骤摘要、复杂度理由、审查处理情况、产出位置。

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

---

## CLI 速查

```bash
node skills/AgentChat-WebSubAgent/index.js --search "query"     # Kimi 搜索
node skills/AgentChat-WebSubAgent/index.js --reason "prompt"    # Gemini 推理
node skills/AgentChat-WebSubAgent/index.js --review "content"   # ChatGPT 审查
node skills/AgentChat-WebSubAgent/index.js --smoke | --doctor   # 环境检查
```

| Flag | 说明 |
|------|------|
| `--search/--reason/--review` | 步骤模式（三选一） |
| `--provider=X` | 覆盖默认 provider |
| `--timeout=N` | 超时 ms（默认 180000） |

## 降级链

| 步骤 | 首选 | 降级 |
|------|------|------|
| Search | Kimi → Qwen |
| Reason | Gemini → ChatGPT → Claude |
| Review | ChatGPT → Claude → Qwen |
