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

// v7: 选择器集中管理。所有语言相关文本从 locales/gemini.js 读取，
// 不再硬编码任何 zh-TW / zh-CN / en / ja 关键字。
// 新增语言只需在 locales/gemini.js 追加一个 profile。
const L = require('./locales/gemini');

// ── txt() normalization ──────────────────────────────────────────────────────
// P0 FIX (profile-mode type confusion): L.txt(key) returns a plain STRING when
// an exact locale profile is active (e.g. '扩展' after detectLocale() maps
// navigator.language zh-CN → zh_CN) and a RegExp ONLY in fuzzy-fallback mode.
// This file used RegExp-only APIs on that value unconditionally:
//   - includesExtended(t) → TypeError ('扩展'.test is not a function) the moment
//     locale detection SUCCEEDS — thrown out of ensureProExtended, through the
//     gemini adapter's preInputHook, failing the ENTIRE Gemini provider at
//     PRE_EDITOR. Fuzzy mode (detection failure) was the only path that worked.
//   - _re.source / _re.flags on a string → undefined → new RegExp(undefined)
//     inside page.evaluate is /(?:)/ (matches EVERYTHING), so profile-mode menu
//     matching degenerated: `extRe.test(t) && !thinkRe.test(t)` is always false,
//     and the submenu-expansion path clicked the first arbitrary menu item.
// asRe() converts either form to a case-insensitive RegExp; profile strings are
// literal UI text, so regex metacharacters are escaped.
const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const asRe = (v) => (v instanceof RegExp ? v : new RegExp(escapeRe(v), 'i'));

