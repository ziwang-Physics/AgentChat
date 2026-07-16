#!/usr/bin/env node
/**
 * Parallel AI Decompose v3 — Thin Orchestrator over AgentChat-OneWeb
 *
 * Core principles:
 *   1. DAG first, parallelism second (respect dependencies)
 *   2. Complementary roles (no overlapping responsibilities)
 *   3. Structured I/O with quality gates
 *   4. Evidence-based arbitration (not majority vote)
 *   5. Explicit degradation (never silent failure)
 *   6. Single provider source: AgentChat-OneWeb (no code duplication)
 *
 * Three modules:
 *   M1: Task DAG — decompose task into complementary sub-prompts
 *   M2: Wave Dispatch — topological layers (depends_on honored); nodes within a
 *       wave run as parallel subprocesses → AgentChat-OneWeb, downstream
 *       prompts receive upstream outputs ({{dep_id}} substitution or appendix)
 *   M3: Evidence Arbitrator — evidence-weighted synthesis + degradation report
 *
 * Provider subprocess plumbing lives in lib/execute.js (shared with
 * AgentChat-WebSubAgent); prompts travel over stdin, never argv.
 */

const path = require("path");
const fs = require("fs");

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
const { acquireLock, releaseLock, cleanupAllLocks } = require('../lib/locks');
const { makeRunId, emitReceipt } = require('../lib/receipt');
process.on("exit", cleanupAllLocks);
process.on("SIGINT", () => { cleanupAllLocks(); process.exit(130); });
process.on("SIGTERM", () => { cleanupAllLocks(); process.exit(143); });

const WEBEXT = path.resolve(__dirname, "..", "AgentChat-OneWeb", "index.js");
// Single source of truth: lib/providers/chain.js (shared with OneWeb).
// Previously this required OneWeb's index.js just to read a constant,
// dragging in playwright-core + all 8 adapter modules at orchestrator startup.
const { PROVIDER_CHAIN } = require('../lib/providers/chain');
const FALLBACK_CHAIN = PROVIDER_CHAIN.map(p => p.key);

function buildFallbackChain(primaryKey, skipList = []) {
    const skipSet = new Set([primaryKey, ...skipList]);
    const rest = FALLBACK_CHAIN.filter(k => !skipSet.has(k));
    return [primaryKey, ...rest];
}

const STAGGER_MS = 1500; // inter-worker launch delay

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════

const { log: _log } = require('../lib/terminal');
const log = (msg) => _log('orch', msg);
function ts() { return new Date().toISOString().slice(11, 19); }

// ═══════════════════════════════════════════════════════════════════
// PROVIDER CALL — shared executor (lib/execute.js)
// ═══════════════════════════════════════════════════════════════════
// callProvider/runChain/cleanResponse previously lived here as a near-copy of
// AgentChat-WebSubAgent's versions and had already drifted (exit-code labels,
// MIN_CALL_BUDGET). Now a single implementation, parameterized:
//   holdLockOnSuccess: true — a successful provider stays locked so other
//     workers IN THE SAME WAVE skip it (tab-collision protection). Locks are
//     released at wave boundaries by dispatchWaves(), and on process exit.
//   acceptUsedMarker: true — tolerate the stdout/close delivery race by
//     trusting OneWeb's "✓ X: USED (N chars" stderr marker.
// Prompt delivery is now stdin (was argv): required for wave execution, which
// injects upstream outputs into downstream prompts — argv would hit Windows'
// ~32KB command-line limit and leak prompts via `ps`.

const { createExecutor } = require('../lib/execute');
const { callProvider, runChain, cleanResponse } = createExecutor({
    webextPath: WEBEXT,
    logPrefix: 'orch',
    minCallBudgetMs: 30_000,
    holdLockOnSuccess: true,
    acceptUsedMarker: true,
});

/** Fallback executor keyed by intended primary — thin wrapper over runChain. */
async function executeWithFallback(primaryKey, prompt, budgetMs, skipList = []) {
    return runChain(buildFallbackChain(primaryKey, skipList), prompt, budgetMs);
}

