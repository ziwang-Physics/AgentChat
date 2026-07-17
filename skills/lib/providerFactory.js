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
// v10: stderr logger for factory-level diagnostics (stdout is a machine
// contract — see lib/receipt.js stream policy; terminal.log writes stderr).
const { log: _tlog } = require('./terminal');
const flog = (key, msg) => { try { _tlog(key || 'factory', msg); } catch (_) {} };

// HTML → Markdown converter for responseFormat: 'markdown'
const TurndownService = require('turndown');
const turndown = new TurndownService({
    headingStyle: 'atx',
    codeBlockStyle: 'fenced',
    emDelimiter: '*',
});

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
//   blockedUrlPatterns?: RegExp[], // post-nav URL regexes needing a human in the browser (CAPTCHA/consent/upsell) → 'auth'
//   signedOutSelectors?: string[], // selector visible ⇒ signed-out landing page ON the provider domain → 'auth'
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
//   stillGeneratingCheck?: (page, info?) => Promise<boolean>, // reset stability clock if true.
//       info = { text, sinceChangeMs, elapsedMs } — text is what the poller just
//       read from responseEl (so checks can classify it with ZERO extra CDP
//       round-trips and are automatically aligned with the polled element).
//   stillGeneratingMaxHoldMs?: number, // v11: cap on how long ⚙ resets may hold
//       the stability clock past the last REAL text change (default: 90000).
//       Bounds the cost of a false-positive check to seconds instead of the
//       whole provider budget. Long-thinking providers raise it (Gemini 300s,
//       Kimi 180s); it re-arms on every actual text change.
//   responseSelectorTimeout?: number, // ms per response selector wait (default: 30000)
//   customSend?: (page, editor) => Promise<boolean>, // override clickSend entirely
//   preInputHook?: (page, cfg) => Promise<void>,   // e.g. Gemini Pro detection
//   postResponseHook?: (page, rawText, cfg) => Promise<string>, // e.g. Qwen prefix strip
// }

// ══════════════════════════════════════════════════════════════════════════════
// SHARED PATTERNS — extracted from duplicated adapter configs (~60 lines saved)
// ══════════════════════════════════════════════════════════════════════════════

// Chinese-language quota patterns shared across 5+ providers (Qwen, Kimi,
// MiniMax, MiMo, DeepSeek, ChatGPT). Each adapter's quotaPatterns = its own
// provider-specific patterns + [...COMMON_CN_QUOTA_PATTERNS].
const COMMON_CN_QUOTA_PATTERNS = [
    /额度.*(?:已|用).*(?:完|尽|满)/i,
    /quota\s*(?:exceeded|limit)/i,
    /次数.*(?:已|用).*(?:完|尽)/i,
    /请.*(?:充值|升级|续费)/i,
];

// Dismissable overlay patterns shared across providers. New-feature popups,
// announcements, and welcome modals that are safe to close via CLOSE_BTN_SEL.
const COMMON_DISMISS_PATTERNS = [
    /新功能/i, /公告/i, /欢迎/i, /更新.*(?:说明|日志)/i,
    /what'?s\s*new/i, /new\s*feature/i, /welcome/i,
    /try\s*(?:the\s*)?new/i, /introducing/i,
];

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
    stillGeneratingMaxHoldMs: 90_000, // v11: ⚙ hold cap (see schema above)
    responseSelectorTimeout: 30_000,
    stabilityWindow: 10_000,
    pollInterval: 2_000,
    minResponseLength: 10,
    insertTextLimit: INSERT_TEXT_LIMIT,
    input: null, // set below after atomic ops are defined
    dismissPatterns: [], // overlays matching these are safe to dismiss (close button click)
    blockedUrlPatterns: [], // post-nav URLs classified as 'auth' (CAPTCHA/consent/interstitial)
    signedOutSelectors: [], // visible ⇒ signed-out landing page — fail fast as 'auth'
};

// ══════════════════════════════════════════════════════════════════════════════
// SHARED ATOMIC OPERATIONS
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Find an editable element matching one of the given selectors.
 * Returns the first visible, non-readonly contenteditable div or textarea.
 *
 * v10: no longer a silent single-shot. When every configured selector fails
 * (the Gemini-class "UI drift" failure, which used to hard-fail the provider
 * at EDITOR_FIND), a heuristic scan across document + open shadow roots looks
 * for the most chat-input-shaped editable on the page; the pick is still
 * gated by validateFn. On total failure, dumps input-element diagnostics to
 * stderr so the next selector fix takes one minute instead of a blind hunt.
 */
