#!/usr/bin/env node
/**
 * Web-SubAgent-Workflow — Sequential Pipeline Helper
 *
 * Thin wrapper over AgentChat-WebExtended. Claude Code is the master controller;
 * this script ONLY handles external AI calls for steps 2 (search), 3 (reason), 5 (review).
 *
 * Usage:
 *   node index.js --search "query"          # Step 2: Kimi → Qwen
 *   node index.js --reason "prompt"         # Step 3: Gemini → ChatGPT → Claude
 *   node index.js --review "content"        # Step 5: ChatGPT → Claude → Qwen
 *   node index.js --provider=kimi "prompt"  # Custom single provider
 *   cat large.txt | node index.js --review  # stdin for large payloads (>32KB)
 *   node index.js --smoke | --doctor
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const { acquireLock, releaseLock, cleanupAllLocks } = require("../lib/locks");

process.on("exit", cleanupAllLocks);
process.on("SIGINT", () => { cleanupAllLocks(); process.exit(130); });
process.on("SIGTERM", () => { cleanupAllLocks(); process.exit(143); });

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const WEBEXT = path.resolve(__dirname, "..", "AgentChat-WebExtended", "index.js");
const { PROVIDER_CHAIN } = require("../lib/providers/chain");
const ALL_KEYS = PROVIDER_CHAIN.map(p => p.key);

const STEP_CHAINS = {
    search: ["kimi", "qwen"],
    reason: ["gemini", "chatgpt", "claude"],
    review: ["chatgpt", "claude", "qwen"],
};

const PER_CALL_CAP_MS = 180_000;
const MIN_CALL_BUDGET_MS = 20_000;

function log(msg) { process.stderr.write(`[workflow] ${msg}\n`); }

// ═══════════════════════════════════════════════════════════════════
// PROVIDER CALL — subprocess → WebExtended
// ═══════════════════════════════════════════════════════════════════

function callProvider(prompt, provider, timeoutMs) {
    return new Promise((resolve) => {
        const child = spawn("node", [
            WEBEXT, `--only=${provider}`, `--timeout=${timeoutMs}`,
            `--timeout-per-provider=${timeoutMs}`,
            "--keep-tabs", "--single",
        ], { stdio: ["pipe", "pipe", "pipe"] });

        child.stdin.on("error", () => { /* EPIPE: child exited before stdin drained */ });
        try { child.stdin.write(prompt); } catch (_) { /* child already gone */ }
        try { child.stdin.end(); } catch (_) { /* child already gone */ }

        let stdout = "", stderr = "";
        const MAX = 1024 * 1024;
        child.stdout.on("data", d => { if (stdout.length < MAX) stdout += d.toString(); });
        child.stderr.on("data", d => { if (stderr.length < MAX) stderr += d.toString(); });

        let settled = false;
        const t1 = setTimeout(() => {
            if (!settled) { log(`SIGTERM → ${provider}`); child.kill("SIGTERM"); }
        }, timeoutMs + 30000);
        const t2 = setTimeout(() => {
            if (!settled) { log(`SIGKILL → ${provider}`); child.kill("SIGKILL"); }
        }, timeoutMs + 35000);

        child.on("close", (code) => {
            settled = true; clearTimeout(t1); clearTimeout(t2);
            const text = stdout.trim();
            const usedMatch = stderr.match(/✓\s*(\w+):\s*USED/);
            const providerUsed = usedMatch ? usedMatch[1].toLowerCase() : provider;
            if (code === 0 && text.length >= 5) {
                resolve({ ok: true, text, provider: providerUsed });
            } else {
                const m = { 1: "no_cdp", 2: "no_provider", 3: "safety", 4: "internal", 5: "quota", 9: "all_exhausted", 10: "timeout" };
                resolve({ ok: false, terminal: code === 1, text: "", provider: providerUsed, reason: m[code] || `exit_${code}` });
            }
        });

        child.on("error", (err) => {
            settled = true; clearTimeout(t1); clearTimeout(t2);
            resolve({ ok: false, text: "", provider, reason: "spawn_error", error: err.message });
        });
    });
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE CLEANING
// ═══════════════════════════════════════════════════════════════════

const UI_CHROME = [
    /^Gemini\s*[说說了]?[：:\s]*/gim, /^Claude\s*responded[：:\s]*/gim,
    /^ChatGPT\s*said[：:\s]*/gim, /^Kimi\s*说[：:\s]*/gim,
    /Thought\s*for\s*\d+s?\s*/gi, /^You said[：:\s]*.*?\n/gim,
    /^[^\n，,]{1,12}[，,]\s*(?:接著要做什麼|接下来要做什么|在想什麼|在想什么|我們進入正題|我们进入正题)[^\n]*/gim,
    /^我隨時待命[！!。.]?\s*/gim, /^我随时待命[！!。.]?\s*/gim,
];

function cleanResponse(text) {
    let c = text || "";
    for (const p of UI_CHROME) c = c.replace(p, "");
    return c.trim();
}

// ═══════════════════════════════════════════════════════════════════
// FALLBACK EXECUTOR
// ═══════════════════════════════════════════════════════════════════

