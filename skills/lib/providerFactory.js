/**
 * Provider Factory — DRY pipeline for all 8 AI providers.
 *
 * Replaces 8 nearly-identical tryXxx() functions (~1200 lines total) with
 * config-driven createProviderRunner(). Each provider's differences are
 * expressed as data (selectors, patterns, hooks), not duplicated code.
 *
 * Usage:
 *   const runChatGPT = createProviderRunner(chatgptConfig);
 *   const result = await runChatGPT(page, prompt, timeoutMs, ctx);
 *   // → { success: true, response } | { success: false, reason }
 *
 * Design:
 *   - Strategy Pattern: provider differences are config objects
 *   - Template Method: 10-step pipeline is fixed; hooks inject variance
 *   - ProviderError from errors.js: consistent error classification
 */

const { ProviderError, classifyError, STAGES } = require('./errors');
const { appendWithRotation } = require('./telemetry');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG SCHEMA (JSDoc reference — not enforced at runtime)
// ══════════════════════════════════════════════════════════════════════════════
//
// {
//   key: string,              // provider key (gemini, chatgpt, …)
//   name: string,             // display name
//   url: string,              // AI website URL
//   navTimeout?: number,      // page.goto timeout (default: 45000)
//   navWaitUntil?: string,    // page.goto waitUntil (default: 'domcontentloaded')
//   authDomains: string[],    // URL substrings that indicate login redirect
//   quotaPatterns: RegExp[],  // body-text patterns for rate-limit detection
//   editorSelectors: string[],// CSS selectors for input element (tried in order)
//   validateEditor?: (el: Element) => Promise<boolean>,  // extra validation
//   input: (page, editor, prompt, opts) => Promise<boolean>, // input text; return true=ok
//   sendSelectors: string[],  // CSS selectors for send button
//   sendFallback: string,     // keyboard key to press if button not found (e.g. 'Enter')
//   stopSelectors?: string[], // CSS selectors for stop button (generation-in-progress)
//   responseSelectors: string[], // CSS selectors for response container
//   stabilityWindow?: number, // ms of no text change to declare done (default: 10000)
//   pollInterval?: number,    // ms between stability checks (default: 2000)
//   minResponseLength?: number, // minimum response chars (default: 10)
//   navPostDelay?: number,    // ms to wait after page.goto for SPA render (default: 0)
//   stopWaitMode?: 'hidden' | 'detached', // how stop button disappears (default: 'hidden')
//   stopBtnExtensionMs?: number, // extra wait if stop btn still visible after initial timeout (default: 0)
//   completionAnchor?: string | string[], // explicit completion signal (e.g. Action Toolbar)
//   stillGeneratingCheck?: (page) => Promise<boolean>, // reset stability clock if true
//   responseSelectorTimeout?: number, // ms per response selector wait (default: 30000)
//   customSend?: (page, editor) => Promise<boolean>, // override clickSend entirely
//   preInputHook?: (page, cfg) => Promise<void>,   // e.g. Gemini Pro detection
//   postResponseHook?: (page, rawText, cfg) => Promise<string>, // e.g. Qwen prefix strip
// }

// ══════════════════════════════════════════════════════════════════════════════
// DEFAULT VALUES
// ══════════════════════════════════════════════════════════════════════════════

// Shared threshold: prompts longer than this use clipboard paste (O(1) CDP round-trips)
// instead of keyboard.insertText (O(n) CDP round-trips).  Set conservatively to avoid
// React re-render overhead for long payloads, but high enough that short prompts get
// reliable keyboard input.
const INSERT_TEXT_LIMIT = 500;

const DEFAULTS = {
    navTimeout: 45000,
    navWaitUntil: 'domcontentloaded',
    navPostDelay: 0,
    stopWaitMode: 'hidden',
    stopBtnExtensionMs: 0,
    completionAnchor: null,
    stillGeneratingCheck: null,
    responseSelectorTimeout: 30_000,
    stabilityWindow: 10_000,
    pollInterval: 2_000,
    minResponseLength: 10,
    insertTextLimit: INSERT_TEXT_LIMIT,
    input: null, // set below after atomic ops are defined
    dismissPatterns: [], // overlays matching these are safe to dismiss (close button click)
};

