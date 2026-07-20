/**
 * lib/plan.js — shared plan-format handling for AgentChat-IndependentTasks.
 *
 * Extracted from index.js so both the orchestrator (index.js) and the linter
 * (validate_answers.js) consume the same expandSharedPlan logic — zero
 * divergence between what the linter checks and what actually runs at dispatch
 * time.
 *
 * Exports:
 *   expandSharedPlan(plan)   — expand compressed format to traditional
 *   isCompressedPlan(plan)   — detect {shared, questionBank} shape
 *   lintCompressedInvariants(plan) — validate compressed format structure
 *   REQ_TEMPLATES / PROMPT_TEMPLATES — for use by callers that need them
 */

"use strict";

// ── Requirement templates (matched to questionBank entry `type`) ──────
const REQ_TEMPLATES = {
  explain:    "1. Explain the physical mechanism. 2. Relate to the computational/experimental results. 3. Frame as a concise reviewer response.",
  compare:    "1. Provide systematic comparison across all mentioned items. 2. Explain observed trends using fundamental physical/chemical arguments. 3. Draft for direct manuscript inclusion.",
  provide:    "1. Describe the requested data/calculation/analysis. 2. Explain its significance for the manuscript's conclusions. 3. Suggest exact location and format for manuscript/SI addition.",
  clarify:    "1. Answer the specific concern directly and concisely. 2. Cite relevant literature or methodological justification. 3. Describe the exact revisions made to the manuscript.",
  literature: "1. Cite specific literature with journal/year. 2. Explain the physical mechanism connecting the literature to this work. 3. Connect the evidence to the BPQD/system studied.",
  mixed:      "1. Address the question's primary concern directly. 2. Provide supporting reasoning or data. 3. Suggest concrete manuscript revision if applicable.",
};

// ── Prompt templates (English only, matched to shared.template) ──────
// {MAX_WORDS} is set by expandSharedPlan() — default 300, overridable per
// subtask via max_words in the plan JSON. Formulas and citations do not
// count toward the limit (advisory, not hard-enforced by the orchestrator).
const PROMPT_TEMPLATES = {
  single_en: `Please complete the following 1 independent task. Use LaTeX for formulas. Begin answering directly.

Hard format requirements (violation = invalid answer):
1. The first line of the answer MUST output verbatim: [ANSWER {ID}]
2. After the anchor line, restate the task in one sentence, then provide the formal answer.
3. CONCISENESS: Target 150–250 words per answer; hard cap {MAX_WORDS} words. Dense and precise — no filler, no background repetition, no generic commentary. Formulas and citations do not count toward the limit.
4. Only answer the listed task. Do not infer, supplement, merge, or renumber.

Background: {BG}

{TASKS_BLOCK}`,

  dual_en: `Please complete the following 2 independent tasks. Use LaTeX for formulas. Begin answering directly.

Hard format requirements (violation = invalid answer):
1. The first line of each answer MUST output verbatim the anchor line: [ANSWER {ID1}] for Task 1, [ANSWER {ID2}] for Task 2.
2. After each anchor line, restate the task in one sentence, then provide the formal answer.
3. CONCISENESS: Target 150–250 words per answer; hard cap {MAX_WORDS} words. Dense and precise — no filler, no background repetition, no generic commentary. Formulas and citations do not count toward the limit.
4. Only answer the listed tasks. Do not infer, supplement, merge, or renumber.

Background: {BG}

{TASKS_BLOCK}`,
};

const DEFAULT_MAX_WORDS = 300;

const VALID_TEMPLATES = Object.keys(PROMPT_TEMPLATES);
const VALID_TYPES = Object.keys(REQ_TEMPLATES);

// ── Helpers ──────────────────────────────────────────────────────────

function deriveRequirements(qtype) {
  const key = String(qtype || "").toLowerCase().trim();
  return REQ_TEMPLATES[key] || REQ_TEMPLATES.mixed;
}

function formatTasksBlock(questions, questionBank) {
  return questions.map((qid, i) => {
    const q = questionBank[qid];
    if (!q) throw new Error(`question "${qid}" not found in plan.questionBank`);
    const draft = q.author_draft || "None. Please analyze independently based on physical principles.";
    const reqs = deriveRequirements(q.type || "mixed");
    return `【Task ${i + 1}】[ANSWER ${qid}]\n${q.text}\nAuthor thoughts (≤2 sentences, follow and expand rather than overturn): ${draft}\nRequirements: ${reqs}`;
  }).join("\n\n");
}

// ── Exported functions ────────────────────────────────────────────────

/**
 * Detect whether a plan uses the compressed format ({shared, questionBank}).
 * Does NOT check validity — only shape.
 */
function isCompressedPlan(plan) {
  return !!(plan && plan.shared && plan.questionBank);
}

