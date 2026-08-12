---
name: AgentChat-OneWeb
description: زنجیره fallback چند ارائه‌دهنده با降级 خودکار (Gemini→ChatGPT→Claude→Qwen→Kimi→MiniMax→MiMo→DeepSeek). برای failover ارائه‌دهنده AI، زنجیره fallback، مسیریابی چند ارائه‌دهنده یا «ارسال به هر AI موجود» استفاده کنید. اجرای اجباری - فراخوانی این skill مستلزم اجرای `node ~/.claude/skills/AgentChat-OneWeb/index.js "<prompt>"` به عنوان اولین اقدام و نقل خط `[receipt] AGENTCHAT_RUN` آن در پاسخ نهایی است؛ توضیح skill یا پاسخ از دانش مدل بدون receipt نقض قوانین است.
---

# زنجیره Fallback چند ارائه‌دهنده AI — پل CDP چند ارائه‌دهنده

> **آخرین به‌روزرسانی**: 2026-07-17  
> **عملکرد اصلی**:降级 خودکار بر اساس اولویت، اطمینان از وجود همیشه یک مدل بزرگ قابل دسترس  
> **لاگ تغییرات**: ببینید [CHANGELOG_fa.md](CHANGELOG_fa.md)

## ⚠️ قوانین اجباری — فراخوانی یعنی اجرا (قرارداد عمل اول)

**هنگامی که این skill فراخوانی می‌شود (مثلاً `/AgentChat-OneWeb <سوال>`), باید دستور `node` را اجرا کنید تا سوال کاربر به AI وب ارسال شود. ممنوع است فقط توضیح دهید بدون اجرا، یا از دانش خود مدل به جای پاسخ AI وب استفاده کنید.**

### ۱. قرارداد عمل اول

**بعد از خواندن این SKILL_fa.md, **اولین فراخوانی ابزار** باید این باشد:**

```bash
node ~/.claude/skills/AgentChat-OneWeb/index.js "<prompt کاربر>"
```

در این میان نباید هیچ مرور فایل، تحلیل معماری، یا توضیح «من خواهم...» قرار گیرد (حداکثر یک خط توضیح درباره دستوری که قرار است اجرا شود). بعد از بازگشت نتیجه از AI وب، می‌توانید تحلیل خود را اضافه کنید.

### ۲. رسید اجرا (receipt) — معیار اجرا همین است، نه توضیح

