/**
 * Shared subprocess executor over AgentChat-OneWeb.
 *
 * Unifies the callProvider / executeWithFallback / cleanResponse triplet that
 * previously lived as drifting near-copies inside AgentChat-IndependentTasks and
 * AgentChat-WebSubAgent. Divergences that had already crept in:
 *   - exit code 2 mapped to "auth" (FSA) vs "no_provider" (Workflow) — unified
 *     to "auth", matching OneWeb's documented ERR_NO_PROVIDER semantics
 *     ("all providers auth-gated").
 *   - MIN_CALL_BUDGET_MS 30s (FSA) vs 20s (Workflow) — parameterized.
 *   - lock lifecycle: hold-on-success (FSA, protects concurrent DAG workers
 *     from tab collisions) vs release-immediately (Workflow, sequential) —
 *     parameterized via holdLockOnSuccess.
 *   - no_cdp terminal abort existed only in Workflow — now both get it: exit 1
 *     means the shared browser is unreachable, so cascading through the rest
 *     of the chain only burns 8 doomed subprocess launches.
 *   - prompt delivery: Workflow used stdin, FSA used argv (Windows ~32KB
 *     command-line limit + `ps` leakage). Unified on stdin — mandatory now
 *     that wave execution injects upstream outputs into downstream prompts.
 *
 * Usage:
 *   const { createExecutor } = require("../lib/execute");
 *   const { callProvider, runChain, cleanResponse } = createExecutor({
 *       webextPath: WEBEXT, logPrefix: "orch",
 *       holdLockOnSuccess: true, acceptUsedMarker: true,
 *   });
 */

const { spawn } = require("child_process");
const { releaseLock, acquireProviderSlot, resolveMaxTabsPerProvider } = require("./locks");
const { log: _log } = require("./terminal");
const { PROVIDER_CHAIN } = require("./providers/chain");

// provider → operator-actionable recovery command (single source: chain.js).
// Surfaced when a call fails with reason 'auth' so orchestrator logs and the
// degradation payload carry the FIX, not just "gemini:all_exhausted".
const RECOVERY_HINTS = Object.fromEntries(
    PROVIDER_CHAIN.filter(p => p.recoveryHint).map(p => [p.key, p.recoveryHint])
);

// ── Defaults ──────────────────────────────────────────────────────────────

const PER_CALL_CAP_MS = 180_000;   // ceiling for a single provider attempt
const MIN_CALL_BUDGET_MS = 30_000; // below this, an attempt can't succeed anyway
const MAX_BUFFER = 1024 * 1024;    // 1MB stdout/stderr cap to prevent OOM

// LOCKED-PROVIDER RETRY: when a provider is temporarily locked by another worker,
// don't permanently skip it — retry with exponential backoff. The old behaviour
// (one shot → permanent skip) conflated "transient resource conflict" with
// "provider dead", so 8 concurrent workers easily starved each other into
// ALL_EXHAUSTED even when every provider was healthy. Budget-aware: retries stop
// once remaining budget < minCallBudgetMs.
const MAX_LOCK_RETRIES = 3;
const LOCK_BACKOFF_BASE_MS = 5_000; // ×3^k backoff: 5s → 15s → 45s

// OneWeb exit-code contract (see its header comment)
const EXIT_REASONS = {
    1: "no_cdp", 2: "auth", 3: "safety", 4: "internal",
    5: "quota", 9: "all_exhausted", 10: "timeout",
};

// ── Response cleaning ─────────────────────────────────────────────────────
//
// Superset of both skills' previous pattern lists, with one deliberate fix:
// Workflow's old /^Gemini\s*[说說了]?[：:\s]*/ allowed ZERO delimiter chars,
// so any content line merely STARTING with "Gemini" lost the word (e.g.
// "Gemini 是 Google 的模型" → "是 Google 的模型"). A bare provider name is now
// only stripped when followed by a speech verb or an explicit colon.

