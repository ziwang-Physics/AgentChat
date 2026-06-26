/**
 * Gemini Web UI — 多语言选择器配置文件
 *
 * Gemini 的 UI 会根据用户的 Google 账号语言设置渲染不同的文本。
 * 此模块将本地化字符串集中管理，使核心逻辑与 Gemini UI 的变更解耦。
 *
 * 添加新语言：只需在此文件追加一个 profile 条目即可。
 * 未知 locale 会自动回退到模糊正则匹配。
 *
 * 最后更新: 2026-06-26 — 基于 Gemini UI 3.1 版本验证
 */

// ─── 语言 profiles ──────────────────────────────────────────────────────────
//
// 每个 key 的含义：
//   modelAria    → 模型选择器按钮的 aria-label 子串
//   modelVerify  → 按钮文本中包含此字符串表示 Pro Extended 已激活
//   proText      → "Pro" 模型菜单项文本（排除 Flash）
//   thinkText    → "思考等级/Thinking" 菜单项文本
//   extendedText → "扩展/Extended" 菜单项文本（排除思考等级自身）
//   standardText → "标准/Standard" 菜单项文本
//   sendAria     → 发送按钮的 aria-label 子串
//   stopAria     → 停止生成按钮的 aria-label 子串
//   copyAria     → 复制按钮的 aria-label 子串
//   goodAria     → "好答案/Good response" 按钮的 aria-label 子串

const PROFILES = {
    "zh-CN": {
        modelAria:    "打开模式选择器",
        modelVerify:  "Pro扩展",
        proText:      "Pro",
        thinkText:    "思考等级",
        extendedText: "扩展",
        standardText: "标准",
        sendAria:     "发送",
        stopAria:     "停止",
        copyAria:     "复制",
        goodAria:     "好答案",
    },
    "zh-TW": {
        modelAria:    "開啟模式挑選器",
        modelVerify:  "Pro延長",
        proText:      "Pro",
        thinkText:    "思考程度",
        extendedText: "延長",
        standardText: "標準",
        sendAria:     "傳送",
        stopAria:     "停止",
        copyAria:     "複製",
        goodAria:     "好答案",
    },
    "en": {
        modelAria:    "Model selector",
        modelVerify:  "Pro Extended",
        proText:      "Pro",
        thinkText:    "Thinking",
        extendedText: "Extended",
        standardText: "Standard",
        sendAria:     "Send",
        stopAria:     "Stop",
        copyAria:     "Copy",
        goodAria:     "Good response",
    },
};

// ─── 模糊回退正则（未知 locale 时使用）──────────────────────────────────────

const FUZZY = {
    modelAria:    /模式选择器|模式挑選器|Model selector/i,
    modelVerify:  /Pro\s*(扩展|延長|Extended)/i,
    proText:      /Pro/i,
    thinkText:    /思考|Thought/i,
    extendedText: /扩展|延長|Extended/i,
    standardText: /标准|標準|Standard/i,
    sendAria:     /发送|傳送|Send/i,
    stopAria:     /停止|Stop/i,
    copyAria:     /复制|複製|Copy/i,
    goodAria:     /好答案|Good response/i,
};

// ─── 不变的 CSS 选择器（与语言无关）─────────────────────────────────────────

const STATIC = {
    menuContainer:     '[role="menu"]',
    menuItem:          '[role="menuitem"]',
    overlayBackdrop:   '.cdk-overlay-backdrop',
    editor:            '.ql-editor, [contenteditable="true"][role="textbox"], rich-textarea',
    editorFallback:    '.ql-editor, [contenteditable="true"], rich-textarea',
    responseContainer: '.model-response-text',
};

// ─── 解析后的 profile（运行时填充）──────────────────────────────────────────

/** @type {typeof PROFILES[keyof typeof PROFILES] | null} */
let activeProfile = null;

/** @type {string | null} */
let detectedLocale = null;

// ─── API ────────────────────────────────────────────────────────────────────

