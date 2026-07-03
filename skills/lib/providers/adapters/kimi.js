/**
 * Kimi (月之暗面 Moonshot) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - preInputHook clicks "新建会话" to start a fresh conversation
 *   - customSend handles Kimi's .send-button-container with disabled class detection
 *   - navPostDelay=4s for React SPA mount
 *   - postResponseHook rejects truncated opening lines (e.g. "我来从...")
 */

module.exports = {
    key: 'kimi',
    url: 'https://kimi.moonshot.cn/',
    navPostDelay: 4000, // React SPA render time
    authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'],
    quotaPatterns: [
        /高峰.*算力.*不足/i,
        /Kimi.*(?:累了|休息)/i,
        /聊的人太多了/i,
        /前往升级/i,
        /额度.*(?:已|用).*(?:完|尽|满)/i,
    ],
    dismissPatterns: [/新功能/i, /公告/i, /更新.*日志/i, /版本.*更新/i],

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
    ],
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 10,

    // ── Reject truncated responses (Kimi occasionally stops mid-sentence) ──
    postResponseHook: async (_page, text) => {
        if (text.length < 80 && /^(我来|让我|我将|我会|下面|以下|首先)/.test(text)) {
            return ''; // fails minResponseLength → factory returns error
        }
        return text;
    },
};
