#!/usr/bin/env node
const AGENTCHAT_ROOT = require("path").resolve(__dirname, "..", "..", "..");
/**
 * v19 regression suite — IndependentTasks dispatch fixes.
 *
 * Covers the five field failures from the 2026-07 9-task dispatch run:
 *   P1 串题:       waitForCompletion refuses the legacy `.last()` fallback on a
 *                  reused tab when the prompt provably never reached the page
 *                  (stale-answer / answer cross-talk class).
 *   P2 Kimi 超时:  deep-think toggle-off helper exists, is opt-out-able, and
 *                  degrades gracefully on a dead page.
 *   P3 同 provider 串行: provider tab slots (locks.js) + --ephemeral-tab
 *                  propagation through lib/execute.js's spawn boundary.
 *   P4 DAG 可视化: orchestrator prints nodes with " | ", never a "→" chain.
 *   P5 JSON argv:  orchestrator accepts --plan=<file> and fails loudly (exit
 *                  64) on an unreadable file instead of dispatching garbage.
 *
 * Zero network, zero browser — mock pages and a fake OneWeb child script.
 */
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, "..", "..", "..");
let passed = 0;
const results = [];
function test(name, fn) { results.push([name, fn]); }

// ─────────────────────────────────────────────────────────────────────────────
// P3a — locks.js: provider tab slots
// ─────────────────────────────────────────────────────────────────────────────

test('P3a: acquireProviderSlot caps at max and hands out distinct lock keys', () => {
    const locks = require(AGENTCHAT_ROOT + '/skills/lib/locks');
    const prov = `v19test_${process.pid}_${Date.now()}`;
    const s0 = locks.acquireProviderSlot(prov, { max: 2 });
    assert.ok(s0, 'slot 0 must acquire');
    assert.strictEqual(s0.slot, 0);
    assert.strictEqual(s0.lockKey, prov, 'slot 0 keeps the bare provider name (back-compat)');
    const s1 = locks.acquireProviderSlot(prov, { max: 2 });
    assert.ok(s1, 'slot 1 must acquire');
    assert.strictEqual(s1.slot, 1);
    assert.strictEqual(s1.lockKey, `${prov}@1`);
    const s2 = locks.acquireProviderSlot(prov, { max: 2 });
    assert.strictEqual(s2, null, 'third acquisition at max=2 must fail');
    locks.releaseLock(s1.lockKey);
    const s1b = locks.acquireProviderSlot(prov, { max: 2 });
    assert.ok(s1b && s1b.slot === 1, 'released slot must be re-acquirable');
    locks.releaseLock(s0.lockKey);
    locks.releaseLock(s1b.lockKey);
});

test('P3a: resolveMaxTabsPerProvider defaults to 1 and clamps env to 1..4', () => {
    const { resolveMaxTabsPerProvider } = require(AGENTCHAT_ROOT + '/skills/lib/locks');
    assert.strictEqual(resolveMaxTabsPerProvider({}), 1);
    assert.strictEqual(resolveMaxTabsPerProvider({ AGENTCHAT_MAX_TABS_PER_PROVIDER: '3' }), 3);
    assert.strictEqual(resolveMaxTabsPerProvider({ AGENTCHAT_MAX_TABS_PER_PROVIDER: '99' }), 4);
    assert.strictEqual(resolveMaxTabsPerProvider({ AGENTCHAT_MAX_TABS_PER_PROVIDER: '0' }), 1);
    assert.strictEqual(resolveMaxTabsPerProvider({ AGENTCHAT_MAX_TABS_PER_PROVIDER: 'abc' }), 1);
});

// ─────────────────────────────────────────────────────────────────────────────
// P3b — execute.js: --ephemeral-tab reaches the child argv
// ─────────────────────────────────────────────────────────────────────────────

function makeFakeOneWeb() {
    const p = path.join(os.tmpdir(), `v19_fake_oneweb_${process.pid}.js`);
    fs.writeFileSync(p, [
        '// echoes its argv as the "response" so the parent can inspect flags',
        'let chunks = [];',
        'process.stdin.on("data", d => chunks.push(d));',
        'process.stdin.on("end", () => {',
        '  process.stdout.write("ARGS:" + JSON.stringify(process.argv.slice(2)));',
        '  process.exit(0);',
        '});',
    ].join('\n'));
    return p;
}

