#!/usr/bin/env node
/**
 * Parallel AI Decompose v3 — Thin Orchestrator over AgentChat-WebExtended
 *
 * Core principles:
 *   1. DAG first, parallelism second (respect dependencies)
 *   2. Complementary roles (no overlapping responsibilities)
 *   3. Structured I/O with quality gates
 *   4. Evidence-based arbitration (not majority vote)
 *   5. Explicit degradation (never silent failure)
 *   6. Single provider source: AgentChat-WebExtended (no code duplication)
 *
 * Three modules:
 *   M1: Task DAG — decompose task into 4 complementary sub-prompts
 *   M2: Parallel Dispatch — spawn N subprocesses, each → AgentChat-WebExtended
 *   M3: Evidence Arbitrator — evidence-weighted synthesis + degradation report
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const LOCK_DIR = path.join(require("os").tmpdir(), "ai_locks");
try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch (_) {}

// Atomic mkdir-based mutex — fs.mkdirSync() is atomic on all POSIX filesystems.
// Each provider gets a directory under LOCK_DIR; only the process that successfully
// creates the directory holds the lock. PID is written into <dir>/pid for stale detection.
// This eliminates the TOCTOU race between existsSync/unlinkSync/writeFileSync('wx').
function acquireLock(provider) {
    const lockDir = path.join(LOCK_DIR, provider);
    try {
        fs.mkdirSync(lockDir);  // atomic — exactly one process wins
        fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
        return true;
    } catch (_) {
        // Directory exists — check if the owning process is still alive
        try {
            const pidFile = path.join(lockDir, "pid");
            const oldPid = parseInt(fs.readFileSync(pidFile, "utf8").trim(), 10);
            try { process.kill(oldPid, 0); } catch (_) {
                // Stale lock — remove and retry atomically
                fs.rmSync(lockDir, { recursive: true, force: true });
                try {
                    fs.mkdirSync(lockDir);
                    fs.writeFileSync(path.join(lockDir, "pid"), String(process.pid));
                    return true;
                } catch (_) { /* another process beat us */ }
            }
        } catch (_) { /* can't read pid file */ }
        return false;
    }
}

