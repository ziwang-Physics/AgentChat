const AGENTCHAT_ROOT = require("path").resolve(__dirname, "..", "..", "..");
/**
 * Functional assertions for the patched Gemini adapter, modeling the factory's
 * exact semantics:
 *   polling element  = document-order LAST match of RESPONSE_SELECTOR
 *                      (Playwright locator(sel).last() over plain CSS)
 *   baselineCounts   = querySelectorAll(sel).length before send
 *   final text       = postResponseHook: LAST dual panel -> FIRST message-content
 *                      (Playwright chaining panels.last().locator(mc).first())
 * Fixtures replicate the DIAG dump: dual panel is a DIV with
 * class="dual-response-panel"; drafts live in <structured-content-container>
 * -> <message-content> -> .markdown.markdown-main-panel.
 */
const { JSDOM } = require('jsdom');
const fs = require('fs'), path = require('path');

const src = fs.readFileSync(path.join(AGENTCHAT_ROOT, 'skills/lib/providers/adapters/gemini.js'), 'utf8');
const SEL   = src.match(/const RESPONSE_SELECTOR = '([^']+)';/)[1];
const PANEL = src.match(/const DUAL_PANEL_SELECTOR = '([^']+)';/)[1];
console.log('RESPONSE_SELECTOR  =', JSON.stringify(SEL));
console.log('DUAL_PANEL_SELECTOR =', JSON.stringify(PANEL), '\n');

const qa    = (doc, sel) => [...doc.querySelectorAll(sel)];
const last  = (doc, sel) => qa(doc, sel).pop() || null;
// Mirror of extractFirstDraft(): last panel -> first message-content,
// gated on the currentness proof (panel tail text === factory-polled text).
const draftA = (doc, polledText) => {
    const panels = qa(doc, PANEL);
    if (!panels.length) return null;
    const drafts = qa(panels[panels.length - 1], 'message-content');
    if (!drafts.length) return null;
    const tail = drafts[drafts.length - 1].textContent.trim();
    if (tail !== (polledText || '').trim()) return null;
    return drafts[0].textContent.trim() || null;
};
// Factory-polled text = innerText of document-order-last RESPONSE_SELECTOR match
const polled = (doc) => (last(doc, SEL) ? last(doc, SEL).textContent.trim() : '');

let pass = 0, fail = 0;
const assert = (name, cond, detail = '') => {
    if (cond) { pass++; console.log('  PASS', name); }
    else      { fail++; console.log('  FAIL', name, detail); }
};

// ── Case 1: new UI, single response (fresh tab) ──────────────────────────────
{
    const doc = new JSDOM(`<div id="chat-history" class="chat-history-scroll-container">
      <user-query>prompt</user-query>
      <structured-content-container class="ng-star-inserted">
        <message-content class="ng-star-inserted"><div class="markdown markdown-main-panel">对于一个包含 42个铋原子的团簇…完整答案。</div></message-content>
      </structured-content-container>
    </div>`).window.document;
    console.log('Case 1: new UI, single response');
    assert('selector attaches (factory phase 2 unblocked)', qa(doc, SEL).length === 1, `got ${qa(doc, SEL).length}`);
    assert('.last() = the response element', last(doc, SEL).tagName === 'MESSAGE-CONTENT');
    assert('postResponseHook no-op (no panel)', draftA(doc, polled(doc)) === null);
}

// ── Case 2: new UI, dual drafts — real DOM shape (DIV.dual-response-panel) ──
{
    const doc = new JSDOM(`<div id="chat-history">
      <div class="dual-response-panel">
        <structured-content-container><message-content><div class="markdown markdown-main-panel">DRAFT_A 选项A内容。</div></message-content></structured-content-container>
        <structured-content-container><message-content><div class="markdown markdown-main-panel">DRAFT_B 选项B内容。</div></message-content></structured-content-container>
      </div>
    </div>`).window.document;
    console.log('Case 2: dual drafts (sibling containers, per DIAG)');
    assert('polling .last() = draft B (documented; stability tracks it)',
        last(doc, SEL).textContent.includes('DRAFT_B'));
    const t = draftA(doc, polled(doc));
    assert('final text = draft A', t && t.includes('DRAFT_A'), t);
    assert('NO concatenation: draft B absent from final text', t && !t.includes('DRAFT_B'), t);
}

