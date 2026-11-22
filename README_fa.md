# AgentChat - مجموعه مهارت‌های رایگان هوش مصنوعی

## 🎯 AgentChat چیست؟

**AgentChat** یک مجموعه مهارت‌های رایگان برای Claude Code است که از طریق مرورگر Chrome محلی، به **۸ هوش مصنوعی رایگان** متصل می‌شود:

- Gemini (گوگل)
- ChatGPT (OpenAI)
- Claude (Anthropic)
- Qwen (علی‌بابا)
- Kimi (Moonshot)
- MiniMax
- MiMo (شیائومی)
- DeepSeek

### 💡 ایده اصلی
به جای پرداخت هزینه برای API، از سهمیه رایگان این سرویس‌ها استفاده می‌کند و وقتی سهمیه یکی تمام شد، خودکار به بعدی سوئیچ می‌کند.

---

## 📦 سه مهارت اصلی

| مهارت | کاربرد | چه زمانی استفاده کنیم |
|-------|--------|----------------------|
| **AgentChat-OneWeb** | زنجیره fallback سریال | وقتی یک سوال دارید و می‌خواهید خودکار بین ۸ AI جابجا شود |
| **AgentChat-IndependentTasks** | اجرای موازی | وقتی چندین task مستقل دارید و می‌خواهید همزمان به ۸ AI بدهید |
| **AgentChat-WebSubAgent** | پایپ‌لاین ۶ مرحله‌ای | وقتی نیاز به تحقیق عمیق + استدلال + بررسی کیفیت دارید |

---

## 🚀 نصب و راه‌اندازی (۵ دقیقه)

### ۱. نصب وابستگی‌ها

```bash
# کلون کردن پروژه
git clone https://github.com/stableagent/AgentChatss.git && cd AgentChatss

# نصب وابستگی‌های پایتون
pip3 install playwright websocket-client

# نصب وابستگی‌های Node.js
npm install
(cd skills/AgentChat-OneWeb && npm install)
```

### ۲. تنظیمات و اجرا

```bash
# کپی فایل تنظیمات
cp .env.example .env

# بررسی محیط
bash scripts/setup.sh

# شروع Chrome daemon
bash scripts/start-chrome-debug.sh
```

### ۳. ورود به حساب‌های AI (فقط بار اول)

باید در Chrome باز شده، به صورت دستی وارد حساب‌های زیر شوید:

| AI | آدرس | نوع حساب |
|----|------|---------|
| Gemini | gemini.google.com | گوگل |
| ChatGPT | chatgpt.com | OpenAI |
| Claude | claude.ai | Anthropic |
| Qwen | www.qianwen.com | علی‌بابا/تاobao |
| Kimi | kimi.moonshot.cn | ویچت/شماره موبایل |
| MiniMax | agent.minimaxi.com | شماره موبایل |
| MiMo | aistudio.xiaomimimo.com | حساب شیائومی |
| DeepSeek | chat.deepseek.com | ویچت/شماره موبایل |

> وضعیت ورود ذخیره می‌شود و فقط یک بار نیاز است.

---

## 📝 نحوه استفاده

### حالت ۱: سوال تکی با fallback خودکار

```bash
/AgentChat-OneWeb "برای من یک اسکریپت پایتون بنویس که..."
```

این دستور سوال شما را به ترتیب به ۸ AI می‌فرستد و اولین پاسخی که بگیرد را برمی‌گرداند.

### حالت ۲: چندین task مستقل به صورت موازی

```bash
/AgentChat-IndependentTasks "این ۸ task مستقل را بین AIها تقسیم کن: ..."
```

مثلاً اگر ۱۶ task دارید، هر AI دو task را انجام می‌دهد.

### حالت ۳: پایپ‌لاین عمیق ۶ مرحله‌ای

```bash
/AgentChat-WebSubAgent "یک طرح معماری برای سیستم پیام‌رسان طراحی کن"
```

**مراحل:**
1. Claude Code برنامه‌ریزی می‌کند
2. Kimi جستجوی وب انجام می‌دهد
3. Gemini استدلال عمیق می‌کند (اگر پیچیده باشد)
4. Claude پاسخ نهایی را ترکیب می‌کند
5. ChatGPT/Claude بررسی و نقد می‌کند
6. Claude اصلاحات را اعمال می‌کند

---

## ⚙️ فایل‌های کلیدی

| فایل | وظیفه |
|------|-------|
| `SKILL.md` | راهنمای اجرا برای Claude Code |
| `index.js` | کد اجرایی هر مهارت |
| `README.md` | مستندات انسانی |
| `lib/` | کتابخانه مشترک بین همه مهارت‌ها |

---

## 🔧 عیب‌یابی

| مشکل | دلیل | راه حل |
|------|------|--------|
| تب Gemini خالی است (`about:blank`) | حالت ایمنی Chrome | `pkill -9 chrome && bash scripts/start-chrome-debug.sh` |
| خطای SSL `-100` | فیلتر یا مشکل TLS | از پروکسی HTTP/SOCKS5 استفاده کنید، نه VLESS Reality |
| ماژول پیدا نشد | وابستگی‌ها نصب نشده | `npm install` در ریشه پروژه |

---

## 🇮🇷 نکته مهم برای کاربران ایران

- حتماً در فایل `.env` پروکسی صحیح تنظیم کنید
- از VLESS Reality استفاده نکنید (با Chrome سازگار نیست)
- پروکسی HTTP یا SOCKS5 توصیه می‌شود

---

## 📄 رسید اجرا (Receipt)

هر بار که یک مهارت اجرا می‌شود، یک **رسید ماشین‌خوان** تولید می‌کند:

```
[receipt] AGENTCHAT_RUN {"run_id":"ac-xxxx","skill":"AgentChat-OneWeb","provider_used":"Gemini",...}
```

- این رسید باید در پاسخ نهایی ذکر شود
- قابل ردیابی در `data/receipts.jsonl` است
- بدون رسید = اجرا انجام نشده!

---

## جمع‌بندی

**AgentChat** به شما اجازه می‌دهد:
- ✅ از ۸ هوش مصنوعی رایگان به صورت همزمان استفاده کنید
- ✅ وقتی سهمیه یکی تمام شد، خودکار به بعدی برود
- ✅ برای taskهای پیچیده، چند AI را به صورت لوله‌ای به کار بگیرید
- ✅ همه چیز روی مرورگر محلی شما اجرا می‌شود (امن و خصوصی)

برای شروع، کافیست مراحل نصب را دنبال کنید و اولین سوال خود را با `/AgentChat-OneWeb` بپرسید!

---

## مجوز

این پروژه تحت مجوز MIT منتشر شده است.
