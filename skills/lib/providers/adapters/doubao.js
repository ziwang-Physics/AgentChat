/**
 * Doubao (豆包) provider adapter config — 2026-08-10 国内化新增.
 *
 * 豆包网页版 (www.doubao.com/chat/) 为 React SPA。
 * 2026-08-10 实测精修: AI 回复渲染于 `.md-box-root`（markdown 容器，中央区），
 * 侧边栏历史列表含大量 avatar/UI 图——图片扫描必须限定在 md-box-root 内。
 * 发送走 Enter（按钮为 Tailwind 通用类，不可靠）。
 */

const { COMMON_CN_QUOTA_PATTERNS, COMMON_DISMISS_PATTERNS } = require('../../providerFactory');
const { makeStillWorkingCheck } = require('../../stillWorking');

// Hoisted so the still-working probe judges the same container family the
// factory polls (see kimi.js v11 note).
const RESPONSE_SELECTORS = [
    '[class*="md-box-root"]',     // 实测: AI markdown 回复容器（2026-08-10 实测确认）
    '[class*="markdown"]',
    '[class*="answer"]',
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
    // 实测: 豆包对"只回复X字"指令会如实返回极短回复（如 2 字符），默认 5 会误判空
    minResponseLength: 2,
    // 实测: 侧边栏历史列表含大量 avatar/UI 图 — 图片扫描限定在回复容器内
    imageScopeSelector: '[class*="md-box-root"]',
    stillGeneratingCheck: makeStillWorkingCheck({ responseSelectors: RESPONSE_SELECTORS }),
    stillGeneratingMaxHoldMs: 120_000,
};
