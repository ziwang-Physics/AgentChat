/**
 * Kimi (月之暗面 Moonshot) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - preInputHook clicks "新建会话" to start a fresh conversation,
 *     then ensures "快速模式" (fast mode) is selected
 *   - customSend handles Kimi's .send-button-container with disabled class detection
 *   - navPostDelay=4s for React SPA mount
 *   - postResponseHook rejects truncated opening lines (e.g. "我来从...")
 *   - v11: stillGeneratingCheck = shared multi-signal detector (stillWorking.js)
 *     covering the full 联网搜索 phase vocabulary (搜索→获取网页→阅读→整理),
 *     stop-control + spinner DOM signals, bounded by stillGeneratingMaxHoldMs
 *   - v12: ensureKimiFastMode — clicks model selector → "快速模式" (fast mode)
 *     for faster, cheaper responses. Gracefully degrades if selector not found.
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// ── v12: Fast mode selector for Kimi ─────────────────────────────────────────
// Kimi's model selector lets users pick between models (快速模式 / 深入思考 /
// k1.5 / k2 / etc.). The fast mode (快速模式) is the lighter, cheaper model
// suitable for bulk independent tasks. We try to activate it, but degrade
// gracefully — a missing selector means the page default is used, which is
// still a working Kimi (same lenient policy as Gemini model activation).

/** CSS selectors for the model-switch trigger button on Kimi's page. */
const MODEL_BTN_SELECTORS = [
    '[class*="model-select"]',
    '[class*="ModelSelect"]',
    '[class*="modelSelect"]',
    '[class*="mode-switch"]',
    '[class*="modeSwitch"]',
    'button:has(> [class*="model"])',
    '[class*="chat-toolbar"] button',
    '[class*="bottom"] [class*="selector"]',
    '[class*="input-area"] [class*="select"]',
];

/** Text / aria-label patterns that signal fast mode is already active. */
const FAST_MODE_ACTIVE_RE = /快速模式|Fast\s*(?:mode|response|reply|answer)?|Speed\s*(?:mode|priority)?/i;

/** Text patterns for the fast-mode menu item (click target inside the dropdown). */
const FAST_MODE_ITEM_RE = /快速模式|Fast\s*(?:mode|response|reply|answer)?|极速模式/i;

/** Patterns we do NOT want to click — deep-thinking / slow modes. */
const SLOW_MODE_RE = /深入思考|深度推理|Deep\s*(?:think|reason)|长思考|Pro\s*(?:mode)?|k2/i;

/**
 * Ensure Kimi is set to "快速模式" (fast mode).
 *
 * Strategy (verify-by-effect, modelled after Gemini's geminiModelSwitch.js):
 *   1. Peek: scan the page for the current model indicator — skip if already fast.
 *   2. Find & click: locate the model selector button, click to open the menu.
 *   3. Select: click the fast-mode menu item.
 *   4. Verify: re-scan to confirm fast mode is active.
 *
 * All steps are best-effort. Failures degrade to the page default.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<boolean>} true if fast mode was activated or already active
 */
async function ensureKimiFastMode(page) {
    try {
        // ── Step 1: Peek — is fast mode already active? ──
        const alreadyFast = await page.evaluate((reSrc, reFlags) => {
            const re = new RegExp(reSrc, reFlags);
            // Scan visible text near input area for fast-mode indicator
            const body = document.body;
            if (!body) return false;
            // Check if any visible element shows the fast mode text
            const walker = document.createTreeWalker(
                body, NodeFilter.SHOW_TEXT, null
            );
            let node;
            while ((node = walker.nextNode())) {
                const el = node.parentElement;
                if (!el || el.offsetParent === null) continue;
                const txt = (node.textContent || '').trim();
                if (txt.length > 1 && txt.length < 30 && re.test(txt)) {
                    return true;
                }
            }
            return false;
        }, FAST_MODE_ACTIVE_RE.source, FAST_MODE_ACTIVE_RE.flags).catch(() => false);

        if (alreadyFast) return true;

        // ── Step 2: Find & click the model selector button ──
        let menuOpened = false;
        for (const sel of MODEL_BTN_SELECTORS) {
            try {
                const loc = page.locator(sel).first();
                const visible = await loc.isVisible({ timeout: 400 }).catch(() => false);
                if (!visible) continue;

                // Pre-click guard: skip if it's clearly something else
                const text = await loc.evaluate(el =>
                    (el.textContent || '').trim().slice(0, 40)
                ).catch(() => '');
                // If it's just icons / empty / clearly a non-model button, skip
                if (!text || /发送|上传|附件|麦克风|语音/.test(text)) continue;

                await loc.click({ timeout: 2000 });
                await page.waitForTimeout(800);
                menuOpened = true;
                break;
            } catch (_) { /* try next selector */ }
        }

        if (!menuOpened) return false; // no selector found — use page default

        // ── Step 3: Click the fast-mode item in the dropdown ──
        const clicked = await page.evaluate(
            (fastSrc, fastFlags, slowSrc, slowFlags) => {
                const fastRe = new RegExp(fastSrc, fastFlags);
                const slowRe = new RegExp(slowSrc, slowFlags);

                // Common menu item selectors
                const itemSels = [
                    '[class*="dropdown"] [class*="item"]',
                    '[class*="menu"] [class*="item"]',
                    '[class*="popup"] [class*="item"]',
                    '[class*="option"]',
                    '[role="menu"] [role="menuitem"]',
                    '[role="listbox"] [role="option"]',
                    'li[class*="item"]', 'li[class*="option"]',
                    'div[class*="item"][class*="select"]',
                ];

                for (const itemSel of itemSels) {
                    const items = document.querySelectorAll(itemSel);
                    for (const item of items) {
                        if (item.offsetParent === null) continue; // hidden
                        const t = (item.textContent || '').trim();
                        if (!t || t.length > 60) continue;
                        // Prefer fast mode; skip slow/deep modes
                        if (fastRe.test(t) && !slowRe.test(t)) {
                            item.click();
                            return true;
                        }
                    }
                }

                // Fallback: scan ALL visible elements for fast-mode text
                const all = document.querySelectorAll(
                    'div, span, button, li, a, [role="menuitem"], [role="option"]'
                );
                for (const el of all) {
                    if (el.offsetParent === null) continue;
                    const t = (el.textContent || '').trim();
                    if (t.length < 2 || t.length > 50) continue;
                    if (fastRe.test(t) && !slowRe.test(t)) {
                        // Prefer clickable ancestor
                        let clickable = el;
                        while (clickable && clickable.tagName !== 'BUTTON'
                            && clickable.getAttribute('role') !== 'menuitem'
                            && clickable.getAttribute('role') !== 'option') {
                            clickable = clickable.parentElement;
                        }
                        if (clickable && clickable.offsetParent !== null) {
                            clickable.click();
                            return true;
                        }
                    }
                }
                return false;
            },
            FAST_MODE_ITEM_RE.source, FAST_MODE_ITEM_RE.flags,
            SLOW_MODE_RE.source, SLOW_MODE_RE.flags
        ).catch(() => false);

        if (!clicked) {
            // Close the menu if we couldn't find fast mode
            await page.keyboard.press('Escape').catch(() => {});
            return false;
        }

        // ── Step 4: Settle & verify ──
        await page.waitForTimeout(1000);
        await page.keyboard.press('Escape').catch(() => {});

        const confirmed = await page.evaluate((reSrc, reFlags) => {
            const re = new RegExp(reSrc, reFlags);
            const body = document.body;
            if (!body) return false;
            const walker = document.createTreeWalker(body, NodeFilter.SHOW_TEXT, null);
            let node;
            while ((node = walker.nextNode())) {
                const el = node.parentElement;
                if (!el || el.offsetParent === null) continue;
                const txt = (node.textContent || '').trim();
                if (txt.length > 1 && txt.length < 30 && re.test(txt)) return true;
            }
            return false;
        }, FAST_MODE_ACTIVE_RE.source, FAST_MODE_ACTIVE_RE.flags).catch(() => false);

        return confirmed;
    } catch (_) {
        // Best-effort only — a missing selector doesn't break the provider
        return false;
    }
}

