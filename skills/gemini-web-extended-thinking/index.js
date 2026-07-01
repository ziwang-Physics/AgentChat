#!/usr/bin/env node
/**
 * Gemini Web Extended Thinking — Playwright/CDP bridge v5.
 *
 * v5: Zero-clipboard DOM injection/extraction + concurrent multi-worker scheduler.
 *     Single CDP connection, N worker tabs, jittered delays for Google rate-limit avoidance.
 *
 * Connects to Chrome Debug (port 9222), switches Gemini to Pro Extended Thinking,
 * submits prompt(s), and returns response(s) on stdout.
 *
 * Usage:
 *   # Single prompt (backward compatible)
 *   node index.js "Your prompt here"
 *   echo "Prompt from stdin" | node index.js
 *
 *   # Multiple prompts (concurrent)
 *   node index.js --prompt "q1" --prompt "q2" --prompt "q3"
 *   node index.js --concurrency=2 --prompt "q1" --prompt "q2"
 *   echo '["q1","q2","q3"]' | node index.js --concurrency=2
 *   node index.js --file=prompts.txt --concurrency=2
 *
 *   # Utilities
 *   node index.js --timeout=300000 "Long prompt..."
 *   node index.js --smoke      # verify environment without submitting
 *   node index.js --doctor     # check Chrome CDP connectivity only
 *
 * Error codes:
 *   1 - Chrome debug not running or Gemini tab/login not available
 *   2 - Pro Extended mode failed to activate (ERR_MODEL_DEGRADED)
 *   3 - Prompt rejected by Gemini safety filter (ERR_SAFETY_REJECTED)
 *   4 - Response timeout, empty, or unknown error
 *   5 - Rate limited (ERR_RATE_LIMITED) — backoff required
 *   6 - Session expired mid-generation (ERR_SESSION_EXPIRED)
 *   7 - Tab crashed (ERR_TARGET_CRASHED)
 *   8 - Blank page (ERR_BLANK_PAGE)
 *  10 - Response timeout (ERR_TIMEOUT) — partial output discarded
 */

const { chromium } = require('playwright-core');

// ── Config ──────────────────────────────────────────────────────────────────
const CDP_URL            = 'http://127.0.0.1:9222';
const GEMINI_URL_PREFIX   = 'https://gemini.google.com/u/0/';
const GEMINI_URL_PREFIX_ALT = 'https://gemini.google.com/app';
const MAX_RETRIES        = 2;
const THINKING_TIMEOUT   = 600_000; // 10 min default
const POLL_INTERVAL      = 2_000;   // ms
const DEFAULT_CONCURRENCY = 2;
const MAX_CONCURRENCY     = 3;       // Google account limit
const JITTER_MIN_MS      = 2_000;
const JITTER_MAX_MS      = 5_000;

