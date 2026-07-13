/**
 * Kimi (月之暗面 Moonshot) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - preInputHook clicks "新建会话" to start a fresh conversation
 *   - customSend handles Kimi's .send-button-container with disabled class detection
 *   - navPostDelay=4s for React SPA mount
 *   - postResponseHook rejects truncated opening lines (e.g. "我来从...")
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');

module.exports = {
    key: 'kimi',
    url: 'https://kimi.moonshot.cn/',
    navPostDelay: 4000, // React SPA render time
    authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'],
    quotaPatterns: [
        /高峰.*算力.*不足/i,
        /Kimi.*(?:累了|休息)/i,
        /聊的人太多了/i,
        // BUGFIX: bare /前往升级/i matched the permanent "Upgrade" CTA
        // button/text visible on EVERY Kimi page (sidebar upsell banner),
        // falsely marking a perfectly available provider as quota-exhausted.
        // Only treat it as quota when tied to a usage-exhausted context
        // (same principle as Gemini adapter's narrow quota patterns — any
        // bare "Upgrade" link would false-positive on every page visit).
        /(?:额度|次数|用完|用尽|不够|上限).{0,30}前往升级/i,
        /额度.*(?:已|用).*(?:完|尽|满)/i,
    ],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS, /版本.*更新/i],

    // ── Start fresh conversation to avoid stale DOM from previous chats ──
    preInputHook: async (page) => {
        try {
            const clicked = await page.evaluate(() => {
                let btn = document.querySelector('.new-chat-btn');
                if (!btn) {
                    const links = document.querySelectorAll(
                        'a, div[class*="new-chat"], div[class*="sidebar-new"]'
                    );
                    for (const el of links) {
                        if ((el.textContent || '').includes('新建会话')) { btn = el; break; }
                    }
                }
                if (btn) { btn.click(); return true; }
                return false;
            });
            if (clicked) await page.waitForTimeout(2500);
        } catch (_) { /* non-critical */ }
    },

    editorSelectors: [
        '.chat-input-editor',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ],

    // ── Kimi's send button loses "disabled" class when text is entered ──
    customSend: async (page) => {
        const sendBtn = page.locator('.send-button-container').first();
        await page.waitForTimeout(800);
        // BUGFIX: catch default was inverted. If the button doesn't exist,
        // evaluate() rejects → .catch(() => false) claimed "not disabled" →
        // sendBtn.click() then burned a 30s locator timeout and failed the
        // whole provider. A missing/unknown button must route to Enter.
        const isDisabled = await sendBtn.evaluate(
            el => el.className.includes('disabled')
        ).catch(() => true);
        if (isDisabled) {
            await page.keyboard.press('Enter');
        } else {
            try {
                await sendBtn.click({ timeout: 5000 });
            } catch (_) {
                await page.keyboard.press('Enter'); // click failed → Enter fallback
            }
        }
    },

    responseSelectors: [
        '[class*="chat-content-item-assistant"]',
        '[class*="segment-content"]',
        '[class*="chat-content-list"] [class*="assistant"]',
        // v10: all three above anchor on the chat-content/segment naming
        // family — one rename kills them together. Generic tails are only
        // reached when the specific ones fail (budget-clamped upstream).
        '[class*="assistant"]',
        '[class*="markdown"]',
    ],
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 10,

    // ── Prevent premature "done" during Kimi's multi-round search pauses ──
    // Kimi's search process: query → pause(5-30s fetch) → analysis → next query → ...
    // During pauses the text stops growing, which fools the stability poller into
    // declaring completion. This check resets the stability clock when Kimi is
    // clearly between search rounds (text ends with a query or result count).
    stillGeneratingCheck: async (page) => {
        try {
            // Use the same selector as responseSelectors[0] for consistency
            const el = page.locator('[class*="chat-content-item-assistant"]').last();
            const text = (await el.evaluate(el => el.innerText || el.textContent || '')
                .catch(() => '')).trim();
            if (!text || text.length < 50) return false;

            const tail = text.slice(-300);
            const STILL_SEARCHING = [
                /搜索[网页关键词资料].*\s*$/,     // ends with a search query line
                /\d+\s*[个条]\s*结[果].*\s*$/,    // ends with "X 个结果"
                /让我[再继续].*\s*$/,             // "让我再搜索..."
                /正在[搜索检索查询].*\s*$/,       // "正在搜索..."
                /还需[要更].*\s*$/,               // "还需要更多..."
            ];
            return STILL_SEARCHING.some(p => p.test(tail));
        } catch (_) {
            return false;
        }
    },

    // ── Reject truncated responses (Kimi occasionally stops mid-sentence) ──
    postResponseHook: async (_page, text) => {
        if (text.length < 80 && /^(我来|让我|我将|我会|下面|以下|首先)/.test(text)) {
            return ''; // fails minResponseLength → factory returns error
        }
        return text;
    },
};