هر اجرای واقعی (شامل شکست) یک خط receipt تولید شده توسط ماشین در **stderr** خروجی می‌دهد:

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx","skill":"AgentChat-OneWeb","exit":0,"provider_used":"Gemini",...}
```

- **پاسخ نهایی باید عیناً این خط receipt را شامل شود** (حداقل run_id، provider_used، exit).
- بدون receipt = بدون اجرا = نقض قوانین، باید برگردید و اجرا کنید.
- `run_id` به صورت تصادفی تولید و همزمان در `~/.claude/skills/AgentChat-OneWeb/data/receipts.jsonl` ذخیره می‌شود، کاربر می‌تواند با `grep <run_id>` بررسی کند—ساختگی قابل عبور از بررسی نیست.
- **اجرای شکست‌خورده (exit≠0) هم receipt دارد**: باید receipt شکست را نقل و دلیل را توضیح دهید (محدودیت نرخ/وارد نشده/timeout...)، بعد از آن مجازید با توانایی خود مدل پاسخ دهید، و باید صریحاً标注 کنید «AI وب در این پاسخ مشارکت نداشت».

### ۳. الگوهای نقض (همه ممنوع)

- ❌ بعد از خواندن SKILL_fa.md توضیح زنجیره fallback، فهرست پارامترهای CLI، یا تشریح معماری—بدون اجرای `node index.js`
- ❌ با این بهانه که «سوال خیلی ساده است/من جواب را می‌دانم» از اجرا بپرید و مستقیم با دانش مدل پاسخ دهید
- ❌ پاسخ中没有 خط `[receipt] AGENTCHAT_RUN` اما ادعا کنید «از طریق AI وب پردازش شد»

### ۴. استثناها

فقط: `--smoke`،`--doctor`، یا وقتی کاربر صریحاً می‌گوید «فقط محیط را بررسی کن بدون ارسال». این دو حالت receipt تولید نمی‌کنند، رفتار مورد انتظار است.

## 📐 استانداردهای قالب‌بندی خروجی — فرمت اجباری پاسخ نهایی

موضوع محدودکننده **متن نهایی پیاده‌سازی شده** نوشته شده توسط Claude Code است؛ خروجی خام workerها، بلوک‌های کد، diff، جدول‌ها و خطوط receipt مشمول محدودیت نیستند.

1. **نتیجه در ابتدا**: پاراگراف اول حداکثر ۵۰ کلمه باشد و نتیجه اصلی (TL;DR) را بیان کند، مستقیماً به خواسته بنیادی کاربر پاسخ دهد، بدون تعارف یا مقدمه‌چینی روش‌شناختی.
2. **سطح‌بندی عناوین**: برای ماژول‌های اصلی از `##` و برای دیدگاه‌های فرعی از `###` استفاده کنید، عنوان سطح یک `#` ممنوع است. ابعاد را به ۳–۵ بلوک منطقی گروه‌بندی کنید (مثل: زمینه/وضعیت فعلی/تحلیل/نتیجه)، از نوشتن گزارش دنباله‌دار بر اساس ترتیب بازیابی خودداری کنید.
3. **کانون بصری**: داده‌ها، زمان‌ها، نام‌های اختصاصی، و استدلال‌های کلیدی را با `**پررنگ**` علامت‌گذاری کنید؛ پررنگ فقط برای هدایت کانون استفاده شود، در هر پاراگراف طبیعی حداکثر ۲ مورد.
4. **انضباط لیست**: فقط لیست‌های نامرتب تک‌سطحی `*` مجاز است، هرگونه لیست تو در تو چندسطحی ممنوع است (برای اطمینان از تجربه خواندن در ترمینال/جعبه چت).
5. **تراکم متن**: پاراگراف‌های روایی طبیعی حداکثر ۳ جمله، شاخه‌های منطقی جدید باید با خط جدید جدا شوند؛ از جملات انتقالی بدون اطلاعات ماهوی مانند «در مجموع»، «بر اساس نتایج جستجوی فوق»، «به عنوان یک هوش مصنوعی» خودداری کنید.
6. **جداسازی اطلاعات**: هنگام نقل قطعات متن اصلی AI وب یا لینک‌های خارجی، باید آن‌ها را در بلوک نقل قول `>` قرار داده و منبع provider را ذکر کنید، و به دقت از تحلیل خود تفکیک کنید.
7. **بند معافیت (اولویت بالاتر از بندهای ۱–۶)**:
   * خط `[receipt] AGENTCHAT_RUN {...}` (یا فهرست run_idهای هر مرحله) باید عیناً در انتهای پاسخ در بلوک کد حفظ شود، ممنوع است بازنویسی، پررنگ یا حذف شود—مشمول بند §2 قوانین اجباری.
   * افشای降级/شکست (مثل «N نقش降级 شد»، «AI وب در این پاسخ مشارکت نداشت») جزو الزامات شفافیت فرآیند است، جمله انتقالی اضافی محسوب نمی‌شود، نباید حذف شود.
   * بلوک‌های کد، diff، جدول‌ها مشمول محدودیت طول پاراگراف و سطح لیست نیستند.

## 🖼️ پروتکل تولید تصویر (Image Generation Protocol)

### شرایط فعال‌سازی

هنگامی که درخواست کاربر شامل هر یک از کلیدواژه‌های زیر باشد، پروتکل تولید تصویر فعال می‌شود:

* **دسته تولید**: تولید تصویر，رسم،制图，ترسیم，作图，تولید图،create image،generate image،make image
* **دسته نمودار**: فلوچارت،نمودار معماری，نمودار شماتیک，نقشه ذهنی،نمودار，نمودار توپولوژی،chart،diagram،flowchart،mindmap،Mermaid
* **دسته بصری‌سازی**: بصری‌سازی،visualization،illustration،infographic،DALL·E،Imagen،Midjourney

### ۱. تقویت خودکار Prompt (اجباری — ارسال flag `--image`، از v14 در index.js داخلی است)

هنگام تشخیص درخواست تولید تصویر، **باید** flag `--image` را به دستور اضافه کنید:

