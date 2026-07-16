/**
 * Functional assertions for the v11 tool-phase truncation fix, modeling the
 * factory's exact phase-3 semantics against a scripted mock page:
 *
 *   T1  textLooksBusy vocabulary — including the two FIELD-OBSERVED Kimi
 *       truncation tails: "正在获取网页..." and "获取网页 5 个网页"
 *   T2  waitForCompletion shrink regression — a collapsing tool card shrinks
 *       innerText; the old growth-only clock truncated MID-ANSWER
 *   T3  waitForCompletion ⚙ hold cap — a permanently-busy-looking tail must
 *       cost a bounded delay, never the whole provider budget
 *   T4  end-to-end Kimi fetch-phase scenario — status-frozen text longer than
 *       the stabilityWindow must NOT complete until the answer streams
 *   T5  makeStillWorkingCheck signal paths (S1 zero-CDP / S2 uiBusy / negative)
 *   T6  extractResponse echo guard (+ exemptions)
 *   T7  adapter wiring + overlay 登录 lookbehind (source-level, like
 *       test_gemini_selectors.js)
 *
 * No browser, no network — pure mocks. Run: node test_still_working.js
 */

'use strict';

const path = require('path');
const fs = require('fs');

const { textLooksBusy, makeStillWorkingCheck } =
    require('./skills/lib/stillWorking');
const { waitForCompletion, extractResponse } =
    require('./skills/lib/providerFactory');

const _q = [];
function await0(fn) { _q.push(fn); } // sequential async test queue

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, detail); }
};

// ── Mock page: responseEl.evaluate() walks a scripted text sequence ─────────
function makePage(script, { domProbe } = {}) {
    let i = 0;
    const current = () => script[Math.min(i, script.length - 1)];
    const el = {
        waitFor: async () => {},
        evaluate: async () => { const t = current(); i++; return t; },
        isVisible: async () => false,
    };
    const page = {
        isClosed: () => false,
        waitForTimeout: (ms) => new Promise(r => setTimeout(r, ms)),
        locator: () => ({
            last: () => el, first: () => el, nth: () => el,
            count: async () => 1,
        }),
        evaluate: async () => {
            if (domProbe === 'reject') throw new Error('evaluate blocked');
            return domProbe || { uiBusy: false, tail: '' };
        },
    };
    return { page, el, calls: () => i };
}

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT1: textLooksBusy vocabulary');
// The two exact field-observed truncation tails:
assert('field tail #1 「正在获取网页...」', textLooksBusy('前文分析…\n正在获取网页...'));
assert('field tail #2 「获取网页 5 个网页」', textLooksBusy('前文分析…\n获取网页 5 个网页'));
// Broader phase vocabulary:
for (const s of [
    '搜索中…', '深度思考中', '联网搜索中', '正在搜索相关资料',
    '正在阅读网页内容', '已阅读 12 个网页', '搜索到 8 条结果', '5 个结果',
    '让我再搜索一下最新数据', '还需要更多资料', 'Searching the web',
    'Reading 5 pages…', 'Thinking', '3 results',
]) assert(`busy: ${JSON.stringify(s)}`, textLooksBusy('blah\n' + s));
// Negatives — real answers must not be classified busy:
assert('prose ending w/ 搜索 mention (long line)', !textLooksBusy(
    '综上所述，通过对文献的系统搜索与比对，可以确认该反应路径在 Au(111) 表面上是主导通道。'));
assert('plain short ending', !textLooksBusy('计算完成。\n结果为 42。'));
assert('status buried ABOVE >6 trailing lines', !textLooksBusy(
    '正在获取网页...\n' + Array.from({length: 8}, (_, k) => `来源 ${k}: 一段较长的最终参考文献描述文本，超过状态行长度上限的普通句子。`).join('\n')));
