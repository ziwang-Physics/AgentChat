---
name: AgentChat-IndependentTasks
description: 并行分发 N 道独立任务给多个浏览器 AI，回收后由 Claude Code 合成权威答案并输出教科书式解答手册 PDF。触发词："分给多个 AI""并行问多个 AI""汇总成 PDF/解答手册"。不适用于需 AI 间协作或角色分工的任务。
---

# AgentChat-IndependentTasks：独立任务并行分发 + 解答手册合成

## ⛔ 角色边界

你是管道的**调用者**，只做三件事：准备输入 → 调用脚本 → 报告结果。禁止手工模拟管道任何环节（提取题目、分组、编写 prompt、审校答案、编译 PDF）。

## 核心模型

N 道独立任务，M 个能力等同的 AI（最多 7：gemini/chatgpt/qwen/kimi/minimax/mimo/deepseek），纯分发、零协作。

```
题目 → 按主题分组 → JSON Plan → node index.js 并行派发 → 校验 → 合成 → md2pdf.sh → PDF
```

**三条铁律**：
1. 所有 AI 同一 prompt 模板，只是题目子集不同。禁止差异化角色设定。
2. 每题一个权威答案（择优或融合，统一口吻重写），不并列展示多版本。
3. 零 AI 署名——PDF 中不得出现 provider 名称/徽章/覆盖矩阵/审计报告/AI 元数据。

## 强制执行规则（不可跳过、不可绕过）

1. **必须真实派发。** 一切 AI 查询必须通过 `node ~/.claude/skills/AgentChat-IndependentTasks/index.js` 实际执行，禁止 Claude Code 自行代答。

2. **必须生成运行回执（receipt）。** 由 `skills/lib/receipt.js` 生成，回执缺失 = 未执行。

3. **文件修改分级:**
   - **冻结（只读）**: `index.js`（编排层）、`AgentChat-OneWeb/index.js`（Provider 层）
   - **共享库（改动需跨技能验证 + 全量测试）**: `lib/*.js`（含 `lib/plan.js`、`lib/execute.js`、`lib/locks.js` 等）
   - **可自由修改**: `SKILL.md`、`synthesize.js`、`validate_answers.js`、`md2pdf.sh`

4. **失败分级降级协议。** 失败 = provider 超时/桥接失败/Step 2.5 答非所问。三级路径：
   - **L1（自动）**：补发一次，改派 fallback 链下一可用 provider。foreign anchor 失败（路由串扰）→ 逐组串行补发；锚行缺失/伪造检测（拒答/bridge 空返回）→ 并行补发。
   - **L2（停下等用户）**：L1 后仍失败 → 输出失败报告 + 两选项（用户指定方案再补发 / 授权生成部分 PDF，缺答以 `> ⚠ 本题答案待补` 占位标出）后 STOP。
   - **绝对禁止**：Claude Code 自答填补 / 同一回合报告失败又擅自生成"完整"PDF。

5. **合成前强制通过内容校验门（机器执行）。** 派发后必须跑 `validate_answers.js`（校验锚行逐字出现、外来锚检测、噪声剥离）。退出码非 0 → L1。合成材料用 `clean/` 目录，不用原始 stdout。

6. **用户 provider 约束写进 `exclude`，覆盖 fallback 链与 L1。** 只不设 primary 不够——fallback 链会自动路由到被禁 provider。必须 plan 顶层 `"exclude": ["claude"]` 并在 L1 补发时同样跳过。

7. **每次 validation `--out` 目录必须唯一（带时间戳）。** 旧目录残留历史 clean 文件会导致误取错误回答。

8. **semantic_check.json 必须"生成→读取→批量改 verdict→写回"。**
   `validate_answers.js` 自动生成，初始 `PENDING`。
   必须 Read → 逐条对照原始题目核实（不得跳过任何条目）→
   在内存中构造完整 JSON → **一次性 Write 回同一路径**。
   约束:
   - 仅修改 `verdict` 与 `note` 字段；其余字段（`subtask`/`question`/`restatement` 等）原样保留。
   - `note` 为单句（≤30 字），须指出判定依据，禁止空泛的"内容匹配"。
   - 写回前自查 JSON 合法性（引号转义、尾逗号）。
   - 条目数 ≤3 时可用 Edit 逐条改；>3 条时必须用 Write 批量替换以省 token。
   禁止从零手写。`md2pdf.sh` 遇 `PENDING`/`MISMATCH` 拒绝编译（退出码 5）。

9. **多轮 dispatch 必须合并 clean 目录。** 以最后一轮为基础，向前追索每题首次 PASS 的 `<id>.txt`；对账全量 questions → PASS；合并 semantic_check.json。禁止未合并进入 Step 3。

