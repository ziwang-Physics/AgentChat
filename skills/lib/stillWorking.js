/**
 * stillWorking.js — shared multi-signal "generation still in progress" detector.
 *
 * WHY THIS EXISTS (Kimi 联网搜索 truncation, 2026-07):
 * Kimi's multi-step web search pipeline emits phase statuses the old
 * kimi.js tail regexes never covered — the char class 正在[搜索检索查询]
 * does not contain 获取, and "N 个网页" is not "N 个结果". During a
 * 5–30s page-fetch the response text is static longer than the 8s
 * stabilityWindow, so the factory declared completion mid-search. Two
 * field-observed truncation tails:
 *     "正在获取网页..."          (45s run,  960 chars)
 *     "获取网页 5 个网页"        (78s run, 1522 chars)
 * Neither matched any old pattern. The same failure class applies to
 * every provider with an agentic tool phase (MiniMax agent, DeepSeek R1
 * 深度思考折叠, Qwen deep search, MiMo), so the detector lives here as a
 * shared module instead of being re-fixed one adapter at a time.
 *
 * DESIGN — three OR'd signals, ordered cheap→expensive:
 *   S1 (zero CDP cost)  factory-supplied polled text tail looks like an
 *                       in-flight status line (textLooksBusy).
 *   S2 (1 evaluate)     a stop/pause control is visible (the send button
 *                       flips to a stop control while streaming) — the
 *                       strongest wording- and locale-independent signal.
 *   S3 (same evaluate)  a spinner/typing indicator is visible INSIDE the
 *                       last response container, or that container's own
 *                       text tail looks busy (covers the case where the
 *                       status lives in a tool card OUTSIDE the node the
 *                       factory happens to poll).
 *
 * FALSE-POSITIVE BUDGET: a wrong "busy" verdict can only DELAY completion,
 * and providerFactory.js v11 bounds that delay with
 * stillGeneratingMaxHoldMs (the ⚙ hold cap): once no REAL text change has
 * happened for that long, ⚙ resets are ignored and the normal stability
 * window takes over. So patterns here are tuned for recall (catch every
 * status wording) rather than precision — a miss truncates a response,
 * a false hit costs bounded seconds.
 */

'use strict';

// ── Text-tail classifier (pure, unit-testable) ──────────────────────────────

// Status chips are SHORT; real prose sentences are not. Only lines at or
// under this length are eligible to be classified as a status.
const STATUS_LINE_MAX = 48;
// How many trailing non-empty lines of the container text to inspect.
// Status cards sometimes render a couple of source-chip lines AFTER the
// status itself, so we look at a small tail window, not just the last line.
const TAIL_LINES = 6;

// Verb vocabulary for CJK tool-phase statuses. Deliberately broad — see
// FALSE-POSITIVE BUDGET above. 获取/抓取/阅读/浏览 are the fetch-phase verbs
// missing from the original kimi.js patterns.
const CN_VERBS =
    '搜索|检索|查询|获取|抓取|读取|阅读|浏览|访问|打开|解析|分析|整理|归纳|'
    + '总结|思考|推理|撰写|生成|调用|执行|等待|加载|联网';

const STATUS_PATTERNS = [
    // "正在获取网页…" / "正在搜索…" / "开始分析…" / "继续浏览…"
    new RegExp(`^(?:正在|开始|继续|准备)(?:${CN_VERBS})`),
    // "搜索中…" / "深度思考中" / "联网搜索中" — up to 4 CJK prefix chars
    new RegExp(`^[\\u4e00-\\u9fa5]{0,4}(?:${CN_VERBS})中(?:[.。…]{0,3})?$`),
    // "获取网页 5 个网页" / "已阅读 12 个网页" / "搜索到 8 条结果" / "5 个结果"
    new RegExp(
        `^(?:已|共)?(?:(?:${CN_VERBS})(?:了|到|网页|资料|来源|链接|结果)?)?`
        + `\\s*\\d+\\s*[个条篇]\\s*(?:网页|结果|来源|链接|页面|资料|文件)`
    ),
    // "让我再搜索一下" / "还需要更多资料"
    /^让我(?:再|先|继续)/,
    /^还需(?:要|更)/,
    // English tool-phase gerunds ("Searching the web", "Reading 5 pages…").
    // A short heading in a final answer can false-positive here — bounded
    // by the factory's ⚙ hold cap, see module header.
    /^(?:Searching|Browsing|Reading|Fetching|Crawling|Visiting|Opening|Gathering|Analyzing|Thinking|Reasoning|Running|Working)\b/i,
    /^\d+\s*(?:results?|sources?|pages?)\s*$/i,
];

/**
 * Does the TAIL of this text look like an in-flight tool/status line?
 * Inspects the last TAIL_LINES non-empty lines; only short lines qualify.
 *
 * @param {string} text - container innerText (full or tail slice)
 * @returns {boolean}
 */
function textLooksBusy(text) {
    if (!text) return false;
    const lines = String(text).split('\n').map(s => s.trim()).filter(Boolean);
    const tail = lines.slice(-TAIL_LINES);
    for (const line of tail) {
        if (line.length > STATUS_LINE_MAX) continue; // prose sentence, not a chip
        if (STATUS_PATTERNS.some(p => p.test(line))) return true;
    }
    return false;
}

