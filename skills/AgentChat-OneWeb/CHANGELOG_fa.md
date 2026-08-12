# لاگ تغییرات AgentChat-OneWeb

## 2026-07-19 (v18) — تعمیرات چهارگانه عدم دسترسی پورت CDP در Windows

- **[P0] همراه‌سازی Job Object (`lib/cdp.js` + `scripts/start-chrome.ps1`)**: فراخوانی ابزار host agent در Job ای اجرا می‌شود که با kill-on-close تنظیم شده، Node `detached: true` بدون تنظیم `CREATE_BREAKAWAY_FROM_JOB`، Chromeای که از طریق autostart/Start-Process راه‌اندازی می‌شود به محض خروج فرآیند skill کشته می‌شود—علت مستقیم "ERR_NO_CDP در دور بعدی پس از پاسخ به سوال". اکنون: launcher داخلی و ps1 هر دو از طریق WMI `Win32_Process.Create` فرآیند ایجاد می‌کنند (فرآیند والد WmiPrvSE.exe، خارج از هر Job فراخوانی)، همزمان PID واقعی را گرفته و در فایل PID برای تعامل متقابل `-Stop` می‌نویسند؛ وقتی WMI در دسترس نیست به plain spawn降级 کرده و هشدار صریح می‌دهد

- **[P0] جذب single instance در Windows (`launchChromeDirect`)**: single instance در Windows یک mutex نام‌گذاری شده/پنجره پیام است نه فایل `Singleton*`—حذف فایل قفل در v16 در Windows no-op است، وقتی نمونه زنده‌ای با همان profile وجود دارد chrome.exe جدید جذب شده و فوراً خارج می‌شود، پورت هرگز bind نمی‌شود، 45 ثانیه انتظار بی‌هوده پس از آن گزارش شکست کلی می‌دهد. اکنون: قبل از راه‌اندازی از طریق CIM فرآیندهای chrome/msedge/chromium که `--user-data-dir=<profile>` را نگه داشته‌اند اسکن می‌شوند؛ اگر مطابقت داشت و PID رکورد شده در فایل PID بود → با `taskkill /T /F` بازیافت و مجدد راه‌اندازی می‌شود، اگر نمونه متعلق به شخص دیگر بود → سریع loud-fail با دادن PID و سه دستورالعمل دفع (سیاست POLICY بدون تغییر: هرگز Chrome کاربر را لمس نکن). پاک‌سازی فایل‌های `Singleton*` فقط به POSIX محدود شد

- **[P0] سخت‌کدی `127.0.0.1` در `index.js` نادیده گرفتن CDP_HOST**: OneWeb به صورت دستی CDP_URL را می‌سازد و با lib/cdp.js انشعاب دارد، WSL2 با تنظیم `CDP_HOST=<IP host Windows>` در .env.example همچنان loopback VM را探测 می‌کند → در هر دور ERR_NO_CDP. اکنون: از منبع حقیقت واحد `CDP_URL` export شده از lib استفاده می‌کند (همه تنظیمات CDP_HOST + CDP_PORT + بارگذاری .env از v16 اعمال می‌شوند)

- **[P1] تشخیص خروج زودهنگام و همسویی تشخیص با ps1 (`waitForPortOrDeath`)**: launcher داخلی نظارت بر بقای PID اضافه کرد (مهلت 1.5 ثانیه‌ای +探测 ثانویه پورت پس از مرگ برای تحمل تحویل single instance)، به محض مرگ فرآیند راه‌اندازی شده انتظار را لغو کرده و reason هدفمند می‌دهد (جذب single instance / مسدودسازی AV)، دیگر 45 ثانیه کامل نمی‌سوزاند؛ مسیر شکست win32 خروجی تشخیصی `netstat -ano | findstr :<port>` اضافه می‌کند