/**
 * 从 Gemini 页面自动检测 locale。
 * 优先级：navigator.language → <html lang> → 回退 null（走 FUZZY）
 *
 * @param {import('playwright-core').Page} page
 * @returns {Promise<string|null>} 检测到的 locale 代码，如 "zh-CN"
 */
async function detectLocale(page) {
    try {
        // 方法 1：浏览器 navigator.language
        const navLang = await page.evaluate(() => navigator.language || '');
        if (navLang && PROFILES[navLang]) return navLang;

        // 方法 2：<html lang="..."> 属性
        const docLang = await page.evaluate(() =>
            document.documentElement.getAttribute('lang') || ''
        );
        if (docLang && PROFILES[docLang]) return docLang;

        // 方法 3：从模型选择器按钮文本反向推断
        const btnText = await page.evaluate(() => {
            const btn = document.querySelector(
                'button[aria-label*="模式"], button[aria-label*="Model"]'
            );
            return btn ? btn.textContent.trim() : '';
        });

        // 按钮文本中包含 "扩展" → zh-CN；"延長" → zh-TW；"Extended" → en
        if (btnText.includes('扩展')) return 'zh-CN';
        if (btnText.includes('延長')) return 'zh-TW';
        if (btnText.includes('Extended')) return 'en';

        return null; // 回退到 FUZZY
    } catch {
        return null;
    }
}

/**
 * 设置当前 locale（由 CLI --locale 标志或 auto-detect 调用）。
 *
 * @param {string|null} locale 如 "zh-CN"、null 表示回退
 * @returns {string} 实际使用的 locale 标识
 */
function setLocale(locale) {
    if (locale && PROFILES[locale]) {
        activeProfile = PROFILES[locale];
        detectedLocale = locale;
    } else {
        activeProfile = null;
        detectedLocale = null;
    }
    return detectedLocale || 'fuzzy-fallback';
}

/**
 * 获取 selector 值。优先精确 profile，回退模糊正则。
 *
 * @param {keyof typeof FUZZY} key 选择器键名
 * @returns {string|RegExp}
 */
function sel(key) {
    if (activeProfile && activeProfile[key]) return activeProfile[key];
    return FUZZY[key];
}

/**
 * 构建 aria-label CSS 选择器字符串。
 * 用于 page.locator() 的 CSS 选择器参数。
 *
 * @param {keyof typeof FUZZY} key
 * @returns {string} CSS 选择器，如 'button[aria-label*="发送"]'
 */
function ariaCSS(key) {
    const val = activeProfile?.[key];
    if (val && typeof val === 'string') {
        return `button[aria-label*="${val}"]`;
    }
    // 回退：拼接所有已知 profiles 的 CSS 选择器
    const parts = [];
    for (const p of Object.values(PROFILES)) {
        if (p[key] && typeof p[key] === 'string') {
            parts.push(`button[aria-label*="${p[key]}"]`);
        }
    }
    return parts.join(', ') || `button`;
}

/**
 * 获取用于 locator.filter({ hasText: ... }) 的文本模式。
 *
 * @param {keyof typeof FUZZY} key
 * @returns {string|RegExp}
 */
function menuPattern(key) {
    return sel(key);
}

/**
 * 获取用于 String.includes() 验证的文本。
 * 始终返回字符串（不使用 RegExp）。
 *
 * @param {keyof typeof FUZZY} key
 * @returns {string}
 */
function verifyStr(key) {
    const val = activeProfile?.[key];
    if (val && typeof val === 'string') return val;
    // 回退：返回第一个已知 profile 的字符串值
    for (const p of Object.values(PROFILES)) {
        if (p[key] && typeof p[key] === 'string') return p[key];
    }
    return '';
}

// ─── 导出 ───────────────────────────────────────────────────────────────────

module.exports = {
    PROFILES,
    FUZZY,
    STATIC,
    detectLocale,
    setLocale,
    sel,
    ariaCSS,
    menuPattern,
    verifyStr,
    get activeProfile()  { return activeProfile; },
    get detectedLocale() { return detectedLocale; },
};
