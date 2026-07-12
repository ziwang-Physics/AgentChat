/**
 * Gemini Web UI — 多语言选择器配置（集中管理，单源真相）
 *
 * 将 Gemini UI 中所有与语言相关的 DOM 文本集中管理。
 * 新增语言只需在此文件追加一个 profile；geminiModelSwitch 和 gemini adapter
 * 不再硬编码任何 langauge-specific 选择器。
 *
 * 每当你遇到一个新 locale 的 Gemini UI，只需：
 *   1. 打开 Gemini，观察界面上的按钮文字和菜单文字
 *   2. 在此文件追加一份 profile
 *   3. CLI 传 --locale=xx_XX 或让自动检测生效
 *
 * 最后更新: 2026-07-03
 */

// ═══════════════════════════════════════════════════════════════════════════
// 语言 profiles（精确匹配优先，未知 locale 回退 fuzzy）
// ═══════════════════════════════════════════════════════════════════════════

const PROFILES = {
    zh_CN: {
        // 模型选择器按钮 aria-label 子串
        modelAria:       '打开模式选择器',
        // 按钮文本校验 — Pro Extended 已激活的标志
        modelVerify:     'Pro扩展',
        // Pro 菜单项描述文本（区别于 Flash）
        proDesc:         '高等数学',
        // 思考等级/程度 菜单项文本（v9 扁平菜单中不再使用，保留兼容旧 UI）
        thinking:        '思考等级',
        // Extended / 扩展思考 菜单项文本（v9 扁平菜单：直接点击）
        extended:        '扩展思考',
        // Standard 文本
        standard:        '标准',
        // 发送按钮
        send:            '发送',
        // 停止按钮
        stop:            '停止',
        // 复制按钮
        copy:            '复制',
        // 好答案按钮
        good:            '好答案',
        // Flash-Lite 描述
        flashLiteDesc:   '极速回答',
    },

    zh_TW: {
        modelAria:       '開啟模式挑選器',
        modelVerify:     'Pro 延伸',   // v9: 新 UI 用「延伸」替代「延長」
        proDesc:         '進階',
        thinking:        '思考程度',
        extended:        '延伸思考',   // v9 扁平菜单：直接点击项
        standard:        '標準',
        send:            '傳送',
        stop:            '停止',
        copy:            '複製',
        good:            '好答案',
        flashLiteDesc:   '極速回答',
    },

    en: {
        modelAria:       'Model selector',
        modelVerify:     'Pro Extended',
        proDesc:         'Advanced',
        thinking:        'Thinking',
        extended:        'Extended thinking',  // v9 flat menu
        standard:        'Standard',
        send:            'Send',
        stop:            'Stop',
        copy:            'Copy',
        good:            'Good response',
        flashLiteDesc:   'Fast answers',
    },

    ja: {
        modelAria:       'モデルセレクターを開く',
        modelVerify:     'Pro 拡張',
        proDesc:         '高度な数学',
        thinking:        '思考レベル',
        extended:        '拡張思考',  // v9 flat menu
        standard:        '標準',
        send:            '送信',
        stop:            '停止',
        copy:            'コピー',
        good:            '良い回答',
        flashLiteDesc:   '高速回答',
    },
};

// ═══════════════════════════════════════════════════════════════════════════
// 模糊回退（未知 locale 时使用正则匹配全部已知文本）
// ═══════════════════════════════════════════════════════════════════════════

const FUZZY = {
    modelAria:    /打开模式选择器|開啟模式挑選器|Model selector|モデルセレクターを開く/i,
    modelVerify:  /Pro\s*(扩展|延長|Extended|拡張)/i,
    proDesc:      /進階|进阶|高等数学|Advanced|高度な数学/i,
    thinking:     /思考等级|思考程度|Thinking|Thought|思考レベル/i,
    extended:     /扩展思考|延伸思考|Extended thinking|拡張思考|扩展|延長|Extended|拡張/i,
    standard:     /标准|標準|Standard|標準/i,
    send:         /发送|傳送|Send|送信/i,
    stop:         /停止|Stop|停止/i,
    copy:         /复制|複製|Copy|コピー/i,
    good:         /好答案|Good response|良い回答/i,
};

// ═══════════════════════════════════════════════════════════════════════════
// 不变的 CSS 选择器（与语言无关）
// ═══════════════════════════════════════════════════════════════════════════

const STATIC = {
    menuContainer:   '[role="menu"]',
    menuItem:        'gem-menu-item, [role="menuitem"]',
    overlayBackdrop: '.cdk-overlay-backdrop',
    editor:          '.ql-editor, [contenteditable="true"][role="textbox"], rich-textarea',
    editorFallback:  '.ql-editor, [contenteditable="true"], rich-textarea',
    response:        '.model-response-text',
};

