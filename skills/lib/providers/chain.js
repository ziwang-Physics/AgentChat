/**
 * PROVIDER_CHAIN — single source of truth for provider priority order.
 *
 * Extracted from AgentChat-WebExtended/index.js so that consumers that only
 * need the chain (e.g. FreeSubAgent's buildFallbackChain) don't have to load
 * playwright-core + all 8 adapters just to read a constant array.
 *
 * WebExtended re-exports this for backward compatibility.
 */

const PROVIDER_CHAIN = [
    { key: 'gemini',   name: 'Gemini',   url: 'https://gemini.google.com/u/0/app', authDomains: ['accounts.google.com'],
      // Surfaced on reason='auth' failures — the ONE command that restores a
      // missing/logged-out Gemini tab in the shared Chrome (see connect-gemini.sh).
      recoveryHint: 'bash scripts/connect-gemini.sh  # 重连一次恢复 Gemini 登录态' },
    { key: 'chatgpt',  name: 'ChatGPT',  url: 'https://chatgpt.com/',               authDomains: ['auth.openai.com', 'chat.openai.com/auth'] },
    { key: 'claude',   name: 'Claude',   url: 'https://claude.ai/',                 authDomains: ['claude.ai/login', 'auth.anthropic.com'] },
    { key: 'qwen',     name: 'Qwen',     url: 'https://www.qianwen.com/?source=tongyigw', authDomains: ['qianwen.com/login', 'login.aliyun.com', 'signin.aliyun.com'] },
    { key: 'kimi',     name: 'Kimi',     url: 'https://kimi.moonshot.cn/',          authDomains: ['kimi.moonshot.cn/login', 'kimi.com/login', 'moonshot.cn/login'], tabHosts: ['kimi.moonshot.cn', 'kimi.com'] },
    { key: 'minimax',  name: 'MiniMax',  url: 'https://agent.minimaxi.com/',        authDomains: ['agent.minimaxi.com/login', 'minimax.com/login'] },
    { key: 'mimo',     name: 'MiMo',     url: 'https://aistudio.xiaomimimo.com/',   authDomains: ['aistudio.xiaomimimo.com/login', 'auth0.com'] },
    { key: 'deepseek', name: 'DeepSeek', url: 'https://chat.deepseek.com/',         authDomains: ['chat.deepseek.com/login', 'deepseek.com/login'] },
    { key: 'doubao',   name: 'Doubao',   url: 'https://www.doubao.com/chat/',       authDomains: ['doubao.com/login', 'www.doubao.com/login'] },
];

module.exports = { PROVIDER_CHAIN };