```bash
node ~/.claude/skills/AgentChat-OneWeb/index.js --image "<prompt اصلی کاربر>"
```

index.js به صورت داخلی دستور تقویت استاندارد («لطفاً از مدل/ابزار تولید تصویر خود主动 برای تولید... استفاده کنید») را به انتهای prompt الحاق می‌کند، و `image_prompt_enhanced: true` را در telemetry ثبت می‌کند.**ممنوع است prompt را به صورت دستی بازنویسی کنید تا جایگزین `--image` شود**—الحاق دستی صرفاً یک قید متنی است، از آن دسته «رعایت توصیفی» که مکانیزم receipt قصد حذف آن را دارد؛ مسیر flag قابل تأیید ماشینی است (در telemetry قابل بررسی است).

اگر کاربر قبلاً صریحاً `--from=ChatGPT` (DALL·E) یا `--from=Gemini` (Imagen) را مشخص کرده است، اولویت با استفاده از قابلیت تولید تصویر آن provider است: `--image --from=Gemini`.

### ۲. دانلود خودکار تصویر (اجباری — داخلی در index.js)

index.js پس از دریافت پاسخ از AI وب، به صورت **خودکار** مراحل زیر را اجرا می‌کند:

1. اسکن URLهای تصویر در متن پاسخ:
   * نحو Markdown: `![alt](url)`
   * تگ HTML: `<img src="url">`
   * لینک مستقیم: URLهایی که با `.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.svg` پایان می‌یابند
2. دانلود هر تصویر به **دایرکتوری کار جاری** (`process.cwd()`، یعنی دایرکتوری که کاربر skill را از آن اجرا می‌کند)
3. فرمت نام فایل: `ai-image-{YYYYMMDD-HHmmss}-{pid}-{شماره}.{ext}` (از v14 pid اضافه شده تا از بازنویسی همزمان توسط workerهای موازی در همان ثانیه جلوگیری شود)
4. خلاصه نتیجه دانلود (پاراگراف `## 📥 Downloaded Images`): **وقتی stdout TTY است** (اجرای مستقیم توسط انسان) به انتهای پاسخ الحاق می‌شود؛ **وقتی stdout pipe است** (مصرف توسط execute.js / Python SDK / MCP server) خلاصه فقط به stderr می‌رود، stdout دستنخورده باقی می‌ماند تا قرارداد ماشینی «متن اصلی پاسخ AI» آلوده نشود، تعداد موفق/شکست در receipt ثبت می‌شود (`images_ok` / `images_failed`).

**محدودیت‌های سخت v14** (URLهای دانلود از پاسخ AI وب می‌آیند—ورودی غیرقابل اعتماد، قابل دستکاری توسط تزریق prompt):
* حداکثر **۲۰ تصویر** در هر پاسخ قابل دانلود است، موارد اضافی در خلاصه به وضوح به عنوان skipped علامت‌گذاری می‌شوند
* حد بالای **۳۰MB** برای هر تصویر؛ بودجه کل مرحله دانلود **۱۲۰ ثانیه**؛ fetch در صفحه tier-2 دارای AbortSignal ۲۵ ثانیه‌ای است (قبلاً timeout وجود نداشت—یک endpoint تصویر معلق می‌توانست باعث شود کل فرآیند هرگز خارج نشود)
* همه tierها **شناسایی payload** انجام می‌دهند: صفحه خطای HTML بازگشتی با HTTP 200 به عنوان شکست دانلود تعیین می‌شود، دیگر به عنوان `.png` خراب ذخیره نمی‌شود
* **رد آدرس‌های loopback / link-local / RFC1918 خصوصی** (مثل `http://127.0.0.1:9222/...` — URL تزریق شده قبلاً می‌توانست داده‌های endpoint دیباگ CDP را در دایرکتوری کاربر بنویسد)؛ برای محیط‌های داخلی/تست می‌توان از `AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS=1` استفاده کرد
* تغییر مسیر نسبی `Location:` و 303 به درستی دنبال می‌شوند؛ هدف تغییر مسیر نیز از بررسی hostهای مسدود شده عبور می‌کند

اگر در پاسخ هیچ URL تصویری وجود نداشته باشد، این مرحله no-op با هزینه صفر است.

### ۳. توضیح دایرکتوری دانلود

