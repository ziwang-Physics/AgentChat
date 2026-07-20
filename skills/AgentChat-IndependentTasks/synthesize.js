#!/usr/bin/env node
/**
 * synthesize.js — Auto-generate solutions.md from clean answers + metadata.
 *
 * Reads validate_answers.js output (clean/ directory) + tasks_extracted.json
 * + plan JSON (for subtask→question mapping) → produces a textbook-style
 * solutions manual in markdown.
 *
 * Replaces the Claude Code manual Read→Rewrite loop (saves ~10K tokens/run):
 *   - Strips anchor-line restatements automatically
 *   - Extracts Key Result boxes heuristically
 *   - Groups by reviewer, numbers sequentially
 *   - Writes full markdown with YAML frontmatter + TOC
 *
 * Usage:
 *   node synthesize.js --clean=DIR --meta=tasks_extracted.json \
 *                      --plan=agentchat_plan.json [--out=solutions.md]
 *
 *   --plan is needed for subtask→question mapping; clean files are named by
 *   subtask ID, not question ID.
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── args ──────────────────────────────────────────────────────────
function usage(msg) {
  if (msg) process.stderr.write(`[synth] ${msg}\n`);
  process.stderr.write("usage: node synthesize.js --clean=DIR --meta=JSON --plan=JSON [--out=FILE]\n");
  process.exit(64);
}

const argv = process.argv.slice(2);
let cleanDir = null, metaFile = null, planFile = null, outFile = "solutions.md";
for (const a of argv) {
  if (a.startsWith("--clean=")) cleanDir = path.resolve(a.slice(8));
  else if (a.startsWith("--meta=")) metaFile = path.resolve(a.slice(7));
  else if (a.startsWith("--plan=")) planFile = path.resolve(a.slice(7));
  else if (a.startsWith("--out=")) outFile = path.resolve(a.slice(6));
  else if (a === "--help" || a === "-h") usage();
}
// Handle space-separated forms
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--clean" && argv[i+1] && !argv[i+1].startsWith("--")) { cleanDir = path.resolve(argv[i+1]); i++; }
  else if (argv[i] === "--meta" && argv[i+1] && !argv[i+1].startsWith("--")) { metaFile = path.resolve(argv[i+1]); i++; }
  else if (argv[i] === "--plan" && argv[i+1] && !argv[i+1].startsWith("--")) { planFile = path.resolve(argv[i+1]); i++; }
  else if (argv[i] === "--out" && argv[i+1] && !argv[i+1].startsWith("--")) { outFile = path.resolve(argv[i+1]); i++; }
}
if (!cleanDir) usage("--clean=DIR is required");
if (!metaFile) usage("--meta=JSON is required");
if (!fs.existsSync(cleanDir)) usage(`clean directory not found: ${cleanDir}`);
if (!fs.existsSync(metaFile)) usage(`meta file not found: ${metaFile}`);

// ── load inputs ───────────────────────────────────────────────────
const meta = JSON.parse(fs.readFileSync(metaFile, "utf8"));

// Build question→subtask mapping from plan JSON (if available)
const qidToSubtask = Object.create(null);
const subtaskProviders = Object.create(null); // subtask_id → provider name
if (planFile && fs.existsSync(planFile)) {
  const plan = JSON.parse(fs.readFileSync(planFile, "utf8"));
  for (const st of (plan.subtasks || [])) {
    for (const qid of (st.questions || [])) {
      qidToSubtask[qid] = st.id;
    }
    subtaskProviders[st.id] = st.primary || "—";
  }
} else {
  // Fallback: build mapping from clean/ directory — scan each file for [ANSWER X] anchors
  const files = fs.readdirSync(cleanDir).filter(f => f.endsWith(".txt") && f !== "all_clean.txt");
  for (const f of files) {
    const sid = f.replace(/\.txt$/, "");
    const text = fs.readFileSync(path.join(cleanDir, f), "utf8");
    const anchors = [...text.matchAll(/\[ANSWER\s+(\S+)\s*\]/g)].map(m => m[1]);
    for (const qid of anchors) qidToSubtask[qid] = sid;
    if (!subtaskProviders[sid]) subtaskProviders[sid] = "—";
  }
}

// Read answers by subtask ID
const subtaskAnswers = Object.create(null);
const allCleanPath = path.join(cleanDir, "all_clean.txt");

if (fs.existsSync(allCleanPath)) {
  const raw = fs.readFileSync(allCleanPath, "utf8");
  const sections = raw.split(/^=== /m);
  for (const sec of sections) {
    const nl = sec.indexOf("\n");
    if (nl < 0) continue;
    const id = sec.slice(0, nl).replace(/=+$/, "").trim();
    const text = sec.slice(nl + 1).trim();
    if (id && text) subtaskAnswers[id] = text;
  }
} else {
  for (const [qid, sid] of Object.entries(qidToSubtask)) {
    const f = path.join(cleanDir, `${sid}.txt`);
    if (fs.existsSync(f) && !subtaskAnswers[sid]) {
      subtaskAnswers[sid] = fs.readFileSync(f, "utf8").trim();
    }
  }
}

// Extract answer for a specific question from its subtask's answer block
function getAnswerFor(qid) {
  const sid = qidToSubtask[qid];
  if (!sid) return null;
  const block = subtaskAnswers[sid];
  if (!block) return null;
  // Extract text between [ANSWER <qid>] and the next [ANSWER ...] or end
  const esc = qid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(`\\[ANSWER\\s+${esc}\\s*\\]([\\s\\S]*?)(?=\\[ANSWER\\s|$)`, "i");
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// ── text processing helpers ────────────────────────────────────────

function stripRestatement(text) {
  if (!text) return "";
  // Remove leading "已深度思考…" noise (MiMo)
  let t = text.replace(/^已深度思考[（(][^)）]*[)）]\s*/g, "");
  // Remove leading restatement patterns
  t = t.replace(
    /^(?:This\s+(?:response|task|answer)\s+(?:addresses|clarifies|asks|requires|responds)\b[^.!?]*[.!?]\s*)/i, ""
  );
  t = t.replace(/^(?:The\s+task\s+asks?\s+to\b[^.!?]*[.!?]\s*)/i, "");
  t = t.replace(/^(?:The\s+(?:authors|reviewer|manuscript)\s+[^.!?]*[.!?]\s*)/i, "");
  t = t.replace(/^\s*(?:Task:\s*)?(?:Clarify|The\s+reviewer)\b[^.!?\n]*[.!?\n]\s*/i, "");
  return t.trim();
}