async function findEditableElement(page, selectors, validateFn, log) {
    const _log = log || (() => {});
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

    // v10: heuristic last resort — selector drift should degrade, not kill
    const rescued = await heuristicFindEditor(page, validateFn, _log).catch(() => null);
    if (rescued) return rescued;

    await dumpEditorDiagnostics(page, _log).catch(() => {});
    return null;
}

/**
 * v10: Heuristic editor discovery (shadow-DOM piercing).
 * Scores visible editables by chat-input shape: low on the page, wide,
 * prompt-ish placeholder/aria. Tags the winner with data-fs-editor="1"
 * (Playwright locators pierce open shadow roots, so the tag is reachable
 * even inside a web component). validateFn still gates the pick.
 */
async function heuristicFindEditor(page, validateFn, log = () => {}) {
    let meta = null;
    try {
        meta = await page.evaluate(({ marker }) => {
            const roots = [document];
            try {
                const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n;
                while ((n = w.nextNode())) if (n.shadowRoot) roots.push(n.shadowRoot);
            } catch (_) {}

            // Clear stale tags from earlier scans
            for (const r of roots) {
                try {
                    r.querySelectorAll(`[${marker}]`).forEach(el => el.removeAttribute(marker));
                } catch (_) {}
            }

            const PROMPTISH = /问|输入|消息|发送|聊|訊息|傳送|message|prompt|ask|chat|send|type/i;
            const vw = window.innerWidth || 1280;
            const vh = window.innerHeight || 800;
            const seen = new Set();
            const cands = [];
            for (const r of roots) {
                let list = [];
                try {
                    list = r.querySelectorAll(
                        'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]'
                    );
                } catch (_) { continue; }
                for (const el of list) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const rect = el.getBoundingClientRect();
                    if (rect.width < 50 || rect.height < 14) continue;
                    const style = getComputedStyle(el);
                    if (style.visibility === 'hidden' || style.display === 'none') continue;
                    if (el.hasAttribute('readonly') || el.hasAttribute('disabled')) continue;
                    if (el.getAttribute('contenteditable') === 'false') continue;

                    const hint = (el.getAttribute('placeholder') || '') + ' '
                               + (el.getAttribute('aria-label') || '');
                    let score = 0;
                    if (rect.top > vh * 0.4) score += 2;   // chat inputs live low
                    if (rect.width > vw * 0.35) score += 2; // main input is wide
                    if (PROMPTISH.test(hint)) score += 2;
                    if (el.tagName === 'TEXTAREA'
                        || el.getAttribute('contenteditable') === 'true') score += 1;

                    cands.push({ el, score, area: rect.width * rect.height, hint: hint.trim().slice(0, 60) });
                }
            }
            if (!cands.length) return null;
            cands.sort((a, b) => b.score - a.score || b.area - a.area);
            cands[0].el.setAttribute(marker, '1');
            return { score: cands[0].score, hint: cands[0].hint, total: cands.length };
        }, { marker: 'data-fs-editor' });
    } catch (_) { return null; }
    if (!meta) return null;

    const loc = page.locator('[data-fs-editor="1"]').first();
    const visible = await loc.isVisible({ timeout: 1000 }).catch(() => false);
    if (!visible) return null;
    if (validateFn) {
        const ok = await validateFn(loc).catch(() => false);
        if (!ok) return null;
    }
    log(`editor found via HEURISTIC scan (selector drift? score=${meta.score} hint="${meta.hint}" candidates=${meta.total}) — update editorSelectors when convenient`);
    return loc;
}

/**
 * v10: Dump visible input-ish elements to stderr when no editor was found —
 * the single source of truth for the next one-minute selector fix.
 */
