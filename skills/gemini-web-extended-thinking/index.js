#!/usr/bin/env node
/**
 * Gemini Web Extended Thinking — Playwright/CDP bridge.
 *
 * Connects to Chrome Debug (port 9222), switches Gemini to Pro Extended Thinking,
 * submits a prompt, and returns the response on stdout.
 *
 * Usage:
 *   node index.js "Your prompt here"
 *   node index.js --timeout=300000 "Long prompt..."
 *   echo "Prompt from stdin" | node index.js
 *
 * Error codes:
 *   1 - Chrome debug not running or Gemini tab/login not available
 *   2 - Pro Extended mode failed to activate (ERR_MODEL_DEGRADED)
 *   3 - Prompt rejected by Gemini safety filter (ERR_SAFETY_REJECTED)
 *   4 - Response timeout, empty, or unknown error
 *   5 - Rate limited (ERR_RATE_LIMITED) — backoff required
 *   6 - Session expired mid-generation (ERR_SESSION_EXPIRED)
 *  10 - Response timeout (ERR_TIMEOUT) — partial output discarded
 *
 * Flags:
 *   --timeout=N  — override default thinking timeout (ms)
 *   --smoke      — smoke test: verify environment without submitting a prompt
 *   --doctor     — check Chrome CDP connectivity only
 *   --session    — reuse existing Gemini tab (multi-turn conversation mode)
 *   --new-session — force-create a new session even if one exists
 *   --locale=zh-CN — override auto-detected Gemini UI language
 */

const { chromium } = require('playwright-core');

// ── Config ──────────────────────────────────────────────────────────────────
const CDP_URL           = 'http://127.0.0.1:9222';
const GEMINI_URL_PREFIX = 'https://gemini.google.com/u/0/app';
const MAX_RETRIES       = 2;
const THINKING_TIMEOUT  = 600_000; // 10 min default
const POLL_INTERVAL     = 2_000;   // ms
const INSERT_TEXT_LIMIT = 50_000;  // ~50KB safe CDP WebSocket payload

// ── Locale-aware selectors ──────────────────────────────────────────────────
// Gemini UI 根据用户账号语言渲染不同文本（简体中文/繁体中文/英文等）。
// locales.js 集中管理所有语言变体，核心逻辑不再硬编码选择器。
const LOC = require('./locales');

// 用于 page.evaluate() 的组合 CSS（必须包含所有已知 locale，因为
// evaluate 运行在浏览器端，无法访问 Node.js 运行时状态）
const EVAL_MODEL_BTN = Object.values(LOC.PROFILES)
    .map(p => `button[aria-label*="${p.modelAria}"]`)
    .join(', ');

// ── Telemetry (Round 7) ─────────────────────────────────────────────────────
const telemetry = {
    timestamp: new Date().toISOString(),
    prompt_length_chars: 0,
    setup_ms: 0,
    mode_activation_ms: 0,
    generation_ms: 0,
    response_length_chars: 0,
    retries_used: 0,
    warnings: [],
    exit_code: 0
};

function recordTelemetry(code = 0) {
    telemetry.exit_code = code;
    const fs = require('fs');
    fs.appendFileSync('gemini-telemetry.jsonl', JSON.stringify(telemetry) + '\n');
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) {
    process.stderr.write('\r\x1b[K'); // clear spinner line
    process.stderr.write(`[gemini] ${msg}\n`);
}

// ── Elapsed Timer Spinner (Round 7) ─────────────────────────────────────────
let spinnerInterval = null;

function startTimer(phaseName) {
    if (spinnerInterval) clearInterval(spinnerInterval);
    const startTime = Date.now();
    const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
    let i = 0;
    spinnerInterval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        process.stderr.write(`\r[gemini] ${frames[i]} ${phaseName} (${mins}:${secs})`);
        i = (i + 1) % frames.length;
    }, 100);
}

function stopTimer() {
    if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
    process.stderr.write('\r\x1b[K'); // clear spinner line
}

// ── Connection & Session Management (Round 5) ───────────────────────────────

/**
 * connectWithRetry — establishes CDP connection with retry and disconnect detection.
 */
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

/**
 * acquireIsolatedPage — spawns a dedicated tab for this execution.
 * Guarantees concurrency isolation (each invocation gets its own tab)
 * and handles auth redirect detection.
 */
