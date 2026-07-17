#!/usr/bin/env node
/**
 * AI Fallback Chain — Multi-Provider CDP Bridge
 *
 * Priority chain: Gemini (Pro Extended) → ChatGPT → Claude → Qwen → Kimi → MiniMax → MiMo → DeepSeek
 * Falls to next provider on quota exhaustion or service unavailability.
 * Only ONE provider is used per invocation — first available wins.
 *
 * Usage:
 *   node index.js "Your prompt here"
 *   node index.js --timeout=600000 "Long prompt..."
 *   echo "Prompt from stdin" | node index.js
 *   node index.js --smoke          # verify at least one provider reachable
 *   node index.js --doctor         # check CDP connectivity only
 *   node index.js --from=ChatGPT   # start from a specific provider
 *   node index.js --from=Claude --single "..."  # try ONLY Claude, no cascade
 *                                   # (used by AgentChat-IndependentTasks, which owns
 *                                   # its own cross-provider fallback + locking)
 *   node index.js --no-download-images "..."  # skip image download post-processing
 *
 * Exit codes:
 *   0 - Success (response on stdout)
 *   1 - Chrome CDP not reachable (ERR_NO_CDP)
 *   2 - No provider reachable — all auth-gated (ERR_NO_PROVIDER)
 *   3 - Safety rejected by all providers (ERR_SAFETY_REJECTED)
 *   4 - Internal error (ERR_INTERNAL)
 *   5 - All providers rate-limited (ERR_RATE_LIMITED)
 *   9 - All providers exhausted, mixed reasons (ERR_ALL_EXHAUSTED)
 *  10 - Total timeout reached (ERR_TIMEOUT)
 *  64 - Usage error (empty prompt / malformed flag) — EX_USAGE. Was 1, which
 *       collided with ERR_NO_CDP and read as "browser down" to orchestrators.
 */

// ── Guarded requires (v14) ──
// Two install-time failure modes previously surfaced as a raw MODULE_NOT_FOUND
// stack with no fix attached:
//   1. playwright-core missing — user skipped `npm install` in the skill dir.
//   2. ../lib missing — user copied ONLY AgentChat-OneWeb/ into
//      ~/.claude/skills/ without the sibling skills/lib/ tree (all shared
//      pipeline code lives there). Both now fail with the exact command.
let chromium;
try {
    ({ chromium } = require('playwright-core'));
} catch (e) {
    process.stderr.write(
        '[fallback] FATAL: playwright-core not installed.\n' +
        `[fallback]   fix: cd ${__dirname} && npm install\n`);
    process.exit(4);
}
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

try {
    require.resolve('../lib/errors');
} catch (e) {
    process.stderr.write(
        '[fallback] FATAL: shared library ../lib not found.\n' +
        '[fallback]   AgentChat-OneWeb requires the sibling skills/lib/ directory.\n' +
        '[fallback]   fix: copy the WHOLE skills/ tree (AgentChat-OneWeb/ + lib/) so that\n' +
        `[fallback]        ${path.resolve(__dirname, '..', 'lib')} exists.\n`);
    process.exit(4);
}
const { ProviderError, classifyError } = require('../lib/errors');
const { createProviderRunner, appendWithRotation } = require('../lib/providerFactory');
const { makeRunId, emitReceipt } = require('../lib/receipt');
const { log: _log, startTimer: _startTimer, spinner } = require('../lib/terminal');
const { connectWithRetry: _connectWithRetry, doctorCheck: _doctorCheck, ensureChromeCdp, startHint, isWSL } = require('../lib/cdp');

// ── Adapt shared modules to OneWeb naming conventions ──
const PREFIX = 'fallback';
const log = (msg) => _log(PREFIX, msg);
const startTimer = (label) => _startTimer(PREFIX, label);
const connectWithRetry = (cdpUrl, retries) => _connectWithRetry(chromium, cdpUrl, retries, log);
const doctorCheck = () => _doctorCheck(true, log);

// ══════════════════════════════════════════════════════════════════════════════
// CONFIG
// ══════════════════════════════════════════════════════════════════════════════

const CDP_URL = `http://127.0.0.1:${process.env.CDP_PORT || '9222'}`;
const DEFAULT_TOTAL_TIMEOUT = 600_000; // 10 min total across all providers
const DEFAULT_PROVIDER_TIMEOUT = 180_000; // 3 min per provider
const SKILL_DIR = path.dirname(__filename); // skill directory for telemetry

// ══════════════════════════════════════════════════════════════════════════════
// INVOCATION CONTEXT — per-run state isolated from module globals (P0-2)
// ══════════════════════════════════════════════════════════════════════════════

class InvocationContext {
    constructor() {
        // Execution receipt id — random per run, quoted by the calling agent
        // as proof the skill actually executed (see lib/receipt.js).
        this.runId = makeRunId();
        this.telemetry = {
            run_id: this.runId,
            timestamp: new Date().toISOString(),
            provider_used: null,
            providers_tried: [],
            fallback_reasons: {},
            prompt_length_chars: 0,
            response_length_chars: 0,
            total_ms: 0,
            per_provider_ms: {},
            exit_code: 0,
        };
    }

