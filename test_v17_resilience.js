#!/usr/bin/env node
/**
 * v17 resilience regression — CAPTCHA/login/throttle wall detection,
 * browser admission slots, and wiring assertions.
 *
 * Run: node test_v17_resilience.js   (requires: npm install — jsdom devDep)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

let pass = 0, fail = 0;
function ok(cond, name) {
    if (cond) { pass++; console.log(`  PASS ${name}`); }
    else { fail++; console.log(`  FAIL ${name}`); }
}

const { detectChallenge, CHALLENGE_REASON, TEXT_EVIDENCE_MAX_BODY } =
    require('./skills/lib/pageHealth');
const { acquireBrowserSlot, releaseBrowserSlot, resolveMaxSlots, BROWSER_SLOT_PREFIX, LOCK_DIR } =
    require('./skills/lib/locks');

// ── Fake Playwright page over jsdom ─────────────────────────────────────────
// detectChallenge does exactly one page.evaluate(fn, arg); run fn against a
// jsdom document by temporarily installing its globals. jsdom's innerText is
// undefined — polyfill with textContent (same evidence for our purposes).
function fakePage(html) {
    const dom = new JSDOM(html, { pretendToBeVisual: true });
    const doc = dom.window.document;
    if (doc.body && doc.body.innerText === undefined) {
        Object.defineProperty(dom.window.HTMLElement.prototype, 'innerText', {
            get() { return this.textContent; },
            configurable: true,
        });
    }
    return {
        evaluate: async (fn, arg) => {
            const g = { document: global.document, window: global.window };
            global.document = doc;
            global.window = dom.window;
            try { return fn(arg); }
            finally { global.document = g.document; global.window = g.window; }
        },
    };
}

(async () => {
    console.log('── detectChallenge: positive cases ──');

    let r = await detectChallenge(fakePage(
        '<html><body><h1>Security check</h1>' +
        '<iframe src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe></body></html>'));
    ok(r.kind === 'captcha', 'reCAPTCHA iframe → captcha');
    ok(CHALLENGE_REASON[r.kind] === 'auth', 'captcha maps to reason=auth');

    r = await detectChallenge(fakePage(
        '<html><body><form id="challenge-form"><div class="cf-turnstile"></div></form></body></html>'));
    ok(r.kind === 'captcha', 'Cloudflare challenge-form → captcha');

    r = await detectChallenge(fakePage(
        '<html><body><h2>Welcome back</h2>' +
        '<input type="email"><input type="password"><button>Sign in</button></body></html>'));
    ok(r.kind === 'login', 'visible password input → login');
    ok(CHALLENGE_REASON[r.kind] === 'auth', 'login maps to reason=auth');

    r = await detectChallenge(fakePage(
        '<html><body><p>请求过于频繁，请稍后再试</p></body></html>'));
    ok(r.kind === 'ratelimit', 'short 请求过于频繁 page → ratelimit');
    ok(CHALLENGE_REASON[r.kind] === 'quota', 'ratelimit maps to reason=quota');

    r = await detectChallenge(fakePage(
        '<html><body><p>Please verify that you are a human to continue.</p></body></html>'));
    ok(r.kind === 'captcha', 'short verify-you-are-human page → captcha');

    r = await detectChallenge(fakePage(
        '<html><body><p>Your session has expired. Please sign in to continue.</p></body></html>'));
    ok(r.kind === 'login', 'short session-expired page → login');

    console.log('── detectChallenge: false-positive guards ──');

    // A long chat transcript DISCUSSING captchas and rate limits must NOT trip
    // text evidence (body length gate), and has no structural evidence.
    const chatWithEditor =
        '<html><body><main>' +
        `<div class="msg">User: 我的爬虫遇到 rate limit 和 captcha 怎么办？</div>` +
        `<div class="msg">AI: too many requests 通常意味着需要退避。verify you are a human 页面则需要人工处理。</div>` +
        '</main><textarea placeholder="输入消息"></textarea></body></html>';
    r = await detectChallenge(fakePage(chatWithEditor));
    ok(r.kind === null, 'SHORT chat discussing captcha/rate-limit but WITH visible editor → null (editor veto)');

    const longNoEditor =
        '<html><body><article>' +
        `rate limit 科普长文。${'正文内容 '.repeat(400)}` +
        '</article></body></html>';
    r = await detectChallenge(fakePage(longNoEditor));
    ok(r.kind === null, `long editorless article mentioning rate limit → null (gate ${TEXT_EVIDENCE_MAX_BODY})`);

    // Hidden captcha iframe (display:none container) must not trip structural.
    r = await detectChallenge(fakePage(
        '<html><body><div style="display:none">' +
        '<iframe src="https://hcaptcha.com/x"></iframe><input type="password"></div>' +
        '<p>normal page</p></body></html>'));
    ok(r.kind === null, 'hidden captcha iframe + hidden password → null');

    r = await detectChallenge(fakePage('<html><body><p>hello world</p></body></html>'));
    ok(r.kind === null, 'benign short page → null');

    // Evaluate throwing (dead context) must degrade to {kind:null}.
    r = await detectChallenge({ evaluate: async () => { throw new Error('ctx gone'); } });
    ok(r.kind === null, 'evaluate throw → {kind:null} (best-effort contract)');

    console.log('── browser admission slots ──');

    // Clean slate for slot locks (previous crashed runs).
    for (let i = 0; i < 16; i++) releaseBrowserSlot(i);

    ok(resolveMaxSlots({ AGENTCHAT_MAX_CONCURRENT_PAGES: '5' }) === 5, 'env cap honored');
    ok(resolveMaxSlots({ AGENTCHAT_MAX_CONCURRENT_PAGES: '99' }) === 16, 'env cap clamped to 16');
    ok(resolveMaxSlots({ AGENTCHAT_MAX_CONCURRENT_PAGES: '0' }) === 3, 'invalid env → default 3');
    ok(resolveMaxSlots({}) === 3, 'no env → default 3');

    const s1 = await acquireBrowserSlot({ max: 2, waitMs: 0 });
    const s2 = await acquireBrowserSlot({ max: 2, waitMs: 0 });
    ok(Number.isInteger(s1) && Number.isInteger(s2) && s1 !== s2, 'two acquires get distinct slots');
    const s3 = await acquireBrowserSlot({ max: 2, waitMs: 0 });
    ok(s3 === null, 'third acquire (cap 2, no wait) → null');

    // Bounded wait: with both slots held, waitMs elapses and returns null
    // (also proves the retry loop terminates).
    const t0 = Date.now();
    const s4 = await acquireBrowserSlot({ max: 2, waitMs: 1200 });
    ok(s4 === null && Date.now() - t0 >= 1000, 'bounded wait exhausts then returns null');

    releaseBrowserSlot(s2);
    const s5 = await acquireBrowserSlot({ max: 2, waitMs: 0 });
    ok(s5 === s2, 'released slot is re-acquirable');
    releaseBrowserSlot(s1);
    releaseBrowserSlot(s5);
    releaseBrowserSlot(null);   // must no-op
    releaseBrowserSlot(undefined);
    ok(true, 'releaseBrowserSlot(null/undefined) no-ops');
    ok(fs.existsSync(LOCK_DIR), 'slot locks live in the shared LOCK_DIR');

    console.log('── wiring assertions ──');

    const pf = fs.readFileSync(path.join(__dirname, 'skills/lib/providerFactory.js'), 'utf8');
    ok((pf.match(/detectChallenge\(page\)/g) || []).length >= 3,
        'providerFactory probes challenges at ≥3 sites (nav / editor-fail / wait-timeout)');
    ok(pf.includes("CHALLENGE_REASON[ch.kind]"), 'providerFactory maps kind → fallback reason');
    ok(pf.includes("getByRole('textbox')"), 'findEditableElement has ARIA tier');
    ok(pf.includes("_fsTier = 'aria'") && pf.includes("_fsTier = 'css'") && pf.includes("_fsTier = 'heuristic'"),
        'all three editor tiers are tagged for telemetry');
    ok(pf.includes('editor_tier'), 'editor tier lands in ctx.telemetry');

    const ow = fs.readFileSync(path.join(__dirname, 'skills/AgentChat-OneWeb/index.js'), 'utf8');
    ok(ow.includes('acquireBrowserSlot(') && ow.includes('releaseBrowserSlot(browserSlot)'),
        'OneWeb acquires and releases an admission slot around the chain');
    ok(/finally\s*\{\s*releaseBrowserSlot\(browserSlot\);/.test(ow),
        'slot release is in a finally block (crash-path safe)');
    ok(ow.includes('手动完成登录/人机验证'), 'generic auth recovery hint present');

    const er = fs.readFileSync(path.join(__dirname, 'skills/lib/errors.js'), 'utf8');
    ok(er.includes("CHALLENGE_CHECK:'challenge_check'") || er.includes("CHALLENGE_CHECK: 'challenge_check'")
        || /CHALLENGE_CHECK:\s*'challenge_check'/.test(er), 'STAGES.CHALLENGE_CHECK registered');

    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