// ══════════════════════════════════════════════════════════════════════════════
// SHARED ATOMIC OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Find an editable element matching one of the given selectors.
 * Returns the first visible, non-readonly contenteditable div or textarea.
 */
async function findEditableElement(page, selectors, validateFn) {
    for (const sel of selectors) {
        try {
            const loc = page.locator(sel).first();
            const visible = await loc.isVisible({ timeout: 3000 }).catch(() => false);
            if (!visible) continue;

            const editable = await loc.evaluate(el => {
                if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                    return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
                }
                return el.getAttribute('contenteditable') !== 'false'
                    && !el.hasAttribute('readonly')
                    && !el.hasAttribute('disabled');
            }).catch(() => false);

            if (!editable) continue;

            if (validateFn) {
                const ok = await validateFn(loc).catch(() => false);
                if (!ok) continue;
            }

            return loc;
        } catch (_) { /* next selector */ }
    }
    return null;
}

/**
 * Input text via clipboard paste + polling wait.
 * For React-controlled contenteditable divs, paste triggers onPaste properly,
 * but React's async re-render may not complete within a fixed timeout.
 *
 * Polls until the text appears (up to text.length * 10ms, min 2s).
 * Returns true if the input was successful (editor contains ≥80% of the text).
 */
async function inputViaClipboard(page, editor, prompt) {
    try {
        await page.evaluate(t => navigator.clipboard.writeText(t), prompt);
        await page.keyboard.press('ControlOrMeta+v');
        // Poll — React re-render time scales with text length
        const timeout = Math.max(2000, prompt.length * 10);
        const start = Date.now();
        let len = 0;
        while (Date.now() - start < timeout) {
            await page.waitForTimeout(150);
            len = await editor.evaluate(el =>
                (el.innerText || el.textContent || '').length
            ).catch(() => 0);
            if (len > prompt.length * 0.8) break;
        }
        return len > prompt.length * 0.8;
    } catch (_) {
        return false;
    }
}

/**
 * Input text via simulated ClipboardEvent('paste') with DataTransfer.
 * Triggers React's onPaste handler directly — works even when clipboard API
 * is blocked by CDP permissions. This is the key fix for React contenteditable.
 */
async function inputViaSimulatedPaste(page, editor, prompt) {
    try {
        await editor.evaluate((el, text) => {
            // Clear
            while (el.firstChild) el.removeChild(el.firstChild);
            el.focus();

            // Build DataTransfer
            const dt = new DataTransfer();
            dt.setData('text/plain', text);

            // Dispatch ClipboardEvent — React's onPaste reads event.clipboardData
            const pasteEvent = new ClipboardEvent('paste', {
                bubbles: true,
                cancelable: true,
                clipboardData: dt,
            });
            el.dispatchEvent(pasteEvent);
        }, prompt);
        await page.waitForTimeout(600);

        const len = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        );
        return len > prompt.length * 0.8;
    } catch (_) {
        return false;
    }
}

/**
 * Input text via chunked keyboard.insertText — the nuclear option.
 * 100% reliable (Playwright dispatches real key events) but O(n) characters.
 * For very long prompts, chunks with yields to avoid blocking React re-renders.
 */
async function inputViaKeyboard(page, editor, prompt, { chunkSize = 150, yieldMs = 40 } = {}) {
    for (let i = 0; i < prompt.length; i += chunkSize) {
        const chunk = prompt.substring(i, Math.min(i + chunkSize, prompt.length));
        await page.keyboard.insertText(chunk);
        await page.waitForTimeout(yieldMs);
    }
    await page.waitForTimeout(300);
    return true; // keyboard.insertText always works
}

/**
 * Default input strategy — clipboard paste for large payloads, keyboard for small.
 * Used by providers that don't need custom input logic (Claude, Kimi, MiniMax, etc.).
 */
