#!/usr/bin/env node
/**
 * AI Fallback Chain — Multi-Provider CDP Bridge
 *
 * Priority chain: Gemini (Pro Extended) → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek
 * Falls to next provider on quota exhaustion or service unavailability.
 * Only ONE provider is used per invocation — first available wins.
 *
 * Usage:
 *   node index.js "Your prompt here"
 *   node index.js --timeout=600000 "Long prompt..."
 *   echo "Prompt from stdin" | node index.js
 *   node index.js --smoke          # verify at least one provider reachable
 *   node index.js --doctor         # check CDP connectivity only
 *   node index.js --from=ChatGPT   # start from a specific provider
 *
 * Exit codes:
 *   0 - Success (response on stdout)
 *   1 - Chrome CDP not reachable (ERR_NO_CDP)
 *   2 - No provider reachable — all auth-gated or page load failed (ERR_NO_PROVIDER)
 *   3 - Safety rejected by all providers (ERR_SAFETY_REJECTED)
 *   4 - Internal error (ERR_INTERNAL)
 *   5 - All providers rate-limited (ERR_RATE_LIMITED)
 *   9 - All providers exhausted, mixed reasons (ERR_ALL_EXHAUSTED)
 *  10 - Total timeout reached (ERR_TIMEOUT)
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const http = require('http');

const { ProviderError, classifyError } = require('../lib/errors');

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const CDP_URL = `http://127.0.0.1:${process.env.CDP_PORT || '9222'}`;
const DEFAULT_TOTAL_TIMEOUT = 600_000; // 10 min total across all providers
const DEFAULT_PROVIDER_TIMEOUT = 180_000; // 3 min per provider
const POLL_INTERVAL = 2_000; // ms between response stability checks
// keyboard.insertText() dispatches one input event per character, which triggers
// React re-renders (ChatGPT, Claude, etc.) — O(n) CDP round-trips for n chars.
// Clipboard paste (navigator.clipboard.writeText + Ctrl+V) is O(1) regardless of length.
// Threshold set to 500 so anything beyond a short sentence uses the fast clipboard path.
const INSERT_TEXT_LIMIT = 500;
const SKILL_DIR = path.dirname(__filename); // skill directory for telemetry

// ══════════════════════════════════════════════════════════════════════════════
// INVOCATION CONTEXT — per-run state isolated from module globals (P0-2)
// ══════════════════════════════════════════════════════════════════════════════

const CIRCUIT_BREAKER_THRESHOLD = 3;   // consecutive failures before breaking
const CIRCUIT_COOLDOWN_MS = 300_000;   // 5 min cooldown before retry

class InvocationContext {
    constructor() {
        this.circuitState = {};  // { gemini: {failures, brokenUntil}, ... }
        this.telemetry = {
            timestamp: new Date().toISOString(),
            provider_used: null,
            providers_tried: [],
            fallback_reasons: {},
            prompt_length_chars: 0,
            response_length_chars: 0,
            total_ms: 0,
            per_provider_ms: {},
            exit_code: 0,
        };
    }

    circuitIsBroken(key) {
        const s = this.circuitState[key];
        if (!s || s.failures < CIRCUIT_BREAKER_THRESHOLD) return false;
        if (Date.now() > s.brokenUntil) {
            delete this.circuitState[key];
            return false;
        }
        return true;
    }

    circuitRecordFailure(key) {
        if (!this.circuitState[key]) this.circuitState[key] = { failures: 0, brokenUntil: 0 };
        const s = this.circuitState[key];
        s.failures++;
        if (s.failures >= CIRCUIT_BREAKER_THRESHOLD) {
            s.brokenUntil = Date.now() + CIRCUIT_COOLDOWN_MS;
        }
    }

    circuitRecordSuccess(key) {
        delete this.circuitState[key];
    }

    recordTelemetry(code) {
        this.telemetry.exit_code = code;
        const f = path.join(SKILL_DIR, 'fallback-telemetry.jsonl');
        fs.appendFileSync(f, JSON.stringify(this.telemetry) + '\n');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER CHAIN (priority order — first available wins)
// ══════════════════════════════════════════════════════════════════════════════

const PROVIDER_CHAIN = [
    {
        key: 'gemini',
        name: 'Gemini',
        url: 'https://gemini.google.com/u/0/app',
        requiresProCheck: true,
        authDomains: ['accounts.google.com'],
        quotaPatterns: [
            /quota\s*exceeded/i,
            /rate\s*limit/i,
            /too\s*many\s*requests/i,
            /try\s*again\s*later/i,
            /usage\s*limit/i,
        ],
        // contenteditable=false on the rich-textarea is the primary rate-limit signal
    },
    {
        key: 'chatgpt',
        name: 'ChatGPT',
        url: 'https://chatgpt.com/',
        requiresProCheck: false,
        authDomains: ['auth.openai.com', 'chat.openai.com/auth'],
        quotaPatterns: [
            /reached.*(?:limit|quota|cap)/i,
            /upgrade\s*(?:to|your)\s*plus/i,
            /free\s*(?:plan|tier)\s*limit/i,
            /usage\s*(?:limit|cap|exceeded)/i,
            /you'?ve\s*(?:reached|hit).*(?:limit|cap)/i,
            /请.*升级/i,
            /额度.*(?:用|已).*尽/i,
        ],
    },
    {
        key: 'claude',
        name: 'Claude',
        url: 'https://claude.ai/',
        requiresProCheck: false,
        authDomains: ['claude.ai/login', 'auth.anthropic.com'],
        quotaPatterns: [
            /rate\s*limit\s*(?:exceeded|reached)/i,
            /out\s*of\s*messages/i,
            /messages?\s*remaining[:\s]*0/i,
            /usage\s*limit/i,
            /please\s*wait/i,
        ],
    },
    {
        key: 'qwen',
        name: 'Qwen',
        url: 'https://www.qianwen.com/?source=tongyigw',
        requiresProCheck: false,
        authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'],
        quotaPatterns: [
            /额度.*(?:已|用).*(?:完|尽|满)/i,
            /quota\s*(?:exceeded|limit)/i,
            /次数.*(?:已|用).*(?:完|尽)/i,
            /请.*(?:充值|升级|续费)/i,
        ],
    },
    {
        key: 'kimi',
        name: 'Kimi',
        url: 'https://kimi.moonshot.cn/',
        requiresProCheck: false,
        authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'],
        quotaPatterns: [
            /高峰.*算力.*不足/i,
            /Kimi.*(?:累了|休息)/i,
            /聊的人太多了/i,
            /前往升级/i,
            /额度.*(?:已|用).*(?:完|尽|满)/i,
        ],
    },
    {
        key: 'minimax',
        name: 'MiniMax',
        url: 'https://agent.minimaxi.com/',
        requiresProCheck: false,
        authDomains: ['agent.minimaxi.com/login', 'minimax.com/login'],
        quotaPatterns: [
            /额度.*(?:已|用).*(?:完|尽|满)/i,
            /quota\s*(?:exceeded|limit)/i,
            /次数.*(?:已|用).*(?:完|尽)/i,
            /请.*(?:充值|升级)/i,
        ],
    },
    {
        key: 'mimo',
        name: 'MiMo',
        url: 'https://aistudio.xiaomimimo.com/',
        requiresProCheck: false,
        authDomains: ['aistudio.xiaomimimo.com/login', 'auth0.com'],
        quotaPatterns: [
            /额度.*(?:已|用).*(?:完|尽|满)/i,
            /quota\s*(?:exceeded|limit)/i,
            /免费版.*升级/i,
            /请.*(?:充值|升级|续费)/i,
        ],
    },
    {
        key: 'deepseek',
        name: 'DeepSeek',
        url: 'https://chat.deepseek.com/',
        requiresProCheck: false,
        authDomains: ['chat.deepseek.com/login', 'deepseek.com/login'],
        quotaPatterns: [
            /额度.*(?:已|用).*(?:完|尽|满)/i,
            /quota\s*(?:exceeded|limit)/i,
            /rate\s*limit/i,
            /请.*(?:充值|升级)/i,
        ],
    },
];

// ══════════════════════════════════════════════════════════════════════════════
// TERMINAL HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function log(msg) {
    process.stderr.write('\r\x1b[K'); // clear spinner
    process.stderr.write(`[fallback] ${msg}\n`);
}

let spinnerInterval = null;
function startTimer(label) {
    if (spinnerInterval) clearInterval(spinnerInterval);
    const start = Date.now();
    const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
    let i = 0;
    spinnerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - start) / 1000);
        const m = String(Math.floor(elapsed / 60)).padStart(2, '0');
        const s = String(elapsed % 60).padStart(2, '0');
        process.stderr.write(`\r[fallback] ${frames[i]} ${label} (${m}:${s})`);
        i = (i + 1) % frames.length;
    }, 100);
}

function stopTimer() {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    process.stderr.write('\r\x1b[K');
}

function spinner(ch) {
    process.stderr.write(ch);
}

// ══════════════════════════════════════════════════════════════════════════════
// CDP CONNECTION
// ══════════════════════════════════════════════════════════════════════════════

async function connectWithRetry(cdpUrl, retries = 3) {
    for (let i = 1; i <= retries; i++) {
        try {
            log(`Connecting to Chrome CDP (attempt ${i}/${retries})...`);
            const browser = await chromium.connectOverCDP(cdpUrl);
            browser.on('disconnected', () => {
                log('CRITICAL: CDP connection to Chrome dropped.');
            });
            return browser;
        } catch (err) {
            if (i === retries) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

/** Click a send button (trying selectors in order) or fall back to keyboard */
async function sendMessage(page, editorLocator, sendSelectors, sendFallback) {
    let sent = false;
    for (const sel of sendSelectors) {
        try {
            const btn = page.locator(sel);
            const btnLoc = btn.first ? btn.first() : btn;
            if (await btnLoc.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btnLoc.click();
                sent = true;
                break;
            }
        } catch (_) { }
    }
    if (!sent) {
        await editorLocator.focus();
        await page.keyboard.press(sendFallback || 'Enter');
    }
    await page.waitForTimeout(1500);
}

