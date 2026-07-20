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
// GUARD: ../lib is a sibling tree shared by all AgentChat skills.
// Copying ONLY this skill directory to ~/.claude/skills/ loses it —
// every ../lib require would throw a bare MODULE_NOT_FOUND stack.
// Mirror of the v14 guard in AgentChat-OneWeb/index.js.
// ═══════════════════════════════════════════════════════════════════
let acquireLock, releaseLock, cleanupAllLocks, makeRunId, emitReceipt;
try {
    ({ acquireLock, releaseLock, cleanupAllLocks } = require('../lib/locks'));
    ({ makeRunId, emitReceipt } = require('../lib/receipt'));
} catch (e) {
    if (e.code === 'MODULE_NOT_FOUND') {
        process.stderr.write(
            '[orch] FATAL: ../lib not found — this skill requires the sibling skills/lib/ tree.\n' +
            `[orch]   fix: cp -r ${path.resolve(__dirname, '..', 'lib')} ${path.resolve(__dirname, 'lib')}\n` +
            '[orch]   (or clone the full AgentChat repo instead of copying a single skill directory)\n');
        process.exit(4);
    }
    throw e;
}

// ═══════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════
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

const STAGGER_MS = 200; // inter-worker launch delay

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════

const { log: _log } = require('../lib/terminal');
const log = (msg) => _log('orch', msg);

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
const { callProvider: _defaultCallProvider, runChain: _defaultRunChain, cleanResponse } = createExecutor({
    webextPath: WEBEXT,
    logPrefix: 'orch',
    minCallBudgetMs: 30_000,
    holdLockOnSuccess: true,
    acceptUsedMarker: true,
});

// v24 P1: perCallCapMs is parsed from CLI inside main(). The top-level executor
// uses the 180s default; if --per-call is given, main() replaces these with a
// re-created executor that carries the user's perCallCapMs. This two-phase init
// avoids restructuring every function signature that closes over callProvider/runChain.
let callProvider = _defaultCallProvider;
let runChain = _defaultRunChain;

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
const { expandSharedPlan } = require('../lib/plan');

function tryParsePreDecomposedPlan(userTask) {
  // Detect if input is already a pre-decomposed JSON plan with "subtasks" array
  // (as produced by Claude Code's Step 2). If so, extract nodes directly — no re-decomposition.
  try {
    const json = JSON.parse(userTask);
    if (json.subtasks && Array.isArray(json.subtasks) && json.subtasks.length >= 1) {
      // v21 GUARD: duplicate subtask ids silently overwrite each other in the
      // `results[id]` map — one whole group's answer vanishes without any error
      // (observed: two subtasks both named group_solvent_dielectric). A malformed
      // plan must ABORT, not fall through to the NL decomposer (which would treat
      // the JSON string as a task description).
      const seen = new Set();
      for (const st of json.subtasks) {
        const id = st.id || "";
        if (seen.has(id)) {
          const err = new Error(`plan invalid: duplicate subtask id "${id}" — later entries overwrite earlier results silently. Fix the plan (run validate_answers.js --lint).`);
          err.agentchatPlanError = true;
          throw err;
        }
        seen.add(id);
      }
      // v21: top-level "exclude" — providers the USER forbade (e.g. "除了 Claude").
      // Honored by every fallback chain in dispatchWaves; without this the chain
      // Gemini→ChatGPT→Claude→… routed user content to an excluded provider.
      //
      // v24 P1 FIX: normalizeAI coerces unknown keys to FALLBACK_CHAIN[0] (gemini)
      // — "exclude":["grok"] would silently exclude the chain head. Use a strict
      // alias-only mapping here: known aliases → canonical key, unknown → WARN +
      // discard. NEVER coerce an unknown exclude entry to a real provider.
      const exclude = Array.isArray(json.exclude)
        ? [...new Set(json.exclude.map(name => {
            const n = (name || "").toLowerCase().trim();
            const aliasMap = { gpt:"chatgpt", chatgpt:"chatgpt", gemini:"gemini", kimi:"kimi",
              qwen:"qwen", claude:"claude", minimax:"minimax", deepseek:"deepseek", mimo:"mimo" };
            const known = aliasMap[n];
            if (known) return known;
            log(`WARN: unknown provider "${name}" in plan exclude list — discarded (valid: ${FALLBACK_CHAIN.join(", ")})`);
            return null;
          }).filter(Boolean))]
        : [];
      const nodes = json.subtasks.map(st => ({
        id: st.id || st.role || `task_${Math.random().toString(36).slice(2,6)}`,
        ai: st.primary || "gemini",
        role: st.role || "worker",
        goal: st.id || "task",
        depends_on: st.depends_on || [],
        prompt: st.prompt || "",
        questions: st.questions || [],   // v24: for in-loop anchor compliance check (qualityGate)
      }));
      // Validate all nodes have non-empty prompts
      if (nodes.every(n => n.prompt && n.prompt.length > 5)) {
        if (exclude.length) log(`  Plan exclude list: [${exclude.join(", ")}] — these providers will never be dispatched to (primary or fallback)`);
        return { nodes, exclude, pre_decomposed: true };
      }
    }
  } catch (e) {
    if (e && e.agentchatPlanError) throw e; // structural plan errors abort the run — never fall through to the decomposer
    /* not JSON, proceed to decomposition */
  }
  return null;
}

