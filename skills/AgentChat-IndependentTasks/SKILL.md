---
name: AgentChat-IndependentTasks
description: 并行分发 N 道相互独立的任务（如习题、翻译段落、独立小问题）给 M 个浏览器自动化 AI（Gemini/ChatGPT/Qwen/Kimi/MiniMax/MiMo/DeepSeek），回收后由 Claude Code 合成为单一权威答案，输出教科书式解答手册 PDF。凡用户提出"把这些题分给多个 AI 做"、"N 道独立习题"、"并行问多个 AI 然后汇总成一份干净的 PDF/解答手册"等需求时必须使用本 skill，即使用户没有明确说出 skill 名称。不适用于需要 AI 之间协作、角色分工或交叉审阅的任务。
---

# AgentChat-IndependentTasks：独立任务并行分发 + 解答手册合成

## 核心模型（先读这一节）

本 skill 解决一类特定问题：**N 道相互独立的任务，M 个能力等同的 AI，纯分发、零协作**。

```
Chrome 页面 / 用户输入
   │ Step 0: CDP 爬取（主页面一次提取，90% 规则，防重复）
   ▼
N 道独立题目
   │ Step 1: 按主题分组 → M 组（M = 可用 AI 数）
   ▼
JSON Plan（每组 → 一个 AI，同一 prompt 模板）
   │ Step 2: node index.js '<JSON>' 并行派发
   ▼
M 份原始回答（中间产物，仅 Claude Code 阅读）
   │ Step 3: 合成——每题一个权威答案，统一学术口吻重写
   ▼
教科书式解答手册（Markdown → Pandoc → Typst → PDF）
```

### 三条铁律

1. **AI 之间无角色差异。** 所有 AI 使用同一 prompt 模板，只是拿到不同的题目子集。禁止为不同 AI 编写"研究员/推理者/审阅者"式的差异化指令。
2. **每题一个规范答案。** 最终 PDF 中每道题只有一份权威解答。若某题被发给多个 AI，由 Claude Code 择优或融合后以统一口吻重写——绝不并列展示多个版本。
3. **零 AI 署名。** 最终产物中不得出现任何 provider 名称、徽章、覆盖矩阵、共识矩阵、审计报告或 AI 元数据附录。读者看到的必须是一本普通的解答手册，看不出它是多个 AI 生成的。

## 强制执行规则（不可跳过、不可绕过）

本节规则任何情况下不得在执行时修改或省略（v19 修订：规则 #4 引入分级降级协议，新增规则 #5 内容校验门）。

1. **必须真实派发。** 一切 AI 查询必须通过以下命令实际执行，禁止 Claude Code 自行代答后伪装成 AI 回答：
   ```bash
   node ~/.claude/skills/AgentChat-IndependentTasks/index.js '<JSON Plan>'
   ```

2. **必须生成运行回执（receipt）。** 每次派发由 `skills/lib/receipt.js` 生成机器可校验的运行回执。回执缺失 = 未执行。合成阶段开始前必须校验回执存在且与本次 Plan 匹配。

3. **禁止修改基础设施。**
   - 编排层 `~/.claude/skills/AgentChat-IndependentTasks/index.js`：只读，禁止改动。
   - Provider 层 `~/.claude/skills/AgentChat-OneWeb/index.js`：只读，禁止改动。
   - 本 skill 的所有改动只发生在 SKILL.md 与合成阶段的 HTML/CSS 生成逻辑。

4. **失败必须显式上报，并按分级降级协议处理。** 失败包括：provider 超时/桥接失败，以及 Step 2.5 内容校验判定的答非所问。处理路径**只有**以下三级，逐级执行：
   - **L1（自动，允许在同一回合内完成）**：对失败/校验不通过的题目组，自动补发**一次**——改派 fallback 链上的下一个可用 provider，重新执行 Step 2 派发与 Step 2.5 校验。
   - **L2（必须停下等用户）**：L1 补发后仍失败的组，输出失败报告（组 ID、涉及题目、失败原因、已尝试的 provider），并给用户两个选项后 **STOP**：(a) 按用户指定方案再补发；(b) 用户明确授权后，生成**部分 PDF**，缺答题目以 `> ⚠ 本题答案待补（AI 派发失败）` 占位块显式标出。
   - **绝对禁止**：Claude Code 自答填补缺失题目并混入 PDF；在同一回合内既报告失败、又擅自生成"完整"PDF。"上报失败"与"绕过失败继续产出完整品"互斥——报告了失败，本回合就只能走 L1 补发或在 L2 停下。

