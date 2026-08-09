/**
 * Doubao (豆包) provider adapter config — 2026-08-10 国内化新增.
 *
 * 豆包网页版 (www.doubao.com/chat/) 为 React SPA，无真实 DOM 选择器依据，
 * 采用通用模式：编辑器优先 contenteditable/textarea + ARIA tier/启发式兜底，
 * 发送走 Enter，响应取 markdown 容器族。首次实跑后按
 * data/selector_drift.jsonl 诊断精修（工厂自愈机制见 providerFactory.js）。
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = [
    '[class*="answer"]',
    '[class*="markdown"]',
    '[class*="message"]',
    '[class*="chat-item"]',
    '[data-testid*="assistant"]',
];

module.exports = {
    key: 'doubao',
    url: 'https://www.doubao.com/chat/',
    navPostDelay: 3000, // React SPA mount
    authDomains: ['doubao.com/login', 'sso.doubao.com', 'login.doubao.com', 'oceanapi.com/login'],
    quotaPatterns: [...COMMON_CN_QUOTA_PATTERNS],
    dismissPatterns: [...COMMON_DISMISS_PATTERNS, /提示/i, /福利/i],
    editorSelectors: [
        'textarea[placeholder*="豆包"]',
        '[contenteditable="true"][role="textbox"]',
        'textarea',
        '[contenteditable="true"]',
        '[role="textbox"]',
    ],
    validateEditor: async (loc) => {
        return loc.evaluate(el => {
            if (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') {
                return !el.hasAttribute('readonly') && !el.hasAttribute('disabled');
            }
            return el.getAttribute('contenteditable') !== 'false'
                && !el.hasAttribute('readonly')
                && !el.hasAttribute('disabled');
        });
    },
    // 通用按钮类名不可靠 — Enter 为主，按钮为辅
    sendSelectors: ['[class*="send"]', '[class*="submit"]', 'button[type="submit"]'],
    sendFallback: 'Enter',
    responseSelectors: RESPONSE_SELECTORS,
    responseSelectorTimeout: 60_000,
    stabilityWindow: 10_000,
    minResponseLength: 5,
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
};