function extractOneLiner(text, maxLen = 160) {
  if (!text || text.length < 30) return (text || "").slice(0, maxLen);
  const ABBREV = /\b(et al|Fig|Eq|Ref|Phys|Rev|Lett|vs|cf|e\.g|i\.e)\.$/;
  const sentences = [];
  let buf = "";
  for (const chunk of text.split(/(?<=[.!?])\s+/)) {
    buf += (buf ? " " : "") + chunk;
    if (!ABBREV.test(chunk.trim())) { sentences.push(buf); buf = ""; }
  }
  if (buf) sentences.push(buf);
  if (sentences.length === 0) return text.slice(0, maxLen);
  // Prefer: sentence containing both a quantitative result AND a conclusiveness marker
  const quant = /\d+(\.\d+)?\s*(eV|cm|nm|%|kcal|meV|fs|ps|K)\b/i;
  const concl = /\b(thus|therefore|hence|overall|consequently|we (find|show|confirm)|in summary)\b/i;
  let pick = sentences.find(s => quant.test(s) && concl.test(s))
          || sentences.find(s => quant.test(s))
          || sentences.find(s => concl.test(s))
          || sentences[sentences.length - 1] || "";
  pick = pick.trim();
  return pick.length > maxLen ? pick.slice(0, maxLen - 1) + "…" : pick;
}

// ── markdown generation ────────────────────────────────────────────

const lines = [];
const paperTitle = (meta.meta && meta.meta.title) || "Manuscript";
const msId = (meta.meta && meta.meta.manuscript_id) || "N/A";
const journal = (meta.meta && meta.meta.journal) || "Journal";

lines.push("---");
lines.push(`title: "Response to Reviewer Comments"`);
lines.push(`subtitle: "${paperTitle}"`);
lines.push(`author: "Manuscript ID: ${msId}"`);
lines.push(`journal: "${journal}"`);
lines.push(`date: "${new Date().toISOString().slice(0, 10)}"`);
lines.push("---");
lines.push("");
lines.push("#outline()");
lines.push("");

// ── Phase 1: extract one-liners for all questions first ────────────
const taskResults = []; // {rev, qid, topic, answerText, oneLiner, provider}
for (const t of meta.tasks) {
  const answerText = getAnswerFor(t.id);
  if (!answerText || answerText.length < 20) {
    taskResults.push({ rev: t.reviewer, qid: t.id, topic: t.topic, answerText: null, oneLiner: "⚠ Answer missing", provider: "—" });
    continue;
  }
  const body = stripRestatement(answerText);
  const oneLiner = extractOneLiner(body);
  // Infer provider from the subtask mapping
  const sid = qidToSubtask[t.id] || "";
  const provider = (sid && subtaskProviders[sid]) || "—";
  taskResults.push({ rev: t.reviewer, qid: t.id, topic: t.topic, answerText: body, oneLiner, provider });
}

