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
 *                                   # (used by AgentChat-FreeSubAgent, which owns
 *                                   # its own cross-provider fallback + locking)
 *
 * Exit codes:
 *   0 - Success (response on stdout)
 *   1 - Chrome CDP not reachable (ERR_NO_CDP)
 *   2 - No provider reachable — all auth-gated or page load failed (ERR_NO_PROVIDER)
 *   3 - Safety rejected by all providers (ERR_SAFETY_REJECTED)
 *   4 - Internal error (ERR_INTERNAL)
 *   5 - All providers rate-limited (ERR_RATE_LIMITED)
 *   9 - All providers exhausted, mixed reasons (ERR_ALL_EXHAUSTED)
 *  10 - Total timeout reached (ERR_TIMEOUT)
 */

const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

const { ProviderError, classifyError } = require('../lib/errors');
const { createProviderRunner, appendWithRotation } = require('../lib/providerFactory');
const { log: _log, startTimer: _startTimer, spinner } = require('../lib/terminal');
const { connectWithRetry: _connectWithRetry, doctorCheck: _doctorCheck } = require('../lib/cdp');

// ── Adapt shared modules to WebExtended naming conventions ──
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
        this.telemetry = {
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
        const f = path.join(SKILL_DIR, 'fallback-telemetry.jsonl');
        appendWithRotation(f, JSON.stringify(this.telemetry) + '\n');
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// PROVIDER CHAIN (priority order — first available wins)
// ══════════════════════════════════════════════════════════════════════════════

// Single source of truth: lib/providers/chain.js (also consumed by FreeSubAgent,
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
 * the job of FreeSubAgent's file locks (and --single), not tab heuristics.
 */
function findProviderPage(context, provider) {
    const hosts = getProviderHosts(provider);
    return context.pages().find(p => {
        try {
            const pu = p.url();
            if (pu.includes('about:blank')) return false;
            return hosts.some(h => pu.includes(h));
        } catch { return false; }
    }) || null;
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
 * @returns {{success: true, response: string, provider: string}} | {{success: false, reasons: object}}
 */
async function tryAllProviders(browser, prompt, ctx, options = {}) {
    // POLICY: Never close the user's Chrome browser. We are a guest in their session.
    // Only manage our own tabs — page.close() for cleanup, but NEVER browser.close().
    const { keepTabs = true } = options;
    const totalTimeout = options.totalTimeout || DEFAULT_TOTAL_TIMEOUT;
    const providerTimeout = options.providerTimeout || Math.min(DEFAULT_PROVIDER_TIMEOUT, Math.floor(totalTimeout / 2));
    const overallStart = Date.now();

    // Determine starting index
    let startIdx = 0;
    if (options.startFrom) {
        const searchName = options.startFrom.toLowerCase();
        startIdx = PROVIDER_CHAIN.findIndex(p =>
            p.key.includes(searchName) || p.name.toLowerCase().includes(searchName)
        );
        if (startIdx === -1) {
            log(`WARN: Provider "${options.startFrom}" not found in chain. Starting from beginning.`);
            startIdx = 0;
        } else {
            log(`Starting from provider index ${startIdx} ("${PROVIDER_CHAIN[startIdx].name}")`);
        }
    }

    const context = browser.contexts()[0];
    if (!context) throw new Error('No active browser context.');

    const fallbackReasons = {};
    const triedProviders = [];

    // singleAttempt: bound the loop to exactly one provider (startIdx) instead of
    // cascading through the rest of PROVIDER_CHAIN on failure. Used by callers
    // (e.g. AgentChat-FreeSubAgent) that implement their own cross-provider
    // fallback with external locking — without this, a single spawned attempt at
    // provider X could silently succeed via provider Y further down the chain,
    // while the caller's lock is only held on X, breaking mutual exclusion between
    // concurrent orchestrator workers that expect exclusive use of Y.
    const endIdx = options.singleAttempt ? Math.min(startIdx + 1, PROVIDER_CHAIN.length) : PROVIDER_CHAIN.length;

    for (let i = startIdx; i < endIdx; i++) {
        const provider = PROVIDER_CHAIN[i];
        const elapsed = Date.now() - overallStart;
        const remainingTotal = totalTimeout - elapsed;

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
            continue;
        }

        // SUCCESS: keep or close tab based on --keep-tabs flag (self-created only)
        if (createdPage && page && !page.isClosed() && !options.keepTabs) {
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
        return { success: true, response: result.response, provider: provider.name };
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
            // Try exactly ONE provider — no internal fallback. Used by FreeSubAgent
            // so that fallback control lives solely in the orchestrator layer.
            startFrom = a.split('=')[1];
            singleAttempt = true;
        } else if (a.startsWith('--from=')) {
            startFrom = a.split('=')[1];
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
        console.error('Usage: node index.js [--timeout=MS] [--from=NAME] [--only=NAME] [--single] [--keep-tabs] [--close] [--smoke] [--doctor] "Your prompt"');
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
        });

        if (result.success) {
            console.log(result.response); // stdout for piping
            ctx.recordTelemetry(0);
            process.exit(0);
        }

        // Classify failure — reasons are now objects {reason, error_details}
        const reasonValues = Object.values(result.reasons).map(r =>
            typeof r === 'string' ? r : (r.reason || '')
        );
        const allAuth = reasonValues.every(r => r.includes('auth') || r.includes('AUTH'));
        const allQuota = reasonValues.every(r => r.includes('quota') || r.includes('QUOTA') || r.includes('rate') || r.includes('RATE'));
        const hasSafety = reasonValues.some(r => r.includes('safety') || r.includes('SAFETY'));

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
        if (hasSafety) {
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

module.exports = { PROVIDER_CHAIN };