هدف دانلود همیشه **دایرکتوری کار جاری کاربر** (`$PWD` شل) است، نه دایرکتوری نصب skill. مثلاً:
* کاربر در `~/Project/` دستور `/AgentChat-OneWeb برایم فلوچارت رسم کن` را فراخوانی می‌کند → تصویر در `~/Project/` دانلود می‌شود
* کاربر در `~/Data_Project/` فراخوانی می‌کند → تصویر در `~/Data_Project/` دانلود می‌شود

می‌توان با flag `--no-download-images` دانلود خودکار را غیرفعال کرد.

---

## Trigger

از این skill استفاده کنید وقتی:
- کاربر می‌خواهد promptی را به «هر AI موجود» ارسال کند
- سهمیه Gemini تمام شده و نیاز به fallback است
- کاربر می‌خواهد failover خودکار ارائه‌دهنده بدون تعویض دستی داشته باشد
- در حال اجرای promptهای دسته‌ای هستید که قابلیت اطمینان ارائه‌دهنده فردی مهم است

برای مکالمات تعاملی که نیاز به context چند دور دارند استفاده نکنید (هر provider state جلسه مستقل دارد).

**چه زمانی از این skill استفاده کنیم**:
- چند ارائه‌دهنده با fallback خودکار. برای قابلیت اطمینان، پردازش دسته‌ای، یا وقتی برایتان مهم نیست کدام AI پاسخ می‌دهد.
- برای عمق استدلال Max خاص Gemini، از `--from=Gemini` استفاده کنید تا Gemini را در ابتدای زنجیره مجبور کنید.

---

## زنجیره Fallback (ترتیب اولویت)

```
Gemini → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek
(Pro Extended Thinking)                                          (آخرین راه حل)
```

اولین ارائه‌دهنده موجود برنده می‌شود. هر مرحله فقط در صورت عدم دسترسی تأیید شده (سهمیه/auth/مدل degraded) به مرحله بعد می‌رود، هرگز به خاطر خطاهای گذرای شبکه نه.

---

## تشخیص دسترسی ارائه‌دهنده

هر provider قبل از ارسال prompt از ۳ لایه بررسی عبور می‌کند:

| لایه بررسی | محتوای بررسی | رفتار در شکست |
|--------|---------|---------|
| **L1: دسترسی** | آیا صفحه بارگذاری می‌شود، آیا نیاز به ورود است | رد شدن → provider بعدی |
| **L2: قابلیت استفاده** | آیا جعبه ورودی قابل ویرایش است، آیا محدود شده‌اید | رد شدن → provider بعدی |
| **L3: کیفیت مدل** | آیا مدل Pro/پیشرفته در دسترس است | خاص Gemini، سایر providerها رد می‌شوند |

###处理 ویژه Gemini

Gemini تنها provider در زنجیره است که نیاز به **Pro Extended Thinking** دارد.  
فعال‌سازی مدل سه لایه降级 دارد:
1. **Pro Extended Thinking** (نیاز به اشتراک Gemini Pro) — ترجیح داده می‌شود
2. **حالت Flash** (fallback رایگان tier) — وقتی Pro Extended در دسترس نباشد自动 سوئیچ می‌شود
3. اگر هر دو شکست بخورند → `ERR_MODEL_DEGRADED`،降级 به ChatGPT

شرایط فعال‌سازی降级 توسط `quotaPatterns` هر adapter تعریف می‌شود (`lib/providers/adapters/<name>.js`)،  
منبع معتبر است. SKILL_fa.md دیگر نسخه دوم را نگهداری نمی‌کند (در گذشته ناسازگاری با کد رخ داده بود).

---

## پیش‌نیازها

