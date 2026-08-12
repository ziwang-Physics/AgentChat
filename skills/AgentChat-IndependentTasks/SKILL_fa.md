# راهنمای مهارت AgentChat-IndependentTasks

## ⛔ مرزهای نقش

شما **فراخوانی‌کننده** این خط لوله هستید و فقط سه کار انجام می‌دهید: آماده‌سازی ورودی → فراخوانی اسکریپت → گزارش نتایج. ممنوع است که به صورت دستی هر یک از مراحل خط لوله را شبیه‌سازی کنید (استخراج سوالات، گروه‌بندی، نوشتن prompt، بازبینی پاسخ‌ها، کامپایل PDF).

## مدل اصلی

N تسک مستقل، M هوش مصنوعی با توانایی برابر (حداکثر ۷ تا: gemini/chatgpt/qwen/kimi/minimax/mimo/deepseek)، توزیع خالص، بدون همکاری.

```
سوالات → گروه‌بندی بر اساس موضوع → Plan JSON → اجرای موازی با node index.js → اعتبارسنجی → ترکیب → md2pdf.sh → PDF
```

**سه قانون آهنین**:
1. همه هوش مصنوعی‌ها از یک الگوی prompt یکسان استفاده می‌کنند، فقط زیرمجموعه سوالات متفاوت است. ممنوع است تنظیمات نقش متفاوت ایجاد کنید.
2. هر سوال یک پاسخ معتبر دارد (بهترین یا ترکیب شده، با لحن یکسان بازنویسی شود)، نمایش چند نسخه به صورت موازی مجاز نیست.
3. بدون نام هوش مصنوعی - در PDF نباید نام provider/نشان/ماتریس پوشش/گزارش حسابرسی/فراداده AI ظاهر شود.

## قوانین اجرایی اجباری (غیرقابل پرش، غیرقابل دور زدن)

1. **ارسال واقعی الزامی است.** تمام پرس‌وجوهای AI باید از طریق `node ~/.claude/skills/AgentChat-IndependentTasks/index.js` به صورت واقعی اجرا شوند، Claude Code حق ندارد به صورت خودکار پاسخ دهد.

2. **تولید رسید اجرایی (receipt) الزامی است.** توسط `skills/lib/receipt.js` تولید می‌شود، فقدان رسید = عدم اجرا.

3. **سطح‌بندی تغییرات فایل:**
   - **منجمد (فقط خواندنی)**: `index.js` (لایه orchestration)، `AgentChat-OneWeb/index.js` (لایه Provider)
   - **کتابخانه مشترک (تغییر نیازمند تست متقاطع + آزمون کامل)**: `lib/*.js` (شامل `lib/plan.js`، `lib/execute.js`، `lib/locks.js` و غیره)
   - **قابل تغییر آزادانه**: `SKILL.md`، `synthesize.js`، `validate_answers.js`، `md2pdf.sh`

4. **پروتکل降级 سطح‌بندی شکست.** شکست = timeout provider/شکست پل/پاسخ نامربوط Step 2.5. سه مسیر:
   - **L1 (خودکار)**: ارسال مجدد، هدایت به provider بعدی در زنجیره fallback. شکست لنگر خارجی (اختلال مسیریابی) → ارسال مجدد سریال به هر گروه؛ تشخیص فقدان/جعل سطر لنگر (امتناع از پاسخ/پاسخ خالی bridge) → ارسال مجدد موازی.
   - **L2 (توقف و انتظار کاربر)**: پس از L1 همچنان شکست → گزارش شکست + دو گزینه (کاربر طرح مشخص کند برای ارسال مجدد / مجوز تولید PDF ناقص، پاسخ‌های缺失 با `> ⚠ پاسخ این سوال در حال تکمیل` جایگزین شود) سپس STOP.
   - **مطلقاً ممنوع**: پاسخ خودکار Claude Code برای پر کردن خلاء / گزارش شکست در همان دور و سپس تولید خودکار PDF "کامل".

5. **عبور اجباری از دروازه اعتبارسنجی محتوا قبل از ترکیب (اجرای ماشینی).** پس از ارسال باید `validate_answers.js` اجرا شود (اعتبارسنجی ظهور عینی سطر لنگر، تشخیص لنگر خارجی، حذف نویز). کد خروجی غیر ۰ → L1. مواد ترکیب از پوشه `clean/` استفاده می‌شود، نه stdout خام.

6. **قیدهای provider کاربر در `exclude` نوشته می‌شوند، زنجیره fallback و L1 را لغو می‌کنند.** فقط تنظیم نکردن primary کافی نیست — زنجیره fallback به صورت خودکار به providerهای ممنوع هدایت می‌کند. باید در سطح plan `"exclude": ["claude"]` باشد و در ارسال مجدد L1 نیز همین providerها رد شوند.

