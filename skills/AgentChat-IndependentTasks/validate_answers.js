#!/usr/bin/env node
/**
 * validate_answers.js — Step 2.5 内容校验门（强制执行规则 #5 的机器实现）
 *
 * receipt 只证明桥接成功；本脚本证明"回答对应被派发的题目"：
 *   1. 锚校验    — 每个全局 ID 的 [ANSWER <ID>] 锚行必须逐字出现
 *   2. 外来锚检测 — 出现不属于该组的 [ANSWER X] → 模型自行改编号（FAIL）
 *   3. 噪声剥离  — 首部粘连时间戳（Qwen）、尾部裸 URL / markdown 图片行
 *                  （Kimi 头像、MiMo logo）、[receipt] AGENTCHAT_RUN 行
 *                  （回执是执行证据，收进 report，但绝不进入合成材料）
 *   4. 伪造检测  — 回答自述"示例值/占位/请替换/placeholder"等 → FAIL
 *                  （fallback 模型编造数据冒充结果，学术场景零容忍）
 *
 * 用法：
 *   node validate_answers.js <plan.json> <raw_stdout.txt | answers_dir> [--out=DIR]
 *   node validate_answers.js --lint <plan.json>          # 派发前 plan 结构检查
 *
 *   raw_stdout.txt — index.js 的完整 stdout（tee 捕获），按 ══════ 头切分
 *   answers_dir    — 或每组一个 <subtask_id>.txt 的目录
 *   --out          — 输出目录（默认 ./agentchat_validated）：
 *                      clean/<id>.txt        清洗后的回答（合成阶段唯一材料源）
 *                      validation_report.json
 *                      semantic_check.json   语义抽查清单（verdict 初始 PENDING，
 *                                            Claude Code 逐条改为 MATCH/MISMATCH；
 *                                            md2pdf.sh 在 PENDING/MISMATCH 存在时拒绝编译）
 *
 * --lint 检查项（Step 2 派发前强制执行）：
 *   重复 subtask id（会静默覆盖 results）· 题目 ID 未出现在本组 prompt 内（prompt/questions 脱节）
 *   非空 depends_on · exclude 含未知 provider · primary ∈ exclude 自相矛盾 · 跨组重复题目 ID（WARN，冗余需有意为之）
 *
 * 退出码：0 全部 PASS | 2 存在 FAIL/缺答/lint 错误 | 64 用法错误
 * 零依赖（Node 18+ stdlib）。
 */

"use strict";

const fs = require("fs");
const path = require("path");

// ── args ──────────────────────────────────────────────────────────
function usage(msg) {
  if (msg) process.stderr.write(`[validate] ${msg}\n`);
  process.stderr.write(
    "usage: node validate_answers.js <plan.json> <raw_stdout.txt|answers_dir> [--out=DIR]\n" +
    "       node validate_answers.js --lint <plan.json>\n");
  process.exit(64);
}

const argv = process.argv.slice(2);
const positional = [];
let outDir = path.resolve("agentchat_validated");
let lintMode = false;
for (const a of argv) {
  if (a.startsWith("--out=")) outDir = path.resolve(a.slice(6));
  else if (a === "--lint") lintMode = true;
  else if (a === "--help" || a === "-h") usage();
  else positional.push(a);
}
if (lintMode && positional.length !== 1) usage("--lint takes exactly 1 arg: <plan.json>");
if (!lintMode && positional.length !== 2) usage("expected exactly 2 positional args");

const planPath = positional[0];
const inputPath = lintMode ? null : positional[1];
if (!fs.existsSync(planPath)) usage(`plan not found: ${planPath}`);
if (!lintMode && !fs.existsSync(inputPath)) usage(`input not found: ${inputPath}`);

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