async function acquireIsolatedPage(browser) {
    const context = browser.contexts()[0];
    if (!context) throw new Error('No active browser context on Chrome instance.');

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    log('Spawning isolated execution tab...');
    const page = await context.newPage();

    // Lifecycle monitoring
    page.on('crash',  () => log('WARN: Tab crashed.'));
    page.on('close', () => log('WARN: Tab closed.'));

    await page.goto(GEMINI_URL_PREFIX, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Detect auth redirects or interstitial pages
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
        await page.close();
        throw Object.assign(
            new Error('Gemini requires login. Please sign in to gemini.google.com in Chrome.'),
            { code: 'ERR_NOT_AUTHENTICATED' }
        );
    }
    if (!currentUrl.startsWith(GEMINI_URL_PREFIX)) {
        await page.close();
        throw Object.assign(
            new Error(`Unexpected page: ${currentUrl}. Expected Gemini app.`),
            { code: 'ERR_WRONG_PAGE' }
        );
    }

    log('Isolated tab ready.');

    // Auto-detect Gemini UI locale for correct selectors
    const lang = await LOC.detectLocale(page);
    if (lang) {
        LOC.setLocale(lang);
        log(`Detected Gemini UI locale: ${lang}`);
    }

    return page;
}

/**
 * acquireSessionPage — reuses an existing Gemini tab for multi-turn conversation.
 *
 * Unlike acquireIsolatedPage (which always spawns a new tab), this finds an
 * existing Gemini tab with an active conversation and reuses it — preserving
 * conversation history, avoiding re-authentication, and preventing Google's
 * security verification triggers.
 *
 * Falls back to creating a new tab if no suitable session exists.
 */
async function acquireSessionPage(browser) {
    const context = browser.contexts()[0];
    if (!context) throw new Error('No active browser context on Chrome instance.');

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    // 1. Hunt for an existing Gemini tab with conversation context
    const pages = await context.pages();
    for (const pg of pages) {
        try {
            const url = pg.url();
            // Must be a Gemini app page with loaded content
            // Match both gemini.google.com/u/0/app and gemini.google.com/app
            const isGeminiPage = url.startsWith(GEMINI_URL_PREFIX) || url.startsWith('https://gemini.google.com/app');
            if (isGeminiPage && !url.includes('accounts.google.com')) {
                const title = await pg.title().catch(() => '');
                if (title && title !== 'about:blank' && !title.includes('登录')) {
                    // Check if page is actually alive and responsive
                    const ready = await pg.evaluate(() => document.readyState).catch(() => null);
                    if (ready === 'complete') {
                        log(`Reusing existing Gemini tab: "${title.substring(0, 50)}"`);
                        // Re-detect locale on reused tab (new process, state is fresh)
                        const lang = await LOC.detectLocale(pg);
                        if (lang) {
                            LOC.setLocale(lang);
                            log(`Detected Gemini UI locale: ${lang}`);
                        }
                        return pg;
                    }
                }
            }
        } catch (_) {
            // Page may have closed between listing and access — skip
        }
    }

    // 2. No reusable page found — create a fresh one
    log('No reusable Gemini tab found, creating new session...');
    const page = await context.newPage();
    page.on('crash',  () => log('WARN: Tab crashed.'));
    page.on('close', () => log('WARN: Tab closed.'));

    await page.goto(GEMINI_URL_PREFIX, { waitUntil: 'domcontentloaded', timeout: 45000 });

    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
        await page.close();
        throw Object.assign(
            new Error('Gemini requires login. Please sign in to gemini.google.com in Chrome.'),
            { code: 'ERR_NOT_AUTHENTICATED' }
        );
    }

    log('New session tab ready.');

    // Auto-detect Gemini UI locale
    const lang = await LOC.detectLocale(page);
    if (lang) {
        LOC.setLocale(lang);
        log(`Detected Gemini UI locale: ${lang}`);
    }

    return page;
}

// ── ensureProExtended (Round 1 improvements) ────────────────────────────────

/**
 * ensureProExtended — switches Gemini to Pro + Extended Thinking.
 *
 * Uses Playwright native Locators (auto-wait) instead of page.evaluate() queries,
 * handles partial/expanded state, and verifies with waitForFunction.
 *
 * Returns true if Pro Extended is active, false after exhausting retries.
 */