```bash
# 0. ⚠️ حیاتی: باید از Chrome سیستم + profile با session ورود استفاده کنید
#    کپی و ویرایش فایل .env پروژه:
#      cp .env.example .env
#    پیکربندی کلیدی:
#      CHROMIUM_PATH=/usr/bin/google-chrome-stable  (الزامی — باید روی Chrome سیستم تنظیم شود، خالی گذاشتن خطا می‌دهد؛ رد مسیر ms-playwright)
#      CHROME_PROFILE=~/.chrome-debug-profile
#    اگر پیکربندی نشده باشد، session ورود همه سایت‌های AI از بین می‌رود!

# 1. Chrome debug روی پورت 9222 در حال اجرا است — از v16 کاملاً خودکار، بدون وابستگی به اسکریپت خارجی
#    index.js وقتی پورت در دسترس نیست自动 Chrome را راه‌اندازی می‌کند (AGENTCHAT_NO_AUTOSTART=1 برای خاموش کردن):
#      Tier 1: اسکریپت راه‌اندازی پلتفرم (اگر scripts/ استقرار یافته — سناریوی clone کامل مخزن)
#      Tier 2: راه‌انداز داخلی — مستقیماً باینری Chrome را پیدا کرده و با مجموعه flagهای加固 راه‌اندازی می‌کند.
#              workbuddy و غیره که فقط درخت skills را کپی می‌کنند (scripts/ همیشه مفقود) از این مسیر استفاده می‌کنند.
#    استقرار فقط skill (workbuddy / ~/.claude/skills/) فقط نیاز دارد تضمین شود:
#      a) .env در دایرکتوری بالایی skills/ قرار گیرد (همان جایی که scripts/ باید باشد)،
#         یا AGENTCHAT_ENV_FILE را روی آن تنظیم کنید — Node از v16 به بعد خودش .env را به طور ایمن بارگذاری می‌کند
#      b) در .env مقدار CHROMIUM_PATH به Chrome سیستم اشاره کند (مثال Windows:
#         C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe؛
#         وقتی تنظیم نشده باشد自动探测 مسیر نصب استاندارد، با fallback به Edge)
#      c) Windows + agent host (skill در ~/.claude/skills/ و غیره نصب شده): فرآیند skill
#         نمی‌تواند .env ریشه مخزن و scripts/ را ببیند (مسیرهای کاندید lib به
#         ~/.claude/.env解析 می‌شوند). با دو متغیر محیطی فرار آن را بازگردانید (در سطح کاربر تنظیم کنید،
#         زیرفرآیند فراخوانی ابزار自动 ارث می‌برد):
#           setx AGENTCHAT_ENV_FILE    "C:\\path\\to\\AgentChat\\.env"
#           setx AGENTCHAT_SCRIPTS_DIR "C:\\path\\to\\AgentChat\\scripts"
#         در غیر این صورت skill فقط مقدار پیش‌فرض 127.0.0.1:9222 + ~/.chrome-debug-profile را探测 می‌کند،
#         با Chrome راه‌اندازی شده توسط ps1 بر اساس .env مخزن (پورت/profile سفارشی)分裂 می‌شود — پورت
#        探测 شکست می‌خورد و سپس نمونه هم profile کشیده می‌شود که توسط مکانیزم single instance Windows بلعیده شده و فوراً خارج می‌شود.
#         از v18: راه‌انداز داخلی Chrome را از طریق WMI ایجاد می‌کند (خارج از Job Object فراخوانی ابزار،
#         دیگر همراه پایان run کشته نمی‌شود)؛ قبل از راه‌اندازی نمونه‌های زنده‌ای که profile اشغال شده را探测 می‌کند
#         (فقط نمونه‌های مدیریت شده رکورد شده در فایل PID بازیافت می‌شوند، نمونه‌های دیگر سریع خطا می‌دهند)؛ رد
#         دایرکتوری User Data پیش‌فرض مرورگر (Chrome ≥136 به طور ساکت debug port را روی آن غیرفعال می‌کند).
#    پیش‌راه‌اندازی دستی (اختیاری، تحت clone کامل سریع‌تر):
#    Linux/macOS:
pgrep -f "start-chrome-debug" || bash scripts/start-chrome-debug.sh
#    Windows (PowerShell؛ برای اولین بار از -FirstLogin برای ورود به Gemini استفاده کنید):
#      powershell -ExecutionPolicy Bypass -File scripts\\start-chrome.ps1
#    توجه WSL2: 127.0.0.1 درون WSL VM است نه host Windows. وقتی Chrome در سمت
#    Windows اجرا می‌شود باید CDP_HOST=<IP host Windows> را تنظیم کنید (ببینید .env.example).

# 2. دسترسی CDP
curl -s http://127.0.0.1:9222/json/version | python3 -c "import json,sys; print(json.load(sys.stdin).get('Browser','FAIL'))"

# 3. playwright-core (npm, ~3MB)
(cd ~/.claude/skills/AgentChat-OneWeb && npm install)
#    ⚠️ این skill به کتابخانه مشترک skills/lib/ هم‌سطح وابسته است (require('../lib/…')) —
#    هنگام نصب در ~/.claude/skills/ باید کل درخت کپی شود: AgentChat-OneWeb/ و lib/ کنار هم.
#    اگر فقط AgentChat-OneWeb/ کپی شود در راه‌اندازی FATAL با راهنمای تعمیر گزارش می‌شود (از v14، دیگر MODULE_NOT_FOUND خام نیست).

# 4. حداقل یک سرویس AI وارد شده باشد (در profile Chrome)
#    URL ورود هر سرویس:
#    Gemini:  https://gemini.google.com/u/0/app
#    ChatGPT: https://chatgpt.com/
#    Claude:  https://claude.ai/
#    Qwen:    https://www.qianwen.com/?source=tongyigw
#    Kimi:    https://kimi.moonshot.cn/
#    MiniMax: https://agent.minimaxi.com/
```