async function defaultInput(page, editor, prompt, { insertTextLimit = INSERT_TEXT_LIMIT } = {}) {
    if (prompt.length > insertTextLimit) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) {}
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(500);
        const len = await editor.evaluate(el => (el.innerText || el.textContent || '').length);
        return len > prompt.length * 0.8;
    } else {
        await page.keyboard.insertText(prompt);
        await page.waitForTimeout(300);
        return true;
    }
}
DEFAULTS.input = defaultInput;

/**
 * Clear the editor (Ctrl+A → Backspace) and focus it.
 */
async function clearEditor(page, editor) {
    await editor.focus();
    await editor.click();
    await page.waitForTimeout(200);
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('ControlOrMeta+a'); // double-tap for some editors
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
}

/**
 * Find, verify, and click a send button, or press a fallback key.
 *
 * v2: Poll-waits for the button to be both visible AND enabled before clicking.
 *     React contenteditable editors may show a disabled button for 200-800ms
 *     after text is pasted (React batch state update).  A click on a disabled
 *     button is silently ignored.
 */
async function clickSend(page, editor, sendSelectors, fallbackKey) {
    for (const sel of sendSelectors) {
        try {
            const btn = page.locator(sel).first();
            // Wait for button to be VISIBLE (up to 2s)
            if (!(await btn.isVisible({ timeout: 2000 }).catch(() => false))) continue;

            // Poll-wait for button to be ENABLED (React may batch-update state)
            const deadline = Date.now() + 3000;
            let enabled = false;
            while (Date.now() < deadline) {
                enabled = await btn.evaluate(el =>
                    !el.hasAttribute('disabled')
                    && el.getAttribute('aria-disabled') !== 'true'
                    && !el.classList.contains('disabled')
                ).catch(() => false);
                if (enabled) break;
                await page.waitForTimeout(150);
            }
            if (!enabled) continue; // still disabled after 3s → try next selector

            await btn.click();
            await page.waitForTimeout(1500);
            return true;
        } catch (_) { /* next selector */ }
    }
    // Fallback: press the key (usually Enter)
    await editor.focus();
    await page.keyboard.press(fallbackKey || 'Enter');
    await page.waitForTimeout(1500);
    return true;
}

/**
 * Wait for AI to finish generating.
 *
 * Strategy: stop button detection → response element → stability polling.
 * Calls config.onProgress(status) if provided:
 *   '+' = text grew, '.' = stable, '?' = DOM error, '⚙' = still generating
 *
 * v2 (2026-07-03): Added stopBtnExtensionMs, completionAnchor, stillGeneratingCheck
 * for Pro Extended Thinking support (Gemini bursty output, 3-5 min generation).
 */
