/**
 * MiniMax provider adapter config.
 *
 * Key differences from standard pipeline:
 *   - TipTap/ProseMirror editor mounts async — needs 4s navPostDelay
 *   - Send trigger is <div aria-label="发送消息"> (non-button element)
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = [
    '[class*="message-content"]', '[class*="matrix-markdown"]',
    '.markdown-body', '[class*="answer"]', '[class*="response"]',
];

module.exports = {
    key: 'minimax',
    url: 'https://agent.minimaxi.com/',
    navPostDelay: 4000, // TipTap/ProseMirror mounts async
    authDomains: ['agent.minimaxi.com/login', 'minimax.com/login'],
    quotaPatterns: [...COMMON_CN_QUOTA_PATTERNS],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS],
    editorSelectors: [
        '[class*="ProseMirror"]', '[class*="tiptap"]', 'textarea',
        '[contenteditable="true"]', '[role="textbox"]', '[class*="editor"]',
    ],
    sendSelectors: ['[aria-label="发送消息"]', '[class*="send"]', '[class*="submit"]'],
    sendFallback: 'Enter',
    responseSelectors: RESPONSE_SELECTORS,
    stabilityWindow: 10_000,
    responseFormat: 'markdown',
    minResponseLength: 5,

    // v11: agent.minimaxi.com is an AGENTIC product — tool/browse phases stall
    // text for tens of seconds exactly like Kimi 联网搜索 (same truncation
    // class). No stopSelectors are known for this UI, so the shared detector
    // (stop control / spinner / CN+EN status vocabulary) is the completion
    // guard; false positives are bounded by the hold cap.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 150_000,
};
