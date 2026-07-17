/**
 * Run receipts — machine-generated proof that a skill invocation actually
 * EXECUTED, quotable by the calling agent and auditable by the user.
 *
 * Why: every SKILL.md carries a "调用即执行" mandate, but prose alone cannot
 * force an agent to run `node index.js` — the recurring failure mode is
 * reading the SKILL.md, narrating the architecture, and answering from the
 * model's own knowledge. A receipt turns compliance from an instruction into
 * a VERIFIABLE fact:
 *
 *   1. Every real run emits exactly one line
 *          [receipt] AGENTCHAT_RUN {"run_id":"ac-xxxxxxxxxxxx",...}
 *      containing a random run_id that cannot be known without executing.
 *   2. The same JSON is appended to <skill>/data/receipts.jsonl (rotation via
 *      lib/telemetry), so the user can cross-check any run_id the agent
 *      quotes:  grep <run_id> skills/'*'/data/receipts.jsonl
 *   3. Each SKILL.md requires the agent to reproduce the receipt line in its
 *      final answer. Missing receipt = the node command never ran; a
 *      fabricated run_id fails the grep in (2).
 *
 * Failure runs also get receipts (exit != 0): "executed but degraded/failed"
 * must be reported with evidence, not silently replaced by the agent's own
 * answer.
 *
 * Stream policy (IMPORTANT — do not change casually):
 *   - AgentChat-OneWeb's stdout is a MACHINE CONTRACT: parents
 *     (lib/execute.js, the Python SDK, the MCP server) take stdout verbatim
 *     as the AI response. Its receipt therefore goes to STDERR, alongside the
 *     existing "✓ X: USED" marker.
 *   - AgentChat-IndependentTasks's stdout is a human/agent-readable report — the
 *     receipt is appended to STDOUT so it survives in the captured output.
 *   - AgentChat-WebSubAgent prints a single JSON object on stdout — the
 *     receipt is embedded as a `receipt` field inside that JSON (plus a
 *     stderr copy for uniform grepping).
 */

const crypto = require('crypto');
const path = require('path');
const { appendWithRotation } = require('./telemetry');

// run_id = 'ac-' + <8 hex: seconds-since-epoch, time-ordered> + <16 hex: 8
// random bytes>. The random half went from 6→8 bytes (48→64 bits) because
// AgentChat-IndependentTasks fans out to M concurrent worker processes that
// each emit a receipt into the SAME receipts.jsonl; at 48 bits a birthday
// collision becomes non-negligible across a busy audit trail, and two runs
// sharing a run_id would break the `grep <run_id>` verification contract. The
// time prefix additionally makes the log self-sorting and lets a stale/replayed
// id be spotted. Format stays 'ac-<hex>' and length is not fixed — every
// consumer parses the receipt as JSON, none slices a fixed width.
function makeRunId() {
    const secs = Math.floor(Date.now() / 1000).toString(16).padStart(8, '0');
    return 'ac-' + secs + crypto.randomBytes(8).toString('hex');
}

/**
 * Build, persist, and (optionally) print a receipt.
 *
 * @param {object} o
 * @param {string} o.skillDir  absolute dir of the invoking skill
 *                             (receipts land in <skillDir>/data/receipts.jsonl)
 * @param {string} o.skill     skill name as it should appear in the receipt
 * @param {string} o.runId     from makeRunId(), generated once per invocation
 * @param {object} [o.fields]  extra fields (exit, provider_used, total_ms, ...)
 * @param {'stdout'|'stderr'|null} [o.stream='stderr']
 *                             where to print the [receipt] line (null = only
 *                             persist, caller embeds the object itself)
 * @returns {object} the receipt object
 */
function emitReceipt({ skillDir, skill, runId, fields = {}, stream = 'stderr' }) {
    const receipt = {
        run_id: runId,
        skill,
        timestamp: new Date().toISOString(),
        ...fields,
    };
    // A receipt is emitted on the SUCCESS path, after the AI response has often
    // already been written to stdout. Nothing here may throw, or a completed run
    // flips to exit≠0 and IndependentTasks treats it as a provider failure. Two
    // residual throw sites are closed: (1) JSON.stringify on a caller-supplied
    // `fields` that happens to be circular, and (2) a stdout/stderr write racing
    // a dead parent (EPIPE). Both are now swallowed — the persisted line in
    // receipts.jsonl remains the source of truth for the audit contract.
    let line;
    try {
        line = JSON.stringify(receipt);
    } catch (_) {
        // Circular/unserializable extra field — fall back to the guaranteed core
        // so the run still gets a greppable, auditable receipt.
        line = JSON.stringify({ run_id: runId, skill, timestamp: receipt.timestamp });
    }
    // Persist first — the audit trail must survive even if the print is lost
    // (best-effort inside appendWithRotation; never throws).
    appendWithRotation(path.join(skillDir, 'data', 'receipts.jsonl'), line + '\n');
    const out = `[receipt] AGENTCHAT_RUN ${line}\n`;
    try {
        if (stream === 'stdout') process.stdout.write(out);
        else if (stream === 'stderr') process.stderr.write(out);
    } catch (_) { /* parent gone / EPIPE — persisted copy above suffices */ }
    return receipt;
}

module.exports = { makeRunId, emitReceipt };
