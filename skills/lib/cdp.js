/**
 * Shared CDP utilities — connect, health check, doctor diagnostics, and
 * platform-aware Chrome auto-start.
 *
 * v15: ensureChromeCdp() auto-runs the platform start script; CDP_HOST;
 *      platform-aware startHint().
 * v16 (workbuddy deployment fix): the start scripts live in <repo>/scripts/ —
 *      OUTSIDE skills/ — so any host that deploys only the skills tree
 *      (workbuddy: C:\Users\<u>\.workbuddy\skills\AgentChat\) never has them,
 *      and v15's autostart died with "starter not found" on every cold run.
 *      Now:
 *        Tier 1: platform start script, searched across candidate dirs
 *                (AGENTCHAT_SCRIPTS_DIR env → repo layout → CWD/scripts)
 *        Tier 2: EMBEDDED launcher — find Chrome, build the same hardened
 *                flag set as the scripts, spawn detached, wait for the port.
 *                Zero external files required.
 *      Plus: Node now loads .env itself (safe KEY=VALUE parse, process.env
 *      wins) — under workbuddy there is no shell wrapper to source it, so
 *      CHROMIUM_PATH / CHROME_PROFILE / PROXY_SERVER were invisible before.
 *
 * NOTE: connectWithRetry takes `chromium` as first arg (imported by caller)
 *       because this lib/ dir has no node_modules — playwright-core lives
 *       under each skill's own node_modules/.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

// ── .env loading (v16) ──────────────────────────────────────────────────────
// Safe line parser — NEVER shell-sourced (see the 2026-06-29 P0 on the bash
// side: `source .env` was an arbitrary-code-execution vector). Values are
// plain strings; $(...), backticks, $VAR stay literal. process.env wins.
function loadDotEnv() {
    const candidates = [
        process.env.AGENTCHAT_ENV_FILE,
        path.resolve(__dirname, '..', '..', '.env'),   // repo layout
        path.resolve(process.cwd(), '.env'),           // caller's project
    ].filter(Boolean);
    for (const f of candidates) {
        let text;
        try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
        for (const raw of text.split(/\r?\n/)) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) continue;
            const m = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
            if (!m) continue;
            let val = m[2].trim();
            if ((val.startsWith('"') && val.endsWith('"')) ||
                (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
            if (!(m[1] in process.env)) process.env[m[1]] = val;
        }
        return f; // first found wins (mirrors the shell loaders)
    }
    return null;
}
const LOADED_ENV_FILE = loadDotEnv();

const DEFAULT_CDP_PORT = process.env.CDP_PORT || '9222';
// CDP_HOST: override for WSL2 → Windows-host Chrome, remote CDP, etc.
const DEFAULT_CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_URL = `http://${DEFAULT_CDP_HOST}:${DEFAULT_CDP_PORT}`;

const AUTOSTART_WAIT_MS = 45_000;
const AUTOSTART_POLL_MS = 1_000;
// Same filename the ps1/daemon use — keeps `start-chrome.ps1 -Stop` able to
// stop a Chrome the embedded launcher started (and vice versa).
const CHROME_PID_FILE = path.join(os.tmpdir(), 'chrome-debug.chrome.pid');

/** `~` / `~/x` → homedir. Anything else passes through untouched. */
function expandHome(p) {
    if (!p) return p;
    if (p === '~') return os.homedir();
    if (p.startsWith('~/') || p.startsWith('~\\')) return path.join(os.homedir(), p.slice(2));
    return p;
}

/** True when running inside WSL (any version). */
function isWSL() {
    return process.platform === 'linux' && /microsoft/i.test(os.release());
}

/** First existing platform start script, searched across deployment layouts.
 *  AGENTCHAT_SCRIPTS_DIR, when set, is authoritative — no fallback guessing. */
function findStartScript() {
    const name = process.platform === 'win32' ? 'start-chrome.ps1' : 'start-chrome-debug.sh';
    const dirs = process.env.AGENTCHAT_SCRIPTS_DIR
        ? [process.env.AGENTCHAT_SCRIPTS_DIR]
        : [
            path.resolve(__dirname, '..', '..', 'scripts'),  // repo layout
            path.resolve(process.cwd(), 'scripts'),          // caller's project
        ];
    for (const d of dirs) {
        const p = path.join(d, name);
        try { if (fs.existsSync(p)) return p; } catch (_) {}
    }
    return null;
}

