# کتابخانه الگوهای Prompt

> این الگوها **تنها منبع قانونی** برای تولید prompt هستند. Claude Code باید از جایگزینی رشته‌ای برای پر کردن متغیرهای الگو استفاده کند — نوشتن دستی بدنه prompt ممنوع است. الگوها در حال حاضر شامل الزامات فرمت، قوانین سطر لنگر و محدودیت‌های سخت هستند. فقط `{BG}` (پیشینه) و `{TASKS_BLOCK}` (بلوک تسک) نیاز به پر شدن دارند.

## الگوی تک‌تسکه انگلیسی (≤۴۰۰ کلمه)

```
Please complete the following 1 independent task. Use LaTeX for formulas. Begin answering directly.

Hard format requirements (violation = invalid answer):
1. The first line of the answer MUST output verbatim: [ANSWER {ID}]
2. After the anchor line, restate the task in one sentence, then provide the formal answer.
3. Only answer the listed task. Do not infer, supplement, merge, or renumber.

Background: {BG}

{TASKS_BLOCK}
```

## الگوی دو-تسکه انگلیسی (≤۶۰۰ کلمه)

```
Please complete the following 2 independent tasks. Use LaTeX for formulas. Begin answering directly.

Hard format requirements (violation = invalid answer):
1. The first line of each answer MUST output verbatim the anchor line: [ANSWER {ID1}] for Task 1, [ANSWER {ID2}] for Task 2.
2. After each anchor line, restate the task in one sentence, then provide the formal answer.
3. Only answer the listed tasks. Do not infer, supplement, merge, or renumber.

Background: {BG}

{TASKS_BLOCK}
```

## الگوی تک‌تسکه چینی (≤۴۰۰ کاراکتر)

```
请完成以下 1 道独立任务。公式用 LaTeX 表示。直接开始作答。

硬性格式要求（违反即视为无效回答）：
1. 解答第一行必须逐字输出锚行：[ANSWER {ID}]
2. 锚行后先一句话复述任务，再正式作答。
3. 只回答列出的任务，禁止推断、补充、合并、重新编号。

背景：{BG}

{TASKS_BLOCK}
```

## الگوی دو-تسکه چینی (≤۶۰۰ کاراکتر)

```
请完成以下 2 道相互独立的任务。公式用 LaTeX 表示。直接开始作答。

硬性格式要求（违反即视为无效回答）：
1. 每道任务解答第一行必须逐字输出锚行：[ANSWER {ID1}]（任务 1）、[ANSWER {ID2}]（任务 2）
2. 锚行后先一句话复述任务，再正式作答。
3. 只回答清单中的任务，禁止推断、补充、合并、重新编号。

背景：{BG}

{TASKS_BLOCK}
```

## قوانین قالب‌بندی `{TASKS_BLOCK}`

`{TASKS_BLOCK}` توسط `format_tasks_block(group)` تولید می‌شود. فرمت هر تسک:

```
【Task {n}】[ANSWER {ID}]
{question text — verbatim from source}
Author thoughts (≤2 sentences, follow and expand rather than overturn): {author_draft or "None. Please analyze independently based on physical principles."}
Requirements: {REQ1}. {REQ2}. {REQ3}.
```

`{REQ1}..{REQ3}` به صورت خودکار از جدول زیر بر اساس نوع سوال تطبیق داده می‌شوند (**هرگز دست‌نویس نشوند**):

| نوع | محرک‌ها | الگوی الزامات |
|------|----------|---------------------|
| explain | Why, Explain, 为什么，解释 | 1. Explain the physical mechanism. 2. Relate to the computational/experimental results. 3. Frame as a concise reviewer response. |
| compare | Compare, Discuss, compare, 比较，讨论 | 1. Provide systematic comparison across all mentioned items. 2. Explain observed trends using fundamental physical/chemical arguments. 3. Draft for direct manuscript inclusion. |
| provide | Provide, Show, Give, calculate, 提供，给出 | 1. Describe the requested data/calculation/analysis. 2. Explain its significance for the manuscript's conclusions. 3. Suggest exact location and format for manuscript/SI addition. |
| clarify | Clarify, Justify, 澄清，说明 | 1. Answer the specific concern directly and concisely. 2. Cite relevant literature or methodological justification. 3. Describe the exact revisions made to the manuscript. |
| literature | literature, cite, 文献 | 1. Cite specific literature with journal/year. 2. Explain the physical mechanism connecting the literature to this work. 3. Connect the evidence to the BPQD/system studied. |
| mixed | (مخلوط یا بدون تطابق) | 1. Address the question's primary concern directly. 2. Provide supporting reasoning or data. 3. Suggest concrete manuscript revision if applicable. |

## الگوی استخراج پیشینه `{BG}`

`{BG}` به صورت خودکار از پاراگراف‌های ابتدایی سند چکیده می‌شود — **هرگز دست‌نویس نشود**. الگوی چکیده:

```
This [theoretical/experimental] study investigates [WHAT] in [SYSTEM]
using [METHOD]. [ONE-SENTENCE KEY FINDING].
```

- انگلیسی: ≤۱۰۰ کلمه
- چینی: ≤۱۵۰ کاراکتر
- همه گروه‌ها `{BG}` یکسان به اشتراک می‌گذارند — برای هر گروه بازنویسی نشود

## مثال استفاده

```python
# شبه‌کد — Claude Code جایگزینی رشته‌ای انجام می‌دهد، نه اجرای اسکریپت
from templates import PROMPT_SINGLE_EN, PROMPT_DUAL_EN
from rules import derive_requirements, format_tasks_block

BG = tasks_extracted["background"]  # از JSON مرحله ۰.۵b

for group in groups:
    k = len(group["questions"])
    template = PROMPT_SINGLE_EN if k == 1 else PROMPT_DUAL_EN
    tasks_block = format_tasks_block(group)  # با استفاده از قوانین A.5

    prompt = template.replace("{K}", str(k)) \
                     .replace("{BG}", BG) \
                     .replace("{TASKS_BLOCK}", tasks_block) \
                     .replace("{ID}", group["questions"][0]) \
                     .replace("{ID1}", group["questions"][0]) \
                     .replace("{ID2}", group["questions"][1] if k > 1 else "")

    # prompt اکنون کامل، مستقل و مطابق فرمت است
    group["prompt"] = prompt
```

## چک‌لیست اجباری

هنگام استفاده از این مهارت، Claude Code **باید**:

- [ ] سند منبع را دقیقاً یک بار بخواند (۰.۵.۱)
- [ ] خروجی ساختاریافته `/tmp/tasks_extracted.json` را در یک پاسخ تولید کند (۰.۵.۲)
- [ ] `{BG}` به صورت خودکار از سند چکیده شود، ≤۱۰۰ کلمه (۰.۵.۳)
- [ ] prompt هر گروه از الگوها تولید شود، هرگز دست‌نویس نشود (۰.۵.۴)
- [ ] الزامات `{TASKS_BLOCK}` به صورت خودکار از جدول A.5 تطبیق داده شوند، هرگز دست‌نویس نشوند
- [ ] Plan JSON از طریق heredoc در `/tmp/agentchat_plan.json` نوشته شود
- [ ] هرگز سند منبع را برای بار دوم نخواند