10. **禁止 M=N 满配部署（零 fallback 陷阱）。** 当所有可用 provider 全部作为 primary 派在同一 wave 时，`index.js` 的 skipList 机制会将其他 primary 从每个 worker 的 fallback 链中预过滤删除——每个 worker 只剩 `[自身]`，一次失败即 `ALL_EXHAUSTED`。**防御**：(a) 始终保留 ≥1 个 provider 不设 primary 作为"热备"；(b) 或设 `AGENTCHAT_MAX_TABS_PER_PROVIDER=2` 启用同 provider 多 tab 并发；(c) 无法满足 (a)(b) 时，L1 补发 group 数 ≤ M−1。

## Step 0：网页内容爬取（仅当题目来源为浏览器页面时）

```bash
node ~/.claude/skills/AgentChat-OneWeb/moodle_scraper.js --detail-timeout=15000 --max-detail=15
```

## Step 0.5：本地文档快速提取协议（省 token）

### 0.5.1 一次读取原则

源文档（.docx/.pdf/.md）**只读一次**。单次 `pandoc` 转换 → 单次完整读取 → 一次性输出结构化题目列表。

```bash
pandoc "source.docx" -t markdown -o /tmp/source_tasks.md
```

### 0.5.2 结构化提取输出格式

读取后，Claude Code 一次性输出 `/tmp/tasks_extracted.json`：

```json
{
  "source": "Response Letter.docx",
  "background": "≤100-word shared context",
  "tasks": [
    {
      "id": "R1Q1",
      "reviewer": 1,
      "question": "verbatim question text",
      "author_draft": "verbatim draft or null",
      "topic": "1-3 word slug (e.g. 'STE-size', 'solvent', 'doping')"
    }
  ],
  "meta": {
    "manuscript_id": "7669388 or null",
    "title": "paper title or null",
    "journal": "journal name or null",
    "language": "en | zh | mixed"
  }
}
```

`question` / `author_draft` 逐字引用原文。`topic` 用于自动分组。`background` 从文档开头 ≤100 词自动凝练。

### 0.5.3 背景自动提取

从 `pandoc` 输出前 ~300 词凝练：研究对象 + 方法 + 关键发现 + 期刊名。≤100 英文词，全部分组共享。模板：

```
This [theoretical/experimental] study investigates [WHAT] in [SYSTEM]
using [METHOD]. [ONE-SENTENCE KEY FINDING].
```

### 0.5.4 模板填充生成 prompt（禁止手写）

**绝对禁止**为每个 group 手写 prompt 正文。Prompt 模板由 `index.js` 内置（`expandSharedPlan` 函数），模板定义见 `references/prompt-templates.md`（仅供参考，不进 Claude Code context）。

**推荐方式**：使用 plan JSON 的 `shared` + `questionBank` 压缩格式（省 ~3K token/次），`index.js` 自动展开：

```json
{
  "exclude": ["claude"],
  "shared": {
    "background": "This theoretical study investigates...",
    "template": "dual_en"
  },
  "subtasks": [
    {
      "id": "STE-size", "primary": "gemini", "depends_on": [],
      "questions": ["R1Q1", "R2Q1"]
    }
  ],
  "questionBank": {
    "R1Q1": {
      "text": "Why the emission energy shows...",
      "author_draft": null,
      "type": "explain"
    },
    "R2Q1": {
      "text": "It should be clarified whether...",
      "author_draft": "量子点尺寸越小...",
      "type": "clarify"
    }
  }
}
```

`index.js` 的 `expandSharedPlan()` 会：取 `shared.template` 选模板 → 填 `{BG}` → 从 `questionBank` 构建 `{TASKS_BLOCK}`（按 `type` 自动匹配要求）→ 生成完整 prompt。`shared.template` 取值：`single_en` | `dual_en` | `single_zh` | `dual_zh`。

**回退方式**：每个 subtask 带完整 `prompt` 字段（传统格式），此时 `shared`/`questionBank` 可选。

`{TASKS_BLOCK}` 格式：`【Task {n}】[ANSWER {ID}]` + 题目原文 + 作者思路 + 要求（按 `type` 自动匹配：explain/compare/provide/clarify/literature/mixed）。

### 0.5.5 完整操作序列

```
Step 0.5a: pandoc source.docx → /tmp/source_tasks.md
Step 0.5b: Read 一次 → 输出 /tmp/tasks_extracted.json
Step 0.5c: 自动分组 + 分配 primary（P ≤ U−1）
Step 0.5d: 生成 Plan JSON（heredoc → /tmp/agentchat_plan.json）
           推荐 shared+questionBank 压缩格式（省 ~3K token）
Step 2:   lint + dispatch（0 Claude Code tokens）
```

## Step 1：题目分组与 AI 分配

**分组原则**：同 topic → 同组。N > M（7）时才可合组（审稿回复每人 ≤1 题/组优先）。全局 ID（如 `R2Q3`）每组内本地重编号「Task 1..k」并附 `[ANSWER <ID>]` 锚行。禁止用审稿人原始编号 "(2)/(3)"。

