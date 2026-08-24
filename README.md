# AgentChat — گردش‌کار Free WebSubAgent

> مجموعه‌ای از مهارت‌های Claude Code برای تقسیم وظایف میان هوش مصنوعی‌ها و استفاده از AIهای رایگان وب از طریق مرورگر Chrome محلی.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Node.js-18+-green.svg)](https://nodejs.org/)
[![Python](https://img.shields.io/badge/Python-3.8+-blue.svg)](https://www.python.org/)
[![Providers](https://img.shields.io/badge/Providers-8-orange.svg)](#-چرا-از-agentchat-استفاده-کنیم)
[![Zero API Cost](https://img.shields.io/badge/Cost-$0-success.svg)](#-چرا-از-agentchat-استفاده-کنیم)
[![Claude Code Ready](https://img.shields.io/badge/Claude_Code-Skill_Ready-8A2BE2.svg)](#-یکپارچهسازی-با-claude-code)

## Free WebSubAgent چیست؟

- یک مجموعه مهارت بدون هزینه برای Claude Code که با کنترل Chrome محلی، به ۸ هوش مصنوعی رایگان وب متصل می‌شود.
- از زنجیره جایگزینی ترتیبی و ارکستراسیون موازی با تقسیم نقش و داوری شواهد پشتیبانی می‌کند.
- پس از تمام شدن سهمیه رایگان یک مدل، به‌صورت خودکار به مدل رایگان بعدی سوئیچ می‌کند.

## چرا از AgentChat استفاده کنیم؟

| Skill | نوع | وظیفه | چه زمانی استفاده کنیم؟ |
|---|---|---|---|
| **AgentChat-OneWeb** | زنجیره جایگزینی ترتیبی | یک AI اصلی و ۷ جایگزین؛ با تمام شدن سهمیه، به‌صورت خودکار بین ۸ Provider جابه‌جا می‌شود. | کدنویسی و کارهای چندرسانه‌ای |
| **AgentChat-IndependentTasks** | ارکستراسیون موازی | اجرای هم‌زمان چند AI برای وظایف مستقل و تقسیم‌شدنی. | تعداد زیادی وظیفه مستقل |
| **AgentChat-WebSubAgent** | پایپ‌لاین ترتیبی | پایپ‌لاین ۶ مرحله‌ای: برنامه‌ریزی → جست‌وجو → استدلال → ترکیب → بررسی → اصلاح. | استدلال عمیق و کنترل کیفیت |

---

## معماری

![AgentChat Architecture](1.png)

## شروع سریع — ۵ دقیقه

### ۱. نصب

```bash
git clone https://github.com/ziwang-Physics/AgentChat.git && cd AgentChat

# وابستگی‌های Python — daemon از Chrome نصب‌شده سیستم استفاده می‌کند
pip3 install playwright websocket-client

# وابستگی‌های Node.js
npm install
(cd skills/AgentChat-OneWeb && npm install)
```

### ۲. پیکربندی و اجرا

```bash
cp .env.example .env           # در صورت نیاز آدرس Proxy را تغییر دهید
bash scripts/setup.sh          # بررسی محیط
bash scripts/start-chrome-debug.sh  # اجرای Chrome daemon
```

### ۳. نمونه استفاده

```bash
# یک prompt با دسترس‌پذیری بالا و fallback خودکار
/AgentChat-OneWeb برای من یک اسکریپت Python بنویس

# اجرای موازی وظایف مستقل
/AgentChat-IndependentTasks این وظایف مستقل را میان AIها تقسیم کن

# پایپ‌لاین عمیق ترتیبی
/AgentChat-WebSubAgent برای من معماری یک صف پیام با همزمانی بالا طراحی کن
```

## یکپارچه‌سازی با Claude Code

این پروژه یک مجموعه Skill بومی برای Claude Code است. هر Skill شامل این فایل‌هاست:

| فایل | مخاطب | وظیفه |
|---|---|---|
| `SKILL.md` | Claude Code | دستورالعمل، شرایط فعال‌سازی و مراحل اجرا |
| `index.js` | Runtime | پیاده‌سازی Playwright/CDP |
| `README.md` | توسعه‌دهنده | معرفی، نصب و نحوه استفاده |

> با ایجاد symlink از `skills/` به `~/.claude/skills/`، Claude Code می‌تواند این منابع رایگان را به‌صورت خودکار فراخوانی کند.

## تشخیص محیط

```bash
node skills/AgentChat-OneWeb/index.js --smoke
node skills/AgentChat-OneWeb/index.js --doctor
node skills/AgentChat-IndependentTasks/index.js --smoke
node skills/AgentChat-WebSubAgent/index.js --doctor
```

## ساختار پروژه

```text
AgentChat/
├── .env.example                         # قالب تنظیمات
├── .gitignore
├── LICENSE                              # MIT
├── package.json                         # وابستگی‌های ریشه
├── README.md                            # مستندات اصلی
├── 1.png                                # نمودار معماری
├── scripts/
│   ├── setup.sh / setup.bat             # بررسی یک‌مرحله‌ای محیط
│   ├── start-chrome-debug.sh            # Chrome CDP daemon برای Linux
│   ├── start-chrome-debug.py            # مدیریت چرخه عمر Chrome
│   ├── start-chrome.ps1                 # اجرای Chrome در Windows PowerShell
│   └── connect-gemini.sh / .ps1         # اتصال سریع به Gemini
└── skills/
    ├── lib/                             # کتابخانه مشترک
    │   ├── execute.js                   # اجرای یکنواخت subprocessها
    │   ├── providerFactory.js           # پایپ‌لاین مبتنی بر پیکربندی
    │   ├── errors.js                    # ProviderError و رهگیری مراحل
    │   ├── cdp.js                       # اتصال CDP و retry و doctor
    │   ├── terminal.js                  # spinner و زمان‌سنج ترمینال
    │   ├── telemetry.js                 # چرخش لاگ‌های telemetry
    │   ├── locks.js                     # قفل فایل و جلوگیری از تداخل Providerها
    │   ├── geminiModelSwitch.js         # تعویض مدل Gemini
    │   ├── prompts.js                   # قالب prompt برای DAG
    │   └── providers/
    │       ├── chain.js                 # زنجیره اولویت Providerها
    │       └── adapters/                # تنظیمات ۸ Provider
    ├── AgentChat-OneWeb/                # زنجیره Fallback هشت‌گانه
    │   ├── SKILL.md
    │   ├── index.js
    │   ├── CHANGELOG.md
    │   ├── package.json
    │   └── data/
    ├── AgentChat-IndependentTasks/     # ارکستراسیون موازی
    │   ├── SKILL.md
    │   └── index.js
    └── AgentChat-WebSubAgent/           # پایپ‌لاین ۶ مرحله‌ای
        ├── SKILL.md
        └── index.js
```

## نیازمندی‌های محیط

| وابستگی | حداقل/روش نصب |
|---|---|
| **Node.js** | 18+ |
| **Python** | 3.8+ |
| **Playwright Python** | `pip3 install playwright` |
| **websocket-client** | `pip3 install websocket-client` |
| **playwright-core** | با `npm install` در ریشه پروژه |

### متغیرهای `.env`

| متغیر | مقدار پیش‌فرض | توضیح |
|---|---|---|
| `CDP_PORT` | `9222` | پورت Chrome DevTools Protocol |
| `PROXY_SERVER` | `http://127.0.0.1:7897` | آدرس Proxy |
| `CHROME_PROFILE` | `~/.chrome-debug-profile` | پروفایل پایدار Chrome |
| `CHROMIUM_PATH` | بدون مقدار | مسیر اجرایی Chrome سیستم |
| `LOG_FILE` | `/tmp/chrome-debug.log` | فایل لاگ تشخیصی |

## ورود به سرویس‌های AI

پیش از اولین استفاده، در Chrome به سرویس‌های زیر وارد شوید. وضعیت ورود در `CHROME_PROFILE` ذخیره می‌شود و معمولاً فقط یک‌بار لازم است:

| AI | آدرس ورود |
|---|---|
| Gemini | `gemini.google.com/u/0/app` |
| ChatGPT | `chatgpt.com` |
| Claude | `claude.ai` |
| Qwen | `www.qianwen.com` |
| Kimi | `kimi.moonshot.cn` |
| MiniMax | `agent.minimaxi.com` |
| MiMo | `aistudio.xiaomimimo.com` |
| DeepSeek | `chat.deepseek.com` |

## شبکه و Proxy

در محیط‌هایی که دسترسی مستقیم به سرویس‌های خارجی محدود است، مقدار `PROXY_SERVER` را با یک HTTP یا SOCKS5 Proxy معتبر تنظیم کنید.

از قرار دادن رمز عبور، API key یا Secret واقعی در Repository خودداری کنید. فایل `.env` باید خصوصی بماند.

## عیب‌یابی

| مشکل | علت احتمالی | راه‌حل |
|---|---|---|
| Gemini روی `about:blank` می‌ماند | مشکل Chrome یا شبکه | Chrome daemon را دوباره راه‌اندازی و Proxy را بررسی کنید |
| `ERR_BLOCKED_BY_CLIENT` | Safe Browsing یا تنظیمات Chrome | flags و تنظیمات Chrome را بررسی کنید |
| خطای SSL `net_error -100` | Proxy یا TLS | HTTP/SOCKS5 Proxy را بررسی کنید |
| `MODULE_NOT_FOUND: playwright-core` | وابستگی Node.js نصب نشده | `npm install` در ریشه پروژه |

### مدیریت دستی

```bash
# وضعیت daemon
curl -s http://127.0.0.1:9222/json/list

# مشاهده لاگ
cat /tmp/chrome-debug.log

# راه‌اندازی مجدد کامل
pkill -9 -f "start-chrome-debug.py" && pkill -9 chrome
sleep 2 && bash scripts/start-chrome-debug.sh
```

## مشارکت در پروژه

برای گزارش مشکل یا پیشنهاد تغییر، Issue یا Pull Request ایجاد کنید. برای افزودن Provider جدید، تنظیمات adapter را در `lib/providers/adapters/` اضافه کنید و اصل «بدون کد اختصاصی Provider در لایه ارکستراسیون» را حفظ کنید.

## مجوز

MIT © [ziwang-Physics](https://github.com/ziwang-Physics)
