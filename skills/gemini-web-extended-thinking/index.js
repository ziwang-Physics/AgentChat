#!/usr/bin/env node
/**
 * Gemini Web Extended Thinking — Playwright/CDP bridge.
 *
 * Connects to Chrome Debug (port 9222), switches Gemini to Pro Extended Thinking,
 * submits a prompt via keyboard.insertText(), and returns the response as stdout.
 *
 * Usage:
 *   node index.js "Your prompt here"
 *   echo "Prompt from stdin" | node index.js
 *
 * Error codes:
 *   1 - Chrome debug not running or Gemini tab not found
 *   2 - Pro Extended mode failed to activate (degraded to standard)
 *   3 - Prompt rejected by Gemini safety filter
 *   4 - Response timeout or empty
 */

const { chromium } = require('playwright');

// ── Config ──────────────────────────────────────────────────────────────────
const CDP_URL = 'http://127.0.0.1:9222';
const GEMINI_URL_PREFIX = 'https://gemini.google.com/u/0/app';
const MAX_RETRIES = 2;
const THINKING_TIMEOUT = 600_000; // 10 min for complex reasoning
const RESPONSE_POLL_INTERVAL = 2000; // ms

// ── Helpers ─────────────────────────────────────────────────────────────────

function log(msg) { process.stderr.write(`[gemini] ${msg}\n`); }

/**
 * ensureProExtended — switches Gemini to Pro + Extended Thinking.
 *
 * Current Gemini UI flow (2025-06):
 *   1. Click model selector button (aria-label matches "模式挑選器" / "Model selector")
 *   2. Ensure "Pro" model is active (not Flash/Flash-Lite)
 *   3. Click "思考程度" menu item to expand thinking-level choices
 *   4. Click "延長" / "Extended" in the expanded choices
 *   5. Close menu, verify button text shows "Pro延長" or "Pro Extended"
 *
 * Returns true if Pro Extended is active, false after exhausting retries.
 */
async function ensureProExtended(page, maxRetries = MAX_RETRIES) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            log(`retry ${attempt}/${maxRetries} — reloading page`);
            try { await page.reload(); await page.waitForTimeout(5000); } catch (_) {}
        }

        // Dismiss any open overlays
        await page.evaluate(() => {
            document.body.click();
            document.querySelectorAll('.cdk-overlay-backdrop').forEach(el => el.remove());
        });
        await page.waitForTimeout(500);

        // Check current mode from the selector button text
        const currentMode = await page.evaluate(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            return btn ? btn.textContent.trim() : 'UNKNOWN';
        });
        log(`attempt ${attempt}: current mode = "${currentMode}"`);

        if (currentMode.includes('Pro延長') || currentMode.includes('Pro Extended')) {
            log('Pro Extended Thinking already active');
            return true;
        }

        // Step 1: open model selector
        const selectorPattern = /模式挑選器|Model selector|模式选择器/;
        await page.evaluate((pattern) => {
            for (const btn of document.querySelectorAll('button')) {
                if (pattern.test(btn.getAttribute('aria-label') || '')) {
                    btn.click();
                    return;
                }
            }
        }, selectorPattern);
        await page.waitForTimeout(2000);

        // Step 2: ensure Pro model (skip Flash variants)
        if (!currentMode.includes('Pro') || currentMode.includes('Flash')) {
            log('switching to Pro model');
            await page.evaluate(() => {
                for (const el of document.querySelectorAll('[role="menuitem"]')) {
                    const text = el.textContent || '';
                    if (text.includes('Pro') && !text.includes('Flash')) {
                        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                        return;
                    }
                }
            });
            await page.waitForTimeout(2000);
        }

        // Step 3: click "思考程度" / "Thought" to expand thinking options
        log('expanding thinking-level choices');
        await page.evaluate(() => {
            for (const el of document.querySelectorAll('[role="menuitem"]')) {
                if (el.textContent.includes('思考') || el.textContent.includes('Thought')) {
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return;
                }
            }
        });
        await page.waitForTimeout(2000);

        // Step 4: click "延長" / "Extended" (the standalone choice, not the parent)
        log('selecting Extended thinking');
        await page.evaluate(() => {
            for (const el of document.querySelectorAll('[role="menuitem"]')) {
                const text = el.textContent || '';
                if ((text.includes('延長') || /Extended/i.test(text)) &&
                    !text.includes('思考') && !/Thought/i.test(text)) {
                    el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
                    return;
                }
            }
        });
        await page.waitForTimeout(2000);

        // Step 5: close menu and verify
        await page.evaluate(() => {
            document.body.click();
            document.querySelectorAll('.cdk-overlay-backdrop').forEach(el => el.remove());
        });
        await page.waitForTimeout(1000);

        const finalMode = await page.evaluate(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            return btn ? btn.textContent.trim() : 'UNKNOWN';
        });
        log(`final mode = "${finalMode}"`);

        if (finalMode.includes('Pro延長') || finalMode.includes('Pro Extended')) {
            return true;
        }
    }
    return false;
}

/**
 * waitForResponse — polls the latest model response until it stabilizes.
 *
 * Strategy: wait for the "Stop" button to disappear (thinking complete),
 * then poll .model-response-text until the last entry's text is stable for 3 consecutive polls.
 * Falls back to a max-wait loop if the Stop button never appears.
 */
