/**
 * v16 regression — embedded Chrome launcher (workbuddy skill-only deployment).
 *
 * Root cause covered: scripts/ lives OUTSIDE skills/, so skill-only installs
 * (C:\Users\<u>\.workbuddy\skills\AgentChat\) never have the start scripts;
 * v15's autostart died with "starter not found" on every cold run.
 *
 *   A. expandHome
 *   B. loadDotEnv safety: values with $(...)/backticks stay literal strings,
 *      never executed; process.env precedence; quotes stripped
 *   C. findChromeBinary: CHROMIUM_PATH (incl. ~ form) wins when it exists
 *   D. buildChromeArgs: security parity (no allow-origins/*, no
 *      ignore-certificate-errors), headful default, HEADLESS opt-in,
 *      PROXY_SERVER passthrough
 *   E. E2E: scripts dir ABSENT (AGENTCHAT_SCRIPTS_DIR → empty tmp) +
 *      CHROMIUM_PATH → stub binary that serves /json/version ⇒
 *      ensureChromeCdp returns {up:true, autostarted:true, method:'direct'};
 *      pid file written with the same name the ps1 -Stop manages;
 *      stale SingletonLock removed
 *   F. Wiring: telemetry records cdp_autostart_method
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passed = 0;
const ok = (n) => { console.log('  ✓ ' + n); passed++; };
const tmp = (n) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), n)); return d; };

(async () => {
    // Fresh module instance per phase where env matters
    const freshCdp = () => { delete require.cache[require.resolve('./skills/lib/cdp.js')]; return require('./skills/lib/cdp.js'); };

    // ── B: .env safe parse (must run before other phases touch env) ──────
    const envDir = tmp('ac-env-');
    fs.writeFileSync(path.join(envDir, '.env'), [
        '# comment',
        'AC_TEST_PLAIN=hello',
        'AC_TEST_QUOTED="with spaces"',
        "AC_TEST_INJ=$(touch /tmp/ac_pwned_v16)`touch /tmp/ac_pwned2_v16`",
        'AC_TEST_PRECEDENCE=from_file',
        'not a kv line',
    ].join('\n'));
    process.env.AGENTCHAT_ENV_FILE = path.join(envDir, '.env');
    process.env.AC_TEST_PRECEDENCE = 'from_env';
    fs.rmSync('/tmp/ac_pwned_v16', { force: true });
    fs.rmSync('/tmp/ac_pwned2_v16', { force: true });
    let cdp = freshCdp();
    assert.strictEqual(process.env.AC_TEST_PLAIN, 'hello');
    assert.strictEqual(process.env.AC_TEST_QUOTED, 'with spaces');
    assert.strictEqual(process.env.AC_TEST_INJ, '$(touch /tmp/ac_pwned_v16)`touch /tmp/ac_pwned2_v16`');
    assert.ok(!fs.existsSync('/tmp/ac_pwned_v16') && !fs.existsSync('/tmp/ac_pwned2_v16'),
        '.env values must NEVER be executed');
    assert.strictEqual(process.env.AC_TEST_PRECEDENCE, 'from_env');
    assert.strictEqual(cdp.LOADED_ENV_FILE, path.join(envDir, '.env'));
    ok('B1: .env parsed safely — injection stays literal, env wins, quotes stripped');

    // ── A: expandHome ────────────────────────────────────────────────────
    assert.strictEqual(cdp.expandHome('~'), os.homedir());
    assert.strictEqual(cdp.expandHome('~/x/y'), path.join(os.homedir(), 'x/y'));
    assert.strictEqual(cdp.expandHome('/abs/p'), '/abs/p');
    assert.strictEqual(cdp.expandHome('C:\\Users\\DELL\\p'), 'C:\\Users\\DELL\\p');
    assert.strictEqual(cdp.expandHome(undefined), undefined);
    ok('A1: expandHome — ~, ~/x, absolute & win paths, undefined passthrough');

    // ── C: findChromeBinary honors CHROMIUM_PATH (incl. ~) ───────────────
    const stubDir = tmp('ac-chrome-');
    const stubBin = path.join(stubDir, 'chrome-stub');
    fs.writeFileSync(stubBin, '#!/bin/bash\ntrue\n'); fs.chmodSync(stubBin, 0o755);
    process.env.CHROMIUM_PATH = stubBin;
    assert.strictEqual(cdp.findChromeBinary(), stubBin);
    ok('C1: CHROMIUM_PATH wins when the file exists');

    // ── D: buildChromeArgs contract ──────────────────────────────────────
    delete process.env.HEADLESS; delete process.env.PROXY_SERVER;
    let args = cdp.buildChromeArgs('9333', '/p/rofile');
    const joined = args.join(' ');
    assert.ok(joined.includes('--remote-debugging-port=9333'));
    assert.ok(joined.includes('--user-data-dir=/p/rofile'));
    assert.ok(!joined.includes('--remote-allow-origins'), 'security parity: no allow-origins');
    assert.ok(!joined.includes('--ignore-certificate-errors'), 'security parity: no ignore-cert');
    assert.ok(!joined.includes('--headless'), 'headful by default');
    process.env.HEADLESS = 'true'; process.env.PROXY_SERVER = 'http://127.0.0.1:7897';
    args = cdp.buildChromeArgs('9333', '/p/rofile');
    assert.ok(args.includes('--headless=new') && args.includes('--proxy-server=http://127.0.0.1:7897'));
    delete process.env.HEADLESS; delete process.env.PROXY_SERVER;
    ok('D1: hardened flag set — security parity, headful default, HEADLESS/PROXY_SERVER honored');

    // ── E: E2E — no scripts dir → embedded launcher brings the port up ───
    const port = 19333;
    const emptyScripts = tmp('ac-noscripts-');
    process.env.AGENTCHAT_SCRIPTS_DIR = emptyScripts;          // tier-1 miss
    const profileDir = tmp('ac-profile-');
    process.env.CHROME_PROFILE = profileDir;
    fs.writeFileSync(path.join(profileDir, 'SingletonLock'), 'stale');
    // Stub "Chrome": parses --remote-debugging-port and serves /json/version.
    const fakeChrome = path.join(stubDir, 'fake-chrome.sh');
    fs.writeFileSync(fakeChrome, `#!/bin/bash
for a in "$@"; do case "$a" in --remote-debugging-port=*) PORT="\${a#*=}";; esac; done
exec python3 -c "
import http.server, socketserver, json, sys
class H(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        if self.path=='/json/version':
            b=json.dumps({'Browser':'FakeChrome/1.0'}).encode()
            self.send_response(200); self.send_header('Content-Length',len(b)); self.end_headers(); self.wfile.write(b)
        else: self.send_response(404); self.end_headers()
    def log_message(self,*a): pass
socketserver.TCPServer(('127.0.0.1', int('\$PORT')), H).serve_forever()
"
`); fs.chmodSync(fakeChrome, 0o755);
    process.env.CHROMIUM_PATH = fakeChrome;
    // v15 F-series guard must not fire: findStartScript should be null here
    cdp = freshCdp();
    assert.strictEqual(cdp.findStartScript(), null);
    ok('E1: skill-only deployment simulated — findStartScript() === null');

    const t0 = Date.now();
    const r = await cdp.ensureChromeCdp(`http://127.0.0.1:${port}`, () => {});
    assert.strictEqual(r.up, true);
    assert.strictEqual(r.autostarted, true);
    assert.strictEqual(r.method, 'direct');
    ok(`E2: ensureChromeCdp → {up:true, method:'direct'} in ${Date.now() - t0}ms with ZERO external scripts`);

    assert.ok(!fs.existsSync(path.join(profileDir, 'SingletonLock')), 'stale singleton lock must be cleared');
    ok('E3: stale SingletonLock removed before launch');

    const pidFile = cdp.CHROME_PID_FILE;
    assert.strictEqual(path.basename(pidFile), 'chrome-debug.chrome.pid');
    assert.ok(fs.existsSync(pidFile), 'pid file must be written');
    const pid = parseInt(fs.readFileSync(pidFile, 'utf8'), 10);
    assert.ok(pid > 0);
    ok('E4: pid file written with ps1-compatible name (start-chrome.ps1 -Stop interop)');
    try { process.kill(-pid, 'SIGKILL'); } catch (_) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    fs.rmSync(pidFile, { force: true });

    // ps1 parity pin — both sides must keep using the same pid filename
    const ps1 = fs.readFileSync('./scripts/start-chrome.ps1', 'utf8');
    assert.ok(ps1.includes('chrome-debug.chrome.pid'));
    ok('E5: ps1 uses the identical pid filename (interop pinned)');

    // ── F: telemetry wiring ──────────────────────────────────────────────
    const idx = fs.readFileSync('./skills/AgentChat-OneWeb/index.js', 'utf8');
    assert.match(idx, /cdp_autostart_method/);
    ok('F1: index.js records cdp_autostart_method (script|direct) in telemetry');

    // cleanup env for downstream suites
    delete process.env.AGENTCHAT_ENV_FILE; delete process.env.AGENTCHAT_SCRIPTS_DIR;
    delete process.env.CHROMIUM_PATH; delete process.env.CHROME_PROFILE;

    console.log(`\n${passed} assertion groups passed`);
    process.exit(0);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
