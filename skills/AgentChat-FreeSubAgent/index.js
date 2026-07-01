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

const WEBEXT = path.resolve(__dirname, "..", "AgentChat-WebExtended", "index.js");
const FALLBACK_CHAIN = ["gemini", "chatgpt", "claude", "qwen", "kimi", "minimax"];
const INSERT_TEXT_LIMIT = 4000;
const STAGGER_MS = 1500; // inter-worker launch delay

// ═══════════════════════════════════════════════════════════════════
// UTILS
// ═══════════════════════════════════════════════════════════════════

function log(msg) { process.stderr.write(`[orch] ${msg}\n`); }
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
    const child = spawn("node", [
      WEBEXT,
      `--from=${provider}`,
      `--timeout=${timeoutMs}`,
      prompt,
    ], {
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs + 30000, // slightly more than child's internal timeout
    });

    let stdout = "", stderr = "";
    child.stdout.on("data", d => stdout += d.toString());
    child.stderr.on("data", d => stderr += d.toString());

    child.on("close", (code) => {
      const text = stdout.trim();
      const provMatch = stderr.match(/✓\s*(\w+):\s*USED/);
      const providerUsed = provMatch ? provMatch[1].toLowerCase() : provider;

      if (code === 0 && text.length >= 5) {
        resolve({ ok: true, text, provider: providerUsed });
      } else {
        const reasonMap = { 1: "no_cdp", 2: "auth", 3: "safety", 4: "internal", 5: "quota", 9: "all_exhausted", 10: "timeout" };
        resolve({ ok: false, text: "", provider: providerUsed, reason: reasonMap[code] || `exit_${code}` });
      }
    });

    child.on("error", (err) => {
      resolve({ ok: false, text: "", provider, reason: "spawn_error", error: err.message });
    });
  });
}

// ═══════════════════════════════════════════════════════════════════
// FALLBACK EXECUTOR — try primary first, then chain
// ═══════════════════════════════════════════════════════════════════

async function executeWithFallback(primaryKey, prompt, budgetMs) {
  const chain = [primaryKey, ...FALLBACK_CHAIN.filter(k => k !== primaryKey)];
  const tried = [];
  const perCallBudget = Math.max(60000, Math.floor(budgetMs / (chain.length + 1)));

  for (const key of chain) {
    log(`    [fallback] Trying ${key}...`);
    const start = Date.now();

    const result = await callProvider(prompt, key, perCallBudget);

    if (result.ok) {
      return {
        provider_used: result.provider || key,
        primary_intended: primaryKey,
        degradation: key !== primaryKey ? {
          reason: tried.map(t => `${t.key}:${t.reason}`).join("; "),
          fallback_chain: tried.map(t => t.key),
          confidence_adjustment: -0.15,
        } : null,
        response: cleanResponse(result.text),
        elapsed_ms: Date.now() - start,
      };
    }
    tried.push({ key, reason: result.reason || "unknown" });
  }

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
  /^Qwen[\d.]+-(?:Max|Plus|Turbo|Flash)\s*\n?\s*/gim,
  /Thought\s*for\s*\d+s?\s*/gi,
  /^You said[：:\s]*.*?\n/gim,
  /^Zi[，,]\s*(?:接著要做什麼|在想什麼|我們進入正題|你好).*/gim,
  /^我隨時待命[！!。.]?\s*/gim,
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
  const map = { gpt: "chatgpt", chatgpt: "chatgpt", gemini: "gemini", kimi: "kimi", qwen: "qwen", claude: "claude", minimax: "minimax" };
  return map[n] || n;
}