---

## فراخوانی

```bash
# استفاده پایه —自动 پیمایش زنجیره fallback (پیش‌فرض برچسب‌های مرورگر حفظ می‌شوند)
node ~/.claude/skills/AgentChat-OneWeb/index.js "Your prompt"

# پس از اجرا自动 پاک‌سازی برچسب‌های مرورگر
node ~/.claude/skills/AgentChat-OneWeb/index.js --close "Your prompt"

# مشخص کردن timeout (ms)
node ~/.claude/skills/AgentChat-OneWeb/index.js --timeout=600000 "Long prompt..."

# خواندن از stdin
echo "Prompt from pipe" | node ~/.claude/skills/AgentChat-OneWeb/index.js

# بررسی محیط (بدون ارسال prompt)
node ~/.claude/skills/AgentChat-OneWeb/index.js --smoke

# بررسی اتصال CDP
node ~/.claude/skills/AgentChat-OneWeb/index.js --doctor

# مجبور کردن provider شروع (رد کردن providerهای قبلی زنجیره)
node ~/.claude/skills/AgentChat-OneWeb/index.js --from=ChatGPT "prompt"
```

### Flagهای CLI

| Flag | توضیح |
|------|------|
| `--timeout=N` | timeout کل (ms)، شامل زمان همه تلاش‌های provider، پیش‌فرض 600000 |
| `--timeout-per-provider=N` | timeout تک provider (ms)، پیش‌فرض `timeout / 2` یا 180000 |
| `--from=NAME` | شروع از provider مشخص شده، رد کردن providerهای قبلی زنجیره. NAME می‌تواند مخفف باشد و حساس به حروف بزرگ نیست |
| `--single` | فقط همان provider مشخص شده با `--from` را امتحان کن، اگر شکست خورد مستقیم برگرد، به providerهای بعدی زنجیره降级 نشو. برای callerهایی که می‌خواهند خودشان降级跨 provider + قفل انجام دهند (مثل AgentChat-IndependentTasks)، تا از دور زدن قفل mutual exclusion توسط降级 داخلی زیرفرآیند جلوگیری شود |
| `--only=NAME` | ادغام简写 `--from=NAME --single` (برای فراخوانی برنامه‌ای استفاده می‌شود؛ NAME ناشناخته loud-fail می‌شود نه fallback ساکت) |
| `--locale=xx_XX` | مجبور کردن profile زبان UI Gemini (`zh_CN` / `zh_TW` / `en` / `ja`)، رد کردن تشخیص خودکار. پارامتر `locale=` در Python SDK همین flag را منتقل می‌کند |
| `--smoke` | بررسی محیط: پیمایش همه providerها تأیید کند حداقل یکی در دسترس است |
| `--doctor` | بررسی اتصال پورت CDP |
| `--close` / `--close-browser` | پس از اجرا همه tabها و اتصال مرورگر را ببند (پیش‌فرض حفظ می‌شود) |
| `--image` | نیت تولید تصویر: index.js به صورت داخلی دستور تقویت استاندارد تولید تصویر را الحاق کرده و telemetry `image_prompt_enhanced` را ثبت می‌کند (ببینید پروتکل تصویر §1) |
| `--no-download-images` | غیرفعال کردن دانلود خودکار تصویر (پیش‌فرض فعال است، URL تصویر از پاسخ استخراج و در دایرکتوری کار جاری دانلود می‌شود) |