async function dumpEditorDiagnostics(page, log = () => {}) {
    try {
        const info = await page.evaluate(() => {
            const roots = [document];
            try {
                const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n;
                while ((n = w.nextNode())) if (n.shadowRoot) roots.push(n.shadowRoot);
            } catch (_) {}
            const seen = new Set();
            const items = [];
            for (const r of roots) {
                let list = [];
                try {
                    list = r.querySelectorAll('textarea, input, [contenteditable], [role="textbox"]');
                } catch (_) { continue; }
                for (const el of list) {
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const rect = el.getBoundingClientRect();
                    items.push({
                        tag: el.tagName,
                        ce: el.getAttribute('contenteditable') || '',
                        placeholder: (el.getAttribute('placeholder') || '').slice(0, 60),
                        aria: (el.getAttribute('aria-label') || '').slice(0, 60),
                        classes: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
                        visible: rect.width > 0 && rect.height > 0,
                        top: Math.round(rect.top),
                        shadow: r !== document,
                    });
                    if (items.length >= 12) return items;
                }
            }
            return items;
        });
        log('DIAG: no editor selector matched — input-ish elements on page:');
        info.forEach((b, i) => {
            log(`  [${i}] <${b.tag}>${b.shadow ? ' [shadow]' : ''} vis=${b.visible} top=${b.top} ce="${b.ce}" ph="${b.placeholder}" aria="${b.aria}" class="${b.classes}"`);
        });
    } catch (e) {
        log(`DIAG: editor dump failed: ${e.message}`);
    }
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
        // PRIVACY FIX: only press Ctrl+V if OUR write to the clipboard succeeded.
        // Previously, a failed writeText (permission denied) was swallowed and
        // Ctrl+V pasted whatever the USER had on their clipboard into a
        // third-party AI page — and could even send it if it passed the 0.8
        // length check. On clipboard failure, fall back to non-clipboard paths.
        let clipOk = true;
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); }
        catch (_) { clipOk = false; }
        if (clipOk) {
            await page.keyboard.press('ControlOrMeta+v');
            await page.waitForTimeout(500);
            const len = await editor.evaluate(el => (el.innerText || el.textContent || '').length);
            if (len > prompt.length * 0.8) return true;
        }
        // Clipboard unavailable or paste didn't land → simulated ClipboardEvent,
        // then chunked keyboard as the last resort.
        if (await inputViaSimulatedPaste(page, editor, prompt)) return true;
        return inputViaKeyboard(page, editor, prompt);
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
 * v10: Verify-by-effect for SEND — the same principle that fixed the Gemini
 * model picker, applied to the one shared step with a SILENT failure mode:
 * a keyboard fallback that inserts a newline instead of submitting (Enter vs
 * Ctrl+Enter UIs) produced no error, then burned the whole WAIT_RESPONSE
 * budget and failed the provider as 'timeout'.
 *
 * Signals (any one ⇒ 'sent'): editor emptied to <20% of the prompt, or a
 * stop button appeared. 'unsent' is only returned when ≥80% of the prompt
 * DEMONSTRABLY still sits in the editor — the only state where a retry with
 * an alternate key cannot double-send. Anything ambiguous ⇒ 'unknown' (no-op).
 *
 * @returns {Promise<'sent'|'unsent'|'unknown'>}
 */
async function verifySendEffect(page, editor, prompt, C, budgetMs = 4000) {
    const readLen = () => editor.evaluate(el =>
        (el.value !== undefined && el.value !== null && el.tagName === 'TEXTAREA')
            ? el.value.length
            : (el.innerText || el.textContent || '').length
    );
    try {
        const start = Date.now();
        while (Date.now() - start < budgetMs) {
            const len = await readLen().catch(() => -1);
            if (len >= 0 && len < prompt.length * 0.2) return 'sent';

            for (const sel of (C.stopSelectors || [])) {
                const vis = await page.locator(sel).first()
                    .isVisible({ timeout: 200 }).catch(() => false);
                if (vis) return 'sent';
            }
            await page.waitForTimeout(400);
        }
        const finalLen = await readLen().catch(() => -1);
        if (finalLen >= prompt.length * 0.8) return 'unsent';
        return 'unknown';
    } catch (_) { return 'unknown'; }
}

/**
 * v10: When no responseSelector ever attaches, dump the largest visible text
 * blocks (shadow-piercing, ancestor-deduped) — mirrors the Gemini DIAG dump.
 * Any future response-selector drift becomes a one-minute fix instead of a
 * blind 'timeout'.
 */