- **[P1] محافظ دایرکتوری پیش‌فرض Chrome ≥136**: وقتی `CHROME_PROFILE` به دایرکتوری User Data پیش‌فرض مرورگر اشاره می‌کند (تشخیص چیدمان سه پلتفرم Win/Linux/macOS) مستقیم رد کرده و توضیح می‌دهد—Chrome ≥136 به طور ساکت `--remote-debugging-port` را روی دایرکتوری داده پیش‌فرض غیرفعال می‌کند، رفتار قدیمی timeout بی‌صدا با باز نشدن پورت بود

- **[docs] SKILL.md**: بخش استقرار host agent در Windows درب فرار `setx AGENTCHAT_ENV_FILE / AGENTCHAT_SCRIPTS_DIR` اضافه شد—در چیدمان فقط-skill، مسیرهای کاندید lib برای解析 .env به `~/.claude/.env`解析 می‌شوند، پیکربندی ریشه مخزن (CDP_PORT/CHROME_PROFILE/CHROMIUM_PATH/PROXY_SERVER/CDP_HOST) قبلاً برای فرآیند skill کاملاً نامرئی بود، ریشه分裂 پورت/profile

- **اضافه شد** `test_v18_windows_cdp.js` — تأیید سیم‌کشی CDP_URL (تأیید سطح source + تأیید عملکرد محیط زیرفرآیند)، معنای CommandLineToArgvW برای `winArgQuote`، ساخت دستور WMI (escape تک‌نقل‌قول PS)، `parseProfileHolders` (با نقل‌قول/اسلش انتهایی/حروف بزرگ/رد عدم مطابقت)، تشخیص دایرکتوری User Data پیش‌فرض مثال‌های مثبت/منفی سه پلتفرم، `isProcessAlive`، کران زمانی خروج زودهنگام `waitForPortOrDeath`

## 2026-07-17 (v17) — لایه ضدشکنندگی: تشخیص دیوار / لایه موقعیت‌یابی ARIA / کنترل واجد شرایط بودن سطح مرورگر

- **[P0] تشخیص دیوار (`lib/pageHealth.js` جدید)**: تشخیص یک‌باره evaluate برای CAPTCHA / دیوار ورود / صفحه拦截 محدودیت نرخ—شواهد ساختاری (iframeهای reCAPTCHA/hCaptcha/Turnstile/Cloudflare/Arkose، فرم challenge، ورودی password قابل مشاهده) بدون شرط تعیین می‌کنند؛ شواهد متنی تحت دروازه دوگانه (عدم وجود ویرایشگر چت قابل مشاهده در صفحه + body <1500 کاراکتر) برای جلوگیری از تشخیص اشتباه. موضع طراحی: **تشخیص و واگذاری به انسان، هرگز دور زدن**. سه نقطه اتصال: پس از ناوبری (دیواری که با همان URL رندر می‌شود، بررسی URL نمی‌گیرد)، هنگامی که ویرایشگر پیدا نمی‌شود (دیوار علت شماره یک "no editor" است)، هنگام超时 انتظار پاسخ (session منقضی/محدودیت نرخ که پس از ارسال ظاهر می‌شود). دسته‌بندی captcha/login→`auth` (recoveryHint را فعال می‌کند)، ratelimit→`quota` (خروجی 5 معنای تلاش مجدد)، جایگزین حالت سکوت قبلی که بودجه را می‌سوزاند و به `error`/`timeout`归属 می‌داد

- **[P1] لایه موقعیت‌یابی ARIA**: `findEditableElement` پس از نابودی کامل لیست CSS و قبل از heuristic shadow-DOM لایه معنایی `getByRole('textbox')` را درج می‌کند (اولویت ترجیحی ضد-drift主流: موقعیت‌یابی role تحت تغییر نام class/hash class churn زنده می‌ماند). سه لایه hit برچسب `_fsTier` می‌خورند و در `ctx.telemetry.editor_tier` می‌افتند—hit aria/heuristic هشدار اولیه drift لیست selector adapter است، نیازی به انتظار نابودی کامل نیست

