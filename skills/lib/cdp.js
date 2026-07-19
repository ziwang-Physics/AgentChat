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
 * v18 (Windows CDP unreachable fix): three Windows-specific failure modes in
 *      the v16 embedded launcher, all ending in ERR_NO_CDP:
 *        1. Singleton absorption — Windows Chrome's singleton is a named
 *           mutex/message window, NOT the Singleton* files, so the file
 *           cleanup was a no-op; a live same-profile Chrome absorbed the new
 *           chrome.exe (which then exited) and the port never bound. Now:
 *           pre-launch CIM scan for processes holding --user-data-dir=<profile>;
 *           reclaim (taskkill) ONLY when the holder matches our PID file,
 *           loud-fail with actionable reason otherwise.
 *        2. Job Object teardown — agent-host tool calls run in kill-on-close
 *           jobs; Node's `detached` does NOT breakaway, so the auto-started
 *           Chrome died the instant the skill's node process exited
 *           ("answered the question; next run: CDP unreachable"). Now: launch
 *           via WMI Win32_Process.Create — the browser is parented to
 *           WmiPrvSE.exe, outside the caller's job — with plain spawn as a
 *           logged fallback.
 *        3. Silent 45s burn — no early-exit detection (the ps1 gained one in
 *           v15; the embedded launcher never did). Now: waitForPortOrDeath
 *           aborts as soon as the launched PID dies, and win32 failures
 *           append a netstat diagnostic. Plus: refuse the browser's DEFAULT
 *           "User Data" dir (Chrome ≥136 silently ignores
 *           --remote-debugging-port there).
 *
 * NOTE: connectWithRetry takes `chromium` as first arg (imported by caller)
 *       because this lib/ dir has no node_modules — playwright-core lives
 *       under each skill's own node_modules/.
 */

const http = require('http');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn, execSync, execFileSync } = require('child_process');

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

// ── v18 Windows helpers ─────────────────────────────────────────────────────

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

/** PID recorded by us / the ps1 in CHROME_PID_FILE, or null. */
function readManagedPid() {
    try {
        const n = parseInt(fs.readFileSync(CHROME_PID_FILE, 'utf8').trim(), 10);
        return Number.isFinite(n) && n > 0 ? n : null;
    } catch (_) { return null; }
}

/** Chrome ≥136 silently disables --remote-debugging-port on the browser's
 *  DEFAULT data dir (2025-03 hardening). Detect the vendor-default layouts on
 *  all three platforms so we can refuse with an actionable reason instead of
 *  waiting out a port that will never open. Pure; testable. */
function looksLikeDefaultUserDataDir(p) {
    if (!p) return false;
    const norm = String(p).replace(/[\\\/]+$/, '');
    return /[\\\/](?:Google[\\\/]Chrome|Chromium|Microsoft[\\\/]Edge)[\\\/]User Data$/i.test(norm)
        || /[\\\/]\.config[\\\/](?:google-chrome|chromium)$/i.test(norm)
        || /[\\\/]Application Support[\\\/](?:Google[\\\/]Chrome|Chromium)$/i.test(norm);
}

/** CommandLineToArgvW-compatible quoting for a single argument (backslash
 *  runs before quotes doubled, embedded quotes escaped). Pure; testable. */