> `--flag` ناشناخته لاگ `WARN` می‌زند و نادیده گرفته می‌شود (از v14؛ قبلاً silently丢弃 می‌شد، ریشه باگ‌هایی مثل بی‌اثر ماندن `--locale` برای ماه‌ها، یا الحاق `--keep-tabs` به prompt بود). مقدار خالی `--from=` / `--only=` با exit 64 hard-fail می‌شود. تحت `--only`/`--single` نام provider باید **دقیقاً مطابقت** داشته باشد با key یا نام نمایشی (مطابقت substring فقط در مسیر降级 به عنوان راحتی برای انسان حفظ شده است).

---

## خروجی و Telemetry

- **stdout**: در صورت موفقیت متن اصلی پاسخ AI را خروجی می‌دهد
- **stderr**: لاگ تشخیصی، پیشوند `[fallback]`
- **telemetry**: در `~/.claude/skills/AgentChat-OneWeb/data/fallback-telemetry.jsonl` نوشته می‌شود

```json
{
  "timestamp": "2026-07-01T...",
  "provider_used": "ChatGPT",
  "providers_tried": ["Gemini"],
  "fallback_reasons": {"Gemini": "ERR_RATE_LIMITED"},
  "prompt_length_chars": 1500,
  "response_length_chars": 3200,
  "total_ms": 45000,
  "exit_code": 0
}
```

---

## کدهای خروج

| Exit | Code | معنی |
|------|------|---------|
| 0 | — | موفقیت — پاسخ در stdout |
| 1 | `ERR_NO_CDP` | پورت Chrome CDP در دسترس نیست |
| 2 | `ERR_NO_PROVIDER` | همه providerها غیرقابل دسترس (همه وارد نشده‌اند/نیاز به auth) |
| 3 | `ERR_SAFETY_REJECTED` | فیلتر ایمنی provider فعلی رد کرده (همه امتحان شده‌اند) |
| 4 | `ERR_INTERNAL` | خطای داخلی (استثنای Node، قطع CDP و غیره) |
| 5 | `ERR_RATE_LIMITED` | همه providerها محدود شده‌اند |
| 9 | `ERR_ALL_EXHAUSTED` | همه providerها پیمایش شدند، همه غیرقابل دسترس |
| 10 | `ERR_TIMEOUT` | timeout کل، بدون پاسخ کامل |
| 64 | `EX_USAGE` | خطای استفاده (prompt خالی / مقدار خالی `--from=`،`--only=`). قبل از v14 استفاده نادرست exit 1 می‌داد، با ERR_NO_CDP تداخل داشت، khiến orchestrator باگ caller را «مرورگر قطع شده» تفسیر کرده و کل زنجیره را终止 می‌کرد. خطای استفاده هم receipt تولید می‌کند |

---

## معماری

```
index.js
├── main()                    — ورودی CLI،解析 پارامترها
├── tryAllProviders()         — پیمایش providerها بر اساس زنجیره، بازگشت اولین موفق
├── RUNNERS (factory-built)   — 8 runner provider از طریق createProviderRunner()
│   ├── gemini                — config: lib/providers/adapters/gemini.js
│   ├── chatgpt               — config: lib/providers/adapters/chatgpt.js
│   ├── claude                — config: lib/providers/adapters/claude.js
│   ├── qwen                  — config: lib/providers/adapters/qwen.js
│   ├── kimi                  — config: lib/providers/adapters/kimi.js
│   ├── minimax               — config: lib/providers/adapters/minimax.js
│   ├── mimo                  — config: lib/providers/adapters/mimo.js
│   └── deepseek              — config: lib/providers/adapters/deepseek.js
├── helpers/
│   ├── isProviderTabOpen()   — dedup tab (مشترک با smokeTest)
│   ├── log() / startTimer()  — خروجی ترمینال (lib/terminal.js)
│   └── connectWithRetry()    — اتصال CDP + تلاش مجدد (lib/cdp.js)
└── constants/
    └── PROVIDER_CHAIN        — ترتیب اولویت + URL
```

### تصمیمات طراحی کلیدی