7. **هر بار validation باید پوشه `--out` منحصر به فرد (با timestamp) داشته باشد.** فایل‌های clean تاریخی در پوشه‌های قدیمی باعث انتخاب اشتباه پاسخ‌ها می‌شود.

8. **semantic_check.json باید "تولید→خواندن→تغییر دسته‌ای verdict→بازنویسی" شود.**
   `validate_answers.js` به صورت خودکار تولید می‌کند، مقدار اولیه `PENDING`.
   باید خوانده شود → بررسی مورد به مورد با سوالات اصلی (بدون پرش هیچ مدخلی) →
   ساخت JSON کامل در حافظه → **یکباره Write به همان مسیر**.
   محدودیت‌ها:
   - فقط فیلدهای `verdict` و `note` اصلاح شوند؛ بقیه فیلدها (`subtask`/`question`/`restatement` و غیره) عیناً حفظ شوند.
   - `note` یک جمله باشد (≤۳۰ کاراکتر)، باید مبنای قضاوت را مشخص کند، ممنوع است کلی‌گویی مثل "محتوا مطابقت دارد".
   - قبل از بازنویسی، صحت JSON自查 شود (فرار نقل قول‌ها، کامای انتهایی).
   - تعداد مدخل‌ها ≤۳时可逐条 Edit；>۳条时必须用 Write 批量替换以节省 token.
   ممنوع است از صفر دست‌نویس شود. `md2pdf.sh` در صورت مواجهه با `PENDING`/`MISMATCH` از کامپایل امتناع می‌کند (کد خروجی ۵).

9. **dispatch چند دوری باید پوشه clean را ادغام کند.** بر اساس آخرین دور، ردیابی معکوس每题首次 PASS 的 `<id>.txt`；对账全量 questions → PASS؛合并 semantic_check.json。ممنوع است بدون ادغام وارد Step 3 شوید.

10. **ممنوع است استقرار کامل M=N (تله بدون fallback).** وقتی همه providerهای موجود به عنوان primary در یک wave ارسال شوند، مکانیسم skipList در `index.js` سایر primaryها را از زنجیره fallback هر worker پیش‌فیلتر و حذف می‌کند — هر worker فقط `[خودش]` باقی می‌ماند، یک شکست یعنی `ALL_EXHAUSTED`. **دفاع**: (الف) همیشه ≥۱ provider را به عنوان primary تنظیم نکنید تا به عنوان "hot-spare" باقی بماند؛ (ب) یا `AGENTCHAT_MAX_TABS_PER_PROVIDER=2` تنظیم کنید تا همزمانی چند tab برای یک provider فعال شود؛ (ج) اگر (الف)(ب) ممکن نبود، تعداد گروه‌های ارسال مجدد L1 ≤ M−1 باشد.

## مرحله ۰: استخراج محتوای وب (فقط وقتی منبع سوالات صفحه مرورگر است)

```bash
node ~/.claude/skills/AgentChat-OneWeb/moodle_scraper.js --detail-timeout=15000 --max-detail=15
```

## مرحله ۰.۵: پروتکل استخراج سریع اسناد محلی (صرفه‌جویی در token)

### ۰.۵.۱ اصل خواندن یک‌باره

سند منبع (.docx/.pdf/.md) **فقط یک بار** خوانده شود. تبدیل `pandoc` یک‌باره → خواندن کامل یک‌باره → خروجی یک‌باره لیست ساختاریافته سوالات.

```bash
pandoc "source.docx" -t markdown -o /tmp/source_tasks.md
```

### ۰.۵.۲ فرمت خروجی استخراج ساختاریافته

پس از خواندن، Claude Code یک‌باره `/tmp/tasks_extracted.json` را خروجی می‌دهد:

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

`question` / `author_draft` عیناً از متن اصلی نقل می‌شوند. `topic` برای گروه‌بندی خودکار استفاده می‌شود. `background` از ابتدای سند ≤۱۰۰ کلمه به صورت خودکار چکیده می‌شود.

### ۰.۵.۳ استخراج خودکار پیشینه

از ~۳۰۰ کلمه اول خروجی `pandoc` چکیده می‌شود: موضوع تحقیق + روش + یافته کلیدی + نام ژورنال. ≤۱۰۰ کلمه انگلیسی، همه گروه‌ها به اشتراک می‌گذارند. الگو:

```
This [theoretical/experimental] study investigates [WHAT] in [SYSTEM]
using [METHOD]. [ONE-SENTENCE KEY FINDING].
```

### ۰.۵.۴ تولید prompt با پرکردن الگو (دست‌نویس ممنوع)

