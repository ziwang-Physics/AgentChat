/**
 * Qwen (通义千问) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React/Tailwind SPA — needs 3s navPostDelay for mount
 *   - Buttons have Tailwind generic classes — no reliable send selectors
 *   - Stop button removed from DOM (detached) when done, not just hidden
 *   - postResponseHook strips model-name prefix (e.g. "Qwen3.7-Max\n")
 */

const { inputViaClipboard, inputViaSimulatedPaste, inputViaKeyboard, COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = [
    '[class*="message-select-wrapper-answer"]',
    '[class*="chat-answers-card-wrap"]',
    '[class*="message-select-content-inner"]',
    '[class*="message-select-content"]',
    '.chat-round.last-message-item',
    // v10: generic tails — four of the five above share the
    // message-select naming family; a single rename kills them together.
    '[class*="answer"]',
    '[class*="markdown"]',
];

module.exports = {
    key: 'qwen',
    url: 'https://www.qianwen.com/?source=tongyigw',
    navPostDelay: 3000, // React-based SPA needs time to mount
    authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'],
    quotaPatterns: [...COMMON_CN_QUOTA_PATTERNS],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS, /提示/i],
    editorSelectors: [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        '[class*="editor"]',
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el => {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
            }
            return el.getAttribute('contenteditable') !== 'false'
                && !el.hasAttribute('readonly')
                && !el.hasAttribute('disabled');
        });
    },
    // Qwen's buttons have Tailwind generic classes — Enter is the only reliable send
    sendSelectors: [],
    sendFallback: 'Enter',

    // ── Pre-input hook: wait for React editor to be ready ──
    // v22 FIX: qwen is a React/Tailwind SPA whose contenteditable editor may
    // lazy-mount (only when the input area scrolls into view). Without this
    // hook the factory's findEditableElement can silently match a hidden
    // fallback <textarea>, causing error@input on the first fill() attempt.
    preInputHook: async (page, C) => {
        try {
            // Primary: wait for the visible contenteditable editor
            await page.locator('[contenteditable="true"][role="textbox"]').first()
                .waitFor({ state: 'visible', timeout: 8000 });
        } catch (_) {
            // Fallback: extra settle time for slow SPA hydration
            await page.waitForTimeout(3000);
        }
    },

    // ── Qwen-specific input: keyboard-first with explicit focus ──
    // v22 FIX: qwen's React editor does NOT handle ClipboardEvent('paste')
    // with DataTransfer (unlike chatgpt's ProseMirror). The simulated paste
    // clears the DOM then dispatches a paste event that qwen ignores, leaving
    // the editor empty. Subsequent keyboard.insertText dispatches to the
    // page-level focused element, but the React re-render after the DOM clear
    // often resets focus to document.body → text goes nowhere → empty editor
    // → composer mismatch → error@input.
    //
    // Strategy: keyboard-first (CDP Input.insertText is the most reliable
    // path for React editors that don't use ProseMirror), with explicit
    // re-focus before each method. Paste methods are fallback only.
    input: async (page, editor, prompt) => {
        // Ensure editor is focused — React may have reset focus after factory clear
        await editor.click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(200);

        // Tier 1: keyboard.insertText chunked — CDP Input.insertText dispatches
        // real keydown/keypress/input/keyup events that React MUST handle.
        // Chunk at 150 chars with 40ms yield to let React re-render.
        await inputViaKeyboard(page, editor, prompt, { chunkSize: 150, yieldMs: 40 });

        // Tier 2: simulated ClipboardEvent if keyboard somehow failed
        const len = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        ).catch(() => 0);
        if (len < prompt.length * 0.8) {
            await editor.focus().catch(() => {});
            await inputViaSimulatedPaste(page, editor, prompt);
        }

        // Tier 3 (LAST RESORT): system clipboard — racy under concurrency
        const len2 = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        ).catch(() => 0);
        if (len2 < prompt.length * 0.8) {
            await editor.focus().catch(() => {});
            await inputViaClipboard(page, editor, prompt);
        }

        // Trigger React onChange via InputEvent to activate send pathway
        await editor.evaluate(node => {
            node.dispatchEvent(new InputEvent('input', {
                bubbles: true, composed: true,
                inputType: 'insertText', data: ' ',
            }));
        }).catch(() => {});
        await page.waitForTimeout(400);

        return true;
    },
    stopWaitMode: 'detached', // Qwen removes stop button from DOM when done
    stopSelectors: ['[class*="stop"]', '[class*="pause-generat"]'],
    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 5,

    // v11: phase-3 defense for 深度搜索 rounds. Phase-1 handles the detached
    // stop button, but if the stop SELECTOR drifts (or the button re-appears
    // between rounds after phase 1 already passed), the 8s window is as
    // vulnerable as Kimi's was. Bounded by the hold cap.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
    postResponseHook: async (_page, text) =>
        text.replace(/^Qwen[\d.]+-(?:Max|Plus|Turbo|Flash)\s*\n?\s*/i, '').trim(),
};