- **[P1] سیگنال semaphore سطح مرورگر (`lib/locks.js`)**: `acquireBrowserSlot`/`releaseBrowserSlot` از قفل اتمی موجود با همه محافظت‌های race condition استفاده می‌کند (TOCTOU rename، بازیافت PID مرده، TTL 30 دقیقه‌ای، بازیابی orphan)، سقف跨进程 تعداد همزمان صفحات اتوماسیون در یک Chrome (`AGENTCHAT_MAX_CONCURRENT_PAGES`، پیش‌فرض 3، سقف 16)—قفل provider فقط همزمانی provider یکسان را سریال می‌کند، انفجار همزمانی 7 worker که به 7 provider **متفاوت** می‌زنند قبلاً تحت هیچ محدودیتی نبود. انتظار با抖动 1.5–3 ثانیه؛ هنگامی که زمان انتظار تمام شد صریحاً به نامحدود降级 کرده و هشدار می‌دهد (کنترل ورود deadlock جدید معرفی نمی‌کند)؛ پس از گرفتن slot抖动 0.3–1.2 ثانیه‌ای برای پراکنده کردن انفجار همزمان رهاسازی barrier. فرآیند اصلی در try/finally پیچیده شده، مسیرهای crash توسط بازیافت PID مرده پشتیبان‌گیری می‌شوند

- **[P2] پوشش کامل recoveryHint برای auth**: providerهایی که recoveryHint اختصاصی ندارند اکنون دستور عمومی می‌زنند (ورود دستی/تأیید human در Chrome دیباگ تکمیل شود)

- **اضافه شد** `test_v17_resilience.js` — 33 ادعا (تشخیص سه نوع دیوار، محافظت از تشخیص اشتباه دروازه طول + رد ویرایشگر، رد عنصر پنهان، معنای semaphore slot و انتظار کران‌دار، 8 ادعا سیم‌کشی)؛ 57+19+15 ادعای موجود همه عبور می‌کنند

## 2026-07-17 (v14)

- **[P0] تعمیر hang مرحله دانلود تصویر**: `fetch()` در صفحه tier-2 قبلاً هیچ timeoutی نداشت—یک endpoint تصویر معلق `page.evaluate` را برای همیشه pending نگه می‌داشت، socket CDP event loop را حفظ می‌کرد، فرآیند هرگز خارج نمی‌شد (بدون flush stdout، بدون receipt)؛ watchdog SIGTERM در IndependentTasks سپس runای که **پاسخ تکمیل شده بود** را به عنوان شکست provider می‌کشت. اکنون: AbortSignal 25 ثانیه‌ای درون صفحه‌ای + Promise.race 30 ثانیه‌ای در لایه خارجی evaluate (late loser بلعیده می‌شود تا از unhandledRejection جلوگیری شود) + بودجه 120 ثانیه‌ای کل مرحله + سقف 20 تصویر در هر پاسخ (مازاد loud-fail)

- **[P0] تکمیل لایه دانلود direct با sniffing payload**: صفحه خطای HTML بازگشتی با HTTP 200 قبلاً مستقیماً به عنوان `.png` خراب ذخیره می‌شد و status:ok گزارش می‌داد (v13 فقط browser tier را تعمیر کرده بود)؛ اکنون buffered + دروازه sniffImageExt، و سقف 30MB برای هر تصویر (بررسی پیشینی content-length + شمارش جریانی قطع)

- **[P0/امنیت] URLهای درون پاسخ به عنوان ورودی غیرقابل اعتماد رد می‌شوند**: رد اهداف loopback/link-local/RFC1918 خصوصی (`![x](http://127.0.0.1:9222/json/list)` تزریق قبلاً می‌توانست metadata endpoint دیباگ CDP—شامل URL وب‌سوکت دیباگ همه tabها—را در cwd کاربر بنویسد، و browser tier با cookie می‌توانست شبکه داخلی را探测 کند)؛ `AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS=1` برای放行 (تست/شبکه داخلی). هدف تغییر مسیر نیز بررسی می‌شود

