#!/usr/bin/env node
/**
 * AI Fallback Chain — Multi-Provider CDP Bridge
 *
 * Priority chain: Gemini (Pro Extended) → ChatGPT → Claude → Qwen → Kimi → MiniMax
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

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const CDP_URL = 'http://127.0.0.1:9222';
const DEFAULT_TOTAL_TIMEOUT = 600_000; // 10 min total across all providers
const DEFAULT_PROVIDER_TIMEOUT = 180_000; // 3 min per provider
const POLL_INTERVAL = 2_000; // ms between response stability checks
const INSERT_TEXT_LIMIT = 50_000; // ~50KB safe CDP WebSocket payload
const SKILL_DIR = path.dirname(__filename); // skill directory for telemetry

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
];

// ══════════════════════════════════════════════════════════════════════════════
// TELEMETRY
// ══════════════════════════════════════════════════════════════════════════════

const telemetry = {
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

function recordTelemetry(code) {
    telemetry.exit_code = code;
    const f = path.join(SKILL_DIR, 'fallback-telemetry.jsonl');
    fs.appendFileSync(f, JSON.stringify(telemetry) + '\n');
}

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

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: GEMINI (Pro Extended Thinking)
// ══════════════════════════════════════════════════════════════════════════════

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
        log('gemini: Action toolbar not detected, falling back to stability check...');
        let lastLen = 0;
        let lastChangeTime = Date.now();
        const STABILITY_WINDOW = 15_000;

        while ((Date.now() - lastChangeTime) < STABILITY_WINDOW) {
            if ((Date.now() - startTime) > timeoutMs) break;
            await page.waitForTimeout(POLL_INTERVAL);
            try {
                const currentText = await responseLocator.last().evaluate(el => el.innerText || el.textContent || '');
                if (currentText.length > lastLen) {
                    lastLen = currentText.length;
                    lastChangeTime = Date.now();
                    spinner('+');
                } else {
                    spinner('s');
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
    return finalContent;
}

async function tryGemini(page, prompt, timeoutMs) {
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
    const genStart = Date.now();
    const stopBtn = page.locator('button[aria-label*="停止"], button[aria-label*="Stop"]').first();
    try {
        await stopBtn.waitFor({ state: 'visible', timeout: 15000 });
        log('gemini: generation started');
        const remainingForGen = Math.max(10000, timeoutMs - (Date.now() - provStart));
        await stopBtn.waitFor({ state: 'hidden', timeout: remainingForGen });
        log('gemini: generation finished');
    } catch {
        log('gemini: No prolonged generation phase (instant/cached response).');
    }

    // ── Collect response ──
    const remainingForResp = Math.max(30000, timeoutMs - (Date.now() - provStart));
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

    telemetry.per_provider_ms.gemini = Date.now() - provStart;
    log(`gemini: SUCCESS — ${response.length} chars in ${telemetry.per_provider_ms.gemini}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: CHATGPT
// ══════════════════════════════════════════════════════════════════════════════

async function tryChatGPT(page, prompt, timeoutMs) {
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

    log('chatgpt: Editor found, typing prompt...');

    await editorLocator.focus();
    await editorLocator.click();
    await page.waitForTimeout(200);

    // Clear and type
    try { await editorLocator.fill(''); } catch {
        await page.keyboard.press('ControlOrMeta+a');
        await page.keyboard.press('Backspace');
    }
    await page.waitForTimeout(100);

    if (prompt.length > INSERT_TEXT_LIMIT) {
        try { await page.evaluate(t => navigator.clipboard.writeText(t), prompt); } catch (_) { }
        await page.keyboard.press('ControlOrMeta+v');
    } else {
        // ChatGPT uses a contenteditable div — type character by character
        // but keyboard.insertText is faster and usually works
        await page.keyboard.insertText(prompt);
    }
    await page.waitForTimeout(500);

    // Send — ChatGPT uses Enter or a send button
    const sendSelectors = [
        'button[data-testid="send-button"]',
        'button[aria-label="Send prompt"]',
        'button[aria-label="Send"]',
        'button svg', // fallback
    ];

    let sent = false;
    for (const sel of sendSelectors) {
        try {
            const btn = page.locator(sel).first();
            if (await btn.isVisible({ timeout: 2000 }).catch(() => false)) {
                await btn.click();
                sent = true;
                log('chatgpt: Sent via button click.');
                break;
            }
        } catch (_) { }
    }
    if (!sent) {
        log('chatgpt: No send button, trying Enter...');
        await editorLocator.focus();
        await page.keyboard.press('Enter');
    }

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

    telemetry.per_provider_ms.chatgpt = Date.now() - provStart;
    log(`chatgpt: SUCCESS — ${response.length} chars in ${telemetry.per_provider_ms.chatgpt}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: CLAUDE
// ══════════════════════════════════════════════════════════════════════════════

async function tryClaude(page, prompt, timeoutMs) {
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

    telemetry.per_provider_ms.claude = Date.now() - provStart;
    log(`claude: SUCCESS — ${response.length} chars in ${telemetry.per_provider_ms.claude}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: QWEN (通义千问)
// ══════════════════════════════════════════════════════════════════════════════

async function tryQwen(page, prompt, timeoutMs) {
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

    telemetry.per_provider_ms.qwen = Date.now() - provStart;
    log(`qwen: SUCCESS — ${cleaned.length} chars in ${telemetry.per_provider_ms.qwen}ms`);
    return { success: true, response: cleaned };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: KIMI (月之暗面 Moonshot)
// ══════════════════════════════════════════════════════════════════════════════

async function tryKimi(page, prompt, timeoutMs) {
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

    let responseEl = null;
    for (const sel of responseSelectors) {
        try {
            const loc = page.locator(sel).last();
            await loc.waitFor({ state: 'attached', timeout: 60000 });
            const txt = await loc.evaluate(el => (el.innerText || el.textContent || '').trim()).catch(() => '');
            if (txt.length > 10) {
                responseEl = loc;
                log(`kimi: Response element matched via "${sel}"`);
                break;
            }
        } catch (_) { }
    }

    if (!responseEl) {
        log('kimi: No response element found.');
        return { success: false, reason: 'error' };
    }

    // Stability check
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
        log(`kimi: empty or too-short response (${response?.length || 0} chars).`);
        return { success: false, reason: 'error' };
    }

    telemetry.per_provider_ms.kimi = Date.now() - provStart;
    log(`kimi: SUCCESS — ${response.length} chars in ${telemetry.per_provider_ms.kimi}ms`);
    return { success: true, response };
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER: MINIMAX
// ══════════════════════════════════════════════════════════════════════════════

async function tryMiniMax(page, prompt, timeoutMs) {
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
        log('minimax: No send button, trying Ctrl+Enter...');
        await editorLocator.focus();
        await page.keyboard.press('ControlOrMeta+Enter');
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

    telemetry.per_provider_ms.minimax = Date.now() - provStart;
    log(`minimax: SUCCESS — ${response.length} chars in ${telemetry.per_provider_ms.minimax}ms`);
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
 * @param {object} options - { totalTimeout, providerTimeout, startFrom }
 * @returns {{success: true, response: string, provider: string}} | {{success: false, reasons: object}}
 */