// ── Telemetry ───────────────────────────────────────────────────────────────
const telemetry = {
    timestamp: new Date().toISOString(),
    mode: 'single',
    task_count: 0,
    prompt_length_chars: 0,
    setup_ms: 0,
    generation_ms: 0,
    response_length_chars: 0,
    retries_used: 0,
    warnings: [],
    exit_code: 0,
    workers_used: 0,
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

// ── Elapsed Timer Spinner ───────────────────────────────────────────────────
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

// ── Connection ──────────────────────────────────────────────────────────────

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

// ── Page Management ─────────────────────────────────────────────────────────

/**
 * refreshPage — hard navigation reload. Uses page.goto(current URL) = equivalent
 * to clicking address bar + Enter. Falls back to F5 keyboard shortcut.
 */
async function refreshPage(page) {
    const currentUrl = page.url();
    log(`Refreshing page (hard navigation to ${currentUrl.substring(0, 60)}...)`);
    try {
        await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
        await page.waitForTimeout(3000);
        log('Page refreshed via hard navigation.');
    } catch (e1) {
        log(`Hard navigation failed (${e1.message}), trying F5...`);
        try {
            await page.keyboard.press('F5');
            await page.waitForTimeout(5000);
            log('Page refreshed via F5.');
        } catch (e2) {
            log(`F5 also failed: ${e2.message}`);
            throw e2;
        }
    }
}

/**
 * createWorkerPage — creates a fresh Gemini tab, initializes it (wait for editor,
 * ensure auth), and returns the page ready for use. Each worker gets its own tab.
 */
async function createWorkerPage(browser) {
    const context = browser.contexts()[0];
    if (!context) throw new Error('No active browser context on Chrome instance.');

    await context.grantPermissions(['clipboard-read', 'clipboard-write']);

    log('Creating new worker tab...');
    const page = await context.newPage();

    page.on('crash',  () => { log('WARN: Worker tab crashed.'); });
    page.on('close', () => { log('WARN: Worker tab closed.'); });

    await page.goto(GEMINI_URL_PREFIX, { waitUntil: 'domcontentloaded', timeout: 45000 });

    // Detect auth redirects
    const currentUrl = page.url();
    if (currentUrl.includes('accounts.google.com')) {
        await page.close();
        throw Object.assign(
            new Error('Gemini requires login. Please sign in to gemini.google.com in Chrome.'),
            { code: 'ERR_NOT_AUTHENTICATED' }
        );
    }
    if (!currentUrl.startsWith(GEMINI_URL_PREFIX) && !currentUrl.startsWith(GEMINI_URL_PREFIX_ALT)) {
        await page.close();
        throw Object.assign(
            new Error(`Unexpected page: ${currentUrl}. Expected Gemini app.`),
            { code: 'ERR_WRONG_PAGE' }
        );
    }

    log('Worker tab loaded. Waiting for editor...');
    // Click to wake up Angular app
    await page.mouse.click(400, 400).catch(() => {});
    await page.waitForTimeout(3000);

    try {
        await page.locator('.ql-editor, [contenteditable="true"], rich-textarea, [role="textbox"]').first().waitFor({ state: 'visible', timeout: 15000 });
        log('Editor rendered successfully.');
    } catch (e) {
        log('WARN: Editor not visible after page load — retrying with page reload.');
        await refreshPage(page);
        await page.waitForTimeout(5000);
        await page.mouse.click(400, 400).catch(() => {});
        try {
            await page.locator('.ql-editor, [contenteditable="true"], rich-textarea, [role="textbox"]').first().waitFor({ state: 'visible', timeout: 15000 });
            log('Editor visible after reload.');
        } catch (e2) {
            log('WARN: Editor still not visible — will attempt to proceed anyway.');
        }
    }
    return page;
}

// ── Model Switching ─────────────────────────────────────────────────────────

/**
 * ensureProExtended — switches Gemini to Pro + Extended Thinking.
 *
 * v6 (2026-06-28): Fixed Angular CDK overlay rendering delay. After clicking the
 * model selector button, gem-menu-item elements appear in the DOM immediately but
 * their innerText is empty for 200-500ms until Angular zone.js finishes change
 * detection. Playwright's auto-wait only checks visibility, not text content.
 * Added waitForMenuItemsFilled() to poll innerText until populated.
 *
 * Uses aria-label for mode check (authoritative), handles partial/expanded state,
 * and verifies with waitForFunction. Idempotent — skips if already active.
 */
async function ensureProExtended(page, maxRetries = MAX_RETRIES) {
    // Helper: wait for menu items to have actual text content (Angular CDK overlay fix)
    const waitForMenuItemsFilled = async (timeoutMs = 5000) => {
        const start = Date.now();
        while (Date.now() - start < timeoutMs) {
            const count = await page.evaluate(() => {
                const items = document.querySelectorAll('gem-menu-item, [role="menuitem"], [role="menuitemradio"]');
                let filled = 0;
                for (const el of items) {
                    if ((el.innerText || '').trim().length > 0) filled++;
                }
                return filled;
            });
            if (count >= 2) return true;
            await page.waitForTimeout(200);
        }
        return false;
    };

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            log(`retry ${attempt}/${maxRetries} — reloading page`);
            try { await refreshPage(page); await page.waitForTimeout(2000); } catch (_) {}
        }

        // Dismiss any open overlays
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // Check current mode via aria-label (authoritative, not textContent)
        const currentAria = await page.evaluate(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
        });
        log(`attempt ${attempt}: current mode = "${currentAria}"`);

        if (currentAria.includes('延長') || currentAria.includes('Extended')) {
            log('Pro Extended Thinking already active');
            return true;
        }

        // Step 1: Open model selector
        try {
            const selectorBtn = page.locator('button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]').first();
            await selectorBtn.waitFor({ state: 'visible', timeout: 5000 });
            await selectorBtn.click();
        } catch {
            log('WARN: Model selector button not found. UI may have changed.');
            continue;
        }

        // Wait for menu + Angular CDK overlay to finish rendering text
        try {
            await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
        } catch {
            log('WARN: Menu [role="menu"] did not appear. Trying gem-menu-item fallback...');
        }

        if (!(await waitForMenuItemsFilled())) {
            log('WARN: Menu items never got innerText (Angular CDK rendering timeout).');
            continue;
        }

        // Step 2: Ensure Pro model (skip Flash variants)
        const modeIsPro = currentAria.includes('Pro') && !currentAria.includes('Flash');
        if (!modeIsPro) {
            log('switching to Pro model');
            try {
                // Use gem-menu-item for text matching (more reliable than role=menuitem)
                const proIdx = await page.evaluate(() => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (t.includes('Pro') && t.includes('進階') && !t.includes('Flash')) return i;
                    }
                    return -1;
                });
                if (proIdx < 0) throw new Error('Pro item not found');

                await page.locator('gem-menu-item, [role="menuitem"]').nth(proIdx).click();
                await page.waitForTimeout(2000);

                // Model switch often closes menu — reopen for thinking level
                const selectorBtn2 = page.locator('button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]').first();
                await selectorBtn2.click();
                await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
                if (!(await waitForMenuItemsFilled())) {
                    log('WARN: Menu items after Pro switch never filled.');
                    continue;
                }
            } catch {
                log('WARN: Failed to switch to Pro model.');
                continue;
            }
        }

        // Step 3: Expand thinking level submenu
        let extendedIdx = -1;
        // Check if submenu is already visible (Extend option at L1, further right)
        extendedIdx = await page.evaluate(() => {
            const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
            for (let i = 0; i < items.length; i++) {
                const t = items[i].innerText || '';
                // L1 "延長" option (pure Extended, not the "思考程度" parent)
                if ((t.includes('延長') || t.includes('Extended')) &&
                    !t.includes('思考') && !t.includes('Thought') &&
                    items[i].offsetParent !== null) {
                    return i;
                }
            }
            return -1;
        });

        if (extendedIdx < 0) {
            log('expanding thinking-level choices');
            try {
                // Click "思考程度" / "Thinking" to expand submenu
                const thinkIdx = await page.evaluate(() => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if ((t.includes('思考程度') || t.includes('Thinking') || t.includes('Thought')) &&
                            items[i].offsetParent !== null) return i;
                    }
                    return -1;
                });
                if (thinkIdx < 0) throw new Error('Thinking level item not found');

                await page.locator('gem-menu-item, [role="menuitem"]').nth(thinkIdx).click();
                await page.waitForTimeout(2000); // Wait for submenu slide-in animation

                // Re-query: now the L1 "延長" item should be visible
                extendedIdx = await page.evaluate(() => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if ((t.includes('延長') || t.includes('Extended')) &&
                            !t.includes('標準') && items[i].offsetParent !== null) return i;
                    }
                    return -1;
                });
                if (extendedIdx < 0) throw new Error('Extended option not found after expanding');
            } catch {
                log('WARN: Could not expand thinking level menu.');
                continue;
            }
        } else {
            log('Extended thinking option already visible (partial state handled).');
        }

        // Step 4: Click Extended
        try {
            await page.locator('gem-menu-item, [role="menuitem"]').nth(extendedIdx).click();
            log('selected Extended thinking');
        } catch {
            log('WARN: Extended button not clickable.');
            continue;
        }

        // Step 5: Close menu and verify
        await page.keyboard.press('Escape');
        await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // Verify via aria-label (authoritative source)
        const isActive = await page.waitForFunction(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            if (!btn) return false;
            const aria = btn.getAttribute('aria-label') || btn.textContent || '';
            return aria.includes('延長') || aria.includes('Extended');
        }, null, { timeout: 5000 }).catch(() => false);

        if (isActive) {
            log('Verified: Pro Extended Thinking active.');
            return true;
        }

        log(`final mode not confirmed as Pro Extended.`);
    }
    return false;
}

