/**
 * Structured Logger — JSONL logging with CLI spinner separation.
 *
 * Spinner frames go ONLY to stderr (same as before).
 * Diagnostic events are written as structured JSONL to a log file.
 *
 * Usage:
 *   const { createLogger } = require('../lib/logger');
 *   const logger = createLogger('web-extended');
 *   logger.log('Connecting to CDP...');
 *   logger.startTimer('Gemini');
 *   logger.stopTimer();
 *   logger.recordEvent({ event: 'provider_success', provider: 'gemini', chars: 1234 });
 */

const fs = require('fs');
const path = require('path');

const LOG_FILE = '/tmp/agentchat-events.jsonl';

// ══════════════════════════════════════════════════════════════════════════════
// Low-level: write one JSON line to the shared event log
// ══════════════════════════════════════════════════════════════════════════════

function writeEvent(name, data) {
    const entry = {
        ts: new Date().toISOString(),
        skill: name,
        ...data,
    };
    try {
        fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + '\n');
    } catch (_) {
        // Log file not critical — silently ignore write failures
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Spinner (pure presentation, stderr only)
// ══════════════════════════════════════════════════════════════════════════════

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ══════════════════════════════════════════════════════════════════════════════
// createLogger — factory for a logger instance
// ══════════════════════════════════════════════════════════════════════════════

function createLogger(name) {
    let spinnerInterval = null;
    const prefix = `[${name}]`;

    /**
     * Write a diagnostic message to stderr (clears spinner first).
     */
    function log(msg) {
        process.stderr.write('\r\x1b[K'); // clear spinner line
        process.stderr.write(`${prefix} ${msg}\n`);
    }

    /**
     * Start elapsed-time spinner. Only one spinner active at a time per logger.
     */
    function startTimer(label) {
        if (spinnerInterval) clearInterval(spinnerInterval);
        const startTime = Date.now();
        let i = 0;
        spinnerInterval = setInterval(() => {
            const elapsedSec = Math.floor((Date.now() - startTime) / 1000);
            const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
            const secs = String(elapsedSec % 60).padStart(2, '0');
            process.stderr.write(`\r${prefix} ${FRAMES[i]} ${label} (${mins}:${secs})`);
            i = (i + 1) % FRAMES.length;
        }, 100);
    }

    /**
     * Stop the spinner and clear its line.
     */
    function stopTimer() {
        if (spinnerInterval) { clearInterval(spinnerInterval); spinnerInterval = null; }
        process.stderr.write('\r\x1b[K'); // clear spinner line
    }

    /**
     * Write a structured event to the JSONL log.
     */
    function recordEvent(data) {
        writeEvent(name, data);
    }

    return { log, startTimer, stopTimer, recordEvent };
}

module.exports = { createLogger, LOG_FILE };