    recordTelemetry(code) {
        this.telemetry.exit_code = code;
        const f = path.join(SKILL_DIR, 'data', 'fallback-telemetry.jsonl');
        appendWithRotation(f, JSON.stringify(this.telemetry) + '\n');
        // Execution receipt — single choke point covering every exit path
        // (success AND failure both prove "the skill ran"). STDERR on purpose:
        // this file's stdout is the raw-response machine contract consumed
        // verbatim by lib/execute.js / the Python SDK / the MCP server, and a
        // receipt line there would be embedded into the answer text.
        emitReceipt({
            skillDir: SKILL_DIR,
            skill: 'AgentChat-OneWeb',
            runId: this.runId,
            fields: {
                exit: code,
                provider_used: this.telemetry.provider_used,
                providers_tried: this.telemetry.providers_tried,
                total_ms: this.telemetry.total_ms,
                // v14: image-download results ride in the receipt — in piped
                // (non-TTY) mode the markdown summary no longer pollutes the
                // stdout machine contract, so this is the machine-readable
                // place a calling agent learns whether downloads happened.
                ...(this.telemetry.images_ok !== undefined
                    ? { images_ok: this.telemetry.images_ok,
                        images_failed: this.telemetry.images_failed }
                    : {}),
            },
            stream: 'stderr',
        });
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER CHAIN (priority order — first available wins)
// ══════════════════════════════════════════════════════════════════════════════

// Single source of truth: lib/providers/chain.js (also consumed by IndependentTasks,
// which must NOT require this file — that would load playwright-core + 8 adapters).
const { PROVIDER_CHAIN } = require('../lib/providers/chain');

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER RUNNERS — factory-built from adapter configs in lib/providers/adapters/
// ══════════════════════════════════════════════════════════════════════════════
//   Gemini:  Pro Extended activation, bursty-output detection, 120s stop extension
//   ChatGPT: 3-tier input (clipboard → simulated paste → chunked keyboard)
//   Claude:  ProseMirror editor, Thinking placeholder filter
//   Qwen:    React SPA 3s delay, stop-btn detached (not hidden), model-name strip
//   Kimi:    New-session hook per call, .send-button-container disabled detection
//   MiniMax: TipTap/ProseMirror async mount 4s delay
//   MiMo:    DOM-traversal send button, React SPA 4s delay
//   DeepSeek: Standard pipeline, ds-markdown response

const PROVIDER_KEYS = ['gemini','chatgpt','claude','qwen','kimi','minimax','mimo','deepseek'];
const RUNNERS = Object.fromEntries(PROVIDER_KEYS.map(k => {
  const cfg = require(`../lib/providers/adapters/${k}`);
  // Gemini uses its own spinner-free runner; all others share the progress spinner
  return [k, createProviderRunner(k === 'gemini' ? cfg : { ...cfg, onProgress: spinner })];
}));

// ══════════════════════════════════════════════════════════════════════════════
// SHARED HELPERS
// ══════════════════════════════════════════════════════════════════════════════

/** Resolve hostnames to check for an already-open provider tab. */
function getProviderHosts(provider) {
    if (provider.tabHosts) return provider.tabHosts;
    try { return [new URL(provider.url).hostname]; } catch { return []; }
}

/**
 * Find an already-open tab for a given provider (or null).
 *
 * BUGFIX (self-DoS): the previous isProviderTabOpen() + "skip if open" logic,
 * combined with keep-tabs-always-on, made sequential invocations block
 * themselves: run 1 succeeds on Gemini and keeps the tab → run 2 sees the tab,
 * classifies Gemini as "in use", and falls to ChatGPT → after a few runs all
 * 8 providers are permanently blocked by their own historical tabs (exit 9).
 *
 * Fix: REUSE the existing tab instead of skipping the provider. page.goto(url)
 * on the existing tab starts a fresh chat, so reuse is functionally identical
 * to a new tab and also stops tab accumulation. Concurrent-worker isolation is
 * the job of IndependentTasks's file locks (and --single), not tab heuristics.
 */
function findProviderPage(context, provider) {
    const hosts = getProviderHosts(provider);
    return context.pages().find(p => {
        try {
            // HOSTNAME MATCH (was: substring over the FULL URL). A tab whose
            // path/query merely MENTIONS a provider domain — e.g. a Google
            // search for "gemini.google.com api" — matched the old
            // pu.includes(host) check, and the runner then page.goto()'d that
            // tab away: navigating an unrelated USER tab, exactly what the
            // keep-tabs policy forbids. Parse the URL and compare hostnames
            // (exact or subdomain) instead.
            const pageUrl = p.url();
            if (!pageUrl || pageUrl.startsWith('about:')) return false;
            const host = new URL(pageUrl).hostname;
            return hosts.some(h => host === h || host.endsWith('.' + h));
        } catch { return false; }
    }) || null;
}

// ══════════════════════════════════════════════════════════════════════════════
// IMAGE DOWNLOAD HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const IMG_EXT_PATTERN = /\.(png|jpg|jpeg|gif|webp|svg)(\?.*)?$/i;
// v17: also capture data: URIs — collectResponseImages converts blob: URLs to
// self-contained data URIs so they survive serialization across the CDP boundary
// and can be decoded + written by downloadAllImages without a browser round-trip.
const MARKDOWN_IMG_RE = /!\[.*?\]\((https?:\/\/[^\s)]+|data:image\/[^\s)]+)\)/g;
const HTML_IMG_RE = /<img[^>]+src=["']((?:https?:\/\/|data:image\/)[^\s"']+)["'][^>]*>/gi;
// v14: `)` excluded from the query char class — `(see https://x/a.png?q=1)`
// previously captured the closing paren into the URL and 404'd the download.
const DIRECT_URL_RE = /https?:\/\/[^\s"'`<>]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s"'`<>)]*)?/gi;

// ── v14: download-phase hard limits ──
// The download phase runs AFTER the provider chain, OUTSIDE totalTimeout, on
// URLs extracted from UNTRUSTED text (the web AI's response — reachable by
// prompt injection). Before v14 it had: no image-count cap, no byte cap, no
// overall budget, and tier-2's in-page fetch had NO timeout at all — a single
// hanging endpoint stalled page.evaluate forever, the CDP socket kept the
// event loop alive, and the process NEVER exited: no stdout flush, no receipt.
// Under IndependentTasks the SIGTERM watchdog then killed a run whose ANSWER
// was already complete — a provider failure manufactured out of a stuck JPEG.
const MAX_IMAGES_PER_RESPONSE = 20;          // urls beyond this are skipped, loudly
const MAX_IMAGE_BYTES = 30 * 1024 * 1024;    // per-image payload cap
const DOWNLOAD_PHASE_BUDGET_MS = 120_000;    // whole-phase deadline
const IN_PAGE_FETCH_TIMEOUT_MS = 25_000;     // tier-2 fetch AbortSignal
const EVALUATE_RACE_TIMEOUT_MS = 30_000;     // guard for a wedged CDP evaluate

// v14: canonical image-generation enhancement (SKILL.md 图片协议 §1). Appended
// by index.js itself when --image is passed — prompt-side enhancement used to
// be a prose-only obligation on the calling agent, the exact compliance class
// lib/receipt.js exists to eliminate. telemetry.image_prompt_enhanced records it.
const IMAGE_ENHANCE_INSTRUCTION =
    '\n\n[系统指令] 请使用你的图片生成模型/工具（如 nano banana pro/gpt image/flux.2/seedream等）主动生成上述要求的图片。' +
    '生成后请提供图片的下载链接或在回答中嵌入图片。如果无法生成图片，请明确说明原因。';

/**
 * v14: Refuse to fetch response-supplied URLs that point at loopback,
 * link-local, or RFC1918 hosts. Attack shape: a prompt-injected
 * `![x](http://127.0.0.1:9222/json/list)` in the web AI's answer would make
 * the direct tier write the CDP target list (debug websocket URLs for every
 * tab of the user's browser) into a file in the user's cwd — and the
 * credentialed browser tiers could probe LAN endpoints with session cookies.
 * Literal-IP/hostname check only (DNS rebinding is out of scope for a CLI
 * that downloads a handful of images). Tests / intranet use can opt out via
 * AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS=1.
 */
function isBlockedImageHost(url) {
    // v17: data: URIs have no host — always safe (self-contained payload).
    if (/^data:/i.test(url)) return false;
    if (process.env.AGENTCHAT_ALLOW_PRIVATE_IMAGE_HOSTS === '1') return false;
    try {
        const u = new URL(url);
        if (!/^https?:$/.test(u.protocol)) return true;
        const h = u.hostname.toLowerCase();
        if (h === 'localhost' || h === '::1' || h === '[::1]' || h === '0.0.0.0') return true;
        if (/^127\./.test(h)) return true;                    // loopback
        if (/^169\.254\./.test(h)) return true;               // link-local / cloud metadata
        if (/^10\./.test(h) || /^192\.168\./.test(h)) return true;   // RFC1918
        if (/^172\.(1[6-9]|2\d|3[01])\./.test(h)) return true;       // RFC1918
        return false;
    } catch (_) {
        return true; // unparseable URL — never fetch blind
    }
}

function extractImageUrls(text) {
    const urls = new Set();
    for (const m of text.matchAll(MARKDOWN_IMG_RE)) urls.add(m[1]);
    for (const m of text.matchAll(HTML_IMG_RE)) urls.add(m[1]);
    for (const m of text.matchAll(DIRECT_URL_RE)) urls.add(m[0]);
    return [...urls];
}

/**
 * v14: Direct (cookieless) fetch, buffered with hard caps. Fixes three holes
 * the streaming version had:
 *   1. Relative `Location:` redirects (`/path` — extremely common) were passed
 *      straight back into http.get and died with a bogus request; 303 wasn't
 *      followed at all. Now resolved against the current URL; only http(s)
 *      targets are followed; redirect targets re-pass the blocked-host check.
 *   2. No size cap — a hostile/misbehaving endpoint could stream gigabytes to
 *      disk. Aborts past MAX_IMAGE_BYTES (content-length checked first).
 *   3. No payload sniffing — an HTML error page served with HTTP 200 was
 *      written to disk as a corrupt ".png" and reported status:'ok' (the exact
 *      class v13 fixed for the BROWSER tiers, left open on this one).
 *
 * @returns {Promise<{buffer: Buffer, contentType: string}>}
 */
function fetchDirectBuffered(url, redirects) {
    redirects = redirects || 0;
    if (redirects > 3) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, { timeout: 30000 }, (res) => {
            if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                res.resume(); // drain — free the socket
                const loc = res.headers.location;
                if (!loc) return reject(new Error(`HTTP ${res.statusCode} redirect without Location`));
                let next;
                try { next = new URL(loc, url).toString(); } // relative Location support
                catch (_) { return reject(new Error(`Unparseable redirect target: ${loc.slice(0, 80)}`)); }
                if (!/^https?:/i.test(next)) return reject(new Error('Redirect to non-http(s) target'));
                if (isBlockedImageHost(next)) return reject(new Error('Redirect to blocked host'));
                return fetchDirectBuffered(next, redirects + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const declared = parseInt(res.headers['content-length'] || '0', 10);
            if (declared > MAX_IMAGE_BYTES) {
                req.destroy();
                return reject(new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte cap (content-length ${declared})`));
            }
            const chunks = [];
            let total = 0;
            res.on('data', (c) => {
                total += c.length;
                if (total > MAX_IMAGE_BYTES) {
                    req.destroy();
                    return reject(new Error(`Image exceeds ${MAX_IMAGE_BYTES} byte cap`));
                }
                chunks.push(c);
            });
            res.on('end', () => resolve({
                buffer: Buffer.concat(chunks),
                contentType: res.headers['content-type'] || '',
            }));
            res.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
}

/**
 * Back-compat wrapper (was the streaming direct downloader). Now buffered,
 * capped, redirect-correct, and sniff-gated: refuses to write a payload that
 * isn't a real image.
 */
async function downloadFile(url, destPath, redirects) {
    const { buffer, contentType } = await fetchDirectBuffered(url, redirects || 0);
    const ext = sniffImageExt(buffer, contentType);
    if (!buffer.length || !ext) {
        throw new Error(`non-image payload (${(contentType || 'unknown type').slice(0, 40)})`);
    }
    fs.writeFileSync(destPath, buffer);
    return destPath;
}

/**
 * v13: Identify an image payload and its extension from content-type and/or
 * magic bytes. Returns null for anything that isn't an image — including the
 * text/html error pages some endpoints serve with HTTP 200, which would
 * otherwise be written to disk as a corrupt ".png".
 */
function sniffImageExt(buf, contentType) {
    const ct = String(contentType || '').toLowerCase();
    const CT_EXT = {
        'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/webp': 'webp', 'image/gif': 'gif', 'image/svg+xml': 'svg',
        'image/avif': 'avif', 'image/bmp': 'bmp',
    };
    for (const k of Object.keys(CT_EXT)) if (ct.includes(k)) return CT_EXT[k];
    if (!buf || buf.length < 12) return null;
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'png';
    if (buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF) return 'jpg';
    if (buf.slice(0, 4).toString('ascii') === 'GIF8') return 'gif';
    if (buf.slice(0, 4).toString('ascii') === 'RIFF'
        && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
    const head = buf.slice(0, 256).toString('utf8').trimStart().toLowerCase();
    if (head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'))) return 'svg';
    return null;
}

/**
 * v13: Fetch an image THROUGH the provider tab's session instead of a naked
 * https.get. Two tiers:
 *
 *   1. page.request.get() — Playwright's APIRequestContext runs Node-side
 *      (no CORS) but carries the browser context's cookie jar. Handles the
 *      common session-gated case (ChatGPT estuary, signed CDN URLs).
 *   2. in-page fetch(credentials:'include') via page.evaluate — same-origin
 *      requests that additionally validate fetch-metadata / anti-bot headers
 *      only a real page context sends. Payload returns as base64 (a few MB
 *      through CDP is fine).
 *
 * Both tiers sniff the payload — a 200 with an HTML error body is a FAILURE,
 * not an image. Throws when neither tier yields a real image.
 *
 * @returns {Promise<{buffer: Buffer, ext: string|null, via: string}>}
 */
async function fetchViaBrowser(page, url) {
    // Tier 1: context-cookie fetch, no CORS constraints
    try {
        const resp = await page.request.get(url, { timeout: 30_000 });
        if (resp.ok()) {
            const buffer = await resp.body();
            if (buffer.length > MAX_IMAGE_BYTES) throw new Error(`image exceeds ${MAX_IMAGE_BYTES} byte cap`);
            const ext = sniffImageExt(buffer, resp.headers()['content-type']);
            if (buffer.length && ext) return { buffer, ext, via: 'browser-session' };
        }
    } catch (_) { /* tier 2 */ }

    // Tier 2: in-page fetch.
    // v14: BOUNDED. The old fetch had no AbortSignal — a hanging endpoint kept
    // page.evaluate pending forever, the CDP socket kept the event loop alive,
    // and the whole invocation hung post-answer (no stdout flush, no receipt).
    // Two layers: AbortSignal.timeout in-page, plus a Promise.race around the
    // evaluate itself in case the CDP round-trip is what's wedged.
    const evalPromise = page.evaluate(async ({ u, fetchTimeout, maxBytes }) => {
        const opts = { credentials: 'include' };
        try { if (AbortSignal && AbortSignal.timeout) opts.signal = AbortSignal.timeout(fetchTimeout); } catch (_) {}
        const resp = await fetch(u, opts);
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (bytes.length > maxBytes) throw new Error('image exceeds byte cap');
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return { b64: btoa(s), type: resp.headers.get('content-type') || '' };
    }, { u: url, fetchTimeout: IN_PAGE_FETCH_TIMEOUT_MS, maxBytes: MAX_IMAGE_BYTES });
    evalPromise.catch(() => {}); // a late loser must not become an unhandledRejection
    const r = await Promise.race([
        evalPromise,
        new Promise((_, rej) => {
            const t = setTimeout(() => rej(new Error('in-page fetch evaluate timed out')),
                EVALUATE_RACE_TIMEOUT_MS);
            if (typeof t.unref === 'function') t.unref(); // never keep the process alive
        }),
    ]);
    const buffer = Buffer.from(r.b64, 'base64');
    const ext = sniffImageExt(buffer, r.type);
    if (!buffer.length || !ext) throw new Error('in-page fetch returned a non-image payload');
    return { buffer, ext, via: 'in-page fetch' };
}

/**
 * v17: Decode a data: URI (base64 only) into { buffer, ext }.
 * Used for generated images that collectResponseImages converted from blob:
 * URLs — they arrive as self-contained data URIs and need no network fetch.
 *
 * @param {string} uri — "data:image/png;base64,iVBORw0KGgo…"
 * @returns {{buffer: Buffer, ext: string}|null}
 */
function decodeDataUri(uri) {
    const m = /^data:(image\/\w+);base64,(.+)$/i.exec(uri);
    if (!m) return null;
    const mime = m[1].toLowerCase();
    const extMap = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/jpg': 'jpg',
        'image/gif': 'gif', 'image/webp': 'webp', 'image/svg+xml': 'svg' };
    const ext = extMap[mime] || 'png';
    try {
        return { buffer: Buffer.from(m[2], 'base64'), ext };
    } catch (_) {
        return null;
    }
}

async function downloadAllImages(response, destDir, opts) {
    opts = opts || {};
    let urls = extractImageUrls(response);
    if (!urls.length) {
        return { downloaded: [], failed: [], response, rawResponse: response, summary: '' };
    }

    // v14: hard limits — see the constants block. Everything past the cap or
    // the deadline is reported loudly as failed, never silently dropped.
    const results = [];
    if (urls.length > MAX_IMAGES_PER_RESPONSE) {
        log(`  ⚠ ${urls.length} image URLs in response — capping at ${MAX_IMAGES_PER_RESPONSE}`);
        for (const u of urls.slice(MAX_IMAGES_PER_RESPONSE)) {
            results.push({ url: u, file: null, status: 'failed', error: `skipped: over ${MAX_IMAGES_PER_RESPONSE}-image cap` });
        }
        urls = urls.slice(0, MAX_IMAGES_PER_RESPONSE);
    }
    const budgetMs = Number.isFinite(opts.budgetMs) ? opts.budgetMs : DOWNLOAD_PHASE_BUDGET_MS;
    const deadline = Date.now() + budgetMs;

    // v13: BROWSER-FIRST download when the provider tab is still available.
    // Generated-image endpoints are routinely session-gated (ChatGPT's
    // /backend-api/estuary/content?id=file_… returns 403 to a cookieless
    // https.get) — the plain Node download can only ever fetch public CDNs.
    const pg = opts.page;
    const pageUsable = !!(pg && typeof pg.isClosed === 'function' && !pg.isClosed());

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    // v14: pid in the filename — concurrent invocations (IndependentTasks runs
    // up to 8 workers sharing the orchestrator's cwd) landing in the same
    // second used to collide on ts+seq and silently overwrite each other.
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const tag = `${ts}-${process.pid}`;

    for (let i = 0; i < urls.length; i++) {
        const extMatch = urls[i].match(IMG_EXT_PATTERN);
        let ext = extMatch ? extMatch[1] : 'png';
        const nameFor = (e) => `ai-image-${tag}-${pad(i + 1)}.${e}`;
        let filename = nameFor(ext);

        if (Date.now() > deadline) {
            results.push({ url: urls[i], file: filename, status: 'failed', error: `skipped: ${budgetMs}ms download budget exhausted` });
            continue;
        }
        if (isBlockedImageHost(urls[i])) {
            results.push({ url: urls[i], file: filename, status: 'failed', error: 'blocked host (loopback/link-local/private range)' });
            log(`  ❌ Download refused: ${urls[i].slice(0, 80)} — blocked host`);
            continue;
        }

        try {
            let got = null;

            // v17: data: URI fast path — decode in-process, no network round-trip.
            // collectResponseImages converts blob: URLs to data URIs so generated
            // images survive serialization across the CDP boundary.
            if (/^data:/i.test(urls[i])) {
                const decoded = decodeDataUri(urls[i]);
                if (!decoded) {
                    throw new Error('failed to decode data URI');
                }
                ext = decoded.ext || ext;
                filename = nameFor(ext);
                got = { buffer: decoded.buffer, ext: decoded.ext, via: 'data-uri' };
            } else if (pageUsable) {
                got = await fetchViaBrowser(pg, urls[i]).catch((e) => {
                    log(`  browser fetch failed (${e.message}) — falling back to direct download`);
                    return null;
                });
            }
            if (!got) {
                // v14: the direct tier now returns a sniffed buffer too — both
                // tiers share one write path, so an HTML-as-200 error page can
                // no longer be written to disk as a corrupt ".png".
                const { buffer, contentType } = await fetchDirectBuffered(urls[i]);
                const sniffed = sniffImageExt(buffer, contentType);
                if (!buffer.length || !sniffed) {
                    throw new Error(`non-image payload (${(contentType || 'unknown type').slice(0, 40)})`);
                }
                got = { buffer, ext: sniffed, via: 'direct' };
            }
            // Extensionless URLs (estuary et al.) defaulted to .png — fix the
            // extension from the sniffed payload before writing (both tiers).
            if (got.ext && got.ext !== ext) {
                ext = got.ext;
                filename = nameFor(ext);
            }
            let destPath = path.join(destDir, filename);
            try {
                fs.writeFileSync(destPath, got.buffer, { flag: 'wx' }); // never clobber
            } catch (e) {
                if (e && e.code === 'EEXIST') {
                    filename = `ai-image-${tag}-${pad(i + 1)}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
                    destPath = path.join(destDir, filename);
                    fs.writeFileSync(destPath, got.buffer, { flag: 'wx' });
                } else { throw e; }
            }
            results.push({ url: urls[i], file: filename, status: 'ok', path: destPath, via: got.via });
            log(`  📥 Downloaded: ${filename} via ${got.via} (${destDir})`);
        } catch (err) {
            results.push({ url: urls[i], file: filename, status: 'failed', error: err.message });
            log(`  ❌ Download failed: ${filename} — ${err.message}`);
        }
    }

    const ok = results.filter(r => r.status === 'ok');
    const failed = results.filter(r => r.status === 'failed');
    let summary = '\n\n---\n## 📥 Downloaded Images\n';
    if (ok.length) summary += ok.map(r => `✅ \`${r.file}\` → ${destDir}`).join('\n') + '\n';
    if (failed.length) summary += failed.map(r => `❌ \`${r.file}\` — ${r.error}`).join('\n') + '\n';
    if (!ok.length && !failed.length) summary += '(no images found in response)\n';

    // v14: `response` keeps the historical augmented shape (human/TTY view and
    // existing tests); `rawResponse` is the untouched machine contract main()
    // now emits when stdout is a pipe. `summary` lets callers place it themselves.
    const augmentedResponse = response + summary;
    return { downloaded: ok, failed, response: augmentedResponse, rawResponse: response, summary };
}

// ══════════════════════════════════════════════════════════════════════════════
// FALLBACK ORCHESTRATOR
// ══════════════════════════════════════════════════════════════════════════════

/**
 * tryAllProviders — iterate through the provider chain, return first success.
 *
 * @param {Browser} browser - CDP browser connection
 * @param {string} prompt - The prompt to send
 * @param {InvocationContext} ctx - Per-invocation context (telemetry)
 * @param {object} options - { totalTimeout, providerTimeout, startFrom, singleAttempt }
 * @returns {{success: true, response: string, provider: string, page: Page}} | {{success: false, reasons: object}}
 */
async function tryAllProviders(browser, prompt, ctx, options = {}) {
    // POLICY: Never close the user's Chrome browser. We are a guest in their session.
    // Only manage our own tabs — page.close() for cleanup, but NEVER browser.close().
    const { keepTabs = true } = options;
    const totalTimeout = options.totalTimeout || DEFAULT_TOTAL_TIMEOUT;
    const providerTimeout = options.providerTimeout
        || (options.singleAttempt
            ? Math.min(DEFAULT_PROVIDER_TIMEOUT, totalTimeout)
            : Math.min(DEFAULT_PROVIDER_TIMEOUT, Math.floor(totalTimeout / 2)));
    const overallStart = Date.now();

    // Determine starting index
    let startIdx = 0;
    // v14: trim + emptiness guard. `''.includes('')` is true for EVERY string,
    // so a blank --only=/--from= (shell interpolation of an unset variable is
    // the typical source) previously resolved to chain index 0 via the
    // substring fallback — silently running GEMINI under --single while the
    // caller's lock is held on whatever provider it THOUGHT it named.
    const startFromRaw = String(options.startFrom || '').trim();
    if (startFromRaw) {
        const searchName = startFromRaw.toLowerCase();
        // MATCHING FIX: exact key/name match first. Pure substring matching
        // resolved --only=mini to GEMINI ("gemini".includes("mini") wins by
        // chain order before MiniMax is ever considered) — under --single that
        // silently runs a different provider than the one the caller named
        // (and locked). Substring stays as a convenience fallback for humans
        // typing --from=gpt etc. — but ONLY on the cascading path: under
        // --single/--only (v14) a non-exact name fails loudly below, because
        // an ambiguous substring resolving to the wrong provider breaks the
        // caller's mutual exclusion exactly like an unknown name does.
        startIdx = PROVIDER_CHAIN.findIndex(p =>
            p.key === searchName || p.name.toLowerCase() === searchName
        );
        if (startIdx === -1 && !options.singleAttempt) startIdx = PROVIDER_CHAIN.findIndex(p =>
            p.key.includes(searchName) || p.name.toLowerCase().includes(searchName)
        );
        if (startIdx === -1) {
            // ROBUSTNESS: under singleAttempt (--only / --single), silently
            // resetting to index 0 runs GEMINI while the CALLER believes it ran
            // the provider it named — and the caller's file lock is held on that
            // named provider, not Gemini. Two workers then race Gemini with
            // mismatched locks (exactly the mutual-exclusion break --single was
            // added to prevent). A misspelled provider must fail loudly, not
            // impersonate a different one. Only the cascading path (no
            // singleAttempt) may fall back to starting from the top.
            if (options.singleAttempt) {
                const valid = PROVIDER_CHAIN.map(p => p.key).join(', ');
                log(`ERROR: --only/--single named unknown or ambiguous provider "${startFromRaw}". Valid (exact): ${valid}`);
                return {
                    success: false,
                    reasons: { [startFromRaw]: { reason: 'error',
                        error_details: { message: `unknown provider: ${startFromRaw}` } } },
                };
            }
            log(`WARN: Provider "${startFromRaw}" not found in chain. Starting from beginning.`);
            startIdx = 0;
        } else {
            log(`Starting from provider index ${startIdx} ("${PROVIDER_CHAIN[startIdx].name}")`);
        }
    }

    // v12: `let` — both may be swapped by the mid-chain CDP reconnect below.
    let context = browser.contexts()[0];
    if (!context) throw new Error('No active browser context.');

    const fallbackReasons = {};
    const triedProviders = [];

    // singleAttempt: bound the loop to exactly one provider (startIdx) instead of
    // cascading through the rest of PROVIDER_CHAIN on failure. Used by callers
    // (e.g. AgentChat-IndependentTasks) that implement their own cross-provider
    // fallback with external locking — without this, a single spawned attempt at
    // provider X could silently succeed via provider Y further down the chain,
    // while the caller's lock is only held on X, breaking mutual exclusion between
    // concurrent orchestrator workers that expect exclusive use of Y.
    const endIdx = options.singleAttempt ? Math.min(startIdx + 1, PROVIDER_CHAIN.length) : PROVIDER_CHAIN.length;

    for (let i = startIdx; i < endIdx; i++) {
        const provider = PROVIDER_CHAIN[i];
        const elapsed = Date.now() - overallStart;
        const remainingTotal = totalTimeout - elapsed;

        // ── v12: browser-loss fail-fast ──
        // A tab-level Context closed sometimes means the whole Chrome/CDP link
        // died with it. The old behavior marched every remaining provider
        // through newPage()/goto() against a dead connection — 7 more
        // identical "Context closed" failures, each burning budget, ending in
        // exit 9 with the real cause (CDP down) buried. Detect once at the
        // top of each iteration; try ONE reconnect (Chrome may still be up
        // with only the websocket dropped); otherwise abort the chain with a
        // dedicated 'browser_lost' reason that main() maps to exit 1
        // (ERR_NO_CDP) so the operator sees the actual fix.
        if (!browser.isConnected()) {
            log('⚠ CDP connection lost mid-chain — attempting one reconnect...');
            let recovered = false;
            if (typeof options.reconnect === 'function') {
                try {
                    const fresh = await options.reconnect();
                    const freshCtx = fresh && fresh.contexts && fresh.contexts()[0];
                    if (freshCtx) {
                        browser = fresh;
                        context = freshCtx;
                        recovered = true;
                        log('✓ CDP reconnected — resuming chain');
                    }
                } catch (e) {
                    log(`  reconnect failed: ${e.message}`);
                }
            }
            if (!recovered) {
                fallbackReasons[provider.key] = {
                    reason: 'browser_lost',
                    error_details: {
                        message: 'CDP connection lost mid-chain and reconnect failed — remaining providers skipped',
                        stage: 'browser',
                        provider: provider.key,
                    },
                };
                triedProviders.push(provider.key);
                log('✗ CDP unrecoverable — aborting chain (remaining providers would all fail identically)');
                break;
            }
        }

        if (remainingTotal < 15000) {
            log(`Total timeout approaching — ${remainingTotal}ms left. Stopping chain.`);
            fallbackReasons[provider.key] = { reason: 'total_timeout' };
            triedProviders.push(provider.key);
            break;
        }

        const perProvTimeout = Math.min(providerTimeout, remainingTotal);

        log(`\n▶ Provider ${i + 1}/${PROVIDER_CHAIN.length}: ${provider.name} (${Math.round(perProvTimeout / 1000)}s budget)`);
        const timer = startTimer(`${provider.name}`);

        let page;
        let result;
        let createdPage = false;
        try {
            // ── Reuse an existing tab for this provider, or create a new one ──
            // (see findProviderPage() for why reuse replaced the old skip logic)
            page = findProviderPage(context, provider);
            if (page) {
                log(`  ${provider.name}: reusing existing tab`);
            } else {
                page = await context.newPage();
                createdPage = true;
            }

            // Grant clipboard permissions
            try { await context.grantPermissions(['clipboard-read', 'clipboard-write']); } catch (_) { }

            // Dispatch to provider runner (each receives ctx for telemetry tracking)
            const runner = RUNNERS[provider.key];
            result = runner
                ? await runner(page, prompt, perProvTimeout, ctx)
                : classifyError(new Error(`Unknown provider: ${provider.key}`), 'navigate', provider.key);
        } catch (err) {
            const pe = new ProviderError(err, { stage: 'unknown', provider: provider.key });
            log(`${provider.name}: ${pe.originalName} — ${pe.message}`);
            result = pe.toResult();
        } finally {
            timer.stop();
        }

        triedProviders.push(provider.key);
        if (!result.success) {
            // Close failed provider's tab ONLY if we created it — a reused tab
            // belongs to the user / a previous session and must be left alone.
            if (createdPage && page && !page.isClosed()) {
                try { await page.close(); } catch (_) { }
            }
            fallbackReasons[provider.key] = {
                reason: result.reason || 'error',
                error_details: result.error_details || null,
            };
            log(`✗ ${provider.name}: FAILED — ${result.reason} → falling to next provider`);
            // Auth-class failures are operator-fixable — print the fix instead
            // of leaving only an opaque reason string in the logs.
            if (result.reason === 'auth' && provider.recoveryHint) {
                log(`  ↳ fix: ${provider.recoveryHint}`);
            }
            continue;
        }

        // SUCCESS: keep or close tab based on --keep-tabs flag (self-created only)
        // P0-4: use the destructured `keepTabs` (defaults to true) instead of
        // `!options.keepTabs` — options.keepTabs is undefined when the caller
        // doesn't pass it explicitly, and !undefined === true, which CLOSES the
        // tab despite the documented default being "keep."
        if (createdPage && page && !page.isClosed() && !keepTabs) {
            try { await page.close(); } catch (_) { }
        }

        // SUCCESS!
        ctx.telemetry.provider_used = provider.name;
        ctx.telemetry.providers_tried = triedProviders;
        ctx.telemetry.fallback_reasons = fallbackReasons;
        ctx.telemetry.total_ms = Date.now() - overallStart;

        log(`\n✓ ${provider.name}: USED (${result.response.length} chars, ${ctx.telemetry.total_ms}ms total)`);
        if (triedProviders.length > 1) {
            log(`  Fallback chain: ${triedProviders.join(' → ')} (${triedProviders.length - 1} provider(s) skipped)`);
        }
        // v13: hand the successful provider's page to the caller — image
        // download must reuse this tab's session cookies (session-gated image
        // endpoints 403 a cookieless download). May already be closed when
        // --close was used; consumers must guard with page.isClosed().
        return { success: true, response: result.response, provider: provider.name, page };
    }

    // All providers exhausted
    ctx.telemetry.providers_tried = triedProviders;
    ctx.telemetry.fallback_reasons = fallbackReasons;
    ctx.telemetry.total_ms = Date.now() - overallStart;

    log(`\n✗ All ${triedProviders.length} provider(s) exhausted.`);
    log(`  Reasons: ${JSON.stringify(fallbackReasons)}`);

    // If the first 2+ providers failed with page-load/auth errors,
    // the proxy or network is likely the root cause, not the providers.
    const pageFailCount = Object.values(fallbackReasons).filter(r =>
        String(r.reason).includes('error') || String(r.reason).includes('auth')
    ).length;
    if (pageFailCount >= 2) {
        log('  ⚠  Multiple providers failed with page/auth errors.');
        log('  ⚠  This may indicate a proxy/network issue — check PROXY_SERVER in .env');
    }

    return { success: false, reasons: fallbackReasons };
}

// ══════════════════════════════════════════════════════════════════════════════
// SMOKE TEST — verify at least one provider is reachable
// ══════════════════════════════════════════════════════════════════════════════

async function smokeTest(browser) {
    log('Running smoke test — checking provider reachability...');
    const context = browser.contexts()[0];
    // v14: CDP can be reachable with ZERO contexts (headless shell, freshly
    // crashed profile). The old code TypeError'd into exit 4 (ERR_INTERNAL);
    // the actual fix is the same as no-CDP: restart the debug browser.
    if (!context) {
        log('❌ CDP reachable but no browser context exists.');
        log('   fix: ' + startHint());
        return;
    }

    for (const provider of PROVIDER_CHAIN) {
        let page;
        try {
            // An already-open tab is itself proof of reachability
            if (findProviderPage(context, provider)) {
                log(`  ${provider.name}: ✅ REACHABLE (existing tab)`);
                continue;
            }

            page = await context.newPage();
            await page.goto(provider.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
            const url = page.url();

            const isAuth = provider.authDomains.some(d => url.includes(d));
            if (isAuth) {
                log(`  ${provider.name}: REACHABLE but needs login (${url.substring(0, 60)})`);
            } else {
                log(`  ${provider.name}: ✅ REACHABLE (${url.substring(0, 60)})`);
            }
        } catch (err) {
            log(`  ${provider.name}: ❌ UNREACHABLE — ${err.message}`);
        } finally {
            if (page && !page.isClosed()) {
                try { await page.close(); } catch (_) { }
            }
        }
    }

    log('Smoke test complete. Check output above for provider status.');
}

// ══════════════════════════════════════════════════════════════════════════════
// MAIN
// ══════════════════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    const ctx = new InvocationContext(); // P0-2: per-invocation state isolation

    // --doctor
    if (args.includes('--doctor')) {
        return doctorCheck();
    }

    // Parse flags
    let customTimeout = DEFAULT_TOTAL_TIMEOUT;
    let customProvTimeout = null;
    let startFrom = null;
    let keepTabs = true; // Always keep tabs — never close user's browser
    let singleAttempt = false; // --single: try exactly one provider, no cascade
    let downloadImages = true; // download images from response to cwd (--no-download-images to disable)
    let imageIntent = false;   // v14 --image: append IMAGE_ENHANCE_INSTRUCTION in-process

    const USAGE =
        'Usage: node index.js [--timeout=MS] [--from=NAME] [--only=NAME] [--single] [--image] [--locale=xx_XX] [--keep-tabs] [--close] [--no-download-images] [--smoke] [--doctor] "Your prompt"\n' +
        '       echo "prompt" | node index.js [flags]';
    // v14: usage errors exit 64 (BSD EX_USAGE), WITH a receipt. They used to
    // exit 1 — colliding with ERR_NO_CDP, so a caller-side bug (empty prompt)
    // read as "browser down" and could terminally abort an orchestrator's
    // whole chain (see the conflation guard in lib/execute.js).
    const usageExit = (msg) => {
        if (msg) log(`ERROR: ${msg}`);
        console.error(USAGE);
        ctx.recordTelemetry(64);
        process.exit(64);
    };

    // Timeouts are milliseconds. Values < 10000 are almost certainly seconds
    // typed by a human (--timeout=900) — normalize instead of silently giving
    // the whole chain a sub-second budget.
    const normalizeTimeout = (v) => {
        if (v < 10_000) {
            log(`WARN: --timeout=${v} interpreted as ${v}s (${v * 1000}ms). Timeouts are in milliseconds.`);
            return v * 1000;
        }
        return v;
    };

    // NOTE: --doctor is already handled above with an early return, so it never
    // reaches this loop. --smoke is detected separately via args.includes('--smoke')
    // further below. Neither should be pushed into `remaining` — previously both
    // were, which meant they'd get joined into the `prompt` string (harmless today
    // only because the smoke/doctor branches short-circuit before `prompt` is used).
    const remaining = [];
    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === '--smoke') {
            // handled via args.includes('--smoke') below — swallow, don't push
        } else if (a.startsWith('--timeout=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) customTimeout = normalizeTimeout(v);
            else log(`WARN: ignoring invalid ${a} (expected a positive integer in ms)`);
        } else if (a.startsWith('--timeout-per-provider=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) customProvTimeout = normalizeTimeout(v);
            else log(`WARN: ignoring invalid ${a} (expected a positive integer in ms)`);
        } else if (a === '--keep-tabs') {
            keepTabs = true;
        } else if (a === '--close' || a === '--close-browser') {
            // Only closes our own tab on success (page.close()) — never browser.close().
            keepTabs = false;
        } else if (a === '--single') {
            singleAttempt = true;
        } else if (a === '--image') {
            // v14: image-generation intent — index.js appends the canonical
            // enhancement instruction itself (see IMAGE_ENHANCE_INSTRUCTION).
            imageIntent = true;
        } else if (a.startsWith('--only=')) {
            // Try exactly ONE provider — no internal fallback. Used by IndependentTasks
            // so that fallback control lives solely in the orchestrator layer.
            // v14: an EMPTY value must fail loudly here — `''` used to slip
            // through to the substring matcher and silently run Gemini.
            startFrom = (a.split('=')[1] || '').trim();
            if (!startFrom) usageExit('--only= requires a provider name (e.g. --only=chatgpt)');
            singleAttempt = true;
        } else if (a.startsWith('--from=')) {
            startFrom = (a.split('=')[1] || '').trim();
            if (!startFrom) usageExit('--from= requires a provider name (e.g. --from=ChatGPT)');
        } else if (a.startsWith('--locale=')) {
            // FEATURE GAP FIX: --locale was documented (lib/locales/gemini.js
            // header: "CLI 传 --locale=xx_XX") and passed by the Python SDK
            // (session.py appends --locale=<key> whenever locale= is given),
            // but this parser had no branch for it — unknown --flags are
            // silently dropped, so the Python `locale` parameter has been a
            // no-op since it shipped. Wire it to the Gemini locale profiles.
            const locKey = a.split('=')[1];
            const applied = require('../lib/locales/gemini').setLocale(locKey);
            if (applied === 'fuzzy' && locKey) {
                log(`WARN: unknown --locale "${locKey}" — falling back to auto-detect/fuzzy matching`);
            } else {
                log(`Gemini UI locale forced to ${applied}`);
            }
        } else if (a === '--no-download-images') {
            // Image download opt-out — skip the automatic image download post-processing.
            // Images in the web AI response will be preserved as remote URLs only.
            downloadImages = false;
        } else if (a.startsWith('--')) {
            // v14: unknown flags WARN instead of vanishing. Silent drops are the
            // root of a recurring bug class here: --keep-tabs was once silently
            // concatenated into the prompt, and --locale shipped as a months-long
            // no-op because this parser had no branch for it and said nothing.
            log(`WARN: unknown flag ${a.split('=')[0]} ignored (a prompt must not start with --; see --help/usage)`);
        } else {
            remaining.push(a);
        }
    }

    // Read prompt
    let prompt = remaining.join(' ').trim();
    if (!prompt && !args.includes('--smoke') && !process.stdin.isTTY) {
        // Try stdin — but only when something is actually piped in.
        // On an interactive TTY this used to hang forever instead of printing usage.
        const chunks = [];
        process.stdin.setEncoding('utf-8');
        for await (const chunk of process.stdin) chunks.push(chunk);
        prompt = chunks.join('').trim();
    }
    if (!prompt && !args.includes('--smoke')) {
        usageExit('no prompt given');
    }

    // v14: --image — append the canonical enhancement HERE, not in the calling
    // agent's head. Applies to argv and stdin prompts alike; recorded in
    // telemetry so the receipt trail shows whether enhancement really happened.
    if (imageIntent && prompt) {
        prompt += IMAGE_ENHANCE_INSTRUCTION;
        ctx.telemetry.image_prompt_enhanced = true;
    }

    ctx.telemetry.prompt_length_chars = prompt.length;

    // Connect to Chrome.
    // v15: ensureChromeCdp() first — on Windows agent hosts (workbuddy etc.)
    // nothing ever ran the SKILL.md bash preflight, so every cold run died
    // ECONNREFUSED before this point. Now the skill starts its own debug
    // Chrome (platform-aware, once, AGENTCHAT_NO_AUTOSTART=1 to opt out).
    let browser;
    try {
        const ensured = await ensureChromeCdp(CDP_URL, log);
        if (!ensured.up) {
            log(`FATAL: Chrome CDP not reachable on ${CDP_URL}` +
                (ensured.reason ? ` (${ensured.reason})` : ''));
            log('Fix: ' + startHint());
            if (isWSL()) log('WSL detected — if Chrome runs on the Windows host, 127.0.0.1 here is the WSL VM. See CDP_HOST in .env.example.');
            ctx.recordTelemetry(1);
            process.exit(1);
        }
        if (ensured.autostarted) {
            ctx.telemetry.cdp_autostarted = true;
            // v16: 'script' = deployed start script; 'direct' = embedded
            // launcher (workbuddy-style installs without scripts/)
            ctx.telemetry.cdp_autostart_method = ensured.method || 'script';
        }
        browser = await connectWithRetry(CDP_URL);
    } catch (err) {
        log(`FATAL: Cannot connect to Chrome CDP — ${err.message}`);
        log('Fix: ' + startHint());
        ctx.recordTelemetry(1);
        process.exit(1);
    }

    try {
        // --smoke
        if (args.includes('--smoke')) {
            await smokeTest(browser);
            process.exit(0);
        }

        // Run fallback chain (ctx carries isolated state through the chain)
        const result = await tryAllProviders(browser, prompt, ctx, {
            totalTimeout: customTimeout,
            providerTimeout: customProvTimeout,
            startFrom,
            keepTabs,
            singleAttempt,
            // v12: one-shot mid-chain CDP recovery (see browser-loss fail-fast)
            reconnect: () => connectWithRetry(CDP_URL, 2),
        });

        if (result.success) {
            // ── Post-process: download images from response (if enabled) ──
            let finalResponse = result.response;
            if (downloadImages) {
                try {
                    const dlResult = await downloadAllImages(result.response, process.cwd(), { page: result.page }); // v13: session-aware download
                    ctx.telemetry.images_ok = (dlResult.downloaded || []).length;
                    ctx.telemetry.images_failed = (dlResult.failed || []).length;
                    // v14: stdout is a MACHINE CONTRACT when piped (lib/execute.js,
                    // the Python SDK, and the MCP server consume it verbatim as
                    // the AI response) — the appended "📥 Downloaded Images"
                    // markdown was polluting subagent answers fed to adjudication.
                    // TTY (a human watching): keep the inline summary. Piped:
                    // raw response on stdout, summary on stderr, counts in the
                    // receipt (see recordTelemetry).
                    if (process.stdout.isTTY) {
                        finalResponse = dlResult.response;
                    } else {
                        finalResponse = dlResult.rawResponse != null ? dlResult.rawResponse : dlResult.response;
                        if ((ctx.telemetry.images_ok + ctx.telemetry.images_failed) > 0 && dlResult.summary) {
                            for (const line of dlResult.summary.split('\n')) {
                                if (line.trim()) log(line);
                            }
                        }
                    }
                } catch (err) {
                    log(`Image download phase failed: ${err.message}`);
                }
            }

            // P0 FLUSH FIX: console.log + immediate process.exit truncates piped
            // stdout at the pipe-buffer boundary (~128KB on Linux, less on
            // Windows/macOS). A PARTIAL flush still passes the parent executor's
            // `text.length >= 5` success check, returning corrupted text as
            // ok:true — the silent-wrong-answer class. This is the "#2 flush
            // fix" that lib/execute.js's acceptUsedMarker comment references:
            // exit only from the write callback, after the kernel accepted the
            // full payload. (process.exit is still required here — the CDP
            // websocket keeps the event loop alive, so a natural exit never
            // happens; exitCode-and-return is NOT an option in this file.)
            ctx.recordTelemetry(0);
            // v14 EPIPE guard: if the parent died (head/timeout-kill), the write
            // callback never fires and the async 'error' event would crash us
            // with a spurious exit 4 AFTER an exit-0 receipt was persisted.
            process.stdout.once('error', () => process.exit(0));
            process.stdout.write(finalResponse + '\n', () => process.exit(0));
            return;
        }

        // Classify failure — reasons are now objects {reason, error_details}
        const reasonValues = Object.values(result.reasons).map(r =>
            typeof r === 'string' ? r : (r.reason || '')
        );
        const allAuth = reasonValues.every(r => r.includes('auth') || r.includes('AUTH'));
        const allQuota = reasonValues.every(r => r.includes('quota') || r.includes('QUOTA') || r.includes('rate') || r.includes('RATE'));
        // P0-6: was .some() — "1 safety + 7 other failures" would exit 3, contradicting
        // the documented "Safety rejected by ALL providers" semantics. Now .every().
        const allSafety = reasonValues.every(r => r.includes('safety') || r.includes('SAFETY'));

        if (allAuth) {
            log('All providers require authentication. Log into at least one service in Chrome.');
            ctx.recordTelemetry(2);
            process.exit(2);
        }
        if (allQuota) {
            log('All providers are rate-limited. Wait and retry later.');
            ctx.recordTelemetry(5);
            process.exit(5);
        }
        if (allSafety) {
            ctx.recordTelemetry(3);
            process.exit(3);
        }
        // Exit 10 (ERR_TIMEOUT) was documented but never emitted — the chain
        // stopping on total_timeout previously collapsed into exit 9.
        const hasTotalTimeout = reasonValues.some(r => r.includes('total_timeout'));
        if (hasTotalTimeout) {
            log('Total timeout reached before the chain could complete.');
            ctx.recordTelemetry(10);
            process.exit(10);
        }
        // v12: CDP died mid-run and the one-shot reconnect failed. Exit 1
        // (ERR_NO_CDP) — same operator action as failing to connect at start.
        // Previously this collapsed into exit 9 with 8 identical Context-closed
        // reasons, hiding the one command that actually fixes it.
        const hasBrowserLost = reasonValues.some(r => r.includes('browser_lost'));
        if (hasBrowserLost) {
            log('CDP connection was lost mid-run. Restart Chrome debug: ' + startHint());
            ctx.recordTelemetry(1);
            process.exit(1);
        }
        ctx.recordTelemetry(9);
        process.exit(9);

    } catch (err) {
        log(`FATAL: ${err.message}`);
        ctx.recordTelemetry(4);
        process.exit(4);
    } finally {
        // POLICY: NEVER call browser.close() — this is a CDP guest session.
        // Closing the browser destroys ALL the user's tabs, not just ours.
    }
}

if (require.main === module) {
    main().catch(e => {
        process.stderr.write(`[fallback] unhandled: ${e.message}\n`);
        process.exit(4);
    });
}

module.exports = {
    PROVIDER_CHAIN,
    // v13: exported for tests and for IndependentTasks' own post-processing
    extractImageUrls,
    downloadAllImages,
    downloadFile,
    fetchViaBrowser,
    sniffImageExt,
};