// ── No-Clipboard Input (v5) ─────────────────────────────────────────────────

const EDITOR_SELECTOR = '.ql-editor, [contenteditable="true"][role="textbox"], rich-textarea';

/**
 * injectPrompt — injects text directly into the Gemini editor via DOM manipulation.
 * NO clipboard. Triggers Angular change detection so the Send button activates.
 *
 * Strategy:
 *   1. Focus + clear the editor via page.evaluate()
 *   2. Set textContent (works for both contenteditable divs and rich-textarea custom elements)
 *   3. Dispatch 'input' + 'change' events to wake Angular zone.js
 *   4. Verify payload integrity
 */
async function injectPrompt(page, editorLocator, text) {
    // NOTE: Editor clearing + focus already handled by submitToGemini before calling this.
    // This function ONLY injects text and triggers Angular change detection.

    const INSERT_TEXT_LIMIT = 50_000;

    if (text.length > INSERT_TEXT_LIMIT) {
        log(`Large payload (${text.length} chars), using clipboard paste...`);
        try {
            await page.evaluate(async (t) => {
                await navigator.clipboard.writeText(t);
            }, text);
        } catch {
            log('WARN: Clipboard write failed (headless Xvfb issue?).');
        }
        await page.keyboard.press('ControlOrMeta+v');
        await page.waitForTimeout(500);
    } else {
        log(`Using insertText (${text.length} chars)...`);
        await page.keyboard.insertText(text);
    }

    await page.waitForTimeout(300);

    // Payload integrity check — use the SAME locator that was already resolved
    // (avoids document.querySelector picking up a different element)
    const injectedLen = await editorLocator.evaluate(el =>
        (el.innerText || el.textContent || '').trim().length
    );

    if (Math.abs(injectedLen - text.length) > text.length * 0.05) {
        log(`WARN: Payload mismatch. Expected ~${text.length}, got ${injectedLen}.`);
        throw Object.assign(
            new Error('Input payload truncated or injection failed.'),
            { code: 'ERR_INPUT_CORRUPTED' }
        );
    }

    // Belt-and-suspenders: type a char + delete to ensure Angular zone.js detects the change
    // and enables the Send button
    try {
        await page.keyboard.type(',');
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(200);
    } catch (_) { /* non-critical */ }

    log(`Payload integrity OK (${injectedLen} chars in editor).`);
}