async function dumpResponseDiagnostics(page, log = () => {}) {
    try {
        const info = await page.evaluate(() => {
            const roots = [document];
            try {
                const w = document.createTreeWalker(document.documentElement, NodeFilter.SHOW_ELEMENT);
                let n;
                while ((n = w.nextNode())) if (n.shadowRoot) roots.push(n.shadowRoot);
            } catch (_) {}

            const seen = new Set();
            const blocks = [];
            let scanned = 0;
            for (const r of roots) {
                let list = [];
                try { list = r.querySelectorAll('[class], article, section, main'); }
                catch (_) { continue; }
                for (const el of list) {
                    if (++scanned > 6000) break;
                    if (seen.has(el)) continue;
                    seen.add(el);
                    const t = (el.innerText || '').trim();
                    if (t.length < 120) continue;
                    const rect = el.getBoundingClientRect();
                    if (rect.width === 0 || rect.height === 0) continue;
                    blocks.push({ el, len: t.length, preview: t.slice(0, 80).replace(/\s+/g, ' ') });
                }
                if (scanned > 6000) break;
            }

            // Prefer leaf-most blocks: ascending by length, an ancestor is
            // dropped when a kept descendant carries ≥90% of its text.
            blocks.sort((a, b) => a.len - b.len);
            const kept = [];
            for (const b of blocks) {
                if (kept.some(k => b.el.contains(k.el) && k.len >= b.len * 0.9)) continue;
                kept.push(b);
            }
            kept.sort((a, b) => b.len - a.len);
            return kept.slice(0, 10).map(({ el, len, preview }) => ({
                tag: el.tagName,
                id: el.id || '',
                classes: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
                len,
                preview,
            }));
        });
        log('DIAG: no responseSelector matched — largest visible text blocks:');
        info.forEach((b, i) => {
            log(`  [${i}] <${b.tag}> id="${b.id}" len=${b.len} class="${b.classes}" text="${b.preview}"`);
        });
    } catch (e) {
        log(`DIAG: response dump failed: ${e.message}`);
    }
}

