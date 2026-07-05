/**
 * Gemini Model Switcher — ensure Pro Extended Thinking is active.
 *
 * v7 (2026-07-05): Angular redesign compatibility
 *   - New model selector button: data-test-id="bard-mode-menu-button"
 *   - aria-label changed from "Model selector" to "Open mode picker, currently X"
 *   - Model options renamed: "3.1 Pro" instead of old naming
 *   - Thinking level moved to submenu: click "Thinking level" → select "Extended"
 *
 * This is the CANONICAL implementation — used by WebExtended.
 *
 * Usage:
 *   const { ensureProExtended } = require('../lib/geminiModelSwitch');
 *   const ok = await ensureProExtended(page, maxRetries, onLog);
 */

const MAX_RETRIES = 2;

// ── Selector helpers (single source of truth) ──

/** CSS selector for the model toggle button (supports old + new UI) */
function modelBtnSelector() {
    return '[data-test-id="bard-mode-menu-button"] button, button[aria-label*="mode picker"], button[aria-label*="Model selector"], button[aria-label*="模式挑选器"], button[aria-label*="模式选择器"]';
}

/** CSS selector for menu items (gem-menu-item for new UI + role fallback for old) */
function menuItemSelector() {
    return 'gem-menu-item, [role="menuitem"], [role="menuitemradio"]';
}

// ── Text detection helpers ──

function includesExtended(t) {
    return t.includes('延長') || t.includes('延长') || t.includes('扩展') || t.includes('Extended');
}

// Helper: wait for menu items to have actual text content (Angular CDK overlay fix)
async function waitForMenuItemsFilled(page, timeoutMs = 5000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const count = await page.evaluate((sel) => {
            const items = document.querySelectorAll(sel);
            let filled = 0;
            for (const el of items) {
                if ((el.innerText || '').trim().length > 0) filled++;
            }
            return filled;
        }, menuItemSelector());
        if (count >= 2) return true;
        await page.waitForTimeout(200);
    }
    return false;
}

/**
 * Get the current mode from the model selector button.
 * Returns the button's innerText (e.g. "GeminiFlash", "3.1Pro") or 'UNKNOWN'.
 */
async function getCurrentMode(page) {
    return await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        if (!btn) return 'UNKNOWN';
        // Try aria-label first, then innerText
        const aria = btn.getAttribute('aria-label') || '';
        if (aria.includes('currently')) {
            // New UI: "Open mode picker, currently Gemini Flash"
            const m = aria.match(/currently\s+(.+?)$/i);
            if (m) return m[1].trim();
        }
        return aria || (btn.innerText || '').trim();
    }, modelBtnSelector());
}

/**
 * Open the model selector menu.
 */
async function openModelMenu(page, log) {
    try {
        const btn = page.locator(modelBtnSelector()).first();
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.click();
        await page.waitForTimeout(1000);
        return true;
    } catch {
        log('gemini WARN: Model selector button not found. UI may have changed.');
        return false;
    }
}

/**
 * Wait for model menu to render its items.
 */
async function waitForMenu(page, log) {
    try {
        await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        log('gemini WARN: Menu [role="menu"] did not appear. Trying fallback...');
    }
    if (!(await waitForMenuItemsFilled(page))) {
        log('gemini WARN: Menu items never got innerText (Angular CDK rendering timeout).');
        return false;
    }
    return true;
}

/**
 * Expand the "Thinking level" submenu and select "Extended".
 * Returns true if Extended was successfully selected.
 */
