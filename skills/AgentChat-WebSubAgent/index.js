#!/usr/bin/env node
/**
 * AgentChat-WebSubAgent — Sequential Pipeline Helper
 *
 * Thin wrapper over AgentChat-OneWeb. Claude Code is the master controller;
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

const path = require("path");
const fs = require("fs");

// ═══════════════════════════════════════════════════════════════════
// GUARD: ../lib is a sibling tree shared by all AgentChat skills.
// Copying ONLY this skill directory to ~/.claude/skills/ loses it —
// every ../lib require would throw a bare MODULE_NOT_FOUND stack.
// Mirror of the v14 guard in AgentChat-OneWeb/index.js.
// ═══════════════════════════════════════════════════════════════════
let acquireLock, releaseLock, cleanupAllLocks, makeRunId, emitReceipt;
try {
    ({ acquireLock, releaseLock, cleanupAllLocks } = require("../lib/locks"));
    ({ makeRunId, emitReceipt } = require("../lib/receipt"));
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        process.stderr.write(
            '[wsa] FATAL: ../lib not found — this skill requires the sibling skills/lib/ tree.\n' +
            `[wsa]   fix: cp -r ${path.resolve(__dirname, '..', 'lib')} ${path.resolve(__dirname, 'lib')}\n` +
            '[wsa]   (or clone the full AgentChat repo instead of copying a single skill directory)\n');
        process.exit(4);
    }
    throw e;
}

process.on("exit", cleanupAllLocks);
process.on("SIGINT", () => { cleanupAllLocks(); process.exit(130); });
process.on("SIGTERM", () => { cleanupAllLocks(); process.exit(143); });

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════

const WEBEXT = path.resolve(__dirname, "..", "AgentChat-OneWeb", "index.js");
const { PROVIDER_CHAIN } = require("../lib/providers/chain");
const ALL_KEYS = PROVIDER_CHAIN.map(p => p.key);

const STEP_CHAINS = {
    search: ["kimi", "qwen"],
    reason: ["gemini", "chatgpt", "claude"],
    review: ["chatgpt", "claude", "qwen"],
};

function log(msg) { process.stderr.write(`[workflow] ${msg}\n`); }

// ═══════════════════════════════════════════════════════════════════
// PROVIDER CALL + FALLBACK — shared executor (lib/execute.js)
// ═══════════════════════════════════════════════════════════════════
// callProvider/cleanResponse/executeWithFallback previously lived here as a
// near-copy of IndependentTasks's versions and had drifted (exit code 2 was
// labelled "no_provider" here vs "auth" there; MIN_CALL_BUDGET 20s vs 30s).
// Single implementation now, parameterized:
//   holdLockOnSuccess: false — steps are sequential; a provider is free again
//     the moment its call returns.
//   minCallBudgetMs: 20s — preserves this skill's previous chain-stop threshold.
// The executor also unifies stdin prompt delivery and the no_cdp terminal abort
// this skill already had.

const { createExecutor } = require("../lib/execute");
const { callProvider, runChain, cleanResponse } = createExecutor({
    webextPath: WEBEXT,
    logPrefix: "workflow",
    minCallBudgetMs: 20_000,
    holdLockOnSuccess: false,
});

const executeWithFallback = runChain; // (chain, prompt, budgetMs)

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

    if (!fs.existsSync(WEBEXT)) { log(`FATAL: OneWeb not found: ${WEBEXT}`); process.exit(1); }

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

    // Execution receipt — embedded INSIDE the output JSON (this file's stdout
    // contract is "one JSON object"; a trailing plain-text line would break
    // that). A stderr copy keeps the `[receipt] AGENTCHAT_RUN` grep pattern
    // uniform across all three skills. The calling agent must quote the
    // receipt (or its run_id) per step in its final report; run_ids are
    // persisted to data/receipts.jsonl for user-side verification.
    const receipt = emitReceipt({
        skillDir: __dirname,
        skill: "AgentChat-WebSubAgent",
        runId: makeRunId(),
        fields: {
            mode: mode || "custom",
            exit: result.success ? 0 : 2,
            provider_used: result.provider_used,
            elapsed_ms: result.elapsed_ms,
        },
        stream: "stderr",
    });

    console.log(JSON.stringify({
        mode: mode || "custom", chain_used: chain,
        timestamp: new Date().toISOString(), receipt, ...result,
    }, null, 2));

    // P0 FLUSH FIX: exit() immediately after console.log() truncates piped
    // stdout at the pipe-buffer boundary; the JSON result (full response
    // embedded) can exceed it. All handles are closed here, so exitCode +
    // natural exit drains stdout fully. cleanupAllLocks still runs on "exit".
    process.exitCode = result.success ? 0 : 2;
}

if (require.main === module) {
    main().catch(e => { process.stderr.write(`[workflow] CRITICAL: ${e.message}\n`); process.exit(4); });
}

module.exports = { STEP_CHAINS, callProvider, cleanResponse };