// v24 P1: validate a DAG object (from AI decomposer or pre-decomposed plan).
// Checks: minimum nodes, non-empty prompts, no duplicate IDs, known ai values.
// Returns { valid: bool, error: string }. Caller decides abort-vs-retry policy.
function validateDAGNodes(nodes) {
  if (!Array.isArray(nodes) || nodes.length < 2)
    return { valid: false, error: `DAG requires ≥2 nodes, got ${nodes?.length || 0}` };
  const seen = new Set();
  for (const n of nodes) {
    if (!n.prompt || String(n.prompt).length <= 5)
      return { valid: false, error: `node "${n.id || "?"}" has empty or too-short prompt` };
    const id = n.id || "";
    if (seen.has(id))
      return { valid: false, error: `duplicate node id "${id}" — later entry silently overwrites earlier results` };
    seen.add(id);
    // ai field: normalize/validate — unknown will be caught by normalizeAI's
    // WARN + coerce-to-head at dispatch time, but flag it early here so a
    // decomposer producing nonsense keys (grok, llama, "") can be retried.
    const ai = (n.ai || "").toLowerCase().trim();
    if (!ai) return { valid: false, error: `node "${id}" has empty ai field` };
  }
  return { valid: true, error: null };
}

async function buildDAG(userTask, budgetMs, opts = {}) {
  log("━━━ Module 1: Task DAG Construction ━━━");

  // P1: Detect pre-decomposed JSON plan — skip re-decomposition entirely
  const preDecomposed = tryParsePreDecomposedPlan(userTask);
  if (preDecomposed) {
    log(`  Task: pre-decomposed JSON with ${preDecomposed.nodes.length} subtasks — skipping decomposition`);
    log(`  Nodes: ${preDecomposed.nodes.map(n => `${n.id}→${n.ai}(${n.role})`).join(" | ")}`);
    return preDecomposed;
  }

  // v24 P1: STRICT PLAN GUARD. When --plan is used the user expects the file
  // to be a valid pre-decomposed plan. JSON parse failure, missing subtasks,
  // or any structural defect → exit 64 immediately. Never fall through to the
  // NL decomposer (which would treat the mangled JSON as a task description)
  // and DEFINITELY never hit the hardcoded 4-role DAG fallback — both paths
  // violate SKILL.md rule #1 (no role-based decomposition for independent tasks).
  if (opts.strictPlan) {
    log("FATAL: --plan file is not a valid pre-decomposed JSON plan.");
    log("  Fix: run validate_answers.js --lint to check plan structure, or");
    log("  provide a JSON with {\"subtasks\":[...]} (see SKILL.md A.5 for the schema).");
    process.exit(64); // EX_USAGE
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
      // v24 P1: validate AI decomposer output just like pre-decomposed plans.
      // Without this, duplicate IDs silently overwrite results; empty prompts
      // waste subprocess rounds; unknown ai keys flow into normalizeAI's
      // coerce-to-head (same bug class as the exclude coerce fix).
      const v = validateDAGNodes(dag.dag?.nodes || []);
      if (!v.valid) { log(`  Decomposer: ${key} DAG invalid — ${v.error}`); continue; }
      log(`  Decomposer: ✓ ${key} produced ${dag.dag.nodes.length}-node DAG`);
      return dag.dag;
    } catch (e) {
      log(`  Decomposer: parse error: ${String(e).slice(0, 60)}`);
    }
  }

  // v24 P1: STRICT PLAN GUARD — the hardcoded 4-role DAG (researcher/reasoner/
  // builder/reviewer) is a collaborative-role decomposition, NOT an independent-
  // task decomposition. Using it for this skill violates SKILL.md rule #1. When
  // --plan is explicit, we already exited above. For the NL path, the decomposer
  // failing means we genuinely cannot decompose — don't silently substitute a
  // role-based DAG that produces un-anchored output (Step 2.5 will FAIL every
  // answer because 4-role prompts don't request [ANSWER] anchors).
  if (opts.strictPlan) {
    log("FATAL: all decomposer providers failed — cannot produce a valid independent-task DAG.");
    process.exit(64);
  }

  // Fallback: rule-based 4-way parallel (only when NOT in strict-plan mode).
  // This path is a last resort for ad-hoc NL prompts; it produces role-based
  // output without [ANSWER] anchors, so Step 2.5 will flag every answer as
  // MISSING_ANCHOR. Documented degradation, not a silent failure.
  log("  Decomposer: ALL failed, using rule-based 4-way parallel DAG");
  log("  WARN: 4-role DAG produces un-anchored output — Step 2.5 qualityGate will flag all answers");
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
// v25: SHARED PLAN EXPANSION — compress plan JSON by deduplicating
// background & format instructions across all subtask prompts.
//
// A plan with `shared` + `questionBank` is expanded into the full
// per-subtask prompt form before entering buildDAG. This saves ~3K
// context tokens per run (background & format boilerplate appear once,
// not N times).
// ═══════════════════════════════════════════════════════════════════