// locale-aware helpers — delegate to the profiles loaded above
const includesExtended  = (t) => asRe(L.txt('extended')).test(t);
const includesStandard  = (t) => asRe(L.txt('standard')).test(t);
// Pro model check: innerText 含 "Pro" 且含当前 locale 的 proDesc
const proDesc           = () => asRe(L.txt('proDesc'));
const modelBtnSelector  = () => L.modelBtnCSS();

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

    // Auto-detect Gemini UI locale on first call
    if (!L.locale) {
        const detected = await L.detectLocale(page);
        L.setLocale(detected);
        if (detected) log(`gemini: detected locale ${detected}`);
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

        // Check current mode via aria-label (authoritative, not textContent)
        const _mbs = modelBtnSelector();
        const currentAria = await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
        }, _mbs);
        log(`gemini attempt ${attempt}: current mode = "${currentAria}"`);

        if (includesExtended(currentAria)) {
            log('gemini: Pro Extended Thinking already active');
            return true;
        }

        // Step 1: Open model selector
        try {
            const selectorBtn = page.locator(
                modelBtnSelector()
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
                const _pd = proDesc();
                const proIdx = await page.evaluate((pd) => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    const re = new RegExp(pd.source, pd.flags);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (t.includes('Pro') && re.test(t) && !t.includes('Flash')) return i;
                    }
                    return -1;
                }, { source: _pd.source, flags: _pd.flags });
                if (proIdx < 0) throw new Error('Pro item not found');

                await page.locator('gem-menu-item, [role="menuitem"]').nth(proIdx).click();
                await page.waitForTimeout(2000);

                // Model switch often closes menu — reopen for thinking level
                const selectorBtn2 = page.locator(
                    modelBtnSelector()
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
        const _extRe = asRe(L.txt('extended')); const _thinkRe = asRe(L.txt('thinking'));
        let extendedIdx = await page.evaluate(({extSrc, extFlags, thinkSrc, thinkFlags}) => {
            const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
            const extRe = new RegExp(extSrc, extFlags);
            const thinkRe = new RegExp(thinkSrc, thinkFlags);
            for (let i = 0; i < items.length; i++) {
                const t = items[i].innerText || '';
                if (extRe.test(t) && !thinkRe.test(t) && items[i].offsetParent !== null) return i;
            }
            return -1;
        }, {extSrc: _extRe.source, extFlags: _extRe.flags, thinkSrc: _thinkRe.source, thinkFlags: _thinkRe.flags});

        if (extendedIdx < 0) {
            log('gemini: expanding thinking-level choices');
            try {
                const _tr = asRe(L.txt('thinking'));
                const thinkIdx = await page.evaluate(({thinkSrc, thinkFlags}) => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    const re = new RegExp(thinkSrc, thinkFlags);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (re.test(t) && items[i].offsetParent !== null) return i;
                    }
                    return -1;
                }, {thinkSrc: _tr.source, thinkFlags: _tr.flags});
                if (thinkIdx < 0) throw new Error('Thinking level item not found');

                await page.locator('gem-menu-item, [role="menuitem"]').nth(thinkIdx).click();
                await page.waitForTimeout(2000);

                // Re-query: Extended should now be visible in submenu
                const _ext2 = asRe(L.txt('extended')); const _std2 = asRe(L.txt('standard'));
                extendedIdx = await page.evaluate(({extSrc, extFlags, stdSrc, stdFlags}) => {
                    const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
                    const extRe = new RegExp(extSrc, extFlags);
                    const stdRe = new RegExp(stdSrc, stdFlags);
                    for (let i = 0; i < items.length; i++) {
                        const t = items[i].innerText || '';
                        if (extRe.test(t) && !stdRe.test(t) && items[i].offsetParent !== null) return i;
                    }
                    return -1;
                }, {extSrc: _ext2.source, extFlags: _ext2.flags, stdSrc: _std2.source, stdFlags: _std2.flags});
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
        //
        // P0 FIX (browser-context closure capture): the old predicate called
        // modelBtnSelector() and includesExtended() INSIDE waitForFunction —
        // Playwright serializes the predicate and runs it in the PAGE, where
        // neither Node-scope function exists. The very first evaluation threw
        // ReferenceError, waitForFunction rejected, and the .catch collapsed it
        // to false: verification could NEVER succeed, burning every retry
        // (success was only ever detected by the NEXT attempt's top-of-loop
        // aria check, after a wasteful page reload). Selector and pattern are
        // now serialized in as arguments.
        const _vSel = modelBtnSelector();
        const _vExt = asRe(L.txt('extended'));
        const isActive = await page.waitForFunction(({ sel, extSrc, extFlags }) => {
            const btn = document.querySelector(sel);
            if (!btn) return false;
            const aria = btn.getAttribute('aria-label') || btn.textContent || '';
            return new RegExp(extSrc, extFlags).test(aria);
        }, { sel: _vSel, extSrc: _vExt.source, extFlags: _vExt.flags }, { timeout: 5000 }).catch(() => false);

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

    // Auto-detect locale if not yet set
    if (!L.locale) {
        const detected = await L.detectLocale(page);
        L.setLocale(detected);
        if (detected) log(`gemini: detected locale ${detected}`);
    }

    // Check if Flash is already active
    //
    // P0 FIX (browser-context closure capture): modelBtnSelector() was called
    // INSIDE page.evaluate — undefined in the page, so the evaluate rejected
    // with ReferenceError on every call. Unlike Step 5's swallowed variant,
    // this one was UNCAUGHT: ensureFlash threw, the gemini adapter's Tier-2
    // Flash fallback died before doing anything, and the factory classified it
    // as a PRE_EDITOR error. Net effect: the documented Pro→Flash degradation
    // tier was dead code — free-tier users could never use Gemini at all; the
    // chain always skipped straight to ChatGPT. Selector now passed as an arg.
    const currentAria = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
    }, modelBtnSelector()).catch(() => 'UNKNOWN');

    if (currentAria.includes('Flash')) {
        log('gemini: Flash model already active');
        return true;
    }

    // Step 1: Open model selector
    try {
        const btn = page.locator(
            modelBtnSelector()
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
    // (same browser-context capture fix as the initial check above)
    const finalAria = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
    }, modelBtnSelector()).catch(() => 'UNKNOWN');

    if (finalAria.includes('Flash')) {
        log(`gemini: Verified Flash model active (${finalAria}).`);
        return true;
    }

    log(`gemini: Flash switch not confirmed. Current: "${finalAria}"`);
    return false;
}

module.exports = { ensureProExtended, ensureFlash, waitForMenuItemsFilled, locales: L };