async function waitForCompletion(page, config, startTime, timeoutMs) {
    const { stopSelectors, stabilityWindow, pollInterval, onProgress } = config;
    const tick = onProgress || (() => {});

    // Phase 1: wait for stop button to appear then disappear
    //
    // BUGFIX (was: always broke after the first selector regardless of match —
    // `.catch(() => {})` on the awaited waitFor() swallowed timeouts *before* the
    // outer try/catch ever saw a rejection, so `break` ran unconditionally on
    // iteration 1). Fix: probe each selector for a short window first; only the
    // selector that actually matches gets the full detection sequence.
    const stopMode = config.stopWaitMode || 'hidden';
    const stopExt = config.stopBtnExtensionMs || 0;
    const STOP_PROBE_TIMEOUT_MS = 3000;
    if (stopSelectors && stopSelectors.length > 0) {
        for (const sel of stopSelectors) {
            const stopBtn = page.locator(sel).first();

            // Quick probe: did *this* selector's stop button actually show up?
            const appeared = await stopBtn
                .waitFor({ state: 'visible', timeout: STOP_PROBE_TIMEOUT_MS })
                .then(() => true)
                .catch(() => false);
            if (!appeared) continue; // this selector never matched — try the next one

            if (stopMode === 'detached') {
                // Qwen: stop button is removed from DOM when done, not just hidden
                await stopBtn.waitFor({ state: 'detached', timeout: Math.min(timeoutMs, 300000) }).catch(() => {});
            } else {
                const remaining = Math.max(30000, timeoutMs - (Date.now() - startTime));
                await stopBtn.waitFor({ state: 'hidden', timeout: remaining }).catch(() => {});

                // Extension for long-generation models (e.g. Pro Extended Thinking)
                if (stopExt > 0) {
                    const stillWorking = await stopBtn.isVisible().catch(() => false);
                    if (stillWorking) {
                        const extra = Math.min(stopExt, Math.max(20000, timeoutMs - (Date.now() - startTime) - 5000));
                        if (extra > 20000) {
                            await stopBtn.waitFor({ state: 'hidden', timeout: extra }).catch(() => {});
                        }
                    }
                }
            }
            break; // handled the matching stop button — done with phase 1
        }
        // If no selector ever matched, that's fine (e.g. a fast response that never
        // showed a stop button) — fall through to phase 2 as before.
    }

    // Phase 2: find response element
    //
    // BUGFIX: same dead-fallback pattern as phase 1 — capture the resolved
    // boolean instead of discarding it, so unmatched selectors actually get
    // skipped instead of the loop always keeping the first one.
    const selTimeout = config.responseSelectorTimeout || 30_000;
    let responseEl = null;
    for (const sel of config.responseSelectors) {
        const loc = page.locator(sel).last();
        const attached = await loc
            .waitFor({ state: 'attached', timeout: Math.min(selTimeout, timeoutMs) })
            .then(() => true)
            .catch(() => false);
        if (attached) {
            responseEl = loc;
            break;
        }
    }

    if (!responseEl) return null;

    // Phase 3: stability polling
    const stillGeneratingCheck = config.stillGeneratingCheck || (async () => false);
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const deadline = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < stabilityWindow && Date.now() < deadline) {
        await page.waitForTimeout(pollInterval);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');

            // Check if generation is still in progress (e.g. bursty Pro Extended output)
            const stillGen = await stillGeneratingCheck(page).catch(() => false);

            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                tick('+');
            } else if (stillGen) {
                lastChangeTime = Date.now(); // reset clock — generation ongoing
                tick('⚙');
            } else {
                tick('.');
            }
        } catch { tick('?'); }
    }

    // Phase 4 (optional): completion anchor — definitive "done" signal
    //
    // BUGFIX: previously gave the *first* anchor selector the entire remaining
    // timeout budget and broke unconditionally afterwards (same swallowed-catch
    // pattern as phases 1-2), so locale variants after the first (e.g. Simplified
    // Chinese / English "Copy" button) were never actually tried — and an
    // unmatched first selector could silently burn the whole remaining budget.
    // Fix: split the remaining budget across candidates; only a real match breaks.
    const anchors = config.completionAnchor;
    if (anchors) {
        const anchorList = Array.isArray(anchors) ? anchors : [anchors];
        const remainingBudget = Math.max(10000, timeoutMs - (Date.now() - startTime));
        const perAnchorTimeout = Math.max(5000, Math.floor(remainingBudget / anchorList.length));
        for (const sel of anchorList) {
            const found = await page.locator(sel).last().waitFor({
                state: 'visible',
                timeout: perAnchorTimeout,
            }).then(() => true).catch(() => false);
            if (found) break; // first matching anchor wins
        }
    }

    return responseEl;
}

/**
 * Extract and validate response text from the response element.
 */
async function extractResponse(page, responseEl, config) {
    let text = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());

    if (!text || text.length < config.minResponseLength) return null;

    // Post-response hook (e.g. Claude thinking filter)
    if (config.postResponseHook) {
        text = await config.postResponseHook(page, text, config);
    }

    if (!text || text.length < config.minResponseLength) return null;

    return text;
}

// ══════════════════════════════════════════════════════════════════════════════
// OVERLAY CHECK — detect and handle modals/dialogs blocking the input area
// ══════════════════════════════════════════════════════════════════════════════