const DAG_DECOMPOSER_PROMPT = `You are a task decomposition expert. Given a complex user task, assign complementary sub-tasks to 4 AI specialists.

AI ROLES (complementary, non-overlapping — each AI does DIFFERENT work):
- Gemini (depth_reasoner): Multi-step logic, mathematical analysis, scientific reasoning, complex deduction
- GPT (creative_builder): Code generation, solution design, creative writing, synthesis, actionable recommendations
- Kimi (researcher): Long-context analysis, literature review, detailed fact extraction, background research
- Qwen (reviewer_retriever): Fact verification, cross-reference checking, Chinese-language tasks, web retrieval

CRITICAL RULES:
1. ALL 4 nodes run SIMULTANEOUSLY. Every node must have empty depends_on=[] UNLESS a node's prompt LITERALLY cannot be written without another node's output.
2. READ THE USER TASK CAREFULLY. The task is: ▶▶▶ <TASK> ◀◀◀ Do NOT invent a different task.
3. Each prompt must demand a DIRECT FINAL ANSWER. Start with "请直接给出..." / "Provide a complete analysis of..." / "List the specific..." — NEVER write prompts that describe what the AI will do.
4. Each AI gets a DIFFERENT angle on the task — no two answering the same question.
5. Output JSON ONLY (no markdown, no backticks):
{
  "dag": {
    "nodes": [
      {
        "id": "angle_1",
        "ai": "Kimi",
        "role": "researcher",
        "goal": "one-line description",
        "depends_on": [],
        "prompt": "Self-contained, actionable prompt with embedded context..."
      },
      ...
    ]
  }
}`;

