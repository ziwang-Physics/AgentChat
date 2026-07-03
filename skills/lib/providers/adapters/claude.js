/**
 * Claude provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - ProseMirror contenteditable editor (validateEditor ensures it's actually editable)
 *   - Stop button may not appear for fast responses — factory handles this gracefully
 *   - postResponseHook strips "Thinking" placeholder + embedded search-result blocks
 */

module.exports = {
    key: 'claude',
    url: 'https://claude.ai/',
    authDomains: ['claude.ai/login', 'auth.anthropic.com'],
    quotaPatterns: [
        /rate\s*limit\s*(?:exceeded|reached)/i,
        /out\s*of\s*messages/i,
        /messages?\s*remaining[:\s]*0/i,
        /usage\s*limit/i,
        // BUGFIX: bare /please\s*wait/i matched generic "Please wait..." loading
        // text and misclassified a perfectly available Claude as quota-exhausted.
        // Only treat it as quota when tied to a rate-limit context.
        /please\s*wait\s*(?:\d+|a few|until|before\s+sending)/i,
    ],
    dismissPatterns: [
        /what'?s\s*new/i, /new\s*feature/i, /try\s*(?:the\s*)?new/i,
        /introducing/i, /welcome/i, /announcement/i,
    ],
    editorSelectors: [
        '[contenteditable="true"]',
        '.ProseMirror',
        'div[role="textbox"]',
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el =>
            el.getAttribute('contenteditable') !== 'false'
            && !el.hasAttribute('readonly')
            && !el.hasAttribute('disabled')
        );
    },
    sendSelectors: [
        'button[aria-label="Send message"]',
        'button[aria-label="Send Message"]',
        'button[aria-label="Send"]',
    ],
    sendFallback: 'Enter',
    stopSelectors: [
        'button[aria-label="Stop"]',
        'button[aria-label="Stop generating"]',
        'button[aria-label*="Stop"]',
        '[data-testid="stop-button"]',
    ],
    responseSelectors: [
        '.prose',
        '[class*="font-claude-message"]',
        '[class*="msg-content"]',
        '[class*="msg-assistant"]',
        '[class*="message"]',
    ],
    stabilityWindow: 10_000,
    minResponseLength: 5,

    // ── Post-processing: strip "Thinking" placeholder + search-result blocks ──
    postResponseHook: async (_page, text) => {
        let cleaned = text.replace(
            /^(Thinking|Analyzing|Reasoning|思考中|分析中)\.{0,3}\s*/gim, ''
        ).trim();

        // Strip embedded search-result blocks
        const SEARCH_HEADER_RE = /\n\d+\s+results?\s*\n/i;
        const searchIdx = cleaned.search(SEARCH_HEADER_RE);
        if (searchIdx > -1) {
            const afterResults = cleaned.substring(searchIdx).search(/\n\s*\n\S/);
            if (afterResults > -1) {
                const cutPoint = searchIdx + afterResults + 1;
                const kept = cleaned.substring(cutPoint).trim();
                if (kept.length > 20) cleaned = kept;
            }
        }

        // Reject placeholder-only responses (returns empty → fails minResponseLength downstream).
        // BUGFIX: previously also rejected anything under 30 chars via `check.length < 30`,
        // which contradicted this adapter's own `minResponseLength: 5` and silently discarded
        // legitimate short answers (e.g. a one-word confirmation or a bare number). The
        // anchored placeholder patterns below already correctly identify placeholder-only
        // text (they require the ENTIRE trimmed response to match), so the extra length
        // gate was redundant as well as wrong.
        const placeholderPatterns = [
            /^Thinking\.{0,3}\s*$/i, /^Analyzing\.{0,3}\s*$/i,
            /^Reasoning\.{0,3}\s*$/i, /^思考中\.{0,3}\s*$/i,
            /^分析中\.{0,3}\s*$/i,
        ];
        const check = cleaned.replace(/[\s\n]+/g, ' ').trim();
        if (placeholderPatterns.some(p => p.test(check))) {
            return '';
        }
        return cleaned;
    },
};
