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
// v9: includesExtended checks button aria-label (activated state), not menu item text.
// The button shows modelVerify (e.g. "Pro延長"), not extended (e.g. "延伸思考").
const includesExtended  = (t) => asRe(L.txt('modelVerify')).test(t)
    || asRe(L.txt('extended')).test(t);  // fallback for old UI where extended is in aria
const includesStandard  = (t) => asRe(L.txt('standard')).test(t);
// Pro model check: innerText 含 "Pro" 且含当前 locale 的 proDesc
const proDesc           = () => asRe(L.txt('proDesc'));
const modelBtnSelector  = () => L.modelBtnCSS();

// ── Three-tier model button discovery ───────────────────────────────────────
// v8 (2026-07-11): Replaces single-point brittle aria-label selector with
// L1(locale-aware CSS) → L2(structured DOM landmarks) → L3(heuristic scan)
// → DOM diagnostic dump. Google UI changes can no longer kill both Pro & Flash
// tiers simultaneously.

/** L2: Structured candidates — language-independent DOM landmarks. */
const MODEL_BTN_CANDIDATES = [
    '[data-test-id="bard-mode-menu-button"]',
    '[data-test-id*="mode-menu"]',
    '[data-test-id*="model"]',
    'button:has(.logo-pill-label-container)',
    '[class*="mode-switcher"]',
    '[class*="model-switcher"]',
    '[class*="modelSwitcher"]',
    'button[aria-haspopup]:has([class*="logo"])',
    'button[aria-haspopup]:has([class*="pill"])',
    '[aria-label*="mode" i]',
    '[aria-label*="model" i]',
];

/** L3: Model-related keywords for heuristic button text/aria scanning. */
const MODEL_KEYWORDS = [
    'Pro', 'Flash', 'Thinking', 'Extended', 'Standard',
    'Advanced',
    '扩展', '延長', '拡張', '思考', '模型', '模式', 'モデル',
    '2.5', '3.0', '2.0', '3.5',
];

/** L3: Negative keywords — common non-model buttons to de-prioritize. */
const NON_MODEL_KEYWORDS = [
    '設定', '设置', 'Settings', '設定',
    '帮助', '幫助', 'Help',
    '通知', 'Notifications',
    '菜单', '選單', 'Menu',
    '分享', 'Share',
    '刪除', '删除', 'Delete',
    '重命名', 'Rename',
    '釘選', 'Pin',
];

/**
 * Three-tier model button discovery.
 *
 * L1: Locale-aware aria-label CSS selector (existing mechanism)
 * L2: Structured candidates — language-independent DOM landmarks
 * L3: Heuristic scan — visible buttons matching model keywords,
 *     prefers aria-haspopup, tags match with data-fs-fallback
 *
 * On total failure: dumps top ~15 visible buttons' diagnostics to stderr.
 *
 * @param {Page} page
 * @param {(msg: string) => void} log
 * @returns {Promise<string|null>} CSS selector for the model button, or null
 */
async function findModelButton(page, log) {
    // ── L1: Locale aria-label CSS ──
    const l1 = modelBtnSelector();
    try {
        const btn = page.locator(l1).first();
        if (await btn.isVisible({ timeout: 800 }).catch(() => false)) {
            log('gemini: L1 model button found (locale aria-label)');
            return l1;
        }
    } catch (_) { /* fall through to L2 */ }

    // ── L2: Structured candidates ──
    for (const sel of MODEL_BTN_CANDIDATES) {
        try {
            const btn = page.locator(sel).first();
            const visible = await btn.isVisible({ timeout: 400 }).catch(() => false);
            if (visible) {
                log(`gemini: L2 model button found via "${sel}"`);
                return sel;
            }
        } catch (_) { /* try next candidate */ }
    }

    // ── L3: Heuristic scan ──
    try {
        const hitText = await page.evaluate((keywords, nonKeywords) => {
            const candidates = [];
            const btns = document.querySelectorAll(
                'button:not([disabled]), [role="button"]:not([disabled]), [aria-haspopup]'
            );

            for (const el of btns) {
                // Must be visible
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const style = getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none') continue;

                const text = (el.textContent || '').trim();
                const aria = (el.getAttribute('aria-label') || '').trim();
                const combined = text + ' ' + aria;
                const testId = (el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '').toLowerCase();

                // Negative filter: skip obvious non-model buttons entirely
                const nonLower = combined.toLowerCase();
                const isNonModel = nonKeywords.some(kw => nonLower.includes(kw.toLowerCase()));
                if (isNonModel && text.length < 30) continue;

                // Score
                let score = 0;
                for (const kw of keywords) {
                    if (nonLower.includes(kw.toLowerCase())) score++;
                }
                if (el.hasAttribute('aria-haspopup')) score += 3;
                if (rect.top < 200) score += 1;
                // data-test-id with model/mode/bard is a strong signal
                if (/(model|mode|bard)/.test(testId)) score += 5;

                if (score > 0) {
                    candidates.push({ el, score, text: combined.slice(0, 120) });
                }
            }

            candidates.sort((a, b) => b.score - a.score);
            if (candidates.length === 0) return null;

            // Tag best candidate for re-finding
            const best = candidates[0];
            best.el.setAttribute('data-fs-fallback', '1');
            return best.text;
        }, MODEL_KEYWORDS, NON_MODEL_KEYWORDS);

        if (hitText) {
            log(`gemini: L3 heuristic hit — text="${hitText}"`);
            return '[data-fs-fallback="1"]';
        }
    } catch (_) { /* fall through to diagnostics */ }

    // ── Total failure: DOM diagnostics ──
    await dumpButtonDiagnostics(page, log);
    return null;
}

