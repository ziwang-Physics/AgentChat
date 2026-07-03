/**
 * Gemini Model Switcher — ensure Pro Extended Thinking is active.
 *
 * v6 (2026-06-28): Fixed Angular CDK overlay rendering delay. After clicking the
 * model selector button, gem-menu-item elements appear in the DOM immediately but
 * their innerText is empty for 200-500ms until Angular zone.js finishes change
 * detection. Playwright's auto-wait only checks visibility, not text content.
 * Added waitForMenuItemsFilled() to poll innerText until populated.
 *
 * This is the CANONICAL implementation — used by WebExtended.
 * Previously duplicated across two files (~300 lines total).
 *
 * Usage:
 *   const { ensureProExtended } = require('../lib/geminiModelSwitch');
 *   const ok = await ensureProExtended(page, maxRetries, onLog);
 */

const MAX_RETRIES = 2;

// BUGFIX: the model-selector button query already matched both Traditional
// ('模式挑選器') and Simplified ('模式选择器') Chinese labels, but the checks that
// decide *whether Extended/Pro is already active* only ever tested the
// Traditional forms ('延長' / '進階' / '標準'). On a Simplified Chinese UI those
// checks never matched, so ensureProExtended() would loop until maxRetries and
// report ERR_MODEL_DEGRADED even when Extended was already active. Centralize
// both variants here so every call site stays in sync.
function includesExtended(t) {
    return t.includes('延長') || t.includes('延长') || t.includes('扩展') || t.includes('Extended');
}
function includesAdvanced(t) {
    return t.includes('進階') || t.includes('进阶');
}
function includesStandard(t) {
    return t.includes('標準') || t.includes('标准');
}

// Helper: wait for menu items to have actual text content (Angular CDK overlay fix)
async function waitForMenuItemsFilled(page, timeoutMs = 5000) {
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
}

/**
 * Switch Gemini to Pro + Extended Thinking mode. Idempotent — skips if already active.
 *
 * @param {Page} page — Playwright page on gemini.google.com
 * @param {number} [maxRetries=2]
 * @param {(msg: string) => void} [onLog] — log callback (default: silent)
 * @returns {Promise<boolean>} true if Pro Extended is active
 */