const PROVIDER_NAMES = "(?:Gemini|Claude|ChatGPT|Kimi|Qwen)";
const UI_CHROME_PATTERNS = [
    new RegExp(`^${PROVIDER_NAMES}\\s*(?:[说說]了?|said|responded)[：:\\s]*`, "gim"),
    new RegExp(`^${PROVIDER_NAMES}\\s*[：:]\\s*`, "gim"),
    /Thought\s*for\s*\d+s?\s*/gi,
    /^You said[：:\s]*.*?\n/gim,
    // Generic conversational-filler openers (locale-agnostic, no personal names)
    /^[^\n，,]{1,12}[，,]\s*(?:接著要做什麼|接下来要做什么|在想什麼|在想什么|我們進入正題|我们进入正题)[^\n]*/gim,
    /^我隨時待命[！!。.]?\s*/gim,
    /^我随时待命[！!。.]?\s*/gim,
];

// ── Per-provider noise patterns (stripped before UI chrome) ────────────────
// Each provider's web UI injects artifacts that shouldn't reach qualityGate.
// Qwen: leading timestamp sometimes glued to first word ("19:39:11[ANSWER …")
// MiMo: trailing logo image URLs (Xiaomi MiMo Studio branding)
// Kimi: trailing avatar image URLs (moonshot.cn CDN)
// MiniMax: trailing generated-image URLs (hailuoai.com CDN)
// DeepSeek: "已深度思考（用时 X.X 秒）" prefix (DeepSeek-R1 thinking banner)
const PER_PROVIDER_CLEANERS = {
    qwen: [
        // Leading timestamp: "19:39:11" or "19:39:11 " prefixed before answer
        /^\s*\d{1,2}:\d{2}(?::\d{2})?\s*/,
    ],
    mimo: [
        // Trailing MiMo branding images
        /\n!\[Xiaomi MiMo Studio[^\]]*\]\(https:\/\/aistudio\.xiaomimimo\.com\/[^\s)]+\)\s*$/g,
    ],
    kimi: [
        // Trailing avatar/profile images from moonshot.cn CDN
        /\n!\[[^\]]*\]\(https:\/\/avatar\.moonshot\.cn\/[^\s)]+\)\s*$/g,
    ],
    minimax: [
        // Trailing generated images from hailuoai.com CDN
        /\n!\[generated-image[^\]]*\]\(https:\/\/cdn\.hailuoai\.com\/[^\s)]+\)\s*$/g,
    ],
    deepseek: [
        // DeepSeek-R1 thinking banner: "已深度思考（用时 X.X 秒）"
        /^已深度思考（用时\s*\d+(?:\.\d+)?\s*秒）\s*/,
    ],
};

function cleanResponse(text, provider) {
    let cleaned = text || "";
    // 1. Per-provider noise (stripped first so UI chrome patterns see clean text)
    if (provider) {
        const pkey = String(provider).toLowerCase();
        const cleaners = PER_PROVIDER_CLEANERS[pkey];
        if (cleaners) {
            for (const pat of cleaners) cleaned = cleaned.replace(pat, "");
        }
    }
    // 2. Generic UI chrome (provider name speech prefixes, thought banners, etc.)
    for (const pat of UI_CHROME_PATTERNS) cleaned = cleaned.replace(pat, "");
    return cleaned.trim();
}

// ── Factory ───────────────────────────────────────────────────────────────

/**
 * @param {object} opts
 * @param {string}  opts.webextPath          absolute path to AgentChat-OneWeb/index.js
 * @param {string}  [opts.logPrefix]         stderr log prefix
 * @param {number}  [opts.minCallBudgetMs]   stop the chain when remaining budget drops below this
 * @param {number}  [opts.perCallCapMs]      per-attempt timeout ceiling
 * @param {boolean} [opts.holdLockOnSuccess] keep the provider lock after a successful call
 *                                           (caller must release, e.g. via cleanupAllLocks at
 *                                           wave boundaries / process exit)
 * @param {boolean} [opts.acceptUsedMarker]  treat "✓ X: USED (N chars" on stderr as success even
 *                                           if stdout arrived empty (stdout/close race tolerance)
 */
