/**
 * Structured Error Objects — ProviderError with pipeline stage tracking.
 *
 * Replaces the generic `{ success: false, reason: 'error' }` pattern that
 * swallows error name, message, stack, and pipeline stage information.
 *
 * Usage:
 *   const pe = new ProviderError(err, { stage: 'editor_find', provider: 'gemini' });
 *   return pe.toResult();  // → { success: false, reason: 'error', error_details: {...} }
 */

// ══════════════════════════════════════════════════════════════════════════════
// Stage enum — which step in the provider pipeline failed
// ══════════════════════════════════════════════════════════════════════════════

const STAGES = Object.freeze({
    NAVIGATE:       'navigate',
    AUTH_CHECK:     'auth_check',
    QUOTA_CHECK:    'quota_check',
    OVERLAY_CHECK:  'overlay_check',   // modal/dialog blocking editor
    PRE_EDITOR:     'pre_editor',      // e.g., Gemini Pro Extended activation
    EDITOR_FIND:    'editor_find',
    INPUT:          'input',           // typing/pasting the prompt into the editor
    SEND:           'send',            // clicking send / pressing fallback key
    WAIT_RESPONSE:  'wait_response',
    EXTRACT:        'extract',
});

// ══════════════════════════════════════════════════════════════════════════════
// Valid fallback reason strings (used by the orchestrator to classify failures)
// ══════════════════════════════════════════════════════════════════════════════

const REASONS = Object.freeze({
    QUOTA:   'quota',
    AUTH:    'auth',
    ERROR:   'error',
    TIMEOUT: 'timeout',
    SAFETY:  'safety',
});

// ══════════════════════════════════════════════════════════════════════════════
// Adapter error codes — providers throw `Object.assign(new Error(...), {code})`
// (see lib/providers/adapters/gemini.js) to signal a specific failure kind from
// inside a hook (preInputHook/postResponseHook). This maps those codes to the
// REASONS the orchestrator understands. Without this map, any such .code was
// silently discarded and every hook-thrown error collapsed into 'error'.
// ══════════════════════════════════════════════════════════════════════════════

const CODE_TO_REASON = Object.freeze({
    ERR_SAFETY_REJECTED: REASONS.SAFETY,
    ERR_MODEL_DEGRADED:  REASONS.ERROR,
    // Landing on the wrong page after navigating to the RIGHT url means a
    // human must intervene in the shared browser (CAPTCHA/consent/redirect) —
    // operationally identical to auth. Was ERROR, which collapsed into
    // exit 9 (all_exhausted) and hid the recovery action.
    ERR_WRONG_PAGE:      REASONS.AUTH,
});

// ══════════════════════════════════════════════════════════════════════════════
// ProviderError — captures full diagnostic context
// ══════════════════════════════════════════════════════════════════════════════

class ProviderError extends Error {
    /**
     * @param {Error|string} cause  — original error or message
     * @param {object} opts
     * @param {string} opts.stage    — pipeline stage (from STAGES)
     * @param {string} opts.provider — provider key (gemini, chatgpt, etc.)
     */
    constructor(cause, opts = {}) {
        const message = typeof cause === 'string' ? cause : (cause.message || 'Unknown error');
        super(message);
        this.name = 'ProviderError';
        this.originalName = (cause && cause.name) || 'Error';
        this.originalStack = (cause && cause.stack) || '';
        this.code = (cause && cause.code) || null;
        this.stage = opts.stage || 'unknown';
        this.provider = opts.provider || 'unknown';
    }

    /**
     * Convert to the { success: false, ... } result shape expected by tryAllProviders.
     *
     * Reason resolution order: explicit `reason` arg > CODE_TO_REASON[this.code] > 'error'.
     * This lets adapter hooks (e.g. Gemini's postResponseHook throwing with
     * `code: 'ERR_SAFETY_REJECTED'`) surface as reason='safety' without every call
     * site having to know about every adapter's custom error codes.
     */
    toResult(reason) {
        const resolvedReason = reason || CODE_TO_REASON[this.code] || REASONS.ERROR;
        return {
            success: false,
            reason: resolvedReason,
            error_details: {
                name: this.originalName,
                message: this.message,
                code: this.code,
                stage: this.stage,
                provider: this.provider,
                // Truncated stack — full stack in telemetry
                stack_preview: this.originalStack.split('\n').slice(0, 3).join('\n'),
            },
        };
    }
}

// ══════════════════════════════════════════════════════════════════════════════
// Convenience: classify + convert in one call
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Wrap an error in ProviderError and return the result object.
 *
 * @param {Error} err         — caught error
 * @param {string} stage       — pipeline stage (from STAGES)
 * @param {string} provider    — provider key
 * @param {string} [reason]    — fallback reason (default: 'error')
 * @returns {{ success: false, reason, error_details }}
 */
function classifyError(err, stage, provider, reason) {
    const pe = new ProviderError(err, { stage, provider });
    return pe.toResult(reason);
}

module.exports = {
    ProviderError,
    classifyError,
    STAGES,
    REASONS,
    CODE_TO_REASON,
};