**满配约束**：P = plan 中去重 primary 数，U = 排除 exclude 后可用 provider 总数。
- P ≤ U−1（推荐）：始终空闲 ≥1 个 hot-spare
- P = U（高风险）：零 fallback，index.js 自动启用 multi-tab（AGENTCHAT_MAX_TABS_PER_PROVIDER=2）
- AGENTCHAT_MAX_TABS_PER_PROVIDER=2：G > U 时建议启用，取值 1–4

**浏览器准入信号量**：`AGENTCHAT_MAX_CONCURRENT_PAGES`（默认 3）。是跨进程的全局浏览器自动化并发上限，每个 OneWeb 子进程在 `tryAllProviders()` 前通过 `acquireBrowserSlot()` 获取（`lib/locks.js:161`）。**默认值 3 是 IndependentTasks 的隐性瓶颈**——wave 中前 3 个 worker 抢到 browser-slot-0..2，剩余 worker 进入 `min(60s, 0.25×timeout)` 等待（典型 ~45s），超时后 **fail-open**（`OneWeb/index.js:1180`）强行闯入，导致：(a) 3+burst 模式退化——限流失效；(b) 等待时间计入子进程预算，后发 worker 有效自动化时间缩水；(c) 等待期间持有 provider lock，阻塞 fallback 链。**推荐**：派发 ≥6 worker 时设 `AGENTCHAT_MAX_CONCURRENT_PAGES=8`（取值 1–16），与 `AGENTCHAT_MAX_TABS_PER_PROVIDER` 一并写入 `settings.json` 的 `env` 块。

**Prompt 生成**：用 App A 模板（或 `index.js` 内置展开）。禁止手写。硬性约束：语言一致、长度 ≤400/600 词、扁平化无子编号、禁止角色设定、嵌入作者材料。

## Step 2：JSON Plan 格式与派发

**传统格式**（每组自带完整 prompt）：
```json
{
  "exclude": ["claude"],
  "subtasks": [
    {
      "id": "group_x", "primary": "gemini", "depends_on": [],
      "questions": ["P01", "P02"], "prompt": "…[ANSWER P01]…[ANSWER P02]…"
    }
  ]
}
```

**压缩格式**（推荐，省 ~3K token）：加 `shared` + `questionBank`，省略 `prompt`（index.js 自动展开）。见 Step 0.5.4。

**派发**（v25 优化，省 ~5K token）：
```bash
# lint
node ~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js --lint /tmp/agentchat_plan.json

# dispatch（--summary-only: 终端只输出一行 JSON；--raw-out: 完整原始输出写文件）
node ~/.claude/skills/AgentChat-IndependentTasks/index.js \
  --plan=/tmp/agentchat_plan.json \
  --summary-only --raw-out=/tmp/agentchat_raw.txt
```

**Decomposer 陷阱**：始终用 `--plan=<file>` + `--lint`，避免 JSON 破坏后落入 AI 重分解路径。

## Step 2.5：内容校验门（强制，机器执行）

```bash
OUTDIR="/tmp/agentchat_answers_$(date +%H%M%S)"
node ~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js \
  /tmp/agentchat_plan.json /tmp/agentchat_raw.txt --out="$OUTDIR"
```

输出：`clean/<id>.txt` + `clean/all_clean.txt`（合并文件，合成只需一次 Read）+ `validation_report.json` + `semantic_check.json`。

退出码非 0 → L1；仍失败 → L2。semantic_check.json：Read → 逐条改 verdict（MATCH/MISMATCH）→ Write 回同一路径。`md2pdf.sh` 遇 PENDING/MISMATCH 拒绝编译。

## Step 3：合成教科书式解答手册

**推荐方式**（省 ~10K token）：用 `synthesize.js` 自动生成 → Claude Code 只做最终审校。

```bash
node ~/.claude/skills/AgentChat-IndependentTasks/synthesize.js \
  --clean="$OUTDIR/clean" \
  --meta=/tmp/tasks_extracted.json \
  --out=/tmp/solutions.md
```

脚本自动：剥离锚行复述句 → 提取 Key Result 框 → 按 reviewer 分组 → 生成封面+TOC+解答+汇总表。Claude Code 只需 Read `/tmp/solutions.md` → 微调措辞/修正 Key Result → Write 回。

**手动回退**：Read `clean/all_clean.txt`（一次）→ 逐题融合/重写（统一第三人称学术口吻）→ 末尾 Key Result 框 → Write solutions.md。

## Step 4：PDF 生成

```bash
export AGENTCHAT_VALIDATED_DIR=/tmp/agentchat_answers_XXXXXX
bash ~/.claude/skills/AgentChat-IndependentTasks/md2pdf.sh /tmp/solutions.md output.pdf
```

Markdown：YAML 封面 → `#outline()` → `## Problem N: 标题` → `**Question:**` → `**Solution:**`（LaTeX `$$...$$`）→ `**Key Result:**`（`> ` 引用块）。

禁止：provider 名称/徽章、覆盖矩阵、审计报告、"Generated by…"。

Typst 不可用时回退 WeasyPrint + `math_render.py`。