**مطلقاً ممنوع** است که بدنه prompt را برای هر group به صورت دست‌نویس بنویسید. الگوی prompt در `index.js` تعبیه شده است (تابع `expandSharedPlan`)، تعریف الگو در `references/prompt-templates.md` قرار دارد (فقط برای مرجع، وارد context Claude Code نمی‌شود).

**روش توصیه شده**: استفاده از فرمت فشرده plan JSON با `shared` + `questionBank` (صرفه‌جویی ~۳K token در هر بار)، `index.js` به صورت خودکار گسترش می‌دهد:

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

تابع `expandSharedPlan()` در `index.js`: `shared.template` را می‌گیرد تا الگو انتخاب شود → `{BG}` پر می‌شود → از `questionBank` بلوک `{TASKS_BLOCK}` ساخته می‌شود (به صورت خودکار بر اساس `type` با نیازها تطبیق داده می‌شود) → prompt کامل تولید می‌شود. مقادیر `shared.template`: `single_en` | `dual_en` | `single_zh` | `dual_zh`.

**روش عقب‌گرد**: هر subtask فیلد `prompt` کامل دارد (فرمت سنتی)، در این حالت `shared`/`questionBank` اختیاری هستند.

فرمت `{TASKS_BLOCK}`: `【Task {n}】[ANSWER {ID}]` + متن عینی سوال +思路作者 + نیازها (به صورت خودکار بر اساس `type` تطبیق: explain/compare/provide/clarify/literature/mixed).

### ۰.۵.۵ توالی عملیات کامل

```
مرحله ۰.۵a: pandoc source.docx → /tmp/source_tasks.md
مرحله ۰.۵b: یک بار Read → خروجی /tmp/tasks_extracted.json
مرحله ۰.۵c: گروه‌بندی خودکار + تخصیص primary (P ≤ U−1)
مرحله ۰.۵d: تولید Plan JSON (heredoc → /tmp/agentchat_plan.json)
           فرمت فشرده shared+questionBank توصیه می‌شود (صرفه‌جویی ~۳K token)
مرحله ۲:   lint + dispatch (۰ token Claude Code)
```

## مرحله ۱: گروه‌بندی سوالات و تخصیص AI

**اصل گروه‌بندی**: topic یکسان → یک گروه. فقط وقتی N > M (۷) است می‌توان گروه‌ها را ادغام کرد (اولویت پاسخ به داوران: ≤۱ سوال در هر گروه). ID سراسری (مثل `R2Q3`) در هر گروه شماره‌گذاری محلی می‌شود «Task 1..k» و لنگر `[ANSWER <ID>]` ضمیمه می‌شود. ممنوع است از شماره‌گذاری اصلی داوران "(2)/(3)" استفاده کنید.

**محدودیت پیکربندی کامل**: P = تعداد primaryهای منحصربه‌فرد در plan، U = مجموع providerهای موجود پس از حذف exclude.
- P ≤ U−1 (توصیه می‌شود): همیشه ≥۱ hot-spare空闲
- P = U (پرخطر): بدون fallback، `index.js` به صورت خودکار multi-tab را فعال می‌کند (AGENTCHAT_MAX_TABS_PER_PROVIDER=2)
- AGENTCHAT_MAX_TABS_PER_PROVIDER=2: وقتی G > U توصیه می‌شود، مقدار ۱–۴

**مجوز ورود مرورگر**: `AGENTCHAT_MAX_CONCURRENT_PAGES` (پیش‌فرض ۳). این حداکثر همزمانی اتوماسیون مرورگر در سطح跨进程 است，هر زیرپردازنده OneWeb قبل از `tryAllProviders()` از طریق `acquireBrowserSlot()` دریافت می‌کند (`lib/locks.js:161`). **مقدار پیش‌فرض ۳ گلوگاه ضمنی IndependentTasks است** — ۳ worker اول در wave slotهای browser-slot-0..2 را می‌گیرند，workerهای باقیمانده وارد انتظار `min(60s, 0.25×timeout)` می‌شوند (معمولاً ~۴۵s)، پس از timeout **fail-open** (`OneWeb/index.js:1180`) به زور وارد می‌شوند，که منجر به: (الف) تخریب حالت 3+burst — کنترل نرخ از کار می‌افتد؛ (ب) زمان انتظار در بودجه زیرپردازنده محاسبه می‌شود，زمان اتوماسیون موثر workerهای بعدی کاهش می‌یابد؛ (ج) در حین انتظار provider lock را نگه می‌دارند，زنجیره fallback را مسدود می‌کنند. **توصیه**: هنگام ارسال ≥۶ worker، مقدار `AGENTCHAT_MAX_CONCURRENT_PAGES=8` تنظیم شود (مقدار ۱–۱۶)，همراه با `AGENTCHAT_MAX_TABS_PER_PROVIDER` در بلوک `env` فایل `settings.json` نوشته شود.