/**
 * Dump top ~15 visible buttons' diagnostics to stderr.
 * When the model button can't be found, this output is the single source of
 * truth for a one-minute fix — no blind guessing about what Google changed.
 */
async function dumpButtonDiagnostics(page, log) {
    try {
        const info = await page.evaluate(() => {
            const btns = document.querySelectorAll(
                'button:not([disabled]), [role="button"]:not([disabled]), [aria-haspopup]'
            );
            const items = [];
            for (const el of btns) {
                const rect = el.getBoundingClientRect();
                if (rect.width === 0 || rect.height === 0) continue;
                const style = getComputedStyle(el);
                if (style.visibility === 'hidden' || style.display === 'none') continue;

                items.push({
                    tag: el.tagName,
                    text: (el.textContent || '').trim().slice(0, 80),
                    aria: (el.getAttribute('aria-label') || '').slice(0, 80),
                    hasPopup: el.hasAttribute('aria-haspopup'),
                    classes: (typeof el.className === 'string' ? el.className : '').slice(0, 120),
                    testId: (el.getAttribute('data-test-id') || el.getAttribute('data-testid') || '').slice(0, 60),
                    top: Math.round(rect.top),
                });
                if (items.length >= 15) break;
            }
            return items;
        });

        log('gemini DIAG: top visible buttons (model button not found):');
        info.forEach((b, i) => {
            log(`  [${i}] <${b.tag}> top=${b.top} popup=${b.hasPopup} text="${b.text}" aria="${b.aria}" class="${b.classes}" testid="${b.testId}"`);
        });
    } catch (e) {
        log(`gemini DIAG: button dump failed: ${e.message}`);
    }
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

        // Locate model selector button (3-tier discovery)
        const mbs = await findModelButton(page, log);
        if (!mbs) {
            log('gemini WARN: Model selector button not found (all 3 tiers exhausted).');
            continue;
        }

        // Check current mode via aria-label (authoritative, not textContent)
        const currentAria = await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
        }, mbs);
        log(`gemini attempt ${attempt}: current mode = "${currentAria}"`);

        // v9 (2026-07-11): 用按钮真实的 aria-label 纠正 locale 检测结果。
        // detectLocale() 可能在按钮渲染前就运行了（页面还在加载 Angular），
        // 此时 fallback 到 navigator.language 会造成 locale 错配
        //（如浏览器 zh-CN 但 Gemini UI 是 zh-TW），导致所有菜单项匹配失败。
        // 按钮 aria-label 是 Gemini UI 实际语言的权威来源。
        const correctedLocale = (() => {
            if (!currentAria || currentAria === 'UNKNOWN') return null;
            if (/開啟|挑選|延長/.test(currentAria)) return 'zh_TW';
            if (/打开|选择|扩展/.test(currentAria)) return 'zh_CN';
            if (/Model selector|Extended/.test(currentAria)) return 'en';
            if (/モデル|拡張/.test(currentAria)) return 'ja';
            return null;
        })();
        if (correctedLocale && correctedLocale !== L.locale) {
            log(`gemini: correcting locale ${L.locale || 'fuzzy'} → ${correctedLocale} (from button aria-label)`);
            L.setLocale(correctedLocale);
        }

        if (includesExtended(currentAria)) {
            log('gemini: Pro Extended Thinking already active');
            return true;
        }

        // Step 1: Open model selector
        try {
            const selectorBtn = page.locator(mbs).first();
            await selectorBtn.waitFor({ state: 'visible', timeout: 5000 });
            await selectorBtn.click();
        } catch {
            log('gemini WARN: Model selector button found but not clickable.');
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
                const selectorBtn2 = page.locator(mbs).first();
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

        // Step 3: Select Extended Thinking
        // v9 (2026-07-11): Google redesigned model picker to a FLAT menu.
        // "Extended thinking" is now a direct menu item (e.g. "延伸思考"),
        // not nested inside a "Thinking level" submenu.
        // Primary path: find and click the extended thinking item directly.
        // Fallback path: old nested submenu expansion (for backward compat).
        const _extRe = asRe(L.txt('extended')); const _thinkRe = asRe(L.txt('thinking'));
        let extendedIdx = await page.evaluate(({extSrc, extFlags, thinkSrc, thinkFlags}) => {
            const items = document.querySelectorAll('gem-menu-item, [role="menuitem"]');
            const extRe = new RegExp(extSrc, extFlags);
            const thinkRe = new RegExp(thinkSrc, thinkFlags);
            // v9 flat menu: "extended" text now matches full item like "延伸思考"
            for (let i = 0; i < items.length; i++) {
                const t = items[i].innerText || '';
                if (extRe.test(t) && !thinkRe.test(t) && items[i].offsetParent !== null) return i;
            }
            return -1;
        }, {extSrc: _extRe.source, extFlags: _extRe.flags, thinkSrc: _thinkRe.source, thinkFlags: _thinkRe.flags});

        if (extendedIdx < 0) {
            // v9 fallback: old nested-submenu expansion (for pre-July-2026 UI)
            log('gemini: flat-menu extended not found, trying old submenu expansion...');
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
                if (thinkIdx < 0) {
                    // Dump menu items to diagnose what Google changed
                    try {
                        const menuSnapshot = await page.evaluate(() => {
                            const items = document.querySelectorAll(
                                'gem-menu-item, [role="menuitem"], [role="menuitemradio"], '
                                + '[role="option"], [role="listitem"], .menu-item, '
                                + '[class*="menuItem"], [class*="menu-item"], li'
                            );
                            const out = [];
                            for (const el of items) {
                                const t = (el.innerText || '').trim();
                                if (!t) continue;
                                out.push({
                                    tag: el.tagName,
                                    text: t.slice(0, 100),
                                    visible: el.offsetParent !== null,
                                    role: el.getAttribute('role') || '',
                                    classes: (typeof el.className === 'string' ? el.className : '').slice(0, 100),
                                });
                            }
                            return out;
                        });
                        log('gemini DIAG: menu items dump (extended thinking not found):');
                        menuSnapshot.forEach((m, i) => {
                            log(`  [${i}] <${m.tag}> role="${m.role}" visible=${m.visible} text="${m.text}" class="${m.classes}"`);
                        });
                    } catch (e) { log(`gemini DIAG: menu dump failed: ${e.message}`); }
                    throw new Error('Extended thinking item not found in menu');
                }

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
                if (extendedIdx < 0) throw new Error('Extended option not found after submenu expansion');
            } catch {
                log('gemini WARN: Could not select extended thinking (both flat & nested paths failed).');
                continue;
            }
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
        const _vSel = mbs;
        // v9: 用 modelVerify（按钮激活后的 aria-label 文字，如 "Pro延長"）
        // 而非 extended（菜单项文字，如 "延伸思考"）来验证是否激活成功
        const _vExt = asRe(L.txt('modelVerify'));
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

        // v9 diagnostic: show actual aria-label to detect Google wording changes
        const actualAria = await page.evaluate((sel) => {
            const btn = document.querySelector(sel);
            return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
        }, _vSel).catch(() => 'UNKNOWN');
        log(`gemini: final mode not confirmed as Pro Extended. Actual aria-label: "${actualAria}"`);
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

    // Locate model selector button (3-tier discovery)
    const mbs = await findModelButton(page, log);
    if (!mbs) {
        log('gemini WARN: Model selector button not found for Flash switch (all 3 tiers exhausted).');
        return false;
    }

    // Check if Flash is already active
    const currentAria = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
    }, mbs).catch(() => 'UNKNOWN');

    // v9: 纠正 locale（同 ensureProExtended 的逻辑）
    const correctedLocale = (() => {
        if (!currentAria || currentAria === 'UNKNOWN') return null;
        if (/開啟|挑選|延長/.test(currentAria)) return 'zh_TW';
        if (/打开|选择|扩展/.test(currentAria)) return 'zh_CN';
        if (/Model selector|Extended/.test(currentAria)) return 'en';
        if (/モデル|拡張/.test(currentAria)) return 'ja';
        return null;
    })();
    if (correctedLocale && correctedLocale !== L.locale) {
        log(`gemini: correcting locale ${L.locale || 'fuzzy'} → ${correctedLocale} (from button aria-label)`);
        L.setLocale(correctedLocale);
    }

    if (currentAria.includes('Flash')) {
        log('gemini: Flash model already active');
        return true;
    }

    // Step 1: Open model selector
    try {
        const btn = page.locator(mbs).first();
        await btn.waitFor({ state: 'visible', timeout: 5000 });
        await btn.click();
    } catch {
        log('gemini WARN: Model selector button found but not clickable for Flash switch.');
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
    const finalAria = await page.evaluate((sel) => {
        const btn = document.querySelector(sel);
        return btn ? (btn.getAttribute('aria-label') || btn.textContent || '').trim() : 'UNKNOWN';
    }, mbs).catch(() => 'UNKNOWN');

    if (finalAria.includes('Flash')) {
        log(`gemini: Verified Flash model active (${finalAria}).`);
        return true;
    }

    log(`gemini: Flash switch not confirmed. Current: "${finalAria}"`);
    return false;
}

module.exports = { ensureProExtended, ensureFlash, waitForMenuItemsFilled, locales: L };