function releaseLock(provider) {
    const lockDir = path.join(LOCK_DIR, provider);
    try {
        const pidFile = path.join(lockDir, "pid");
        const data = fs.readFileSync(pidFile, "utf8").trim();
        if (parseInt(data, 10) === process.pid) {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    } catch (_) {}
}

// Cleanup all locks owned by this process on exit (prevent stale locks)
function cleanupAllLocks() {
    let entries;
    try { entries = fs.readdirSync(LOCK_DIR); } catch (_) { return; }
    for (const name of entries) {
        const lockDir = path.join(LOCK_DIR, name);
        try {
            const pidFile = path.join(lockDir, "pid");
            const data = fs.readFileSync(pidFile, "utf8").trim();
            if (parseInt(data, 10) === process.pid) {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
        } catch (_) { /* skip non-lock directories */ }
    }
}
process.on("exit", cleanupAllLocks);
process.on("SIGINT", () => { cleanupAllLocks(); process.exit(); });
process.on("SIGTERM", () => { cleanupAllLocks(); process.exit(); });

const WEBEXT = path.resolve(__dirname, "..", "AgentChat-WebExtended", "index.js");
// Single source of truth: lib/providers/chain.js (shared with WebExtended).
// Previously this required WebExtended's index.js just to read a constant,
// dragging in playwright-core + all 8 adapter modules at orchestrator startup.
const { PROVIDER_CHAIN } = require('../lib/providers/chain');
const FALLBACK_CHAIN = PROVIDER_CHAIN.map(p => p.key);

function buildFallbackChain(primaryKey, skipList = []) {
    const skipSet = new Set([primaryKey, ...skipList]);
    const rest = FALLBACK_CHAIN.filter(k => !skipSet.has(k));
    return [primaryKey, ...rest];
}

const STAGGER_MS = 1500; // inter-worker launch delay

// Module-level flags set by main()
// POLICY: Always keep tabs. Never let subprocesses close the user's browser.
const KEEP_TABS = true;

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════

const { log: _log } = require('../lib/terminal');
const log = (msg) => _log('orch', msg);
function ts() { return new Date().toISOString().slice(11, 19); }

// ═══════════════════════════════════════════════════════════════════
// PROVIDER CALL — single subprocess → AgentChat-WebExtended
// ═══════════════════════════════════════════════════════════════════

/**
 * Call a single AI provider via AgentChat-WebExtended subprocess.
 * All provider implementation lives in WebExtended — this is just a thin wrapper.
 *
 * @returns {{ ok: boolean, text: string, provider: string, reason?: string }}
 */
function callProvider(prompt, provider, timeoutMs) {
  return new Promise((resolve) => {
    const spawnArgs = [
      WEBEXT,
      `--from=${provider}`,
      `--timeout=${timeoutMs}`,
    ];
    spawnArgs.push("--keep-tabs"); // Always — never let child process close tabs
    // BUGFIX: without --single, WebExtended's --from only sets the starting index —
    // on failure it cascades through the REST of its own PROVIDER_CHAIN inside this
    // one subprocess. That meant `provider` (the key we acquireLock()'d above) could
    // silently differ from the provider actually used, while the lock stayed on
    // `provider` — breaking mutual exclusion between concurrent DAG-node workers
    // that expect exclusive use of whatever provider ends up handling their call.
    // --single makes this an atomic "exactly this one provider" attempt, so our own
    // executeWithFallback() loop (with its own locking) is the sole fallback layer.
    spawnArgs.push("--single");
    spawnArgs.push(prompt);

    const child = spawn("node", spawnArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      // P0-4: Removed built-in timeout (SIGTERM only, no SIGKILL fallback).
      // Using explicit dual-timer instead to prevent zombie processes.
    });

    let stdout = "", stderr = "";
    const MAX_BUFFER = 1024 * 1024; // 1MB to prevent OOM (P1 extra safety)
    let truncated = false;

    child.stdout.on("data", d => {
      if (stdout.length < MAX_BUFFER) stdout += d.toString();
      else truncated = true;
    });
    child.stderr.on("data", d => {
      if (stderr.length < MAX_BUFFER) stderr += d.toString();
      else truncated = true;
    });

    let settled = false;
    const sigtermTime = timeoutMs + 30000;
    const sigkillTime = sigtermTime + 5000;

    // P0-4: SIGTERM first, then SIGKILL to prevent zombie processes
    const sigtermTimer = setTimeout(() => {
      if (!settled) { log(`    [orch] SIGTERM -> ${provider} (actual elapsed ${sigtermTime}ms, call budget ${timeoutMs}ms)`); child.kill('SIGTERM'); }
    }, sigtermTime);

    const sigkillTimer = setTimeout(() => {
      if (!settled) { log(`    [orch] SIGKILL -> ${provider} (forced after ${sigkillTime}ms total)`); child.kill('SIGKILL'); }
    }, sigkillTime);

    child.on("close", (code) => {
      settled = true;
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);

      const text = stdout.trim();
      const provMatch = stderr.match(/✓\s*(\w+):\s*USED/);
      const providerUsed = provMatch ? provMatch[1].toLowerCase() : provider;

      if (truncated) {
        log(`    [orch] WARN: Output truncated for ${provider} (exceeded 1MB buffer)`);
      }

      // P0-5: If WebExtended logged "✓ Provider: USED" to stderr, trust it.
      // Concurrent subprocesses can race stdout delivery vs close event.
      const usedMatch = stderr.match(/✓\s*(\w+):\s*USED\s*\((\d+)\s*chars/);
      if (code === 0 && (text.length >= 5 || usedMatch)) {
        resolve({ ok: true, text, provider: providerUsed });
      } else {
        const reasonMap = { 1: "no_cdp", 2: "auth", 3: "safety", 4: "internal", 5: "quota", 9: "all_exhausted", 10: "timeout" };
        resolve({ ok: false, text: "", provider: providerUsed, reason: reasonMap[code] || `exit_${code}` });
      }
    });

    child.on("error", (err) => {
      settled = true;
      clearTimeout(sigtermTimer);
      clearTimeout(sigkillTimer);
      resolve({ ok: false, text: "", provider, reason: "spawn_error", error: err.message });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// FALLBACK EXECUTOR — try primary first, then chain
// ═══════════════════════════════════════════════════════════════════

const PER_CALL_CAP_MS = 180_000;   // ceiling for a single provider attempt
const MIN_CALL_BUDGET_MS = 30_000; // below this, an attempt can't succeed anyway

async function executeWithFallback(primaryKey, prompt, budgetMs, skipList = []) {
  const start = Date.now();
  const chain = buildFallbackChain(primaryKey, skipList);
  const tried = [];
  const myLocks = []; // track which providers we locked

  for (const key of chain) {
    // BUDGET FIX: the old perCallBudget used Math.max(120000, ...) — a FLOOR,
    // so a single call could exceed the node's entire budget, and the loop
    // never compared elapsed time against budgetMs at all. Worst case one
    // worker ran 8 × 150s ≈ 20 min regardless of --timeout. Budget is now
    // checked every iteration and the cap is a ceiling.
    const remaining = budgetMs - (Date.now() - start);
    if (remaining < MIN_CALL_BUDGET_MS) {
      log(`    [fallback] Budget exhausted (${Math.round(remaining / 1000)}s left) — stopping chain.`);
      tried.push({ key, reason: "budget_exhausted" });
      break;
    }
    const perCallBudget = Math.min(remaining, PER_CALL_CAP_MS);

    // File lock: skip if another worker already has this provider open
    if (!acquireLock(key)) {
      log(`    [fallback] Skipping ${key} (locked by another worker)`);
      tried.push({ key, reason: "locked" });
      continue;
    }
    myLocks.push(key);

    log(`    [fallback] Trying ${key} (${Math.round(perCallBudget / 1000)}s budget)...`);

    const result = await callProvider(prompt, key, perCallBudget);

    if (result.ok) {
      // Keep lock — marks provider as "in use" so other workers skip it
      // Degradation = the provider that actually answered ≠ intended primary.
      // With --single these are equivalent to (key !== primaryKey), but comparing
      // provider_used keeps arbitration honest even if subprocess semantics
      // ever change again.
      const actualProvider = result.provider || key;
      return {
        provider_used: actualProvider,
        primary_intended: primaryKey,
        degradation: actualProvider !== primaryKey ? {
          reason: tried.map(t => `${t.key}:${t.reason}`).join("; "),
          fallback_chain: tried.map(t => t.key),
          confidence_adjustment: -0.15,
        } : null,
        response: cleanResponse(result.text),
        elapsed_ms: Date.now() - start,
      };
    }
    tried.push({ key, reason: result.reason || "unknown" });
    releaseLock(key); // failed — release so other worker can try it later
  }

  // All exhausted — release any remaining locks
  for (const k of myLocks) releaseLock(k);

  return {
    provider_used: null,
    primary_intended: primaryKey,
    degradation: { reason: "ALL_EXHAUSTED", attempted: tried.map(t => `${t.key}:${t.reason}`), confidence_adjustment: -1.0 },
    response: null,
    error: `All providers exhausted: ${tried.map(t => t.key).join(", ")}`,
  };
}

// ═══════════════════════════════════════════════════════════════════
// RESPONSE CLEANING
// ═══════════════════════════════════════════════════════════════════

const UI_CHROME_PATTERNS = [
  /^Gemini\s*說[了]?[：:\s]*/gim,
  /^Gemini\s*said[：:\s]*/gim,
  /^Claude\s*responded[：:\s]*/gim,
  /^ChatGPT\s*said[：:\s]*/gim,
  /^Kimi\s*说[：:\s]*/gim,
  /Thought\s*for\s*\d+s?\s*/gi,
  /^You said[：:\s]*.*?\n/gim,
  // Generic conversational-filler openers (was a hardcoded personal-name
  // pattern — leaked personal context and didn't generalize).
  /^[^\n，,]{1,12}[，,]\s*(?:接著要做什麼|接下来要做什么|在想什麼|在想什么|我們進入正題|我们进入正题)[^\n]*/gim,
  /^我隨時待命[！!。.]?\s*/gim,
  /^我随时待命[！!。.]?\s*/gim,
];

function cleanResponse(text) {
  let cleaned = text || "";
  for (const pat of UI_CHROME_PATTERNS) {
    cleaned = cleaned.replace(pat, "");
  }
  return cleaned.trim();
}

// ═══════════════════════════════════════════════════════════════════
// MODULE 1: TASK DAG
// ═══════════════════════════════════════════════════════════════════

function normalizeAI(name) {
  const n = (name || "").toLowerCase().trim();
  const map = { gpt: "chatgpt", chatgpt: "chatgpt", gemini: "gemini", kimi: "kimi", qwen: "qwen", claude: "claude", minimax: "minimax", deepseek: "deepseek", mimo: "mimo" };
  return map[n] || n;
}

const { DAG_DECOMPOSER_PROMPT } = require('../lib/prompts');

function tryParsePreDecomposedPlan(userTask) {
  // Detect if input is already a pre-decomposed JSON plan with "subtasks" array
  // (as produced by Claude Code's Step 2). If so, extract nodes directly — no re-decomposition.
  try {
    const json = JSON.parse(userTask);
    if (json.subtasks && Array.isArray(json.subtasks) && json.subtasks.length >= 2) {
      const nodes = json.subtasks.map(st => ({
        id: st.id || st.role || `task_${Math.random().toString(36).slice(2,6)}`,
        ai: st.primary || "gemini",
        role: st.role || "worker",
        goal: st.id || "task",
        depends_on: st.depends_on || [],
        prompt: st.prompt || "",
      }));
      // Validate all nodes have non-empty prompts
      if (nodes.every(n => n.prompt && n.prompt.length > 5)) {
        return { nodes, pre_decomposed: true };
      }
    }
  } catch (_) { /* not JSON, proceed to decomposition */ }
  return null;
}

async function buildDAG(userTask, budgetMs) {
  log("━━━ Module 1: Task DAG Construction ━━━");

  // P1: Detect pre-decomposed JSON plan — skip re-decomposition entirely
  const preDecomposed = tryParsePreDecomposedPlan(userTask);
  if (preDecomposed) {
    log(`  Task: pre-decomposed JSON with ${preDecomposed.nodes.length} subtasks — skipping decomposition`);
    log(`  Nodes: ${preDecomposed.nodes.map(n => `${n.id}→${n.ai}(${n.role})`).join(" | ")}`);
    return preDecomposed;
  }

  log(`  Task: "${userTask.slice(0, 100)}${userTask.length > 100 ? "..." : ""}"`);

  const prompt = DAG_DECOMPOSER_PROMPT.replace("<TASK>", userTask);

  // Try each provider for decomposition — under a hard deadline.
  // BUDGET FIX: previously each of up to 8 attempts got a fresh 0.4×budget
  // slice with no elapsed-time check, so M1 alone could consume the entire
  // --timeout before dispatch ever started.
  const deadline = Date.now() + budgetMs;
  for (const key of FALLBACK_CHAIN) {
    const remaining = deadline - Date.now();
    if (remaining < 20_000) {
      log("  Decomposer: budget exhausted — falling back to rule-based DAG");
      break;
    }
    log(`  Decomposer: trying ${key}...`);
    const result = await callProvider(prompt, key, Math.min(remaining, Math.floor(budgetMs * 0.4)));
    if (!result.ok) { log(`  Decomposer: ${key} failed (${result.reason})`); continue; }

    const m = result.text.match(/\{[\s\S]*"dag"[\s\S]*\}/);
    if (!m) { log("  Decomposer: no DAG JSON found"); continue; }

    try {
      const dag = JSON.parse(m[0]);
      if (!dag.dag?.nodes || dag.dag.nodes.length < 2) { log("  Decomposer: DAG too small"); continue; }
      log(`  Decomposer: ✓ ${key} produced ${dag.dag.nodes.length}-node DAG`);
      return dag.dag;
    } catch (e) {
      log(`  Decomposer: parse error: ${String(e).slice(0, 60)}`);
    }
  }

  // Fallback: rule-based 4-way parallel
  log("  Decomposer: ALL failed, using rule-based 4-way parallel DAG");
  return {
    nodes: [
      { id: "research", ai: "Kimi",   role: "researcher",        goal: "资料收集", depends_on: [], prompt: `请收集关于以下问题的背景资料和关键事实，直接列出信息：\n\n${userTask}` },
      { id: "analyze",  ai: "Gemini", role: "depth_reasoner",    goal: "深度分析", depends_on: [], prompt: `请从理论/机制层面深入分析以下问题，给出严谨的推理和结论：\n\n${userTask}` },
      { id: "create",   ai: "GPT",    role: "creative_builder",  goal: "方案与建议", depends_on: [], prompt: `请从应用和实践角度分析以下问题，给出可操作的建议和方案：\n\n${userTask}` },
      { id: "verify",   ai: "Qwen",   role: "reviewer_retriever", goal: "事实核查", depends_on: [], prompt: `请独立审查和验证以下问题涉及的关键事实，用中文指出潜在的不确定之处：\n\n${userTask}` },
    ],
    fallback: true,
  };
}

// ═══════════════════════════════════════════════════════════════════
// MODULE 2: PARALLEL DISPATCH + QUALITY GATE
// ═══════════════════════════════════════════════════════════════════

function qualityGate(node, result) {
  const issues = [];
  if (!result.response || result.response.length < 10) {
    issues.push("EMPTY_OR_TOO_SHORT");
  }
  if (result.degradation) {
    issues.push(`DEGRADED: ${result.degradation.reason}`);
  }
  const passed = issues.length === 0 || (issues.length === 1 && issues[0].startsWith("DEGRADED"));
  return {
    passed,
    issues,
    quality_score: passed ? (result.degradation ? 0.6 : 1.0) : 0.0,
  };
}

async function runOneWorker(node, budgetMs, skipList = []) {
  const primaryKey = normalizeAI(node.ai);

  try {
    const result = await executeWithFallback(primaryKey, node.prompt, budgetMs, skipList);
    const qr = qualityGate(node, result);
    const degNote = result.degradation
      ? ` ⚠ ${result.provider_used} (intended ${primaryKey})`
      : ` ✓ ${result.provider_used}`;
    log(`  [${node.id}]${degNote} score=${qr.quality_score}${qr.issues.length ? " issues:" + qr.issues.join(",") : ""}`);
    return { nodeId: node.id, output: result, quality: qr, node };
  } catch (e) {
    log(`  [${node.id}] ✗ exception: ${String(e).slice(0, 60)}`);
    return {
      nodeId: node.id,
      output: { provider_used: null, response: null, error: String(e), degradation: { reason: "EXCEPTION", confidence_adjustment: -1.0 } },
      quality: { passed: false, issues: ["EXCEPTION"], quality_score: 0 },
      node,
    };
  }
}

async function dispatchParallel(dag, budgetMs) {
  const nodes = dag.nodes;
  log(`━━━ Module 2: Parallel Dispatch — ${nodes.length} workers ━━━`);
  log(`  Roles: ${nodes.map(n => `${n.id}→${n.ai}(${n.role})`).join(" | ")}`);

  // P1-6: Subtract stagger overhead from budget before dividing equally
  const totalStaggerOverhead = (nodes.length - 1) * STAGGER_MS;
  const effectiveBudget = Math.max(nodes.length * 60000, budgetMs - totalStaggerOverhead);
  const perNodeBudget = Math.floor(effectiveBudget / nodes.length);

  // Collect all primary providers so each worker avoids stepping on others' toes
  const allPrimaries = nodes.map(n => normalizeAI(n.ai));
  const uniquePrimaries = [...new Set(allPrimaries)];

  // Launch all workers with stagger, each with equal budget from its own start time
  const tasks = nodes.map((node, i) => {
    const delay = i * STAGGER_MS;
    const myPrimary = normalizeAI(node.ai);
    const skipList = uniquePrimaries.filter(p => p !== myPrimary);
    return new Promise(resolve => setTimeout(async () => {
      const r = await runOneWorker(node, perNodeBudget, skipList);
      resolve(r);
    }, delay));
  });

  // Promise.allSettled — never fails if a single worker throws unexpectedly
  const settled = await Promise.allSettled(tasks);
  const results = {};
  for (const s of settled) {
    if (s.status === 'rejected') {
      log(`  Worker promise rejected: ${String(s.reason).slice(0, 60)}`);
      continue;
    }
    const wr = s.value;
    if (wr) results[wr.nodeId] = { output: wr.output, quality: wr.quality, node: wr.node };
  }
  return results;
}

// ═══════════════════════════════════════════════════════════════════
// MODULE 3: EVIDENCE ARBITRATOR
// ═══════════════════════════════════════════════════════════════════

// ── Shared helpers ──

/** Split text into sentences, keeping the sentence intact. */
function sentences(text) {
  return (text || "").split(/(?<=[。！？!?\n])\s*/).filter(s => s.trim().length > 8);
}

/** Extract key phrases: numbers+units, chemical formulas, quoted terms, proper nouns. */
function keyPhrases(text) {
  const found = new Set();
  // numbers with common scientific units
  for (const m of text.matchAll(/([\d.]+)\s*(eV|Å|kcal\/mol|kJ\/mol|nm|pm|kcal|kJ|％|%|degree|K\b)/gi)) {
    found.add(m[0].toLowerCase());
  }
  // chemical formulas (Ag, HCl, H₂O, Cu(111), etc.)
  for (const m of text.matchAll(/\b(?:[A-Z][a-z]?(?:\d+)?(?:\([^)]*\))?){1,4}\b/g)) {
    const t = m[0].trim();
    if (t.length >= 2 && !/^(The|This|In|On|We|It|Is|No|To|He|She|They|For|And|But|Or|A|An)$/i.test(t)) {
      found.add(t.toLowerCase());
    }
  }
  return [...found];
}

// ── Trust Tiers ──

function assignTrust(node, result) {
  if (!result?.output?.response) return { tier: "MISSING", provider: result?.output?.provider_used || null, reason: result?.output?.error || "no response" };
  const deg = result.output.degradation;
  if (deg) return {
    tier: "DEGRADED",
    provider: result.output.provider_used,
    intended: result.output.primary_intended,
    reason: deg.reason,
  };
  const short = result.output.response.length < 50;
  return { tier: short ? "DEGRADED" : "FULL", provider: result.output.provider_used, reason: short ? "response too short" : null };
}

// ── Check: Reviewer Alerts ──

function reviewerAlerts(reviewerText, researcherText, reasonerText) {
  const NEGATION_RE = /(?:错误|不一致|应为|并非|contradiction|不准确|遗漏|忽略|missing|wrong|incorrect|disagree|不符合|有误|忽视了|没有考虑)/i;
  const alerts = [];
  for (const sent of sentences(reviewerText)) {
    if (!NEGATION_RE.test(sent)) continue;
    const phrases = keyPhrases(sent);
    if (phrases.length === 0) continue;
    const inResearcher = phrases.filter(p => (researcherText || "").toLowerCase().includes(p));
    const inReasoner   = phrases.filter(p => (reasonerText || "").toLowerCase().includes(p));
    const targets = [];
    if (inResearcher.length > 0) targets.push("researcher");
    if (inReasoner.length > 0) targets.push("reasoner");
    if (targets.length > 0) {
      alerts.push({ targets, sentence: sent.trim().slice(0, 200), on_entities: [...new Set([...inResearcher, ...inReasoner])] });
    }
  }
  return alerts;
}

// ── Check: Synthesis Gap ──

function synthesisGap(builderText, sources) {
  const gaps = [];
  // researcher: entity coverage
  if (sources.researcher) {
    const ents = keyPhrases(sources.researcher);
    const hit = ents.filter(e => (builderText || "").toLowerCase().includes(e));
    if (ents.length > 2 && hit.length / ents.length < 0.4) {
      gaps.push({ from: "researcher", type: "entity_coverage", rate: `${hit.length}/${ents.length}`, detail: "资料关键实体在综合报告中覆盖率不足" });
    }
  }
  // reasoner: conclusion absorption
  if (sources.reasoner) {
    const concl = sentences(sources.reasoner).filter(s =>
      /(?:因此|所以|thus|therefore|结论|conclusion|综上|hence|accordingly)/i.test(s)
    );
    const absorbed = concl.filter(s => {
      const words = s.replace(/[，,。！？.!?\s]+/g, " ").trim().split(/\s+/).slice(0, 8).join(" ");
      return words.length > 8 && (builderText || "").toLowerCase().includes(words.toLowerCase());
    });
    if (concl.length >= 2 && absorbed.length === 0) {
      gaps.push({ from: "reasoner", type: "conclusion_missing", detail: "推理者结论未被综合报告吸收" });
    } else if (concl.length >= 2 && absorbed.length < concl.length) {
      gaps.push({ from: "reasoner", type: "partial_absorption", detail: `推理者 ${concl.length} 条结论仅 ${absorbed.length} 条被纳入` });
    }
  }
  // reviewer: flag response
  if (sources.reviewer) {
    const hasNegation = /(?:错误|不一致|应为|并非|contradiction|不准确|遗漏|忽略)/i.test(sources.reviewer);
    if (hasNegation && !/(?:存疑|uncertain|may\s+not|possibly|有待|需要进一步|limitation)/i.test(builderText || "")) {
      gaps.push({ from: "reviewer", type: "flag_unacknowledged", detail: "审阅者发现问题但综合报告未回应" });
    }
  }
  return gaps;
}

// ── Arbitration ──

function arbitrateResults(dag, results) {
  log("━━━ Module 3: Evidence Arbitration ━━━");

  const nodes = dag.nodes;
  const trust = {};
  for (const node of nodes) {
    trust[node.id] = assignTrust(node, results[node.id]);
  }

  // Resolve role texts (role name → actual response)
  const roleText = {};
  for (const node of nodes) {
    const r = results[node.id];
    if (r?.output?.response) roleText[node.role] = r.output.response;
  }

  // Reviewer Alerts
  let alerts = [];
  const revText = roleText["reviewer_retriever"] || roleText["reviewer"] || "";
  const resText = roleText["researcher"] || "";
  const reaText = roleText["depth_reasoner"] || "";
  if (revText && (resText || reaText)) {
    alerts = reviewerAlerts(revText, resText, reaText);
  }

  // Synthesis Gap
  let gaps = [];
  const bldText = roleText["creative_builder"] || "";
  if (bldText) {
    const sources = {};
    if (resText) sources.researcher = resText;
    if (reaText) sources.reasoner = reaText;
    if (revText) sources.reviewer = revText;
    if (Object.keys(sources).length > 0) {
      gaps = synthesisGap(bldText, sources);
    }
  }

  return { trust, alerts, gaps };
}

// ═══════════════════════════════════════════════════════════════════
// OUTPUT: SYNTHESIS BRIEF + RAW RESPONSES
// ═══════════════════════════════════════════════════════════════════

function printStructuredOutput(dag, results, arb, totalMs) {
  const nodes = dag.nodes;

  // ── Synthesis Brief ──
  const lines = [];
  lines.push("═".repeat(60));
  lines.push("SYNTHESIS BRIEF");
  lines.push("═".repeat(60));

  // Trust table
  lines.push("\nTRUST:");
  for (const node of nodes) {
    const t = arb.trust[node.id];
    const label = { FULL: "✓", DEGRADED: "⚠", MISSING: "✗" }[t.tier] || "?";
    const extras = t.tier === "DEGRADED" ? ` (${t.reason}${t.intended ? ", intended="+t.intended : ""})` : "";
    lines.push(`  ${label} ${node.id} [${node.role}]: ${t.tier} → ${t.provider || "NONE"}${extras}`);
  }

  // Reviewer Alerts
  if (arb.alerts.length > 0) {
    lines.push("\nREVIEWER ALERTS:");
    for (const a of arb.alerts) {
      lines.push(`  ⚡ 指向 ${a.targets.join(" + ")} | ${a.sentence}`);
    }
  } else {
    lines.push("\nREVIEWER ALERTS: (none)");
  }

  // Synthesis Gaps
  if (arb.gaps.length > 0) {
    lines.push("\nSYNTHESIS GAPS:");
    for (const g of arb.gaps) {
      lines.push(`  ◇ [${g.from}] ${g.type}: ${g.detail}`);
    }
  } else {
    lines.push("\nSYNTHESIS GAPS: (none — builder 完整覆盖)");
  }

  // Strategy
  const degraded = nodes.filter(n => arb.trust[n.id].tier === "DEGRADED");
  const missing  = nodes.filter(n => arb.trust[n.id].tier === "MISSING");
  const stratParts = [];
  if (arb.alerts.length > 0) stratParts.push(`${arb.alerts.length} 项审阅者质疑需核实`);
  if (arb.gaps.length > 0) stratParts.push(`${arb.gaps.length} 处综合报告缺口需补充`);
  if (degraded.length > 0) stratParts.push(`${degraded.length} 个角色降级，其输出交叉验证后使用`);
  if (missing.length > 0) stratParts.push(`${missing.length} 个角色缺失，需自行补充该角度`);
  if (stratParts.length === 0) stratParts.push("所有角色无降级，综合报告完整，可直接引用");
  lines.push(`\nSTRATEGY: ${stratParts.join("；")}。`);

  console.log(`\n${lines.join("\n")}`);
  console.log(`\nTotal time: ${(totalMs / 1000).toFixed(1)}s\n`);

  // ── Raw responses ──
  for (const node of nodes) {
    const r = results[node.id];
    if (r?.output?.response) {
      console.log(`\n══════ ${node.id} (${node.role}) — ${r.output.provider_used} ══════`);
      console.log(r.output.response);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════

async function main() {
  const args = process.argv.slice(2);
  let timeout = 600_000, prompt = "", smoke = false, doctor = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--timeout=")) {
      timeout = parseInt(args[i].split("=")[1], 10);
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--smoke") smoke = true;
    else if (args[i] === "--doctor") doctor = true;
    // --keep-tabs is always-on (no longer configurable — we never close user's Chrome).
    // It must still be recognized and swallowed here, otherwise it falls into the
    // `else` branch below and gets concatenated into `prompt`, corrupting the
    // pre-decomposed JSON plan (see SKILL.md's `--keep-tabs '<DAG_JSON_STRING>'`
    // invocation) and breaking tryParsePreDecomposedPlan()'s JSON.parse.
    else if (args[i] === "--keep-tabs") { /* no-op — always on */ }
    else prompt += args[i] + " ";
  }
  prompt = prompt.trim();
  if (!prompt && !smoke && !doctor && !process.stdin.isTTY) {
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    prompt = Buffer.concat(chunks).toString().trim();
  }

  if (doctor) {
    if (fs.existsSync(WEBEXT)) {
      log(`✓ WebExtended found at: ${WEBEXT}`);
      process.exit(0);
    } else {
      log(`✗ WebExtended NOT found at: ${WEBEXT}`);
      process.exit(1);
    }
  }

  if (!prompt && !smoke) {
    log("Usage: node index.js [--timeout=N] [--smoke] [--doctor] <prompt>");
    process.exit(1);
  }

  // UNIT FIX: timeouts are milliseconds, but SKILL.md examples were written in
  // seconds (--timeout=900 → 900ms → M1 got a 270ms budget and always failed).
  // Normalize implausibly small values instead of silently starving the run.
  if (timeout > 0 && timeout < 10_000) {
    log(`WARN: --timeout=${timeout} interpreted as ${timeout}s (${timeout * 1000}ms). Timeouts are in milliseconds.`);
    timeout *= 1000;
  }

  // Verify WebExtended exists
  if (!fs.existsSync(WEBEXT)) {
    log(`FATAL: AgentChat-WebExtended not found at: ${WEBEXT}`);
    log("  This skill depends on AgentChat-WebExtended for provider implementations.");
    process.exit(1);
  }

  const T0 = Date.now();

  if (smoke) {
    log("Smoke test: checking all providers via WebExtended...");
    const testedLocks = [];
    for (const key of FALLBACK_CHAIN) {
      // Skip if already locked (provider in use by another worker / already tested)
      if (!acquireLock(key)) {
        log(`  ${key}: ⏭ locked (provider in use)`);
        continue;
      }
      testedLocks.push(key);
      const result = await callProvider("Respond with just the word OK.", key, 120000);
      log(`  ${key}: ${result.ok ? `✓ (${result.text.length} chars)` : `✗ ${result.reason}`}`);
      // Release lock on failure — keep on success so concurrent workers skip it
      if (!result.ok) { releaseLock(key); testedLocks.pop(); }
    }
    // Release any remaining locks after test completes
    for (const k of testedLocks) releaseLock(k);
    process.exit(0);
  }

  // M1: Build DAG
  const dag = await buildDAG(prompt, Math.floor(timeout * 0.3));
  log(`  DAG: ${dag.nodes.map(n => `${n.id}(${n.ai}/${n.role})`).join(" → ")}`);

  // M2: Parallel dispatch
  // BUDGET FIX: M2 now gets 85% of the time ACTUALLY remaining after M1
  // (with a floor so workers are never starved), instead of a fixed 0.55×
  // slice that ignored any M1 overrun.
  const m2Budget = Math.max(120_000, Math.floor((timeout - (Date.now() - T0)) * 0.85));
  const results = await dispatchParallel(dag, m2Budget);

  // M3: Arbitrate
  const arbitration = arbitrateResults(dag, results);

  // Output
  printStructuredOutput(dag, results, arbitration, Date.now() - T0);

  const failCount = Object.values(results).filter(r => !r?.output?.response).length;
  process.exit(failCount === dag.nodes.length ? 2 : 0);
}

// BUGFIX: previously called main() unconditionally, so simply require()'ing this
// file (e.g. from a test, or another script re-using FALLBACK_CHAIN/normalizeAI)
// would immediately run the CLI: parse process.argv, block on stdin if no prompt
// was given, spawn subprocesses, and eventually call process.exit(). Guarded to
// match AgentChat-WebExtended/index.js's existing require.main === module pattern.
if (require.main === module) {
    main().catch(e => { log(`CRITICAL: ${e.message}`); process.exit(4); });
}

module.exports = { FALLBACK_CHAIN, buildFallbackChain, normalizeAI, cleanResponse };