// ── DOM-side probe (single page.evaluate) ────────────────────────────────────
// Runs in the page. RegExps cannot cross the evaluate boundary, so the DOM
// class/aria heuristics are self-contained string sources here; the TEXT
// classification stays in Node (textLooksBusy) on the returned tail.
function _domProbe({ sels }) {
    const visible = el => {
        try {
            if (!el || !el.getBoundingClientRect) return false;
            const r = el.getBoundingClientRect();
            if (r.width <= 0 || r.height <= 0) return false;
            const s = getComputedStyle(el);
            return s.visibility !== 'hidden' && s.display !== 'none'
                && s.opacity !== '0';
        } catch (_) { return false; }
    };

    // Last response container, honoring the ADAPTER's own selector order —
    // the probe must judge the same subtree family the factory polls.
    let host = null;
    for (const sel of sels || []) {
        let list;
        try { list = document.querySelectorAll(sel); } catch (_) { continue; }
        if (list && list.length) { host = list[list.length - 1]; break; }
    }

    // S2: stop/pause control anywhere on the page. Class-token or aria
    // anchored — bare substring "stop" would hit "one-stop" marketing copy.
    const STOPISH = /(?:^|[\s_-])(?:stop|pause)[-_]?(?:btn|button|icon|generat|answer|respon)|(?:^|[\s_-])generating(?:$|[\s_-])/i;
    const STOP_ARIA = /停止|stop\s*(?:generat|respon|answer)|暂停/i;
    let uiBusy = false;
    let scanned = 0;
    let ctrls;
    try {
        ctrls = document.querySelectorAll(
            'button, [role="button"], [class*="stop" i], [class*="pause" i]'
        );
    } catch (_) { ctrls = []; }
    for (const el of ctrls) {
        if (++scanned > 400) break;
        const aria = (el.getAttribute && (el.getAttribute('aria-label') || '')) || '';
        const cls = typeof el.className === 'string' ? el.className : '';
        if ((STOP_ARIA.test(aria) || STOPISH.test(cls)) && visible(el)) {
            uiBusy = true; break;
        }
    }

    // S3a: spinner / typing indicator INSIDE the last response container.
    // [^a-z] boundary (case-insensitive) keeps "download(ing)" from matching
    // "loading". camelCase boundaries are accepted misses — signals are OR'd.
    if (!uiBusy && host) {
        const SPIN = /(?:^|[^a-z])(?:loading|spinner|dot(?:ting)?[-_]?(?:flashing|typing|pulse)?|animate-spin|typing(?:[-_]?indicator)?|shimmer|skeleton|blinking?|cursor[-_]?blink)/i;
        let n = 0;
        let nodes;
        try { nodes = host.querySelectorAll('[class]'); } catch (_) { nodes = []; }
        for (const el of nodes) {
            if (++n > 800) break;
            const cls = typeof el.className === 'string' ? el.className : '';
            if (cls && SPIN.test(cls) && visible(el)) { uiBusy = true; break; }
        }
    }

    const text = host ? (host.innerText || host.textContent || '') : '';
    return { uiBusy, tail: String(text).slice(-1500) };
}

/**
 * Build a stillGeneratingCheck for providerFactory.
 *
 * @param {object} opts
 * @param {string[]} opts.responseSelectors - SAME array the adapter hands the
 *        factory, so the probe and the stability poller judge the same
 *        container family (the old kimi.js check hardcoded selector [0] and
 *        silently diverged whenever the factory matched a fallback selector).
 * @returns {(page: import('playwright-core').Page, info?: {text?: string}) => Promise<boolean>}
 */
function makeStillWorkingCheck(opts = {}) {
    const sels = Array.isArray(opts.responseSelectors)
        ? opts.responseSelectors.slice()
        : [];
    return async function stillWorkingCheck(page, info) {
        // S1 — zero-cost: classify the text the factory ALREADY read this
        // poll (perfectly aligned with the element driving the stability
        // clock). Factory v11 passes { text }; older callers pass nothing.
        if (info && typeof info.text === 'string' && textLooksBusy(info.text)) {
            return true;
        }
        // S2 + S3 — one CDP round-trip.
        let probe = null;
        try {
            probe = await page.evaluate(_domProbe, { sels });
        } catch (_) {
            return false; // page gone / CSP — never break the poller
        }
        if (!probe) return false;
        if (probe.uiBusy) return true;
        // S3b — the probe's host subtree can include tool/status cards that
        // sit OUTSIDE the factory-polled node; classify its tail too.
        if (typeof probe.tail === 'string' && probe.tail
            && probe.tail !== (info && info.text)) {
            return textLooksBusy(probe.tail);
        }
        return false;
    };
}

module.exports = {
    textLooksBusy,
    makeStillWorkingCheck,
    // exported for tests / diagnostics
    STATUS_PATTERNS,
    STATUS_LINE_MAX,
    TAIL_LINES,
    _domProbe,
};
