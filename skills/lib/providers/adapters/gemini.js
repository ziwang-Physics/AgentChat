/**
 * Gemini provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - Pro Extended Thinking activation (preInputHook), v10: Pro→Flash→DEFAULT
 *     (lenient policy — selector drift in the model picker degrades the model
 *     choice instead of failing the provider; AGENTCHAT_GEMINI_MODEL_POLICY=strict
 *     restores the old hard-fail)
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
 *   - 2026-07 UI rewrite support: <message-content> response containers
 *     (RESPONSE_SELECTOR) + dual-draft panels ("选项 A/B") resolved to draft A
 *     in postResponseHook (extractFirstDraft) — drafts are NEVER concatenated
 *
 * Dependencies: lib/geminiModelSwitch.js (ensureProExtended), lib/providerFactory.js (input helpers)
 */

const { ensureProExtended, ensureFlash } = require('../../geminiModelSwitch');
const { log: _tlog } = require('../../terminal');

// Default logger — the factory calls preInputHook(page, C) with no third arg,
// so the old `logFn || (() => {})` default silently swallowed every model
// activation log line, making Pro/Flash switching impossible to debug.
const glog = (msg) => _tlog('gemini', msg);

// ── Helpers (replicated from OneWeb for self-contained adapter) ──

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

// ── Response container selectors ────────────────────────────────────────────
// 2026-07 Gemini UI rewrite: `.model-response-text` no longer exists anywhere
// in the DOM. Responses now render inside <message-content> custom elements
// (DIAG dump: MESSAGE-CONTENT len=2454), and Gemini sometimes produces TWO
// parallel drafts ("选项 A" / "选项 B") inside a dual-response panel — which
// per the dump is a DIV carrying class="dual-response-panel", NOT a custom
// element tag.
//
// Design constraints (from providerFactory.js, read in full):
//   1. Phase 2 waits up to responseSelectorTimeout (60s) for EACH
//      responseSelectors array entry SERIALLY — so this must be ONE union
//      string that attaches in every UI generation, never a list with a dead
//      legacy entry in front burning 60s per call.
//   2. The factory resolves the element as locator(sel).last() (live, tracks
//      the newest match each poll) and keys the baselineCounts stale-response
//      guard off this exact selector string. Both compose correctly with a
//      simple union: old UI → .model-response-text; new UI → the newest
//      message-content.
//   3. Deliberately CSS2-simple. Draft-A-vs-draft-B discrimination needs
//      CSS4 (:not() with a complex argument) whose support differs across
//      selector engines — so it is NOT done here. During phase-3 stability
//      polling in dual mode, .last() legitimately tracks draft B (document-
//      order last); the definitive draft-A extraction happens once, in
//      postResponseHook, via Playwright locator chaining (engine-safe).
//      Per-element innerText extraction means drafts can NEVER concatenate.
const RESPONSE_SELECTOR = '.model-response-text, message-content';

// Dual-draft panel container. Class form is what the DIAG dump shows; the
// custom-element tag form is kept as zero-cost insurance against an Angular
// refactor flipping between the two.
const DUAL_PANEL_SELECTOR = '.dual-response-panel, dual-response-panel';

/**
 * If the CURRENT turn rendered a dual-draft panel, deterministically extract
 * draft A (the FIRST message-content inside the LAST panel). Locator chaining
 * (.last()/.first()) replaces sibling-order CSS, so this survives wrapper-div
 * drift and needs no CSS4.
 *
 * STALE-PANEL GUARD: a reused tab can restore history containing an OLD,
 * unresolved dual panel while the NEW turn answers in single mode. Blindly
 * taking "last panel → first draft" would then overwrite the fresh answer
 * with stale text. Currentness proof: when the panel IS the newest content,
 * the factory-polled element (document-order-LAST message-content) is the
 * panel's own last message-content — so their texts must be identical. Any
 * mismatch means the panel belongs to an earlier turn → return null and keep
 * the factory-polled text.
 *
 * @param {import('playwright').Page} page
 * @param {string} polledText - text the factory extracted from its .last() element
 * @returns {Promise<string|null>} draft A text, or null (no panel / stale / failure)
 */
