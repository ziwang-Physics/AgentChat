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
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');

const { ProviderError, classifyError } = require('../lib/errors');
const { createProviderRunner, appendWithRotation } = require('../lib/providerFactory');
const { makeRunId, emitReceipt } = require('../lib/receipt');
const { log: _log, startTimer: _startTimer, spinner } = require('../lib/terminal');
const { connectWithRetry: _connectWithRetry, doctorCheck: _doctorCheck } = require('../lib/cdp');

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
const MARKDOWN_IMG_RE = /!\[.*?\]\((https?:\/\/[^\s)]+)\)/g;
const HTML_IMG_RE = /<img[^>]+src=["'](https?:\/\/[^\s"']+)["'][^>]*>/gi;
const DIRECT_URL_RE = /https?:\/\/[^\s"'`<>]+\.(?:png|jpg|jpeg|gif|webp|svg)(?:\?[^\s"'`<>]*)?/gi;

function extractImageUrls(text) {
    const urls = new Set();
    for (const m of text.matchAll(MARKDOWN_IMG_RE)) urls.add(m[1]);
    for (const m of text.matchAll(HTML_IMG_RE)) urls.add(m[1]);
    for (const m of text.matchAll(DIRECT_URL_RE)) urls.add(m[0]);
    return [...urls];
}

function downloadFile(url, destPath, redirects) {
    redirects = redirects || 0;
    if (redirects > 3) return Promise.reject(new Error('Too many redirects'));
    return new Promise((resolve, reject) => {
        const proto = url.startsWith('https') ? https : http;
        const req = proto.get(url, { timeout: 30000 }, (res) => {
            if ([301, 302, 307, 308].includes(res.statusCode)) {
                const loc = res.headers.location;
                if (loc) return downloadFile(loc, destPath, redirects + 1).then(resolve, reject);
            }
            if (res.statusCode !== 200) {
                return reject(new Error(`HTTP ${res.statusCode}`));
            }
            const file = fs.createWriteStream(destPath);
            res.pipe(file);
            file.on('finish', () => { file.close(); resolve(destPath); });
            file.on('error', reject);
        });
        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    });
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
            const ext = sniffImageExt(buffer, resp.headers()['content-type']);
            if (buffer.length && ext) return { buffer, ext, via: 'browser-session' };
        }
    } catch (_) { /* tier 2 */ }

    // Tier 2: in-page fetch
    const r = await page.evaluate(async (u) => {
        const resp = await fetch(u, { credentials: 'include' });
        if (!resp.ok) throw new Error('HTTP ' + resp.status);
        const bytes = new Uint8Array(await resp.arrayBuffer());
        let s = '';
        const CH = 0x8000;
        for (let i = 0; i < bytes.length; i += CH) {
            s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
        }
        return { b64: btoa(s), type: resp.headers.get('content-type') || '' };
    }, url);
    const buffer = Buffer.from(r.b64, 'base64');
    const ext = sniffImageExt(buffer, r.type);
    if (!buffer.length || !ext) throw new Error('in-page fetch returned a non-image payload');
    return { buffer, ext, via: 'in-page fetch' };
}