5. **合成前必须通过内容校验门（机器强制，不可用肉眼检查替代）。** receipt 只证明"浏览器桥接成功返回了文本"，**不证明**"文本回答的是被派发的题目"（历史事故：receipt `failed:0` 但 3/7 回答答非所问）。派发完成后、Step 3 合成开始前，必须执行：
   ```bash
   node ~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js <plan.json> <raw_output_or_dir>
   ```
   该脚本校验每题锚行 `[ANSWER <全局ID>]` 是否逐字出现、是否出现不属于该组的外来锚（模型自行改编号的信号），并剥离 provider 噪声（首部时间戳、尾部头像/logo URL）。**退出码非 0 时禁止进入 Step 3**，转入规则 #4 的 L1。合成材料一律使用脚本输出的 `clean/` 目录内容，不使用原始 stdout。

## Step 0：网页内容爬取（当题目来源为浏览器页面时）

当用户要求从当前 Chrome 页面爬取题目时，直接使用自带的 Playwright 爬虫：

```bash
node ~/.claude/skills/AgentChat-OneWeb/moodle_scraper.js --detail-timeout=15000 --max-detail=15
```

该爬虫自动完成：
1. 通过 CDP 连接已打开的 Chrome（需课程页面已在 Chrome 中打开）
2. 从课程主页提取所有 assignment/forum 活动节点
3. 对缺少内联题目的作业，并行打开详情页获取完整描述 + 附件文件 URL
4. 输出 JSON：含 title、url、questionText、files 等字段

**图片附件处理**：若题目内容在附件图片中（questionText 仅含"见附件图片"），从标题和上下文（对应章节知识点）判断题目内容即可。无需 OCR 图片。

## Step 1：题目分组与 AI 分配

**输入**：N 道独立题目（来自 Step 0 爬取结果，或用户直接提供原文，可为中文/英文/混合）。

**按主题聚类分组。** 将 N 题分成 M 组（M = 本次可用 AI 数，最多 7：gemini / chatgpt / qwen / kimi / minimax / mimo / deepseek）。分组原则：
- 同主题的题目放同一组（如"量子力学推导类"、"群论/特征标表类"、"光谱项与塞曼效应类"），使单个 AI 的上下文集中。
- 各组题量尽量均衡；难题多的组可少放几题。
- N < M 时只启用 N 个 AI；不为凑数拆题。

**高上下文任务优先 1 题/组。** 对"审稿意见回复"、"逐条答复"类每题自带大段上下文的任务：只要 N ≤ M（题数不超过可用 AI 数），**必须** 1 题 1 组，禁止为省 AI 而合组（历史事故：2 个双题组 0/2 命中，5 个单题组 4/5 命中）。N > M 时才允许合组，且必须遵守下方锚定模板。

**可选冗余。** 对特别关键或易错的题，可将同一题放进 2 个组（发给 2 个 AI），供 Step 3 择优。默认不冗余。

**全局 ID 与本地重编号。** 每道题分配一个全局 ID（如 `R2Q3` = Reviewer 2 Question 3；习题可用 `P07`）。组内题目一律按本地顺序重编号为「任务 1..任务 k」，全局 ID 以方括号附注。**禁止把原始来源编号（如审稿人的 "(2)"、"(3)"）作为组内唯一标识**——模型看到 "Question (2)/(3)" 会自行推断出不存在的 "(1)" 并作答（历史事故的直接成因）。