// ── No-Clipboard Output (v5) ────────────────────────────────────────────────

/**
 * extractResponse — extracts Gemini's response text directly from the DOM.
 * NO clipboard. Uses model-message web component innerText as primary source.
 *
 * Fallback chain:
 *   1. model-message elements (most reliable, only latest response)
 *   2. Response container selectors
 *   3. Main content area innerText
 *   4. Keyboard Copy + clipboard (LAST RESORT for edge cases)
 */
async function extractResponse(page) {
    // ── PRIMARY: Direct DOM extraction ──
    let text = await page.evaluate(() => {
        // 1. Try model-message web component (Gemini's native response container)
        const msgs = document.querySelectorAll('model-message');
        if (msgs.length > 0) {
            const last = msgs[msgs.length - 1];
            const content = last.innerText || last.textContent || '';
            if (content.trim().length > 50) return content.trim();
        }

        // 2. Try response-specific selectors
        const respSelectors = [
            '[class*="response-text"]',
            '[class*="model-response"]',
            '[class*="markdown"]',
            '[class*="message-content"]',
        ];
        for (const sel of respSelectors) {
            const el = document.querySelector(sel);
            if (el) {
                const content = el.innerText || el.textContent || '';
                if (content.trim().length > 50) return content.trim();
            }
        }

        // 3. Find the conversation area (main content, not sidebar)
        const mainSelectors = ['main', '[role="main"]', '.main-content', 'article'];
        for (const sel of mainSelectors) {
            const el = document.querySelector(sel);
            if (el) {
                const content = (el.innerText || el.textContent || '').trim();
                if (content.length > 200 && content.length < 20000) {
                    // Filter out editor text (prompt that user typed)
                    const editor = document.querySelector('.ql-editor, [contenteditable="true"], rich-textarea');
                    const editorText = editor ? (editor.innerText || editor.textContent || '').trim() : '';
                    if (editorText && content.includes(editorText)) {
                        const idx = content.indexOf(editorText);
                        return content.substring(0, idx).trim();
                    }
                    return content;
                }
            }
        }

        return '';
    });

    if (text && text.length > 50) {
        log(`Response via DOM extraction: ${text.length} chars`);
        return text;
    }

    // ── FALLBACK: Keyboard copy + clipboard (only when DOM extraction fails) ──
    log('DOM extraction insufficient, falling back to keyboard copy...');
    try {
        // Click in the response area to focus it
        await page.mouse.click(700, 350).catch(() => {});
        await page.waitForTimeout(300);
        await page.keyboard.press('ControlOrMeta+a');
        await page.waitForTimeout(400);
        await page.keyboard.press('ControlOrMeta+c');
        await page.waitForTimeout(600);
        text = await page.evaluate(() => navigator.clipboard.readText());

        // Filter if we got too much (full page)
        if (text && text.length > 50000) {
            text = await page.evaluate(() => {
                const bodyText = document.body.innerText || '';
                const paragraphs = bodyText.split('\n').filter(l => l.trim().length > 0);
                let combined = '';
                const nav = ['新對話','搜尋對話','影片','媒體庫','筆記本','新增筆記本','近期對話','Gemini','Google 帳戶','提交','使用麥克風','開啟臨時對話','全螢幕'];
                for (const p of paragraphs) {
                    const t = p.trim();
                    if (t.length > 20 && !nav.includes(t)) combined += (combined ? '\n' : '') + t;
                }
                return combined.length > 200 ? combined : '';
            });
        }
        log(`Response via keyboard copy fallback: ${text ? text.length : 0} chars`);
    } catch (e) {
        log(`Keyboard copy fallback also failed: ${e.message}`);
    }

    return text || '';
}

