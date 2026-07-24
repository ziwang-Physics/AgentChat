/**
 * 会话上下文管理器 — Session Context Manager
 *
 * 解决多轮对话降级时的上下文丢失问题：
 *   - 短对话（<5 轮）：注入完整 Q&A 历史到 fallback 的 prompt 开头
 *   - 长对话（≥5 轮）：自动生成摘要保存到 .json 文件，fallback 时注入摘要
 *
 * 用法：
 *   const { getContext, addTurn, clearSession } = require('./lib/session_context');
 *
 *   // 请求前注入
 *   const ctx = getContext(sessionId);
 *   if (ctx) prompt = ctx + '\n\n---\n\n' + prompt;
 *
 *   // 响应后保存
 *   addTurn(sessionId, question, answer);
 *
 * 存储位置：~/.agentchat/sessions/{sessionId}.json
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

// ── 配置 ──────────────────────────────────────────────────────────────────

const SESSIONS_DIR = path.join(os.homedir(), '.agentchat', 'sessions');
const MAX_FULL_TURNS = 4;          // ≤4 轮：全量注入
const MAX_CONTEXT_CHARS = 3000;    // 超过此长度则摘要
const SUMMARY_PROMPT = `
请将以下对话历史压缩为一段简洁的摘要（150字以内），只保留核心结论和关键上下文，用于后续对话的追问背景：

---
`;

// ── 存储层 ────────────────────────────────────────────────────────────────

// 内存缓存（sessionId → { turns: [...], createdAt, updatedAt }）
const cache = new Map();

function ensureDir() {
    try { fs.mkdirSync(SESSIONS_DIR, { recursive: true }); } catch (_) {}
}

function sessionFile(sessionId) {
    // 允许字母数字 + 连字符，拒绝路径穿越
    const safe = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').substring(0, 64);
    return path.join(SESSIONS_DIR, `${safe}.json`);
}

function load(sessionId) {
    ensureDir();
    const file = sessionFile(sessionId);
    try {
        const raw = fs.readFileSync(file, 'utf8');
        return JSON.parse(raw);
    } catch (_) {
        return { turns: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
    }
}

function save(sessionId, data) {
    ensureDir();
    data.updatedAt = new Date().toISOString();
    try {
        fs.writeFileSync(sessionFile(sessionId), JSON.stringify(data, null, 2), 'utf8');
    } catch (_) { /* 写入失败静默 — 内存缓存仍然有效 */ }
    cache.set(sessionId, data);
}

// ── 上下文构建 ────────────────────────────────────────────────────────────

/**
 * 从对话记录构建可注入的上下文字符串。
 * 短对话返回完整 Q&A，长对话返回摘要 + 最近 2 轮。
 */
function buildContext(data) {
    const turns = data.turns || [];
    if (turns.length === 0) return null;

    const totalChars = turns.reduce((sum, t) =>
        sum + (t.question || '').length + (t.answer || '').length, 0);

    // 短对话：全量 Q&A
    if (turns.length <= MAX_FULL_TURNS && totalChars < MAX_CONTEXT_CHARS) {
        const parts = turns.map((t, i) => {
            const q = (t.question || '').trim();
            const a = ((t.answer || '').trim()).substring(0, 800); // 单轮截断
            return `用户: ${q}\nAI: ${a}`;
        });
        return `[对话背景 — 共 ${turns.length} 轮，来自之前的对话]\n\n${parts.join('\n\n---\n\n')}\n\n[背景结束]\n\n`;
    }

    // 长对话：摘要（如果已生成）+ 最近 2 轮
    const recent = turns.slice(-2);
    const recentPart = recent.map((t, i) => {
        const q = (t.question || '').trim();
        const a = ((t.answer || '').trim()).substring(0, 500);
        return `用户: ${q}\nAI: ${a}`;
    }).join('\n\n---\n\n');

    if (data.summary) {
        return `[对话摘要 — 共 ${turns.length} 轮，核心要点如下]\n\n${data.summary}\n\n[最近 2 轮对话]\n\n${recentPart}\n\n[背景结束]\n\n`;
    }

    // 还没有摘要：用最近 3 轮
    const more = turns.slice(-3);
    const morePart = more.map((t, i) => {
        const q = (t.question || '').trim();
        const a = ((t.answer || '').trim()).substring(0, 600);
        return `用户: ${q}\nAI: ${a}`;
    }).join('\n\n---\n\n');

    return `[对话背景 — 共 ${turns.length} 轮（显示最近 3 轮）]\n\n${morePart}\n\n[背景结束]\n\n`;
}

// ── 公开 API ──────────────────────────────────────────────────────────────

/**
 * 获取会话的上下文注入文本（用于挂到新 Provider 的 prompt 前面）。
 * 返回 null 表示新会话或不足 1 轮，不需要注入。
 */
function getContext(sessionId) {
    if (!sessionId) return null;
    let data = cache.get(sessionId);
    if (!data) {
        data = load(sessionId);
        cache.set(sessionId, data);
    }
    if (!data.turns || data.turns.length === 0) return null;
    return buildContext(data);
}

/**
 * 记录一轮成功的 Q&A。
 * 当对话 ≥ MAX_FULL_TURNS 时标记需要摘要（下次 getContext 触发）。
 */
function addTurn(sessionId, question, answer) {
    if (!sessionId || !question || !answer) return;

    let data = cache.get(sessionId) || load(sessionId);
    if (!data.turns) data.turns = [];
    if (!data.createdAt) data.createdAt = new Date().toISOString();

    data.turns.push({
        question: question.trim(),
        answer: answer.trim(),
        timestamp: new Date().toISOString(),
    });

    // 到达长对话阈值 → 标记需要摘要
    if (data.turns.length >= MAX_FULL_TURNS && !data.summary && !data._summaryPending) {
        data._summaryPending = true;
    }

    save(sessionId, data);
}

/**
 * 生成并持久化对话摘要（调用 LLM）。应异步调用，不阻塞主流程。
 * @param {string} sessionId
 * @param {Function} callLLM — (prompt) => Promise<string>  任意 LLM 调用函数
 */
async function generateSummary(sessionId, callLLM) {
    const data = cache.get(sessionId) || load(sessionId);
    if (!data || !data.turns || data.turns.length < MAX_FULL_TURNS) return;

    // 构建摘要输入
    const dialogue = data.turns.map((t, i) =>
        `[第${i + 1}轮]\n问: ${(t.question || '').trim()}\n答: ${(t.answer || '').trim().substring(0, 1000)}`
    ).join('\n\n');

    try {
        const summary = await callLLM(SUMMARY_PROMPT + dialogue);
        data.summary = summary.trim();
        data._summaryPending = false;
        save(sessionId, data);
        return summary;
    } catch (e) {
        // 摘要生成失败不破坏对话记录 — 下次 fallback 用最近 3 轮
        data._summaryPending = false;
        save(sessionId, data);
        return null;
    }
}

function clearSession(sessionId) {
    if (!sessionId) return;
    cache.delete(sessionId);
    try { fs.unlinkSync(sessionFile(sessionId)); } catch (_) {}
}

function getSessionData(sessionId) {
    if (!sessionId) return null;
    let data = cache.get(sessionId);
    if (!data) { data = load(sessionId); cache.set(sessionId, data); }
    return data;
}

module.exports = {
    getContext,
    addTurn,
    generateSummary,
    clearSession,
    getSessionData,
    MAX_FULL_TURNS,
};
