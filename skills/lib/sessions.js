/**
 * Session URL persistence — resume multi-turn conversations.
 *
 * Each provider's web UI generates a unique session URL after the first
 * message (e.g. https://www.doubao.com/chat/38435105284969218). By saving
 * and reusing this URL, subsequent calls continue the same conversation
 * instead of starting a fresh chat every time.
 *
 * Storage: ~/.local/state/agentchat/sessions.json
 *   { "doubao": "https://www.doubao.com/chat/38435...", "kimi": "..." }
 *
 * Expiry: sessions are treated as sticky — they persist until a navigation
 * failure indicates the session is gone (404, auth redirect, etc.), at which
 * point the entry is cleared and the next call falls back to the base URL.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = path.join(os.homedir(), '.local', 'state', 'agentchat');
const SESSIONS_FILE = path.join(STATE_DIR, 'sessions.json');

function _ensureDir() {
    if (!fs.existsSync(STATE_DIR)) {
        fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    }
}

function _read() {
    try {
        if (!fs.existsSync(SESSIONS_FILE)) return {};
        const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return {};
    }
}

function _write(data) {
    _ensureDir();
    fs.writeFileSync(SESSIONS_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Get the saved session URL for a provider, or null.
 * @param {string} providerKey
 * @returns {string|null}
 */
function getSessionUrl(providerKey) {
    const data = _read();
    return data[providerKey] || null;
}

/**
 * Save the current session URL for a provider.
 * Only saves URLs that differ from the base URL (have a session component).
 * @param {string} providerKey
 * @param {string} url - current page URL
 * @param {string} baseUrl - provider's base URL from config
 */
function saveSessionUrl(providerKey, url, baseUrl) {
    // Only save if the URL has a meaningful session component
    // (longer than the base URL + has a path/id segment)
    if (!url || url === baseUrl) return;

    try {
        const parsed = new URL(url);
        const baseParsed = new URL(baseUrl);
        // Must be on the same host and have a non-trivial path beyond the base
        if (parsed.hostname !== baseParsed.hostname) return;
        if (parsed.pathname === baseParsed.pathname) return;

        const data = _read();
        data[providerKey] = url;
        _write(data);
    } catch {
        // URL parsing failure — skip
    }
}

/**
 * Clear the saved session URL for a provider.
 * Called when the session URL is no longer valid.
 * @param {string} providerKey
 */
function clearSessionUrl(providerKey) {
    const data = _read();
    if (data[providerKey]) {
        delete data[providerKey];
        _write(data);
    }
}

module.exports = { getSessionUrl, saveSessionUrl, clearSessionUrl };