**同一 prompt 模板（锚定版）。** 每个 AI 的 prompt 自包含（含完整题目原文），模板统一：
```
请完成以下 {k} 道相互独立的任务。公式用 LaTeX 表示。
直接开始作答，不要寒暄，不要询问澄清。

硬性格式要求（违反即视为无效回答）：
1. 每道任务的解答第一行必须单独输出锚行，逐字复制：[ANSWER {全局ID}]
2. 锚行之后，用一句话复述该任务问的是什么，再开始正式作答。
3. 只回答下方清单中列出的任务。禁止推断、补充、合并或重新编号任何未列出的任务。

【背景（全组共享，≤150 字）】{仅一段，放且只放一次}

【任务 1】[ANSWER {全局ID_1} 对应题]
题目原文（逐字引用）：{原文}
{若源文档含作者已有草稿/部分答案：}作者已有思路（必须遵循，展开而非推翻）：{草稿原文}
本题要求：{1. 2. 3.（≤5 条）}

【任务 2】……
```
硬性约束：
- 禁止任何角色设定（"你是审稿回复专家/XX 教授"）、语气指示或 AI 差异化内容。角色设定 + 400–700 词长 prompt 是历史事故中 3/7 答非所问的诱因之一——上下文越长、结构越花哨，web AI 对"具体回答哪道题"的注意力越弱。
- 共享背景压缩到 ≤150 字且只出现一次；每题上下文放在该题的【任务 n】块内，不与其他题交叉引用。
- **作者已有材料必须入 prompt。** 若题目来源文档（如 Response Letter .docx）中已含作者对某题的草稿、要点或既定方案（哪怕只有一句"补充 pz/px 轨道贡献到 SI"），必须逐字提取并以"作者已有思路"字段嵌入对应任务块，并要求 AI 与之保持一致地展开。禁止丢弃已有材料让 AI 白手起家——生成的答案可能与作者既定方案矛盾。

## Step 2：JSON Plan 格式

```json
{
  "subtasks": [
    {
      "id": "group_quantum",
      "primary": "gemini",
      "depends_on": [],
      "questions": ["推导氢原子波函数", "p²光谱项", "朗德因子"],
      "prompt": "请回答以下光谱学习题：……直接给出完整解答。"
    },
    {
      "id": "group_grouptheory",
      "primary": "chatgpt",
      "depends_on": [],
      "questions": ["C3v 特征标表应用", "振动模式对称性分类"],
      "prompt": "请回答以下光谱学习题：……直接给出完整解答。"
    }
  ]
}
```

**字段约定**：
- `id`：组名，语义化（`group_<主题>`），仅内部使用，不出现在最终 PDF。
- `primary`：承接该组的 provider 名。
- `depends_on`：**恒为 `[]`。** 独立任务模型下不存在依赖；出现非空 depends_on 即为设计错误。
- `questions`：该组题目的**全局 ID 列表**（如 `["R2Q2","R2Q3"]`），与 prompt 中锚行的 `[ANSWER <ID>]` 一一对应。Step 2.5 校验与 Step 3 对账均以此列表为准，因此必须使用 ID 而非自由文本描述。
- `prompt`：发给该 AI 的完整自包含 prompt（含题目全文，遵循 Step 1 锚定模板）。

**派发**（v19：优先文件/stdin 传参，禁止大 JSON 走 argv）：
```bash
# 首选：写入临时文件，用 --plan 传路径（任意大小的 plan 都安全）
cat > /tmp/agentchat_plan.json <<'PLAN'
{ "subtasks": [ ... ] }
PLAN
node ~/.claude/skills/AgentChat-IndependentTasks/index.js --plan=/tmp/agentchat_plan.json | tee /tmp/agentchat_raw.txt

# 等价：stdin 管道
node ~/.claude/skills/AgentChat-IndependentTasks/index.js < /tmp/agentchat_plan.json | tee /tmp/agentchat_raw.txt
```
argv 直传 `'<JSON>'` 仅允许用于 <8KB 的小 plan；超过后存在 shell 截断/转义破坏风险——JSON 被破坏时 `tryParsePreDecomposedPlan` 解析失败，会静默降级为对乱码文本做 AI 重分解。

**同 provider 并发（可选）**：当 N（题组数）> M（provider 数）导致轮转分配下 gemini/chatgpt 各承担 2+ 组时，同 provider 的任务默认串行（共享 tab 互斥锁）。设置环境变量后可开多 tab 真并发（每个任务独立临时 tab，完成即关闭）：
```bash
AGENTCHAT_MAX_TABS_PER_PROVIDER=2 node ~/.claude/skills/AgentChat-IndependentTasks/index.js --plan=/tmp/agentchat_plan.json
```
取值 1–4，默认 1（保持旧行为）。开启后注意同一账号并发对话可能触发 provider 侧限流，建议从 2 开始。

所有 subtask 并行执行。执行完毕后校验 receipt——然后**必须**通过 Step 2.5，才能进入 Step 3。

## Step 2.5：内容校验门（强制，机器执行）

