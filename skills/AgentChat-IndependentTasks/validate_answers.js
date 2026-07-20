#!/usr/bin/env node
/**
 * validate_answers.js — Step 2.5 内容校验门（强制执行规则 #5 的机器实现）
 *
 * receipt 只证明桥接成功；本脚本证明"回答对应被派发的题目"：
 *   1. 锚校验    — 每个全局 ID 的 [ANSWER <ID>] 锚行必须逐字出现
 *   2. 外来锚检测 — 出现不属于该组的 [ANSWER X] → 模型自行改编号（FAIL）
 *   3. 噪声剥离  — 首部粘连时间戳（Qwen）、尾部裸 URL / markdown 图片行
 *                  （Kimi 头像、MiMo logo）— provider UI 污染的 B 层兜底
 *
 * 用法：
 *   node validate_answers.js <plan.json> <raw_stdout.txt | answers_dir> [--out=DIR]
 *
 *   raw_stdout.txt — index.js 的完整 stdout（tee 捕获），按 ══════ 头切分
 *   answers_dir    — 或每组一个 <subtask_id>.txt 的目录
 *   --out          — 输出目录（默认 ./agentchat_validated）：
 *                      clean/<id>.txt        清洗后的回答（合成阶段唯一材料源）
 *                      validation_report.json
 *
 * 退出码：0 全部 PASS | 2 存在 FAIL/缺答 | 64 用法错误
 * 零依赖（Node 18+ stdlib）。
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── args ──────────────────────────────────────────────────────────
function usage(msg) {
  if (msg) process.stderr.write(`[validate] ${msg}\n`);
  process.stderr.write(
    "usage: node validate_answers.js <plan.json> <raw_stdout.txt|answers_dir> [--out=DIR]\n");
  process.exit(64);
}

const argv = process.argv.slice(2);
const positional = [];
let outDir = path.resolve("agentchat_validated");
for (const a of argv) {
  if (a.startsWith("--out=")) outDir = path.resolve(a.slice(6));
  else if (a === "--help" || a === "-h") usage();
  else positional.push(a);
}
if (positional.length !== 2) usage("expected exactly 2 positional args");

const [planPath, inputPath] = positional;
if (!fs.existsSync(planPath)) usage(`plan not found: ${planPath}`);
if (!fs.existsSync(inputPath)) usage(`input not found: ${inputPath}`);

let plan;
try {
  plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
} catch (e) {
  usage(`plan is not valid JSON: ${e.message}`);
}
const subtasks = plan.subtasks;
if (!Array.isArray(subtasks) || subtasks.length === 0)
  usage("plan.subtasks missing or empty");
for (const st of subtasks) {
  if (!st.id) usage("every subtask needs an id");
  if (!Array.isArray(st.questions) || st.questions.length === 0)
    usage(`subtask "${st.id}": questions must be a non-empty array of global IDs`);
}

// ── collect raw answers per subtask ───────────────────────────────
// Two input shapes:
//   directory  → <id>.txt per subtask
//   flat file  → orchestrator stdout; blocks delimited by
//                ══════ <id> (<role>) — <provider> ══════
const raw = Object.create(null); // id -> text|null

if (fs.statSync(inputPath).isDirectory()) {
  for (const st of subtasks) {
    const f = path.join(inputPath, `${st.id}.txt`);
    raw[st.id] = fs.existsSync(f) ? fs.readFileSync(f, "utf8") : null;
  }
} else {
  const text = fs.readFileSync(inputPath, "utf8");
  // Header lines look like: ══════ group_x (worker) — gemini ══════
  const headerRe = /^═+\s*(\S+)\s*(?:\([^)]*\))?\s*(?:—|-)\s*\S+\s*═+\s*$/;
  const lines = text.split(/\r?\n/);
  let cur = null;
  const buf = Object.create(null);
  for (const line of lines) {
    const m = line.match(headerRe);
    if (m) { cur = m[1]; buf[cur] = []; continue; }
    if (cur) buf[cur].push(line);
  }
  for (const st of subtasks)
    raw[st.id] = Object.prototype.hasOwnProperty.call(buf, st.id)
      ? buf[st.id].join("\n")
      : null;
}

// ── noise stripping ───────────────────────────────────────────────
// Leading: bare timestamp possibly glued to first word (Qwen "12:42:00Response…")
// Trailing: bare-URL lines / markdown image lines (Kimi avatar, MiMo logos)
const LEAD_TS_RE = /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?)\s*/;
const BARE_URL_LINE = /^\s*!?\[?[^\]\n]*\]?\(?\s*https?:\/\/\S+\s*\)?\s*$/;