const OVERLAY_SEL = [
    '[role="dialog"]', '[role="alertdialog"]',
    '.modal', '[class*="modal"]', '[class*="dialog"]',
    '[class*="overlay"]', '[class*="popup"]',
];

const CLOSE_BTN_SEL = [
    '[aria-label*="close" i]', '[aria-label*="Close" i]',
    '[aria-label*="关闭"]', '[aria-label*="Dismiss" i]',
    'button:has-text("×")', 'button:has-text("Close")',
    'button:has-text("关闭")', 'button:has-text("Got it")',
    'button:has-text("Accept")', 'button:has-text("同意")',
    'button:has-text("知道了")', 'button:has-text("继续")',
    '[class*="close" i]', 'svg[class*="close" i]',
];

/**
 * Scan for visible overlays. If found:
 *   - quota/auth text → hard block (skip to next provider)
 *   - dismissable text → click close button, continue
 *   - unknown → try close, if still present → block
 *
 * Returns { block: string|null, detail: string }
 */
async function checkOverlays(page, C) {
    for (const sel of OVERLAY_SEL) {
        let el;
        try {
            el = page.locator(sel).first();
            if (!(await el.isVisible({ timeout: 800 }).catch(() => false))) continue;
        } catch (_) { continue; }

        const text = await el.evaluate(n => (n.innerText || n.textContent || '').trim()).catch(() => '');
        if (text.length < 5) continue;

        // Hard block: quota
        for (const pat of (C.quotaPatterns || [])) {
            if (pat.test(text)) return { block: 'quota', detail: text.slice(0, 120) };
        }
        // Hard block: login
        if (/(?:log\s*in|sign\s*in|登\s*录|请先登录|Continue with Google)/i.test(text)) {
            return { block: 'auth', detail: text.slice(0, 120) };
        }

        // Soft block: dismissable overlay
        const dismissable = (C.dismissPatterns || []).some(p => p.test(text));
        const dismissed = await tryDismissOverlay(page, el);
        if (!dismissed) {
            return { block: dismissable ? 'error' : 'error', detail: 'overlay stuck: ' + text.slice(0, 120) };
        }
        return { block: null }; // dismissed, continue
    }
    return { block: null };
}

async function tryDismissOverlay(page, el) {
    for (const sel of CLOSE_BTN_SEL) {
        try {
            const btn = el.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click();
                await page.waitForTimeout(800);
                // Check: overlay gone?
                if (!(await el.isVisible({ timeout: 500 }).catch(() => true))) return true;
            }
        } catch (_) { /* next selector */ }
    }
    return false;
}

// ══════════════════════════════════════════════════════════════════════════════
// FACTORY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Create a provider runner from a config object.
 *
 * The returned function has the same signature as the legacy tryXxx() functions:
 *   async (page, prompt, timeoutMs, ctx) → { success, response? }
 *
 * This makes it a drop-in replacement in tryAllProviders' switch block.
 *
 * @param {object} cfg — provider config (see CONFIG SCHEMA above)
 * @returns {(page: Page, prompt: string, timeoutMs: number, ctx: object) => Promise<{success: boolean, response?: string, reason?: string}>}
 */