- **[P1] تعمیر تغییر مسیر**: `Location:` نسبی (بسیار رایج) قبلاً مستقیماً زنجیره را قطع می‌کرد، 303 دنبال نمی‌شد؛ اکنون `new URL(loc, base)`解析، فقط http(s) را دنبال می‌کند، سقف 3 پرش

- **[P1] تعمیر冒充 مقدار خالی `--only=`/`--from=`**: `''.includes('')` همیشه درست → مقدار خالی از طریق fallback substring به طور ساکت به chain[0]=Gemini解析 می‌شد، تحت --single نمونه‌ای با provider متفاوت از holder قفل فراخوانی اجرا می‌شد (دقیقاً تخریب互斥ی که loud-fail قصد جلوگیری از آن را داشت)؛ اکنون در دوره parse با exit 64 hard-fail می‌شود؛ و تحت --single/--only نام provider باید دقیقاً مطابقت داشته باشد (راحتی substring فقط در مسیر级联 حفظ شده است)

- **[P1] حذف آلودگی قرارداد ماشینی stdout**: در حالت pipe خلاصه "📥 Downloaded Images" دیگر به بدنه پاسخ追加 نمی‌شود (execute.js/SDK/MCP stdout را کلمه به کلمه به عنوان پاسخ AI مصرف می‌کنند، خلاصه قبلاً در متن裁决 subagent混入 می‌شد)؛ خلاصه فقط به stderr می‌رود، شمارش در receipt ثبت می‌شود (`images_ok`/`images_failed`)؛ رفتار TTY انسانی مستقیم بدون تغییر. فیلد `rawResponse`/`summary` جدید به مقدار بازگشتی downloadAllImages اضافه شد

- **[P1] تغییر exit 1 → 64 (EX_USAGE) برای خطاهای استفاده**: تضاد با ERR_NO_CDP رفع شد (مشکل توصیف شده در conflation guard execute.js)، و خطاهای استفاده اکنون receipt تولید می‌کنند

- **[P1] ترتیب بررسی providerFactory**: پردازش overlay به قبل از اسکن سطح body quota منتقل شد—پنجره ارتقای قابل بستن ("لطفاً ارتقا دهید..." که COMMON_CN_QUOTA_PATTERNS را هدف قرار می‌دهد) قبلاً provider قابل دسترس را به اشتباه به عنوان quota整轮 رد می‌کرد

- **[P2] `--flag` ناشناخته WARN به جای丢弃 ساکت** (باگ ریشه‌ای چرخش بیهوده --locale/--keep-tabs در prompt حذف شد)؛ مقدار timeout نامعتبر WARN؛ flag `--image`: دستور تقویت تولید تصویر توسط فرآیند index.js الحاق می‌شود (SKILL.md §1 از قید prose به قابل تأیید ماشینی تغییر یافت)، telemetry `image_prompt_enhanced` را ثبت می‌کند

- **[P2/متفرقه]**: نام فایل دانلود pid اضافه می‌کند (workerهای همزمان در همان ثانیه بازنویسی می‌کنند) + نوشتن `wx` برای جلوگیری ازlobber؛ بخش query در DIRECT_URL_RE دیگر `)` انتهایی را نمی‌بلعد؛ smokeTest context خالی راهنمای تعمیر می‌دهد نه TypeError→exit 4؛ محافظ require سطح بالا (وقتی playwright-core نصب نشده / فقط OneWeb کپی شده بدون skills/lib دستور تعمیر دقیق می‌دهد)؛ محافظ EPIPE stdout (والد زودتر می‌میرد دیگر بعد از receipt exit-0崩成 exit 4 نمی‌شود)；تصحیح drift مسیر `~/start-chrome-debug.sh`؛ تست test_providers_v10.js مسیر مطلق سخت‌کد شده `/home/wangzi` به `__dirname` تغییر یافت (قابل حمل)؛ 6 مجموعه ادعای بازگشتی v14 اضافه شد (test_v13_image_capture.js 15/15)