async function downloadAllImages(response, destDir, opts) {
    opts = opts || {};
    const urls = extractImageUrls(response);
    if (!urls.length) return { downloaded: [], response };

    // v13: BROWSER-FIRST download when the provider tab is still available.
    // Generated-image endpoints are routinely session-gated (ChatGPT's
    // /backend-api/estuary/content?id=file_… returns 403 to a cookieless
    // https.get) — the plain Node download can only ever fetch public CDNs.
    const pg = opts.page;
    const pageUsable = !!(pg && typeof pg.isClosed === 'function' && !pg.isClosed());

    const now = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const ts = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    const results = [];

    for (let i = 0; i < urls.length; i++) {
        const extMatch = urls[i].match(IMG_EXT_PATTERN);
        let ext = extMatch ? extMatch[1] : 'png';
        let filename = `ai-image-${ts}-${pad(i + 1)}.${ext}`;
        let destPath = path.join(destDir, filename);
        try {
            let via = 'direct';
            let got = null;
            if (pageUsable) {
                got = await fetchViaBrowser(pg, urls[i]).catch((e) => {
                    log(`  browser fetch failed (${e.message}) — falling back to direct download`);
                    return null;
                });
            }
            if (got) {
                // Extensionless URLs (estuary et al.) defaulted to .png — fix
                // the extension from the sniffed payload before writing.
                if (!extMatch && got.ext && got.ext !== ext) {
                    ext = got.ext;
                    filename = `ai-image-${ts}-${pad(i + 1)}.${ext}`;
                    destPath = path.join(destDir, filename);
                }
                fs.writeFileSync(destPath, got.buffer);
                via = got.via;
            } else {
                await downloadFile(urls[i], destPath);
            }
            results.push({ url: urls[i], file: filename, status: 'ok', path: destPath, via });
            log(`  📥 Downloaded: ${filename} via ${via} (${destDir})`);
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

    const augmentedResponse = response + summary;
    return { downloaded: ok, failed, response: augmentedResponse };
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
    if (options.startFrom) {
        const searchName = options.startFrom.toLowerCase();
        // MATCHING FIX: exact key/name match first. Pure substring matching
        // resolved --only=mini to GEMINI ("gemini".includes("mini") wins by
        // chain order before MiniMax is ever considered) — under --single that
        // silently runs a different provider than the one the caller named
        // (and locked). Substring stays as a convenience fallback for humans
        // typing --from=gpt etc.
        startIdx = PROVIDER_CHAIN.findIndex(p =>
            p.key === searchName || p.name.toLowerCase() === searchName
        );
        if (startIdx === -1) startIdx = PROVIDER_CHAIN.findIndex(p =>
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
                log(`ERROR: --only/--single named unknown provider "${options.startFrom}". Valid: ${valid}`);
                return {
                    success: false,
                    reasons: { [options.startFrom]: { reason: 'error',
                        error_details: { message: `unknown provider: ${options.startFrom}` } } },
                };
            }
            log(`WARN: Provider "${options.startFrom}" not found in chain. Starting from beginning.`);
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
        } else if (a.startsWith('--timeout-per-provider=')) {
            const v = parseInt(a.split('=')[1], 10);
            if (!isNaN(v) && v > 0) customProvTimeout = normalizeTimeout(v);
        } else if (a === '--keep-tabs') {
            keepTabs = true;
        } else if (a === '--close' || a === '--close-browser') {
            // Only closes our own tab on success (page.close()) — never browser.close().
            keepTabs = false;
        } else if (a === '--single') {
            singleAttempt = true;
        } else if (a.startsWith('--only=')) {
            // Try exactly ONE provider — no internal fallback. Used by IndependentTasks
            // so that fallback control lives solely in the orchestrator layer.
            startFrom = a.split('=')[1];
            singleAttempt = true;
        } else if (a.startsWith('--from=')) {
            startFrom = a.split('=')[1];
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
        } else if (!a.startsWith('--')) {
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
        console.error('Usage: node index.js [--timeout=MS] [--from=NAME] [--only=NAME] [--single] [--locale=xx_XX] [--keep-tabs] [--close] [--smoke] [--doctor] "Your prompt"');
        console.error('       echo "prompt" | node index.js [flags]');
        process.exit(1);
    }

    ctx.telemetry.prompt_length_chars = prompt.length;

    // Connect to Chrome
    let browser;
    try {
        browser = await connectWithRetry(CDP_URL);
    } catch (err) {
        log(`FATAL: Cannot connect to Chrome CDP — ${err.message}`);
        log('Ensure Chrome debug is running: bash ~/start-chrome-debug.sh');
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
                    finalResponse = dlResult.response;
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
            log('CDP connection was lost mid-run. Restart Chrome debug: bash scripts/start-chrome-debug.sh');
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
