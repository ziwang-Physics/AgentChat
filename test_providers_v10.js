/* Patch-2 harness — factory hardening + adapter selectors, no browser. */
const F = require(__dirname + '/skills/lib/providerFactory.js');

let failures = 0;
const t = (cond, msg) => { console.log(cond ? '  PASS' : '  FAIL', msg); if (!cond) failures++; };

// ── mock page: routes evaluate() by fn arity/args, locator by selector ──
function makePage(state) {
    // state: { visible: Set, heuristicMeta: obj|null, editorText: fn|string, stopVisible: bool }
    const page = {
        locator(sel) {
            const self = {
                first: () => self,
                async isVisible() {
                    if (state.stopSel && sel === state.stopSel) return !!state.stopVisible;
                    return state.visible.has(sel);
                },
                async evaluate(fn) {
                    // editable check inside findEditableElement / validateEditor path
                    if (state.editableFor && sel in state.editableFor) return state.editableFor[sel];
                    return true;
                },
                async focus() {},
                async click() {},
            };
            return self;
        },
        async evaluate(fn, arg) {
            if (arg && arg.marker === 'data-fs-editor') return state.heuristicMeta || null;
            return []; // diagnostics dumps
        },
        keyboard: { press: async (k) => { page.pressed = (page.pressed || []).concat(k); } },
        async waitForTimeout() { return new Promise(r => setTimeout(r, 1)); },
    };
    return page;
}

(async () => {
    console.log('[1] findEditableElement: all selectors miss → heuristic rescue');
    let page = makePage({
        visible: new Set(['[data-fs-editor="1"]']),
        heuristicMeta: { score: 5, hint: '有问题，尽管问', total: 3 },
    });
    let logs = [];
    let ed = await F.findEditableElement(page, ['textarea[placeholder*="gone"]'], null, m => logs.push(m));
    t(ed !== null, 'heuristic rescue returns an editor locator');
    t(logs.some(m => /HEURISTIC/.test(m)), 'drift logged with hint for a permanent selector fix');

    console.log('[2] findEditableElement: heuristic also empty → diagnostics + null (no throw)');
    page = makePage({ visible: new Set(), heuristicMeta: null });
    logs = [];
    ed = await F.findEditableElement(page, ['textarea[placeholder*="gone"]'], null, m => logs.push(m));
    t(ed === null, 'returns null on total failure');
    t(logs.some(m => /DIAG: no editor selector matched/.test(m)), 'editor diagnostics dumped');

    console.log('[3] heuristic pick still gated by validateEditor');
    page = makePage({
        visible: new Set(['[data-fs-editor="1"]']),
        heuristicMeta: { score: 5, hint: 'x', total: 1 },
    });
    ed = await F.findEditableElement(page, ['#nope'], async () => false, () => {});
    t(ed === null, 'validateEditor=false rejects the heuristic pick');

    console.log('[4] verifySendEffect');
    const mkEditor = (textFn) => ({ evaluate: async (fn) => {
        // emulate the length-read: return length of current text
        const el = { tagName: 'TEXTAREA', value: textFn() };
        return fn(el);
    }, focus: async () => {} });
    const prompt = 'x'.repeat(100);

    let cleared = false;
    let editor = mkEditor(() => cleared ? '' : prompt);
    let p2 = makePage({ visible: new Set() });
    setTimeout(() => { cleared = true; }, 50);
    let eff = await F.verifySendEffect(p2, editor, prompt, { stopSelectors: [] }, 1500);
    t(eff === 'sent', 'editor cleared → sent');

    editor = mkEditor(() => prompt);
    p2 = makePage({ visible: new Set(), stopSel: '[data-testid="stop"]', stopVisible: true });
    eff = await F.verifySendEffect(p2, editor, prompt, { stopSelectors: ['[data-testid="stop"]'] }, 800);
    t(eff === 'sent', 'stop button visible → sent');

    editor = mkEditor(() => prompt);
    p2 = makePage({ visible: new Set() });
    eff = await F.verifySendEffect(p2, editor, prompt, { stopSelectors: [] }, 500);
    t(eff === 'unsent', 'full prompt still in editor → unsent (safe-retry state)');

    editor = mkEditor(() => prompt.slice(0, 50)); // 50% left — ambiguous
    p2 = makePage({ visible: new Set() });
    eff = await F.verifySendEffect(p2, editor, prompt, { stopSelectors: [] }, 500);
    t(eff === 'unknown', 'partial text → unknown (no retry, no double-send risk)');

    editor = { evaluate: async () => { throw new Error('gone'); }, focus: async () => {} };
    eff = await F.verifySendEffect(p2, editor, prompt, { stopSelectors: [] }, 400);
    t(eff === 'unknown', 'evaluate throws → unknown, never throws outward');

    console.log('[5] adapter selector hardening');
    const ds = require(__dirname + '/skills/lib/providers/adapters/deepseek.js');
    t(ds.editorSelectors[0].includes('给 DeepSeek 发送消息'), 'deepseek: specific selector still FIRST');
    t(ds.editorSelectors.includes('textarea') && ds.editorSelectors.includes('[contenteditable="true"]'),
        'deepseek: structural fallbacks appended');
    t(ds.responseSelectors[ds.responseSelectors.length - 1] === '[class*="markdown"]',
        'deepseek: generic response tail appended LAST');

    const mimo = require(__dirname + '/skills/lib/providers/adapters/mimo.js');
    t(mimo.editorSelectors[0].includes('有问题，尽管问'), 'mimo: specific selector still FIRST');
    t(mimo.editorSelectors.includes('textarea') && mimo.editorSelectors.includes('[role="textbox"]'),
        'mimo: structural fallbacks appended');

    const kimi = require(__dirname + '/skills/lib/providers/adapters/kimi.js');
    t(kimi.responseSelectors.includes('[class*="markdown"]'), 'kimi: generic response tail appended');
    t(kimi.responseSelectors[0] === '[class*="chat-content-item-assistant"]', 'kimi: specific order preserved');

    const qwen = require(__dirname + '/skills/lib/providers/adapters/qwen.js');
    t(qwen.responseSelectors.includes('[class*="markdown"]'), 'qwen: generic response tail appended');
    t(qwen.responseSelectors[0] === '[class*="message-select-wrapper-answer"]', 'qwen: specific order preserved');

    console.log('[6] exports intact (chatgpt.js imports would break otherwise)');
    for (const name of ['createProviderRunner', 'findEditableElement', 'inputViaClipboard',
        'inputViaSimulatedPaste', 'inputViaKeyboard', 'clearEditor', 'clickSend',
        'waitForCompletion', 'extractResponse', 'COMMON_CN_QUOTA_PATTERNS',
        'COMMON_DISMISS_PATTERNS', 'verifySendEffect', 'heuristicFindEditor']) {
        t(typeof F[name] !== 'undefined', `export ${name}`);
    }

    console.log('[7] all 8 adapters still load + build runners');
    for (const k of ['chatgpt', 'claude', 'deepseek', 'gemini', 'kimi', 'mimo', 'minimax', 'qwen']) {
        try {
            const cfg = require(`${__dirname}/skills/lib/providers/adapters/${k}.js`);
            const run = F.createProviderRunner(cfg);
            t(typeof run === 'function', `${k}: adapter loads, runner builds`);
        } catch (e) { t(false, `${k}: ${e.message}`); }
    }

    console.log(failures === 0 ? '\nALL TESTS PASSED' : `\n${failures} FAILURES`);
    process.exit(failures ? 1 : 0);
})();
