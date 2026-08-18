'use strict';

function classifyProviderFailure(text) {
    const value = String(text || '');
    if (/(?:额度|积分|次数).*(?:用完|耗尽|不足|明天|次日)|quota|limit reached/i.test(value)) {
        return 'quota';
    }
    if (/请登录|登录后|扫码登录|sign.?in|log.?in|authentication/i.test(value)) {
        return 'auth';
    }
    if (/不符合.*规范|违规|敏感|安全|审核未通过|safety|policy/i.test(value)) {
        return 'safety';
    }
    if (/超时|timeout/i.test(value)) return 'timeout';
    return 'generation';
}

async function runWithFallback(task, adapters, context = {}) {
    const attempts = [];

    for (const provider of task.providers) {
        const adapter = adapters[provider];
        if (!adapter || typeof adapter.generate !== 'function') {
            attempts.push({ provider, ok: false, reason: 'unsupported' });
            continue;
        }

        let result;
        try {
            result = await adapter.generate(task, context);
        } catch (error) {
            result = {
                ok: false,
                reason: classifyProviderFailure(error && error.message),
                error: error && error.message,
            };
        }

        const ok = !!(result && result.ok);
        const reason = ok ? null : (result.reason || classifyProviderFailure(result.error || result.message));
        attempts.push({ provider, ok, reason });

        if (ok) return { ...result, provider, attempts };
        if (reason === 'safety') {
            return { ok: false, provider, reason, attempts, error: result.error || result.message || null };
        }
    }

    return { ok: false, provider: null, reason: 'all_exhausted', attempts };
}

module.exports = { classifyProviderFailure, runWithFallback };