// ── Results Summary table (审阅入口，省 token) ─────────────────────
lines.push("\\newpage");
lines.push("");
lines.push("# Results Summary");
lines.push("");
lines.push("| # | Reviewer | Question | Provider | Key Result |");
lines.push("|---|----------|----------|----------|------------|");
let summaryNum = 0;
for (const tr of taskResults) {
  summaryNum++;
  const revLabel = `R${tr.rev}`;
  const kr = tr.oneLiner.length > 120 ? tr.oneLiner.slice(0, 117) + "…" : tr.oneLiner;
  lines.push(`| ${summaryNum} | ${revLabel} | ${tr.qid} | ${tr.provider} | ${kr} |`);
}
lines.push("");

// ── Phase 2: per-reviewer detailed sections ────────────────────────
lines.push("\\newpage");
lines.push("");

// Group questions by reviewer
const byReviewer = Object.create(null);
for (const t of meta.tasks) {
  const r = t.reviewer || 0;
  if (!byReviewer[r]) byReviewer[r] = [];
  byReviewer[r].push(t);
}

let globalProblemNum = 0;

for (const rev of Object.keys(byReviewer).sort((a, b) => a - b)) {
  lines.push(`# Reviewer ${rev}`);
  lines.push("");

  const tasks = byReviewer[rev];
  for (let i = 0; i < tasks.length; i++) {
    globalProblemNum++;
    const t = tasks[i];
    const tr = taskResults.find(r => r.qid === t.id);
    const answerText = tr ? tr.answerText : null;
    if (!answerText || answerText.length < 20) {
      lines.push(`## Problem ${globalProblemNum}: ${t.topic || "Question"} (${t.id})`);
      lines.push("");
      lines.push("**Question:** " + t.question.replace(/\n/g, " "));
      lines.push("");
      lines.push("**Solution:**");
      lines.push("");
      lines.push(`> ⚠ Answer for ${t.id} is missing — see validation report.`);
      lines.push("");
      lines.push("\\newpage");
      lines.push("");
      continue;
    }

    const oneLiner = tr ? tr.oneLiner : "";

    // Problem title
    const topicLabel = (t.topic || "Question").replace(/^./, c => c.toUpperCase());
    lines.push(`## Problem ${globalProblemNum}: ${topicLabel} (${t.id})`);
    lines.push("");

    // Question
    lines.push("**Question:** " + t.question.replace(/\n/g, " "));
    lines.push("");

    // Author draft (if present)
    if (t.author_draft) {
      lines.push("**Author Notes:** " + t.author_draft.replace(/\n/g, " "));
      lines.push("");
    }

    // Solution
    lines.push("**Solution:**");
    lines.push("");
    lines.push(answerText);
    lines.push("");

    // Key Result — one-liner only, no verbatim paragraph duplication
    if (oneLiner && oneLiner.length < answerText.length * 0.8) {
      lines.push("**Key Result:**");
      lines.push("");
      lines.push("> " + oneLiner.replace(/\n/g, "\n> "));
      lines.push("");
    }
    lines.push("\\newpage");
    lines.push("");
  }
}

// Summary table
lines.push("# Summary of All Revisions");
lines.push("");
lines.push("| Reviewer | Question | Topic | Status |");
lines.push("|----------|----------|-------|--------|");
for (const t of meta.tasks) {
  const revLabel = `R${t.reviewer}`;
  const topicLabel = t.topic || "general";
  const answerText = getAnswerFor(t.id);
  const status = (answerText && answerText.length > 20) ? "✓ answered" : "⚠ missing";
  lines.push(`| ${revLabel} | ${t.id} | ${topicLabel} | ${status} |`);
}
lines.push("");

// Write output
fs.writeFileSync(outFile, lines.join("\n"), "utf8");
const answeredCount = meta.tasks.filter(t => {
  const a = getAnswerFor(t.id);
  return a && a.length > 20;
}).length;
process.stderr.write(`[synth] ${meta.tasks.length} questions → ${answeredCount} answered → ${globalProblemNum} problems → ${outFile}\n`);
process.stderr.write(`[synth] Review: Claude Code should verify Key Result boxes and adjust if needed before PDF compilation.\n`);