/**
 * Wait for AI to finish generating.
 *
 * Strategy: stop button detection → response element → stability polling.
 * Calls config.onProgress(status) if provided:
 *   '+' = text grew, '~' = text changed without growing (shrink / in-place
 *   mutation — e.g. a collapsing tool/thinking card), '.' = stable,
 *   '?' = DOM error, '⚙' = still generating
 *
 * v2 (2026-07-03): Added stopBtnExtensionMs, completionAnchor, stillGeneratingCheck
 * for Pro Extended Thinking support (Gemini bursty output, 3-5 min generation).
 * v11 (2026-07): Phase-3 rework for agentic tool phases (Kimi 联网搜索 truncation):
 *   - CHANGE detection, not GROWTH detection. The old `text.length > lastLen`
 *     never reset the clock when innerText SHRANK — exactly what happens when
 *     a search/thinking card collapses and the real answer starts streaming:
 *     until the answer grows back past the card's peak length, every poll
 *     looked "stable" and the window could expire MID-ANSWER. Fingerprint
 *     (length + 80-char tail) now catches shrink and same-length mutation.
 *   - stillGeneratingCheck now receives (page, { text, sinceChangeMs,
 *     elapsedMs }) and is only consulted when the text did NOT change
 *     (its verdict was ignored on growth anyway — saves one CDP round-trip
 *     per growing poll).
 *   - ⚙ resets are capped by stillGeneratingMaxHoldMs since the last REAL
 *     text change, so a false-positive check degrades to a bounded delay
 *     instead of burning the whole provider budget.
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
                // Qwen: stop button is removed from DOM when done, not just hidden.
                const cap = Math.min(timeoutMs, 300000);
                const elapsed = Date.now() - startTime;
                const remaining = cap - elapsed;
                // P1-7: clamp to actual remaining budget — Math.max(30000, ...)
                // could force an extra 30s wait even when budget is already
                // exhausted, causing single-provider overrun that chains into
                // totalTimeout overflow. Budget exhausted → return immediately.
                if (remaining < 5000) break; // not enough time to wait meaningfully
                await stopBtn.waitFor({ state: 'detached', timeout: Math.max(5000, remaining) }).catch(() => {});
            } else {
                const elapsed = Date.now() - startTime;
                const remaining = timeoutMs - elapsed;
                if (remaining < 5000) break;
                await stopBtn.waitFor({ state: 'hidden', timeout: Math.max(5000, remaining) }).catch(() => {});

                // Extension for long-generation models (e.g. Pro Extended Thinking)
                if (stopExt > 0) {
                    const stillWorking = await stopBtn.isVisible().catch(() => false);
                    if (stillWorking) {
                        const elapsed2 = Date.now() - startTime;
                        const remaining2 = timeoutMs - elapsed2;
                        // P1-7: clamp extension to remaining budget; don't force
                        // a 20s floor when budget is already gone.
                        const extra = Math.min(stopExt, Math.max(0, remaining2 - 5000));
                        if (extra > 0) {
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
    //
    // BUDGET FIX: each selector previously waited min(selTimeout, timeoutMs)
    // with NO elapsed-time deduction — after phase 1 legitimately consumed the
    // budget, an adapter with 5 responseSelectors (e.g. Claude) could still
    // burn 5 × 30s past the deadline. Per-selector wait is now clamped to the
    // REMAINING budget, floored at 1s so an already-attached element is still
    // found instantly even when the budget is spent.
    //
    // STALE-RESPONSE GUARD: on a REUSED tab whose SPA restored a previous
    // conversation, `.last()` initially resolves to the LAST message of the OLD
    // chat. If the send silently failed (or the new message is slow to mount),
    // stability polling would see that old, stable text and return a previous
    // answer for the new prompt — the silent-wrong-answer class. When the
    // pre-send baseline count for a selector was > 0, we first wait briefly for
    // element #baseline (the first NEW node) to attach; only if that gate fails
    // (some UIs replace in place rather than append) do we fall back to the old
    // `.last()` behavior. baseline === 0 (fresh page, the common case) is a
    // zero-cost no-op.
    const selTimeout = config.responseSelectorTimeout || 30_000;
    const baseline = config.baselineCounts || null;
    let responseEl = null;
    for (const sel of config.responseSelectors) {
        const remaining = timeoutMs - (Date.now() - startTime);
        const perWait = Math.min(selTimeout, Math.max(1000, remaining));

        if (baseline && Number.isInteger(baseline[sel]) && baseline[sel] > 0) {
            const freshGate = await page.locator(sel).nth(baseline[sel])
                .waitFor({ state: 'attached', timeout: Math.min(perWait, 15_000) })
                .then(() => true)
                .catch(() => false);
            if (freshGate) {
                responseEl = page.locator(sel).last(); // live locator tracks newest
                break;
            }
            // gate failed — fall through to the legacy .last() probe below
        }

        const loc = page.locator(sel).last();
        const attached = await loc
            .waitFor({ state: 'attached', timeout: perWait })
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
    // v11: ⚙ hold cap — see docstring. Re-arms on every REAL text change.
    const stillGenMaxHold = Number.isFinite(config.stillGeneratingMaxHoldMs)
        ? config.stillGeneratingMaxHoldMs
        : 90_000;
    let lastLen = 0;
    // v11 fingerprint: length + tail. Catches shrink (collapsing tool cards)
    // and same-length in-place mutation, which pure length-growth missed.
    // Initialized to the empty-text fingerprint so an empty responseEl on
    // poll 1 does NOT count as a change (exact parity with the old code).
    let lastFp = '0\u0000';
    let lastChangeTime = Date.now();
    let lastRealChangeTime = Date.now(); // only ACTUAL text changes re-arm the ⚙ cap
    const deadline = startTime + timeoutMs;

    // ROBUSTNESS: distinguish a transient read miss (element re-rendered mid-poll)
    // from a fatal page loss (tab crashed, navigated away, browser context gone).
    // The old blanket `catch { tick('?') }` treated BOTH as transient and kept
    // polling a dead page until the FULL timeoutMs elapsed — turning a 2s crash
    // into a 180s hang and burning the whole provider budget on nothing. We now
    // count consecutive errors and, if the page itself is closed/crashed, break
    // immediately and return whatever text we captured before the failure.
    let consecutiveErrors = 0;
    const MAX_CONSECUTIVE_ERRORS = 5;
    while ((Date.now() - lastChangeTime) < stabilityWindow && Date.now() < deadline) {
        await page.waitForTimeout(pollInterval);
        // Fast path out: page/context gone → no point polling further.
        if (page.isClosed()) { tick('?'); break; }
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            consecutiveErrors = 0;

            const now = Date.now();
            const fp = text.length + '\u0000' + text.slice(-80);

            if (fp !== lastFp) {
                // ANY change — growth, shrink (collapsing search/thinking
                // card), or same-length mutation — means generation is live.
                const grew = text.length > lastLen;
                lastLen = text.length;
                lastFp = fp;
                lastChangeTime = now;
                lastRealChangeTime = now;
                tick(grew ? '+' : '~');
            } else {
                // Text static — ask the adapter whether the UI still says
                // "working" (tool phase, bursty thinking). Only consulted
                // here: its verdict was ignored on change anyway, so this
                // also saves one CDP round-trip per changing poll.
                const stillGen = await stillGeneratingCheck(page, {
                    text,
                    sinceChangeMs: now - lastRealChangeTime,
                    elapsedMs: now - startTime,
                }).catch(() => false);

                if (stillGen && (now - lastRealChangeTime) < stillGenMaxHold) {
                    lastChangeTime = now; // reset clock — generation ongoing
                    tick('⚙');
                } else {
                    tick('.');
                }
            }
        } catch (e) {
            tick('?');
            // A crashed/navigated page throws "Target closed" / "Execution context
            // was destroyed" on every subsequent evaluate — retrying can't recover.
            const msg = String(e && e.message || e);
            if (/Target.*closed|context was destroyed|has been closed|crashed/i.test(msg)) {
                break;
            }
            // Otherwise treat as transient, but cap the run of failures so a
            // permanently-detached responseEl can't spin to the deadline either.
            if (++consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) break;
        }
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
        // BUDGET FIX (P1-7 follow-up): the old Math.max(10000,·) forced a 10s
        // wait even with the budget exhausted, and the 5s per-anchor floor broke
        // the "split the remaining budget" invariant — 4 anchors × max(5s, r/4)
        // can spend 20s when only 10s remain (Gemini has 4 locale variants).
        // Now: a small 2s grace so a visible anchor is still caught instantly,
        // a hard cumulative deadline, and a 1s per-anchor floor within it.
        const remainingBudget = Math.max(2000, timeoutMs - (Date.now() - startTime));
        const anchorDeadline = Date.now() + remainingBudget;
        const perAnchorTimeout = Math.max(1000, Math.floor(remainingBudget / anchorList.length));
        for (const sel of anchorList) {
            const left = anchorDeadline - Date.now();
            if (left <= 0) break; // cumulative budget spent — stop probing
            const found = await page.locator(sel).last().waitFor({
                state: 'visible',
                timeout: Math.min(perAnchorTimeout, left),
            }).then(() => true).catch(() => false);
            if (found) break; // first matching anchor wins
        }
    }

    return responseEl;
}

/**
 * Extract and validate response text from the response element.
 *
 * v11 ECHO GUARD: adapters whose responseSelectors end in generic tails
 * ([class*="message"], [class*="message-content"], …) can have `.last()`
 * resolve to the USER's own bubble when the assistant node mounts slowly —
 * the poller then sees perfectly stable text and returns the PROMPT as the
 * "response" (silent-wrong-answer class). When the extracted text is
 * essentially the prompt itself, fail the EXTRACT stage instead.
 */