**تولید Prompt**: از الگوی App A استفاده کنید (یا گسترش داخلی `index.js`). دست‌نویس ممنوع است. محدودیت‌های سخت: زبان یکنواخت، طول ≤۴۰۰/۶۰۰ کلمه، تخت‌سازی بدون شماره‌گذاری فرعی، ممنوعیت تنظیم نقش، جاسازی مواد نویسنده.

## مرحله ۲: فرمت Plan JSON و ارسال

**فرمت سنتی** (هر گروه prompt کامل خود را دارد):
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

**فرمت فشرده** (توصیه می‌شود، صرفه‌جویی ~۳K token): اضافه کردن `shared` + `questionBank`، حذف `prompt` (`index.js` به صورت خودکار گسترش می‌دهد). به مرحله ۰.۵.۴ مراجعه کنید.

**ارسال** (بهینه‌سازی v25، صرفه‌جویی ~۵K token):
```bash
# lint
node ~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js --lint /tmp/agentchat_plan.json

# dispatch (--summary-only: ترمینال فقط یک خط JSON خروجی می‌دهد؛ --raw-out: خروجی خام کامل در فایل نوشته می‌شود)
node ~/.claude/skills/AgentChat-IndependentTasks/index.js \
  --plan=/tmp/agentchat_plan.json \
  --summary-only --raw-out=/tmp/agentchat_raw.txt
```

**تله Decomposer**: همیشه از `--plan=<file>` + `--lint` استفاده کنید، از افتادن در مسیر بازتجزیه AI پس از خرابی JSON جلوگیری کنید.

## مرحله ۲.۵: دروازه اعتبارسنجی محتوا (اجباری، اجرای ماشینی)

```bash
OUTDIR="/tmp/agentchat_answers_$(date +%H%M%S)"
node ~/.claude/skills/AgentChat-IndependentTasks/validate_answers.js \
  /tmp/agentchat_plan.json /tmp/agentchat_raw.txt --out="$OUTDIR"
```

خروجی: `clean/<id>.txt` + `clean/all_clean.txt` (فایل ادغام شده，فقط یک بار Read برای ترکیب نیاز است) + `validation_report.json` + `semantic_check.json`.

کد خروجی غیر ۰ → L1؛ همچنان شکست → L2. semantic_check.json: Read → تغییر verdict به صورت مورد به مورد (MATCH/MISMATCH) → Write به همان مسیر. `md2pdf.sh` در صورت مواجهه با PENDING/MISMATCH از کامپایل امتناع می‌کند.

## مرحله ۳: ترکیب دفترچه راه‌حل به سبک کتاب درسی

**روش توصیه شده** (صرفه‌جویی ~۱۰K token): استفاده از `synthesize.js` برای تولید خودکار → Claude Code فقط بازبینی نهایی را انجام می‌دهد.

```bash
node ~/.claude/skills/AgentChat-IndependentTasks/synthesize.js \
  --clean="$OUTDIR/clean" \
  --meta=/tmp/tasks_extracted.json \
  --out=/tmp/solutions.md
```

اسکریپت به صورت خودکار: حذف سطر لنگر复述句 → استخراج کادر Key Result → گروه‌بندی بر اساس reviewer → تولید جلد+فهرست+راه‌حل‌ها+جدول خلاصه. Claude Code فقط نیاز دارد `/tmp/solutions.md` را بخواند → تنظیم ظرافت‌های لفظی/اصلاح Key Result → Write به همان فایل.

**عقب‌گرد دستی**: خواندن `clean/all_clean.txt` (یک بار) → ادغام/بازنویسی سوال به سوال (لحن آکادمیک سوم شخص یکنواخت) → کادر Key Result در انتها → Write فایل solutions.md.

## مرحله ۴: تولید PDF

```bash
export AGENTCHAT_VALIDATED_DIR=/tmp/agentchat_answers_XXXXXX
bash ~/.claude/skills/AgentChat-IndependentTasks/md2pdf.sh /tmp/solutions.md output.pdf
```

Markdown: جلد YAML → `#outline()` → `## Problem N: عنوان` → `**Question:**` → `**Solution:**` (LaTeX `$$...$$`) → `**Key Result:**` (بلوک نقل قول `> `).

ممنوع: نام provider/نشان، ماتریس پوشش، گزارش حسابرسی، "Generated by…".

در صورت عدم دسترسی به Typst، از WeasyPrint + `math_render.py` به عنوان عقب‌گرد استفاده شود.