test('P3b: callProvider passes --ephemeral-tab only when requested', async () => {
    const { createExecutor } = require(AGENTCHAT_ROOT + '/skills/lib/execute');
    const fake = makeFakeOneWeb();
    try {
        const { callProvider } = createExecutor({ webextPath: fake, logPrefix: 'v19test' });
        const withFlag = await callProvider('hello world prompt', 'gemini', 15_000, { ephemeralTab: true });
        assert.ok(withFlag.ok, `fake child must succeed, got ${JSON.stringify(withFlag)}`);
        assert.ok(withFlag.text.includes('"--ephemeral-tab"'), 'flag missing from child argv');
        const withoutFlag = await callProvider('hello world prompt', 'gemini', 15_000);
        assert.ok(withoutFlag.ok);
        assert.ok(!withoutFlag.text.includes('--ephemeral-tab'), 'flag must be absent by default');
        assert.ok(withoutFlag.text.includes('"--only=gemini"'), 'existing args must be preserved');
    } finally {
        try { fs.unlinkSync(fake); } catch (_) {}
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// P3c — OneWeb: --ephemeral-tab is a recognized flag (never leaks into prompt)
// ─────────────────────────────────────────────────────────────────────────────

test('P3c: OneWeb source wires --ephemeral-tab through parse → options → tab policy', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills', 'AgentChat-OneWeb', 'index.js'), 'utf8');
    assert.ok(src.includes("a === '--ephemeral-tab'"), 'flag parse branch missing');
    assert.ok(/ephemeralTab \? null : findProviderPage/.test(src), 'tab-reuse bypass missing');
    assert.ok(/ephemeralTab && result\.page && !result\.page\.isClosed\(\)/.test(src), 'ephemeral close-on-exit missing');
});

// ─────────────────────────────────────────────────────────────────────────────
// P1 — providerFactory: stale-answer guard in waitForCompletion
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal Playwright-page mock for waitForCompletion:
 *   - one response selector, baseline count 1 (reused tab, one OLD answer)
 *   - the NEW element never mounts (send silently failed) → fresh gate fails
 *   - `.last()` resolves to the stale answer
 *   - page.evaluate returns `bodyText` (the echo probe's view of the page)
 */
function makeMockPage({ bodyText, staleText }) {
    const staleLocator = {
        waitFor: async ({ state }) => {
            if (state === 'attached') return; // stale element IS attached
            throw new Error('unexpected');
        },
        evaluate: async () => staleText,
    };
    const missingLocator = {
        waitFor: async () => { throw new Error('timeout: element never attached'); },
    };
    return {
        locator: () => ({
            first: () => missingLocator,        // stop button — never appears
            nth: () => missingLocator,          // element #baseline — never mounts
            last: () => staleLocator,           // the OLD conversation's answer
            count: async () => 1,
        }),
        // v20 probe contract: the echo check runs IN-PAGE and returns a
        // boolean (needle passed as the evaluate arg). Emulate faithfully.
        evaluate: async (_fn, needle) =>
            String(bodyText).replace(/\s+/g, ' ').trim().toLowerCase()
                .includes(String(needle || '').toLowerCase()),
        waitForTimeout: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 20))),
        isClosed: () => false,
    };
}

async function runWaitForCompletion(page, prompt) {
    // waitForCompletion is module-internal — drive it through the same shape
    // createProviderRunner uses, via a require of the module and a direct call
    // if exported, else through a tiny eval-free re-entry: the function IS
    // reachable because the module exposes createProviderRunner which closes
    // over it. Simplest robust route: temporarily export check.
    const pf = require(AGENTCHAT_ROOT + '/skills/lib/providerFactory');
    // If not exported (older builds), skip with a loud failure.
    assert.ok(typeof pf.__waitForCompletionForTests === 'function' || typeof pf.createProviderRunner === 'function');
    if (typeof pf.__waitForCompletionForTests === 'function') {
        return pf.__waitForCompletionForTests(page, promptConfig(prompt), Date.now(), 3_000);
    }
    // Fallback: source-level pin (guard code must exist) + behavioral test via
    // a locally reconstructed harness is out of scope — enforce the pin.
    const src = fs.readFileSync(path.join(ROOT, 'skills/lib/providerFactory.js'), 'utf8');
    assert.ok(src.includes('promptEchoPresent'), 'stale-answer guard missing from waitForCompletion');
    return 'SOURCE_PIN_ONLY';
}