async function extractResponse(page, responseEl, config, prompt) {
    let text;

    if (config.responseFormat === 'markdown') {
        // Extract innerHTML and convert to Markdown.
        // innerText loses all formatting (bold, code, lists, tables, links).
        // innerHTML preserves the rendered structure, and turndown converts
        // it back to well-formed Markdown.
        const html = await responseEl.evaluate(el => el.innerHTML);
        if (!html || html.trim().length < config.minResponseLength) return null;
        text = turndown.turndown(html).trim();
    } else {
        text = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    }

    if (!text || text.length < config.minResponseLength) return null;

    if (prompt && typeof prompt === 'string') {
        const norm = s => s.replace(/\s+/g, ' ').trim();
        const np = norm(prompt);
        const nt = norm(text);
        // Only guard non-trivial prompts, and only reject NEAR-IDENTICAL
        // text (a user bubble carries the prompt plus at most a few UI
        // labels). "Repeat after me: X" style answers, where the response
        // is a small SUBSTRING of the prompt, must stay valid.
        if (np.length >= 20) {
            const ratio = nt.length / np.length;
            const nearLen = ratio >= 0.9 && ratio <= 1.15;
            if (nt === np || (nearLen && (nt.includes(np) || np.includes(nt)))) {
                return null; // echoed prompt → EXTRACT error upstream
            }
        }
    }

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
    // PERF: probe all overlay selectors CONCURRENTLY. The serial loop paid the
    // full 800ms isVisible timeout per ABSENT selector — 7 selectors ≈ 5.6s of
    // dead time on every provider visit (the no-overlay case is the common
    // one). CDP multiplexes fine; the whole scan now costs ~0.8s.
    let visFlags;
    try {
        visFlags = await Promise.all(OVERLAY_SEL.map(sel =>
            page.locator(sel).first().isVisible({ timeout: 800 }).catch(() => false)
        ));
    } catch (_) {
        visFlags = OVERLAY_SEL.map(() => false);
    }

    let anyDismissed = false;
    for (let s = 0; s < OVERLAY_SEL.length; s++) {
        if (!visFlags[s]) continue;
        const sel = OVERLAY_SEL[s];
        let el;
        try {
            el = page.locator(sel).first();
        } catch (_) { continue; }

        // STALE-SNAPSHOT GUARD: visFlags was captured BEFORE any dismissal.
        // The same modal typically matches several selectors ([role="dialog"]
        // AND [class*="dialog"]). After the first selector dismissed it, later
        // selectors still carried visFlags=true; the now-HIDDEN element's
        // textContent still matched (innerText is '' when hidden, so the ||
        // falls through to textContent), but its close button was invisible —
        // tryDismissOverlay failed and a SUCCESSFULLY dismissed popup came
        // back as {block:'error'}, failing the provider. Once anything was
        // dismissed, re-probe visibility live before processing.
        if (anyDismissed) {
            const stillVisible = await el.isVisible({ timeout: 300 }).catch(() => false);
            if (!stillVisible) continue;
        }

        const text = await el.evaluate(n => (n.innerText || n.textContent || '').trim()).catch(() => '');
        if (text.length < 5) continue;

        // Skip: known non-blocking page furniture (footer disclaimers, permanent
        // info bars) that happen to sit inside an overlay-like container.
        const skipPatterns = C.skipOverlayPatterns || [];
        if (skipPatterns.some(p => p.test(text))) continue;

        // Hard block: quota
        for (const pat of (C.quotaPatterns || [])) {
            if (pat.test(text)) return { block: 'quota', detail: text.slice(0, 120) };
        }
        // Hard block: login
        // v11: '登录' needs a negative lookbehind — settings dialogs contain
        // 退出登录 (logout) and marketing copy contains 免登录/已登录, all of
        // which hard-blocked a perfectly signed-in provider as 'auth'.
        // \b around log in / sign in similarly stops "Blogindex"-style hits.
        if (/(?:\blog\s*in\b|\bsign\s*in\b|(?<!退出|已|免)登\s*录|请先登录|Continue with Google)/i.test(text)) {
            return { block: 'auth', detail: text.slice(0, 120) };
        }

        // Soft block: try to dismiss. Known-dismissable overlays (matched against
        // C.dismissPatterns) are expected to close cleanly via CLOSE_BTN_SEL;
        // unrecognized overlays are still attempted best-effort (matches the
        // "unknown → try close, if still present → block" policy above), but are
        // now labeled distinctly so failures are easier to diagnose from logs.
        // BUGFIX: previously `dismissable ? 'error' : 'error'` — both branches
        // returned the same value, so `dismissable` was computed and discarded.
        const dismissable = (C.dismissPatterns || []).some(p => p.test(text));
        const dismissed = await tryDismissOverlay(page, el);
        if (!dismissed) {
            const kind = dismissable ? 'known overlay' : 'unrecognized overlay';
            return { block: 'error', detail: `${kind} stuck: ${text.slice(0, 120)}` };
        }
        // Dismissed — keep scanning the REMAINING selectors instead of returning:
        // a welcome popup can sit on top of a quota modal, and the early return
        // let the quota state slip through to a doomed input attempt.
        anyDismissed = true;
        continue;
    }
    return { block: null };
}

