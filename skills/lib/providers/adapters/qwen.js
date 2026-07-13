/**
 * Qwen (通义千问) provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - React/Tailwind SPA — needs 3s navPostDelay for mount
 *   - Buttons have Tailwind generic classes — no reliable send selectors
 *   - Stop button removed from DOM (detached) when done, not just hidden
 *   - postResponseHook strips model-name prefix (e.g. "Qwen3.7-Max\n")
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');

module.exports = {
    key: 'qwen',
    url: 'https://www.qianwen.com/?source=tongyigw',
    navPostDelay: 3000, // React-based SPA needs time to mount
    authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'],
    quotaPatterns: [...COMMON_CN_QUOTA_PATTERNS],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS, /提示/i],
    editorSelectors: [
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
        'textarea',
        '[role="textbox"]',
        '[class*="editor"]',
    ],
    // Qwen's buttons have Tailwind generic classes — Enter is the only reliable send
    sendSelectors: [],
    sendFallback: 'Enter',
    stopWaitMode: 'detached', // Qwen removes stop button from DOM when done
    stopSelectors: ['[class*="stop"]', '[class*="pause-generat"]'],
    responseSelectors: [
        '[class*="message-select-wrapper-answer"]',
        '[class*="chat-answers-card-wrap"]',
        '[class*="message-select-content-inner"]',
        '[class*="message-select-content"]',
        '.chat-round.last-message-item',
        // v10: generic tails — four of the five above share the
        // message-select naming family; a single rename kills them together.
        '[class*="answer"]',
        '[class*="markdown"]',
    ],
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 5,
    postResponseHook: async (_page, text) =>
        text.replace(/^Qwen[\d.]+-(?:Max|Plus|Turbo|Flash)\s*\n?\s*/i, '').trim(),
};