async function ensureProExtended(page, maxRetries = MAX_RETRIES, onLog) {
    const log = onLog || (() => {});

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

        // Check current mode via aria-label (authoritative, not textContent)
        const currentAria = await page.evaluate(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
            );
            return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
        });
        log(`gemini attempt ${attempt}: current mode = "${currentAria}"`);

        if (includesExtended(currentAria)) {
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
            log('gemini WARN: Model selector button not found. UI may have changed.');
            continue;
        }

        // Wait for menu + Angular CDK overlay to finish rendering text
        try {
            await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
        } catch {
            log('gemini WARN: Menu [role="menu"] did not appear. Trying gem-menu-item fallback...');
        }

        if (!(await waitForMenuItemsFilled(page))) {
            log('gemini WARN: Menu items never got innerText (Angular CDK rendering timeout).');
            continue;
        }

        // Step 2: Ensure Pro model (skip Flash variants)
        const modeIsPro = currentAria.includes('Pro') && !currentAria.includes('Flash');
        if (!modeIsPro) {
            log('gemini: switching to Pro model');
            try {
                const proIdx = await page.evaluate(() => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (t.includes('Pro') && (t.includes('進階') || t.includes('进阶') || t.includes('高等数学')) && !t.includes('Flash')) return i;
                    }
                    return -1;
                });
                if (proIdx < 0) throw new Error('Pro item not found');

                await page.locator('gem-menu-item, [role="menuitem"]').nth(proIdx).click();
                await page.waitForTimeout(2000);

                // Model switch often closes menu — reopen for thinking level
                const selectorBtn2 = page.locator(
                    'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
                ).first();
                await selectorBtn2.click();
                await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
                if (!(await waitForMenuItemsFilled(page))) {
                    log('gemini WARN: Menu items after Pro switch never filled.');
                    continue;
                }
            } catch {
                log('gemini WARN: Failed to switch to Pro model.');
                continue;
            }
        }

        // Step 3: Expand thinking level submenu
        let extendedIdx = await page.evaluate(() => {
            const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
            for (let i = 0; i < items.length; i++) {
                const t = items[i].innerText || '';
                if ((t.includes('延長') || t.includes('延长') || t.includes('扩展') || t.includes('Extended')) &&
                    !t.includes('思考') && !t.includes('Thought') &&
                    items[i].offsetParent !== null) {
                    return i;
                }
            }
            return -1;
        });

        if (extendedIdx < 0) {
            log('gemini: expanding thinking-level choices');
            try {
                const thinkIdx = await page.evaluate(() => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if ((t.includes('思考程度') || t.includes('思考等级') || t.includes('Thinking') || t.includes('Thought')) &&
                            items[i].offsetParent !== null) return i;
                    }
                    return -1;
                });
                if (thinkIdx < 0) throw new Error('Thinking level item not found');

                await page.locator('gem-menu-item, [role="menuitem"]').nth(thinkIdx).click();
                await page.waitForTimeout(2000);

                // Re-query: now the L1 "延長" item should be visible
                extendedIdx = await page.evaluate(() => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if ((t.includes('延長') || t.includes('延长') || t.includes('扩展') || t.includes('Extended')) &&
                            !t.includes('標準') && !t.includes('标准') && items[i].offsetParent !== null) return i;
                    }
                    return -1;
                });
                if (extendedIdx < 0) throw new Error('Extended option not found after expanding');
            } catch {
                log('gemini WARN: Could not expand thinking level menu.');
                continue;
            }
        } else {
            log('gemini: Extended thinking option already visible (partial state handled).');
        }

        // Step 4: Click Extended
        try {
            await page.locator('gem-menu-item, [role="menuitem"]').nth(extendedIdx).click();
            log('gemini: selected Extended thinking');
        } catch {
            log('gemini WARN: Extended button not clickable.');
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
            return aria.includes('延長') || aria.includes('延长') || aria.includes('扩展') || aria.includes('Extended');
        }, null, { timeout: 5000 }).catch(() => false);

        if (isActive) {
            log('gemini: Verified Pro Extended Thinking active.');
            return true;
        }

        log('gemini: final mode not confirmed as Pro Extended.');
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
    const currentAria = await page.evaluate(() => {
        const btn = document.querySelector(
            'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
        );
        return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
    });

    if (currentAria.includes('Flash')) {
        log('gemini: Flash model already active');
        return true;
    }

    // Step 1: Open model selector
    try {
        const btn = page.locator(
            'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
        ).first();
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.click();
    } catch {
        log('gemini WARN: Cannot open model selector for Flash switch.');
        return false;
    }

    // Wait for menu to render
    try {
        await page.locator('[role="menu"]').waitFor({ state: 'visible', timeout: 5000 });
    } catch {
        log('gemini WARN: Menu did not appear.');
        return false;
    }

    if (!(await waitForMenuItemsFilled(page))) {
        log('gemini WARN: Menu items never filled for Flash switch.');
        return false;
    }

    // Step 2: Find and click Flash (prefer "3.5 Flash" over "3.1 Flash-Lite")
    // Flash menu items contain "Flash" but NOT "Pro"
    // Prioritize the non-Lite variant: "3.5 Flash" > "3.1 Flash-Lite"
    const flashIdx = await page.evaluate(() => {
        const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
        // First pass: look for "Flash" without "Lite"
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
    });

    if (flashIdx < 0) {
        log('gemini WARN: Flash menu item not found.');
        await page.keyboard.press('Escape');
        return false;
    }

    try {
        await page.locator('gem-menu-item, [role="menuitem"]').nth(flashIdx).click();
        log('gemini: selected Flash model');
    } catch {
        log('gemini WARN: Flash menu item not clickable.');
        await page.keyboard.press('Escape');
        return false;
    }

    // Step 3: Ensure thinking level is Standard (not Extended, because Flash doesn't support it)
    await page.waitForTimeout(1500);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);

    // Verify Flash is active
    const finalAria = await page.evaluate(() => {
        const btn = document.querySelector(
            'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"], button[aria-label*="模式选择器"]'
        );
        return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
    });

    if (finalAria.includes('Flash')) {
        log(`gemini: Verified Flash model active (${finalAria}).`);
        return true;
    }

    log(`gemini: Flash switch not confirmed. Current: "${finalAria}"`);
    return false;
}

module.exports = { ensureProExtended, ensureFlash, waitForMenuItemsFilled };