/** Locate a Chrome/Chromium/Edge binary. CHROMIUM_PATH (validated) wins. */
function findChromeBinary() {
    const envPath = expandHome(process.env.CHROMIUM_PATH);
    if (envPath && fs.existsSync(envPath)) return envPath;
    let candidates = [];
    if (process.platform === 'win32') {
        const pf   = process.env['ProgramFiles'] || 'C:\\Program Files';
        const pf86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
        const lad  = process.env['LOCALAPPDATA'] || '';
        candidates = [
            path.join(pf,   'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            lad && path.join(lad, 'Google', 'Chrome', 'Application', 'chrome.exe'),
            path.join(pf,   'Chromium', 'Application', 'chrome.exe'),
            path.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
            path.join(pf,   'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        ].filter(Boolean);
    } else if (process.platform === 'darwin') {
        candidates = [
            '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
            '/Applications/Chromium.app/Contents/MacOS/Chromium',
            '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
        ];
    } else {
        candidates = [
            '/usr/bin/google-chrome-stable', '/usr/bin/google-chrome',
            '/usr/bin/chromium', '/usr/bin/chromium-browser',
            '/snap/bin/chromium', '/usr/bin/microsoft-edge',
        ];
    }
    for (const c of candidates) {
        try { if (fs.existsSync(c)) return c; } catch (_) {}
    }
    return null;
}

/** Hardened flag set — parity with start-chrome.ps1 / start-chrome-debug.py.
 *  SECURITY: no --remote-allow-origins=* and no --ignore-certificate-errors
 *  (both were removed repo-wide; see the scripts' comments). */
function buildChromeArgs(port, profileDir) {
    const args = [
        `--remote-debugging-port=${port}`,
        '--remote-debugging-address=127.0.0.1',
        `--user-data-dir=${profileDir}`,
        '--disable-features=OptimizationHints,Translate,HttpsUpgrades',
        '--disable-background-networking',
        '--disable-client-side-phishing-detection',
        '--disable-field-trial-config',
        '--disable-component-update',
        '--disable-sync',
        '--disable-extensions',
        '--disable-default-apps',
        '--disable-breakpad',
        '--disable-hang-monitor',
        '--disable-popup-blocking',
        '--disable-renderer-backgrounding',
        '--no-first-run',
        '--no-default-browser-check',
        '--noerrdialogs',
        '--hide-scrollbars',
        '--mute-audio',
        '--disable-dev-shm-usage',
    ];
    if (process.env.PROXY_SERVER) args.push(`--proxy-server=${process.env.PROXY_SERVER}`);
    // Headful by default — a headless never-logged-in profile cannot be signed
    // in interactively and trips bot checks. HEADLESS=1/true/yes opts in.
    if (/^(1|true|yes)$/i.test(process.env.HEADLESS || '')) {
        args.push('--headless=new', '--disable-gpu', '--window-size=1920,1080');
    }
    args.push(process.env.GEMINI_URL || 'https://gemini.google.com/u/0/app');
    return args;
}

/**
 * Tier-2 embedded launcher — no external script needed.
 * @returns {{ok: boolean, reason?: string, pid?: number}}
 */
function launchChromeDirect(port, log) {
    const chrome = findChromeBinary();
    if (!chrome) {
        return { ok: false, reason: 'Chrome not found — set CHROMIUM_PATH in .env to your chrome.exe / chrome binary' };
    }
    const profileDir = path.resolve(expandHome(process.env.CHROME_PROFILE || path.join(os.homedir(), '.chrome-debug-profile')));
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}
    // Stale singleton locks from a crashed instance block startup silently.
    for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Lockfile']) {
        try { fs.rmSync(path.join(profileDir, lock), { force: true }); } catch (_) {}
    }
    const args = buildChromeArgs(port, profileDir);
    log(`Launching Chrome directly: ${chrome}`);
    log(`  profile: ${profileDir}`);
    try {
        const child = spawn(chrome, args, { detached: true, stdio: 'ignore' });
        child.on('error', () => { /* surfaced by the port wait */ });
        child.unref();
        try { fs.writeFileSync(CHROME_PID_FILE, String(child.pid)); } catch (_) {}
        return { ok: true, pid: child.pid };
    } catch (e) {
        return { ok: false, reason: `spawn failed: ${e.message}` };
    }
}

/** Per-platform "how to start Chrome debug" fix command. */
function startHint() {
    if (process.platform === 'win32') {
        return 'powershell -ExecutionPolicy Bypass -File scripts\\start-chrome.ps1' +
               '   (first time: add -FirstLogin and sign in to Gemini)' +
               ' — or just set CHROMIUM_PATH in .env; the skill can launch Chrome itself';
    }
    if (isWSL()) {
        return 'bash scripts/start-chrome-debug.sh — OR, if Chrome runs on the ' +
               'Windows host: inside WSL2 127.0.0.1 is the VM, not Windows. ' +
               'Start Chrome on Windows with scripts\\start-chrome.ps1, then set ' +
               'CDP_HOST to the Windows host IP (cat /etc/resolv.conf → nameserver) ' +
               'and add --remote-debugging-address=0.0.0.0 ONLY on trusted networks.';
    }
    return 'bash scripts/start-chrome-debug.sh';
}

/** One HTTP GET /json/version probe. Resolves true/false, never throws. */
function probeCdp(cdpUrl, timeoutMs = 2000) {
    const url = (cdpUrl || CDP_URL) + '/json/version';
    return new Promise((resolve) => {
        const req = http.get(url, (res) => {
            res.resume();
            resolve(res.statusCode === 200);
        });
        req.on('error', () => resolve(false));
        req.setTimeout(timeoutMs, () => { req.destroy(); resolve(false); });
    });
}

async function waitForPort(url, log, budgetMs = AUTOSTART_WAIT_MS) {
    const deadline = Date.now() + budgetMs;
    while (Date.now() < deadline) {
        if (await probeCdp(url)) return true;
        await new Promise(r => setTimeout(r, AUTOSTART_POLL_MS));
    }
    return false;
}

/**
 * Ensure a Chrome CDP endpoint is up, auto-starting once if needed.
 *   Tier 1: platform start script (if deployed)
 *   Tier 2: embedded launcher (always available)
 * Skipped when the port is up, AGENTCHAT_NO_AUTOSTART=1, or CDP_HOST is remote.
 *
 * @returns {Promise<{up: boolean, autostarted: boolean, method?: 'script'|'direct', reason?: string}>}
 */
async function ensureChromeCdp(cdpUrl, onLog) {
    const log = onLog || (() => {});
    const url = cdpUrl || CDP_URL;

    if (await probeCdp(url)) return { up: true, autostarted: false };

    if (process.env.AGENTCHAT_NO_AUTOSTART === '1') {
        return { up: false, autostarted: false, reason: 'autostart disabled (AGENTCHAT_NO_AUTOSTART=1)' };
    }
    const host = new URL(url).hostname;
    if (host !== '127.0.0.1' && host !== 'localhost') {
        return { up: false, autostarted: false, reason: `CDP_HOST=${host} is remote — cannot auto-start Chrome there` };
    }
    const port = new URL(url).port || '9222';
    const reasons = [];

    // ── Tier 1: deployed start script ──────────────────────────────────────
    const script = findStartScript();
    if (script) {
        const isPs1 = script.endsWith('.ps1');
        const cmd = isPs1 ? 'powershell.exe' : 'bash';
        const argv = isPs1
            ? ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script]
            : [script];
        log(`CDP port down — auto-starting via start script: ${script}`);
        try {
            const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', cwd: path.dirname(path.dirname(script)) });
            child.on('error', () => {});
            child.unref();
            if (await waitForPort(url, log)) {
                log('Chrome CDP is up (auto-started via script).');
                return { up: true, autostarted: true, method: 'script' };
            }
            reasons.push('start script ran but port stayed down 45s');
        } catch (e) {
            reasons.push(`script spawn failed: ${e.message}`);
        }
    } else {
        reasons.push('no start script deployed (scripts/ not copied — normal under workbuddy/skill-only installs)');
    }

    // ── Tier 2: embedded launcher ──────────────────────────────────────────
    // Re-probe first: a slow Tier-1 Chrome may have just bound the port.
    if (await probeCdp(url)) return { up: true, autostarted: true, method: 'script' };
    log('Falling back to embedded Chrome launcher (no external scripts needed)...');
    const launched = launchChromeDirect(port, log);
    if (!launched.ok) {
        reasons.push(launched.reason);
        return { up: false, autostarted: false, reason: reasons.join('; ') };
    }
    if (await waitForPort(url, log)) {
        log('Chrome CDP is up (embedded launcher).');
        return { up: true, autostarted: true, method: 'direct' };
    }
    reasons.push(`embedded launch: port still down ${AUTOSTART_WAIT_MS / 1000}s after spawn (pid ${launched.pid})`);
    return { up: false, autostarted: true, method: 'direct', reason: reasons.join('; ') };
}