// ═══════════════════════════════════════════════════════════════════════════
// 运行时状态
// ═══════════════════════════════════════════════════════════════════════════

let _locale = null;   // 'zh_CN' | 'zh_TW' | 'en' | 'ja' | null (fuzzy)
let _profile = null;  // 当前使用的精确 profile（null = 回退 fuzzy）

// ═══════════════════════════════════════════════════════════════════════════
// API
// ═══════════════════════════════════════════════════════════════════════════

/**
 * 从 Gemini 页面自动检测 UI locale。
 * 优先级：navigator.language → <html lang> → 按钮文本反向推断 → null
 */
async function detectLocale(page) {
    try {
        // 方法 3（提升为验证步骤）：从模型选择器按钮的 aria-label + textContent 反向推断。
        // 按钮文本是 Gemini UI 实际语言的权威来源。navigator.language 可能与页面 UI
        // 不一致（如浏览器设置为 zh-CN 但 Gemini 页面是 zh-TW），此时以按钮文本为准
        // ——否则所有菜单项匹配（thinking/extended/proDesc）都会因 locale 错配而失败。
        const btnText = await page.evaluate(() => {
            const el = document.querySelector(
                'button[aria-label*="模式"], button[aria-label*="Model"], button[aria-label*="モデル"]'
            );
            if (!el) return '';
            return (el.getAttribute('aria-label') || '') + ' ' + (el.textContent || '');
        });

        const btnLocale = (() => {
            if (!btnText.trim()) return null;
            // aria-label 最可靠：'開啟模式挑選器' = zh_TW, '打开模式选择器' = zh_CN
            if (/開啟|挑選|延長/.test(btnText)) return 'zh_TW';
            if (/打开|选择|扩展/.test(btnText)) return 'zh_CN';
            if (/Model selector|Extended/.test(btnText)) return 'en';
            if (/モデル|拡張/.test(btnText)) return 'ja';
            return null;
        })();

        // 按钮文本权威最高 → 直接返回
        if (btnLocale && PROFILES[btnLocale]) return btnLocale;

        // 方法 1：navigator.language（仅当按钮文本无法判断时使用）
        const nav = await page.evaluate(() => navigator.language || '');
        const navLocale = mapBCP47(nav);

        // 方法 2：<html lang>
        const doc = await page.evaluate(() =>
            document.documentElement.getAttribute('lang') || ''
        );
        const docLocale = mapBCP47(doc);

        if (navLocale && PROFILES[navLocale]) return navLocale;
        if (docLocale && PROFILES[docLocale]) return docLocale;

        return null; // 回退模糊匹配
    } catch {
        return null;
    }
}

/** BCP47 (zh-CN) → 内部 locale key (zh_CN) */
function mapBCP47(tag) {
    if (!tag) return null;
    const t = tag.toLowerCase();
    if (t.startsWith('zh-cn') || t.startsWith('zh-hans')) return 'zh_CN';
    if (t.startsWith('zh-tw') || t.startsWith('zh-hant')) return 'zh_TW';
    if (t.startsWith('ja')) return 'ja';
    if (t.startsWith('en')) return 'en';
    return null;
}

/** 手动设置 locale（CLI --locale 覆盖） */
function setLocale(key) {
    if (key && PROFILES[key]) {
        _locale = key;
        _profile = PROFILES[key];
    } else {
        _locale = null;
        _profile = null;
    }
    return _locale || 'fuzzy';
}

/** 获取 selector 字符串值：精确 profile → fuzzy regex fallback */
function txt(key) {
    if (_profile && _profile[key]) return _profile[key];
    return FUZZY[key];
}

/** 构建 aria-label CSS 选择器 */
function ariaCSS(key) {
    if (_profile && _profile[key]) {
        return `button[aria-label*="${_profile[key]}"]`;
    }
    // 回退：拼接所有已知 profile 的关键字
    const parts = Object.values(PROFILES).map(p => {
        if (p[key]) return `button[aria-label*="${p[key]}"]`;
        return null;
    }).filter(Boolean);
    return parts.join(', ') || 'button';
}

/** locator.filter({ hasText }) 用的文本模式 */
function menuText(key) { return txt(key); }

/** String.includes() 验证用的纯字符串 */
function verifyText(key) {
    if (_profile && _profile[key]) return _profile[key];
    // 回退：取首个已知 profile
    for (const p of Object.values(PROFILES)) {
        if (p[key]) return p[key];
    }
    return '';
}

// 常用组合
function modelBtnCSS() { return ariaCSS('modelAria'); }

module.exports = {
    PROFILES,
    FUZZY,
    STATIC,
    detectLocale,
    setLocale,
    txt,
    ariaCSS,
    menuText,
    verifyText,
    modelBtnCSS,
    get locale()  { return _locale; },
    get profile() { return _profile; },
};