/**
 * Expand a compressed-format plan into the traditional format.
 *
 * For each subtask that lacks an explicit prompt, auto-generates one from
 * the shared template + questionBank. Subtasks that already have a prompt
 * (>10 chars) are left untouched (backward compatibility).
 *
 * Mutates `plan` in place and strips shared/questionBank before returning.
 * Returns the same object for chaining.
 */
function expandSharedPlan(plan) {
  // Pass-through: no shared fields — plan is already fully expanded
  if (!isCompressedPlan(plan)) return plan;

  const { background, template: tplName } = plan.shared;
  const qbank = plan.questionBank;

  for (const st of plan.subtasks) {
    // Explicit prompt overrides shared expansion (backward compat)
    if (st.prompt && st.prompt.length > 10) continue;

    const k = st.questions.length;
    const tplKey = tplName || (k === 1 ? "single_en" : "dual_en");
    let template = PROMPT_TEMPLATES[tplKey];
    if (!template) throw new Error(`unknown template "${tplKey}" — valid: ${VALID_TEMPLATES.join(", ")}`);

    // Per-subtask word-limit override (default: DEFAULT_MAX_WORDS)
    const maxWords = st.max_words || DEFAULT_MAX_WORDS;

    const tasksBlock = formatTasksBlock(st.questions, qbank);

    // Fill template placeholders
    let prompt = template
      .replace(/\{BG\}/g, background || "")
      .replace(/\{TASKS_BLOCK\}/g, tasksBlock)
      .replace(/\{ID\}/g, st.questions[0] || "")
      .replace(/\{ID1\}/g, st.questions[0] || "")
      .replace(/\{ID2\}/g, st.questions[1] || "")
      .replace(/\{MAX_WORDS\}/g, String(maxWords));

    st.prompt = prompt;
  }

  // Clean up — strip shared metadata before returning to downstream
  delete plan.shared;
  delete plan.questionBank;
  return plan;
}

/**
 * Validate the compressed plan format's own structure BEFORE expansion.
 *
 * Returns an array of {severity: "error"|"warn", message} objects.
 * Callers should treat "error" as blocking, "warn" as advisory.
 *
 * Checks performed:
 *   (error) every question ID in subtasks[*].questions exists in questionBank
 *   (warn)  questionBank entries not referenced by any subtask (orphans)
 *   (error) shared.template is a known template name
 *   (warn)  shared.background is missing or very short
 *   (warn)  questionBank entries with unknown/empty `type`
 */
function lintCompressedInvariants(plan) {
  const issues = [];

  if (!plan.questionBank || typeof plan.questionBank !== "object") {
    issues.push({ severity: "error", message: "questionBank missing or not an object" });
    return issues;
  }
  if (!plan.shared || typeof plan.shared !== "object") {
    issues.push({ severity: "error", message: "shared missing or not an object" });
    return issues;
  }
  if (!Array.isArray(plan.subtasks) || plan.subtasks.length === 0) {
    issues.push({ severity: "error", message: "subtasks missing or empty" });
    return issues;
  }

  const qbKeys = new Set(Object.keys(plan.questionBank));

  // Check 1: every question ID referenced by a subtask exists in questionBank
  const referenced = new Set();
  for (const st of plan.subtasks) {
    for (const qid of st.questions) {
      referenced.add(qid);
      if (!qbKeys.has(qid)) {
        issues.push({
          severity: "error",
          message: `subtask "${st.id}": question "${qid}" not found in questionBank (dangling reference)`,
        });
      }
    }
  }

  // Check 2: orphan entries in questionBank (not referenced by any subtask)
  for (const key of qbKeys) {
    if (!referenced.has(key)) {
      issues.push({
        severity: "warn",
        message: `questionBank entry "${key}" is not referenced by any subtask (orphan)`,
      });
    }
  }

  // Check 3: shared.template must be valid
  const tplName = plan.shared.template;
  if (tplName && !VALID_TEMPLATES.includes(tplName)) {
    issues.push({
      severity: "error",
      message: `unknown template "${tplName}" — valid: ${VALID_TEMPLATES.join(", ")}`,
    });
  }

  // Check 4: shared.background
  if (!plan.shared.background || plan.shared.background.length < 20) {
    issues.push({
      severity: "warn",
      message: "shared.background is missing or very short (<20 chars)",
    });
  }

  // Check 5: questionBank entry types
  for (const [key, entry] of Object.entries(plan.questionBank)) {
    const type = String((entry.type || "mixed")).toLowerCase().trim();
    if (!VALID_TYPES.includes(type)) {
      issues.push({
        severity: "warn",
        message: `questionBank "${key}": unknown type "${type}" — valid: ${VALID_TYPES.join(", ")}`,
      });
    }
  }

  return issues;
}

module.exports = {
  REQ_TEMPLATES,
  PROMPT_TEMPLATES,
  VALID_TEMPLATES,
  VALID_TYPES,
  DEFAULT_MAX_WORDS,
  deriveRequirements,
  formatTasksBlock,
  expandSharedPlan,
  isCompressedPlan,
  lintCompressedInvariants,
};