## 2026-07-16 (v11)

- **[P0] تعمیر截断 مرحله «دریافت وب» در جستجوی联网 Kimi** (تست واقعی: 45 ثانیه/960 کاراکتر截断 در «در حال دریافت وب...»، 78 ثانیه/1522 کاراکتر截断 در «دریافت وب 5 صفحه وب»). سه علت ترکیبی:
  1. شکاف واژگان `stillGeneratingCheck` در kimi.js — `正在 [搜索检索查询]` شامل «دریافت» نیست، `\\d+个结 [果]` با «N صفحه وب» مطابقت ندارد → مرحله抓取 (سکوت 5-30 ثانیه‌ای) برای detector کاملاً نامرئی است، پنجره ثبات 8 ثانیه‌ای منقضی شده و به اشتباه تکمیل تشخیص داده می‌شود
  2. regex دم با لنگر `$` ذاتاً شکننده است (هر خط chip از هر منبعی پس از خط وضعیت باعث عدم مطابقت می‌شود) و responseSelectors[0] سخت‌کد شده، وقتی factory به fallback selector می‌رسد detector عنصر اشتباه را خوانده و ساکت از کار می‌افتد
  3. **باگ لایه factory**: phase-3 فقط وقتی `text.length > lastLen` ساعت ثبات را reset می‌کند — تا شدن کارت جستجو/thinking باعث انقباض innerText می‌شود، قبل از اینکه پاسخ به طول اوج بازگردد همه pollها به عنوان "stable" در نظر گرفته می‌شوند، پنجره می‌تواند در میانه خروجی streaming بدنه منقضی شود (روی همه providerهایی که UI ابزار قابل تا شدن دارند تأثیر می‌گذارد)

- **اضافه شد** `lib/stillWorking.js` — detector مشترک "هنوز در حال تولید" چند سیگناله: S1 طبقه‌بندی factory متن خوانده شده بدون هزینه CDP / S2 دکمه توقف قابل مشاهده (مستقل از زبان و عبارت) / S3 spinner در آخرین کانتینر پاسخ یا خط وضعیت tail زیردرخت آن؛ واژگان کامل فعل CN (搜索 | 检索 | 查询 | 获取 | 抓取 | 读取 | 阅读 | 浏览 | 访问 | 打开 | 解析 | 分析 | 整理 | 归纳 | 总结 | 思考 | 推理 | 撰写 | 生成 | 调用 | 执行 | 等待 | 加载 | 联网) + خط شمارش «N صفحه وب/نتیجه/منبع» + فعل/اسم EN

- بازنویسی phase-3 در providerFactory: تشخیص تغییر fingerprint (length+tail-80) جایگزین تشخیص رشد خالص شد، tick '~' جدید اضافه شد (انقباض/تغییر در جای)؛ امضای جدید `stillGeneratingCheck(page, {text, sinceChangeMs, elapsedMs})` (سازگاری عقبرو، pollهای با تغییر متن دیگر check را صدا نمی‌زنند — هر poll رشد یک往返 CDP ذخیره می‌کند)؛ `stillGeneratingMaxHoldMs` جدید اضافه شد (پیش‌فرض 90 ثانیه، Gemini 300 ثانیه، Kimi 180 ثانیه) — ⚙ از آخرین تغییر واقعی متنreset می‌شود، تشخیص اشتباه از "سوزاندن کل بودجه provider" به "تاخیر کران‌دار"降级 می‌شود

