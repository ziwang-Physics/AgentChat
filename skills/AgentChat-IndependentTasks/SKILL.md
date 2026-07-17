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

本节规则与旧版完全一致，任何情况下不得修改或省略。

1. **必须真实派发。** 一切 AI 查询必须通过以下命令实际执行，禁止 Claude Code 自行代答后伪装成 AI 回答：
   ```bash
   node ~/.claude/skills/AgentChat-IndependentTasks/index.js '<JSON Plan>'
   ```

2. **必须生成运行回执（receipt）。** 每次派发由 `skills/lib/receipt.js` 生成机器可校验的运行回执。回执缺失 = 未执行。合成阶段开始前必须校验回执存在且与本次 Plan 匹配。

3. **禁止修改基础设施。**
   - 编排层 `~/.claude/skills/AgentChat-IndependentTasks/index.js`：只读，禁止改动。
   - Provider 层 `~/.claude/skills/AgentChat-OneWeb/index.js`：只读，禁止改动。
   - 本 skill 的所有改动只发生在 SKILL.md 与合成阶段的 HTML/CSS 生成逻辑。

4. **失败必须显式上报。** 任一 provider 超时或失败时，如实报告哪些题目组未获回答，并给出补发方案（重发给同一 AI 或改派其他 AI）；禁止静默跳过或用 Claude 自答填补而不告知用户。

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

**可选冗余。** 对特别关键或易错的题，可将同一题放进 2 个组（发给 2 个 AI），供 Step 3 择优。默认不冗余。

**同一 prompt 模板。** 每个 AI 的 prompt 自包含（含完整题目原文），模板统一：
```
请回答以下{学科}习题。每道题给出完整解答过程与最终结果，公式用 LaTeX 表示。
直接开始作答，不要寒暄，不要询问澄清。

题目 1：{原文}
题目 2：{原文}
...
```
禁止加入任何 AI 特定的角色设定、语气指示或"你是 XX 专家"式差异化内容。

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
- `questions`：该组题目的简短标识列表（用于回执校验与合成阶段对账）。
- `prompt`：发给该 AI 的完整自包含 prompt（含题目全文）。

**派发**：
```bash
node ~/.claude/skills/AgentChat-IndependentTasks/index.js '<上述 JSON>'
```
所有 subtask 并行执行。执行完毕后校验 receipt，再进入 Step 3。

## Step 3：合成教科书式解答手册

原始 AI 回答是中间产物，只供 Claude Code 阅读，不直接进入 PDF。

对每一道题：

1. **对账。** 用 `questions` 列表核对该题是否有回答；缺答题目按「强制执行规则 #4」处理。
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
pandoc solutions.md -f markdown -t typst -o solutions.typ
  │
  ▼
typst compile solutions.typ 光谱学作业解答.pdf
  │
  ▼
Professional PDF (native math, proper typography)
```

### Typst 模板规范

使用 Typst 内置功能构建教科书式解答手册，无需额外模板包。核心设置：

```typst
#set page(
  paper: "a4",
  margin: (x: 2cm, y: 2.5cm),
  header: align(right, text(size: 7pt, fill: gray)[课程名 · Solutions]),
  footer: align(center, text(size: 7pt, fill: gray)[#counter(page).display()])
)
#set text(font: ("Libertinus Serif", "Noto Sans CJK SC"), size: 10.5pt, lang: "en")
#set par(justify: true, leading: 0.65em)
```

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
2. 目录（`#table.of_contents()`）
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
- 运行回执库：`skills/lib/receipt.js`
- 公式渲染器（备用）：`~/.claude/skills/AgentChat-IndependentTasks/math_render.py`
- Typst 二进制：`~/.local/bin/typst`
- 公式渲染器：`~/.claude/skills/AgentChat-IndependentTasks/math_render.py`