async function ensureProExtended(page, maxRetries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            log(`retry ${attempt}/${maxRetries} — reloading page`);
            try { await page.reload({ waitUntil: 'domcontentloaded' }); await page.waitForTimeout(5000); } catch (_) {}
        }

        // Dismiss any open overlays with Escape (more reliable than body.click)
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // Check current mode
        const currentMode = await page.evaluate((evalBtn) => {
            const btn = document.querySelector(evalBtn);
            return btn ? btn.textContent.trim() : 'UNKNOWN';
        }, EVAL_MODEL_BTN);
        log(`attempt ${attempt}: current mode = "${currentMode}"`);

        if (currentMode.includes(LOC.verifyStr('modelVerify'))) {
            log('Pro Extended Thinking already active');
            return true;
        }

        // Step 1: Open model selector (using Playwright Locator with auto-wait)
        try {
            const selectorBtn = page.locator(LOC.ariaCSS('modelAria')).first();
            await selectorBtn.waitFor({ state: 'visible', timeout: 5000 });
            await selectorBtn.click();
        } catch {
            log('WARN: Model selector button not found. UI may have changed.');
            continue; // → retry
        }

        // Wait for menu container
        try {
            const menu = page.locator('[role="menu"]');
            await menu.waitFor({ state: 'visible', timeout: 5000 });
        } catch {
            log('WARN: Menu did not appear after clicking selector.');
            continue;
        }

        // Step 2: Ensure Pro model (skip Flash variants)
        if (!currentMode.includes('Pro') || currentMode.includes('Flash')) {
            log('switching to Pro model');
            try {
                const proItem = page.locator(LOC.STATIC.menuItem, { hasText: LOC.menuPattern('proText') })
                    .filter({ hasNotText: 'Flash' }).first();
                await proItem.click();
                await page.waitForTimeout(2000);

                // Model switch often closes menu — reopen for thinking level
                const selectorBtn = page.locator(LOC.ariaCSS('modelAria')).first();
                await selectorBtn.click();
                await page.locator(LOC.STATIC.menuContainer).waitFor({ state: 'visible', timeout: 5000 });
            } catch {
                log('WARN: Failed to switch to Pro model.');
                continue;
            }
        }

        // Step 3-4: Expand thinking level → select Extended (handles partial state)
        const extendedBtn = page.locator(LOC.STATIC.menuItem)
            .filter({ hasText: LOC.menuPattern('extendedText') })
            .filter({ hasNotText: LOC.menuPattern('thinkText') })
            .first();

        const extendedAlreadyVisible = await extendedBtn.isVisible().catch(() => false);

        if (!extendedAlreadyVisible) {
            log('expanding thinking-level choices');
            try {
                const thoughtItem = page.locator(LOC.STATIC.menuItem, { hasText: LOC.menuPattern('thinkText') }).first();
                await thoughtItem.click();
                // Locator auto-waits for extendedBtn to become visible
            } catch {
                log('WARN: Could not expand thinking level menu.');
                continue;
            }
        } else {
            log('Extended thinking option already visible (partial state handled).');
        }

        // Click Extended
        try {
            await extendedBtn.waitFor({ state: 'visible', timeout: 5000 });
            await extendedBtn.click();
            log('selected Extended thinking');
        } catch {
            log('WARN: Extended button not clickable.');
            continue;
        }

        // Step 5: Close menu gracefully and verify
        await page.keyboard.press('Escape');
        await page.locator(LOC.STATIC.overlayBackdrop).waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});

        // Verify with polling (handles UI transition delays)
        // We use a lambda string pattern; null args since we use hardcoded selectors
        const isActive = await page.waitForFunction(({ evalBtn, verifyStr }) => {
            const btn = document.querySelector(evalBtn);
            if (!btn) return false;
            const text = btn.textContent.trim();
            return text.includes(verifyStr);
        }, { evalBtn: EVAL_MODEL_BTN, verifyStr: LOC.verifyStr('modelVerify') }, { timeout: 3000 }).catch(() => false);

        if (isActive) {
            log('Verified: Pro Extended Thinking active.');
            return true;
        }

        log(`final mode not confirmed as Pro Extended.`);
    }
    return false;
}

// ── waitForResponse (Round 2 improvements) ──────────────────────────────────