async function tryDismissOverlay(page, el) {
    // Phase 1: search within overlay element
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
    // Phase 2: fallback — page-wide search (MiMo-style overlays may position
    // the dismiss button outside the overlay container's DOM hierarchy)
    for (const sel of CLOSE_BTN_SEL) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 500 }).catch(() => false)) {
                await btn.click();
                await page.waitForTimeout(800);
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
            // Signed-out failure surfaces THREE ways, all needing the same
            // operator action (re-auth in the shared browser):
            //   1. redirect to a login domain           → authDomains
            //   2. redirect to CAPTCHA/consent/upsell   → blockedUrlPatterns
            //   3. signed-out landing page served ON the provider domain
            //      (Gemini does this — URL looks fine)  → signedOutSelectors
            // Cases 2–3 previously fell through to model-activation / editor /
            // send failures → reason 'error' → exit 9 (all_exhausted): the
            // caller burned the full per-call budget and never learned the
            // real fix. Classify all three as 'auth' within seconds of nav.
            const isAuth = C.authDomains.some(d => url.includes(d))
                        || url.includes('/auth')
                        || url.includes('/login')
                        || (C.blockedUrlPatterns || []).some(re => re.test(url));
            if (isAuth) {
                return classifyError(
                    new Error(`Login required (landed on ${url.slice(0, 100)})`),
                    STAGES.AUTH_CHECK, C.key, 'auth'
                );
            }
            for (const sel of (C.signedOutSelectors || [])) {
                if (await page.locator(sel).first()
                        .isVisible({ timeout: 500 }).catch(() => false)) {
                    return classifyError(
                        new Error(`Signed-out UI present: ${sel}`),
                        STAGES.AUTH_CHECK, C.key, 'auth'
                    );
                }
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
        // v10: findEditableElement now self-heals (heuristic rescue) and dumps
        // diagnostics on total failure — pass the provider-tagged logger.
        const editor = await findEditableElement(
            page, C.editorSelectors, C.validateEditor, (m) => flog(C.key, m)
        );
        if (!editor) {
            return classifyError(
                new Error('No editable input found'),
                STAGES.EDITOR_FIND, C.key, 'error'
            );
        }

        // ── Step 6: Clear + input text ──
        // Stage label fixed: input failures were previously mislabeled EDITOR_FIND,
        // skewing telemetry-based failure analysis.
        try {
            await clearEditor(page, editor);
            const inputOk = await C.input(page, editor, prompt, { timeoutMs });
            if (!inputOk) {
                return classifyError(
                    new Error('Failed to input text'),
                    STAGES.INPUT, C.key, 'error'
                );
            }
        } catch (e) {
            return classifyError(e, STAGES.INPUT, C.key);
        }

        // ── Step 6.5: baseline response-element counts (stale-response guard) ──
        // On a reused tab with restored history, phase 2's `.last()` can attach
        // to the PREVIOUS conversation's final message. Counting matches per
        // responseSelector BEFORE sending lets waitForCompletion prefer the
        // first element that appears BEYOND this count. Fresh pages count 0 →
        // the guard is inert there. Best-effort: failures just disable the guard.
        const baselineCounts = {};
        for (const sel of C.responseSelectors) {
            try { baselineCounts[sel] = await page.locator(sel).count(); }
            catch (_) { /* guard disabled for this selector */ }
        }

        // ── Step 7: Send ── (stage label fixed: was mislabeled WAIT_RESPONSE)
        try {
            if (C.customSend) {
                await C.customSend(page, editor);
            } else {
                await clickSend(page, editor, C.sendSelectors, C.sendFallback);
            }
        } catch (e) {
            return classifyError(e, STAGES.SEND, C.key);
        }

        // ── Step 7.5: v10 send-effect verification ──
        // A send that silently did nothing (Enter inserted a newline; a stale
        // button ate the click) previously surfaced only as a WAIT_RESPONSE
        // 'timeout' after the full budget. Retry with the alternate key ONLY
        // when ≥80% of the prompt is demonstrably still in the editor — the
        // one state where a retry cannot double-send. Best-effort throughout.
        try {
            const eff = await verifySendEffect(page, editor, prompt, C);
            if (eff === 'unsent') {
                const alt = (C.sendFallback === 'Enter') ? 'ControlOrMeta+Enter' : 'Enter';
                flog(C.key, `send not confirmed — prompt still in editor; retrying with ${alt}`);
                await editor.focus().catch(() => {});
                await page.keyboard.press(alt);
                await page.waitForTimeout(1500);
            }
        } catch (_) { /* verification is best-effort */ }

        // ── Step 8: Wait for response ──
        // BUGFIX: pass provStart (full provider budget start) instead of respStart
        // (post-input reset). waitForCompletion's phase-1 comment already assumes
        // startTime covers pre-send elapsed time; the old code gave waiting a fresh
        // clock, letting one provider consume up to ~2× its budget.
        // Shallow per-run copy: C is shared across invocations of this runner,
        // so per-run state (baselineCounts) must never be written onto it.
        const responseEl = await waitForCompletion(page, { ...C, baselineCounts }, provStart, timeoutMs);
        if (!responseEl) {
            // v10: dump the largest visible text blocks BEFORE classifying —
            // a response-selector drift is now diagnosable from one log.
            await dumpResponseDiagnostics(page, (m) => flog(C.key, m)).catch(() => {});
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
            response = await extractResponse(page, responseEl, C, prompt);
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
    // v10 hardening helpers (exported for tests / custom pipelines)
    heuristicFindEditor,
    verifySendEffect,
    dumpEditorDiagnostics,
    dumpResponseDiagnostics,
    inputViaClipboard,
    inputViaSimulatedPaste,
    inputViaKeyboard,
    clearEditor,
    clickSend,
    waitForCompletion,
    extractResponse,
    // Shared patterns — avoid duplicating common CN quota/dismiss regexes
    COMMON_CN_QUOTA_PATTERNS,
    COMMON_DISMISS_PATTERNS,
};