// ── Response Waiting ────────────────────────────────────────────────────────

/**
 * waitForResponse — waits for Gemini to finish generating, then extracts response.
 *
 * PRIMARY signal: Action Toolbar (Copy / Good response buttons) appears.
 *                 This indicates BOTH generation AND DOM rendering are complete.
 *
 * FALLBACK: innerText stability check with absolute time bound (15s window).
 */
async function waitForResponse(page, timeoutMs = THINKING_TIMEOUT) {
    const startTime = Date.now();
    log('waiting for response rendering to complete...');

    const responseLocator = page.locator('model-message, .model-response-text, [class*="response-text"], [class*="model-response"], [class*="markdown"], [class*="message-content"]');

    // Ensure at least one response block exists
    let responseFound = false;
    try {
        await responseLocator.last().waitFor({ state: 'attached', timeout: timeoutMs });
        responseFound = true;
    } catch {
        log('No response text element appeared within timeout.');
    }

    if (!responseFound) {
        log('Refreshing page to recover response rendering...');
        try {
            await refreshPage(page);
            await page.waitForTimeout(5000);
            await responseLocator.last().waitFor({ state: 'attached', timeout: Math.min(30000, timeoutMs - (Date.now() - startTime)) });
            responseFound = true;
        } catch {
            log('Page refresh did not help — response still not found.');
            return null;
        }
    }

    // PRIMARY: Wait for Action Toolbar
    const actionToolbar = page.locator(
        'button[aria-label*="複製"], button[aria-label*="Copy"], button[aria-label*="Good response"], button[aria-label*="好答案"]'
    ).last();

    const remainingForToolbar = Math.max(10000, timeoutMs - (Date.now() - startTime));
    const toolbarAppeared = await actionToolbar.waitFor({ state: 'visible', timeout: remainingForToolbar }).then(() => true).catch(() => false);

    if (!toolbarAppeared) {
        log('Action toolbar not detected, falling back to stability check...');

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
                const currentText = await page.evaluate(() => {
                    const msgs = document.querySelectorAll('model-message');
                    if (msgs.length > 0) {
                        return msgs[msgs.length - 1].textContent || '';
                    }
                    const resp = document.querySelector('[class*="response-text"], [class*="model-response"], [class*="markdown"], [class*="message-content"]');
                    return resp ? (resp.textContent || '') : '';
                });
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

    // ── Extract response (no clipboard primary path) ──
    const finalContent = await extractResponse(page);
    log(`response complete, length = ${finalContent ? finalContent.length : 0}`);
    return finalContent;
}

// ── Submission Pipeline ─────────────────────────────────────────────────────

/**
 * submitToGemini — full pipeline: ensure mode → DOM-inject prompt (no clipboard)
 * → send → wait for generation → DOM-extract response (no clipboard) → return.
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
            const editorLocator = page.locator(EDITOR_SELECTOR).first();

            try {
                await editorLocator.waitFor({ state: 'visible', timeout: 10_000 });

                // Rate-limit / read-only detection
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

            // Clear existing text — MUST use keyboard events (Ctrl+A+Backspace)
            // to trigger Angular zone.js change detection. page.evaluate-based
            // clearing silently corrupts Quill's internal data model.
            try {
                await editorLocator.fill('');
            } catch {
                // fill() doesn't work on custom elements like rich-textarea
                // Use keyboard shortcuts which dispatch proper events
                await editorLocator.focus();
                await page.keyboard.press('ControlOrMeta+a');
                await page.keyboard.press('Backspace');
            }
            await page.waitForTimeout(100);

            // ── 3. Inject prompt (v5: keyboard.insertText + clipboard, no innerHTML) ──
            await injectPrompt(page, editorLocator, message);

            // ── 4. Send ──
            const sendBtn = page.locator(
                'button[aria-label*="傳送"], button[aria-label*="发送"], button[aria-label*="Send"]'
            );

            try {
                await sendBtn.waitFor({ state: 'visible', timeout: 3000 });
                // Wait for Angular to enable the button
                const isEnabled = await sendBtn.isEnabled().catch(() => false);
                if (isEnabled || !(await sendBtn.isEnabled().catch(() => true))) {
                    // Click even if we cannot determine enabled state
                }
                await sendBtn.click();
            } catch {
                log('Send button not available, falling back to Ctrl+Enter');
                await editorLocator.focus();
                await page.keyboard.press('ControlOrMeta+Enter');
            }

            // ── 5. Wait for generation phase ──
            log('waiting for generation phase...');
            const genStartTime = Date.now();
            const stopBtn = page.locator(
                'button[aria-label*="停止"], button[aria-label*="Stop"]'
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

            // ── 6. Collect response (no clipboard primary path) ──
            const remainingForResponse = Math.max(30_000, timeout - (Date.now() - genStartTime));
            const response = await waitForResponse(page, remainingForResponse);

            // Session expiry check
            const currentUrl = page.url();
            if (!currentUrl.startsWith(GEMINI_URL_PREFIX) && !currentUrl.startsWith(GEMINI_URL_PREFIX_ALT)) {
                throw Object.assign(
                    new Error('Session expired — page redirected away from Gemini.'),
                    { code: 'ERR_SESSION_EXPIRED' }
                );
            }

            // Timeout / safety check
            if (!response || response.length < 10) {
                const maybeRejected = await page.evaluate(() => {
                    const el = document.querySelector('.model-response-text, [class*="response-text"], [class*="model-response"], [class*="markdown"], [class*="message-content"]');
                    return el?.textContent || '';
                });
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
                log(`Attempt ${attempt} failed: ${error.message}. Refreshing page...`);
                try {
                    await refreshPage(page);
                    await page.waitForTimeout(5000);
                    log('Page refreshed, retrying submission.');
                    continue;
                } catch (reloadErr) {
                    log(`Page reload failed: ${reloadErr.message}. Creating new tab...`);
                    try { if (!page.isClosed()) await page.close(); } catch (_) {}
                    try {
                        const ctx = page.context();
                        page = await ctx.newPage();
                        await ctx.grantPermissions(['clipboard-read', 'clipboard-write']);
                        await page.goto(GEMINI_URL_PREFIX, { waitUntil: 'domcontentloaded', timeout: 45000 });
                        await page.waitForTimeout(5000);
                        log('New tab created, retrying.');
                        continue;
                    } catch (newTabErr) {
                        throw Object.assign(
                            new Error('All recovery attempts failed.'),
                            { code: 'ERR_TARGET_CRASHED' }
                        );
                    }
                }
            }
        }
    }

    throw lastError || new Error('All retries exhausted.');
}

// ── Task Queue & Scheduler (v5) ─────────────────────────────────────────────

/**
 * Worker loop — runs in a dedicated tab, dequeuing and processing tasks until
 * the queue is empty. Handles page crashes by recreating the tab.
 */
async function workerLoop(browser, workerId, taskQueue, results, options) {
    let page;
    let tasksProcessed = 0;

    try {
        page = await createWorkerPage(browser);
        await ensureProExtended(page);
        log(`Worker ${workerId}: initialized and ready.`);

        while (taskQueue.length > 0) {
            const task = taskQueue.shift();
            if (!task) break;

            const { index, prompt } = task;
            const workerLabel = `W${workerId}`;
            log(`[${workerLabel}] Processing task #${index} (${prompt.substring(0, 80)}...)`);

            try {
                const response = await submitToGemini(page, prompt, options);
                results[index] = {
                    index,
                    prompt: prompt.substring(0, 200),
                    success: true,
                    response,
                    workerId,
                };
                log(`[${workerLabel}] Task #${index} complete — ${response.length} chars`);
                tasksProcessed++;
            } catch (err) {
                log(`[${workerLabel}] Task #${index} failed: ${err.message}`);
                results[index] = {
                    index,
                    prompt: prompt.substring(0, 200),
                    success: false,
                    error: err.message,
                    code: err.code || 'UNKNOWN',
                    workerId,
                };

                // If page is dead, recreate it for the next task
                if (err.code === 'ERR_TARGET_CRASHED' || (page && page.isClosed())) {
                    log(`[${workerLabel}] Page died, recreating...`);
                    try {
                        page = await createWorkerPage(browser);
                        await ensureProExtended(page);
                        log(`[${workerLabel}] Page recreated successfully.`);
                    } catch (recreateErr) {
                        log(`[${workerLabel}] Page recreation failed: ${recreateErr.message}. Worker exiting.`);
                        break;
                    }
                }

                // If safety rejection or rate limit, don't kill the worker
                // but for rate limit do a longer sleep
                if (err.code === 'ERR_RATE_LIMITED') {
                    log(`[${workerLabel}] Rate limited — sleeping 60s before next task.`);
                    await page.waitForTimeout(60000);
                }
            }

            // Jittered delay between tasks to avoid Google rate limiting
            const delay = JITTER_MIN_MS + Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS);
            log(`[${workerLabel}] Sleeping ${Math.round(delay)}ms before next task...`);
            await page.waitForTimeout(delay);
        }
    } catch (err) {
        log(`Worker ${workerId} fatal error during setup: ${err.message}`);
    } finally {
        // Clean up: close this worker's tab
        if (page && !page.isClosed()) {
            try { await page.close(); } catch (_) {}
        }
        log(`Worker ${workerId} finished — processed ${tasksProcessed} tasks.`);
    }
}