// Requirement templates — matched by question type (same as SKILL.md A.5)
// ═══════════════════════════════════════════════════════════════════
// MODULE 2: PARALLEL DISPATCH + QUALITY GATE
// ═══════════════════════════════════════════════════════════════════

/**
 * Quality gate with in-loop anchor compliance check (v24).
 *
 * Previously this only checked response length — a provider returning a valid-
 * looking answer that merely omitted the [ANSWER <ID>] anchor (ChatGPT's known
 * "helpful format stripping" behaviour) sailed through with score=1, and the
 * orchestrator never triggered fallback. The missing anchor was only caught
 * post-hoc by validate_answers.js, forcing a manual L1 re-dispatch.
 *
 * Now: when expectedQuestions is non-empty, every declared question ID MUST
 * have its [ANSWER <ID>] anchor present verbatim in the response. Missing
 * anchors → quality_score = 0.0 → runChain tries the next fallback provider
 * automatically within the SAME wave, without any L1 intervention.
 *
 * The check is deliberately lightweight (regex only, no LLM call) and
 * intentionally stricter than validate_answers.js (which also checks foreign
 * anchors and fabrication markers) — its job is to catch the common case
 * (missing anchor) inside the execution loop, not duplicate the full validator.
 */
// ── Lenient anchor matching (Postel's Law for LLM format compliance) ──
// LLMs rarely delete anchor lines entirely — they "beautify" them:
// bold (**[ANSWER X]**), headings (### [ANSWER X]), full-width brackets,
// trailing colons, leading text. Normalize first, then near-strict match.
function normalizeLine(line) {
  return line
    .normalize('NFKC')
    .replace(/[【〔]/g, '[').replace(/[】〕]/g, ']')
    .replace(/[*_`~]/g, '')
    .replace(/^[\s>#\-+.\d]*/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
}
function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
function idPattern(id) { return escapeRe(id).replace(/(\d)(?=[A-Z])/g, '$1[\\s\\-_]?'); }
function hasAnchorLenient(text, qid) {
  const lines = String(text || '').split(/\r?\n/);
  const re = new RegExp(`\\[\\s*ANSWER\\s*[:：]?\\s*${idPattern(qid)}\\s*\\]`, 'i');
  return lines.some(l => re.test(normalizeLine(l)));
}

function qualityGate(result, expectedQuestions = []) {
  const issues = [];
  if (!result.response || result.response.length < 10) {
    issues.push("EMPTY_OR_TOO_SHORT");
  }
  if (result.degradation) {
    issues.push(`DEGRADED: ${result.degradation.reason}`);
  }
  // v25: lenient anchor compliance — normalize before matching to catch
  // common LLM beautification mutations (bold, heading, full-width brackets,
  // trailing colons) without triggering unnecessary format-retries.
  if (expectedQuestions.length > 0 && result.response) {
    for (const qid of expectedQuestions) {
      if (!hasAnchorLenient(result.response, qid)) {
        issues.push(`MISSING_ANCHOR:${qid}`);
      }
    }
  }
  const hardFail = issues.some(i => !i.startsWith("DEGRADED"));
  const passed = !hardFail;
  return {
    passed,
    issues,
    quality_score: passed ? (result.degradation ? 0.6 : 1.0) : 0.0,
  };
}

/**
 * Run one worker with automatic anchor-format retry (v24).
 *
 * Previously a missing [ANSWER <ID>] anchor was only caught post-hoc by
 * validate_answers.js, forcing a manual L1 re-dispatch. Now: if qualityGate
 * detects MISSING_ANCHOR, we retry executeWithFallback once with a reinforced
 * prompt. Because holdLockOnSuccess keeps the first provider locked, the retry
 * naturally skips to the next provider in the fallback chain — no architectural
 * changes to runChain needed.
 *
 * Budget note: the retry reuses the original budget. In the worst case (P=U
 * zero-fallback, both attempts hit the same locked primary), this burns ~60s
 * (two minCallBudget cycles) before returning ALL_EXHAUSTED — acceptable
 * compared to the previous L1 overhead (full re-dispatch + re-validation).
 */
async function runOneWorker(node, budgetMs, skipList = [], prompt = node.prompt) {
  const primaryKey = normalizeAI(node.ai);
  const questions = node.questions || [];
  // Only retry when there are questions to validate anchors against.
  // No questions → old behaviour (single attempt, no anchor check).
  const maxAttempts = questions.length > 0 ? 2 : 1;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const result = await executeWithFallback(primaryKey, prompt, budgetMs, skipList);
      const qr = qualityGate(result, questions);
      const anchorIssues = qr.issues.filter(i => i.startsWith("MISSING_ANCHOR:"));

      // Return immediately if: anchor check passed, no questions to check,
      // or this was the last allowed attempt.
      if (anchorIssues.length === 0 || attempt >= maxAttempts - 1) {
        const degNote = result.degradation
          ? ` ⚠ ${result.provider_used} (intended ${primaryKey})`
          : ` ✓ ${result.provider_used}`;
        if (attempt > 0 && anchorIssues.length === 0) {
          log(`  [${node.id}] retry ✓ (attempt ${attempt + 1}) — anchor(s) recovered via ${result.provider_used}`);
        }
        log(`  [${node.id}]${degNote} score=${qr.quality_score}${qr.issues.length ? " issues:" + qr.issues.join(",") : ""}`);
        return { nodeId: node.id, output: result, quality: qr, node };
      }

      // Anchor(s) missing — retry once with reinforced format instruction.
      // The first provider's lock is held (holdLockOnSuccess), so
      // executeWithFallback will skip it and try the next in the chain.
      log(`  [${node.id}] anchor(s) missing: ${anchorIssues.join(",")} — retrying with format reinforcement (attempt ${attempt + 1}/${maxAttempts - 1})`);
      const anchorLines = questions.map(q => `[ANSWER ${q}]`).join("\n");
      prompt = `CRITICAL FORMAT CORRECTION — Your previous response was rejected because you omitted required anchor lines. You MUST output these exact lines as the VERY FIRST lines of your response (one per line, in order):\n${anchorLines}\n\nAfter the anchor lines, restate each task and provide your answer.\n\n${node.prompt}`;
    } catch (e) {
      log(`  [${node.id}] ✗ exception (attempt ${attempt + 1}): ${String(e).slice(0, 60)}`);
      return {
        nodeId: node.id,
        output: { provider_used: null, primary_intended: primaryKey, response: null, error: String(e), degradation: { reason: "EXCEPTION", confidence_adjustment: -1.0 } },
        quality: { passed: false, issues: ["EXCEPTION"], quality_score: 0 },
        node,
      };
    }
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
    // v21: plan-level `exclude` (user's "except X" constraint) is merged into
    // EVERY worker's skip list so no fallback chain can route to a forbidden
    // provider. The lint gate rejects primary∈exclude before dispatch; if a
    // plan slips through anyway we warn loudly rather than silently obeying
    // the primary over the user's exclusion.
    const planExclude = Array.isArray(dag.exclude) ? dag.exclude : [];
    const primaries = [...new Set(wave.map(n => normalizeAI(n.ai)))];

    // v24: P=U full-deployment zero-fallback guard.
    // When every available (non-excluded) provider is a primary in the same wave,
    // skipList filtering removes ALL other primaries from each worker's fallback
    // chain → each worker has [self] only → one format/transient failure = dead
    // worker. The old mitigation was "hope the caller reserved a spare" — now we
    // detect the condition and auto-enable multi-tab concurrency so fallback can
    // route through the same provider's second ephemeral-tab slot.
    const available = FALLBACK_CHAIN.filter(k => !planExclude.includes(k));
    if (primaries.length >= available.length && primaries.length > 1) {
      const currentMaxTabs = parseInt(process.env.AGENTCHAT_MAX_TABS_PER_PROVIDER || "1", 10);
      if (currentMaxTabs < 2) {
        log(`  WARN: all ${primaries.length}/${available.length} available providers are primaries — ` +
            `each worker has ZERO fallback (skipList covers entire provider set). ` +
            `Auto-enabling AGENTCHAT_MAX_TABS_PER_PROVIDER=2 (second-slot fallback). ` +
            `Consider reserving >=1 provider as hot-spare in future plans.`);
        process.env.AGENTCHAT_MAX_TABS_PER_PROVIDER = "2";
      } else {
        log(`  WARN: all ${primaries.length}/${available.length} available providers are primaries — ` +
            `multi-tab=${currentMaxTabs} mitigates but doesn't eliminate zero-fallback risk. ` +
            `Reserving >=1 provider as hot-spare is the stronger defence.`);
      }
    }

    for (const p of primaries) {
      if (planExclude.includes(p)) log(`  WARN: primary "${p}" is in the plan's exclude list — plan is self-contradictory (lint should have caught this); exclude does NOT strip an explicit primary`);
    }
    log(`  Wave ${w + 1}/${waves.length}: ${wave.length} worker(s), budget ${Math.round(waveBudget / 1000)}s`);

    const tasks = wave.map((node, i) => {
      const delay = i * STAGGER_MS;
      const myPrimary = normalizeAI(node.ai);
      const skipList = [...primaries.filter(p => p !== myPrimary), ...planExclude];
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
  let timeout = 600_000, perCallCapMs = null, prompt = "", smoke = false, doctor = false, planFile = null;
  let summaryOnly = false, rawOutFile = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--timeout=")) {
      timeout = parseInt(args[i].split("=")[1], 10);
    } else if (args[i] === "--timeout" && args[i + 1]) {
      timeout = parseInt(args[i + 1], 10);
      i++;
    // v24 P1: --per-call=N sets the ceiling for a SINGLE provider attempt.
    // Without this, perCallCapMs stays at the executor's 180s hard default
    // regardless of --timeout — a 900s timeout only buys more fallback
    // retries, not longer individual calls. Typical deep-thinking prompts on
    // a single provider need 5+ minutes; the 180s default systematically
    // kills them mid-response.
    } else if (args[i].startsWith("--per-call=")) {
      perCallCapMs = parseInt(args[i].split("=")[1], 10);
    } else if (args[i] === "--per-call" && args[i + 1]) {
      perCallCapMs = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === "--smoke") smoke = true;
    else if (args[i] === "--doctor") doctor = true;
    // v19 --plan: read the JSON plan from a FILE instead of argv. A 10KB+ plan
    // passed as "$(cat plan.json)" risks shell truncation / quote mangling —
    // one corrupted byte silently downgrades tryParsePreDecomposedPlan() to a
    // full AI re-decomposition of the (mangled) text.
    else if (args[i].startsWith("--plan=")) planFile = args[i].slice("--plan=".length);
    else if (args[i] === "--plan" && args[i + 1]) { planFile = args[i + 1]; i++; }
    // --keep-tabs is always-on (no longer configurable — we never close user's Chrome).
    // It must still be recognized and swallowed here, otherwise it falls into the
    // `else` branch below and gets concatenated into `prompt`, corrupting the
    // pre-decomposed JSON plan (see SKILL.md's `--keep-tabs '<DAG_JSON_STRING>'`
    // invocation) and breaking tryParsePreDecomposedPlan()'s JSON.parse.
    else if (args[i] === "--keep-tabs") { /* no-op — always on */ }
    // v25: --summary-only — terminal output = one-line JSON summary (saves ~5K
    // context tokens per run by not printing full raw responses to stdout).
    else if (args[i] === "--summary-only") summaryOnly = true;
    // v25: --raw-out=FILE — write the full raw responses to a file (replaces
    // the `| tee raw.txt` pattern). Required when --summary-only is used, but
    // also works standalone to avoid the tee round-trip.
    else if (args[i].startsWith("--raw-out=")) rawOutFile = args[i].slice("--raw-out=".length);
    else if (args[i] === "--raw-out" && args[i + 1]) { rawOutFile = args[i + 1]; i++; }
    else prompt += args[i] + " ";
  }
  prompt = prompt.trim();
  if (planFile) {
    // v20: an argv prompt AND --plan together is almost always a caller bug
    // (e.g. quoting slipped and half the JSON became positional args) — the
    // file wins, but say so instead of silently discarding the argv text.
    if (prompt) log(`WARN: both --plan and an argv prompt given — argv prompt (${prompt.length} chars) ignored, using ${planFile}`);
    try {
      prompt = fs.readFileSync(planFile, "utf8").trim();
      // v25: expand shared plan (no-op if no shared/questionBank fields)
      try {
        const planObj = JSON.parse(prompt);
        const expanded = expandSharedPlan(planObj);
        prompt = JSON.stringify(expanded);
      } catch (e) {
        if (e.message && e.message.includes("question") && e.message.includes("not found in plan.questionBank"))
          { log(`ERROR: ${e.message}`); process.exit(64); }
        // Not a shared plan or expansion not applicable — pass through as-is
      }
      log(`Plan loaded from ${planFile} (${prompt.length} chars)`);
    } catch (e) {
      log(`ERROR: cannot read --plan file "${planFile}": ${e.message}`);
      process.exit(64); // EX_USAGE — matches OneWeb's usage-error convention
    }
  }
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
    log("Usage: node index.js [--timeout=MS] [--plan=FILE] [--smoke] [--doctor] <prompt>   (或: node index.js < plan.json)");
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
  // (timeout > 0 is guaranteed by the NaN guard above.)
  if (timeout < 10_000) {
    log(`WARN: --timeout=${timeout} interpreted as ${timeout}s (${timeout * 1000}ms). Timeouts are in milliseconds.`);
    timeout *= 1000;
  }

  // v24 P1: --per-call validation and executor re-init.
  // The top-level createExecutor uses the 180s default. When --per-call is given,
  // re-create the executor so perCallCapMs flows into callProvider → OneWeb
  // --timeout-per-provider, raising the ceiling for single attempts.
  if (perCallCapMs !== null) {
    if (!Number.isFinite(perCallCapMs) || perCallCapMs <= 0) {
      log(`WARN: invalid --per-call value — ignoring (using default 180s)`);
    } else if (perCallCapMs < 10_000) {
      log(`WARN: --per-call=${perCallCapMs} interpreted as seconds (${perCallCapMs * 1000}ms).`);
      perCallCapMs *= 1000;
    }
    if (Number.isFinite(perCallCapMs) && perCallCapMs > 0) {
      const exec = createExecutor({
        webextPath: WEBEXT, logPrefix: 'orch', minCallBudgetMs: 30_000,
        holdLockOnSuccess: true, acceptUsedMarker: true,
        perCallCapMs,
      });
      callProvider = exec.callProvider;
      runChain = exec.runChain;
      log(`perCallCapMs set to ${Math.round(perCallCapMs / 1000)}s (single-attempt ceiling raised from default 180s)`);
    }
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
  // v24 P1: strict-plan guard — when the user provides --plan they expect the
  // file to be a valid pre-decomposed plan. Any structural defect → exit 64
  // before dispatch, never fall into NL decomposition or the 4-role DAG.
  const dag = await buildDAG(prompt, Math.floor(timeout * 0.3), { strictPlan: !!planFile });
  // v19: " | " separator — the node ARRAY carries no ordering, and "→" falsely
  // implied a 9-node sequential dependency chain for plans where every
  // depends_on is []. Actual execution order (if any) is shown by the
  // "Wave N:" lines from dispatchWaves().
  log(`  DAG nodes: ${dag.nodes.map(n => `${n.id}(${n.ai}/${n.role})`).join(" | ")}`);

  // M2: Wave dispatch (topological layers, depends_on now honored)
  // M2 gets 85% of the time ACTUALLY remaining after M1. Floor is a 60s
  // CONSTANT — the old 120s floor (and dispatchParallel's nodes×60s floor)
  // could silently exceed the user's --timeout.
  const m2Budget = Math.max(60_000, Math.floor((timeout - (Date.now() - T0)) * 0.85));
  const results = await dispatchWaves(dag, m2Budget);

  // M3: Arbitrate
  const arbitration = arbitrateResults(dag, results);

  // Output
  const totalMs = Date.now() - T0;
  const failCount = Object.values(results).filter(r => !r?.output?.response).length;
  const exitCode = failCount === dag.nodes.length ? 2 : 0;

  // v25: --raw-out=FILE — write full detailed output to disk (replaces `| tee`)
  // Isolated in try/catch: a raw-out write failure must not kill the rest of
  // M3 output (printStructuredOutput / receipt), but MUST set non-zero exit.
  let rawOutBytes = 0;
  if (rawOutFile) {
    try {
      const rawLines = [];
      rawLines.push("═".repeat(60));
      rawLines.push("SYNTHESIS BRIEF");
      rawLines.push("═".repeat(60));
      for (const node of dag.nodes) {
        const t = arbitration.trust[node.id];
        const label = { FULL: "✓", DEGRADED: "⚠", MISSING: "✗" }[t.tier] || "?";
        rawLines.push(`  ${label} ${node.id} [${node.role}]: ${t.tier} → ${t.provider || "NONE"}`);
      }
      for (const node of dag.nodes) {
        const r = results[node.id];
        if (r?.output?.response) {
          rawLines.push(`\n══════ ${node.id} (${node.role}) — ${r.output.provider_used} ══════`);
          rawLines.push(r.output.response);
        }
      }
      // append receipt
      rawLines.push(`\n[receipt] AGENTCHAT_RUN ${JSON.stringify({
        run_id: RUN_ID, skill: "AgentChat-IndependentTasks",
        timestamp: new Date().toISOString(), exit: exitCode,
        nodes: dag.nodes.length, failed: failCount,
        providers_used: Object.fromEntries(
          Object.entries(results).map(([id, r]) => [id, r?.output?.provider_used || null])
        ), total_ms: totalMs,
      })}`);
      const out = rawLines.join("\n") + "\n";
      fs.writeFileSync(rawOutFile, out, "utf8");
      rawOutBytes = Buffer.byteLength(out, "utf8");
      log(`Raw output written to ${rawOutFile} (${rawLines.length} lines, ${rawOutBytes} bytes)`);
    } catch (e) {
      console.error(`[raw-out] FAILED: ${e.stack}`);
      process.exitCode = 1;
    }
  }

  if (summaryOnly) {
    // v25: terminal shows ONLY one-line JSON — saves ~5K context tokens
    const summary = {
      exit: exitCode,
      nodes: dag.nodes.length,
      failed: failCount,
      providers_used: Object.fromEntries(
        Object.entries(results).map(([id, r]) => [id, r?.output?.provider_used || null])
      ),
      total_ms: totalMs,
      run_id: RUN_ID,
    };
    console.log(JSON.stringify(summary));
  } else {
    // Isolated in try/catch: presentation layer failure must not kill receipt
    // emission, but MUST be visible in exit code.
    try {
      printStructuredOutput(dag, results, arbitration, totalMs);
    } catch (e) {
      console.error(`[output] print crashed: ${e.stack}`);
      process.exitCode = 1;
    }
  }

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
      total_ms: totalMs,
      raw_out: rawOutFile ? { path: rawOutFile, bytes: rawOutBytes } : null,
    },
    stream: summaryOnly ? 'stderr' : 'stdout',
  });

  // P0 FLUSH FIX: process.exit() right after console.log() truncates piped
  // stdout at the pipe-buffer boundary (~128KB Linux, less on Windows) — the
  // SYNTHESIS BRIEF + raw responses easily exceed that when Claude Code
  // captures this process's output. Every handle is closed by now (children
  // reaped, executor timers cleared), so setting exitCode and returning lets
  // Node drain stdout completely and exit naturally. The process.on("exit")
  // cleanupAllLocks handler still fires.
  process.exitCode = process.exitCode || exitCode;
}

// BUGFIX: previously called main() unconditionally, so simply require()'ing this
// file (e.g. from a test, or another script re-using FALLBACK_CHAIN/normalizeAI)
// would immediately run the CLI: parse process.argv, block on stdin if no prompt
// was given, spawn subprocesses, and eventually call process.exit(). Guarded to
// match AgentChat-OneWeb/index.js's existing require.main === module pattern.
if (require.main === module) {
    main().catch(e => { log(`CRITICAL: ${e.message}`); process.exit(4); });
}

module.exports = { FALLBACK_CHAIN, buildFallbackChain, normalizeAI, cleanResponse, topoWaves, injectUpstream, tryParsePreDecomposedPlan, validateDAGNodes };