// ── --lint: pre-dispatch plan structure checks ────────────────────
// 每一条都对应一次真实事故；派发前 30ms 的检查换后面 10 分钟浏览器时间。
if (lintMode) {
  const KNOWN = ["gemini", "chatgpt", "claude", "qwen", "kimi", "minimax", "mimo", "deepseek"];
  const errs = [], warns = [];

  // duplicate subtask ids → results[id] silently overwritten (observed incident)
  const idSeen = new Set();
  for (const st of subtasks) {
    if (idSeen.has(st.id)) errs.push(`duplicate subtask id "${st.id}" — later entry overwrites earlier results silently`);
    idSeen.add(st.id);
  }

  // duplicate question IDs across groups: legal redundancy, but must be intentional
  const qOwner = Object.create(null);
  for (const st of subtasks) for (const q of st.questions) {
    if (qOwner[q]) warns.push(`question "${q}" appears in both "${qOwner[q]}" and "${st.id}" — intentional redundancy? (Step 3 must merge, not duplicate)`);
    else qOwner[q] = st.id;
  }

  for (const st of subtasks) {
    // depends_on must be [] in this skill
    if (Array.isArray(st.depends_on) && st.depends_on.length > 0)
      errs.push(`subtask "${st.id}": non-empty depends_on — independent-tasks model forbids dependencies`);
    // prompt/questions coherence: every declared ID must literally appear in
    // the prompt (anchor instruction). A missing ID means the prompt was
    // written for different questions than the plan declares (observed:
    // duplicated-id incident produced exactly this divergence).
    const p = st.prompt || "";
    for (const q of st.questions)
      if (!p.includes(q)) errs.push(`subtask "${st.id}": question ID "${q}" does not appear in its prompt — prompt/questions out of sync`);
    if (st.primary && !KNOWN.includes(String(st.primary).toLowerCase()))
      warns.push(`subtask "${st.id}": unknown primary "${st.primary}"`);
  }

  // exclude sanity
  const exclude = Array.isArray(plan.exclude) ? plan.exclude.map(x => String(x).toLowerCase()) : [];
  for (const x of exclude)
    if (!KNOWN.includes(x)) errs.push(`exclude contains unknown provider "${x}"`);
  for (const st of subtasks)
    if (st.primary && exclude.includes(String(st.primary).toLowerCase()))
      errs.push(`subtask "${st.id}": primary "${st.primary}" is in the exclude list — self-contradictory plan`);

  for (const w of warns) process.stderr.write(`[lint] WARN  ${w}\n`);
  for (const e of errs) process.stderr.write(`[lint] ERROR ${e}\n`);
  process.stderr.write(`[lint] ${errs.length} error(s), ${warns.length} warning(s) — ${subtasks.length} subtasks, ${Object.keys(qOwner).length} unique questions${exclude.length ? `, exclude=[${exclude.join(",")}]` : ""}\n`);
  process.exit(errs.length ? 2 : 0);
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
// Anywhere: [receipt] AGENTCHAT_RUN lines — execution evidence, belongs in the
// report, must never leak into synthesis material (observed in retry clean files)
const LEAD_TS_RE = /^\s*(?:\[?\d{1,2}:\d{2}(?::\d{2})?\]?)\s*/;
const BARE_URL_LINE = /^\s*!?\[?[^\]\n]*\]?\(?\s*https?:\/\/\S+\s*\)?\s*$/;
const RECEIPT_LINE = /^\s*\[receipt\]\s+AGENTCHAT_RUN\b.*$/;

function stripNoise(text) {
  let stripped = [];
  const receiptLines = [];
  // receipt lines can appear anywhere (orchestrator appends after last block;
  // retries capture it mid-file) — remove every occurrence, preserve as evidence
  let t = text.split(/\r?\n/).filter(line => {
    if (RECEIPT_LINE.test(line)) { receiptLines.push(line.trim()); return false; }
    return true;
  }).join("\n");
  if (receiptLines.length) stripped.push(`${receiptLines.length} [receipt] line(s)`);
  t = t.replace(/^\s+/, "");
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
  return { text: lines.join("\n").trim(), stripped, receiptLines };
}