// ── Case 3: multi-turn history + current dual panel ─────────────────────────
{
    const doc = new JSDOM(`<div id="chat-history">
      <structured-content-container><message-content>OLD_TURN_1 answer.</message-content></structured-content-container>
      <div class="dual-response-panel">
        <structured-content-container><message-content>STALE_DRAFT_A old panel.</message-content></structured-content-container>
        <structured-content-container><message-content>STALE_DRAFT_B old panel.</message-content></structured-content-container>
      </div>
      <div class="dual-response-panel">
        <structured-content-container><message-content>DRAFT_A current.</message-content></structured-content-container>
        <structured-content-container><message-content>DRAFT_B current.</message-content></structured-content-container>
      </div>
    </div>`).window.document;
    console.log('Case 3: old turn + old unresolved panel + current panel');
    const t = draftA(doc, polled(doc));
    assert('LAST panel wins: draft A of the CURRENT turn', t === 'DRAFT_A current.', t);
    assert('stale panel never leaks', !t.includes('STALE'), t);
}

// ── Case 4: baselineCounts stale-guard composition (reused tab) ─────────────
{
    const doc = new JSDOM(`<div id="chat-history">
      <structured-content-container><message-content>RESTORED_OLD answer.</message-content></structured-content-container>
    </div>`).window.document;
    console.log('Case 4: stale-guard — reused tab, restored history');
    const baseline = qa(doc, SEL).length;
    assert('pre-send baseline = 1', baseline === 1, `got ${baseline}`);
    doc.getElementById('chat-history').insertAdjacentHTML('beforeend',
      '<structured-content-container><message-content>NEW answer body.</message-content></structured-content-container>');
    assert('.nth(baseline) = first NEW node', qa(doc, SEL)[baseline].textContent.includes('NEW'));
    assert('.last() = NEW node', last(doc, SEL).textContent.includes('NEW'));
}

// ── Case 5: legacy UI regression (pre-2026-07) ───────────────────────────────
{
    const doc = new JSDOM(`<div>
      <message-content class="model-response-text">LEGACY turn 1.</message-content>
      <message-content class="model-response-text">LEGACY turn 2 newest.</message-content>
    </div>`).window.document;
    console.log('Case 5: legacy UI (.model-response-text)');
    assert('.last() = newest legacy turn', last(doc, SEL).textContent.includes('newest'));
    assert('same-element union dedupes (2 turns -> 2 matches, not 4)',
        qa(doc, SEL).length === 2, `got ${qa(doc, SEL).length}`);
    assert('postResponseHook no-op on legacy UI', draftA(doc, polled(doc)) === null);
}

// ── Case 6: wrapper-div drift (non-sibling draft containers) ─────────────────
{
    const doc = new JSDOM(`<div class="dual-response-panel">
      <div class="draft-card"><structured-content-container><message-content>DRAFT_A</message-content></structured-content-container></div>
      <div class="draft-card"><structured-content-container><message-content>DRAFT_B</message-content></structured-content-container></div>
    </div>`).window.document;
    console.log('Case 6: hypothetical wrapper divs around each draft');
    assert('chaining still yields draft A (no sibling-order CSS dependence)',
        draftA(doc, polled(doc)) === 'DRAFT_A', draftA(doc, polled(doc)));
}

// ── Case 7: custom-element panel variant (tag form insurance) ────────────────
{
    const doc = new JSDOM(`<dual-response-panel>
      <structured-content-container><message-content>DRAFT_A tag-form</message-content></structured-content-container>
      <structured-content-container><message-content>DRAFT_B tag-form</message-content></structured-content-container>
    </dual-response-panel>`).window.document;
    console.log('Case 7: panel as custom element instead of class');
    assert('tag-form panel also resolves to draft A', draftA(doc, polled(doc)) === 'DRAFT_A tag-form', draftA(doc, polled(doc)));
}

// ── Case 9 (regression for the stale-panel guard): old unresolved panel in
// restored history + CURRENT turn answers in single mode — the hook must be
// a no-op so the fresh answer is NOT overwritten by the stale draft A. ──────
{
    const doc = new JSDOM(`<div id="chat-history">
      <div class="dual-response-panel">
        <structured-content-container><message-content>STALE_DRAFT_A old.</message-content></structured-content-container>
        <structured-content-container><message-content>STALE_DRAFT_B old.</message-content></structured-content-container>
      </div>
      <structured-content-container><message-content>FRESH single-mode answer.</message-content></structured-content-container>
    </div>`).window.document;
    console.log('Case 9: stale panel + fresh single response (guard)');
    assert('polled .last() = fresh answer', polled(doc).includes('FRESH'));
    assert('hook is a no-op (stale panel rejected)', draftA(doc, polled(doc)) === null,
        String(draftA(doc, polled(doc))));
}

// ── Case 8: fallback selector sanity ─────────────────────────────────────────
{
    const doc = new JSDOM(`<message-content><div class="markdown markdown-main-panel">BODY</div></message-content>`).window.document;
    console.log('Case 8: .markdown.markdown-main-panel fallback entry');
    assert('fallback matches', last(doc, '.markdown.markdown-main-panel') !== null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
