/**
 * PROVIDER_CHAIN — single source of truth for provider priority order.
 *
 * Extracted from AgentChat-OneWeb/index.js so that consumers that only
 * need the chain (e.g. IndependentTasks's buildFallbackChain) don't have to load
 * playwright-core + all 7 adapters just to read a constant array.
 *
 * OneWeb re-exports this for backward compatibility.
 *
 * 2026-08-10 国内化改造: 移除 Gemini/ChatGPT/Claude，新增豆包(Doubao)/智谱清言(GLM)，
 * 链序 = deepseek → doubao → glm → qwen → kimi → minimax → mimo（纯国内 7 家）。
 */

const PROVIDER_CHAIN = [
    { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',         authDomains: ['chat.deepseek.com/login', 'deepseek.com/login'] },
    { key: 'doubao',   name: 'Doubao',   url: 'https://www.doubao.com/chat/',        authDomains: ['doubao.com/login', 'sso.doubao.com', 'login.doubao.com', 'oceanapi.com/login'] },
    { key: 'glm',      name: 'GLM',      url: 'https://chatglm.cn/main/all',         authDomains: ['chatglm.cn/login', 'open.bigmodel.cn', 'bigmodel.cn/login'] },
    { key: 'qwen',     name: 'Qwen',     url: 'https://www.qianwen.com/?source=tongyigw', authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'] },
    { key: 'kimi',     name: 'Kimi',     url: 'https://www.kimi.com/',              authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'], tabHosts: ['kimi.moonshot.cn', 'kimi.com'] },
    { key: 'minimax',  name: 'MiniMax',  url: 'https://agent.minimaxi.com/',        authDomains: ['agent.minimaxi.com/login', 'minimax.com/login'] },
    { key: 'mimo',     name: 'MiMo',     url: 'https://aistudio.xiaomimimo.com/',   authDomains: ['aistudio.xiaomimimo.com/login', 'auth0.com'] },
];

module.exports = { PROVIDER_CHAIN };