/** Patterns that indicate the AI is still working, not producing final output */
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
    if (trimmed.length > 300) return false;  // enough content → real response
    for (const pat of STILL_WORKING_TEXT) {
        if (pat.test(trimmed)) return true;
    }
    // Short response that's just search keywords (no Chinese/Japanese sentences)
    if (trimmed.length < 150 && !/[。！？\.!\?;；，\n]{1}/.test(trimmed)) return true;
    return false;
}

/** Post-extraction: validate that the response is complete and meaningful */
function validateResponseComplete(text) {
    const trimmed = (text || '').trim();
    if (trimmed.length < 10) return { ok: false, reason: 'too_short' };
    // Pure search-query page with no answer content
    if (/^搜索网页\s*\n[\s\S]{0,200}\d+\s*个结果\s*$/.test(trimmed)) return { ok: false, reason: 'search_only' };
    if (/^Searching\w*\s*\n[\s\S]{0,200}\d+\s*results?\s*$/i.test(trimmed)) return { ok: false, reason: 'search_only' };
    // Only thinking placeholder
    if (/^(?:Thought|Thinking|思考中|分析中)\s*for\s*\d+s?\s*$/im.test(trimmed) && trimmed.length < 60) {
        return { ok: false, reason: 'thinking_only' };
    }
    return { ok: true };
}

async function ensureProExtended(page, maxRetries = 2) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            log(`gemini: retry ${attempt}/${maxRetries} — reloading page`);
            try { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000); } catch (_) { }
        }

        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // Check current mode
        const currentMode = await page.evaluate(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            return btn ? btn.textContent.trim() : 'UNKNOWN';
        });
        log(`gemini attempt ${attempt}: current mode = "${currentMode}"`);

        if (currentMode.includes('Pro延長') || currentMode.includes('Pro Extended')) {
            log('gemini: Pro Extended Thinking already active');
            return true;
        }

        // Step 1: Open model selector
        try {
            const selectorBtn = page.locator(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            ).first();
            await selectorBtn.waitFor({ state: 'visible', timeout: 5000 });
            await selectorBtn.click();
        } catch {
            log('gemini WARN: Model selector button not found.');
            continue;
        }

        // Wait for menu
        try {
            await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
        } catch {
            log('gemini WARN: Menu did not appear.');
            continue;
        }

        // Step 2: Ensure Pro model (skip Flash)
        if (!currentMode.includes('Pro') || currentMode.includes('Flash')) {
            log('gemini: switching to Pro model');
            try {
                const proItem = page.locator('[role="menuitem"]', { hasText: 'Pro' })
                    .filter({ hasNotText: 'Flash' }).first();
                await proItem.click();
                await page.waitForTimeout(2000);
                // Reopen menu for thinking level
                const btn = page.locator(
                    'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
                ).first();
                await btn.click();
                await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
            } catch {
                log('gemini WARN: Failed to switch to Pro model.');
                continue;
            }
        }

        // Step 3-4: Expand thinking level → select Extended
        const extendedBtn = page.locator('[role="menuitem"]')
            .filter({ hasText: /延長|Extended/i })
            .filter({ hasNotText: /思考|Thought/i })
            .first();

        const extendedAlreadyVisible = await extendedBtn.isVisible().catch(() => false);

        if (!extendedAlreadyVisible) {
            log('gemini: expanding thinking-level choices');
            try {
                const thoughtItem = page.locator('[role="menuitem"]', { hasText: /思考|Thought/i }).first();
                await thoughtItem.click();
            } catch {
                log('gemini WARN: Could not expand thinking level menu.');
                continue;
            }
        }

        // Click Extended
        try {
            await extendedBtn.waitFor({ state: 'visible', timeout: 5000 });
            await extendedBtn.click();
            log('gemini: selected Extended thinking');
        } catch {
            log('gemini WARN: Extended button not clickable.');
            continue;
        }

        // Close menu + verify
        await page.keyboard.press('Escape');
        await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => { });

        const isActive = await page.waitForFunction(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            if (!btn) return false;
            const text = btn.textContent.trim();
            return text.includes('Pro延長') || text.includes('Pro Extended');
        }, null, { timeout: 3000 }).catch(() => false);

        if (isActive) {
            log('gemini: Verified Pro Extended Thinking active.');
            return true;
        }
        log('gemini: final mode not confirmed as Pro Extended.');
    }
    return false;
}

async function waitForGeminiResponse(page, timeoutMs) {
    const startTime = Date.now();
    log('gemini: waiting for response rendering...');

    const responseLocator = page.locator('.model-response-text');

    try {
        await responseLocator.last().waitFor({ state: 'attached', timeout: timeoutMs });
    } catch {
        log('gemini: No response text element appeared within timeout.');
        return null;
    }

    // PRIMARY: Action Toolbar detection
    const actionToolbar = page.locator(
        'button[aria-label*="複製"], button[aria-label*="Copy"], button[aria-label*="Good response"], button[aria-label*="好答案"]'
    ).last();

    const toolbarAppeared = await actionToolbar.waitFor({
        state: 'visible',
        timeout: Math.max(10000, timeoutMs - (Date.now() - startTime))
    }).then(() => true).catch(() => false);

    if (!toolbarAppeared) {
        log('gemini: Action toolbar not detected, falling back to enhanced stability check...');
        let lastLen = 0;
        let lastChangeTime = Date.now();
        const MAX_STABILITY = 15_000;

        while ((Date.now() - lastChangeTime) < MAX_STABILITY) {
            if ((Date.now() - startTime) > timeoutMs) break;
            await page.waitForTimeout(POLL_INTERVAL);
            try {
                const currentText = await responseLocator.last().evaluate(el => el.innerText || el.textContent || '');

                // Three-layer defense for bursty generation (Pro Extended Thinking pauses)
                const generating = await isStillGenerating(page);
                const preGen = looksLikePreGeneration(currentText);
                const adaptiveWindow = currentText.length < 150 ? 30_000
                                    : currentText.length < 500 ? 20_000
                                    : 15_000;

                if (currentText.length > lastLen) {
                    lastLen = currentText.length;
                    lastChangeTime = Date.now();
                    spinner('+');
                } else if (generating || preGen) {
                    lastChangeTime = Date.now();  // still working, reset clock
                    spinner(generating ? '⚙' : '…');
                } else {
                    const stableFor = Date.now() - lastChangeTime;
                    spinner(stableFor < adaptiveWindow ? '·' : 's');
                }
            } catch { spinner('?'); }
        }
        process.stderr.write('\n');
    } else {
        log('gemini: Action toolbar detected — response finalized.');
    }

    const finalContent = await responseLocator.last().evaluate((el) => {
        const container = el.closest('model-message')
            || el.closest('[class*="message-container"]')
            || el.closest('[class*="response-container"]')
            || el.parentElement?.parentElement
            || el;
        return (container.innerText || container.textContent || '').trim();
    });

    log(`gemini: response complete, length = ${finalContent ? finalContent.length : 0}`);

    // Post-extraction validation — reject search-only/thinking-only responses
    if (finalContent && finalContent.length > 0) {
        const validation = validateResponseComplete(finalContent);
        if (!validation.ok) {
            log(`gemini: response rejected — ${validation.reason}`);
            return null;
        }
    }
    return finalContent;
}

