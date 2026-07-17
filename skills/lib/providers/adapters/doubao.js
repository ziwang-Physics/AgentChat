/**
 * Doubao (豆包) provider adapter config.
 *
 * ByteDance's AI chatbot at doubao.com.
 * Uses a React SPA with CSS modules (Semi Design / custom design system).
 *
 * Key DOM structure:
 *   - Editor: textarea[placeholder*="发消息"] (Semi Design autosize textarea)
 *   - Send: #flow-end-msg-send button (only visible after typing), fallback Ctrl+Enter
 *   - Response: [class*="message-list"] [class*="md-box-root"]
 *     - User messages are in flex justify-end with bg-g-send-msg-bubble-bg
 *     - Assistant messages are left-aligned, same md-box-root container
 *     - Both have data-streaming="false" when complete
 */

const { COMMON_DISMISS_PATTERNS } = require('../../providerFactory');

const RESPONSE_SELECTORS = [
    // v1: message-list → md-box-root is the semantic content container.
    // Both user and assistant use the same class; the factory's .last()
    // resolves to the most recent message. The echo guard filters out
    // user-message hits (text near-identical to prompt).
    '[class*="message-list"] [class*="md-box-root"]',
    '[class*="md-box-root"]',
    // Generic fallbacks
    '[class*="markdown"]',
    '[class*="content"]',
];

module.exports = {
    key: 'doubao',
    url: 'https://www.doubao.com/chat/',
    navPostDelay: 4000, // React SPA render time
    authDomains: ['doubao.com/login', 'www.doubao.com/login', 'sso.doubao.com'],
    quotaPatterns: [
        /高峰.*算力.*不足/i,
        /(?:额度|次数|用完|用尽|不够|上限).{0,30}(?:升级|充值)/i,
        /额度.*(?:已|用).*(?:完|尽|满)/i,
        /今日.*(?:次数|额度).*(?:已|用).*(?:完|尽)/i,
        /请.*(?:稍后|明天).*(?:再试|重试)/i,
    ],
    dismissPatterns: [
        ...COMMON_DISMISS_PATTERNS,
        /版本.*更新/i,
        /下载.*(?:电脑版|App)/i,
        /打开.*App/i,
    ],

    editorSelectors: [
        'textarea[placeholder*="发消息"]',
        'textarea[placeholder*="输入"]',
        'textarea[placeholder*="消息"]',
        '#input-engine-container textarea',
        'textarea',
        '[contenteditable="true"]',
    ],

    // Doubao's textarea treats Enter as newline, NOT send.
    // The send button is #flow-end-msg-send — a round icon button inside
    // #input-engine-container with an SVG arrow icon.
    sendSelectors: [
        '#flow-end-msg-send',
        '#input-engine-container button:first-of-type',
        '#input-engine-container button',
    ],
    sendFallback: 'ControlOrMeta+Enter',

    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 8_000,
    minResponseLength: 5,
};