receipt 只覆盖桥接层（CDP 超时、provider 失败），无法发现"模型流畅地回答了另一道题"。本步骤把「强制执行规则 #5」落成机器检查：

```bash
node ~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js <plan.json> /tmp/agentchat_raw.txt --out=/tmp/agentchat_answers
```

脚本行为：
1. 从原始输出按 `══════ <id> …` 分隔符切出各组回答（也接受"每组一个 `<id>.txt` 文件"的目录输入）。
2. **噪声剥离**（provider UI 污染的 B 层兜底）：剥离回答首部粘连的时间戳（如 Qwen 的 `12:42:00`）、尾部的裸 URL 行 / markdown 图片行（Kimi 头像、MiMo logo）。
3. **锚校验**：每个全局 ID 的 `[ANSWER <ID>]` 锚行必须逐字出现；出现**不属于该组**的外来锚（如组内只有 R2Q2/R2Q3 却出现 `[ANSWER R2Q1]`）判 FAIL——这是模型自行改编号/答错题的确定性信号。
4. 输出清洗后的 `--out` 目录（`clean/<id>.txt`）+ `validation_report.json`；任一组 FAIL 则退出码 2。

退出码非 0 → 按「强制执行规则 #4」L1 自动补发失败组一次；补发后重跑本步骤。仍失败 → L2 停下等用户。

**Claude Code 在校验通过后仍需做一次语义抽查**（锚行后的"一句话复述"是否与题目一致）——锚校验挡住编号漂移，语义抽查挡住"锚对了但内容跑偏"。抽查发现问题同样走规则 #4。

## Step 3：合成教科书式解答手册

合成材料 = Step 2.5 输出的 `clean/` 目录（已剥离噪声、已通过锚校验），**不是**原始 stdout。原始 AI 回答是中间产物，只供 Claude Code 阅读，不直接进入 PDF。

对每一道题：

1. **对账。** 用 `questions`（全局 ID）核对 `validation_report.json` 中该题状态为 PASS；缺答/FAIL 题目按「强制执行规则 #4」分级降级处理——注意 L2 场景下生成部分 PDF 需用户明确授权，且占位块必须显式可见。
2. **择优/融合。** 单一回答 → 直接采用为底稿；多个回答 → 比较推导正确性、完整性、数值一致性，择优或取各自正确部分融合。发现回答有明显错误（量纲、符号、数值）时修正之。
3. **统一口吻重写。** 以教科书解答手册的学术口吻重写全文：陈述式、第三人称、无"作为 AI"、无口语填充、无 markdown 痕迹。全书术语与符号约定统一（如 ℏ、cm⁻¹、光谱项记号）。
4. **提炼 Key Result。** 每题解答末尾提炼 1–3 行最终结果（公式或数值），放入 key-result 框。
5. **最终审校。** 通读全书解答，确保术语一致、符号统一、数值正确，无 AI 生成痕迹。

## Step 4：PDF 生成 — Pandoc + Typst 管道

**首选方案：Pandoc (Markdown → Typst) → Typst compile → PDF。**

Typst 是现代排版引擎，提供 LaTeX 级别的数学公式和排版质量，但编译速度极快（毫秒级）。使用 pandoc 作为中间层自动将 AI 输出的 LaTeX 数学转换为 Typst 语法。

### 依赖

- `pandoc` — Markdown/LaTeX → Typst 转换器（系统已安装）
- `typst` (v0.15+) — 编译 .typ 文件为 PDF（系统已安装：`~/.local/bin/typst`）
- 无需 LaTeX 发行版（texlive）、无需 JavaScript、无需 SVG 公式预渲染

### 管道流程

```
AI 回答 (Markdown + LaTeX math)
  │
  ▼
Claude Code 合成 Markdown 文档（合并 + 统一口吻重写）
  │
  ▼
bash ~/.claude/skills/AgentChat-IndependentTasks/md2pdf.sh solutions.md 光谱学作业解答.pdf
  │   （内部：pandoc -t typst → 自动注入兼容 shim + 页面模板 → typst compile）
  ▼
Professional PDF (native math, proper typography)
```

**必须使用 `md2pdf.sh`，禁止手动裸跑 `pandoc | typst`。** 原因是 pandoc 的 typst writer 与新版 Typst 存在已知不兼容（每次手跑都要手工修补，故封装为脚本一次解决）：