async function waitForResponse(page, maxWaitSec = 180) {
    let lastLen = 0;
    let stable = 0;

    for (let i = 0; i < maxWaitSec; i++) {
        await page.waitForTimeout(RESPONSE_POLL_INTERVAL);
        const current = await page.evaluate(() => {
            const rs = document.querySelectorAll('.model-response-text');
            return rs.length > 0 ? rs[rs.length - 1].textContent : null;
        });

        if (!current) {
            process.stderr.write('.');
            continue;
        }

        if (current.length > lastLen) {
            lastLen = current.length;
            stable = 0;
            process.stderr.write('+');
        } else if (current.length === lastLen && lastLen > 0) {
            if (++stable >= 3) break; // 6 s of no change → done
            process.stderr.write('s');
        }
    }

    const final = await page.evaluate(() => {
        const rs = document.querySelectorAll('.model-response-text');
        return rs.length > 0 ? rs[rs.length - 1].textContent : null;
    });
    log(`response complete, length = ${final ? final.length : 0}`);
    return final;
}

// ── Main Submission ─────────────────────────────────────────────────────────

/**
 * submitToGemini — full pipeline: ensure mode → type prompt → send → wait → return.
 *
 * @param {import('playwright').Page} page — Gemini tab page object
 * @param {string} message — prompt text
 * @param {{ timeout?: number, retries?: number }} options
 * @returns {Promise<string>} Gemini's response text
 */

async function submitToGemini(page, message, options = {}) {
    const timeout = options.timeout || THINKING_TIMEOUT;
    const retries = options.retries || MAX_RETRIES;
    let lastError = null;

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

            // ── 2. Type prompt into Gemini's Quill editor ──
            // Click editor, select all, clear
            await page.click('.ql-editor');
            await page.keyboard.press('ControlOrMeta+a');
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            // Use insertText for reliable Angular change-detection trigger
            // (avoids clipboard flakiness with background CDP tabs)
            await page.bringToFront();
            await page.evaluate(() => window.focus());
            await page.keyboard.insertText(message);
            await page.waitForTimeout(500);

            // Trigger Angular with a space-then-delete (belt-and-suspenders with insertText)
            await page.keyboard.type(' ');
            await page.keyboard.press('Backspace');
            await page.waitForTimeout(300);

            // ── 3. Send ──
            const sendBtn = page.locator(
                'button[aria-label*="傳送"], button[aria-label*="发送"], button[aria-label*="Send"]'
            );
            try {
                await sendBtn.waitFor({ state: 'visible', timeout: 5000 });
                await sendBtn.click();
            } catch {
                // Fallback: Ctrl+Enter if Angular didn't mount the button
                log('send button not found, falling back to Ctrl+Enter');
                await page.evaluate(() => document.querySelector('.ql-editor')?.focus());
                await page.keyboard.press('ControlOrMeta+Enter');
            }

            // ── 4. Wait for thinking to complete ──
            log('waiting for thinking phase...');
            const stopBtn = page.locator(
                'button[aria-label*="停止"], button[aria-label*="Stop"]'
            );
            try {
                await stopBtn.waitFor({ state: 'visible', timeout: 15000 });
                log('thinking started');
                await stopBtn.waitFor({ state: 'hidden', timeout });
                log('thinking finished');
            } catch (_) {
                log('no visible thinking phase (may be a short answer)');
            }

            // ── 5. Collect response ──
            const response = await waitForResponse(page, Math.ceil(timeout / RESPONSE_POLL_INTERVAL));
            if (!response || response.length < 10) {
                // Check for safety rejection
                const maybeRejected = await page.evaluate(() => {
                    const el = document.querySelector('.model-response-text');
                    return el?.textContent || '';
                });
                if (maybeRejected && /can'?t help|unable to|against policy/i.test(maybeRejected)) {
                    throw Object.assign(
                        new Error('Gemini rejected the prompt (safety filter)'),
                        { code: 'ERR_SAFETY_REJECTED' }
                    );
                }
                throw new Error('Response empty or too short');
            }

            return response;

        } catch (error) {
            lastError = error;
            log(`attempt ${attempt} failed: ${error.message}`);

            // Don't retry safety rejections
            if (error.code === 'ERR_SAFETY_REJECTED') throw error;

            if (attempt < retries) {
                try { await page.reload(); await page.waitForTimeout(5000); } catch (_) {}
            }
        }
    }

    throw lastError || new Error('All retries exhausted');
}

// ── CLI Entry Point ─────────────────────────────────────────────────────────

async function main() {
    // Read prompt from argv or stdin
    let prompt = process.argv.slice(2).join(' ').trim();
    if (!prompt) {
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        prompt = chunks.join('').trim();
    }
    if (!prompt) {
        console.error('Usage: node index.js "Your prompt"  or  echo "prompt" | node index.js');
        process.exit(1);
    }

    // Connect to Chrome
    let browser;
    try {
        browser = await chromium.connectOverCDP(CDP_URL);
    } catch {
        log('FATAL: Cannot connect to Chrome debug on ' + CDP_URL);
        log('Start Chrome with: bash scripts/start-chrome-debug.sh');
        process.exit(1);
    }

    await browser.contexts()[0].grantPermissions(['clipboard-read', 'clipboard-write']);

    const page = browser.contexts()[0].pages()
        .find(p => p.url().startsWith(GEMINI_URL_PREFIX) && !p.url().includes('RotateCookies'));

    if (!page) {
        log('FATAL: No Gemini tab found. Run: bash scripts/connect-gemini.sh');
        await browser.close();
        process.exit(1);
    }

    try {
        const answer = await submitToGemini(page, prompt);
        // Output clean response to stdout
        console.log(answer);
    } catch (error) {
        log(`FATAL: ${error.message}`);
        if (error.code === 'ERR_MODEL_DEGRADED') process.exit(2);
        if (error.code === 'ERR_SAFETY_REJECTED') process.exit(3);
        process.exit(4);
    } finally {
        await browser.close(); // CDP: disconnects, does NOT kill Chrome
    }
}

main().catch(e => {
    process.stderr.write(`[gemini] unhandled: ${e.message}\n`);
    process.exit(4);
});
