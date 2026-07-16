/**
 * DeepSeek provider adapter config.
 *
 * Standard pipeline with DeepSeek-specific DOM selectors.
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = [
    '.ds-markdown',
    '.ds-assistant-message-main-content',
    '[class*="ds-markdown"]',
    // v10: all three above share the ds- class family — one CSS-module
    // rename kills them together. Generic tail is only reached when the
    // specific ones fail (per-selector wait is budget-clamped upstream).
    '[class*="markdown"]',
];

module.exports = {
    key: 'deepseek',
    url: 'https://chat.deepseek.com/',
    navPostDelay: 3000,
    authDomains: ['chat.deepseek.com/login', 'deepseek.com/login'],
    quotaPatterns: [
        ...COMMON_CN_QUOTA_PATTERNS,
        /rate\s*limit/i,
    ],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS],
    editorSelectors: [
        // v10: the two placeholder-anchored selectors were the ONLY entries —
        // placeholder COPY is the most volatile selector anchor there is
        // (marketing tweaks it freely, and an EN-locale UI never matches the
        // Chinese string at all). One copy change = whole provider dead at
        // EDITOR_FIND. Specific-first order preserved; structural fallbacks
        // appended (validateEditor + the factory's heuristic rescue gate them).
        'textarea[placeholder*="给 DeepSeek 发送消息"]',
        'textarea[placeholder*="DeepSeek"]',
        'textarea[placeholder*="Message"]',   // EN locale
        '#chat-input',                        // historical stable id
        'textarea',
        '[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"]',
    ],
    sendSelectors: ['.ds-button--primary.ds-button--filled.ds-button--circle'],
    sendFallback: 'Enter',
    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 12_000,
    minResponseLength: 5,

    // v11: R1 深度思考 stalls text mid-fold ("思考中…", collapsing reasoning
    // panel shrinks innerText) and 联网搜索 has the same fetch-silence windows
    // as Kimi. Shared detector + factory shrink-fingerprint cover both;
    // hold cap bounds any false positive.
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 150_000,
};