async function extractFirstDraft(page, polledText) {
    try {
        const panels = page.locator(DUAL_PANEL_SELECTOR);
        if (await panels.count() === 0) return null;
        const drafts = panels.last().locator('message-content');
        if (await drafts.count() === 0) return null;

        const panelTail = await drafts.last()
            .evaluate(el => {
              const clone = el.cloneNode(true);
              clone.querySelectorAll('.katex').forEach(node => {
                const ann = node.querySelector('annotation[encoding="application/x-tex"]');
                if (ann) {
                  const tex = ann.textContent.trim();
                  node.replaceWith(document.createTextNode(
                    (node.closest('.katex-display') ? '\n$$' + tex + '$$\n' : '$' + tex + '$')
                  ));
                }
              });
              clone.querySelectorAll('mjx-container').forEach(node => {
                const tex = node.getAttribute('data-tex');
                if (tex) {
                  const block = node.hasAttribute('display') && node.getAttribute('display') === 'true';
                  node.replaceWith(document.createTextNode(block ? '\n$$' + tex + '$$\n' : '$' + tex + '$'));
                }
              });
              return (clone.innerText || clone.textContent || '').trim();
            })
            .catch(() => null);
        if (panelTail === null || panelTail !== (polledText || '').trim()) {
            return null; // panel is not the current turn — keep polled text
        }

        const text = await drafts.first()
            .evaluate(el => {
              const clone = el.cloneNode(true);
              clone.querySelectorAll('.katex').forEach(node => {
                const ann = node.querySelector('annotation[encoding="application/x-tex"]');
                if (ann) {
                  const tex = ann.textContent.trim();
                  node.replaceWith(document.createTextNode(
                    (node.closest('.katex-display') ? '\n$$' + tex + '$$\n' : '$' + tex + '$')
                  ));
                }
              });
              clone.querySelectorAll('mjx-container').forEach(node => {
                const tex = node.getAttribute('data-tex');
                if (tex) {
                  const block = node.hasAttribute('display') && node.getAttribute('display') === 'true';
                  node.replaceWith(document.createTextNode(block ? '\n$$' + tex + '$$\n' : '$' + tex + '$'));
                }
              });
              return (clone.innerText || clone.textContent || '').trim();
            })
            .catch(() => '');
        return text || null;
    } catch (_) {
        return null;
    }
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

        // Tier 3: both switchers failed.
        //
        // v10 POLICY FIX (the actual "one-time" fix for the recurring Gemini
        // outages): model PINNING failure is not model UNAVAILABILITY. If the
        // selector drifts, the page still has a fully working Gemini with its
        // default model — throwing here threw away a valid Gemini answer and
        // cascaded the whole call to ChatGPT every time Google touched the
        // model picker. Default is now to WARN and proceed on the page's
        // current/default model; diagnostics for the picker were already
        // dumped by geminiModelSwitch. Opt back into the old hard-fail with
        //   AGENTCHAT_GEMINI_MODEL_POLICY=strict
        // (for callers that MUST have Pro Extended, e.g. benchmark runs).
        const policy = String(process.env.AGENTCHAT_GEMINI_MODEL_POLICY || 'lenient')
            .trim().toLowerCase();
        if (policy === 'strict') {
            throw Object.assign(
                new Error('Gemini model activation failed — Pro Extended and Flash both unavailable (policy=strict)'),
                { code: 'ERR_MODEL_DEGRADED' }
            );
        }
        log('gemini WARN: model activation failed — proceeding with the page\'s '
            + 'DEFAULT model (policy=lenient). Set AGENTCHAT_GEMINI_MODEL_POLICY=strict to fail instead.');
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
    // Entry 2 is a last-resort fallback for a future UI where <message-content>
    // itself gets renamed: the .markdown panel carried identical text in the
    // DIAG dump (len 2454 == 2454). It is only consulted after entry 1 spends
    // its full 60s wait, and in dual mode its .last() may resolve to draft B —
    // a single coherent draft, never a concatenation.
    responseSelectors: [RESPONSE_SELECTOR, '.markdown.markdown-main-panel'],
    responseSelectorTimeout: 60_000,
    stabilityWindow: 10_000,
    minResponseLength: 10,

    // v17: generated-image support — Imagen renders may lag behind text stability.
    // Shadow-DOM piercing in collectResponseImages handles <img> inside custom
    // elements; imageSettleMs adds a post-stability grace window for render
    // completion before extraction scans the DOM.
    imageScopeSelector: null,  // TreeWalker starts from responseEl; shadow roots covered
    imageSettleMs: 5_000,      // 5s grace for Imagen render after text stable
    imageMinPx: 200,           // v17: exclude AI sparkle-icons, avatars, thumbnails

    // v11: the factory now caps ⚙ stability-clock holds at
    // stillGeneratingMaxHoldMs since the last REAL text change (default 90s).
    // Pro Extended can think 3-5 min with the stop button visible and ZERO
    // text output — raise the cap so isStillGenerating() keeps holding the
    // clock for the full thinking phase, exactly as before the cap existed.
    stillGeneratingMaxHoldMs: 300_000,

    // ── Completion anchor: Action Toolbar = definitive "done" ──
    // GAP FIX: the DIAG log shows a zh-CN UI ("选项 A", "搜索网页"), but the old
    // list only covered zh-TW ("複製") and English — on Simplified-Chinese
    // pages NO anchor could ever match and phase 4 silently burned its budget
    // slice every call. Added 复制/コピー/良い回答 to mirror locales/gemini.js
    // FUZZY (copy: /复制|複製|Copy|コピー/, good: /好答案|Good response|良い回答/),
    // plus <message-actions> as a locale-independent structural anchor probed
    // first. Phase 4 splits the remaining budget across entries with a hard
    // cumulative deadline, so extra entries cannot overrun the budget.
    completionAnchor: [
        'message-actions button',
        'button[aria-label*="复制"]',
        'button[aria-label*="複製"]',
        'button[aria-label*="Copy"]',
        'button[aria-label*="コピー"]',
        'button[aria-label*="Good response"]',
        'button[aria-label*="好答案"]',
        'button[aria-label*="良い回答"]',
    ],

    // ── Bursty generation detection ──
    stillGeneratingCheck: async (page) => {
        const generating = await isStillGenerating(page);
        if (generating) return true;
        // Also check if current text is just pre-generation filler.
        // Must use the SAME selector union the factory polls with, so the
        // pre-generation verdict is rendered on the SAME element whose text
        // drives the stability clock (in dual mode that is draft B, the
        // document-order last — draft A is swapped in later by postResponseHook).
        const text = await page.locator(RESPONSE_SELECTOR).last()
            .evaluate(el => {
              const clone = el.cloneNode(true);
              clone.querySelectorAll('.katex').forEach(node => {
                const ann = node.querySelector('annotation[encoding="application/x-tex"]');
                if (ann) {
                  const tex = ann.textContent.trim();
                  node.replaceWith(document.createTextNode(
                    (node.closest('.katex-display') ? '\n$$' + tex + '$$\n' : '$' + tex + '$')
                  ));
                }
              });
              clone.querySelectorAll('mjx-container').forEach(node => {
                const tex = node.getAttribute('data-tex');
                if (tex) {
                  const block = node.hasAttribute('display') && node.getAttribute('display') === 'true';
                  node.replaceWith(document.createTextNode(block ? '\n$$' + tex + '$$\n' : '$' + tex + '$'));
                }
              });
              return (clone.innerText || clone.textContent || '').trim();
            }).catch(() => '');
        return looksLikePreGeneration(text);
    },

    // ── Input: Angular-specific (fill() for clear, dispatchEvent for CD) ──
    // v22 CONCURRENCY FIX: system clipboard is a single OS-wide resource — concurrent
    // workers race on it. Keyboard insertText (CDP Input.insertText, target-scoped)
    // is the primary path; system clipboard is the LAST resort, used only when
    // keyboard fails. Gemini's Quill/Angular editor doesn't reliably consume
    // synthetic ClipboardEvents, so we skip the simulated-paste tier.
    input: async (page, editor, prompt) => {
        // Clear — try fill() first for Angular/Quill compatibility
        try { await editor.fill(''); } catch {
            await page.keyboard.press('ControlOrMeta+a');
            await page.keyboard.press('Backspace');
        }
        await page.waitForTimeout(100);

        // Input text
        if (prompt.length > INSERT_TEXT_LIMIT) {
            // Tier 1: chunked keyboard — CDP Input.insertText, target-scoped, safe.
            for (let i = 0; i < prompt.length; i += 150) {
                await page.keyboard.insertText(prompt.substring(i, i + 150));
                await page.waitForTimeout(40);
            }
            let landed = await editor.evaluate(el =>
                (el.innerText || el.textContent || '').length
            ).catch(() => 0) > prompt.length * 0.8;

            // Tier 2 (LAST RESORT): system clipboard. Racy under concurrency;
            // the composer readback check catches cross-talk when it occurs.
            if (!landed) {
                let clipOk = true;
                try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); }
                catch (_) { clipOk = false; }
                if (clipOk) {
                    // Clear failed keyboard content first
                    try { await editor.fill(''); } catch {
                        await page.keyboard.press('ControlOrMeta+a');
                        await page.keyboard.press('Backspace');
                    }
                    await page.waitForTimeout(100);
                    await page.keyboard.press('ControlOrMeta+v');
                    await page.waitForTimeout(500);
                    landed = await editor.evaluate(el =>
                        (el.innerText || el.textContent || '').length
                    ).catch(() => 0) > prompt.length * 0.8;
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

    // ── Post-response: dual-draft resolution + validate + safety rejection ──
    postResponseHook: async (page, text) => {
        // Dual-draft panel (选项 A / 选项 B): the factory's polled .last()
        // element is draft B in that mode (document-order last). Replace the
        // text with draft A — deterministic, single draft, never concatenated.
        // extractFirstDraft's stale-panel guard keeps this a no-op when the
        // panel belongs to an earlier restored turn. Must run BEFORE the
        // refusal/validation checks so they judge the draft actually returned.
        const draftA = await extractFirstDraft(page, text);
        if (draftA) text = draftA;

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
