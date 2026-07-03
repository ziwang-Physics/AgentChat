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
 *   - Extra URL validation: must be on gemini.google.com (not upgrade/error pages)
 *   - Safety rejection + short-response validation in postResponseHook
 *
 * Dependencies: lib/geminiModelSwitch.js (ensureProExtended), lib/providerFactory.js (input helpers)
 */

const { ensureProExtended, ensureFlash } = require('../../geminiModelSwitch');

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
function looksLikePreGeneration(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length === 0) return true;
    if (trimmed.length > 300) return false;
    for (const pat of STILL_WORKING_TEXT) {
        if (pat.test(trimmed)) return true;
    }
    if (trimmed.length < 150 && !/[。！？\.!\?;；，\n]{1}/.test(trimmed)) return true;
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

    // ── Pre-input: tiered model activation (Pro Extended → Flash → fail) ──
    preInputHook: async (page, cfg, logFn) => {
        const log = logFn || (() => {});
        // Extra URL validation — must be on gemini.google.com
        const url = page.url();
        if (!url.includes('gemini.google.com')) {
            throw Object.assign(
                new Error(`Unexpected Gemini URL: ${url}`),
                { code: 'ERR_WRONG_PAGE' }
            );
        }

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
            try {
                await page.evaluate(t => navigator.clipboard.writeText(t), prompt);
            } catch (_) { /* clipboard may fail in headless */ }
            await page.keyboard.press('ControlOrMeta+v');
            await page.waitForTimeout(500);
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
        // Check for safety rejection
        if (/can'?t help|unable to|against policy|I cannot fulfill|safety guidelines/i.test(text)) {
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