/**
 * waitForResponse — extracts the full, finalized response.
 *
 * PRIMARY strategy: wait for the Action Toolbar (Copy / Good response buttons)
 *   to appear — the only reliable indicator that generation AND DOM rendering
 *   are completely finished.
 *
 * FALLBACK strategy: text-length stability check with absolute time bound,
 *   using innerText (accounts for visual rendering, not just textContent).
 *
 * EXTRACTION: climbs to the full message container to capture multi-block
 *   responses (intro text + code blocks + follow-up questions).
 */
async function waitForResponse(page, timeoutMs = THINKING_TIMEOUT) {
    const startTime = Date.now();
    log('waiting for response rendering to complete...');

    const responseLocator = page.locator(LOC.STATIC.responseContainer);

    // Ensure at least one response block exists
    try {
        await responseLocator.last().waitFor({ state: 'attached', timeout: timeoutMs });
    } catch {
        log('No response text element appeared within timeout.');
        return null;
    }

    // PRIMARY: Wait for Action Toolbar (Copy / Good response / thumbs)
    const actionToolbar = page.locator(
        LOC.ariaCSS('copyAria') + ', ' + LOC.ariaCSS('goodAria')
    ).last();

    const toolbarAppeared = await actionToolbar.waitFor({ state: 'visible', timeout: Math.max(10000, timeoutMs - (Date.now() - startTime)) }).then(() => true).catch(() => false);

    if (!toolbarAppeared) {
        log('Action toolbar not detected, falling back to stability check...');

        // FALLBACK: innerText stability with absolute time bound
        let lastLen = 0;
        let lastChangeTime = Date.now();
        const STABILITY_WINDOW = 15_000;

        while ((Date.now() - lastChangeTime) < STABILITY_WINDOW) {
            if ((Date.now() - startTime) > timeoutMs) {
                log('Max timeout reached during stability check.');
                break;
            }

            await page.waitForTimeout(POLL_INTERVAL);

            try {
                const currentText = await responseLocator.last().evaluate(el => el.innerText || el.textContent || '');
                if (currentText.length > lastLen) {
                    lastLen = currentText.length;
                    lastChangeTime = Date.now();
                    process.stderr.write('+');
                } else {
                    process.stderr.write('s');
                }
            } catch {
                process.stderr.write('?');
            }
        }
        process.stderr.write('\n');
    } else {
        log('Action toolbar detected — response finalized.');
    }

    // Extract FULL response: climb to message container for multi-block content
    const finalContent = await responseLocator.last().evaluate((el) => {
        const container = el.closest('model-message')
            || el.closest('[class*="message-container"]')
            || el.closest('[class*="response-container"]')
            || el.parentElement?.parentElement
            || el;
        return (container.innerText || container.textContent || '').trim();
    });

    log(`response complete, length = ${finalContent ? finalContent.length : 0}`);
    return finalContent;
}

// ── submitToGemini (Round 3 input + Round 4 retry improvements) ─────────────

/**
 * submitToGemini — full pipeline: ensure mode → type prompt → send → wait → return.
 */