/**
 * Connect to Chrome CDP with retries.
 * @param {object} chromium — playwright-core chromium object (from caller's require)
 */
async function connectWithRetry(chromium, cdpUrl, retries = 3, onLog) {
    const url = cdpUrl || CDP_URL;
    const log = onLog || (() => {});
    for (let i = 1; i <= retries; i++) {
        try {
            log(`Connecting to Chrome CDP (attempt ${i}/${retries})...`);
            const browser = await chromium.connectOverCDP(url);
            browser.on('disconnected', () => {
                log('CRITICAL: CDP connection to Chrome dropped.');
            });
            return browser;
        } catch (err) {
            if (i === retries) throw err;
            await new Promise(r => setTimeout(r, 2000));
        }
    }
}

/** Check CDP connectivity. Exit on failure (CLI mode), or return boolean. */
async function doctorCheck(exitOnFail = true, onLog) {
    const log = onLog || console.error;
    if (await probeCdp(CDP_URL, 5000)) {
        log(`Chrome CDP reachable: ${CDP_URL}`);
        return true;
    }
    log('Chrome CDP is NOT reachable on ' + CDP_URL);
    log('Run: ' + startHint());
    if (isWSL()) log('(WSL detected — see the CDP_HOST note above if Chrome runs on Windows)');
    if (exitOnFail) process.exit(1);
    return false;
}

module.exports = {
    connectWithRetry, doctorCheck, ensureChromeCdp, probeCdp, startHint, isWSL,
    expandHome, findChromeBinary, findStartScript, launchChromeDirect, buildChromeArgs,
    CDP_URL, CHROME_PID_FILE, LOADED_ENV_FILE,
};