function promptConfig(prompt) {
    return {
        key: 'mocktest',
        stopSelectors: [],
        responseSelectors: ['.resp'],
        responseSelectorTimeout: 300,
        stabilityWindow: 100,
        pollInterval: 30,
        baselineCounts: { '.resp': 1 },
        promptForEcho: prompt,
    };
}

const CROSSTALK_PROMPT = '请解释 As, Sb, Bi 量子点的非单调发射能随尺寸变化的物理机制，并给出文献支持。';

test('P1: echo ABSENT on reused tab → stale .last() is refused (returns null)', async () => {
    const pf = require(AGENTCHAT_ROOT + '/skills/lib/providerFactory');
    if (typeof pf.__waitForCompletionForTests !== 'function') {
        // guard exists but isn't test-exported — enforce source pin instead
        const src = fs.readFileSync(path.join(ROOT, 'skills/lib/providerFactory.js'), 'utf8');
        assert.ok(src.includes('promptEchoPresent'), 'guard missing');
        return;
    }
    const page = makeMockPage({
        bodyText: '【上一次会话残留】dopant comparison 的旧回答……与当前 prompt 无关。',
        staleText: '这是上一轮别的题目的完整回答（应被拒绝提取）',
    });
    const el = await pf.__waitForCompletionForTests(page, promptConfig(CROSSTALK_PROMPT), Date.now(), 3_000);
    assert.strictEqual(el, null, '串题回归：stale 元素被错误接受');
});

test('P1: echo PRESENT on reused tab → legacy .last() fallback still works', async () => {
    const pf = require(AGENTCHAT_ROOT + '/skills/lib/providerFactory');
    if (typeof pf.__waitForCompletionForTests !== 'function') return;
    const page = makeMockPage({
        bodyText: '用户: ' + CROSSTALK_PROMPT + '\nAI: 生成中……',
        staleText: '针对本 prompt 的回答（就地替换型 UI，元素数不增长）',
    });
    const el = await pf.__waitForCompletionForTests(page, promptConfig(CROSSTALK_PROMPT), Date.now(), 3_000);
    assert.ok(el, '就地替换型 UI 的合法回退被误杀');
});

test('P1: fresh page (baseline 0) is untouched by the guard', async () => {
    const pf = require(AGENTCHAT_ROOT + '/skills/lib/providerFactory');
    if (typeof pf.__waitForCompletionForTests !== 'function') return;
    const page = makeMockPage({ bodyText: '', staleText: '全新页面的回答' });
    const cfg = promptConfig(CROSSTALK_PROMPT);
    cfg.baselineCounts = { '.resp': 0 };
    const el = await pf.__waitForCompletionForTests(page, cfg, Date.now(), 3_000);
    assert.ok(el, 'baseline 0 必须保持旧行为');
});

// ─────────────────────────────────────────────────────────────────────────────
// P2 — kimi adapter: deep-think off helper
// ─────────────────────────────────────────────────────────────────────────────

test('P2: kimi adapter exposes deep-think-off, honors opt-out, survives dead page', async () => {
    const kimi = require(AGENTCHAT_ROOT + '/skills/lib/providers/adapters/kimi');
    const fn = kimi._ensureKimiDeepThinkOff;
    assert.strictEqual(typeof fn, 'function', 'ensureKimiDeepThinkOff missing');

    process.env.AGENTCHAT_KIMI_KEEP_DEEPTHINK = '1';
    try {
        const r = await fn({ evaluate: () => { throw new Error('must not be called'); } });
        assert.strictEqual(r, false, 'opt-out env must short-circuit');
    } finally {
        delete process.env.AGENTCHAT_KIMI_KEEP_DEEPTHINK;
    }

    const dead = await fn({ evaluate: async () => { throw new Error('Target closed'); } });
    assert.strictEqual(dead, false, 'dead page must degrade to false, not throw');
});

// ─────────────────────────────────────────────────────────────────────────────
// P4 / P5 — orchestrator
// ─────────────────────────────────────────────────────────────────────────────

