/**
 * Page-health probes — detect CAPTCHA walls, login interstitials, and
 * throttle pages so the chain can fail FAST with the right classification
 * instead of burning the full per-provider budget into reason='error'.
 *
 * Design stance (deliberate): DETECT AND SURFACE, NEVER BYPASS. A CAPTCHA is
 * an explicit human check; the correct automation response is to classify it
 * as an operator-fixable 'auth' failure, print the recovery hint, and fall to
 * the next provider. No solver services, no stealth. The same industry
 * guidance applies to throttling: the fix for anti-bot pressure is LESS
 * concurrency (see locks.js acquireBrowserSlot), not evasion.
 *
 * Two evidence classes, combined in ONE page.evaluate round-trip (~50ms):
 *
 *   1. STRUCTURAL — CAPTCHA vendor iframes (reCAPTCHA / hCaptcha / Turnstile /
 *      Cloudflare challenges / Arkose), challenge forms, visible password
 *      inputs. These are unambiguous regardless of page size: chat UIs never
 *      contain a visible password field, and vendor iframes never appear in
 *      normal provider pages. Checked first, no length gate.
 *
 *   2. TEXTUAL — challenge/login/throttle phrases in body.innerText, double-gated:
 *      (a) no visible chat editor on the page (walls never have one) and
 *      (b) body length < TEXT_EVIDENCE_MAX_BODY chars. The gates are the
 *      false-positive defence: interstitials (login walls, "checking your
 *      browser", "too many requests") are near-empty pages, while a chat page
 *      merely DISCUSSING captchas or rate limits carries a long transcript.
 *      In-page quota banners on FULL chat pages remain the job of each
 *      adapter's quotaPatterns — this module only covers whole-page walls.
 *
 * Kind → fallback-reason mapping (CHALLENGE_REASON):
 *   captcha   → 'auth'   human needed in the shared browser (recoveryHint path)
 *   login     → 'auth'   same operator action: re-authenticate
 *   ratelimit → 'quota'  retry-later semantics (OneWeb exit 5 / ERR_RATE_LIMITED)
 */

'use strict';

const TEXT_EVIDENCE_MAX_BODY = 1500;

const CHALLENGE_REASON = Object.freeze({
    captcha: 'auth',
    login: 'auth',
    ratelimit: 'quota',
});

/**
 * Probe the page for a blocking challenge.
 *
 * Best-effort by contract: any evaluation failure (navigation race, dead
 * context) returns { kind: null } — callers must treat "no challenge found"
 * as "no NEW information", never as proof of health.
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<{kind: 'captcha'|'login'|'ratelimit'|null, detail?: string}>}
 */
async function detectChallenge(page) {
    let r = null;
    try {
        r = await page.evaluate((maxBody) => {
            // Style-based visibility: layout-independent, so it behaves
            // identically in jsdom (tests) and real Chromium. Walks ancestors —
            // candidate sets here are tiny, cost is negligible.
            const vis = (el) => {
                for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
                    if (n.hasAttribute('hidden')) return false;
                    let s;
                    try { s = window.getComputedStyle(n); } catch (_) { return true; }
                    if (!s) return true;
                    if (s.display === 'none' || s.visibility === 'hidden') return false;
                }
                return true;
            };

            // ── 1. STRUCTURAL evidence (no body-length gate) ──
            const CAPTCHA_IFRAME_RE = /recaptcha|hcaptcha|turnstile|challenges\.cloudflare\.com|arkoselabs|funcaptcha/i;
            for (const f of document.querySelectorAll('iframe[src]')) {
                if (CAPTCHA_IFRAME_RE.test(f.getAttribute('src') || '') && vis(f)) {
                    return { kind: 'captcha', detail: `captcha iframe: ${(f.getAttribute('src') || '').slice(0, 80)}` };
                }
            }
            const CAPTCHA_NODE_SEL =
                '#challenge-form, .cf-turnstile, [id^="cf-chl"], .g-recaptcha, .h-captcha, [class*="captcha" i]';
            for (const el of document.querySelectorAll(CAPTCHA_NODE_SEL)) {
                if (vis(el)) {
                    return { kind: 'captcha', detail: `captcha node: ${(el.id || el.className || '').toString().slice(0, 80)}` };
                }
            }
            for (const el of document.querySelectorAll('input[type="password"]')) {
                // Chat UIs never render a visible password field — its presence
                // IS the login wall, whatever the URL says.
                if (vis(el)) return { kind: 'login', detail: 'visible password input' };
            }

            // ── 2. TEXTUAL evidence (interstitial pages only) ──
            // Two independent guards against false positives on chat content
            // that merely DISCUSSES captchas / rate limits / logins:
            //   a. EDITOR VETO — a wall page never renders a usable chat
            //      editor; if one is visible, textual evidence is void
            //      (structural evidence above is unaffected).
            //   b. LENGTH GATE — real interstitials carry a few hundred chars
            //      of visible text; transcripts run thousands.
            let hasEditor = false;
            for (const el of document.querySelectorAll(
                'textarea, [contenteditable="true"], [role="textbox"], input[type="text"]')) {
                if (el.hasAttribute('readonly') || el.hasAttribute('disabled')) continue;
                if (vis(el)) { hasEditor = true; break; }
            }
            const body = (document.body && document.body.innerText) || '';
            const text = body.replace(/\s+/g, ' ').trim();
            if (!hasEditor && text.length > 0 && text.length < maxBody) {
                const CAPTCHA_TEXT_RE = /verify (?:that )?you(?:'re| are)(?: a)? human|checking your browser|unusual traffic from your (?:computer|network|device)|人机验证|安全验证|确认您不是机器人|请完成(?:安全)?验证|需要验证您是真人|人機驗證|請完成驗證/i;
                const LOGIN_TEXT_RE = /sign in to continue|log ?in to continue|please sign in|session (?:has )?expired|your session (?:has )?timed out|请先登录|登录后继续|登录以继续|会话已过期|登录已过期|重新登录|請先登入|登入後繼續|工作階段已過期/i;
                const RATELIMIT_TEXT_RE = /too many requests|rate.?limit(?:ed|s)?(?: exceeded)?|HTTP ERROR 429|请求过于频繁|操作(?:过于|太)频繁|访问过于频繁|发送过于频繁|请稍后(?:再)?试|請稍後再試|請求過於頻繁/i;

                let m;
                if ((m = text.match(CAPTCHA_TEXT_RE)))   return { kind: 'captcha',   detail: `text: "${m[0].slice(0, 60)}" (body ${text.length} chars)` };
                if ((m = text.match(LOGIN_TEXT_RE)))     return { kind: 'login',     detail: `text: "${m[0].slice(0, 60)}" (body ${text.length} chars)` };
                if ((m = text.match(RATELIMIT_TEXT_RE))) return { kind: 'ratelimit', detail: `text: "${m[0].slice(0, 60)}" (body ${text.length} chars)` };
            }
            return null;
        }, TEXT_EVIDENCE_MAX_BODY);
    } catch (_) {
        return { kind: null };
    }
    return r || { kind: null };
}

module.exports = { detectChallenge, CHALLENGE_REASON, TEXT_EVIDENCE_MAX_BODY };
