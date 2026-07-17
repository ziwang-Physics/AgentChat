/**
 * Shared CDP utilities — connect, health check, doctor diagnostics, and
 * platform-aware Chrome auto-start.
 *
 * Used by OneWeb and IndependentTasks skills.
 *
 * v15 (Windows/workbuddy fix):
 *   - CDP_HOST env support — WSL2 users can point at the Windows host
 *     (127.0.0.1 inside WSL2 is the VM, NOT the Windows machine running Chrome).
 *   - ensureChromeCdp(): if the port is down, auto-run the platform's start
 *     script ONCE (powershell start-chrome.ps1 on win32, bash
 *     start-chrome-debug.sh elsewhere) and wait for the port. Previously the
 *     auto-start path existed only as a bash one-liner in SKILL.md — invisible
 *     to any Windows agent host, which is exactly how every workbuddy run
 *     died with ECONNREFUSED. Disable with AGENTCHAT_NO_AUTOSTART=1.
 *   - startHint(): per-platform fix command — the old hardcoded
 *     "bash scripts/start-chrome-debug.sh" was a dead end on Windows.
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

const DEFAULT_CDP_PORT = process.env.CDP_PORT || '9222';
// CDP_HOST: override for WSL2 → Windows-host Chrome, remote CDP, etc.
const DEFAULT_CDP_HOST = process.env.CDP_HOST || '127.0.0.1';
const CDP_URL = `http://${DEFAULT_CDP_HOST}:${DEFAULT_CDP_PORT}`;

const SCRIPTS_DIR = path.resolve(__dirname, '..', '..', 'scripts');
const AUTOSTART_WAIT_MS = 45_000;   // start-chrome.ps1's own port wait is 30s
const AUTOSTART_POLL_MS = 1_000;

/** True when running inside WSL (any version). */
function isWSL() {
    return process.platform === 'linux' && /microsoft/i.test(os.release());
}

/** Per-platform "how to start Chrome debug" fix command. */
function startHint() {
    if (process.platform === 'win32') {
        return 'powershell -ExecutionPolicy Bypass -File scripts\\start-chrome.ps1' +
               '   (first time: add -FirstLogin and sign in to Gemini)';
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

/**
 * Ensure a Chrome CDP endpoint is up, auto-starting the platform's debug
 * Chrome once if needed. Safe to call unconditionally before connecting.
 *
 * Auto-start is skipped when:
 *   - the port is already up (fast path, one probe)
 *   - AGENTCHAT_NO_AUTOSTART=1
 *   - CDP_HOST points at a non-local address (we can't start remote Chrome)
 *
 * @returns {Promise<{up: boolean, autostarted: boolean, reason?: string}>}
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

    // Pick the platform starter. Windows: powershell script (headful by
    // default post-v15 — headless Gemini can't be logged in interactively and
    // trips bot checks). Linux/macOS: existing daemon wrapper.
    let cmd, argv;
    if (process.platform === 'win32') {
        const ps1 = path.join(SCRIPTS_DIR, 'start-chrome.ps1');
        if (!fs.existsSync(ps1)) return { up: false, autostarted: false, reason: `starter not found: ${ps1}` };
        cmd = 'powershell.exe';
        argv = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ps1];
    } else {
        const sh = path.join(SCRIPTS_DIR, 'start-chrome-debug.sh');
        if (!fs.existsSync(sh)) return { up: false, autostarted: false, reason: `starter not found: ${sh}` };
        cmd = 'bash';
        argv = [sh];
    }

    log(`CDP port down — auto-starting Chrome debug (${cmd} ${argv[argv.length - 1]})...`);
    try {
        // detached + ignore: the starter daemonizes (or the ps1 launches Chrome
        // via Start-Process); we must not inherit its stdio into our stdout
        // machine contract, and we must not die with it.
        const child = spawn(cmd, argv, { detached: true, stdio: 'ignore', cwd: path.resolve(SCRIPTS_DIR, '..') });
        child.on('error', () => { /* surfaced by the port wait below */ });
        child.unref();
    } catch (e) {
        return { up: false, autostarted: false, reason: `spawn failed: ${e.message}` };
    }

    const deadline = Date.now() + AUTOSTART_WAIT_MS;
    while (Date.now() < deadline) {
        if (await probeCdp(url)) {
            log('Chrome CDP is up (auto-started).');
            return { up: true, autostarted: true };
        }
        await new Promise(r => setTimeout(r, AUTOSTART_POLL_MS));
    }
    return { up: false, autostarted: true, reason: `port still down ${AUTOSTART_WAIT_MS / 1000}s after auto-start` };
}

/**
 * Connect to Chrome CDP with retries.
 * @param {object} chromium — playwright-core chromium object (from caller's require)
 * @param {string} [cdpUrl] — CDP endpoint
 * @param {number} [retries=3]
 * @param {(msg: string) => void} [onLog] — log callback
 * @returns {Promise<Browser>}
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

/**
 * Check CDP connectivity. Exit on failure (CLI mode), or return boolean.
 * @param {boolean} [exitOnFail=true] — if true, process.exit on failure
 * @param {(msg: string) => void} [onLog]
 * @returns {Promise<boolean>}
 */
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

module.exports = { connectWithRetry, doctorCheck, ensureChromeCdp, probeCdp, startHint, isWSL, CDP_URL };
