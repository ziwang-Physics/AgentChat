/**
 * MiMo (Xiaomi MiMo Studio) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React/Tailwind SPA — needs 4s navPostDelay
 *   - Send button located via DOM traversal from textarea, not CSS selectors
 *   - customSend overrides the factory's default clickSend
 */

module.exports = {
    key: 'mimo',
    url: 'https://aistudio.xiaomimimo.com/',
    navPostDelay: 4000, // React/Tailwind SPA render
    authDomains: ['aistudio.xiaomimimo.com/login', 'auth0.com'],
    quotaPatterns: [
        /额度.*(?:已|用).*(?:完|尽|满)/i,
        /quota\s*(?:exceeded|limit)/i,
        /免费版.*升级/i,
        /请.*(?:充值|升级|续费)/i,
    ],
    dismissPatterns: [/welcome/i, /what'?s\s*new/i, /新功能/i, /公告/i],
    editorSelectors: [
        'textarea[placeholder*="有问题，尽管问"]',
        'textarea[placeholder*="Shift + Enter"]',
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
    responseSelectors: ['.markdown-prose', '.Markdown_markdown__', '[class*="markdown"]'],
    stabilityWindow: 15_000,
    minResponseLength: 5,
};