function createExecutor({
    webextPath,
    logPrefix = "exec",
    minCallBudgetMs = MIN_CALL_BUDGET_MS,
    perCallCapMs = PER_CALL_CAP_MS,
    holdLockOnSuccess = false,
    acceptUsedMarker = false,
} = {}) {
    if (!webextPath) throw new Error("createExecutor: webextPath is required");
    const log = (msg) => _log(logPrefix, msg);

    /**
     * Call exactly ONE provider via a OneWeb subprocess (--only + --single:
     * no internal cascade — fallback control lives solely in the caller).
     * Prompt is delivered over stdin, never argv.
     *
     * @returns {Promise<{ok:boolean, text:string, provider:string, terminal?:boolean, reason?:string, error?:string}>}
     */
    function callProvider(prompt, provider, timeoutMs, callOpts = {}) {
        // BUDGET CONTRACT FIX: OneWeb's normalizeTimeout() reinterprets any
        // --timeout < 10000 as SECONDS (×1000) — a human-typo heuristic that is
        // wrong for programmatic callers. IndependentTasks's buildDAG can legally
        // compute a 8-9s slice (0.4 × a small M1 budget), which the child then
        // inflated to HOURS while our SIGTERM fired at slice+30s: the attempt
        // burned ~40s of wall clock and died as exit_null instead of finishing
        // (or timing out) within its slice. Clamp at the spawn boundary so the
        // value the child sees is always in the "milliseconds" regime.
        timeoutMs = Math.max(10_000, Math.floor(timeoutMs) || 0);

        // EXIT-CODE CONFLATION GUARD: OneWeb exits 1 for BOTH a usage error
        // (empty prompt) and ERR_NO_CDP. An empty prompt spawned downstream would
        // come back as reason "no_cdp" with terminal=true — aborting the caller's
        // ENTIRE fallback chain over a caller-side bug. Fail fast locally instead.
        if (!prompt || !String(prompt).trim()) {
            return Promise.resolve({ ok: false, text: "", provider, reason: "empty_prompt" });
        }
        return new Promise((resolve) => {
            const childArgs = [
                webextPath,
                `--only=${provider}`,
                "--single",
                `--timeout=${timeoutMs}`,
                `--timeout-per-provider=${timeoutMs}`,
                "--keep-tabs", // POLICY: never let subprocesses close the user's browser
            ];
            // v19: same-provider concurrency — when >1 tab slot per provider is
            // configured, EVERY call runs in its own ephemeral tab (never reuse
            // an existing tab, close it on exit). Reuse under concurrency lets
            // two subprocesses findProviderPage() onto the SAME tab → 串题.
            if (callOpts.ephemeralTab) childArgs.push("--ephemeral-tab");
            const child = spawn(process.execPath, childArgs, { stdio: ["pipe", "pipe", "pipe"] });

            // stdin delivery — EPIPE-safe (child may exit before stdin drains)
            child.stdin.on("error", () => { /* EPIPE: child exited early */ });
            try { child.stdin.write(prompt); } catch (_) { /* child already gone */ }
            try { child.stdin.end(); } catch (_) { /* child already gone */ }

            let stdout = "", stderr = "", truncated = false;
            child.stdout.on("data", d => {
                if (stdout.length < MAX_BUFFER) stdout += d.toString(); else truncated = true;
            });
            child.stderr.on("data", d => {
                if (stderr.length < MAX_BUFFER) stderr += d.toString(); else truncated = true;
            });

            // Dual-timer teardown: SIGTERM after budget + 30s grace, SIGKILL +5s more
            // (prevents zombie subprocesses if OneWeb's own timeout wedges).
            let settled = false;
            const sigtermTimer = setTimeout(() => {
                if (!settled) { log(`SIGTERM → ${provider} (budget ${timeoutMs}ms + 30s grace elapsed)`); child.kill("SIGTERM"); }
            }, timeoutMs + 30_000);
            const sigkillTimer = setTimeout(() => {
                if (!settled) { log(`SIGKILL → ${provider}`); child.kill("SIGKILL"); }
            }, timeoutMs + 35_000);

            child.on("close", (code, signal) => {
                if (settled) return; // 'error' already resolved this promise
                settled = true;
                clearTimeout(sigtermTimer); clearTimeout(sigkillTimer);
                if (truncated) log(`WARN: ${provider} output exceeded 1MB — truncated`);

                const text = stdout.trim();
                const used = stderr.match(/✓\s*(\w+):\s*USED/);
                const providerUsed = used ? used[1].toLowerCase() : provider;
                const usedWithChars = stderr.match(/✓\s*\w+:\s*USED\s*\(\d+\s*chars/);

                // v23: STRUCTURED ERROR CHANNEL — OneWeb emits its per-provider
                // failure map as `[oneweb] AGENTCHAT_ERR {json}` on stderr before
                // any failure exit. Exit codes stay as the coarse fallback, but
                // they lose all detail (--single always exits 9, so "all_exhausted"
                // carried zero information about WHAT failed: selector miss, goto
                // timeout, and auth wall were indistinguishable upstream). Parse
                // the LAST such line; malformed JSON degrades to the exit code.
                let detail = null;
                {
                    const lines = stderr.match(/\[oneweb\] AGENTCHAT_ERR (\{.*\})/g);
                    if (lines) {
                        const payload = lines[lines.length - 1].slice("[oneweb] AGENTCHAT_ERR ".length);
                        try { detail = JSON.parse(payload); } catch (_) { /* fall back to exit code */ }
                    }
                }
                // Compact "reason@stage" for the provider this call intended (or
                // the sole entry, which is the --single case): e.g.
                // "error@editor_find", "timeout@wait_response", "auth@auth_check".
                const detailReason = (() => {
                    const rs = detail && detail.reasons;
                    if (!rs) return null;
                    const keys = Object.keys(rs);
                    const k = keys.includes(provider) ? provider : (keys.length === 1 ? keys[0] : null);
                    if (!k) return null;
                    const r = rs[k];
                    return r && r.reason ? (r.stage ? `${r.reason}@${r.stage}` : r.reason) : null;
                })();

                if (code === 0 && text.length >= 5) {
                    resolve({ ok: true, text, provider: providerUsed });
                } else if (code === 0 && acceptUsedMarker && usedWithChars && text.length < 5) {
                    // USED marker found but stdout was empty — the child's
                    // process.stdout.write callback (#2 flush fix) should prevent
                    // this, but if it still happens, don't silently return an empty
                    // success. Let the fallback chain try another provider.
                    resolve({ ok: false, text: "", provider: providerUsed,
                              reason: "stdout_lost_after_used_marker" });
                } else {
                    // code === null ⇒ killed by signal (our SIGTERM/SIGKILL after
                    // budget overrun, or external kill). Was labelled "exit_null",
                    // which read like a OneWeb contract violation in logs.
                    const coarse = code === null
                        ? `killed_${signal || "signal"}`
                        : (EXIT_REASONS[code] || `exit_${code}`);
                    // v23: prefer the structured detail — "error@editor_find"
                    // beats "all_exhausted". Signal kills keep the coarse label
                    // (the child died mid-flight; any emitted detail is stale).
                    const reason = (code !== null && detailReason) ? detailReason : coarse;
                    resolve({
                        ok: false, text: "", provider: providerUsed,
                        terminal: code === 1, // no_cdp — fatal for the whole chain
                        reason,
                        ...(detail ? { detail: detail.reasons } : {}),
                    });
                }
            });

            child.on("error", (err) => {
                if (settled) return; // 'close' already resolved this promise
                settled = true;
                clearTimeout(sigtermTimer); clearTimeout(sigkillTimer);
                resolve({ ok: false, text: "", provider, reason: "spawn_error", error: err.message });
            });
        });
    }

    /**
     * Try providers in `chain` order under a wall-clock budget, with file-lock
     * mutual exclusion against concurrent workers.
     *
     * chain[0] is the intended primary; any other provider answering counts as
     * degradation.
     */
    async function runChain(chain, prompt, budgetMs) {
        const start = Date.now();
        const tried = [];

        for (let i = 0; i < chain.length; i++) {
            const key = chain[i];

            const remaining = budgetMs - (Date.now() - start);
            if (remaining < minCallBudgetMs) {
                log(`[fallback] Budget exhausted (${Math.round(remaining / 1000)}s left) — stopping chain.`);
                for (const k of chain.slice(i)) tried.push({ provider: k, reason: "budget_exhausted" });
                break;
            }
            const perCall = Math.min(remaining, perCallCapMs);

            // LOCKED-PROVIDER RETRY: transient resource conflict (another
            // worker holds the provider lock) is NOT the same as a dead
            // provider. The old code permanently skipped locked providers,
            // so 8 concurrent workers could starve each other into
            // ALL_EXHAUSTED even when every provider was healthy. Retry with
            // exponential backoff (5s → 15s → 30s), budget-aware so we
            // don't burn the call budget on waiting alone.
            //
            // v19: acquireLock(key) → acquireProviderSlot(key). Default cap is
            // 1 slot (bare provider-name lock — behavior identical to before);
            // AGENTCHAT_MAX_TABS_PER_PROVIDER=2..4 opens extra lanes so
            // round-robin overflow tasks (N tasks > M providers) and fallbacks
            // run CONCURRENTLY in dedicated ephemeral tabs instead of
            // serializing on one shared tab.
            const maxTabs = resolveMaxTabsPerProvider();
            let slot = acquireProviderSlot(key, { max: maxTabs });
            let lockRetries = 0;
            while (!slot && lockRetries < MAX_LOCK_RETRIES) {
                const waitMs = Math.min(
                    LOCK_BACKOFF_BASE_MS * Math.pow(3, lockRetries),
                    Math.max(0, budgetMs - (Date.now() - start) - minCallBudgetMs)
                );
                if (waitMs <= 1000) break; // budget too tight — don't wait
                log(`[fallback] ${key} busy (all ${maxTabs} slot(s) taken) — retry in ${Math.round(waitMs / 1000)}s (${lockRetries + 1}/${MAX_LOCK_RETRIES})`);
                await new Promise(r => setTimeout(r, waitMs));
                slot = acquireProviderSlot(key, { max: maxTabs });
                lockRetries++;
            }
            if (!slot) {
                log(`[fallback] Skipping ${key} (locked after ${lockRetries} retries)`);
                tried.push({ provider: key, reason: "locked" });
                continue;
            }

            log(`[fallback] Trying ${key}${slot.slot > 0 ? `#${slot.slot}` : ""} (${Math.round(perCall / 1000)}s budget)...`);
            const result = await callProvider(prompt, key, perCall, { ephemeralTab: maxTabs > 1 });

            if (result.ok) {
                if (!holdLockOnSuccess) releaseLock(slot.lockKey);
                const actualProvider = result.provider || key;
                const cleaned = cleanResponse(result.text, actualProvider);
                return {
                    success: true,
                    provider_used: actualProvider,
                    primary_intended: chain[0],
                    degradation: actualProvider !== chain[0] ? {
                        reason: tried.map(t => `${t.provider}:${t.reason}`).join("; "),
                        fallback_chain: tried.map(t => t.provider),
                        // e.g. ["gemini: bash scripts/connect-gemini.sh …"] —
                        // lets the calling agent RELAY the fix to the user.
                        ...(tried.some(t => t.fix)
                            ? { fixes: tried.filter(t => t.fix).map(t => `${t.provider}: ${t.fix}`) }
                            : {}),
                        confidence_adjustment: -0.15,
                    } : null,
                    response: cleaned,
                    response_length: cleaned.length,
                    elapsed_ms: Date.now() - start,
                    ...(holdLockOnSuccess ? { held_lock: slot.lockKey } : {}),
                };
            }

            releaseLock(slot.lockKey);
            const entry = { provider: key, reason: result.reason || "unknown" };
            // v23: reason may now be "auth@auth_check" — prefix match, not equality
            if (String(entry.reason).startsWith("auth") && RECOVERY_HINTS[key]) {
                entry.fix = RECOVERY_HINTS[key];
                log(`[fallback] ${key}: auth — fix: ${entry.fix}`);
            }
            if (result.detail) entry.detail = result.detail; // full per-provider failure map from the child
            tried.push(entry);

            // no_cdp (exit 1) is fatal for the whole chain — every provider
            // shares the same browser. Don't burn subprocess launches on the rest.
            if (result.terminal) {
                for (const k of chain.slice(i + 1)) tried.push({ provider: k, reason: "skipped_no_cdp" });
                break;
            }
        }

        return {
            success: false,
            provider_used: null,
            primary_intended: chain[0],
            degradation: { reason: "ALL_EXHAUSTED", attempted: tried, confidence_adjustment: -1.0 },
            response: null,
            response_length: 0,
            error: `All providers exhausted: ${tried.map(t => t.provider).join(", ")}`,
            elapsed_ms: Date.now() - start,
        };
    }

    return { callProvider, runChain, cleanResponse };
}

module.exports = { createExecutor, cleanResponse, PER_CALL_CAP_MS, MIN_CALL_BUDGET_MS, EXIT_REASONS };