async function tryAllProviders(browser, prompt, options = {}) {
    const { closeBrowser = false } = options;
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
            fallbackReasons[provider.key] = 'total_timeout';
            triedProviders.push(provider.key);
            break;
        }

        const perProvTimeout = Math.min(providerTimeout, remainingTotal);

        log(`\n▶ Provider ${i + 1}/${PROVIDER_CHAIN.length}: ${provider.name} (${Math.round(perProvTimeout / 1000)}s budget)`);
        startTimer(`${provider.name}`);

        let page;
        let result;
        try {
            // Create dedicated page for this provider
            page = await context.newPage();

            // Grant clipboard permissions
            try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (_) { }

            // Dispatch to provider handler
            switch (provider.key) {
                case 'gemini':
                    result = await tryGemini(page, prompt, perProvTimeout);
                    break;
                case 'chatgpt':
                    result = await tryChatGPT(page, prompt, perProvTimeout);
                    break;
                case 'claude':
                    result = await tryClaude(page, prompt, perProvTimeout);
                    break;
                case 'qwen':
                    result = await tryQwen(page, prompt, perProvTimeout);
                    break;
                case 'kimi':
                    result = await tryKimi(page, prompt, perProvTimeout);
                    break;
                case 'minimax':
                    result = await tryMiniMax(page, prompt, perProvTimeout);
                    break;
                default:
                    result = { success: false, reason: 'error' };
            }
        } catch (err) {
            log(`${provider.name}: Exception — ${err.message}`);
            result = { success: false, reason: 'error' };
        } finally {
            stopTimer();
            // Close this provider's tab — only on failure, or if --close set
            if (page && !page.isClosed()) {
                if (closeBrowser || !result || !result.success) {
                    try { await page.close(); } catch (_) { }
                }
            }
        }

        triedProviders.push(provider.key);
        if (!result.success) {
            fallbackReasons[provider.key] = `ERR_${result.reason.toUpperCase()}`;
            log(`✗ ${provider.name}: FAILED — ${result.reason} → falling to next provider`);
            continue;
        }

        // SUCCESS!
        telemetry.provider_used = provider.name;
        telemetry.providers_tried = triedProviders;
        telemetry.fallback_reasons = fallbackReasons;
        telemetry.total_ms = Date.now() - overallStart;

        log(`\n✓ ${provider.name}: USED (${result.response.length} chars, ${telemetry.total_ms}ms total)`);
        if (triedProviders.length > 1) {
            log(`  Fallback chain: ${triedProviders.join(' → ')} (${triedProviders.length - 1} provider(s) skipped)`);
        }
        return { success: true, response: result.response, provider: provider.name };
    }

    // All providers exhausted
    telemetry.providers_tried = triedProviders;
    telemetry.fallback_reasons = fallbackReasons;
    telemetry.total_ms = Date.now() - overallStart;

    log(`\n✗ All ${triedProviders.length} provider(s) exhausted.`);
    log(`  Reasons: ${JSON.stringify(fallbackReasons)}`);

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
        log('Run: bash ~/start-chrome-debug.sh');
        process.exit(1);
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);

    // --doctor
    if (args.includes('--doctor')) {
        return doctorCheck();
    }

    // Parse flags
    let customTimeout = DEFAULT_TOTAL_TIMEOUT;
    let customProvTimeout = null;
    let startFrom = null;
    let closeBrowser = false;

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
        } else if (a === '--close' || a === '--close-browser') {
            closeBrowser = true;
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
        console.error('Usage: node index.js [--timeout=N] [--from=NAME] [--smoke] [--doctor] "Your prompt"');
        console.error('       echo "prompt" | node index.js [flags]');
        process.exit(1);
    }

    telemetry.prompt_length_chars = prompt.length;

    // Connect to Chrome
    let browser;
    try {
        browser = await connectWithRetry(CDP_URL);
    } catch (err) {
        log(`FATAL: Cannot connect to Chrome CDP — ${err.message}`);
        log('Ensure Chrome debug is running: bash ~/start-chrome-debug.sh');
        recordTelemetry(1);
        process.exit(1);
    }

    try {
        // --smoke
        if (args.includes('--smoke')) {
            await smokeTest(browser);
            process.exit(0);
        }

        // Run fallback chain
        const result = await tryAllProviders(browser, prompt, {
            totalTimeout: customTimeout,
            providerTimeout: customProvTimeout,
            startFrom,
            closeBrowser,
        });

        if (result.success) {
            console.log(result.response); // stdout for piping
            recordTelemetry(0);
            process.exit(0);
        }

        // Classify failure
        const reasons = Object.values(result.reasons);
        const allAuth = reasons.every(r => r.includes('AUTH'));
        const allQuota = reasons.every(r => r.includes('QUOTA') || r.includes('RATE'));
        const hasSafety = reasons.some(r => r.includes('SAFETY'));

        if (allAuth) {
            log('All providers require authentication. Log into at least one service in Chrome.');
            recordTelemetry(2);
            process.exit(2);
        }
        if (allQuota) {
            log('All providers are rate-limited. Wait and retry later.');
            recordTelemetry(5);
            process.exit(5);
        }
        if (hasSafety) {
            recordTelemetry(3);
            process.exit(3);
        }
        recordTelemetry(9);
        process.exit(9);

    } catch (err) {
        log(`FATAL: ${err.message}`);
        recordTelemetry(4);
        process.exit(4);
    } finally {
        stopTimer();
        if (browser && closeBrowser) {
            try { await browser.close(); } catch (_) { }
        } else if (browser) {
            log('Browser kept open (use --close to auto-close)');
        }
    }
}

main().catch(e => {
    process.stderr.write(`[fallback] unhandled: ${e.message}\n`);
    process.exit(4);
});
