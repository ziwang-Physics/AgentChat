/**
 * Shared CDP utilities — connect, health check, and doctor diagnostics.
 *
 * Used by WebExtended and FreeSubAgent skills.
 * Eliminates ~70 lines of duplicated connectWithRetry + doctorCheck logic.
 *
 * NOTE: connectWithRetry takes `chromium` as first arg (imported by caller)
 *       because this lib/ dir has no node_modules — playwright-core lives
 *       under each skill's own node_modules/.
 */

const http = require('http');

const DEFAULT_CDP_PORT = process.env.CDP_PORT || '9222';
const CDP_URL = `http://127.0.0.1:${DEFAULT_CDP_PORT}`;

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
    try {
        const res = await new Promise((resolve, reject) => {
            const req = http.get(CDP_URL + '/json/version', (res) => {
                let data = '';
                res.on('data', c => data += c);
                res.on('end', () => resolve({ ok: true, data }));
            });
            req.on('error', reject);
            req.setTimeout(5000, () => { req.destroy(); reject(new Error('CDP GET timeout')); });
        });
        log(`Chrome CDP reachable: ${res.data.substring(0, 100)}`);
        return true;
    } catch (e) {
        log('Chrome CDP is NOT reachable on ' + CDP_URL);
        log('Run: bash scripts/start-chrome-debug.sh');
        if (exitOnFail) process.exit(1);
        return false;
    }
}

module.exports = { connectWithRetry, doctorCheck, CDP_URL };