async function executeWithFallback(chain, prompt, budgetMs) {
    const start = Date.now();
    const tried = [], myLocks = [];

    for (let i = 0; i < chain.length; i++) {
        const key = chain[i];
        const remaining = budgetMs - (Date.now() - start);
        if (remaining < MIN_CALL_BUDGET_MS) {
            for (const k of chain.slice(i)) {
                tried.push({ provider: k, reason: "budget_exhausted" });
            }
            break;
        }
        const perCall = Math.min(remaining, PER_CALL_CAP_MS);

        if (!acquireLock(key)) {
            tried.push({ provider: key, reason: "locked" }); continue;
        }
        myLocks.push(key);
        log(`Trying ${key} (${Math.round(perCall / 1000)}s)...`);

        const r = await callProvider(prompt, key, perCall);
        releaseLock(key);

        if (r.ok) {
            for (const k of myLocks) releaseLock(k);
            const cleaned = cleanResponse(r.text);
            return {
                success: true,
                provider_used: r.provider || key,
                primary_intended: chain[0],
                degradation: r.provider !== chain[0] ? {
                    reason: tried.map(t => `${t.provider}:${t.reason}`).join("; "),
                    fallback_chain: tried.map(t => t.provider),
                } : null,
                response: cleaned,
                response_length: cleaned.length,
                elapsed_ms: Date.now() - start,
            };
        }

        tried.push({ provider: key, reason: r.reason || "unknown" });

        // no_cdp (exit 1) is fatal for the whole chain — all providers use the same browser
        if (r.terminal) {
            for (const k of chain.slice(i + 1)) {
                tried.push({ provider: k, reason: "skipped_no_cdp" });
            }
            break;
        }
    }
    for (const k of myLocks) releaseLock(k);
    return {
        success: false, provider_used: null, primary_intended: chain[0],
        degradation: { reason: "ALL_EXHAUSTED", attempted: tried },
        response: null, error: `All exhausted: ${tried.map(t => t.provider).join(", ")}`,
        elapsed_ms: Date.now() - start,
    };
}

// ═══════════════════════════════════════════════════════════════════
// SMOKE TEST
// ═══════════════════════════════════════════════════════════════════

async function smokeTest() {
    log("Smoke test...");
    const seen = new Set();
    for (const chain of Object.values(STEP_CHAINS)) {
        for (const key of chain) seen.add(key);
    }

    const results = [];
    for (const key of seen) {
        if (!acquireLock(key)) { log(`  ${key}: ⏭ locked`); results.push(false); continue; }
        const r = await callProvider("Respond with exactly: Hello World", key, 120000);
        log(`  ${key}: ${r.ok ? "✓" : "✗ " + r.reason}`);
        releaseLock(key);
        results.push(r.ok);
    }
    if (results.every(v => !v)) {
        log("FATAL: all providers failed smoke test");
        process.exit(2);
    }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
    const args = process.argv.slice(2);
    let mode = null, customProvider = null, timeout = 180_000, smoke = false, doctor = false;
    const positional = [];

    for (let i = 0; i < args.length; i++) {
        const a = args[i];
        if (a === "--search") mode = "search";
        else if (a === "--reason") mode = "reason";
        else if (a === "--review") mode = "review";
        else if (a === "--smoke") smoke = true;
        else if (a === "--doctor") doctor = true;
        else if (a.startsWith("--provider=")) customProvider = a.split("=")[1].toLowerCase();
        else if (a.startsWith("--timeout=")) {
            const v = parseInt(a.split("=")[1], 10);
            if (!isNaN(v) && v > 0) timeout = v < 10000 ? v * 1000 : v;
        } else if (a === "--keep-tabs" || a === "--multi") { /* no-op — always on / deprecated */ }
        else if (!a.startsWith("--")) positional.push(a);
    }

    let prompt = positional.join(" ").trim();

    // Read from stdin when no positional prompt and stdin is piped (supports large payloads)
    if (!prompt && !process.stdin.isTTY) {
        try { prompt = fs.readFileSync(0, "utf8").trim(); } catch (_) { /* stdin not readable */ }
    }

    if (doctor) {
        if (!fs.existsSync(WEBEXT)) { log(`✗ NOT found: ${WEBEXT}`); process.exit(1); }
        const { spawnSync } = require("child_process");
        const r = spawnSync("node", [WEBEXT, "--doctor"], { stdio: "inherit", timeout: 30000 });
        process.exit(r.status || (r.error ? 1 : 0));
    }

    if (!fs.existsSync(WEBEXT)) { log(`FATAL: WebExtended not found: ${WEBEXT}`); process.exit(1); }

    if (smoke) { await smokeTest(); process.exit(0); }
    if (!prompt) { log("Usage: node index.js [--search|--reason|--review] [--timeout=N] <prompt>"); process.exit(1); }

    let chain;
    if (customProvider) {
        if (!ALL_KEYS.includes(customProvider)) {
            log(`ERROR: Unknown provider "${customProvider}". Valid: ${ALL_KEYS.join(", ")}`);
            process.exit(1);
        }
        chain = [customProvider];
    } else if (mode) {
        chain = STEP_CHAINS[mode];
    } else {
        log("WARN: No mode specified, defaulting to --search.");
        mode = "search"; chain = STEP_CHAINS.search;
    }

    log(`Mode: ${mode || "custom"} | Chain: ${chain.join(" → ")} | Budget: ${Math.round(timeout / 1000)}s`);
    const result = await executeWithFallback(chain, prompt, timeout);

    console.log(JSON.stringify({
        mode: mode || "custom", chain_used: chain,
        timestamp: new Date().toISOString(), ...result,
    }, null, 2));

    process.exit(result.success ? 0 : 2);
}

if (require.main === module) {
    main().catch(e => { process.stderr.write(`[workflow] CRITICAL: ${e.message}\n`); process.exit(4); });
}

module.exports = { STEP_CHAINS, callProvider, cleanResponse };