async function submitToGemini(page, message, options = {}) {
    const timeout = options.timeout || THINKING_TIMEOUT;
    const retries  = options.retries  || MAX_RETRIES;
    let lastError  = null;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            log(`submission attempt ${attempt}/${retries}`);

            // ── 1. Enforce Pro Extended Thinking ──
            if (!(await ensureProExtended(page))) {
                throw Object.assign(
                    new Error('Pro Extended Thinking failed to activate — refusing to run with degraded model'),
                    { code: 'ERR_MODEL_DEGRADED' }
                );
            }

            // ── 2. Locate, verify, and focus editor ──
            log('locating input editor...');

            const editorSelector = LOC.STATIC.editor;
            const editorLocator = page.locator(editorSelector).first();

            try {
                await editorLocator.waitFor({ state: 'visible', timeout: 10_000 });

                // Rate-limit / read-only detection (Round 9)
                const isEditable = await editorLocator.evaluate(el =>
                    el.getAttribute('contenteditable') !== 'false' && !el.hasAttribute('readonly')
                );
                if (!isEditable) {
                    throw Object.assign(
                        new Error('Editor is read-only — rate limit likely reached.'),
                        { code: 'ERR_RATE_LIMITED' }
                    );
                }

                await editorLocator.focus();
                await editorLocator.click();
            } catch (err) {
                if (err.code === 'ERR_RATE_LIMITED') throw err;
                throw Object.assign(
                    new Error('Input editor not found or not visible.'),
                    { code: 'ERR_EDITOR_NOT_FOUND' }
                );
            }

            // Clear existing text (keyboard fallback for custom elements like <rich-textarea>)
            try {
                await editorLocator.fill('');
            } catch {
                // Custom element (rich-textarea) doesn't support fill() — use keyboard
                await editorLocator.click();
                await page.keyboard.press('ControlOrMeta+a');
                await page.keyboard.press('Backspace');
            }
            await page.waitForTimeout(100);

            // ── 3. Type prompt with payload integrity check ──
            if (message.length > INSERT_TEXT_LIMIT) {
                log(`Large payload (${message.length} chars), using clipboard paste...`);
                try {
                    await page.evaluate(async (text) => {
                        await navigator.clipboard.writeText(text);
                    }, message);
                } catch {
                    log('WARN: Clipboard write failed (headless Xvfb issue?).');
                }
                await page.keyboard.press('ControlOrMeta+v');
                await page.waitForTimeout(500);
            } else {
                log(`Using insertText (${message.length} chars)...`);
                await page.keyboard.insertText(message);
            }

            // Payload integrity check — detect WebSocket frame drops
            await page.waitForTimeout(500);
            const injectedLen = await editorLocator.evaluate(el =>
                (el.innerText || el.textContent || '').trim().length
            );
            if (Math.abs(injectedLen - message.length) > message.length * 0.05) {
                log(`WARN: Payload mismatch. Expected ~${message.length}, got ${injectedLen}. Retrying...`);
                throw Object.assign(
                    new Error('WebSocket dropped input frames — payload truncated.'),
                    { code: 'ERR_INPUT_CORRUPTED' }
                );
            }

            // Trigger Angular change detection via native input event
            await editorLocator.evaluate(node => {
                node.dispatchEvent(new Event('input', { bubbles: true, composed: true }));
            });

            // ── 4. Send ──
            const sendBtn = page.locator(
                LOC.ariaCSS('sendAria')
            );

            try {
                await sendBtn.waitFor({ state: 'visible', timeout: 3000 });
                // Wait for Angular to enable the button
                await sendBtn.waitFor({ state: 'attached', timeout: 2000 });
                const isEnabled = await sendBtn.isEnabled().catch(() => false);
                if (isEnabled || !(await sendBtn.isEnabled().catch(() => true))) {
                    // Click even if we can't determine enabled state (Playwright handles the retry)
                }
                await sendBtn.click();
            } catch {
                log('Send button not available, falling back to Ctrl+Enter');
                await editorLocator.focus();
                await page.keyboard.press('ControlOrMeta+Enter');
            }

            // ── 5. Wait for generation phase (dynamic timeout from total budget) ──
            log('waiting for generation phase...');
            const genStartTime = Date.now();
            const stopBtn = page.locator(
                LOC.ariaCSS('stopAria')
            ).first();

            try {
                await stopBtn.waitFor({ state: 'visible', timeout: 15_000 });
                log('generation started (stop button visible)');

                const elapsed = Date.now() - genStartTime;
                const remainingTimeout = Math.max(10_000, timeout - elapsed);

                await stopBtn.waitFor({ state: 'hidden', timeout: remainingTimeout });
                log('generation finished (stop button hidden)');
            } catch {
                log('No prolonged generation phase (instant or cached response).');
            }

            // ── 6. Collect response (with session expiry and safety scan) ──
            const remainingForResponse = Math.max(30_000, timeout - (Date.now() - genStartTime));
            const response = await waitForResponse(page, remainingForResponse);

            // Session expiry check: did the page redirect away?
            const currentUrl = page.url();
            if (!currentUrl.startsWith(GEMINI_URL_PREFIX)) {
                throw Object.assign(
                    new Error('Session expired — page redirected away from Gemini.'),
                    { code: 'ERR_SESSION_EXPIRED' }
                );
            }

            // Timeout check: don't return partial text as success (Round 10)
            if (!response || response.length < 10) {
                const maybeRejected = await page.evaluate(() => {
                    const el = document.querySelector('.model-response-text');
                    return el?.textContent || '';
                });
                // Expanded safety rejection patterns (Round 9)
                if (maybeRejected && /can'?t help|unable to|against policy|I cannot fulfill|safety guidelines/i.test(maybeRejected)) {
                    throw Object.assign(
                        new Error('Gemini rejected the prompt (safety filter).'),
                        { code: 'ERR_SAFETY_REJECTED' }
                    );
                }
                if (!response && (Date.now() - genStartTime) > timeout) {
                    throw Object.assign(
                        new Error('Max timeout reached — response not complete.'),
                        { code: 'ERR_TIMEOUT' }
                    );
                }
                throw new Error('Response empty or too short.');
            }

            return response;

        } catch (error) {
            lastError = error;
            log(`attempt ${attempt} failed: ${error.message}`);

            if (error.code === 'ERR_SAFETY_REJECTED') throw error; // never retry

            if (attempt < retries) {
                // ── Tiered Recovery (Round 4) ──
                log('Attempting soft UI recovery...');
                try {
                    // 1. Abort any stuck generation
                    const stopBtn = page.locator(LOC.ariaCSS('stopAria')).first();
                    if (await stopBtn.isVisible({ timeout: 2000 }).catch(() => false)) {
                        log('Canceling stuck generation...');
                        await stopBtn.click();
                        await stopBtn.waitFor({ state: 'hidden', timeout: 5000 }).catch(() => {});
                    }

                    // 2. Clean editor
                    const editorLocator = page.locator(LOC.STATIC.editorFallback).first();
                    if (await editorLocator.isVisible({ timeout: 2000 }).catch(() => false)) {
                        try { await editorLocator.fill(''); } catch {
                            await editorLocator.click();
                            await page.keyboard.press('ControlOrMeta+a');
                            await page.keyboard.press('Backspace');
                        }
                    }
                } catch (softErr) {
                    // 3. Escalate to hard recovery — but don't swallow target crashes (Round 10)
                    if (softErr.message?.includes('Target crashed') || softErr.message?.includes('Target closed')) {
                        log('FATAL: Browser target crashed — cannot recover.');
                        throw Object.assign(
                            new Error('Chrome tab crashed. Restart Chrome or increase resource limits.'),
                            { code: 'ERR_TARGET_CRASHED' }
                        );
                    }
                    log('Soft recovery failed, escalating to page reload...');
                    try {
                        await page.reload({ waitUntil: 'domcontentloaded' });
                        await page.waitForTimeout(5000);
                    } catch (reloadErr) {
                        if (reloadErr.message?.includes('Target crashed') || reloadErr.message?.includes('Target closed')) {
                            throw Object.assign(
                                new Error('Chrome tab crashed during reload.'),
                                { code: 'ERR_TARGET_CRASHED' }
                            );
                        }
                    }
                }
            }
        }
    }

    throw lastError || new Error('All retries exhausted.');
}