// ── fabrication detection ─────────────────────────────────────────
// A fallback model once fabricated ΔE_re/η_STE numbers and self-labelled them
// "示例值…请替换为实际计算结果". In an academic response letter fabricated
// numbers are worse than a missing answer — any self-declared placeholder
// marker fails the block outright (goes to Rule #4 L1 re-dispatch).
const FABRICATION_RES = [
  /示例值|示意数值|占位(符|数据|数值)?|请替换为|按[^\n]{0,10}趋势构造|虚构(的)?(数值|数据)|编造/,
  /placeholder (value|number|data)s?|illustrative (value|number|figure)s?|hypothetical (value|number|data)s?/i,
  /replace (these|this|with) (your|the )?(own |actual |real )?(value|number|result|data)s?/i,
  /for illustration (purposes )?only|values? (are|were) (invented|fabricated|made up)/i,
];
function scanFabrication(text) {
  const hits = [];
  for (const re of FABRICATION_RES) {
    const m = text.match(re);
    if (m) hits.push(m[0]);
  }
  return hits;
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

  const { text, stripped, receiptLines } = stripNoise(raw[st.id]);
  entry.noiseStripped = stripped;
  if (receiptLines.length) entry.receipt = receiptLines;

  const fab = scanFabrication(text);
  if (fab.length) {
    entry.fabricationMarkers = fab;
    entry.status = "FAIL";
    entry.reason = `self-declared placeholder/fabricated data: ${fab.map(s => JSON.stringify(s)).join(", ")}`;
    anyFail = true;
  }

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
    // 抽出锚行后的第一句"复述"，供 semantic_check.json 强制抽查（Issue: 语义抽查被跳过）
    let restatement = null;
    if (seg) {
      const firstLine = seg[1].trim().split(/\n/)[0] || "";
      restatement = (firstLine.split(/(?<=[。.!?？！])\s*/)[0] || firstLine).slice(0, 200);
    }
    entry.questions[qid] = { anchorFound: re.test(text), bodyLength: bodyLen, restatement };
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

// ── semantic_check.json：把"语义抽查"从口头步骤变成机器门 ─────────
// 锚校验挡编号漂移；"锚对了但内容跑偏"只能靠 Claude Code 逐条对照复述句与题目。
// 历史上这一步被直接跳过——因此现在它产出一个必须填写的 artifact：
// 每条 verdict 初始 PENDING，Claude Code 对照后改为 MATCH 或 MISMATCH（附一句理由）。
// md2pdf.sh（AGENTCHAT_VALIDATED_DIR 指向本目录时）在存在 PENDING/MISMATCH 时拒绝编译。
const semantic = [];
for (const e of report.subtasks) {
  for (const [qid, v] of Object.entries(e.questions || {})) {
    if (v.anchorFound) semantic.push({
      subtask: e.id, question: qid,
      restatement: v.restatement || "",
      verdict: "PENDING",   // Claude Code: 改为 "MATCH" 或 "MISMATCH"
      note: "",             // MISMATCH 时写一句原因
    });
  }
}
fs.writeFileSync(path.join(outDir, "semantic_check.json"),
  JSON.stringify(semantic, null, 2) + "\n", "utf8");

// ── console summary ───────────────────────────────────────────────
for (const e of report.subtasks) {
  const qs = Object.entries(e.questions)
    .map(([q, v]) => `${q}:${v.anchorFound ? "✓" : "✗"}`).join(" ");
  const extra = [
    e.foreignAnchors?.length ? `foreign=[${e.foreignAnchors.join(",")}]` : "",
    e.fabricationMarkers?.length ? `FABRICATED(${e.fabricationMarkers.length})` : "",
    e.noiseStripped?.length ? `noise(${e.noiseStripped.length})` : "",
    e.reason || "",
  ].filter(Boolean).join(" ");
  process.stderr.write(`[validate] ${e.status.padEnd(7)} ${e.id}  ${qs}  ${extra}\n`);
}
process.stderr.write(`[validate] report: ${path.join(outDir, "validation_report.json")}\n`);
process.stderr.write(`[validate] clean answers: ${path.join(outDir, "clean")}\n`);
process.stderr.write(`[validate] semantic check (fill verdicts before PDF): ${path.join(outDir, "semantic_check.json")}\n`);

process.exit(anyFail ? 2 : 0);