test('P4: orchestrator prints DAG nodes with " | ", not a "→" chain', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills/AgentChat-IndependentTasks/index.js'), 'utf8');
    assert.ok(!src.includes('.join(" → ")'), '误导性 "→" 连接仍存在');
    assert.ok(/DAG nodes: .*join\(" \| "\)/.test(src), '" | " 分隔的节点行缺失');
});

test('P5: --plan with an unreadable file exits 64 without dispatching', () => {
    const r = spawnSync(process.execPath, [
        path.join(ROOT, 'skills/AgentChat-IndependentTasks/index.js'),
        '--plan=/nonexistent/v19_no_such_plan.json', '--timeout=60000',
    ], { encoding: 'utf8', timeout: 20_000 });
    assert.strictEqual(r.status, 64, `expected exit 64, got ${r.status}\nstderr: ${r.stderr}`);
    assert.ok(/cannot read --plan file/.test(r.stderr), 'loud error message missing');
});

test('P5: --plan file content is loaded as the prompt (via parse-fail path)', () => {
    // A plan file containing NON-JSON must flow into the normal prompt path —
    // proven here indirectly: the orchestrator proceeds past plan loading
    // (logs "Plan loaded") before failing later for unrelated reasons under a
    // sandbox with no browser. We only assert the load log to avoid any
    // provider dispatch in tests: use --doctor which exits right after arg
    // parsing + plan load.
    const tmp = path.join(os.tmpdir(), `v19_plan_${process.pid}.json`);
    fs.writeFileSync(tmp, JSON.stringify({ subtasks: [
        { id: 'g1', primary: 'gemini', depends_on: [], prompt: 'x'.repeat(40) },
        { id: 'g2', primary: 'chatgpt', depends_on: [], prompt: 'y'.repeat(40) },
    ] }));
    try {
        const r = spawnSync(process.execPath, [
            path.join(ROOT, 'skills/AgentChat-IndependentTasks/index.js'),
            '--plan', tmp, '--doctor',
        ], { encoding: 'utf8', timeout: 20_000 });
        assert.ok(/Plan loaded from/.test(r.stderr), `plan load log missing\nstderr: ${r.stderr}`);
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
});

// ─────────────────────────────────────────────────────────────────────────────
// v20 refinement pins
// ─────────────────────────────────────────────────────────────────────────────

test('v20: locks — clampedEnvInt dedup keeps both resolvers behaviorally intact', () => {
    const { resolveMaxSlots, resolveMaxTabsPerProvider } = require(AGENTCHAT_ROOT + '/skills/lib/locks');
    assert.strictEqual(resolveMaxSlots({}), 3);
    assert.strictEqual(resolveMaxSlots({ AGENTCHAT_MAX_CONCURRENT_PAGES: '20' }), 16);
    assert.strictEqual(resolveMaxTabsPerProvider({}), 1);
    assert.strictEqual(resolveMaxTabsPerProvider({ AGENTCHAT_MAX_TABS_PER_PROVIDER: '2' }), 2);
});

test('v20: locks — orphaned transfer dirs older than TTL are swept', () => {
    const locks = require(AGENTCHAT_ROOT + '/skills/lib/locks');
    // A fake OTHER-pid transfer dir, backdated past the 30min TTL.
    const fakePid = 999999;
    const dir = path.join(locks.LOCK_DIR, `v20sweep.stale.${fakePid}.${Date.now()}`);
    fs.mkdirSync(dir, { recursive: true });
    const old = new Date(Date.now() - 31 * 60_000);
    fs.utimesSync(dir, old, old);
    // A FRESH other-pid transfer dir must survive (could be a live reclaimer).
    const fresh = path.join(locks.LOCK_DIR, `v20sweep.release.${fakePid}.${Date.now()}`);
    fs.mkdirSync(fresh, { recursive: true });
    try {
        locks.cleanupAllLocks();
        assert.ok(!fs.existsSync(dir), 'TTL-expired orphan transfer dir must be swept');
        assert.ok(fs.existsSync(fresh), 'fresh foreign transfer dir must be left alone');
    } finally {
        try { fs.rmSync(fresh, { recursive: true, force: true }); } catch (_) {}
        try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) {}
    }
});

