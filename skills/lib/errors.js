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
// Stage enum — which step in the 9-step pipeline failed
// ══════════════════════════════════════════════════════════════════════════════

const STAGES = Object.freeze({
    NAVIGATE:       'navigate',
    AUTH_CHECK:     'auth_check',
    QUOTA_CHECK:    'quota_check',
    PRE_EDITOR:     'pre_editor',      // e.g., Gemini Pro Extended activation
    EDITOR_FIND:    'editor_find',
    EDITOR_TYPE:    'editor_type',
    SEND:           'send',
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
        this.stage = opts.stage || 'unknown';
        this.provider = opts.provider || 'unknown';
    }

    /**
     * Convert to the { success: false, ... } result shape expected by tryAllProviders.
     */
    toResult(reason = REASONS.ERROR) {
        return {
            success: false,
            reason,
            error_details: {
                name: this.originalName,
                message: this.message,
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
    return pe.toResult(reason || REASONS.ERROR);
}

module.exports = {
    ProviderError,
    classifyError,
    STAGES,
    REASONS,
};
