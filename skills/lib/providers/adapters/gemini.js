/**
 * Gemini provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - Pro Extended Thinking activation (preInputHook)
 *   - Bursty output detection (stillGeneratingCheck) — resets stability clock
 *     when Pro Extended pauses mid-reasoning for 6s+
 *   - Action Toolbar completion anchor — Copy/Good-response buttons = definitive "done"
 *   - Stop button 120s extension for long-thinking prompts (3-5 min)
 *   - Angular-specific: fill() for clearing, dispatchEvent('input') after typing
 *   - Pre-generation filter: "Thinking...", search queries not counted as real text
 *   - Declarative auth hardening: blockedUrlPatterns (must stay on
 *     gemini.google.com — CAPTCHA/consent/upsell → 'auth') + signedOutSelectors
 *     (signed-out landing page served ON gemini.google.com → 'auth')
 *   - Safety rejection + short-response validation in postResponseHook
 *
 * Dependencies: lib/geminiModelSwitch.js (ensureProExtended), lib/providerFactory.js (input helpers)
 */

const { ensureProExtended, ensureFlash } = require('../../geminiModelSwitch');
const { log: _tlog } = require('../../terminal');

// Default logger — the factory calls preInputHook(page, C) with no third arg,
// so the old `logFn || (() => {})` default silently swallowed every model
// activation log line, making Pro/Flash switching impossible to debug.
const glog = (msg) => _tlog('gemini', msg);

// ── Helpers (replicated from WebExtended for self-contained adapter) ──

const STILL_WORKING_TEXT = [
    /^搜索网页\s*$/im,
    /^\d+\s*个结果\s*$/im,
    /^Searching\w*\s*$/im,
    /^(?:Thought|Thinking|Analyzing|Reasoning)\s*(?:for\s*\d+s?)?\.{0,3}\s*$/im,
    /^(?:思考中|分析中|搜索中|正在搜索)\.{0,3}\s*$/im,
    /^Running\s+\w+\s*\.{0,3}\s*$/im,
    /^実行中\s*$/im,
];

const STILL_WORKING_UI = [
    'button[aria-label*="Stop"]',
    'button[aria-label*="停止"]',
    '[data-testid="stop-button"]',
    '[class*="stop-generat"]',
    '[class*="pause-generat"]',
];

/** Check if the page UI indicates generation is still in progress */
async function isStillGenerating(page) {
    for (const sel of STILL_WORKING_UI) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 300 }).catch(() => false)) return true;
        } catch (_) {}
    }
    return false;
}

/** Check if text looks like pre-generation filler (search queries, thinking, etc.) */
// P1-10: consecutive unchanged rounds counter — prevents infinite stability-clock
// resets for short, valid answers (e.g. "42", single-word responses) that lack
// punctuation. Without this guard, `stillGeneratingCheck` keeps returning true,
// resetting the stability clock every cycle until the full Gemini budget burns out.
let _preGenStreak = 0;
const MAX_PREGEN_STREAK = 8; // ~16s at default 2s poll interval

function looksLikePreGeneration(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length === 0) { _preGenStreak++; return _preGenStreak <= MAX_PREGEN_STREAK; }
    if (trimmed.length > 300) { _preGenStreak = 0; return false; }
    for (const pat of STILL_WORKING_TEXT) {
        if (pat.test(trimmed)) { _preGenStreak++; return _preGenStreak <= MAX_PREGEN_STREAK; }
    }
    if (trimmed.length < 150 && !/[。！？\.!\?;；，\n]{1}/.test(trimmed)) {
        _preGenStreak++;
        return _preGenStreak <= MAX_PREGEN_STREAK; // eventually accept as final
    }
    _preGenStreak = 0;
    return false;
}

function validateResponseComplete(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 10) return { ok: false, reason: 'too_short' };
    if (/^搜索网页\s*\n[\s\S]{0,200}\d+\s*个结果\s*$/.test(trimmed)) return { ok: false, reason: 'search_only' };
    if (/^Searching\w*\s*\n[\s\S]{0,200}\d+\s*results?\s*$/i.test(trimmed)) return { ok: false, reason: 'search_only' };
    if (/^(?:Thought|Thinking|思考中|分析中)\s*for\s*\d+s?\s*$/im.test(trimmed) && trimmed.length < 60) {
        return { ok: false, reason: 'thinking_only' };
    }
    return { ok: true };
}