// ═══════════════════════════════════════════════════════════════════
// MODULE 1: TASK DAG
// ═══════════════════════════════════════════════════════════════════

function normalizeAI(name) {
  const n = (name || "").toLowerCase().trim();
  const map = { gpt: "chatgpt", chatgpt: "chatgpt", gemini: "gemini", kimi: "kimi", qwen: "qwen", claude: "claude", minimax: "minimax", deepseek: "deepseek", mimo: "mimo" };
  const key = map[n] || n;
  // ROBUSTNESS: a decomposer DAG (produced by an external AI) can name an AI
  // that isn't in our provider set — e.g. "grok", "llama", a typo, or "".
  // Previously such a key flowed straight through: acquireLock("grok") always
  // "succeeds" (it's an unused name), then callProvider sends --only=grok to
  // OneWeb, which USED to silently run Gemini — so this worker held a lock
  // on "grok" while consuming Gemini, colliding with the real Gemini worker.
  // Now OneWeb rejects unknown --only, but we still shouldn't waste a
  // subprocess round-trip on a doomed key: coerce anything unknown to the head
  // of the chain so the worker at least runs a real, lockable provider.
  if (!FALLBACK_CHAIN.includes(key)) {
    log(`WARN: unknown AI "${name}" in DAG node — coercing to "${FALLBACK_CHAIN[0]}"`);
    return FALLBACK_CHAIN[0];
  }
  return key;
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

function qualityGate(result) {
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

async function runOneWorker(node, budgetMs, skipList = [], prompt = node.prompt) {
  const primaryKey = normalizeAI(node.ai);

  try {
    const result = await executeWithFallback(primaryKey, prompt, budgetMs, skipList);
    const qr = qualityGate(result);
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

// ── Wave scheduling — Kahn topological layering ──
//
// P0 FIX: dispatchParallel() launched ALL nodes concurrently with a stagger and
// never read depends_on — it was parsed by tryParsePreDecomposedPlan() and then
// ignored. A node with depends_on:["research"] whose prompt said "基于上述资料"
// ran simultaneously with `research` and received nothing: the silent-wrong-
// answer class. Nodes are now grouped into topological waves; each wave runs in
// parallel, and downstream prompts receive upstream outputs before dispatch.

const MAX_INJECT_CHARS_PER_DEP = 12_000; // web UIs have paste/input limits

function topoWaves(nodes) {
  const ids = new Set(nodes.map(n => n.id));
  for (const n of nodes) {
    for (const d of (n.depends_on || [])) {
      if (!ids.has(d)) log(`  WARN: node "${n.id}" depends on unknown node "${d}" — ignoring that edge`);
    }
  }
  const done = new Set();
  const waves = [];
  let rest = [...nodes];
  while (rest.length > 0) {
    const wave = rest.filter(n => (n.depends_on || []).every(d => done.has(d) || !ids.has(d)));
    if (wave.length === 0) {
      // Cycle: can't order them — run the remainder as one final parallel wave.
      // injectUpstream() will mark their intra-cycle deps as missing.
      log(`  WARN: dependency cycle among [${rest.map(n => n.id).join(", ")}] — running them as one final wave`);
      waves.push(rest);
      break;
    }
    waves.push(wave);
    for (const n of wave) done.add(n.id);
    rest = rest.filter(n => !done.has(n.id));
  }
  return waves;
}

/**
 * Materialize a node's prompt with its dependencies' outputs.
 * - `{{dep_id}}` placeholders are substituted in place;
 * - deps without a placeholder are appended as a labelled appendix;
 * - failed/absent upstream output becomes an explicit note (the worker is told
 *   the input is missing rather than silently reasoning over nothing).
 */
function injectUpstream(node, results) {
  const deps = node.depends_on || [];
  if (deps.length === 0) return node.prompt;

  let prompt = node.prompt;
  const appendix = [];
  for (const dep of deps) {
    let out = results[dep]?.output?.response || null;
    if (out && out.length > MAX_INJECT_CHARS_PER_DEP) {
      out = out.slice(0, MAX_INJECT_CHARS_PER_DEP) + "\n…（上游输出过长，已截断）";
    }
    const marker = `{{${dep}}}`;
    const role = results[dep]?.node?.role || "";

    if (out) {
      if (prompt.includes(marker)) prompt = prompt.split(marker).join(out);
      else appendix.push(`【上游 ${dep}${role ? ` / ${role}` : ""} 的输出】\n${out}`);
    } else {
      log(`  [${node.id}] WARN: dependency "${dep}" has no output — injecting failure note`);
      const note = `（上游 ${dep} 未产出结果 — 请基于任务本身独立完成，并在回答中注明该输入缺失）`;
      if (prompt.includes(marker)) prompt = prompt.split(marker).join(note);
      else appendix.push(`【上游 ${dep}】${note}`);
    }
  }
  if (appendix.length > 0) {
    prompt += `\n\n═══════ 上游任务输出（供参考，请综合利用） ═══════\n\n${appendix.join("\n\n")}`;
  }
  return prompt;
}

async function dispatchWaves(dag, budgetMs) {
  const nodes = dag.nodes;
  const waves = topoWaves(nodes);
  log(`━━━ Module 2: Wave Dispatch — ${nodes.length} workers / ${waves.length} wave(s) ━━━`);
  waves.forEach((w, i) => log(`  Wave ${i + 1}: ${w.map(n => `${n.id}→${n.ai}(${n.role})`).join(" | ")}`));

  // BUDGET FIX: the floor used to be Math.max(nodes.length * 60000, ...) — it
  // GREW with node count, so a 4-node DAG got ≥240s regardless of --timeout,
  // silently violating the user's contract. The floor is now a 60s constant.
  if (budgetMs < 60_000) log(`  WARN: M2 budget ${Math.round(budgetMs / 1000)}s below 60s floor — raising to 60s`);
  const deadline = Date.now() + Math.max(60_000, budgetMs);

  const results = {};

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    const remaining = deadline - Date.now();

    if (remaining < 30_000) {
      const skipped = waves.slice(w).flat();
      log(`  Wave ${w + 1}: budget exhausted (${Math.round(remaining / 1000)}s left) — skipping ${skipped.length} node(s)`);
      for (const node of skipped) {
        results[node.id] = {
          output: {
            provider_used: null, primary_intended: normalizeAI(node.ai), response: null,
            error: "budget_exhausted_before_dispatch",
            degradation: { reason: "BUDGET_EXHAUSTED", confidence_adjustment: -1.0 },
          },
          quality: { passed: false, issues: ["BUDGET_EXHAUSTED"], quality_score: 0 },
          node,
        };
      }
      break;
    }

    // Even split of the remaining wall clock across remaining waves — a wave
    // finishing early donates its leftovers to the next iteration's `remaining`.
    const wavesLeft = waves.length - w;
    const waveBudget = Math.min(remaining, Math.max(60_000, Math.floor(remaining / wavesLeft)));
    // Provider contention only exists WITHIN a wave — skip lists no longer span
    // the whole DAG, so fallback chains are less constrained than before.
    const primaries = [...new Set(wave.map(n => normalizeAI(n.ai)))];
    log(`  Wave ${w + 1}/${waves.length}: ${wave.length} worker(s), budget ${Math.round(waveBudget / 1000)}s`);

    const tasks = wave.map((node, i) => {
      const delay = i * STAGGER_MS;
      const myPrimary = normalizeAI(node.ai);
      const skipList = primaries.filter(p => p !== myPrimary);
      const prompt = injectUpstream(node, results); // upstream outputs from prior waves
      const workerBudget = Math.max(30_000, waveBudget - delay);
      return new Promise(resolve => setTimeout(async () => {
        resolve(await runOneWorker(node, workerBudget, skipList, prompt));
      }, delay));
    });

    // Promise.allSettled — never fails if a single worker throws unexpectedly
    const settled = await Promise.allSettled(tasks);
    for (const s of settled) {
      if (s.status === "rejected") {
        log(`  Worker promise rejected: ${String(s.reason).slice(0, 60)}`);
        continue;
      }
      if (s.value) results[s.value.nodeId] = { output: s.value.output, quality: s.value.quality, node: s.value.node };
    }

    // Wave boundary: release locks held on success. holdLockOnSuccess protects
    // in-flight workers of THIS wave from tab collisions; across waves the
    // provider is idle again — keeping the lock would force needless degradation
    // whenever a later wave's primary was already used in an earlier one.
    cleanupAllLocks();
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
  // P1-15: chemical formulas — require at least one lowercase letter OR a
  // digit/parenthesis to avoid matching all-caps English words (JSON, USA, AI,
  // THE, etc.). Still catches real formulas: Ag, HCl, H₂O, Cu(111), Fe2O3.
  for (const m of text.matchAll(/\b(?:[A-Z][a-z]?(?:\d+)?(?:\([^)]*\))?){1,4}\b/g)) {
    const t = m[0].trim();
    const hasLower = /[a-z]/.test(t);
    const hasNumOrParen = /[\d()]/.test(t);
    const isSingleUpper = /^[A-Z]$/.test(t);
    if (t.length >= 2 && (hasLower || hasNumOrParen) && !isSingleUpper &&
        !/^(The|This|In|On|We|It|Is|No|To|He|She|They|For|And|But|Or|A|An)$/i.test(t)) {
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

  // Resolve role texts (role name → actual response).
  // Two nodes with the same role were previously overwritten — the first node's
  // output silently vanished from arbitration. Collect all responses per role.
  const roleText = {};
  for (const node of nodes) {
    const r = results[node.id];
    if (r?.output?.response) {
      roleText[node.role] = (roleText[node.role] || []).concat(r.output.response);
    }
  }
  // Flatten: reviewer alerts downstream expect strings, so join multi-response roles.
  for (const [role, texts] of Object.entries(roleText)) {
    if (Array.isArray(texts) && texts.length > 1) {
      roleText[role] = texts.join("\n---\n");
    } else if (Array.isArray(texts)) {
      roleText[role] = texts[0];
    }
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

  // Runtime reinforcement of SKILL.md《输出排版规范》— re-enters the upper
  // agent's context at result time, guarding against instruction decay in
  // long sessions (same rationale as the [receipt] enforcement line).
  lines.push(`\nFORMAT: 最终回答遵循 SKILL.md《输出排版规范》— 结论先行(≤50字)、\`##\` 分块(3–5维度)、单层列表、叙述段≤3句、引用入 \`>\` 块、receipt 原样保留。`);

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
      log(`✓ OneWeb found at: ${WEBEXT}`);
      process.exit(0);
    } else {
      log(`✗ OneWeb NOT found at: ${WEBEXT}`);
      process.exit(1);
    }
  }

  if (!prompt && !smoke) {
    log("Usage: node index.js [--timeout=N] [--smoke] [--doctor] <prompt>");
    process.exit(1);
  }

  // NaN GUARD: `--timeout=abc` / `--timeout==900000` parse to NaN, which every
  // comparison below silently passes (NaN < x is false), so NaN used to flow
  // into ALL budget math — deadlines, wave splits, and finally the executor's
  // setTimeout(NaN + 30000), which Node coerces to a 1ms delay: every
  // subprocess got SIGTERM'd ~1ms after spawn and the whole run collapsed into
  // a wall of inscrutable killed_SIGTERM failures. Fail back to the default.
  if (!Number.isFinite(timeout) || timeout <= 0) {
    log(`WARN: invalid --timeout value — falling back to default 600000ms (10 min)`);
    timeout = 600_000;
  }

  // UNIT FIX: timeouts are milliseconds, but SKILL.md examples were written in
  // seconds (--timeout=900 → 900ms → M1 got a 270ms budget and always failed).
  // Normalize implausibly small values instead of silently starving the run.
  if (timeout > 0 && timeout < 10_000) {
    log(`WARN: --timeout=${timeout} interpreted as ${timeout}s (${timeout * 1000}ms). Timeouts are in milliseconds.`);
    timeout *= 1000;
  }

  // Verify OneWeb exists
  if (!fs.existsSync(WEBEXT)) {
    log(`FATAL: AgentChat-OneWeb not found at: ${WEBEXT}`);
    log("  This skill depends on AgentChat-OneWeb for provider implementations.");
    process.exit(1);
  }

  const T0 = Date.now();
  const RUN_ID = makeRunId(); // execution receipt id (see lib/receipt.js)

  if (smoke) {
    log("Smoke test: checking all providers via OneWeb...");
    const testedLocks = [];
    for (const key of FALLBACK_CHAIN) {
      // Skip if already locked (provider in use by another worker / already tested)
      if (!acquireLock(key)) {
        log(`  ${key}: ⏭ locked (provider in use)`);
        continue;
      }
      testedLocks.push(key);
      // P0-5: "OK" (2 chars) fails minResponseLength (5-10) in most adapters.
      // Use a fixed phrase ≥10 chars so smoke tests don't systematically false-fail.
      const result = await callProvider("Respond with exactly: Hello World", key, 120000);
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

  // M2: Wave dispatch (topological layers, depends_on now honored)
  // M2 gets 85% of the time ACTUALLY remaining after M1. Floor is a 60s
  // CONSTANT — the old 120s floor (and dispatchParallel's nodes×60s floor)
  // could silently exceed the user's --timeout.
  const m2Budget = Math.max(60_000, Math.floor((timeout - (Date.now() - T0)) * 0.85));
  const results = await dispatchWaves(dag, m2Budget);

  // M3: Arbitrate
  const arbitration = arbitrateResults(dag, results);

  // Output
  printStructuredOutput(dag, results, arbitration, Date.now() - T0);

  const failCount = Object.values(results).filter(r => !r?.output?.response).length;
  const exitCode = failCount === dag.nodes.length ? 2 : 0;

  // Execution receipt — appended to STDOUT (this file's stdout is an
  // agent-readable report, not a machine contract). The calling agent must
  // quote this line in its final answer as proof of execution; the random
  // run_id is also persisted to data/receipts.jsonl for user-side grep
  // verification. Emitted for failure runs too (exit=2): "executed but all
  // workers failed" must be reported with evidence, never silently replaced
  // by the agent's own answer.
  emitReceipt({
    skillDir: __dirname,
    skill: 'AgentChat-IndependentTasks',
    runId: RUN_ID,
    fields: {
      exit: exitCode,
      nodes: dag.nodes.length,
      failed: failCount,
      providers_used: Object.fromEntries(
        Object.entries(results).map(([id, r]) => [id, r?.output?.provider_used || null])
      ),
      total_ms: Date.now() - T0,
    },
    stream: 'stdout',
  });

  // P0 FLUSH FIX: process.exit() right after console.log() truncates piped
  // stdout at the pipe-buffer boundary (~128KB Linux, less on Windows) — the
  // SYNTHESIS BRIEF + raw responses easily exceed that when Claude Code
  // captures this process's output. Every handle is closed by now (children
  // reaped, executor timers cleared), so setting exitCode and returning lets
  // Node drain stdout completely and exit naturally. The process.on("exit")
  // cleanupAllLocks handler still fires.
  process.exitCode = exitCode;
}

// BUGFIX: previously called main() unconditionally, so simply require()'ing this
// file (e.g. from a test, or another script re-using FALLBACK_CHAIN/normalizeAI)
// would immediately run the CLI: parse process.argv, block on stdin if no prompt
// was given, spawn subprocesses, and eventually call process.exit(). Guarded to
// match AgentChat-OneWeb/index.js's existing require.main === module pattern.
if (require.main === module) {
    main().catch(e => { log(`CRITICAL: ${e.message}`); process.exit(4); });
}

module.exports = { FALLBACK_CHAIN, buildFallbackChain, normalizeAI, cleanResponse, topoWaves, injectUpstream };