// ── CLI Entry Point (Round 4 --timeout flag) ────────────────────────────────

async function main() {
    // Parse flags
    const args = process.argv.slice(2);

    // --doctor: check CDP connectivity only
    if (args.includes('--doctor')) {
        log('Running environment check (--doctor)...');
        try {
            const http = require('http');
            const res = await new Promise((resolve, reject) => {
                http.get(CDP_URL + '/json/version', (res) => {
                    let data = '';
                    res.on('data', c => data += c);
                    res.on('end', () => resolve({ ok: true, data }));
                }).on('error', reject);
            });
            log(`Chrome CDP reachable: ${res.data.substring(0, 100)}`);
            process.exit(0);
        } catch (e) {
            log('Chrome CDP is NOT reachable on ' + CDP_URL);
            log('Run: bash scripts/start-chrome-debug.sh');
            process.exit(1);
        }
    }

    // Parse --timeout flag
    let promptArgs = args.filter(a => !a.startsWith('--timeout=') && !a.startsWith('--locale=') && a !== '--smoke' && a !== '--doctor' && a !== '--session' && a !== '--new-session');
    let customTimeout = THINKING_TIMEOUT;

    const timeoutFlagIdx = promptArgs.findIndex(a => a.startsWith('--timeout='));
    if (timeoutFlagIdx !== -1) {
        const val = parseInt(promptArgs[timeoutFlagIdx].split('=')[1], 10);
        if (!isNaN(val) && val > 0) customTimeout = val;
        promptArgs.splice(timeoutFlagIdx, 1);
    }

    // Parse --locale= flag (override auto-detection)
    let manualLocale = null;
    const localeArg = args.find(a => a.startsWith('--locale='));
    if (localeArg) {
        manualLocale = localeArg.split('=')[1].trim();
        LOC.setLocale(manualLocale);
        log(`Manual locale override: ${manualLocale}`);
    }

    // --session: reuse existing tab (multi-turn), --new-session: force fresh tab
    const sessionMode = args.includes('--session');
    const newSession = args.includes('--new-session');

    // Read prompt from remaining argv or stdin
    let prompt = promptArgs.join(' ').trim();
    if (!prompt) {
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        prompt = chunks.join('').trim();
    }
    if (!prompt && !args.includes('--smoke')) {
        console.error('Usage: node index.js [--timeout=N] [--smoke] [--doctor] [--session] [--new-session] [--locale=zh-CN] "Your prompt"');
        console.error('       echo "prompt" | node index.js [--timeout=N] [--session]');
        console.error('  --session     Reuse existing Gemini tab for multi-turn conversation');
        console.error('  --new-session Force-create a new conversation tab');
        console.error('  --locale=LANG Override auto-detected Gemini UI language (zh-CN|zh-TW|en)');
        process.exit(1);
    }

    // ── Connection & Page Lifecycle ──
    let browser, page;
    let closePageOnExit = true;  // default: cleanup after ourselves
    const setupStart = Date.now();
    try {
        browser = await connectWithRetry(CDP_URL);

        if (newSession) {
            // Force new tab even in session scenario
            log('Forcing new session tab...');
            page = await acquireIsolatedPage(browser);
        } else if (sessionMode) {
            // Multi-turn: reuse existing tab, don't close it when done
            page = await acquireSessionPage(browser);
            closePageOnExit = false;
        } else {
            // Default: isolated tab per invocation
            page = await acquireIsolatedPage(browser);
        }

        telemetry.setup_ms = Date.now() - setupStart;

        // --smoke: verify environment without submitting
        if (args.includes('--smoke')) {
            log('Running smoke test...');
            try {
                const editor = page.locator(LOC.STATIC.editorFallback).first();
                await editor.waitFor({ state: 'visible', timeout: 5000 });
                log('Editor found on page.');

                const selectorBtn = page.locator(LOC.ariaCSS('modelAria')).first();
                await selectorBtn.waitFor({ state: 'visible', timeout: 5000 });
                log('Model selector found on page.');

                log('Smoke test PASSED — environment is healthy.');
                process.exit(0);
            } catch (e) {
                log(`Smoke test FAILED: ${e.message}`);
                process.exit(1);
            }
        }

        const answer = await submitToGemini(page, prompt, { timeout: customTimeout });
        telemetry.response_length_chars = answer.length;
        console.log(answer);  // clean stdout for piping
        recordTelemetry(0);

    } catch (error) {
        log(`FATAL: ${error.message}`);
        if (error.code === 'ERR_MODEL_DEGRADED')    { recordTelemetry(2); process.exit(2); }
        if (error.code === 'ERR_SAFETY_REJECTED')   { recordTelemetry(3); process.exit(3); }
        if (error.code === 'ERR_RATE_LIMITED')      { recordTelemetry(5); process.exit(5); }
        if (error.code === 'ERR_SESSION_EXPIRED')   { recordTelemetry(6); process.exit(6); }
        if (error.code === 'ERR_TARGET_CRASHED')    { recordTelemetry(7); process.exit(7); }
        if (error.code === 'ERR_NOT_AUTHENTICATED') { recordTelemetry(1); process.exit(1); }
        if (error.code === 'ERR_EDITOR_NOT_FOUND')  { recordTelemetry(4); process.exit(4); }
        recordTelemetry(4);
        process.exit(4);
    } finally {
        stopTimer();
        if (closePageOnExit && page && !page.isClosed()) {
            try { await page.close(); } catch (_) {}
        }
        if (browser) {
            try { await browser.close(); } catch (_) {} // CDP: disconnects only
        }
    }
}

main().catch(e => {
    process.stderr.write(`[gemini] unhandled: ${e.message}\n`);
    process.exit(4);
});