1. **یک صفحه برای هر فراخوانی** — هر فراخوانی یک tab مستقل ایجاد می‌کند، پیش‌فرض مرورگر بسته نمی‌شود (`--close` پاک‌سازی خودکار را فعال می‌کند).
2. **یک tab جدید برای هر provider** — هر تلاش provider از tab مستقل استفاده می‌کند (از طریق `context.newPage()`).
   بعد از شکست tab فعلی بسته می‌شود، tab جدید برای provider بعدی ایجاد می‌شود.
3. **تشخیص سهمیه از طریق DOM** — به کد وضعیت HTTP وابسته نیست، بلکه محتوای DOM صفحه را بررسی می‌کند تا تعیین کند آیا محدود شده‌اید.
4. **بدون context跨 provider** — context بین providerهای مختلف منتقل نمی‌شود. هر بار prompt مستقل است.
5. **Pro Extended برای Gemini اجباری** — Gemini فقط وقتی استفاده می‌شود که Pro Extended فعال شده باشد، در غیر این صورت مستقیم降级 می‌شود.

---

## یادداشت‌های پیاده‌سازی خاص هر Provider

رفتار خاص هر provider در `lib/providers/adapters/<name>.js` تعریف شده است (config-driven، نه hard-coded)، SKILL_fa.md فقط تفاوت‌های کلیدی را برای مرجع فراخوانی AI نگه می‌دارد:

| Provider | تفاوت کلیدی | ببینید |
|----------|---------|------|
| **Gemini** | فعال‌سازی اجباری Pro Extended، تشخیص خروجی bursty،延长 120 ثانیه‌ای دکمه توقف، لنگر تکمیل Action Toolbar | `adapters/gemini.js` |
| **ChatGPT** | استراتژی ورودی 3 لایه (clipboard→simulated paste→chunked keyboard)، تأیید وضعیت دکمه ارسال React | `adapters/chatgpt.js` |
| **Claude** | ویرایشگر ProseMirror، فیلتر کردن placeholder «Thinking»، جداسازی بلوک جستجوی تعبیه شده | `adapters/claude.js` |
| **Qwen** | تأخیر 3 ثانیه‌ای React SPA، حالت detached دکمه توقف، جداسازی پیشوند نام مدل | `adapters/qwen.js` |
| **Kimi** | ایجاد جلسه جدید برای هر فراخوانی، تشخیص disabled بودن send-button-container، پنجره ثبات تطبیقی (5-30 ثانیه) | `adapters/kimi.js` |
| **MiniMax** | تأخیر 4 ثانیه‌ای挂载 ناهمزمان TipTap/ProseMirror، ارسال با `<div aria-label="发送消息">` نه button | `adapters/minimax.js` |
| **MiMo** | تأخیر 4 ثانیه‌ای React SPA، پیمایش DOM برای locating دکمه ارسال (بدون CSS selector قابل اعتماد) | `adapters/mimo.js` |
| **DeepSeek** | خط لوله استاندارد، پاسخ ds-markdown | `adapters/deepseek.js` |

---

## افزودن Provider جدید

1. ایجاد `lib/providers/adapters/<name>.js` و export کردن شیء config (به adapterهای موجود مراجعه کنید)
2. افزودن entry در آرایه `PROVIDER_CHAIN`
3. افزودن key در آرایه `PROVIDER_KEYS` (ثبت خودکار در RUNNERS)
4. فیلدهای کلیدی Config: `url`, `authDomains`, `editorSelectors`, `sendSelectors`/`sendFallback`, `responseSelectors`
5. تابع باید `{success: true, response: string}` یا `{success: false, reason: string}` بازگرداند
   - `reason` باید یکی از این‌ها باشد: `"quota"` | `"auth"` | `"error"` | `"timeout"`

---

## موقعیت کد

- `index.js` — ورودی CLI + orchestrator fallback
- `lib/providerFactory.js` — خط لوله 10 مرحله‌ای config-driven (همه 8 provider مشترک)
- `lib/providers/adapters/<name>.js` — پیکربندی تفاوت‌های هر provider
- `lib/providers/chain.js` — ترتیب اولویت (منبع حقیقت واحد مشترک با IndependentTasks)
- `SKILL_fa.md` — راهنمای عملیاتی面向 AI
- `package.json` — metadata npm (playwright-core)