function createProviderRunner(cfg) {
    // Merge defaults
    const C = { ...DEFAULTS, ...cfg };

    return async function run(page, prompt, timeoutMs, ctx) {
        const provStart = Date.now();

        // ── Step 1: Navigate ──
        try {
            await page.goto(C.url, {
                waitUntil: C.navWaitUntil,
                timeout: C.navTimeout,
            });
            // SPA render wait — some providers need extra time for React/Angular to mount
            if (C.navPostDelay > 0) {
                await page.waitForTimeout(C.navPostDelay);
            }
        } catch (e) {
            return classifyError(e, STAGES.NAVIGATE, C.key);
        }

        // ── Step 2: Auth check ──
        try {
            const url = page.url();
            const isAuth = C.authDomains.some(d => url.includes(d))
                        || url.includes('/auth')
                        || url.includes('/login');
            if (isAuth) {
                return classifyError(
                    new Error('Login required'), STAGES.AUTH_CHECK, C.key, 'auth'
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.AUTH_CHECK, C.key);
        }

        // ── Step 3: Quota check ──
        try {
            const bodyText = await page.evaluate(() => document.body?.innerText || '');
            for (const pattern of (C.quotaPatterns || [])) {
                if (pattern.test(bodyText)) {
                    return classifyError(
                        new Error(`Quota hit: ${pattern}`),
                        STAGES.QUOTA_CHECK, C.key, 'quota'
                    );
                }
            }
        } catch (e) {
            return classifyError(e, STAGES.QUOTA_CHECK, C.key);
        }

        // ── Step 3.5: Overlay check — dismiss modals or bail if blocked ──
        try {
            const ov = await checkOverlays(page, C);
            if (ov.block) {
                return classifyError(
                    new Error(ov.detail),
                    STAGES.OVERLAY_CHECK, C.key, ov.block
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.OVERLAY_CHECK, C.key);
        }

        // ── Step 4: Pre-input hook (e.g. Gemini Pro detection) ──
        if (C.preInputHook) {
            try {
                await C.preInputHook(page, C);
            } catch (e) {
                return classifyError(e, STAGES.PRE_EDITOR, C.key);
            }
        }

        // ── Step 5: Find editor ──
        const editor = await findEditableElement(page, C.editorSelectors, C.validateEditor);
        if (!editor) {
            return classifyError(
                new Error('No editable input found'),
                STAGES.EDITOR_FIND, C.key, 'error'
            );
        }

        // ── Step 6: Clear + input text ──
        try {
            await clearEditor(page, editor);
            const inputOk = await C.input(page, editor, prompt, { timeoutMs });
            if (!inputOk) {
                return classifyError(
                    new Error('Failed to input text'),
                    STAGES.EDITOR_FIND, C.key, 'error'
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.EDITOR_FIND, C.key);
        }

        // ── Step 7: Send ──
        try {
            if (C.customSend) {
                await C.customSend(page, editor);
            } else {
                await clickSend(page, editor, C.sendSelectors, C.sendFallback);
            }
        } catch (e) {
            return classifyError(e, STAGES.WAIT_RESPONSE, C.key);
        }

        // ── Step 8: Wait for response ──
        const respStart = Date.now();
        const responseEl = await waitForCompletion(page, C, respStart, timeoutMs);
        if (!responseEl) {
            return classifyError(
                new Error('No response element appeared'),
                STAGES.WAIT_RESPONSE, C.key, 'timeout'
            );
        }

        // ── Step 9: Extract + post-process ──
        // BUGFIX: previously not wrapped in try/catch, so a postResponseHook throw
        // (e.g. Gemini's ERR_SAFETY_REJECTED) bypassed classifyError entirely here
        // and only got caught by the generic outer catch in tryAllProviders, which
        // used to always collapse to reason='error' — losing the safety signal.
        let response;
        try {
            response = await extractResponse(page, responseEl, C);
        } catch (e) {
            return classifyError(e, STAGES.EXTRACT, C.key);
        }
        if (!response) {
            return classifyError(
                new Error('Response too short or empty'),
                STAGES.EXTRACT, C.key, 'error'
            );
        }

        // ── Step 10: Success ──
        if (ctx && ctx.telemetry) {
            ctx.telemetry.per_provider_ms[C.key] = Date.now() - provStart;
        }
        return { success: true, response };
    };
}

// ══════════════════════════════════════════════════════════════════════════════
// EXPORTS
// ══════════════════════════════════════════════════════════════════════════════

module.exports = {
    createProviderRunner,
    INSERT_TEXT_LIMIT,
    // Re-export from telemetry for backward compatibility
    appendWithRotation,
    // Shared atomic operations — also usable directly by providers that need
    // custom pipeline steps beyond what the factory supports.
    findEditableElement,
    inputViaClipboard,
    inputViaSimulatedPaste,
    inputViaKeyboard,
    clearEditor,
    clickSend,
    waitForCompletion,
    extractResponse,
};