function stripNoise(text) {
  let stripped = [];
  let t = text.replace(/^\s+/, "");
  const m = t.match(LEAD_TS_RE);
  if (m && m[0].trim()) { stripped.push(`leading timestamp "${m[0].trim()}"`); t = t.slice(m[0].length); }
  const lines = t.split(/\r?\n/);
  let removed = 0;
  while (lines.length) {
    const last = lines[lines.length - 1];
    if (last.trim() === "") { lines.pop(); continue; }
    if (BARE_URL_LINE.test(last)) { lines.pop(); removed++; continue; }
    break;
  }
  if (removed) stripped.push(`${removed} trailing URL/image line(s)`);
  return { text: lines.join("\n").trim(), stripped };
}

// ── anchor validation ─────────────────────────────────────────────
const ANCHOR_RE = /\[ANSWER\s+([^\]\s]+)\s*\]/g;
function escRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

const allIds = new Set(subtasks.flatMap(st => st.questions));
const report = { generated: new Date().toISOString(), plan: path.resolve(planPath), subtasks: [] };
let anyFail = false;

fs.mkdirSync(path.join(outDir, "clean"), { recursive: true });

for (const st of subtasks) {
  const entry = { id: st.id, provider: st.primary || null, status: "PASS",
                  questions: {}, foreignAnchors: [], noiseStripped: [] };

  if (raw[st.id] == null || raw[st.id].trim() === "") {
    entry.status = "MISSING";
    entry.reason = "no response block found for this subtask id";
    anyFail = true;
    report.subtasks.push(entry);
    continue;
  }

  const { text, stripped } = stripNoise(raw[st.id]);
  entry.noiseStripped = stripped;

  // anchors present in this answer
  const found = new Set();
  let m;
  ANCHOR_RE.lastIndex = 0;
  while ((m = ANCHOR_RE.exec(text)) !== null) found.add(m[1]);

  const expected = new Set(st.questions);
  for (const qid of st.questions) {
    const re = new RegExp(`\\[ANSWER\\s+${escRe(qid)}\\s*\\]`);
    const seg = text.match(new RegExp(
      `\\[ANSWER\\s+${escRe(qid)}\\s*\\]([\\s\\S]*?)(?=\\[ANSWER\\s|$)`));
    const bodyLen = seg ? seg[1].trim().length : 0;
    entry.questions[qid] = { anchorFound: re.test(text), bodyLength: bodyLen };
    if (!re.test(text)) { entry.status = "FAIL"; anyFail = true; }
    else if (bodyLen < 30) {
      entry.questions[qid].warn = "body under 30 chars";
      entry.status = "FAIL"; anyFail = true;
    }
  }

  // foreign anchors: model renumbered / answered a question not in its group.
  // Only IDs that belong to the plan's universe count as "foreign" with
  // certainty; unknown tokens are reported as warnings (could be a typo'd echo).
  for (const id of found) {
    if (expected.has(id)) continue;
    if (allIds.has(id)) {
      entry.foreignAnchors.push(id);
      entry.status = "FAIL"; anyFail = true;
    } else {
      (entry.unknownAnchors ||= []).push(id);
    }
  }

  fs.writeFileSync(path.join(outDir, "clean", `${st.id}.txt`), text + "\n", "utf8");
  report.subtasks.push(entry);
}

fs.writeFileSync(path.join(outDir, "validation_report.json"),
  JSON.stringify(report, null, 2) + "\n", "utf8");

// ── console summary ───────────────────────────────────────────────
for (const e of report.subtasks) {
  const qs = Object.entries(e.questions)
    .map(([q, v]) => `${q}:${v.anchorFound ? "✓" : "✗"}`).join(" ");
  const extra = [
    e.foreignAnchors?.length ? `foreign=[${e.foreignAnchors.join(",")}]` : "",
    e.noiseStripped?.length ? `noise(${e.noiseStripped.length})` : "",
    e.reason || "",
  ].filter(Boolean).join(" ");
  process.stderr.write(`[validate] ${e.status.padEnd(7)} ${e.id}  ${qs}  ${extra}\n`);
}
process.stderr.write(`[validate] report: ${path.join(outDir, "validation_report.json")}\n`);
process.stderr.write(`[validate] clean answers: ${path.join(outDir, "clean")}\n`);

process.exit(anyFail ? 2 : 0);