assert('empty', !textLooksBusy(''));

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT2: phase-3 shrink regression (collapsing tool card)');
await0(async () => {
    // peak(card inflated) ×3 → card collapses (SHRINK) → answer streams, all
    // BELOW the old peak → final constant. Growth-only logic would expire the
    // window during the shrink/regrow phase and truncate mid-answer.
    const FINAL = 'FINAL:' + 'A'.repeat(474);
    const script = [
        'P'.repeat(500), 'P'.repeat(500), 'P'.repeat(500),
        'A'.repeat(120), 'A'.repeat(180), 'A'.repeat(240),
        'A'.repeat(300), 'A'.repeat(360), 'A'.repeat(420),
        FINAL,
    ];
    const ticks = [];
    const { page, el } = makePage(script);
    const cfg = {
        responseSelectors: ['x'], stabilityWindow: 200, pollInterval: 40,
        onProgress: t => ticks.push(t),
    };
    const start = Date.now();
    const got = await waitForCompletion(page, cfg, start, 8000);
    assert('returns responseEl', !!got);
    const text = await el.evaluate(() => {});
    assert('completed on FINAL text (no mid-answer truncation)',
        text === FINAL, `got len=${text.length}`);
    assert("shrink emitted '~' ticks", ticks.includes('~'), ticks.join(''));
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT3: ⚙ hold cap bounds a permanently-busy-looking tail');
await0(async () => {
    const script = ['正在获取网页...']; // never changes, always "busy"
    const { page } = makePage(script);
    const cfg = {
        responseSelectors: ['x'], stabilityWindow: 150, pollInterval: 40,
        stillGeneratingMaxHoldMs: 500,
        stillGeneratingCheck: async (_p, info) => textLooksBusy(info.text),
    };
    const t0 = Date.now();
    await waitForCompletion(page, cfg, t0, 10_000);
    const dt = Date.now() - t0;
    assert('held past plain window (⚙ worked)', dt > 400, `dt=${dt}`);
    assert('but bounded far below deadline (cap worked)', dt < 2500, `dt=${dt}`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT4: end-to-end Kimi fetch-phase scenario');
await0(async () => {
    // Answer-so-far + frozen fetch status for 12 polls (480ms >> 150ms window)
    // → fetch completes, analysis streams → final. The v10 adapter truncated
    // exactly here; v11 must hold through the freeze and return the FINAL text.
    const frozen = 'X'.repeat(300) + '\n正在获取网页...';
    const FINAL = 'X'.repeat(300) + '\n' + '正文'.repeat(120) + '\n结论：完成。';
    const script = [
        ...Array(12).fill(frozen),
        'X'.repeat(300) + '\n' + '正文'.repeat(40),
        'X'.repeat(300) + '\n' + '正文'.repeat(80),
        FINAL,
    ];
    const { page, el } = makePage(script);
    const check = makeStillWorkingCheck({ responseSelectors: ['x'] });
    const cfg = {
        responseSelectors: ['x'], stabilityWindow: 150, pollInterval: 40,
        stillGeneratingCheck: check, stillGeneratingMaxHoldMs: 5000,
    };
    const t0 = Date.now();
    const got = await waitForCompletion(page, cfg, t0, 10_000);
    const dt = Date.now() - t0;
    assert('survived the frozen fetch phase', dt > 12 * 40, `dt=${dt}`);
    assert('returned', !!got);
    const text = await el.evaluate(() => {});
    assert('final text intact (bug fixed)', text === FINAL, `len=${text.length}`);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT5: makeStillWorkingCheck signal paths');
await0(async () => {
    const check = makeStillWorkingCheck({ responseSelectors: ['x'] });
    // S1: busy verdict from factory-supplied text, ZERO CDP (evaluate rejects)
    const { page: p1 } = makePage([''], { domProbe: 'reject' });
    assert('S1 zero-CDP busy from info.text',
        await check(p1, { text: '…\n获取网页 5 个网页' }) === true);
    // S2: uiBusy from DOM probe
    const { page: p2 } = makePage([''], { domProbe: { uiBusy: true, tail: '' } });
    assert('S2 uiBusy → true', await check(p2, { text: '普通结尾。' }) === true);
    // S3b: busy tail visible only in the probe's host subtree
    const { page: p3 } = makePage([''], { domProbe: { uiBusy: false, tail: '正在阅读网页内容' } });
    assert('S3b probe-tail busy → true', await check(p3, { text: '普通结尾。' }) === true);
    // Negative: calm everywhere
    const { page: p4 } = makePage([''], { domProbe: { uiBusy: false, tail: '结论：完成。' } });
    assert('calm → false', await check(p4, { text: '结论：完成。' }) === false);
    // Robustness: evaluate rejects + calm text → false, never throws
    const { page: p5 } = makePage([''], { domProbe: 'reject' });
    assert('evaluate failure → false (no throw)',
        await check(p5, { text: '结论：完成。' }) === false);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT6: extractResponse echo guard');
await0(async () => {
    const mk = (text) => ({ evaluate: async () => text });
    const cfg = { minResponseLength: 5 };
    const prompt = '请分析这个反应路径的过渡态能量并给出与实验值的对比结论。';
    assert('exact echo rejected',
        await extractResponse(null, mk(prompt), cfg, prompt) === null);
    assert('echo + UI labels rejected',
        await extractResponse(null, mk(prompt + ' 复制'), cfg, prompt) === null);
    assert('real answer passes',
        await extractResponse(null, mk('过渡态能垒为 0.87 eV，与实验值 0.9±0.05 eV 一致。'), cfg, prompt)
        !== null);
    assert('substring-style short answer to long prompt passes (repeat-after-me)',
        await extractResponse(null, mk('过渡态能量'), cfg, prompt) !== null);
    assert('short prompt exempt',
        await extractResponse(null, mk('你好呀朋友'), cfg, '你好呀朋友') !== null);
});

// ═════════════════════════════════════════════════════════════════════════════
console.log('\nT7: adapter wiring + overlay 登录 lookbehind');
await0(async () => {
    const kimi = require('./skills/lib/providers/adapters/kimi');
    assert('kimi check is the shared detector',
        typeof kimi.stillGeneratingCheck === 'function');
    assert('kimi hold cap = 180s', kimi.stillGeneratingMaxHoldMs === 180_000);
    const { page } = makePage([''], { domProbe: 'reject' });
    assert('kimi check catches field tail #1',
        await kimi.stillGeneratingCheck(page, { text: '…\n正在获取网页...' }) === true);
    assert('kimi check catches field tail #2',
        await kimi.stillGeneratingCheck(page, { text: '…\n获取网页 5 个网页' }) === true);

    for (const k of ['minimax', 'deepseek', 'qwen', 'mimo']) {
        const a = require(`./skills/lib/providers/adapters/${k}`);
        assert(`${k}: shared check wired`, typeof a.stillGeneratingCheck === 'function'
            && Number.isFinite(a.stillGeneratingMaxHoldMs));
    }
    const gemini = require('./skills/lib/providers/adapters/gemini');
    assert('gemini hold cap raised to 300s (Pro Extended preserved)',
        gemini.stillGeneratingMaxHoldMs === 300_000);
    const claude = require('./skills/lib/providers/adapters/claude');
    assert('claude editor order: specific first',
        claude.editorSelectors[0] === '.ProseMirror'
        && claude.editorSelectors[claude.editorSelectors.length - 1] === '[contenteditable="true"]');
    const chatgpt = require('./skills/lib/providers/adapters/chatgpt');
    assert('chatgpt untouched (stop-button pipeline)', !chatgpt.stillGeneratingCheck);

    // Source-level: the overlay login regex must NOT hard-block 退出登录/免登录
    const src = fs.readFileSync(
        path.join(__dirname, 'skills/lib/providerFactory.js'), 'utf8');
    const m = src.match(/if \((\/\(\?:\\blog[^\n]+?\/i)\.test\(text\)\) \{/);
    assert('login regex found in source', !!m);
    if (m) {
        const re = eval(m[1]); // eslint-disable-line no-eval — test-only
        assert('「退出登录」 not auth', !re.test('设置 退出登录 深色模式'));
        assert('「免登录体验」 not auth', !re.test('免登录体验新功能'));
        assert('「已登录」 not auth', !re.test('已登录：user@example.com'));
        assert('「请先登录」 IS auth', re.test('请先登录后继续'));
        assert('「登录」 alone IS auth', re.test('登录 / 注册'));
        assert('"Log in" IS auth', re.test('Log in to continue'));
        assert('"Blogindex" not auth', !re.test('Blogindex weekly'));
    }
});

// ── run queue (keeps top-level await-free for plain node) ────────────────────
(async () => {
    // T1 already ran synchronously above via direct calls — the queue holds T2+.
    for (const fn of _q) await fn();
    console.log(`\n${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
})();