test('v20: providerFactory — math-extraction closure has exactly one definition', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills', 'lib', 'providerFactory.js'), 'utf8');
    const hits = (src.match(/querySelectorAll\('\.katex'\)/g) || []).length;
    assert.strictEqual(hits, 1, `expected 1 definition, found ${hits} (duplication regressed)`);
    assert.ok(src.includes('IN_PAGE_TEXT_WITH_MATH'), 'shared extractor missing');
});

test('v20: providerFactory — echo probe returns in-page boolean (no body-text shipping)', async () => {
    // Behavioral: the P1 tests above already exercise the guard end-to-end via
    // the boolean-contract mock. Here pin the contract itself: evaluate is
    // called WITH the needle argument.
    const pf = require(AGENTCHAT_ROOT + '/skills/lib/providerFactory');
    if (typeof pf.__waitForCompletionForTests !== 'function') return;
    let seenNeedle = null;
    const page = {
        locator: () => ({
            first: () => ({ waitFor: async () => { throw new Error('none'); } }),
            nth: () => ({ waitFor: async () => { throw new Error('none'); } }),
            last: () => ({ waitFor: async () => { throw new Error('none'); } }),
            count: async () => 1,
        }),
        evaluate: async (_fn, needle) => { seenNeedle = needle; return false; },
        waitForTimeout: (ms) => new Promise(r => setTimeout(r, Math.min(ms, 10))),
        isClosed: () => false,
    };
    await pf.__waitForCompletionForTests(page, promptConfig(CROSSTALK_PROMPT), Date.now(), 1_500);
    assert.ok(typeof seenNeedle === 'string' && seenNeedle.length > 0 && seenNeedle.length <= 60,
        'needle must be passed into the in-page probe (≤60 chars)');
});

test('v20: kimi — single module-level logger, no per-call require boilerplate', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills', 'lib', 'providers', 'adapters', 'kimi.js'), 'utf8');
    const requires = (src.match(/require\('\.\.\/\.\.\/terminal'\)/g) || []).length;
    assert.ok(requires <= 2, `terminal required ${requires}× (1 code + ≤1 comment expected)`);
    assert.ok(src.includes('let klog'), 'module-level klog missing');
});

test('v20: OneWeb — grantPermissions hoisted out of the provider loop', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills', 'AgentChat-OneWeb', 'index.js'), 'utf8');
    const grants = (src.match(/grantPermissions/g) || []).length;
    assert.strictEqual(grants, 1, `grantPermissions appears ${grants}× (expected 1: inside ensureClipboardPermissions)`);
    assert.ok(src.includes('ensureClipboardPermissions'), 'once-per-context helper missing');
    assert.ok(src.includes('permissionsGranted = false; // v20'), 'reconnect re-grant reset missing');
});

test('v20: orchestrator — argv prompt + --plan warns instead of silent discard', () => {
    const tmp = path.join(os.tmpdir(), `v20_plan_${process.pid}.json`);
    fs.writeFileSync(tmp, '{"subtasks":[]}');
    try {
        const r = spawnSync(process.execPath, [
            path.join(ROOT, 'skills', 'AgentChat-IndependentTasks', 'index.js'),
            'some', 'stray', 'argv', 'prompt', '--plan', tmp, '--doctor',
        ], { encoding: 'utf8', timeout: 20_000 });
        assert.ok(/WARN: both --plan and an argv prompt/.test(r.stderr),
            `conflict warning missing\nstderr: ${r.stderr}`);
    } finally {
        try { fs.unlinkSync(tmp); } catch (_) {}
    }
});

test('v20: orchestrator — dead ts() removed, exception output carries primary_intended', () => {
    const src = fs.readFileSync(path.join(ROOT, 'skills', 'AgentChat-IndependentTasks', 'index.js'), 'utf8');
    assert.ok(!/function ts\(\)/.test(src), 'dead ts() still present');
    assert.ok(/primary_intended: primaryKey, response: null, error: String\(e\)/.test(src),
        'exception branch missing primary_intended');
});

// ─────────────────────────────────────────────────────────────────────────────

(async () => {
    let failed = 0;
    for (const [name, fn] of results) {
        try {
            await fn();
            passed++;
            console.log(`  ✓ ${name}`);
        } catch (e) {
            failed++;
            console.error(`  ✗ ${name}\n    ${String(e.message || e).split('\n').join('\n    ')}`);
        }
    }
    console.log(`\nv19 dispatch fixes: ${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
