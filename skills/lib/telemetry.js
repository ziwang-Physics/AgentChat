/**
 * Shared telemetry — log rotation and file append.
 *
 * Previously duplicated verbatim in providerFactory.js and gemini/index.js.
 */

const fs = require('fs');
const path = require('path');

const MAX_TELEMETRY_BYTES = 10 * 1024 * 1024; // 10 MB
const MAX_ROTATIONS = 3;

/**
 * Append a line to a telemetry file, rotating if it exceeds the size limit.
 * Rotations: file → file.1 → file.2 → file.3 (discarded).
 *
 * @param {string} filePath — path to the telemetry log file
 * @param {string} line — JSON line to append (include trailing \n)
 */
function appendWithRotation(filePath, line) {
    // P1-14: ensure the parent directory exists before writing — otherwise
    // telemetry is silently lost when data/ hasn't been created yet.
    try { fs.mkdirSync(path.dirname(filePath), { recursive: true }); } catch (_) {}
    try {
        if (fs.existsSync(filePath) && fs.statSync(filePath).size > MAX_TELEMETRY_BYTES) {
            // Shift rotations: .2→.3, .1→.2, file→.1
            // BUGFIX: was `MAX_ROTATIONS - 1`, which starts the loop one level too
            // shallow — it only ever did .1→.2 and file→.1, so the oldest rotation
            // (.2) was silently clobbered instead of being preserved to .3.
            for (let i = MAX_ROTATIONS; i >= 1; i--) {
                const oldPath = i === 1 ? filePath : `${filePath}.${i - 1}`;
                const newPath = `${filePath}.${i}`;
                try { if (fs.existsSync(oldPath)) fs.renameSync(oldPath, newPath); } catch (_) {}
            }
        }
    } catch (_) { /* rotation is best-effort */ }
    // The append must also be best-effort: if the skill dir is read-only
    // (common for Claude Code skill mounts) or the disk is full, a throw here
    // used to propagate AFTER the response was already printed to stdout,
    // flipping a successful run into exit 4 — which IndependentTasks then treated
    // as a provider failure. Telemetry loss must never fail the invocation.
    try {
        fs.appendFileSync(filePath, line);
    } catch (_) { /* telemetry is best-effort */ }
}

module.exports = { appendWithRotation, MAX_TELEMETRY_BYTES, MAX_ROTATIONS };
