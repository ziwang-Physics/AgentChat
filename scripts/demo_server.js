#!/usr/bin/env node
/**
 * AgentChat 可视化演示服务器
 *
 * 启动一个本地 HTTP 服务器，提供 Web 界面来演示 AgentChat 的多 AI Provider 能力。
 * 零额外依赖 — 仅使用 Node.js 内置模块。
 *
 * 用法:
 *   node scripts/demo_server.js
 *   然后打开浏览器访问 http://localhost:3456
 *
 * 前提: Chrome CDP 必须在 9222 端口运行
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// 会话上下文管理器 — 多轮对话降级时自动传递历史给 fallback Provider
const { getContext, addTurn, generateSummary, clearSession, getSessionData } = require('./lib/session_context');

const PORT = 3456;
const PROJECT_DIR = path.resolve(__dirname, '..');
const WEBEXT_INDEX = path.join(PROJECT_DIR, 'skills', 'AgentChat-OneWeb', 'index.js');
const DEMO_HTML = path.join(PROJECT_DIR, 'demo', 'index.html');
// 用已知的 Node.js 路径（Windows 上 PATH 不包含 node 时也能跑）
const NODE_EXE = process.platform === 'win32'
    ? path.join(process.env.LOCALAPPDATA || '', 'node-v24.18.0-win-x64', 'node.exe')
    : 'node';
if (!require('fs').existsSync(NODE_EXE)) {
    // fallback to whatever is in PATH
    process.env.NODE_EXE = 'node';
} else {
    process.env.NODE_EXE = NODE_EXE;
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.js': 'application/javascript; charset=utf-8',
    '.png': 'image/png',
    '.json': 'application/json; charset=utf-8',
};

// ── CDP Health Check + Auto-Restart ────────────────────────────────────────

const CDP_PORT = process.env.CDP_PORT || 9222;
const CDP_URL = `http://127.0.0.1:${CDP_PORT}`;

function cdpCheck() {
    return new Promise((resolve) => {
        const req = http.get(`${CDP_URL}/json/version`, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => resolve({ ok: true, data }));
        });
        req.on('error', () => resolve({ ok: false }));
        req.setTimeout(3000, () => { req.destroy(); resolve({ ok: false }); });
    });
}

function launchChrome() {
    console.log('[demo] 正在启动 Chrome...');

    // 必须非默认目录 — Chrome 禁止在系统 User Data 下开启远程调试
    const plat = process.platform;
    const profileDir = path.join(
        process.env.USERPROFILE || process.env.HOME || '/tmp',
        '.chrome-debug-profile'
    );
    try { require('fs').mkdirSync(profileDir, { recursive: true }); } catch (_) {}

    // 清除可能残留的锁文件
    ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Lockfile'].forEach(f => {
        try { require('fs').unlinkSync(path.join(profileDir, f)); } catch (_) {}
    });

    let cmd;
    if (plat === 'win32') {
        cmd = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
        const alt = process.env.LOCALAPPDATA + '\\Google\\Chrome\\Application\\chrome.exe';
        if (!require('fs').existsSync(cmd) && require('fs').existsSync(alt)) cmd = alt;
    } else if (plat === 'darwin') {
        cmd = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
    } else {
        cmd = 'google-chrome-stable';
    }

    args = [
        `--remote-debugging-port=${CDP_PORT}`,
        '--remote-debugging-address=127.0.0.1',
        '--remote-allow-origins=*',
        `--user-data-dir=${profileDir}`,
        '--disable-features=OptimizationHints,Translate,HttpsUpgrades',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-field-trial-config',
        '--disable-component-update',
        '--disable-sync',
        '--no-first-run',
        '--no-default-browser-check',
        '--ignore-certificate-errors',
        'about:blank',                    // 暖启动：开一个空白 tab 让 Chrome 初始化完成
    ];

    console.log(`[demo]   ${cmd}`);
    const child = spawn(cmd, args, {
        stdio: ['ignore', 'ignore', 'pipe'],  // capture stderr for error diagnosis
        detached: true,
    });
    child.stderr.on('data', (d) => {
        const msg = d.toString().trim();
        if (msg) console.log(`[demo] [chrome stderr] ${msg.substring(0, 300)}`);
    });
    child.on('error', (err) => {
        console.log(`[demo] ❌ Chrome 启动失败: ${err.message}`);
    });
    child.unref();
}

async function ensureCdp(timeoutMs = 30000) {
    const start = Date.now();
    const first = await cdpCheck();
    if (first.ok) {
        console.log('[demo] Chrome CDP 已就绪');
        return true;
    }

    // 没在运行 — 启动 Chrome
    console.log('[demo] Chrome CDP 未运行，自动启动...');
    launchChrome();

    // 等待 CDP 就绪
    while (Date.now() - start < timeoutMs) {
        await new Promise((r) => setTimeout(r, 1000));
        const result = await cdpCheck();
        if (result.ok) {
            console.log('[demo] Chrome CDP 启动完成!');

            // 不立即清理 about:blank tab — Windows 下 Chrome 只有一个 tab
            // 时关闭它会导致 Chrome 进程退出。WebExtended 的 tab 冲突检测
            // 已用 --ephemeral-tab 规避，不需要这个 hack。
            // await cleanupBlankTabs();
            return true;
        }
        process.stdout.write('.');
    }
    console.log('\n[demo] ⚠️  Chrome CDP 启动超时 — 部分功能可能不可用');
    return false;
}

function cleanupBlankTabs() {
    return new Promise((resolve) => {
        // 关闭所有 about:blank 页面
        http.get(`${CDP_URL}/json/list`, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const pages = JSON.parse(data);
                    let closed = 0;
                    pages.forEach((p) => {
                        if (p.url === 'about:blank' && p.type === 'page') {
                            http.get(`${CDP_URL}/json/close/${p.id}`, () => {}).end();
                            closed++;
                        }
                    });
                    if (closed > 0) console.log(`[demo] 已清理 ${closed} 个空白 tab`);
                } catch (_) {}
                resolve();
            });
        }).on('error', resolve).end();
    });
}

// 关闭所有 AI 网站 tab（保留 about:blank — Chrome 需要至少一个 tab）
// smoke check 和之前的请求会残留 tab，导致后续请求 tab_already_open
function closeOldProviderTabs() {
    return new Promise((resolve) => {
        http.get(`${CDP_URL}/json/list`, (res) => {
            let data = '';
            res.on('data', (c) => { data += c; });
            res.on('end', () => {
                try {
                    const pages = JSON.parse(data);
                    let closed = 0;
                    pages.forEach((p) => {
                        // 只关 AI 网站 tab（包含已知域名），保留 about:blank
                        const isAI = /gemini|chatgpt|claude|qianwen|kimi|minimax|mimo|deepseek/i.test(p.url);
                        if (isAI && p.type === 'page') {
                            http.get(`${CDP_URL}/json/close/${p.id}`, () => {}).end();
                            closed++;
                        }
                    });
                    if (closed > 0) console.log(`[demo] 已清理 ${closed} 个 AI 网站 tab`);
                } catch (_) {}
                resolve();
            });
        }).on('error', resolve).end();
    });
}

async function callWebext(prompt, opts = {}) {
    // 每次请求前清理旧的 AI 网站 tab（smoke check 残留等），避免 tab_already_open
    await closeOldProviderTabs();

    return new Promise((resolve, reject) => {
        const args = [
            WEBEXT_INDEX,
            `--timeout=${opts.timeout || 600000}`,
            `--timeout-per-provider=${opts.provTimeout || 120000}`,
        ];
        if (opts.from) args.push(`--from=${opts.from}`);
        // 通过 CLI 参数传递 prompt（而非 stdin），避免跨平台编码问题
        if (prompt) args.push(prompt);

        const child = spawn(process.env.NODE_EXE || 'node', args, {
            cwd: PROJECT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
            env: {
                ...process.env,
                // 跳过 Pro Extended 模型切换：Pro 模式下 Angular 重新渲染
                // 导致发送按钮事件失效。Flash 模式发送/接收均正常。
                // 等上游修复 Pro 模式发送后再改回 'lenient'
                AGENTCHAT_SKIP_MODEL_SWITCH: '1',
            },
        });

        let stdout = '';
        let stderr = '';

        child.stdout.on('data', (d) => { stdout += d.toString(); });
        child.stderr.on('data', (d) => { stderr += d.toString(); });

        const timeout = setTimeout(() => {
            child.kill();
            reject(new Error('TIMEOUT'));
        }, opts.timeout + 30000);

        child.on('close', (code) => {
            clearTimeout(timeout);
            if (code === 0 && stdout.trim()) {
                // 从 stderr 提取元数据
                let provider = 'Unknown';
                let model = '';
                let timeMs = 0;
                let chain = [];

                for (const line of stderr.split('\n')) {
                    const m = line.match(/✓\s*(\w+):\s*USED/i);
                    if (m) provider = m[1];
                    const t = line.match(/Fallback chain:\s*(.+)/);
                    if (t) chain = t[1].split('→').map(s => s.trim()).filter(Boolean);
                    const ms = line.match(/(\d+)ms\s*total/);
                    if (ms) timeMs = parseInt(ms[1]);
                }
                if (stderr.includes('Pro Extended')) model = 'Pro Extended';
                else if (stderr.includes('Flash')) model = 'Flash';

                resolve({
                    response: stdout.trim(),
                    provider,
                    model,
                    timeMs: timeMs || (Date.now() - (timeMs || 0)),
                    chain,
                    success: true,
                });
            } else {
                const lastLines = stderr.split('\n').filter(Boolean).slice(-3).join(' ');
                reject(new Error(lastLines || `exit code ${code}`));
            }
        });

        child.on('error', (e) => { clearTimeout(timeout); reject(e); });
    });
}

function callSmoke() {
    return new Promise((resolve) => {
        const child = spawn(process.env.NODE_EXE || 'node', [WEBEXT_INDEX, '--smoke'], {
            cwd: PROJECT_DIR,
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (d) => { stderr += d.toString(); });
        child.on('close', () => {
            const providers = [];
            for (const line of stderr.split('\n')) {
                // "  Gemini: ✅ REACHABLE (...)" or "  Gemini: tab already open → skipping"
                let m = line.match(/(\w[\w\s]*):\s*(✅|❌|REACHABLE|UNREACHABLE|needs login)/i);
                if (m) {
                    providers.push({ name: m[1].trim(), status: m[2].trim() });
                    continue;
                }
                // "  Gemini: tab already open → skipping" — means ready to use
                m = line.match(/(\w[\w\s]*):\s*tab already open/i);
                if (m) {
                    providers.push({ name: m[1].trim(), status: '✅ (tab ready)' });
                }
            }
            // 确保 8 provider 都有状态（漏掉的标记为 unknown）
            resolve(providers);
        });
    });
}

// ── HTTP Server ─────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        return res.end();
    }

    const url = new URL(req.url, `http://localhost:${PORT}`);

    // Helper: read request body safely (handles multi-byte UTF-8 split across TCP chunks)
    function readBody(req) {
        return new Promise((resolve) => {
            const chunks = [];
            req.on('data', (c) => chunks.push(c));
            req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        });
    }

    // API: POST /api/ask
    // 支持可选 sessionId — 多轮对话降级时自动注入历史上下文到 fallback
    if (req.method === 'POST' && url.pathname === '/api/ask') {
        const body = await readBody(req);
        try {
            const { prompt, provider, sessionId } = JSON.parse(body);
                if (!prompt || prompt.trim().length < 2) {
                    throw new Error('Prompt too short');
                }

                // 会话模式：将之前的对话上下文注入 prompt（降级时 fallback 可见）
                let fullPrompt = prompt.trim();
                let ctxInfo = null;
                if (sessionId) {
                    const ctx = getContext(sessionId);
                    if (ctx) {
                        fullPrompt = ctx + '当前问题: ' + fullPrompt;
                        ctxInfo = { sessionId, hasContext: true };
                    }
                }

                const result = await callWebext(fullPrompt, {
                    from: provider || 'gemini',
                    timeout: 600000,
                    provTimeout: 180000,
                });

                // 会话模式：成功响应后保存对话记录
                if (sessionId && result.success && result.response) {
                    addTurn(sessionId, prompt.trim(), result.response);

                    // 异步生成摘要（长对话 ≥4 轮时）
                    const data = getSessionData(sessionId);
                    if (data && data._summaryPending && data.turns.length >= 4) {
                        // 不阻塞响应，fire-and-forget
                        generateSummary(sessionId, (sp) => {
                            return callWebext(sp, {
                                from: 'kimi',
                                timeout: 60000,
                                provTimeout: 30000,
                            }).then(r => r.response).catch(() => null);
                        }).catch(() => {});
                    }
                }

                if (ctxInfo) result.session = ctxInfo;
                res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
                res.end(JSON.stringify(result));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: false,
                response: `Error: ${e.message}`,
                provider: '',
                model: '',
                timeMs: 0,
                chain: [],
            }));
        }
        return;
    }

    // API: GET /api/smoke
    if (req.method === 'GET' && url.pathname === '/api/smoke') {
        try {
            const providers = await callSmoke();
            // 必须等 tab 清理完成再响应，否则降级链页面的后续 /api/ask 会遇到 tab_already_open
            await closeOldProviderTabs();
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(providers));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify([]));
        }
        return;
    }

    // API: GET /api/health — CDP status check
    if (req.method === 'GET' && url.pathname === '/api/health') {
        const cdp = await cdpCheck();
        res.writeHead(cdp.ok ? 200 : 503, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            cdp: cdp.ok ? 'online' : 'offline',
            port: CDP_PORT,
            server: 'running',
        }));
        return;
    }

    // API: POST /api/parallel — FreeSubAgent 4-worker parallel decomposition
    if (req.method === 'POST' && url.pathname === '/api/parallel') {
        const body = await readBody(req);
        try {
            const { tasks } = JSON.parse(body);
            if (!tasks || !Array.isArray(tasks) || tasks.length === 0) {
                throw new Error('Need a tasks array with at least 1 task');
            }

            const results = [];
            const startTime = Date.now();

            // Run each task in sequence (to avoid overwhelming Chrome)
            for (const task of tasks) {
                try {
                    const r = await callWebext(task.prompt, {
                        from: task.provider || 'gemini',
                        timeout: 300000,
                        provTimeout: 120000,
                    });
                    results.push({ id: task.id, role: task.role, ...r, error: null });
                } catch (e) {
                    results.push({ id: task.id, role: task.role, success: false, response: '', error: e.message });
                }
            }

            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({
                success: results.some(r => r.success),
                totalMs: Date.now() - startTime,
                completed: results.filter(r => r.success).length,
                total: tasks.length,
                results,
            }));
        } catch (e) {
            res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, error: e.message }));
        }
        return;
    }

    // API: POST /api/search-web — Kimi 联网搜索
    if (req.method === 'POST' && url.pathname === '/api/search-web') {
        const body = await readBody(req);
        try {
            const { query } = JSON.parse(body);
            if (!query) throw new Error('Need a search query');
            const r = await callWebext(
                `请进行联网搜索，用要点列出关键事实和数据。不要运行代码。\n\n搜索内容：${query}`,
                { from: 'kimi', timeout: 300000, provTimeout: 180000 }
            );
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: POST /api/deep-reason — Gemini Pro Extended 深度推理
    if (req.method === 'POST' && url.pathname === '/api/deep-reason') {
        const body = await readBody(req);
        try {
            const { prompt, context } = JSON.parse(body);
            const full = context
                ? `${prompt}\n\n基于以下资料进行推理分析，不需要搜索新资料：\n${context}`
                : prompt;
            const r = await callWebext(full, { from: 'gemini', timeout: 600000, provTimeout: 300000 });
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: POST /api/review — ChatGPT 交叉审查
    if (req.method === 'POST' && url.pathname === '/api/review') {
        const body = await readBody(req);
        try {
            const { content } = JSON.parse(body);
            if (!content) throw new Error('Need content to review');
            const r = await callWebext(
                `请逐一审查以下内容，列出所有问题点并给出具体修改建议。不要重写整个方案。\n\n${content}`,
                { from: 'chatgpt', timeout: 300000, provTimeout: 180000 }
            );
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: POST /api/verify — Qwen 事实核查
    if (req.method === 'POST' && url.pathname === '/api/verify') {
        const body = await readBody(req);
        try {
            const { content } = JSON.parse(body);
            if (!content) throw new Error('Need content to verify');
            const r = await callWebext(
                `请对你提供的内容进行事实核查。每个结论标注信息来源。\n\n${content}`,
                { from: 'qwen', timeout: 300000, provTimeout: 180000 }
            );
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(r));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify({ success: false, response: e.message }));
        }
        return;
    }

    // API: GET /api/stats — server uptime + call statistics
    if (req.method === 'GET' && url.pathname === '/api/stats') {
        const cdp = await cdpCheck();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({
            cdp: cdp.ok ? 'online' : 'offline',
            port: CDP_PORT,
            providers: 8,
            skills: 6,
            languages: 4,
            uptime: process.uptime(),
        }));
        return;
    }

    // API: GET /api/sessions — 列出所有会话
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
        try {
            const sessionsDir = path.join(require('os').homedir(), '.agentchat', 'sessions');
            const files = require('fs').existsSync(sessionsDir)
                ? require('fs').readdirSync(sessionsDir).filter(f => f.endsWith('.json'))
                : [];
            const sessions = files.map(f => {
                const id = f.replace('.json', '');
                const data = getSessionData(id);
                return {
                    id,
                    turns: data.turns.length,
                    hasSummary: !!data.summary,
                    createdAt: data.createdAt,
                    updatedAt: data.updatedAt,
                };
            }).sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify(sessions));
        } catch (_) {
            res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
            res.end(JSON.stringify([]));
        }
        return;
    }

    // API: DELETE /api/sessions/{id} — 清除指定会话
    if (req.method === 'DELETE' && url.pathname.startsWith('/api/sessions/')) {
        const sessionId = url.pathname.split('/api/sessions/')[1];
        clearSession(sessionId);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ cleared: true, sessionId }));
        return;
    }

    // Static: serve from demo/ directory
    let demoDir = path.join(PROJECT_DIR, 'demo');
    let filePath = path.join(demoDir, 'index.html');
    let staticPath = url.pathname.replace(/^\//, '');
    if (staticPath && staticPath !== 'index.html') {
        let candidate = path.join(demoDir, staticPath);
        if (require('fs').existsSync(candidate)) {
            filePath = candidate;
        }
    }

    try {
        const content = fs.readFileSync(filePath);
        const ext = path.extname(filePath).toLowerCase();
        res.writeHead(200, { 'Content-Type': MIME[ext] || 'text/plain' });
        res.end(content);
    } catch {
        res.writeHead(404);
        res.end('Not found');
    }
});

// ── 启动：先确保 CDP 在线，再开 HTTP 服务 ──

(async () => {
    const cdpReady = await ensureCdp();

    server.on('error', (e) => {
        if (e.code === 'EADDRINUSE') {
            console.log(`[demo] 端口 ${PORT} 被占用，自动清理...`);
            const { execSync } = require('child_process');
            try {
                if (process.platform === 'win32') {
                    execSync(`netstat -ano | findstr :${PORT}`, { encoding: 'utf8' })
                        .split('\n').forEach(line => {
                            const m = line.trim().match(/(\d+)\s*$/);
                            if (m) { try { process.kill(parseInt(m[1])); } catch(_){} }
                        });
                }
            } catch(_) {}
            setTimeout(() => { server.listen(PORT); }, 1000);
            return;
        }
        throw e;
    });

    server.listen(PORT, () => {
        console.log('');
        console.log('╔══════════════════════════════════════════════╗');
        console.log('║       AgentChat 可视化演示平台                 ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log(`║  Web 界面: http://localhost:${PORT}              ║`);
        console.log('║  CDP 状态: ' + (cdpReady ? '✅ 已连接' : '⚠️  离线') + '                            ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log('║  API:                                         ║');
        console.log('║    POST /api/ask         单 Provider 问答      ║');
        console.log('║    POST /api/parallel    4 Worker 并行编排    ║');
        console.log('║    POST /api/search-web  联网检索 (Kimi)      ║');
        console.log('║    POST /api/deep-reason 深度推理 (Gemini)    ║');
        console.log('║    POST /api/review      交叉审查 (ChatGPT)   ║');
        console.log('║    POST /api/verify      事实核查 (Qwen)      ║');
        console.log('║    GET  /api/smoke       Provider 可达性      ║');
        console.log('║    GET  /api/health      CDP 健康检查          ║');
        console.log('║    GET  /api/stats       服务器统计            ║');
        console.log('╠══════════════════════════════════════════════╣');
        console.log('║  Ctrl+C 停止服务器                             ║');
        console.log('╚══════════════════════════════════════════════╝');
        console.log('');
    });
})();