function winArgQuote(a) {
    const s = String(a);
    if (s !== '' && !/[\s"]/.test(s)) return s;
    let out = '"';
    let bs = 0;
    for (const ch of s) {
        if (ch === '\\') { bs++; continue; }
        if (ch === '"') { out += '\\'.repeat(bs * 2 + 1) + '"'; bs = 0; continue; }
        out += '\\'.repeat(bs) + ch; bs = 0;
    }
    out += '\\'.repeat(bs * 2) + '"';
    return out;
}

/** PowerShell one-liner that creates a process via WMI and prints its PID.
 *  WMI-created processes are parented to WmiPrvSE.exe — OUTSIDE any Job
 *  Object the caller sits in — which is the whole point (see v18 note #2).
 *  Pure; testable. */
function buildWmiCreatePsCommand(exe, args) {
    const cmdline = [exe, ...args].map(winArgQuote).join(' ');
    const psLiteral = cmdline.replace(/'/g, "''"); // PS single-quoted literal
    return "$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = '" + psLiteral + "' }; " +
           "if ($r.ReturnValue -eq 0) { [Console]::Out.Write($r.ProcessId) } " +
           "else { [Console]::Error.Write('ReturnValue=' + $r.ReturnValue); exit 1 }";
}

/** Launch via WMI. @returns {{ok:boolean, pid?:number, reason?:string}} */
function wmiCreateProcess(exe, args) {
    try {
        const out = execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
             '-Command', buildWmiCreatePsCommand(exe, args)],
            { timeout: 20_000, encoding: 'utf8', windowsHide: true });
        const pid = parseInt(String(out).trim(), 10);
        if (Number.isFinite(pid) && pid > 0) return { ok: true, pid };
        return { ok: false, reason: `unparseable PID: ${JSON.stringify(String(out).slice(0, 80))}` };
    } catch (e) {
        return { ok: false, reason: String(e.message || e).split(/\r?\n/)[0] };
    }
}

/** Parse "PID<TAB>CommandLine" lines → entries whose --user-data-dir equals
 *  profileDir (case- and trailing-slash-insensitive). Pure; testable. */
function parseProfileHolders(text, profileDir) {
    const want = String(profileDir).replace(/[\\\/]+$/, '').toLowerCase();
    const hits = [];
    for (const line of String(text || '').split(/\r?\n/)) {
        const i = line.indexOf('\t');
        if (i < 1) continue;
        const pid = parseInt(line.slice(0, i), 10);
        const cmd = line.slice(i + 1);
        if (!Number.isFinite(pid) || !cmd) continue;
        const m = cmd.match(/--user-data-dir=(?:"([^"]*)"|([^\s"]+))/i);
        if (!m) continue;
        const dir = (m[1] || m[2] || '').replace(/[\\\/]+$/, '').toLowerCase();
        if (dir && dir === want) hits.push({ pid, cmd });
    }
    return hits;
}

/** Live Chromium-family processes holding profileDir. Best-effort — [] on
 *  any failure so diagnostics can never block the launch path. */
function findWindowsChromesUsingProfile(profileDir) {
    if (process.platform !== 'win32') return [];
    try {
        const ps = 'Get-CimInstance Win32_Process -Filter "Name=\'chrome.exe\' OR Name=\'msedge.exe\' OR Name=\'chromium.exe\'" | ' +
                   'ForEach-Object { "$($_.ProcessId)`t$($_.CommandLine)" }';
        const out = execFileSync('powershell.exe',
            ['-NoProfile', '-NonInteractive', '-Command', ps],
            { timeout: 10_000, encoding: 'utf8', windowsHide: true });
        return parseProfileHolders(out, profileDir);
    } catch (_) { return []; }
}

/** netstat lines mentioning the port (win32 failure diagnostics). '' on
 *  failure or non-Windows. */
function netstatPortDiag(port) {
    if (process.platform !== 'win32') return '';
    try {
        return execSync(`netstat -ano | findstr :${port}`,
            { timeout: 8_000, encoding: 'utf8', windowsHide: true }).trim();
    } catch (_) { return ''; } // findstr exits 1 on no match
}