async function selectExtendedThinking(page, log) {
    // Find "Thinking level" item and click it to expand
    const thinkIdx = await page.evaluate((sel) => {
        const items = document.querySelectorAll(sel);
        for (let i = 0; i < items.length; i++) {
            const t = items[i].innerText || '';
            if ((t.includes('思考程度') || t.includes('思考等级') || t.includes('Thinking') || t.includes('Thought') || t.includes('Thinking level')) &&
                items[i].offsetParent !== null) return i;
        }
        return -1;
    }, menuItemSelector());

    if (thinkIdx < 0) {
        log('gemini: Thinking level item not found in menu');
        return false;
    }

    await page.locator(menuItemSelector()).nth(thinkIdx).click();
    await page.waitForTimeout(1500);

    // Now look for "Extended" in the expanded submenu
    const extIdx = await page.evaluate((sel) => {
        const items = document.querySelectorAll(sel);
        for (let i = 0; i < items.length; i++) {
            const t = items[i].innerText || '';
            if ((t.includes('Extended') || t.includes('延长') || t.includes('延長')) &&
                !t.includes('Standard') && !t.includes('标准') && !t.includes('标准') &&
                items[i].offsetParent !== null) {
                return i;
            }
        }
        return -1;
    }, menuItemSelector());

    if (extIdx < 0) {
        log('gemini: Extended thinking option not found in submenu');
        return false;
    }

    try {
        await page.locator(menuItemSelector()).nth(extIdx).click();
        log('gemini: selected Extended thinking');
        await page.waitForTimeout(1000);
        return true;
    } catch {
        log('gemini WARN: Extended button not clickable.');
        return false;
    }
}

// ═══════════════════════════════════════════════════════════════════
// Public API
// ═══════════════════════════════════════════════════════════════════

/**
 * Check if the Gemini account has a Pro subscription.
 * Looks for signs of free-tier (upgrade prompts, "Get Advanced" etc.)
 * @returns {Promise<boolean>} true if the account has Pro access
 */
async function hasProSubscription(page) {
    // Check for upgrade/subscribe prompts visible on the page
    const result = await page.evaluate(() => {
        const text = document.body.innerText || '';
        // Signs of FREE account (no Pro access)
        const freeSignals = [
            /upgrade\s+to\s+(?:gemini\s+)?advanced/i,
            /get\s+(?:gemini\s+)?advanced/i,
            /try\s+(?:gemini\s+)?advanced/i,
            /subscribe\s+to\s+gemini/i,
            /升级到/i,
            /获取.*高级/i,
        ];
        for (const pat of freeSignals) {
            if (pat.test(text)) return false;
        }

        // Signs of Pro access — "Gemini Advanced" badge, or Pro model already active
        const proSignals = [
            /gemini\s+advanced/i,
            /pro\s+subscription/i,
        ];
        for (const pat of proSignals) {
            if (pat.test(text)) return true;
        }

        // Look for an "Upgrade" button in the model selector or nav
        const upgradeBtns = document.querySelectorAll(
            'button[aria-label*="upgrade" i], button[aria-label*="subscribe" i], a[href*="advanced"], a[href*="subscribe"], [data-test-id*="upgrade"]'
        );
        if (upgradeBtns.length > 0) return false;

        // Default: assume free tier (safest — avoid Pro that would fail silently)
        return false;
    });
    return result;
}

/**
 * Switch Gemini to Pro + Extended Thinking mode. Idempotent — skips if already active.
 * NOTE: Only works with a paid Gemini Advanced/Pro subscription.
 * Free accounts will fall through to ensureFlash().
 *
 * @param {Page} page — Playwright page on gemini.google.com
 * @param {number} [maxRetries=2]
 * @param {(msg: string) => void} [onLog] — log callback (default: silent)
 * @returns {Promise<boolean>} true if Pro Extended is active
 */
