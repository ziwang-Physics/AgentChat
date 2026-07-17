/**
 * MiMo (Xiaomi MiMo Studio) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React/Tailwind SPA — needs 4s navPostDelay
 *   - Send button located via DOM traversal from textarea, not CSS selectors
 *   - customSend overrides the factory's default clickSend
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = ['.markdown-prose', '.Markdown_markdown__', '[class*="markdown"]'];

module.exports = {
    key: 'mimo',
    url: 'https://aistudio.xiaomimimo.com/',
    navPostDelay: 4000, // React/Tailwind SPA render
    authDomains: ['aistudio.xiaomimimo.com/login', 'auth0.com'],
    quotaPatterns: [
        ...COMMON_CN_QUOTA_PATTERNS,
        // BUGFIX: bare /免费版.*升级/i matched permanent upsell banners
        // visible on EVERY MiMo page ("免费版" branding + "升级" CTA in the
        // header/sidebar area), falsely marking the provider as quota-
        // exhausted. Only treat it as quota when tied to a usage-exhausted
        // context (same principle as Gemini/Kimi adapter fixes).
        /(?:额度|次数|用完|用尽|已达|上限).{0,30}免费版.*升级/i,
    ],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS],
    // MiMo shows a permanent footer disclaimer ("本网站为面向开发者的模型能力演示平台，
    // 非正式 AI 助手，内容由 AI 生成仅供参考。") that sits inside a container which
    // matches OVERLAY_SEL ([class*="dialog"] etc.) but is NOT a dismissable modal.
    // Skip it so the overlay check doesn't falsely block the provider.
    skipOverlayPatterns: [
        /本网站为面向开发者的模型能力演示平台/i,
    ],
    editorSelectors: [
        // v10: same P0 as DeepSeek — both entries anchored on placeholder COPY
        // (the most volatile anchor: one wording tweak = provider dead at
        // EDITOR_FIND). Structural fallbacks appended, specific-first order
        // preserved. customSend already routes to Enter when its own
        // placeholder-based traversal misses, so send stays consistent.
        'textarea[placeholder*="有问题，尽管问"]',
        'textarea[placeholder*="Shift + Enter"]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ],
    // MiMo's send button is found via DOM traversal from textarea, not CSS selectors.
    // Tries both editorSelectors placeholder variants — the textarea that actually
    // matched during Step 5 (Chinese or English UI) may be either one.
    customSend: async (page, _editor) => {
        let sent = false;
        for (const textareaSel of [
            'textarea[placeholder*="有问题，尽管问"]',
            'textarea[placeholder*="Shift + Enter"]',
        ]) {
            try {
                const sendBtn = page.locator(textareaSel)
                    .locator('..').locator('..')  // grandparent container
                    .locator('button:not([disabled])')
                    .filter({ has: page.locator('svg') }).last();
                if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                    await sendBtn.click();
                    sent = true;
                    break;
                }
            } catch (_) { /* try next placeholder variant */ }
        }
        if (!sent) await page.keyboard.press('Enter');
    },
    responseSelectors: RESPONSE_SELECTORS,
    stabilityWindow: 15_000,
    responseFormat: 'markdown',
    minResponseLength: 5,

    // v11: no stop selectors are known for this UI — the shared detector is
    // the only completion guard during slow reasoning; hold cap bounds it.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
};