/**
 * runScheduler — spawns N worker tabs, distributes tasks from the queue.
 * Returns results array once all workers complete.
 */
async function runScheduler(browser, tasks, options) {
    const concurrency = Math.min(
        options.concurrency || DEFAULT_CONCURRENCY,
        MAX_CONCURRENCY,
        tasks.length
    );

    // Create a mutable queue (workers dequeue from it)
    const taskQueue = tasks.map(t => ({ ...t })); // shallow copy
    const results = new Array(tasks.length);

    log(`Starting scheduler: ${tasks.length} tasks, ${concurrency} workers.`);
    startTimer('Scheduler');

    const workers = [];
    for (let i = 0; i < concurrency; i++) {
        workers.push(workerLoop(browser, i, taskQueue, results, options));
    }

    await Promise.all(workers);
    stopTimer();

    return results.filter(r => r !== undefined); // remove empty slots
}

// ── CLI Parsing (v5) ────────────────────────────────────────────────────────

function parseArgs(argv) {
    const flags = {
        prompts: [],
        concurrency: DEFAULT_CONCURRENCY,
        timeout: THINKING_TIMEOUT,
        file: null,
        smoke: false,
        doctor: false,
    };

    const positional = [];

    for (let i = 0; i < argv.length; i++) {
        const a = argv[i];

        if (a === '--smoke') {
            flags.smoke = true;
        } else if (a === '--doctor') {
            flags.doctor = true;
        } else if (a.startsWith('--timeout=')) {
            const val = parseInt(a.split('=')[1], 10);
            if (!isNaN(val) && val > 0) flags.timeout = val;
        } else if (a.startsWith('--concurrency=')) {
            const val = parseInt(a.split('=')[1], 10);
            if (!isNaN(val) && val > 0) flags.concurrency = Math.min(val, MAX_CONCURRENCY);
        } else if (a === '--prompt') {
            if (i + 1 < argv.length) {
                flags.prompts.push(argv[i + 1]);
                i++; // consume next arg
            }
        } else if (a.startsWith('--file=')) {
            flags.file = a.split('=')[1];
        } else if (!a.startsWith('-')) {
            positional.push(a);
        }
    }

    return { flags, positional };
}