async function ensureProExtended(page, maxRetries = MAX_RETRIES, onLog) {
    const log = onLog || (() => {});

    // Quick check: does this account even have Pro access?
    const hasPro = await hasProSubscription(page);
    if (!hasPro) {
        log('gemini: No Pro subscription detected — skipping Pro Extended');
        return false;
    }

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
        if (attempt > 0) {
            log(`gemini: retry ${attempt}/${maxRetries} — reloading page`);
            try {
                const currentUrl = page.url();
                await page.goto(currentUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
                await page.waitForTimeout(3000);
            } catch (_) {}
        }

        // Dismiss any open overlays
        await page.keyboard.press('Escape');
        await page.waitForTimeout(500);

        // Check current mode via button text
        const currentMode = await getCurrentMode(page);
        log(`gemini attempt ${attempt}: current mode = "${currentMode}"`);

        // Check if Extended is already active
        if (includesExtended(currentMode)) {
            log('gemini: Pro Extended Thinking already active');
            return true;
        }

        // Step 1: Open model selector
        if (!(await openModelMenu(page, log))) continue;
        if (!(await waitForMenu(page, log))) continue;

        // Step 2: Ensure Pro model (skip Flash variants)
        const isPro = currentMode.includes('Pro') && !currentMode.includes('Flash');
        if (!isPro) {
            log('gemini: switching to Pro model');
            try {
                const proIdx = await page.evaluate((sel) => {
                    const items = document.querySelectorAll(sel);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        // New UI: "3.1 Pro\nAdvanced math and code"
                        // Old UI: "Pro" + "進階"/"进阶"/"高等数学"
                        if (t.includes('Pro') && !t.includes('Flash')) return i;
                    }
                    return -1;
                }, menuItemSelector());

                if (proIdx < 0) throw new Error('Pro item not found');

                await page.locator(menuItemSelector()).nth(proIdx).click();
                await page.waitForTimeout(2000);

                // Model switch often closes menu — reopen for thinking level
                if (!(await openModelMenu(page, log))) continue;
                if (!(await waitForMenu(page, log))) continue;
            } catch (e) {
                log(`gemini WARN: Failed to switch to Pro model. ${e.message}`);
                continue;
            }
        }

        // Step 3: Select Extended Thinking (new submenu-based UI)
        if (!(await selectExtendedThinking(page, log))) {
            continue;
        }

        // Step 4: Close menu and verify
        await page.keyboard.press('Escape');
        await page.locator('.cdk-overlay-backdrop').waitFor({ state: 'hidden', timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(1000);

        // Verify via button text
        const finalMode = await getCurrentMode(page);
        if (includesExtended(finalMode)) {
            log('gemini: Verified Pro Extended Thinking active.');
            return true;
        }

        log(`gemini: final mode not confirmed as Pro Extended (got "${finalMode}").`);
    }
    return false;
}

/**
 * Switch Gemini to Flash model with standard thinking (free tier).
 * Used as fallback when Pro Extended is unavailable (no subscription).
 *
 * @param {Page} page — Playwright page on gemini.google.com
 * @param {(msg: string) => void} [onLog] — log callback
 * @returns {Promise<boolean>} true if Flash model is active
 */
async function ensureFlash(page, onLog) {
    const log = onLog || (() => {});

    // Check if Flash is already active
    const currentMode = await getCurrentMode(page);
    if (currentMode.includes('Flash')) {
        log('gemini: Flash model already active');
        return true;
    }

    // Step 1: Open model selector
    if (!(await openModelMenu(page, log))) return false;
    if (!(await waitForMenu(page, log))) return false;

    // Step 2: Find and click Flash (prefer non-Lite variant)
    const flashIdx = await page.evaluate((sel) => {
        const items = document.querySelectorAll(sel);
        // First pass: look for "Flash" without "Lite" — prefer "3.5 Flash"
        for (let i = 0; i < items.length; i++) {
            const t = items[i].innerText || '';
            if (t.includes('Flash') && !t.includes('Lite') && !t.includes('极速')) return i;
        }
        // Second pass: accept Flash-Lite as fallback
        for (let i = 0; i < items.length; i++) {
            const t = items[i].innerText || '';
            if (t.includes('Flash') && !t.includes('Pro')) return i;
        }
        return -1;
    }, menuItemSelector());

    if (flashIdx < 0) {
        log('gemini WARN: Flash menu item not found.');
        await page.keyboard.press('Escape');
        return false;
    }

    try {
        await page.locator(menuItemSelector()).nth(flashIdx).click();
        log('gemini: selected Flash model');
    } catch {
        log('gemini WARN: Flash menu item not clickable.');
        await page.keyboard.press('Escape');
        return false;
    }

    // Step 3: Ensure thinking level is Standard (Flash doesn't support Extended)
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify Flash is active
    const finalMode = await getCurrentMode(page);
    if (finalMode.includes('Flash')) {
        log(`gemini: Verified Flash model active (${finalMode}).`);
        return true;
    }

    log(`gemini: Flash switch not confirmed. Current: "${finalMode}"`);
    return false;
}

module.exports = { ensureProExtended, ensureFlash, waitForMenuItemsFilled };