/** Cross-platform PID existence check (EPERM ⇒ alive, not ours). */
function isProcessAlive(pid) {
    if (!pid) return false;
    try { process.kill(pid, 0); return true; }
    catch (e) { return e.code === 'EPERM'; }
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
 * v18: async; see header notes #1–#3 for the Windows failure modes fixed here.
 * @returns {Promise<{ok: boolean, reason?: string, pid?: number|null}>}
 */
async function launchChromeDirect(port, log) {
    const chrome = findChromeBinary();
    if (!chrome) {
        return { ok: false, reason: 'Chrome not found — set CHROMIUM_PATH in .env to your chrome.exe / chrome binary' };
    }
    const profileDir = path.resolve(expandHome(process.env.CHROME_PROFILE || path.join(os.homedir(), '.chrome-debug-profile')));
    if (looksLikeDefaultUserDataDir(profileDir)) {
        return { ok: false, reason:
            `CHROME_PROFILE=${profileDir} is the browser's DEFAULT User Data dir — ` +
            'Chrome >=136 silently ignores --remote-debugging-port there, so the CDP port would never open. ' +
            'Use a dedicated profile (default: ~/.chrome-debug-profile) and sign in to the AI sites once inside it.' };
    }
    try { fs.mkdirSync(profileDir, { recursive: true }); } catch (_) {}

    if (process.platform === 'win32') {
        // v18 #1: Windows' singleton is a named mutex — a live same-profile
        // Chrome absorbs any new instance, which exits without binding the
        // port. Detect holders BEFORE launching; reclaim only our own.
        const holders = findWindowsChromesUsingProfile(profileDir);
        if (holders.length) {
            const managedPid = readManagedPid();
            const foreign = holders.filter(h => h.pid !== managedPid);
            if (foreign.length) {
                return { ok: false, reason:
                    `a Chrome without a reachable CDP port on ${port} already holds this profile ` +
                    `(PID ${foreign.map(h => h.pid).join(', ')}) — a new instance would be absorbed by ` +
                    "Chrome's singleton and exit immediately. Close it, run scripts\\start-chrome.ps1 -Stop, " +
                    'or point CHROME_PROFILE at a different directory.' };
            }
            // Only OUR recorded instance holds the profile without serving the
            // expected port (e.g. it was started under a different CDP_PORT
            // from a .env this process cannot see). Reclaim it.
            log(`Managed Chrome (PID ${managedPid}) holds the profile without serving port ${port} — reclaiming...`);
            try { execFileSync('taskkill', ['/PID', String(managedPid), '/T', '/F'], { timeout: 10_000, stdio: 'ignore', windowsHide: true }); } catch (_) {}
            await sleep(2000);
        }
    } else {
        // POSIX only: here the singleton really is these files; stale ones
        // from a crashed instance block startup silently. (On Windows this
        // cleanup was a no-op — the reason v16 could never recover.)
        for (const lock of ['SingletonLock', 'SingletonSocket', 'SingletonCookie', 'Lockfile']) {
            try { fs.rmSync(path.join(profileDir, lock), { force: true }); } catch (_) {}
        }
    }

    const args = buildChromeArgs(port, profileDir);
    log(`Launching Chrome directly: ${chrome}`);
    log(`  profile: ${profileDir}`);

    if (process.platform === 'win32') {
        // v18 #2: WMI create → parented to WmiPrvSE.exe, outside the caller's
        // Job Object, so the browser survives the tool-call teardown that
        // killed every plain-spawned Chrome the moment the skill exited.
        const wmi = wmiCreateProcess(chrome, args);
        if (wmi.ok) {
            log(`  launched via WMI (job-breakaway), PID ${wmi.pid}`);
            try { fs.writeFileSync(CHROME_PID_FILE, String(wmi.pid)); } catch (_) {}
            return { ok: true, pid: wmi.pid };
        }
        log(`  WMI launch unavailable (${wmi.reason}) — falling back to plain spawn.`);
        log('  WARNING: a plain-spawned Chrome stays inside the caller\'s Job Object; ' +
            'on agent hosts it will be killed when this tool call ends.');
    }
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

/** v18 #3: waitForPort with early abort when the launched PID dies — the
 *  singleton hand-off / AV-block cases previously burned the full 45s wait
 *  before surfacing a generic failure.
 *  @returns {Promise<{up: boolean, died: boolean}>} */
async function waitForPortOrDeath(url, pid, log, budgetMs = AUTOSTART_WAIT_MS) {
    const deadline = Date.now() + budgetMs;
    const graceUntil = Date.now() + 1500; // brand-new process settling window
    while (Date.now() < deadline) {
        if (await probeCdp(url)) return { up: true, died: false };
        if (pid && Date.now() > graceUntil && !isProcessAlive(pid)) {
            // Re-probe once: a singleton hand-off can leave the port served
            // by the pre-existing instance an instant later.
            if (await probeCdp(url)) return { up: true, died: false };
            return { up: false, died: true };
        }
        await sleep(AUTOSTART_POLL_MS);
    }
    return { up: false, died: false };
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
    const launched = await launchChromeDirect(port, log);
    if (!launched.ok) {
        reasons.push(launched.reason);
        return { up: false, autostarted: false, reason: reasons.join('; ') };
    }
    const waited = await waitForPortOrDeath(url, launched.pid, log);
    if (waited.up) {
        log('Chrome CDP is up (embedded launcher).');
        return { up: true, autostarted: true, method: 'direct' };
    }
    if (waited.died) {
        // v18 #3: fail FAST and specific instead of burning the full wait.
        reasons.push(`embedded launch: chrome (pid ${launched.pid}) exited without binding port ${port} — ` +
                     'likely absorbed by an existing same-profile Chrome this process could not see, ' +
                     'or blocked by antivirus (debug-flagged chrome.exe)');
    } else {
        reasons.push(`embedded launch: port still down ${AUTOSTART_WAIT_MS / 1000}s after spawn (pid ${launched.pid})`);
    }
    const diag = netstatPortDiag(port);
    if (diag) {
        log(`netstat for port ${port}:`);
        for (const l of diag.split(/\r?\n/)) log('  ' + l);
    }
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
    // v18 (exported for the regression suite + operator tooling)
    winArgQuote, buildWmiCreatePsCommand, parseProfileHolders, looksLikeDefaultUserDataDir,
    isProcessAlive, waitForPortOrDeath, netstatPortDiag, findWindowsChromesUsingProfile,
};