async function collectTasks(flags, positional) {
    let prompts = [...flags.prompts];

    // Positional args = single prompt
    if (positional.length > 0 && prompts.length === 0) {
        prompts = [positional.join(' ')];
    }

    // --file: read prompts from file (one per line)
    if (flags.file) {
        const fs = require('fs');
        const content = fs.readFileSync(flags.file, 'utf-8');
        const lines = content.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        prompts = prompts.concat(lines);
    }

    // If no prompts yet, try stdin
    if (prompts.length === 0 && !process.stdin.isTTY) {
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        const stdinText = chunks.join('').trim();
        if (stdinText) {
            // Try JSON array first, else treat as single prompt
            try {
                const arr = JSON.parse(stdinText);
                if (Array.isArray(arr)) {
                    prompts = arr.map(s => String(s));
                } else {
                    prompts = [stdinText];
                }
            } catch {
                prompts = [stdinText];
            }
        }
    }

    // Build task list
    const tasks = prompts.map((p, i) => ({ index: i, prompt: p }));
    return tasks;
}

// ── Output Formatting ───────────────────────────────────────────────────────

function outputResults(results, taskCount) {
    if (taskCount === 1 && results.length === 1) {
        // Single prompt: plain text (backward compatible)
        if (results[0].success) {
            console.log(results[0].response);
        } else {
            // Still output the error on stdout for single-prompt mode
            // but also log to stderr
            log(`Task failed: ${results[0].error}`);
            console.log(''); // empty output signals failure
        }
    } else {
        // Multiple prompts: JSON array
        console.log(JSON.stringify(results, null, 2));
    }
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main() {
    const argv = process.argv.slice(2);
    const { flags, positional } = parseArgs(argv);

    // --doctor: check CDP connectivity only (no Chrome tab needed)
    if (flags.doctor) {
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
            log('Run: bash ~/start-chrome-debug.sh');
            process.exit(1);
        }
    }

    // Collect tasks
    const tasks = await collectTasks(flags, positional);

    if (tasks.length === 0 && !flags.smoke) {
        console.error('Usage: node index.js [--timeout=N] [--concurrency=N] [--smoke] [--doctor] [--prompt "q"] ...');
        console.error('       node index.js "single prompt"');
        console.error('       echo \'["q1","q2"]\' | node index.js --concurrency=2');
        console.error('       node index.js --file=prompts.txt --concurrency=3');
        process.exit(1);
    }

    // ── Connect to CDP ──
    let browser;
    const setupStart = Date.now();
    try {
        browser = await connectWithRetry(CDP_URL);
        telemetry.setup_ms = Date.now() - setupStart;

        // ── --smoke: full environment verification (requires page) ──
        if (flags.smoke) {
            log('Running smoke test (full environment verification)...');
            try {
                const smokePage = await createWorkerPage(browser);
                log('Editor found on page.');

                const selectorBtn = smokePage.locator('button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]').first();
                await selectorBtn.waitFor({ state: 'visible', timeout: 5000 });
                log('Model selector found on page.');

                log('Smoke test PASSED — environment is healthy.');
                await smokePage.close().catch(() => {});
                process.exit(0);
            } catch (e) {
                log(`Smoke test FAILED: ${e.message}`);
                process.exit(1);
            }
        }

        // Determine mode
        const isMultiTask = tasks.length > 1;
        telemetry.mode = isMultiTask ? 'multi' : 'single';
        telemetry.task_count = tasks.length;

        if (isMultiTask) {
            // ── Multi-task: use scheduler ──
            telemetry.workers_used = Math.min(flags.concurrency, MAX_CONCURRENCY, tasks.length);
            const results = await runScheduler(browser, tasks, {
                timeout: flags.timeout,
                concurrency: flags.concurrency,
            });
            outputResults(results, tasks.length);

            // Set telemetry from aggregate
            const successCount = results.filter(r => r.success).length;
            const totalChars = results.reduce((sum, r) => sum + (r.response ? r.response.length : 0), 0);
            telemetry.response_length_chars = totalChars;
            log(`Scheduler complete: ${successCount}/${tasks.length} succeeded, ${totalChars} total chars.`);
            recordTelemetry(successCount === tasks.length ? 0 : 4);
        } else {
            // ── Single prompt: classic mode (backward compatible) ──
            const task = tasks[0];
            const context = browser.contexts()[0];
            await context.grantPermissions(['clipboard-read', 'clipboard-write']);

            // Reuse existing tab if available
            const existingPages = context.pages();
            let page;
            for (const pg of existingPages) {
                try {
                    if (pg.isClosed()) continue;
                    const pgUrl = pg.url();
                    if (pgUrl.startsWith(GEMINI_URL_PREFIX) || pgUrl.startsWith(GEMINI_URL_PREFIX_ALT)) {
                        page = pg;
                        log('Reusing existing Gemini tab for single prompt.');
                        break;
                    }
                } catch (e) { /* dead page, skip */ }
            }

            if (!page) {
                page = await createWorkerPage(browser);
            }

            const answer = await submitToGemini(page, task.prompt, { timeout: flags.timeout });
            telemetry.response_length_chars = answer.length;
            console.log(answer);
            recordTelemetry(0);
        }
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
    }
}

main().catch(e => {
    process.stderr.write(`[gemini] unhandled: ${e.message}\n`);
    process.exit(4);
});
