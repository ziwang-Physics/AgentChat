/**
 * ChatGPT provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React contenteditable editor with 3-tier input strategy
 *   - Send-button React state verification (batch updates may delay enable)
 *   - Input strategy: clipboard → simulated PasteEvent → chunked keyboard
 *
 * CHANGELOG (2026-07-03):
 *   - FIX: navPostDelay=4000 — React SPA must mount ProseMirror before editor search;
 *     without delay, only the hidden <textarea class="wcDTda_fallbackTextarea">
 *     exists in initial DOM → findEditableElement falls through to textarea selector
 *     → isVisible times out (element hidden) → ERR_ALL_EXHAUSTED
 *   - FIX: validateEditor now rejects wcDTda_fallbackTextarea class
 *   - FIX: preInputHook waits for visible ProseMirror div as double insurance
 *   - FIX: changed textarea selector to 'textarea:not(.wcDTda_fallbackTextarea)'
 */

const { inputViaClipboard, inputViaSimulatedPaste, inputViaKeyboard, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');

module.exports = {
    key: 'chatgpt',
    url: 'https://chatgpt.com/',
    authDomains: ['auth.openai.com', 'chat.openai.com/auth'],
    navPostDelay: 4000, // ⚡ React SPA mounts ProseMirror ~2-3s after domcontentloaded
    quotaPatterns: [
        /reached.*(?:limit|quota|cap)/i,
        /upgrade\s*(?:to|your)\s*plus/i,
        /free\s*(?:plan|tier)\s*limit/i,
        /usage\s*(?:limit|cap|exceeded)/i,
        /you'?ve\s*(?:reached|hit).*(?:limit|cap)/i,
        /请.*升级/i,
        /额度.*(?:用|已).*尽/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /welcome\s*back/i,
    ],
    editorSelectors: [
        '#prompt-textarea',                          // ProseMirror div (visible, React-mounted)
        '[contenteditable="true"][role="textbox"]',  // generic ProseMirror
        'div[contenteditable="true"]:not(.ProseMirror-hide)', // any visible editable div
        'textarea:not(.wcDTda_fallbackTextarea)',    // textarea but NOT the hidden fallback
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el => {
            // Reject the hidden ProseMirror fallback textarea
            if (el.tagName === 'TEXTAREA' && el.classList.contains('wcDTda_fallbackTextarea')) {
                return false;
            }
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
            }
            return el.getAttribute('contenteditable') !== 'false'
                && !el.hasAttribute('readonly')
                && !el.hasAttribute('disabled');
        });
    },
    sendSelectors: [
        'button[data-testid="send-button"]',         // primary — verified 2026-07-03
        'button[aria-label="发送提示"]',              // Chinese locale variant
        'button[aria-label="Send prompt"]',           // English locale variant
        'button[aria-label="Send"]',                  // short English variant
        // P1-11: removed 'button svg' — matches ANY button containing an SVG
        // (new-chat, voice-input, attach-file, etc.), so misclick risk >> benefit.
        // sendFallback: 'Enter' already covers the case where no selector matches.
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[data-testid="stop-button"]',
        'button[aria-label="Stop"]',
    ],
    responseSelectors: [
        '.markdown',
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '[class*="response"]',
    ],
    // v13: DALL·E mounts the generated <img> as a SIBLING of the .markdown
    // text container inside the assistant turn — scanning only the matched
    // responseEl misses it. Widen the image scan to the enclosing turn.
    imageScopeSelector: '[data-message-author-role="assistant"]',
    stabilityWindow: 10_000,
    responseFormat: 'markdown',
    minResponseLength: 5,

    // ── Pre-input hook: wait for ProseMirror editor to be ready ──
    // The navPostDelay handles the common case, but this is the safety net
    // for slow network / server-rendered pages that take longer to hydrate.
    preInputHook: async (page, C) => {
        // Wait for the ProseMirror editor div to be visible and interactive
        // (not the hidden fallback textarea that exists in initial HTML)
        try {
            await page.locator('#prompt-textarea[contenteditable="true"]').first()
                .waitFor({ state: 'visible', timeout: 8000 });
        } catch (_) {
            // If ProseMirror didn't appear, try waiting for any visible textbox
            await page.waitForTimeout(3000);
        }
    },

    // ── ChatGPT-specific: clipboard-first with React Send-button verification ──
    // React contenteditable requires onPaste to be triggered for state update.
    // Strategy: clipboard paste (now with polling) → simulated paste → keyboard chunks.
    input: async (page, editor, prompt) => {
        // Tier 1: clipboard paste with adaptive polling
        let ok = await inputViaClipboard(page, editor, prompt);

        // Tier 2: simulated ClipboardEvent (bypasses clipboard API permission issues)
        if (!ok) {
            ok = await inputViaSimulatedPaste(page, editor, prompt);
        }

        // Tier 3: keyboard.insertText chunked (nuclear option, always works)
        if (!ok) {
            await inputViaKeyboard(page, editor, prompt, { chunkSize: 150, yieldMs: 40 });
            ok = true;
        }

        // Verify Send button — React batches state updates asynchronously
        const sendBtn = page.locator('button[data-testid="send-button"]').first();
        let sendEnabled = false;
        try {
            sendEnabled = await sendBtn.evaluate(el =>
                !el.hasAttribute('disabled')
                && el.getAttribute('aria-disabled') !== 'true'
                && !el.classList.contains('disabled')
            );
        } catch (_) { /* button may not exist yet */ }

        if (!sendEnabled) {
            // Trigger React onChange via InputEvent to enable the send button
            await editor.evaluate(node => {
                node.dispatchEvent(new InputEvent('input', {
                    bubbles: true, composed: true,
                    inputType: 'insertText', data: ' ',
                }));
            });
            await page.waitForTimeout(600);
        }

        return ok;
    },
};