// Hoisted so responseSelectors and stillGeneratingCheck are guaranteed to
// judge the SAME container family. The old check hardcoded selector [0]
// ('[class*="chat-content-item-assistant"]') and silently read the wrong
// element — or nothing — whenever the factory had matched a fallback
// selector, disabling the check exactly when the DOM had drifted.
const RESPONSE_SELECTORS = [
    '[class*="chat-content-item-assistant"]',
    '[class*="segment-content"]',
    '[class*="chat-content-list"] [class*="assistant"]',
    // v10: all three above anchor on the chat-content/segment naming
    // family — one rename kills them together. Generic tails are only
    // reached when the specific ones fail (budget-clamped upstream).
    '[class*="assistant"]',
    '[class*="markdown"]',
];

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

    // ── Start fresh conversation + ensure fast mode ──
    preInputHook: async (page) => {
        // Step 1: Click "新建会话" to start a fresh conversation
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

        // Step 2: Ensure "快速模式" (fast mode) is selected
        // Best-effort — degrades gracefully to page default if selector not found
        try {
            const fastOk = await ensureKimiFastMode(page);
            if (fastOk) {
                // v12: use require'd terminal logger like gemini adapter does
                try {
                    const { log: _tlog } = require('../../terminal');
                    _tlog('kimi', '快速模式 (fast mode) active');
                } catch (_) { /* logger not available in all contexts */ }
            }
        } catch (_) { /* best-effort — proceed with page default */ }
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

    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 10,

    // ── Prevent premature "done" during Kimi's multi-round search pauses ──
    // Kimi's search process: query → pause(5-30s fetch) → analysis → next query → ...
    // During pauses the text stops growing, which fools the stability poller
    // into declaring completion.
    //
    // v11 FIX (field-observed truncations at "正在获取网页..." and
    // "获取网页 5 个网页"): the old tail regexes here had a VOCABULARY GAP —
    // 正在[搜索检索查询] does not contain 获取, and "N 个网页" is not
    // "N 个结果" — so the entire 网页获取 phase was invisible to the check
    // and every fetch longer than the 8s stabilityWindow truncated the run.
    // They were also $-anchored against innerText tails (any trailing
    // source-chip line broke the anchor) and hardcoded to selector [0].
    //
    // Replaced with the shared multi-signal detector (lib/stillWorking.js):
    //   S1 zero-cost classification of the factory-polled text,
    //   S2 visible stop/pause control (wording/locale independent),
    //   S3 spinner inside — or busy tail of — the last response container,
    // with the fetch-phase verbs (获取/抓取/阅读/浏览/…) and "N 个网页"
    // count lines in the vocabulary. False positives are bounded by
    // stillGeneratingMaxHoldMs below instead of burning the budget.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),

    // Multi-round search legitimately alternates fetch-silence and text
    // bursts for minutes; the cap re-arms on every REAL text change, so it
    // only bounds a terminal stall (e.g. a final answer whose last line
    // happens to look like a status chip).
    stillGeneratingMaxHoldMs: 180_000,

    // ── Reject truncated responses (Kimi occasionally stops mid-sentence) ──
    postResponseHook: async (_page, text) => {
        if (text.length < 80 && /^(我来|让我|我将|我会|下面|以下|首先)/.test(text)) {
            return ''; // fails minResponseLength → factory returns error
        }
        return text;
    },
};