// ── Config ──────────────────────────────────────────────────────────────────

const INSERT_TEXT_LIMIT = 500;

module.exports = {
    key: 'gemini',
    url: 'https://gemini.google.com/u/0/app',
    authDomains: ['accounts.google.com'],

    // Post-nav URL allow-list — replaces the imperative ERR_WRONG_PAGE check
    // that lived in preInputHook (where it classified as generic 'error' →
    // exit 9 / all_exhausted). Anything NOT on gemini.google.com after nav
    // (google.com/sorry CAPTCHA, consent.google.com, one.google upsell) needs
    // a human in the browser — same operator action as auth.
    blockedUrlPatterns: [/^https?:\/\/(?!gemini\.google\.com\/)/i],

    // Gemini serves a signed-out landing page ON gemini.google.com with NO
    // login redirect — the editor may even render, so the old pipeline burned
    // the entire per-call budget (model activation retries + send + response
    // wait) before dying as 'error'. Href-anchored selectors only: a bare
    // a[href*="accounts.google.com"] would false-positive on the signed-in
    // avatar's SignOutOptions link.
    signedOutSelectors: [
        'a[href*="accounts.google.com/ServiceLogin"]',
        'a[href*="accounts.google.com/signin"]',
        'a[href*="accounts.google.com/AccountChooser"]',
    ],

    // Gemini previously had NO quotaPatterns — free-tier exhaustion could never
    // be classified as reason='quota' (breaking exit code 5 aggregation).
    // Patterns are deliberately narrow: the Gemini page shows permanent
    // "Upgrade"/"Advanced" upsell banners, so anything matching bare
    // /upgrade/ would false-positive on every visit.
    quotaPatterns: [
        /reached your (?:daily )?limit/i,
        /limit\s+(?:resets|refreshes)/i,
        /you'?ve\s+hit\s+your\s+.*limit/i,
        /已达到.*(?:上限|限额|限制)/i,
        /已達到.*(?:上限|限額|限制)/i,
    ],

    // ── Pre-input: tiered model activation (Pro Extended → Flash → fail) ──
    preInputHook: async (page, cfg, logFn) => {
        const log = logFn || glog;
        // Per-run reset: _preGenStreak is module-level state. In a long-lived
        // process that runs this adapter more than once (tests, future daemon
        // mode), a streak left at MAX from the previous run would make
        // looksLikePreGeneration() reject fresh filler on the very first poll.
        _preGenStreak = 0;
        // (URL validation moved to the factory's Step-2 auth check via
        //  blockedUrlPatterns — a wrong page is now 'auth', not 'error'.)

        // Tier 1: Try Pro Extended Thinking (requires Gemini Pro subscription)
        let ok = await ensureProExtended(page, 1, log);
        if (ok) {
            log('gemini: Pro Extended Thinking active (Pro subscription)');
            return;
        }

        // Tier 2: Pro Extended failed — fall back to Flash model (free tier)
        log('gemini: Pro Extended unavailable, falling back to Flash (free tier)...');
        ok = await ensureFlash(page, log);
        if (ok) {
            log('gemini: Flash model active (free tier fallback)');
            return;
        }

        // Tier 3: Flash also failed — let provider chain fall to ChatGPT
        throw Object.assign(
            new Error('Gemini model activation failed — Pro Extended and Flash both unavailable'),
            { code: 'ERR_MODEL_DEGRADED' }
        );
    },

    // ── Editor ──
    editorSelectors: [
        '.ql-editor',
        '[contenteditable="true"][role="textbox"]',
        'rich-textarea',
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el =>
            el.getAttribute('contenteditable') !== 'false'
            && !el.hasAttribute('readonly')
        );
    },

    // ── Send ──
    sendSelectors: [
        'button[aria-label*="傳送"]',
        'button[aria-label*="发送"]',
        'button[aria-label*="Send"]',
    ],
    sendFallback: 'ControlOrMeta+Enter',

    // ── Stop button (Pro Extended 3-5 min generation) ──
    stopSelectors: [
        'button[aria-label*="停止"]',
        'button[aria-label*="Stop"]',
    ],
    stopBtnExtensionMs: 120_000, // Pro Extended extra budget

    // ── Response ──
    responseSelectors: ['.model-response-text'],
    responseSelectorTimeout: 60_000,
    stabilityWindow: 10_000,
    minResponseLength: 10,

    // ── Completion anchor: Action Toolbar = definitive "done" ──
    completionAnchor: [
        'button[aria-label*="複製"]',
        'button[aria-label*="Copy"]',
        'button[aria-label*="Good response"]',
        'button[aria-label*="好答案"]',
    ],

    // ── Bursty generation detection ──
    stillGeneratingCheck: async (page) => {
        const generating = await isStillGenerating(page);
        if (generating) return true;
        // Also check if current text is just pre-generation filler
        const text = await page.locator('.model-response-text').last()
            .evaluate(el => el.innerText || el.textContent || '').catch(() => '');
        return looksLikePreGeneration(text);
    },

    // ── Input: Angular-specific (fill() for clear, dispatchEvent for CD) ──
    input: async (page, editor, prompt) => {
        // Clear — try fill() first for Angular/Quill compatibility
        try { await editor.fill(''); } catch {
            await page.keyboard.press('ControlOrMeta+a');
            await page.keyboard.press('Backspace');
        }
        await page.waitForTimeout(100);

        // Input text
        if (prompt.length > INSERT_TEXT_LIMIT) {
            // Only Ctrl+V if OUR clipboard write succeeded — otherwise we'd paste
            // the user's private clipboard contents into the Gemini page.
            let clipOk = true;
            let landed = false;
            try {
                await page.evaluate(t => navigator.clipboard.writeText(t), prompt);
            } catch (_) { clipOk = false; /* clipboard may fail in headless */ }
            if (clipOk) {
                await page.keyboard.press('ControlOrMeta+v');
                await page.waitForTimeout(500);
                // BUGFIX: verify the paste actually landed. Previously a paste
                // that Quill swallowed (permission granted but paste event eaten)
                // fell straight to the final length check and FAILED the whole
                // provider at the INPUT stage — although the chunked-keyboard
                // path below would have succeeded. Recoverable ≠ fatal.
                landed = await editor.evaluate(el =>
                    (el.innerText || el.textContent || '').length
                ).catch(() => 0) > prompt.length * 0.8;
            }
            if (!landed) {
                if (clipOk) {
                    // A PARTIAL paste may sit in the editor — clear it first or
                    // the fallback below would append and duplicate content.
                    try { await editor.fill(''); } catch {
                        await page.keyboard.press('ControlOrMeta+a');
                        await page.keyboard.press('Backspace');
                    }
                    await page.waitForTimeout(100);
                }
                // Fallback: chunked insertText (O(n) but reliable, no clipboard)
                for (let i = 0; i < prompt.length; i += 150) {
                    await page.keyboard.insertText(prompt.substring(i, i + 150));
                    await page.waitForTimeout(40);
                }
            }
        } else {
            await page.keyboard.insertText(prompt);
        }

        // Trigger Angular zone.js change detection
        await editor.evaluate(node => {
            node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
        });

        // Verify payload arrived
        const len = await editor.evaluate(el =>
            (el.innerText || el.textContent || '').length
        );
        return len > prompt.length * 0.8;
    },

    // ── Post-response: validate + detect safety rejection ──
    postResponseHook: async (page, text) => {
        // Check for safety rejection.
        // BUGFIX (false positive): the old pattern matched substrings like
        // "unable to" ANYWHERE in the full text — a scientific answer containing
        // "the ligand is unable to passivate..." threw away the entire valid
        // response as ERR_SAFETY_REJECTED. Real refusals are SHORT and state the
        // refusal UP FRONT, so: (a) only inspect the first 200 chars, (b) require
        // the total response to be short, (c) anchor phrases to first person.
        const head = text.slice(0, 200);
        const REFUSAL_RE = /(?:I\s+can'?t\s+help|I'?m\s+(?:sorry.{0,40})?unable\s+to|against\s+(?:my\s+|our\s+)?polic(?:y|ies)|I\s+cannot\s+fulfill|violates?\s+.{0,30}safety\s+guidelines|我(?:无法|不能)(?:帮助|协助|提供))/i;
        if (text.length < 600 && REFUSAL_RE.test(head)) {
            throw Object.assign(
                new Error('Gemini safety filter rejected prompt'),
                { code: 'ERR_SAFETY_REJECTED' }
            );
        }

        const validation = validateResponseComplete(text);
        if (!validation.ok) {
            return ''; // fails minResponseLength → factory returns error
        }

        return text;
    },
};