async function buildDAG(userTask, budgetMs) {
  log("━━━ Module 1: Task DAG Construction ━━━");
  log(`  Task: "${userTask.slice(0, 100)}${userTask.length > 100 ? "..." : ""}"`);

  const prompt = DAG_DECOMPOSER_PROMPT.replace("<TASK>", userTask);

  // Try each provider for decomposition
  for (const key of FALLBACK_CHAIN) {
    log(`  Decomposer: trying ${key}...`);
    const result = await callProvider(prompt, key, Math.floor(budgetMs * 0.4));
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

async function runOneWorker(node, budgetMs) {
  const primaryKey = normalizeAI(node.ai);

  try {
    const result = await executeWithFallback(primaryKey, node.prompt, budgetMs);
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

  const perNodeBudget = Math.floor(budgetMs / nodes.length);
  const deadline = Date.now() + perNodeBudget;

  // Launch all workers with stagger, run concurrently via Promise.all
  const tasks = nodes.map((node, i) => {
    const delay = i * STAGGER_MS;
    return new Promise(resolve => setTimeout(async () => {
      const remaining = Math.max(60000, deadline - Date.now());
      const r = await runOneWorker(node, remaining);
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

function arbitrateResults(dag, results) {
  log("━━━ Module 3: Evidence Arbitration ━━━");

  const nodes = dag.nodes;
  const arbitration = {
    summary: "",
    findings: [],
    contradictions: [],
    degradations: [],
    overall_confidence: 1.0,
  };

  // Collect degradation reports
  for (const node of nodes) {
    const r = results[node.id];
    if (!r) {
      arbitration.degradations.push({ node_id: node.id, role: node.role, reason: "NO_RESULT" });
      continue;
    }
    if (r.output.degradation) {
      arbitration.degradations.push({
        node_id: node.id, role: node.role,
        intended: r.output.primary_intended, used: r.output.provider_used,
        reason: r.output.degradation.reason,
        confidence_adj: r.output.degradation.confidence_adjustment,
      });
    }
  }

  // Evidence-weighted synthesis
  const validResults = nodes
    .map(n => ({ node: n, r: results[n.id] }))
    .filter(x => x.r?.output?.response);

  // Cross-check for quality/length disparities
  for (let i = 0; i < validResults.length; i++) {
    for (let j = i + 1; j < validResults.length; j++) {
      const a = validResults[i], b = validResults[j];
      const qa = a.r.quality.quality_score, qb = b.r.quality.quality_score;
      if (Math.abs(qa - qb) > 0.3) {
        arbitration.findings.push({
          type: "quality_disparity",
          node_a: a.node.id, node_b: b.node.id,
          score_a: qa, score_b: qb,
          note: `Quality gap > 0.3 between ${a.node.id}(${qa}) and ${b.node.id}(${qb})`,
        });
      }
      const la = a.r.output.response?.length || 0, lb = b.r.output.response?.length || 0;
      if (la > 0 && lb > 0 && la > 200 && lb > 200 && (la / lb > 3 || lb / la > 3)) {
        arbitration.findings.push({
          type: "length_disparity",
          node_a: a.node.id, node_b: b.node.id,
          len_a: la, len_b: lb,
          note: `Significant response length difference: ${a.node.id}=${la} vs ${b.node.id}=${lb}`,
        });
      }
    }
  }

  // Build structured summary
  const lines = [];
  lines.push("═".repeat(60));
  lines.push("EVIDENCE ARBITRATION REPORT");
  lines.push("═".repeat(60));

  for (const node of nodes) {
    const r = results[node.id];
    if (!r?.output?.response) {
      lines.push(`\n[${node.id}] ${node.role} (${node.ai}): ❌ NO RESULT — ${r?.output?.error || "unknown"}`);
      continue;
    }
    const deg = r.output.degradation;
    const degNote = deg ? ` ⚠ DEGRADED (${deg.reason}, conf: ${(1 + deg.confidence_adjustment).toFixed(2)})` : "";
    lines.push(`\n[${node.id}] ${node.role} → ${r.output.provider_used} (quality: ${r.quality.quality_score})${degNote}`);
    lines.push(`  ${r.output.response.slice(0, 200)}${r.output.response.length > 200 ? "..." : ""}`);
  }

  if (arbitration.degradations.length > 0) {
    lines.push(`\n${"─".repeat(60)}`);
    lines.push("DEGRADATION REPORT:");
    for (const d of arbitration.degradations) {
      lines.push(`  [${d.node_id}] ${d.role}: ${d.used || "NONE"} (intended: ${d.intended || d.node_id}) — ${d.reason}`);
    }
  }

  const scores = Object.values(results).map(r => r?.quality?.quality_score || 0);
  arbitration.overall_confidence = scores.length > 0 ? scores.reduce((a, b) => a + b, 0) / scores.length : 0;
  lines.push(`\n${"─".repeat(60)}`);
  lines.push(`OVERALL CONFIDENCE: ${(arbitration.overall_confidence * 100).toFixed(0)}%`);
  if (arbitration.findings.length > 0) {
    lines.push(`FINDINGS: ${arbitration.findings.length} issue(s) flagged`);
    for (const f of arbitration.findings) lines.push(`  - [${f.type}] ${f.note}`);
  }

  arbitration.summary = lines.join("\n");
  return arbitration;
}

// ═══════════════════════════════════════════════════════════════════
// OUTPUT FORMATTER
// ═══════════════════════════════════════════════════════════════════

function printStructuredOutput(dag, results, arbitration, totalMs) {
  console.log(`\n${arbitration.summary}`);
  console.log(`\nTotal time: ${(totalMs / 1000).toFixed(1)}s\n`);

  for (const node of dag.nodes) {
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
    if ((args[i] === "--timeout" || args[i].startsWith("--timeout=")) && args[i + 1]) {
      const v = args[i].startsWith("--timeout=") ? args[i].split("=")[1] : args[i + 1];
      timeout = parseInt(v, 10);
      if (!args[i].startsWith("--timeout=")) i++;
    } else if (args[i] === "--smoke") smoke = true;
    else if (args[i] === "--doctor") doctor = true;
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

  // Verify WebExtended exists
  if (!fs.existsSync(WEBEXT)) {
    log(`FATAL: AgentChat-WebExtended not found at: ${WEBEXT}`);
    log("  This skill depends on AgentChat-WebExtended for provider implementations.");
    process.exit(1);
  }

  const T0 = Date.now();

  if (smoke) {
    log("Smoke test: checking all providers via WebExtended...");
    for (const key of FALLBACK_CHAIN) {
      const result = await callProvider("Respond with just the word OK.", key, 120000);
      log(`  ${key}: ${result.ok ? `✓ (${result.text.length} chars)` : `✗ ${result.reason}`}`);
    }
    process.exit(0);
  }

  // M1: Build DAG
  const dag = await buildDAG(prompt, Math.floor(timeout * 0.3));
  log(`  DAG: ${dag.nodes.map(n => `${n.id}(${n.ai}/${n.role})`).join(" → ")}`);

  // M2: Parallel dispatch
  const results = await dispatchParallel(dag, Math.floor(timeout * 0.55));

  // M3: Arbitrate
  const arbitration = arbitrateResults(dag, results);

  // Output
  printStructuredOutput(dag, results, arbitration, Date.now() - T0);

  const failCount = Object.values(results).filter(r => !r?.output?.response).length;
  process.exit(failCount === dag.nodes.length ? 2 : 0);
}

main().catch(e => { log(`CRITICAL: ${e.message}`); process.exit(4); });
