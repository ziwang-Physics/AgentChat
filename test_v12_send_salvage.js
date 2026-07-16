#!/usr/bin/env node
/**
 * test_v12_send_salvage.js — functional assertions for the v12 patch:
 *   1. isContextLostError classification
 *   2. clickSend tags post-commit context loss as ERR_SEND_COMMITTED_CTX_LOST
 *      (and does NOT fall through to next selector / keyboard fallback)
 *   3. clickSend pre-commit failures still fall through (unchanged behavior)
 *   4. salvageCommittedSend: full recovery path (conversation URL + prompt
 *      echo + response extraction) returns the committed send's response
 *   5. salvageCommittedSend: prompt-echo guard bails (no silent wrong answer)
 *   6. salvageCommittedSend: dead BROWSER (not just tab) defers to orchestrator
 *   7. createProviderRunner end-to-end: SEND-stage context loss → salvage →
 *      {success:true} instead of {success:false, reason:'error'}
 *   8. index.js source-level: browser-loss fail-fast + reconnect + exit-1 wiring
 *
 * No Playwright required — mocks implement the exact call surface used.
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const {
    clickSend, isContextLostError, salvageCommittedSend, createProviderRunner,
} = require('./skills/lib/providerFactory');

const CTX_LOST_MSG = 'Target page, context or browser has been closed';
const ctxLostErr = () => new Error(CTX_LOST_MSG);
let passed = 0;
function ok(name, fn) {
    return Promise.resolve().then(fn).then(
        () => { console.log(`  ✓ ${name}`); passed++; },
        (e) => { console.error(`  ✗ ${name}\n    ${e && e.stack || e}`); process.exitCode = 1; }
    );
}

// ── Mock builders ────────────────────────────────────────────────────────────
function mockLocator(overrides = {}) {
    const self = {
        isVisible: async () => true,
        evaluate: async () => true,
        click: async () => {},
        waitFor: async () => {},
        first: () => self,
        last: () => self,
        nth: () => self,
        count: async () => 0,
        focus: async () => {},
        ...overrides,
    };
    // re-bind chainers to the final object
    self.first = () => self; self.last = () => self; self.nth = () => self;
    return self;
}
function mockPage(overrides = {}) {
    return {
        locator: () => mockLocator(),
        waitForTimeout: async () => {},
        keyboard: { press: async () => {}, insertText: async () => {} },
        url: () => 'https://chatgpt.com/',
        context: () => null,
        goto: async () => {},
        evaluate: async () => '',
        close: async () => {},
        isClosed: () => false,
        ...overrides,
    };
}

(async () => {
console.log('v12 send-salvage functional tests');

// 1 ─ isContextLostError classification
await ok('isContextLostError matches Playwright loss surface, rejects normal errors', () => {
    for (const m of [
        CTX_LOST_MSG, 'Target closed', 'Browser has been disconnected',
        'Protocol error (Runtime.evaluate): Session closed', 'Connection closed',
    ]) assert(isContextLostError(new Error(m)), `should match: ${m}`);
    for (const m of ['Timeout 2000ms exceeded', 'net::ERR_NAME_NOT_RESOLVED', 'element is not attached'])
        assert(!isContextLostError(new Error(m)), `should NOT match: ${m}`);
});

// 2 ─ clickSend: click lands → waitForTimeout throws Context closed → tagged error
await ok('clickSend tags post-click context loss as ERR_SEND_COMMITTED_CTX_LOST', async () => {
    let clicks = 0, fallbackPressed = false;
    const page = mockPage({
        locator: () => mockLocator({ click: async () => { clicks++; } }),
        waitForTimeout: async (ms) => { if (ms === 1500) throw ctxLostErr(); },
        keyboard: { press: async () => { fallbackPressed = true; } },
    });
    const editor = mockLocator();
    let err = null;
    try { await clickSend(page, editor, ['button.a', 'button.b'], 'Enter'); }
    catch (e) { err = e; }
    assert(err, 'must throw');
    assert.strictEqual(err.code, 'ERR_SEND_COMMITTED_CTX_LOST');
    assert.strictEqual(clicks, 1, 'must NOT retry the next selector after a landed click');
    assert.strictEqual(fallbackPressed, false, 'must NOT press keyboard fallback after a landed click');
});

// 3 ─ clickSend: pre-commit failure (button never enabled) still falls through
await ok('clickSend pre-commit fallthrough to keyboard fallback unchanged', async () => {
    let fallbackPressed = false;
    const page = mockPage({
        locator: () => mockLocator({ isVisible: async () => false }), // no button visible
        keyboard: { press: async (k) => { fallbackPressed = (k === 'Enter'); } },
    });
    const r = await clickSend(page, mockLocator(), ['button.a'], 'Enter');
    assert.strictEqual(r, true);
    assert.strictEqual(fallbackPressed, true);
});

// ── shared salvage fixtures ──────────────────────────────────────────────────
const PROMPT = '为当前skill生成一张精简的机制图，展示 provider 降级链与 CDP 桥接架构';
const ANSWER = 'Here is the generated mechanism diagram: ![image](https://files.oaiusercontent.com/mech.png) — 已按要求生成精简机制图。';
function chatgptC(extra = {}) {
    return {
        key: 'chatgpt', url: 'https://chatgpt.com/',
        navWaitUntil: 'domcontentloaded', navTimeout: 45000, navPostDelay: 0,
        responseSelectors: ['.markdown'], stopSelectors: [],
        stabilityWindow: 1, pollInterval: 1, minResponseLength: 5,
        responseSelectorTimeout: 2000, salvageOnContextLoss: true,
        authDomains: [], quotaPatterns: [], dismissPatterns: [],
        blockedUrlPatterns: [], signedOutSelectors: [],
        stillGeneratingMaxHoldMs: 1,
        ...extra,
    };
}
function freshPageWithConversation({ echo = true, answer = ANSWER } = {}) {
    let closed = false;
    return {
        goto: async () => {},
        waitForTimeout: async () => {},
        evaluate: async (fn, arg) => {
            // salvage's echo guard passes a function + needle
            if (typeof fn === 'function' && typeof arg === 'string') {
                const body = echo ? `User: ${PROMPT}\nAssistant: ${answer}` : 'Fresh empty chat';
                // emulate the in-page check: body includes needle (normalized)
                return body.replace(/\s+/g, ' ').includes(arg);
            }
            return '';
        },
        locator: () => mockLocator({
            // waitForCompletion phase-2 attach + phase-3 stability + extract
            waitFor: async () => {},
            evaluate: async (fn) => {
                const el = { innerText: answer, textContent: answer, tagName: 'DIV' };
                return fn(el);
            },
            isVisible: async () => false,
        }),
        close: async () => { closed = true; },
        isClosed: () => closed,
        get _closed() { return closed; },
    };
}
function deadPage({ lastUrl = 'https://chatgpt.com/c/abc123', browserConnected = true, freshPage }) {
    const ctxObj = {
        browser: () => ({ isConnected: () => browserConnected }),
        newPage: async () => freshPage,
    };
    return { url: () => lastUrl, context: () => ctxObj };
}

// 4 ─ salvage: full recovery path
await ok('salvageCommittedSend recovers the response via conversation URL + echo guard', async () => {
    const fresh = freshPageWithConversation({ echo: true });
    const dp = deadPage({ freshPage: fresh });
    const r = await salvageCommittedSend(dp, chatgptC(), PROMPT, Date.now(), 120000, () => {});
    assert(r && r.success === true, 'salvage must succeed');
    assert(r.response.includes('mech.png'), 'must return the committed send\'s response');
    assert(!fresh._closed, 'recovered tab stays open on success (keep-tabs policy)');
});

// 5 ─ salvage: echo guard bails → no silent wrong answer
await ok('salvageCommittedSend bails when the prompt is absent from the recovered page', async () => {
    const fresh = freshPageWithConversation({ echo: false });
    const dp = deadPage({ freshPage: fresh });
    const r = await salvageCommittedSend(dp, chatgptC(), PROMPT, Date.now(), 120000, () => {});
    assert.strictEqual(r, null);
    assert(fresh._closed, 'salvage-created tab must be closed on bail');
});

// 6 ─ salvage: dead browser defers to orchestrator
await ok('salvageCommittedSend returns null when the whole CDP connection is down', async () => {
    const dp = deadPage({ browserConnected: false, freshPage: freshPageWithConversation({}) });
    const r = await salvageCommittedSend(dp, chatgptC(), PROMPT, Date.now(), 120000, () => {});
    assert.strictEqual(r, null);
});

// 7 ─ end-to-end: runner turns SEND-stage context loss into success via salvage
await ok('createProviderRunner: SEND context loss → salvage → {success:true}', async () => {
    const fresh = freshPageWithConversation({ echo: true });
    const ctxObj = {
        browser: () => ({ isConnected: () => true }),
        newPage: async () => fresh,
    };
    // Page that behaves normally through nav/editor/input, then the send
    // button click lands and the post-click settle wait kills the context.
    const editorLoc = mockLocator({
        evaluate: async (fn) => {
            const el = {
                tagName: 'DIV', value: undefined,
                innerText: '', textContent: '',
                hasAttribute: () => false, getAttribute: () => 'true',
                classList: { contains: () => false },
                dispatchEvent: () => {},
            };
            try { return fn(el); } catch (_) { return true; }
        },
    });
    let sendClicked = false;
    const page = {
        goto: async () => {},
        url: () => 'https://chatgpt.com/c/xyz789',
        context: () => ctxObj,
        waitForTimeout: async (ms) => {
            if (sendClicked && ms === 1500) throw ctxLostErr(); // the DALL·E crash point
        },
        evaluate: async () => 'clean body text',
        keyboard: { press: async () => {}, insertText: async () => {} },
        locator: (sel) => {
            if (sel === 'EDITOR') return editorLoc;
            if (sel === 'SEND') return mockLocator({
                click: async () => { sendClicked = true; },
                evaluate: async () => true, // enabled
            });
            return mockLocator({ isVisible: async () => false, count: async () => 0, waitFor: async () => { throw new Error('Timeout'); } });
        },
    };
    const runner = createProviderRunner(chatgptC({
        editorSelectors: ['EDITOR'],
        validateEditor: async () => true,
        input: async () => true,
        sendSelectors: ['SEND'],
        sendFallback: 'Enter',
    }));
    const telemetry = { per_provider_ms: {} };
    const result = await runner(page, PROMPT, 120000, { telemetry });
    assert.strictEqual(result.success, true, `expected salvage success, got ${JSON.stringify(result).slice(0, 200)}`);
    assert(result.response.includes('mech.png'));
    assert.strictEqual(telemetry.send_salvaged, 'chatgpt');
});

// 8 ─ index.js wiring (source-level: requiring index.js loads playwright-core)
await ok('index.js: browser-loss fail-fast, reconnect plumbing, exit-1 mapping present', () => {
    const src = fs.readFileSync(path.join(__dirname, 'skills/AgentChat-OneWeb/index.js'), 'utf8');
    assert(/if \(!browser\.isConnected\(\)\)/.test(src), 'loop-top isConnected check');
    assert(/options\.reconnect/.test(src), 'reconnect callback consumed');
    assert(/reconnect:\s*\(\)\s*=>\s*connectWithRetry\(CDP_URL,\s*2\)/.test(src), 'main() passes reconnect');
    assert(/reason:\s*'browser_lost'/.test(src), 'browser_lost reason recorded');
    assert(/hasBrowserLost[\s\S]{0,400}recordTelemetry\(1\)/.test(src), 'browser_lost → exit 1');
    assert(/let context = browser\.contexts\(\)\[0\]/.test(src), 'context reassignable for reconnect');
});

console.log(`\n${passed}/8 assertions groups passed`);
})();
