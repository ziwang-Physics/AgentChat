/**
 * Shared terminal utilities — spinner, timer, log line management.
 *
 * Used by all skills (OneWeb, IndependentTasks).
 * Eliminates ~80 lines of duplicated \r\x1b[K + spinner frame logic.
 *
 * v2 (2026-07-03): Timer handle pattern — startTimer() returns {stop}
 * instead of relying on a module-level global singleton.  Each caller
 * manages its own timer lifecycle, preventing cross-invocation races.
 */

// ── Log with spinner clearing ────────────────────────────────────────────────

// TTY detection — when stderr is a PIPE (every subprocess spawned by
// lib/execute.js), ANSI clear sequences and 10Hz spinner frames are pure
// noise: they inflate the parent's 1MB stderr capture buffer (risking
// truncation of the "USED" marker the executor greps for) and garble logs.
const IS_TTY = Boolean(process.stderr.isTTY);

function log(prefix, msg) {
    if (IS_TTY) process.stderr.write('\r\x1b[K'); // clear spinner line
    process.stderr.write(`[${prefix}] ${msg}\n`);
}

// ── Elapsed timer with braille spinner ───────────────────────────────────────

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * Start an elapsed timer with braille-spinner display on stderr.
 * Returns a handle so the caller controls lifecycle — no global state.
 *
 * @param {string} prefix  — log prefix shown in brackets
 * @param {string} label   — description shown next to spinner
 * @returns {{ stop: () => void }}
 */
function startTimer(prefix, label) {
    // Non-TTY: no live spinner — return an inert handle. Frames written at
    // 10Hz into a pipe accumulate ~400 B/s for the entire provider run.
    if (!IS_TTY) return { stop() {} };
    const startTime = Date.now();
    let i = 0;
    const interval = setInterval(() => {
        const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
        const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
        const secs = String(elapsedSec % 60).padStart(2, '0');
        process.stderr.write(`\r[${prefix}] ${SPINNER_FRAMES[i]} ${label} (${mins}:${secs})`);
        i = (i + 1) % SPINNER_FRAMES.length;
    }, 100);
    return {
        stop() {
            clearInterval(interval);
            process.stderr.write('\r\x1b[K'); // clear spinner line
        }
    };
}

// ── Progress spinner (single char, no timer) ─────────────────────────────────

function spinner(ch) {
    if (IS_TTY) process.stderr.write(ch);
}

module.exports = { log, startTimer, spinner };