async function tryGemini(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying Gemini (priority 1) ━━━');

    // Navigate
    const cfg = PROVIDER_CHAIN.find(p => p.key === 'gemini');
    await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d))) {
        log('gemini: Not authenticated — redirect to login detected.');
        return { success: false, reason: 'auth' };
    }
    if (!url.includes('gemini.google.com')) {
        log(`gemini: Unexpected URL: ${url}`);
        return { success: false, reason: 'error' };
    }

    // Rate-limit check: editor locked?
    try {
        const editor = page.locator('.ql-editor, [contenteditable="true"][role="textbox"], rich-textarea').first();
        await editor.waitFor({ state: 'visible', timeout: 10000 });
        const isEditable = await editor.evaluate(el =>
            el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly')
        );
        if (!isEditable) {
            log('gemini: Editor is read-only — rate limited (ERR_RATE_LIMITED).');
            return { success: false, reason: 'quota' };
        }
    } catch {
        log('gemini: Editor not found — UI may have changed.');
        return { success: false, reason: 'error' };
    }

    // Pro Extended check
    if (!(await ensureProExtended(page))) {
        log('gemini: Pro Extended activation FAILED — degrading to next provider.');
        return { success: false, reason: 'quota' }; // treat model degradation as quota
    }

    // ── Type prompt ──
    const editorLocator = page.locator('.ql-editor, [contenteditable="true"][role="textbox"], rich-textarea').first();
    await editorLocator.focus();
    await editorLocator.click();

    try { await editorLocator.fill(''); } catch {
        await editorLocator.click();
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(100);

    if (prompt.length > INSERT_TEXT_LIMIT) {
        log(`gemini: Large payload (${prompt.length} chars), clipboard paste...`);
        try {
            await page.evaluate(async (text) => {
                await navigator.clipboard.writeText(text);
            }, prompt);
        } catch { log('gemini WARN: Clipboard write failed.'); }
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(500);
    } else {
        await page.keyboard.insertText(prompt);
    }

    // Trigger Angular change detection
    await editorLocator.evaluate(node => {
        node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });

    // ── Send ──
    const sendBtn = page.locator('button[aria-label*="傳送"], button[aria-label*="发送"], button[aria-label*="Send"]');
    try {
        await sendBtn.waitFor({ state: 'visible', timeout: 3000 });
        await sendBtn.click();
    } catch {
        log('gemini: Send button unavailable, trying Ctrl+Enter...');
        await editorLocator.focus();
        await page.keyboard.press('ControlOrMeta+Enter');
    }

    // ── Wait for generation phase ──
    // Pro Extended Thinking can take 2-5 minutes for complex prompts.
    // The stop button is visible during the ENTIRE thinking+generation phase.
    // When it's visible → Gemini IS working → keep waiting, don't time out.
    const stopBtn = page.locator('button[aria-label*="停止"], button[aria-label*="Stop"]').first();
    try {
        await stopBtn.waitFor({ state: 'visible', timeout: 20000 });
        log('gemini: generation started (stop button visible)');
        // Use nearly the full remaining budget for the generation wait.
        // Pro Extended thinking for long prompts can legitimately take 3-5 min.
        const remainingForGen = Math.max(60000, timeoutMs - (Date.now() - provStart) - 15000);
        await stopBtn.waitFor({ state: 'hidden', timeout: remainingForGen });
        log('gemini: generation finished (stop button hidden)');
    } catch {
        // Check if stop button is STILL visible — if so, Gemini is still working.
        // Don't give up; give it one more extension (up to 120s extra).
        const stillWorking = await stopBtn.isVisible().catch(() => false);
        if (stillWorking) {
            log('gemini: Still generating after initial wait — extending (Pro Extended may be thinking)...');
            const extraBudget = Math.min(120000, Math.max(30000, timeoutMs - (Date.now() - provStart) - 5000));
            if (extraBudget > 20000) {
                await stopBtn.waitFor({ state: 'hidden', timeout: extraBudget }).catch(() => {
                    log('gemini: Generation still in progress at hard deadline.');
                });
            }
        } else {
            log('gemini: No prolonged generation phase (instant/cached response).');
        }
    }

    // ── Collect response ──
    // For Pro Extended, the response may need extra time to render after generation finishes
    const remainingForResp = Math.max(45000, timeoutMs - (Date.now() - provStart));
    const response = await waitForGeminiResponse(page, remainingForResp);

    if (!response || response.length < 10) {
        // Check for safety rejection
        const maybeRejected = await page.evaluate(() => {
            const el = document.querySelector('.model-response-text');
            return el?.textContent || '';
        });
        if (maybeRejected && /can'?t help|unable to|against policy|I cannot fulfill|safety guidelines/i.test(maybeRejected)) {
            log('gemini: Safety filter rejected prompt.');
            return { success: false, reason: 'safety' };
        }
        log('gemini: Response empty or too short.');
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.gemini = Date.now() - provStart;
    log(`gemini: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.gemini}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: CHATGPT
// ══════════════════════════════════════════════════════════════════════════════

async function tryChatGPT(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying ChatGPT (priority 2) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'chatgpt');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('chatgpt: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d))) {
        log('chatgpt: Not authenticated — login redirect.');
        return { success: false, reason: 'auth' };
    }
    // ChatGPT might redirect to chatgpt.com/auth/login
    if (url.includes('/auth') || url.includes('/login')) {
        log('chatgpt: Auth page detected.');
        return { success: false, reason: 'auth' };
    }

    // Rate-limit / quota check via page text
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    for (const pattern of cfg.quotaPatterns) {
        if (pattern.test(bodyText)) {
            log(`chatgpt: Quota pattern matched: "${bodyText.match(pattern)?.[0]}"`);
            return { success: false, reason: 'quota' };
        }
    }

    // Find editor
    const editorSelectors = [
        '#prompt-textarea',
        '[contenteditable="true"][role="textbox"]',
        'div[contenteditable="true"]',
        'textarea',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
            const editable = await loc.evaluate(el =>
                el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly') && !el.hasAttribute('disabled')
            ).catch(() => false);
            if (editable) {
                editorLocator = loc;
                break;
            }
        }
    }

    if (!editorLocator) {
        log('chatgpt: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('chatgpt: Editor found, clipboard paste...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);
    // ChatGPT uses contenteditable div — fill() hangs for 30s before throwing.
    // Use keyboard shortcuts directly instead.
    await page.keyboard.press('ControlOrMeta+a');
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(100);
    // Always use clipboard — skip O(n) keyboard.insertText for React re-render perf
    try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
    await page.keyboard.press('ControlOrMeta+v');
    await page.waitForTimeout(500);
    // Trigger React change detection
    await editorLocator.evaluate(node => {
        node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
    });

    const sendSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send"]',
        'button svg',
    ];
    await sendMessage(page, editorLocator, sendSelectors, 'Enter');
    log('chatgpt: Sent.');

    // ── Wait for response ──
    log('chatgpt: waiting for response...');
    const startTime = Date.now();

    // Wait for the assistant response to appear
    const responseSelectors = [
        '.markdown',
        '[data-message-author-role="assistant"]',
        '.agent-turn',
        '[class*="response"]',
    ];

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: Math.min(30000, timeoutMs) });
            responseEl = loc;
            break;
        } catch (_) { }
    }

    if (!responseEl) {
        log('chatgpt: No response element appeared.');
        return { success: false, reason: 'timeout' };
    }

    // Wait for generation to finish (stop button disappears)
    try {
        const stopBtn = page.locator('button[data-testid="stop-button"], button[aria-label="Stop"]').first();
        await stopBtn.waitFor({ state: 'visible', timeout: 5000 }).catch(() => { });
        const remaining = Math.max(30000, timeoutMs - (Date.now() - startTime));
        await stopBtn.waitFor({ state: 'hidden', timeout: remaining }).catch(() => { });
    } catch (_) { }

    // Stability check
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const STABILITY_WINDOW = 10_000;
    const DEADLINE = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < STABILITY_WINDOW && Date.now() < DEADLINE) {
        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else {
                spinner('.');
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    if (!response || response.length < 5) {
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.chatgpt = Date.now() - provStart;
    log(`chatgpt: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.chatgpt}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: CLAUDE
// ══════════════════════════════════════════════════════════════════════════════

async function tryClaude(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying Claude (priority 3) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'claude');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('claude: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d)) || url.includes('/login')) {
        log('claude: Not authenticated.');
        return { success: false, reason: 'auth' };
    }

    // Quota check
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    for (const pattern of cfg.quotaPatterns) {
        if (pattern.test(bodyText)) {
            log(`claude: Quota pattern matched: "${bodyText.match(pattern)?.[0]}"`);
            return { success: false, reason: 'quota' };
        }
    }

    // Find editor (Claude uses ProseMirror contenteditable)
    const editorSelectors = [
        '[contenteditable="true"]',
        '.ProseMirror',
        'div[role="textbox"]',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        const loc = page.locator(sel).first();
        if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
            const editable = await loc.evaluate(el =>
                el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly')
            ).catch(() => false);
            if (editable) {
                editorLocator = loc;
                break;
            }
        }
    }

    if (!editorLocator) {
        log('claude: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('claude: Editor found, typing...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    try { await editorLocator.fill(''); } catch {
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(100);

    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(500);

    // Send — Claude uses Enter or button (aria-label is lowercase "m")
    const sendSelectors = [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[aria-label="Send"]',
    ];

    let sent = false;
    for (const sel of sendSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click();
                sent = true;
                break;
            }
        } catch (_) { }
    }
    if (!sent) {
        log('claude: Trying Enter to send...');
        await editorLocator.focus();
        await page.keyboard.press('Enter');
    }

    // ── Wait for response ──
    log('claude: waiting for response...');
    const startTime = Date.now();

    // Claude shows a stop button during generation. But the button's aria-label
    // may vary between UI versions, and it may appear/disappear too quickly for
    // our polling to catch.  Use multiple strategies.
    let generationDetected = false;
    try {
        const stopSelectors = [
            'button[aria-label="Stop"]',
            'button[aria-label="Stop generating"]',
            'button[aria-label*="Stop"]',
            '[data-testid="stop-button"]',
        ];
        for (const sel of stopSelectors) {
            try {
                const stopBtn = page.locator(sel).first();
                await stopBtn.waitFor({ state: 'visible', timeout: 10000 });
                log('claude: generation started (stop button visible)');
                generationDetected = true;
                const remaining = Math.max(30000, timeoutMs - (Date.now() - provStart));
                await stopBtn.waitFor({ state: 'hidden', timeout: remaining }).catch(() => {});
                log('claude: generation finished (stop button hidden)');
                break;
            } catch (_) { /* try next selector */ }
        }
    } catch (_) { }

    if (!generationDetected) {
        // Fallback: wait for the response element to contain MORE than just
        // the "Thinking" placeholder. Claude shows "Thinking" / "Analyzing"
        // during the reasoning phase — we must wait past that.
        log('claude: Stop button not detected, waiting for real content...');
        const DEADLINE_LOADING = Date.now() + Math.min(60000, timeoutMs);
        while (Date.now() < DEADLINE_LOADING) {
            await page.waitForTimeout(2000);
            try {
                const bodyText = await page.evaluate(() => document.body?.innerText || '');
                // Look for meaningful content — not just the "Thinking" placeholder
                const meaningful = bodyText.replace(/\b(Thinking|Analyzing|Reasoning|思考中|分析中)\.{0,3}\s*/gi, '').trim();
                if (meaningful.length > 50) {
                    log('claude: real content detected via body text scan');
                    generationDetected = true;
                    break;
                }
            } catch (_) { }
        }
        if (!generationDetected) {
            log('claude: No generation detected after extended wait.');
        }
    }

    // Extract response
    // Claude response: Tailwind classes with msg-assistant in var name
    const responseSelectors = [
        '[class*="msg-assistant"]',
        '[class*="font-claude-message"]',
        '.prose',
        '[class*="message"]',
    ];

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: 10000 });
            responseEl = loc;
            break;
        } catch (_) { }
    }

    if (!responseEl) {
        log('claude: Response element not found.');
        return { success: false, reason: 'error' };
    }

    // Stability check
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const STABILITY_WINDOW = 10_000;
    const DEADLINE = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < STABILITY_WINDOW && Date.now() < DEADLINE) {
        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else {
                spinner('.');
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    if (!response || response.length < 5) {
        return { success: false, reason: 'error' };
    }

    // Reject placeholder-only responses (Claude's "Thinking" / "Analyzing" phase)
    const PLACEHOLDER_PATTERNS = [
        /^Thinking\.{0,3}\s*$/i,
        /^Analyzing\.{0,3}\s*$/i,
        /^Reasoning\.{0,3}\s*$/i,
        /^思考中\.{0,3}\s*$/i,
        /^分析中\.{0,3}\s*$/i,
    ];
    const cleanedCheck = response.replace(/[\s\n]+/g, ' ').trim();
    if (PLACEHOLDER_PATTERNS.some(p => p.test(cleanedCheck)) || cleanedCheck.length < 30) {
        log(`claude: Response is placeholder-only ("${cleanedCheck.slice(0, 40)}") — treating as error`);
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.claude = Date.now() - provStart;
    log(`claude: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.claude}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: QWEN (通义千问)
// ══════════════════════════════════════════════════════════════════════════════

async function tryQwen(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying Qwen/通义千问 (priority 4) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'qwen');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('qwen: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Wait for SPA to fully render (Qwen is React-based, needs time)
    await page.waitForTimeout(3000);

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d)) || url.includes('/login')) {
        log('qwen: Not authenticated.');
        return { success: false, reason: 'auth' };
    }

    // Quota check
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    for (const pattern of cfg.quotaPatterns) {
        if (pattern.test(bodyText)) {
            log(`qwen: Quota pattern matched: "${bodyText.match(pattern)?.[0]}"`);
            return { success: false, reason: 'quota' };
        }
    }

    // Find editor — Qwen uses contenteditable div with role="textbox" (Tailwind)
    const editorSelectors = [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        '[class*="editor"]',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
                const editable = await loc.evaluate(el => {
                    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
                    return el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly');
                }).catch(() => true);
                if (editable) {
                    editorLocator = loc;
                    break;
                }
            }
        } catch (_) { }
    }

    if (!editorLocator) {
        log('qwen: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('qwen: Editor found, typing...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    // Clear any existing text
    try { await editorLocator.fill(''); } catch {
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(100);

    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(500);

    // ── Send: Qwen uses Enter key in contenteditable div ──
    // Qwen's buttons all have Tailwind generic classes — no "send"/"submit" identifiers.
    // Enter is the only reliable send mechanism.
    log('qwen: sending via Enter...');
    await page.keyboard.press('Enter');
    await page.waitForTimeout(2000);

    // ── Wait for response ──
    log('qwen: waiting for response...');
    const startTime = Date.now();

    // First, wait for the loading/thinking indicator to appear (confirms generation started)
    try {
        const loadingIndicator = page.locator('[class*="loading"][class*="navigator"], [class*="stop-generat"]').first();
        await loadingIndicator.waitFor({ state: 'attached', timeout: 15000 });
        log('qwen: generation started (loading indicator detected)');
    } catch {
        log('qwen: loading indicator not detected, proceeding anyway...');
    }

    // Qwen actual response selectors (verified 2026-07-01):
    //   message-select-wrapper-answer-rqWekn — the answer wrapper
    //   chat-answers-card-wrap — the answer card container
    //   message-select-content-inner-QCE5NQ — inner content area
    const responseSelectors = [
        '[class*="message-select-wrapper-answer"]',
        '[class*="chat-answers-card-wrap"]',
        '[class*="message-select-content-inner"]',
        '[class*="message-select-content"]',
        '.chat-round.last-message-item',
    ];

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: 60000 });
            // Verify it actually contains meaningful text (not just the skeleton)
            const txt = await loc.evaluate(el => (el.innerText || el.textContent || '').trim()).catch(() => '');
            if (txt.length > 10) {
                responseEl = loc;
                log(`qwen: Response element matched via "${sel}"`);
                break;
            }
        } catch (_) { }
    }

    if (!responseEl) {
        // Fallback: try extracting all new text from chat room
        log('qwen: No response element via selectors; trying chat-room text extraction...');
        try {
            const chatRoom = page.locator('[class*="chatRoom"], [class*="chat-room"]').first();
            responseEl = chatRoom;
            await chatRoom.waitFor({ state: 'attached', timeout: 10000 });
        } catch {
            log('qwen: Chat room not found either.');
            return { success: false, reason: 'error' };
        }
    }

    // ── Stability check ──
    // Wait for the "stop generating" button to disappear (indicates generation finished)
    try {
        const stopBtn = page.locator('[class*="stop"], [class*="pause-generat"]').first();
        await stopBtn.waitFor({ state: 'detached', timeout: Math.min(timeoutMs, 300000) });
        log('qwen: generation finished (stop button detached)');
    } catch { /* stop button may never appear for short responses */ }

    // Poll for text stability
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const STABILITY_WINDOW = 8_000;
    const DEADLINE = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < STABILITY_WINDOW && Date.now() < DEADLINE) {
        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else {
                spinner('.');
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    if (!response || response.length < 5) {
        log(`qwen: empty or too-short response (${response?.length || 0} chars).`);
        return { success: false, reason: 'error' };
    }

    // Strip model-name prefix if present (e.g., "Qwen3.7-Max\n")
    const cleaned = response.replace(/^Qwen[\d.]+-(?:Max|Plus|Turbo|Flash)\s*\n?\s*/i, '').trim();

    ctx.telemetry.per_provider_ms.qwen = Date.now() - provStart;
    log(`qwen: SUCCESS — ${cleaned.length} chars in ${ctx.telemetry.per_provider_ms.qwen}ms`);
    return { success: true, response: cleaned };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: KIMI (月之暗面 Moonshot)
// ══════════════════════════════════════════════════════════════════════════════

async function tryKimi(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying Kimi/月之暗面 (priority 5) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'kimi');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('kimi: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Wait for SPA to fully render (Kimi is React-based, redirects to www.kimi.com)
    await page.waitForTimeout(4000);

    // Start a fresh chat to avoid stale DOM from previous conversations
    // (otherwise pre-existing assistant elements break response detection)
    try {
        // Use evaluate for reliability — Playwright isVisible() can be flaky for sidebar elements
        const clicked = await page.evaluate(() => {
            let btn = document.querySelector('.new-chat-btn');
            if (!btn) {
                // Fallback: find link containing "新建会话"
                const links = document.querySelectorAll('a, div[class*="new-chat"], div[class*="sidebar-new"]');
                for (const el of links) {
                    if ((el.textContent || '').includes('新建会话')) { btn = el; break; }
                }
            }
            if (btn) { btn.click(); return true; }
            return false;
        });
        if (clicked) {
            log('kimi: Started new conversation.');
            await page.waitForTimeout(2500);
        }
    } catch (_) {
        // Non-critical: if new-chat fails, we still proceed with the fallback detection logic
    }

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d)) || url.includes('/login')) {
        log('kimi: Not authenticated.');
        return { success: false, reason: 'auth' };
    }

    // Quota / rate-limit check
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    for (const pattern of cfg.quotaPatterns) {
        if (pattern.test(bodyText)) {
            log(`kimi: Quota/rate-limit pattern matched: "${bodyText.match(pattern)?.[0]}"`);
            return { success: false, reason: 'quota' };
        }
    }

    // Find editor — Kimi uses contenteditable div with role="textbox" (class: chat-input-editor)
    const editorSelectors = [
        '.chat-input-editor',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
                const editable = await loc.evaluate(el => {
                    return el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly');
                }).catch(() => true);
                if (editable) {
                    editorLocator = loc;
                    break;
                }
            }
        } catch (_) { }
    }

    if (!editorLocator) {
        log('kimi: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('kimi: Editor found, typing...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    // Clear
    try { await editorLocator.fill(''); } catch {
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(100);

    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(500);

    // Send — Kimi uses div.send-button-container (loses "disabled" class when text is entered)
    log('kimi: sending via send-button click...');
    try {
        const sendBtn = page.locator('.send-button-container').first();
        // Wait for button to become active after typing
        await page.waitForTimeout(800);
        // Verify button is enabled before clicking
        const isDisabled = await sendBtn.evaluate(el => el.className.includes('disabled')).catch(() => false);
        if (isDisabled) {
            log('kimi: Send button still disabled, trying Enter...');
            await page.keyboard.press('Enter');
        } else {
            await sendBtn.click();
            log('kimi: Send button clicked.');
        }
    } catch {
        log('kimi: Send button not found, trying Enter...');
        await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(2000);

    // Quick check: did we immediately get a rate-limit response?
    // Kimi's rate-limit appears in the response area within 2-3s of sending
    const quickCheck = await page.evaluate(() => {
        const el = document.querySelector('[class*="chat-content-item-assistant"], [class*="segment-content"]');
        return (el?.innerText || el?.textContent || '').trim();
    }).catch(() => '');
    if (quickCheck && /(?:累了|休息|高峰期|算力不足|聊的人太多)/i.test(quickCheck)) {
        log(`kimi: Rate-limited — "${quickCheck.substring(0, 60)}"`);
        return { success: false, reason: 'quota' };
    }

    // ── Wait for response ──
    log('kimi: waiting for response...');
    const startTime = Date.now();

    // Kimi response selectors (verified 2026-07-01):
    //   chat-content-item-assistant — the assistant message wrapper (MOST SPECIFIC)
    //   segment-content — the response text content
    const responseSelectors = [
        '[class*="chat-content-item-assistant"]',
        '[class*="segment-content"]',
        '[class*="chat-content-list"] [class*="assistant"]',
    ];

    // Snapshot assistant elements BEFORE sending: count + last element's text.
    // After send, Kimi either (a) creates a NEW assistant element, or
    // (b) reuses the existing one with updated text. Both cases handled.
    const oldCount = await page.locator('[class*="chat-content-item-assistant"]').count();
    const lastAssistant = page.locator('[class*="chat-content-item-assistant"]').last();
    const oldText = await lastAssistant.evaluate(el => (el.innerText || el.textContent || '').trim()).catch(() => '');
    // Treat Kimi's default greeting / very short pre-existing text as "no real content"
    // (new conversation always has exactly 1 short assistant greeting element)
    const isGreeting = oldCount === 1 && oldText.length < 30;
    const effectiveOldLen = isGreeting ? 0 : oldText.length;
    log(`kimi: ${oldCount} pre-existing assistant element(s), last text ${oldText.length} chars${isGreeting ? ' (greeting)' : ''}`);

    let responseEl = null;
    // Short serial timeouts — each selector gets 10s
    const PER_SEL_TIMEOUT = 10000;
    for (const sel of responseSelectors) {
        try {
            const deadline = Date.now() + PER_SEL_TIMEOUT;
            let matched = false;
            while (Date.now() < deadline) {
                const curCount = await page.locator(sel).count();
                const loc = page.locator(sel).last();
                const txt = await loc.evaluate(el => (el.innerText || el.textContent || '').trim()).catch(() => '');
                const isNewElement = curCount > oldCount;
                const textGrew = txt.length > effectiveOldLen;
                if (txt.length > 10 && (isNewElement || textGrew)) {
                    responseEl = loc;
                    log(`kimi: Response element matched via "${sel}" (${txt.length} chars, newEl=${isNewElement}, grew=${textGrew})`);
                    matched = true;
                    break;
                }
                await page.waitForTimeout(1500);
            }
            if (matched) break;
            log(`kimi:   selector "${sel}" timed out (${PER_SEL_TIMEOUT/1000}s)`);
        } catch (e) {
            log(`kimi:   selector "${sel}" FAILED: ${(e.message || String(e)).slice(0, 100)}`);
        }
    }

    if (!responseEl) {
        log('kimi: No response element found. Dumping debug info...');
        try {
            const url = page.url();
            log(`kimi:   current URL: ${url}`);
            const bodySnippet = await page.evaluate(() => (document.body?.innerText || '').slice(0, 300));
            log(`kimi:   body snippet: ${bodySnippet.replace(/\n/g, ' | ')}`);
        } catch (_) {}
        return { success: false, reason: 'error' };
    }

    // Kimi generates in BURSTS with pauses between sentences, plus a "search web"
    // pre-phase (搜索网页 → N 个结果 → then real answer). Three-layer defense:
    //   L1: UI signals — Kimi's stop/loading indicator still visible?
    //   L2: Text patterns — still showing search queries instead of real answer?
    //   L3: Adaptive window — short content gets longer patience (30s → 20s → 15s)
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const DEADLINE = startTime + timeoutMs;
    const MIN_CONTENT_DEADLINE = startTime + 60_000; // must stay ≥60s when content < 200 chars

    while (Date.now() < DEADLINE) {
        // Adaptive stability window: very short content = done in one burst
        const stabilityWindow = lastLen < 50   ?  5_000   // simple greeting, done
                              : lastLen < 150  ? 30_000   // still in search/thinking phase
                              : lastLen < 500  ? 20_000   // early generation
                              : lastLen < 1500 ? 15_000   // mid generation
                              :                   8_000;  // long content, likely near end

        if ((Date.now() - lastChangeTime) > stabilityWindow) break;

        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');

            // ── L1: UI signals ──
            const generating = await isStillGenerating(page);

            // ── L2: Text patterns — still just search queries? ──
            const preGen = looksLikePreGeneration(text);

            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else if (generating || preGen) {
                // AI is still working — keep waiting, don't count as idle
                lastChangeTime = Date.now();
                spinner(generating ? '⚙' : '…');
            } else {
                // Text is stable but maybe too early? Check against adaptive window
                const stableFor = Date.now() - lastChangeTime;
                if (stableFor < stabilityWindow) {
                    spinner('·');  // not yet past adaptive window, keep waiting
                } else {
                    spinner('.');
                }
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());

    // Shared three-layer validation
    const validation = validateResponseComplete(response);
    if (!validation.ok) {
        log(`kimi: response rejected — ${validation.reason} (${response?.length || 0} chars)`);
        return { success: false, reason: 'error' };
    }

    // Reject clearly truncated responses — Kimi occasionally stops mid-sentence
    // after just the opening line (e.g. "我来从...角度审查"). A proper review
    // should be at least 200 chars for any meaningful analysis.
    if (response.length < 80 && /^(我来|让我|我将|我会|下面|以下|首先)/.test(response)) {
        log(`kimi: Response appears truncated (${response.length} chars, starts with meta-planning) — treating as error`);
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.kimi = Date.now() - provStart;
    log(`kimi: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.kimi}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: MINIMAX
// ══════════════════════════════════════════════════════════════════════════════

async function tryMiniMax(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying MiniMax (priority 5) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'minimax');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('minimax: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Wait for JS-rendered editor (TipTap/ProseMirror mounts async)
    await page.waitForTimeout(4000);

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d)) || url.includes('/login')) {
        log('minimax: Not authenticated.');
        return { success: false, reason: 'auth' };
    }

    // Quota check
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    for (const pattern of cfg.quotaPatterns) {
        if (pattern.test(bodyText)) {
            log(`minimax: Quota pattern matched: "${bodyText.match(pattern)?.[0]}"`);
            return { success: false, reason: 'quota' };
        }
    }

    // Find editor (TipTap/ProseMirror-based rich text editor)
    const editorSelectors = [
        '[class*="ProseMirror"]',
        '[class*="tiptap"]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
        '[class*="editor"]',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
                const editable = await loc.evaluate(el => {
                    if (el.tagName === 'TEXTAREA') return !el.disabled && !el.readOnly;
                    return el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly');
                }).catch(() => true);
                if (editable) {
                    editorLocator = loc;
                    break;
                }
            }
        } catch (_) { }
    }

    if (!editorLocator) {
        log('minimax: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('minimax: Editor found, typing...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    try { await editorLocator.fill(''); } catch {
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(100);

    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(500);

    // Send — MiniMax uses a DIV[aria-label="发送消息"] (not a <button>)
    const sendSelectors = [
        '[aria-label="发送消息"]',
        '[class*="send"]',
        '[class*="submit"]',
    ];

    let sent = false;
    for (const sel of sendSelectors) {
        try {
            const btn = page.locator(sel).last();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click();
                sent = true;
                log('minimax: Sent via click.');
                break;
            }
        } catch (_) { }
    }
    if (!sent) {
        log('minimax: No send button, trying Enter...');
        await editorLocator.focus();
        await page.keyboard.press('Enter');
    }

    // ── Wait for response ──
    log('minimax: waiting for response...');
    const startTime = Date.now();

    // MiniMax response: div.matrix-markdown.message-content
    const responseSelectors = [
        '[class*="message-content"]',
        '[class*="matrix-markdown"]',
        '.markdown-body',
        '[class*="answer"]',
        '[class*="response"]',
    ];

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: 30000 });
            responseEl = loc;
            break;
        } catch (_) { }
    }

    if (!responseEl) {
        log('minimax: Response element not found.');
        return { success: false, reason: 'error' };
    }

    // Stability check
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const STABILITY_WINDOW = 10_000;
    const DEADLINE = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < STABILITY_WINDOW && Date.now() < DEADLINE) {
        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else {
                spinner('.');
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    if (!response || response.length < 5) {
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.minimax = Date.now() - provStart;
    log(`minimax: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.minimax}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: MIMO (Xiaomi MiMo Studio — MiMo-V2.5-Pro)
// ══════════════════════════════════════════════════════════════════════════════

async function tryMiMo(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying MiMo/Xiaomi (priority 6) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'mimo');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('mimo: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Wait for SPA to render (MiMo is React/Tailwind-based, auto-creates new chat at /#/c)
    await page.waitForTimeout(4000);

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d)) || url.includes('/login')) {
        log('mimo: Not authenticated.');
        return { success: false, reason: 'auth' };
    }

    // Quota / rate-limit check
    const bodyText = await page.evaluate(() => document.body?.innerText || '').catch(() => '');
    for (const pattern of cfg.quotaPatterns) {
        if (pattern.test(bodyText)) {
            log(`mimo: Quota pattern matched: "${bodyText.match(pattern)?.[0]}"`);
            return { success: false, reason: 'quota' };
        }
    }

    // Find editor — MiMo uses a textarea (Tailwind-styled, no id/name)
    // placeholder="有问题，尽管问，Shift + Enter 换行"
    const editorSelectors = [
        'textarea[placeholder*="有问题，尽管问"]',
        'textarea[placeholder*="Shift + Enter"]',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
                editorLocator = loc;
                break;
            }
        } catch (_) { }
    }

    if (!editorLocator) {
        log('mimo: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('mimo: Editor found, typing...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    // Clear
    await editorLocator.fill('');
    await page.waitForTimeout(100);

    // Type prompt — prefer clipboard paste for performance
    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(800);

    // Send — click the send button (paper-plane icon, second button in input container)
    // The send button has rounded-full class and becomes enabled after text is typed
    let sent = false;
    try {
        // Find the input container, then find the button with SVG paper-plane icon
        const sendBtn = page.locator('textarea[placeholder*="有问题，尽管问"]')
            .locator('..')  // parent
            .locator('..')  // grandparent (rounded-xl input container)
            .locator('button:not([disabled])')
            .filter({ has: page.locator('svg') })
            .last();
        if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await sendBtn.click();
            sent = true;
            log('mimo: Sent via send button click.');
        }
    } catch (_) { }

    if (!sent) {
        // Fallback: press Enter (Shift+Enter is for newlines, so Enter should send)
        log('mimo: Send button not found, trying Enter...');
        await page.keyboard.press('Enter');
    }

    // ── Wait for response ──
    log('mimo: waiting for response...');
    const startTime = Date.now();

    // After sending, URL changes from /#/c to /#/chat/[hash]
    // Wait for the markdown response area to appear
    const responseSelectors = [
        '.markdown-prose',
        '.Markdown_markdown__',
        '[class*="markdown"]',
    ];

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: Math.min(30000, timeoutMs) });
            // Verify it has actual content (not just empty markdown container)
            const text = await loc.evaluate(el => el.innerText || el.textContent || '').catch(() => '');
            if (text.length > 10) {
                responseEl = loc;
                break;
            }
        } catch (_) { }
    }

    if (!responseEl) {
        log('mimo: No response element appeared.');
        return { success: false, reason: 'timeout' };
    }

    // MiMo shows "已深度思考（用时 X 秒）" — wait for this phase + response stability
    // No explicit stop button found; rely on text stability
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const DEADLINE = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < 15_000 && Date.now() < DEADLINE) {
        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else {
                spinner('.');
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    if (!response || response.length < 5) {
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.mimo = Date.now() - provStart;
    log(`mimo: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.mimo}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: DEEPSEEK
// ══════════════════════════════════════════════════════════════════════════════

async function tryDeepSeek(page, prompt, timeoutMs, ctx) {
    const provStart = Date.now();
    log('━━━ Trying DeepSeek (priority 7) ━━━');

    const cfg = PROVIDER_CHAIN.find(p => p.key === 'deepseek');

    try {
        await page.goto(cfg.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    } catch {
        log('deepseek: Page load failed.');
        return { success: false, reason: 'error' };
    }

    // Wait for SPA to render
    await page.waitForTimeout(3000);

    // Auth check
    const url = page.url();
    if (cfg.authDomains.some(d => url.includes(d)) || url.includes('/login')) {
        log('deepseek: Not authenticated.');
        return { success: false, reason: 'auth' };
    }

    // Find editor — DeepSeek uses a textarea with placeholder
    const editorSelectors = [
        'textarea[placeholder*="给 DeepSeek 发送消息"]',
        'textarea[placeholder*="DeepSeek"]',
    ];

    let editorLocator = null;
    for (const sel of editorSelectors) {
        try {
            const loc = page.locator(sel).first();
            if (await loc.isVisible({ timeout: 3000 }).catch(() => false)) {
                editorLocator = loc;
                break;
            }
        } catch (_) { }
    }

    if (!editorLocator) {
        log('deepseek: No editable input found.');
        return { success: false, reason: 'error' };
    }

    log('deepseek: Editor found, typing...');
    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    // Clear
    await editorLocator.fill('');
    await page.waitForTimeout(100);

    // Type prompt — prefer clipboard paste for performance
    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(500);

    // Send — click the primary filled circle send button
    let sent = false;
    try {
        // The send button is inside the input container, identified by ds-button--primary.ds-button--filled.ds-button--circle
        const sendBtn = page.locator('.ds-button--primary.ds-button--filled.ds-button--circle').first();
        if (await sendBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
            await sendBtn.click();
            sent = true;
            log('deepseek: Sent via send button click.');
        }
    } catch (_) { }

    if (!sent) {
        log('deepseek: Send button not found, trying Enter...');
        await page.keyboard.press('Enter');
    }

    // ── Wait for response ──
    log('deepseek: waiting for response...');
    const startTime = Date.now();

    // DeepSeek shows "已思考（用时 X 秒）" then the final answer
    // Response appears in div.ds-markdown inside assistant message
    const responseSelectors = [
        '.ds-markdown',
        '.ds-assistant-message-main-content',
        '[class*="ds-markdown"]',
    ];

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: Math.min(60000, timeoutMs) });
            const text = await loc.evaluate(el => el.innerText || el.textContent || '').catch(() => '');
            if (text.length > 10) {
                responseEl = loc;
                break;
            }
        } catch (_) { }
    }

    if (!responseEl) {
        log('deepseek: No response element appeared.');
        return { success: false, reason: 'timeout' };
    }

    // Stability check — DeepSeek may show thinking first, then final answer
    let lastLen = 0;
    let lastChangeTime = Date.now();
    const DEADLINE = startTime + timeoutMs;

    while ((Date.now() - lastChangeTime) < 12_000 && Date.now() < DEADLINE) {
        await page.waitForTimeout(POLL_INTERVAL);
        try {
            const text = await responseEl.evaluate(el => el.innerText || el.textContent || '');
            if (text.length > lastLen) {
                lastLen = text.length;
                lastChangeTime = Date.now();
                spinner('+');
            } else {
                spinner('.');
            }
        } catch { spinner('?'); }
    }
    process.stderr.write('\n');

    const response = await responseEl.evaluate(el => (el.innerText || el.textContent || '').trim());
    if (!response || response.length < 5) {
        return { success: false, reason: 'error' };
    }

    ctx.telemetry.per_provider_ms.deepseek = Date.now() - provStart;
    log(`deepseek: SUCCESS — ${response.length} chars in ${ctx.telemetry.per_provider_ms.deepseek}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// FALLBACK ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * tryAllProviders — iterate through the provider chain, return first success.
 *
 * @param {Browser} browser - CDP browser connection
 * @param {string} prompt - The prompt to send
 * @param {InvocationContext} ctx - Per-invocation context (circuit breaker + telemetry)
 * @param {object} options - { totalTimeout, providerTimeout, startFrom }
 * @returns {{success: true, response: string, provider: string}} | {{success: false, reasons: object}}
 */
async function tryAllProviders(browser, prompt, ctx, options = {}) {
    // POLICY: Never close the user's Chrome browser. We are a guest in their session.
    // Only manage our own tabs — page.close() for cleanup, but NEVER browser.close().
    const { keepTabs = true } = options;
    const totalTimeout = options.totalTimeout || DEFAULT_TOTAL_TIMEOUT;
    const providerTimeout = options.providerTimeout || Math.min(DEFAULT_PROVIDER_TIMEOUT, Math.floor(totalTimeout / 2));
    const overallStart = Date.now();

    // Determine starting index
    let startIdx = 0;
    if (options.startFrom) {
        const searchName = options.startFrom.toLowerCase();
        startIdx = PROVIDER_CHAIN.findIndex(p =>
            p.key.includes(searchName) || p.name.toLowerCase().includes(searchName)
        );
        if (startIdx === -1) {
            log(`WARN: Provider "${options.startFrom}" not found in chain. Starting from beginning.`);
            startIdx = 0;
        } else {
            log(`Starting from provider index ${startIdx} ("${PROVIDER_CHAIN[startIdx].name}")`);
        }
    }

    const context = browser.contexts()[0];
    if (!context) throw new Error('No active browser context.');

    const fallbackReasons = {};
    const triedProviders = [];

    for (let i = startIdx; i < PROVIDER_CHAIN.length; i++) {
        const provider = PROVIDER_CHAIN[i];
        const elapsed = Date.now() - overallStart;
        const remainingTotal = totalTimeout - elapsed;

        if (remainingTotal < 15000) {
            log(`Total timeout approaching — ${remainingTotal}ms left. Stopping chain.`);
            fallbackReasons[provider.key] = { reason: 'total_timeout' };
            triedProviders.push(provider.key);
            break;
        }

        const perProvTimeout = Math.min(providerTimeout, remainingTotal);

        // Circuit breaker: skip providers that have repeatedly failed
        if (ctx.circuitIsBroken(provider.key)) {
            const s = ctx.circuitState[provider.key];
            const remainingCooldown = Math.ceil((s.brokenUntil - Date.now()) / 1000);
            log(`\n▶ Provider ${i + 1}/${PROVIDER_CHAIN.length}: ${provider.name} — CIRCUIT BROKEN (${remainingCooldown}s cooldown remaining)`);
            fallbackReasons[provider.key] = { reason: 'circuit_broken' };
            triedProviders.push(provider.key);
            continue;
        }

        log(`\n▶ Provider ${i + 1}/${PROVIDER_CHAIN.length}: ${provider.name} (${Math.round(perProvTimeout / 1000)}s budget)`);
        startTimer(`${provider.name}`);

        let page;
        let result;
        try {
            // Create dedicated page for this provider
            page = await context.newPage();

            // Grant clipboard permissions
            try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (_) { }

            // Dispatch to provider handler (each receives ctx for telemetry tracking)
            switch (provider.key) {
                case 'gemini':
                    result = await tryGemini(page, prompt, perProvTimeout, ctx);
                    break;
                case 'chatgpt':
                    result = await tryChatGPT(page, prompt, perProvTimeout, ctx);
                    break;
                case 'claude':
                    result = await tryClaude(page, prompt, perProvTimeout, ctx);
                    break;
                case 'qwen':
                    result = await tryQwen(page, prompt, perProvTimeout, ctx);
                    break;
                case 'kimi':
                    result = await tryKimi(page, prompt, perProvTimeout, ctx);
                    break;
                case 'minimax':
                    result = await tryMiniMax(page, prompt, perProvTimeout, ctx);
                    break;
                case 'mimo':
                    result = await tryMiMo(page, prompt, perProvTimeout, ctx);
                    break;
                case 'deepseek':
                    result = await tryDeepSeek(page, prompt, perProvTimeout, ctx);
                    break;
                default:
                    result = classifyError(
                        new Error(`Unknown provider: ${provider.key}`),
                        'navigate', provider.key
                    );
            }
        } catch (err) {
            const pe = new ProviderError(err, { stage: 'unknown', provider: provider.key });
            log(`${provider.name}: ${pe.originalName} — ${pe.message}`);
            result = pe.toResult();
        } finally {
            stopTimer();
        }

        triedProviders.push(provider.key);
        if (!result.success) {
            // Close failed provider's tab — useless clutter regardless of --keep-tabs
            if (page && !page.isClosed()) {
                try { await page.close(); } catch (_) { }
            }
            ctx.circuitRecordFailure(provider.key);
            fallbackReasons[provider.key] = {
                reason: result.reason || 'error',
                error_details: result.error_details || null,
            };
            log(`✗ ${provider.name}: FAILED — ${result.reason} → falling to next provider`);
            continue;
        }

        // SUCCESS: keep or close tab based on --keep-tabs flag
        if (page && !page.isClosed() && !options.keepTabs) {
            try { await page.close(); } catch (_) { }
        }

        // SUCCESS!
        ctx.circuitRecordSuccess(provider.key);
        ctx.telemetry.provider_used = provider.name;
        ctx.telemetry.providers_tried = triedProviders;
        ctx.telemetry.fallback_reasons = fallbackReasons;
        ctx.telemetry.total_ms = Date.now() - overallStart;

        log(`\n✓ ${provider.name}: USED (${result.response.length} chars, ${ctx.telemetry.total_ms}ms total)`);
        if (triedProviders.length > 1) {
            log(`  Fallback chain: ${triedProviders.join(' → ')} (${triedProviders.length - 1} provider(s) skipped)`);
        }
        return { success: true, response: result.response, provider: provider.name };
    }

    // All providers exhausted
    ctx.telemetry.providers_tried = triedProviders;
    ctx.telemetry.fallback_reasons = fallbackReasons;
    ctx.telemetry.total_ms = Date.now() - overallStart;

    log(`\n✗ All ${triedProviders.length} provider(s) exhausted.`);
    log(`  Reasons: ${JSON.stringify(fallbackReasons)}`);

    // If the first 2+ providers failed with page-load/auth errors,
    // the proxy or network is likely the root cause, not the providers.
    const pageFailCount = Object.values(fallbackReasons).filter(r =>
        String(r.reason).includes('error') || String(r.reason).includes('auth')
    ).length;
    if (pageFailCount >= 2) {
        log('  ⚠  Multiple providers failed with page/auth errors.');
        log('  ⚠  This may indicate a proxy/network issue — check PROXY_SERVER in .env');
    }

    return { success: false, reasons: fallbackReasons };
}

// ══════════════════════════════════════════════════════════════════════════════
// SMOKE TEST — verify at least one provider is reachable
// ══════════════════════════════════════════════════════════════════════════════

async function smokeTest(browser) {
    log('Running smoke test — checking provider reachability...');
    const context = browser.contexts()[0];

    for (const provider of PROVIDER_CHAIN) {
        let page;
        try {
            page = await context.newPage();
            await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            const url = page.url();

            const isAuth = provider.authDomains.some(d => url.includes(d));
            if (isAuth) {
                log(`  ${provider.name}: REACHABLE but needs login (${url.substring(0, 60)})`);
            } else {
                log(`  ${provider.name}: ✅ REACHABLE (${url.substring(0, 60)})`);
            }
        } catch (err) {
            log(`  ${provider.name}: ❌ UNREACHABLE — ${err.message}`);
        } finally {
            if (page && !page.isClosed()) {
                try { await page.close(); } catch (_) { }
            }
        }
    }

    log('Smoke test complete. Check output above for provider status.');
}

// ══════════════════════════════════════════════════════════════════════════════
// DOCTOR — CDP connectivity check only
// ══════════════════════════════════════════════════════════════════════════════

async function doctorCheck() {
    log('Running CDP connectivity check (--doctor)...');
    try {
        const res = await new Promise((resolve, reject) => {
            http.get(CDP_URL + '/json/version', (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({ ok: true, data }));
            }).on('error', reject);
        });
        log(`Chrome CDP reachable: ${res.data.substring(0, 120)}`);
        process.exit(0);
    } catch (e) {
        log('Chrome CDP is NOT reachable on ' + CDP_URL);
        log('Run: bash scripts/start-chrome-debug.sh');
        process.exit(1);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    const ctx = new InvocationContext(); // P0-2: per-invocation state isolation

    // --doctor
    if (args.includes('--doctor')) {
        return doctorCheck();
    }

    // Parse flags
    let customTimeout = DEFAULT_TOTAL_TIMEOUT;
    let customProvTimeout = null;
    let startFrom = null;
    let keepTabs = true; // Always keep tabs — never close user's browser

    const remaining = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--smoke' || a === '--doctor') {
            remaining.push(a); // keep flag
        } else if (a.startsWith('--timeout=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) customTimeout = v;
        } else if (a.startsWith('--timeout-per-provider=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) customProvTimeout = v;
        } else if (a === '--keep-tabs') {
            keepTabs = true;
        } else if (a.startsWith('--from=')) {
            startFrom = a.split('=')[1];
        } else if (!a.startsWith('--')) {
            remaining.push(a);
        }
    }

    // Read prompt
    let prompt = remaining.join(' ').trim();
    if (!prompt && !args.includes('--smoke')) {
        // Try stdin
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        prompt = chunks.join('').trim();
    }
    if (!prompt && !args.includes('--smoke')) {
        console.error('Usage: node index.js [--timeout=N] [--from=NAME] [--keep-tabs] [--smoke] [--doctor] "Your prompt"');
        console.error('       echo "prompt" | node index.js [flags]');
        process.exit(1);
    }

    ctx.telemetry.prompt_length_chars = prompt.length;

    // Connect to Chrome
    let browser;
    try {
        browser = await connectWithRetry(CDP_URL);
    } catch (err) {
        log(`FATAL: Cannot connect to Chrome CDP — ${err.message}`);
        log('Ensure Chrome debug is running: bash ~/start-chrome-debug.sh');
        ctx.recordTelemetry(1);
        process.exit(1);
    }

    try {
        // --smoke
        if (args.includes('--smoke')) {
            await smokeTest(browser);
            process.exit(0);
        }

        // Run fallback chain (ctx carries isolated state through the chain)
        const result = await tryAllProviders(browser, prompt, ctx, {
            totalTimeout: customTimeout,
            providerTimeout: customProvTimeout,
            startFrom,
            keepTabs,
        });

        if (result.success) {
            console.log(result.response); // stdout for piping
            ctx.recordTelemetry(0);
            process.exit(0);
        }

        // Classify failure — reasons are now objects {reason, error_details}
        const reasonValues = Object.values(result.reasons).map(r =>
            typeof r === 'string' ? r : (r.reason || '')
        );
        const allAuth = reasonValues.every(r => r.includes('auth') || r.includes('AUTH'));
        const allQuota = reasonValues.every(r => r.includes('quota') || r.includes('QUOTA') || r.includes('rate') || r.includes('RATE'));
        const hasSafety = reasonValues.some(r => r.includes('safety') || r.includes('SAFETY'));

        if (allAuth) {
            log('All providers require authentication. Log into at least one service in Chrome.');
            ctx.recordTelemetry(2);
            process.exit(2);
        }
        if (allQuota) {
            log('All providers are rate-limited. Wait and retry later.');
            ctx.recordTelemetry(5);
            process.exit(5);
        }
        if (hasSafety) {
            ctx.recordTelemetry(3);
            process.exit(3);
        }
        ctx.recordTelemetry(9);
        process.exit(9);

    } catch (err) {
        log(`FATAL: ${err.message}`);
        ctx.recordTelemetry(4);
        process.exit(4);
    } finally {
        stopTimer();
        // POLICY: NEVER call browser.close() — this is a CDP guest session.
        // Closing the browser destroys ALL the user's tabs, not just ours.
    }
}

if (require.main === module) {
    main().catch(e => {
        process.stderr.write(`[fallback] unhandled: ${e.message}\n`);
        process.exit(4);
    });
}

module.exports = { PROVIDER_CHAIN };