- Kimi/MiniMax/DeepSeek/Qwen/MiMo همه به detector مشترک متصل شدند (مرحله ابزار agent MiniMax، تا شدن تفکر عمیق DeepSeek R1، جستجوی عمیق Qwen متعلق به همان کلاس截断 هستند)؛ responseSelectors به ثابت ماژول ارتقا یافتند تا detector و factory polling یک خانواده کانتینر را بچرخانند؛ ChatGPT/Claude خط لوله phase-1 دکمه توقف بدون تغییر باقی ماندند

- محافظت echo در extractResponse: tail selector泛型 (`[class*="message"]` و غیره) وقتی گره assistant به آرامی mount می‌شود `.last()` ممکن است به حباب کاربر خودی解析 شود → prompt را به عنوان پاسخ برمی‌گرداند (کلاس silent-wrong-answer)؛ وقتی متن استخراج شده ≈ prompt (±10-15٪ طول و互相 شامل) تشخیص EXTRACT شکست می‌خورد. prompt کوتاه (<20 کاراکتر) و پاسخ substring از نوع "بازگویی" معاف هستند

- تشخیص اشتباه login در checkOverlays: 「退出登录」「免登录」「已登录」 دیگر provider وارد شده را به طور سخت به 'auth' تشخیص نمی‌دهند (نگرش منفی رو به عقب)؛ مرز کلمه `\\blog in\\b`/`\\bsign in\\b`

- ترتیب editorSelectors در Claude: `[contenteditable="true"]` سطح صفحه از اول به آخر منتقل شد، تا از binding `.first()` به جعبه تغییر نام مکالمه/ناحیه قابل ویرایش popup جلوگیری شود

- **اضافه شد** test_still_working.js — 57 ادعا (شامل دو回归端到端 با tail截断 تست واقعی，回归 انقباض، ⚙ سقف، محافظت echo، 8 سیم‌کشی provider)؛ test_gemini_selectors.js 19 ادعا همه عبور می‌کنند

## 2026-07-03

- **اضافه شد** flag `--single`: فقط یک provider را امتحان کن بدون级联، برای قفل跨 worker در IndependentTasks استفاده می‌شود

- checkOverlays(): یک عبارت سه‌تایی مرده را تعمیر کرد (`dismissable ? 'error' : 'error'`)

- شاخه `stopWaitMode='detached'` در waitForCompletion() (Qwen): کسر زمان سپری شده اضافه شد، تا از over-budget شدن تک provider جلوگیری شود

- postResponseHook در adapter Claude: آستانه 30 کاراکتری که با minResponseLength:5 تناقض داشت حذف شد، پاسخ کوتاه دیگر به اشتباه کشته نمی‌شود

- off-by-one در چرخش لاگ telemetry.js: `.2` قبلاً ساکت覆盖 می‌شد و گم می‌شد، اکنون به درستی به `.3` می‌افتد

- تشخیص پاسخ Kimi: مقایسه برابری رشته → شمارش عنصر + رشد طول متن، باگ عدم مطابقت متن یکسان تعمیر شد

- جلسه جدید Kimi: قبل از هر فراخوانی `.new-chat-btn` کلیک می‌شود تا DOM قدیمی پاک شود، از تداخل detection جلوگیری می‌کند

- تشخیص greeting در Kimi: `oldCount===1 && oldText<30chars` → به عنوان صفحه خالی در نظر گرفته می‌شود

- پنجره ثبات Kimi: تطبیقی (5s/30s/20s/15s/8s)، متن کوتاه دیگر 30 ثانیه انتظار نمی‌کشد

- timeout سریال Kimi: selector 60s → 10s هر کدام، بدترین حالت 45s → 30s

- timeout طولانی prompt در Gemini Pro Extended: دکمه توقف قابل مشاهده=هنوز در حال فکر کردن، انتظار +120 ثانیه延长 شد

- placeholder «Thinking» در Claude: پاسخ خالی Thinking/Analyzing فیلتر شد، تشخیص توقف چندگانه

- Promise.allSettled: استثنا در تک worker در IndependentTasks دیگر روی سایر workerها تأثیر نمی‌گذارد