| 症状 | 成因 | shim 修复 |
|------|------|-----------|
| `unknown variable: horizontalrule` | pandoc 对 `---` 输出 `#horizontalrule`，该函数仅存在于 pandoc 的 standalone 模板中；非 standalone 输出缺定义 | 前置注入 `#let horizontalrule = align(center, line(...))` |
| `can only be used when context is known`（页码） | Typst 0.11+ 要求 `counter(page).display()` 包裹于 `context`，pandoc 与旧模板均不生成 | 模板 footer 写作 `context counter(page).display()` |
| 目录不出 | `#table.of_contents()` 不是 Typst 函数 | 正确写法 `#outline()`，shim 已内置 |

若 pandoc/typst 升级后出现新的不兼容符号，修 `md2pdf.sh` 的 shim 段，不要退回手工修补。

### Typst 模板规范

使用 Typst 内置功能构建教科书式解答手册，无需额外模板包。核心设置：

```typst
#set page(
  paper: "a4",
  margin: (x: 2cm, y: 2.5cm),
  header: align(right, text(size: 7pt, fill: gray)[课程名 · Solutions]),
  // Typst 0.11+：counter(...).display() 必须在 context 内，否则编译失败
  footer: context align(center, text(size: 7pt, fill: gray)[#counter(page).display()])
)
#set text(font: ("Libertinus Serif", "Noto Sans CJK SC"), size: 10.5pt, lang: "en")
#set par(justify: true, leading: 0.65em)
```

以上模板已内置于 `md2pdf.sh` 的 shim 段（含 `#let horizontalrule` 定义），正常情况下无需手写。

### 每题 Markdown 结构（直接输入 pandoc）

```markdown
# Problem 1: 氢原子径向波函数的推导

**Question:** 从薛定谔方程出发，推导氢原子的波函数表达式。

**Solution:**

[解答正文，LaTeX 数学原生嵌入]

$$-\frac{\hbar^2}{2\mu}\nabla^2\psi - \frac{e^2}{4\pi\epsilon_0 r}\psi = E\psi$$

**Key Result:** 基态波函数 $\psi_{100} = \frac{1}{\sqrt{\pi a_0^3}}e^{-r/a_0}$。
```

### 文档结构

1. 封面（Typst `#align(center)` + 标题 + 元数据）
2. 目录（`#outline()` —— 注意不是 `#table.of_contents()`，后者不存在，Typst 会报 unknown function）
3. 各题解答（按 Problem 1, 2, ... 排列）

### 明确禁止出现在 PDF 中的元素

Provider 卡片、AI 名称/徽章、覆盖矩阵、共识矩阵、审计报告、"Generated by …" 字样、AI 元数据附录、逐题来源标注。**以上任一元素出现即为实现错误。**

### Typst 相比 WeasyPrint 优势

| | WeasyPrint (旧) | Typst (新) |
|---|---|---|
| 数学公式 | 需 `math_render.py` 预渲染为 SVG，CJK 字体问题 | **原生渲染**，矢量数学，无中间步骤 |
| 排版质量 | 浏览器级 CSS，flexbox/grid 不可靠 | **专业排版引擎**，kerning、hyphenation、widow/orphan 控制 |
| 分页 | CSS page-break 属性不可预测 | **确定性分页** |
| PDF 体积 | 1.7 MB（382 个 SVG 嵌入） | **预计 <200 KB**（纯矢量文本） |
| 编译速度 | ~30s（SVG 渲染） | **<1s** |
| 字体 | 需 `@font-face` 手动嵌入 | 系统 Fontconfig 自动发现 |

### 备用方案

若 Typst 不可用，回退到 WeasyPrint + `math_render.py`（旧管道，公式需预渲染为 SVG）。

## 文件位置

- 本文件：`~/.claude/skills/AgentChat-IndependentTasks/SKILL.md`
- 编排层（只读）：`~/.claude/skills/AgentChat-IndependentTasks/index.js`
- Provider 层（只读）：`~/.claude/skills/AgentChat-OneWeb/index.js`
- 内容校验门：`~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js`
- PDF 管道封装：`~/.claude/skills/AgentChat-IndependentTasks/md2pdf.sh`
- 运行回执库：`skills/lib/receipt.js`
- 公式渲染器（备用）：`~/.claude/skills/AgentChat-IndependentTasks/math_render.py`
- Typst 二进制：`~/.local/bin/typst`
