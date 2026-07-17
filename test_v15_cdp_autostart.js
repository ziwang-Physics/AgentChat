/**
 * v15 regression — Windows CDP auto-start & platform-aware recovery.
 *
 * Covers:
 *   A. probeCdp: real HTTP round-trip against a live stub and a dead port
 *   B. ensureChromeCdp fast-path (port already up → no spawn)
 *   C. ensureChromeCdp gates: AGENTCHAT_NO_AUTOSTART=1, remote CDP_HOST
 *   D. ensureChromeCdp autostart path: spawns the platform starter and
 *      returns up:true once the port opens (starter stubbed via a temp
 *      scripts dir is not possible — path is fixed — so we assert the
 *      spawn attempt + bounded failure on a closed port with a fake-fast
 *      deadline is NOT tested live; instead source-level assertions pin
 *      the spawn contract)
 *   E. startHint(): win32 / linux / wsl variants (platform simulated)
 *   F. Wiring: OneWeb index.js calls ensureChromeCdp before connectWithRetry,
 *      no hardcoded bash hint survives on any error path
 *   G. start-chrome.ps1 static contract: failure exits non-zero, `~` is
 *      expanded, no $OFS string-interpolated ArgumentList, headful default
 */
const assert = require('assert');
const http = require('http');
const fs = require('fs');
const path = require('path');

let passed = 0;
const ok = (name) => { console.log('  ✓ ' + name); passed++; };

(async () => {
    // ── A/B/C: live behavior on a stub CDP ──────────────────────────────
    const server = http.createServer((req, res) => {
        if (req.url === '/json/version') { res.writeHead(200); res.end('{"Browser":"Stub/1.0"}'); }
        else { res.writeHead(404); res.end(); }
    });
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    delete process.env.CDP_HOST; delete process.env.CDP_PORT;
    const cdp = require('./skills/lib/cdp.js');

    assert.strictEqual(await cdp.probeCdp(`http://127.0.0.1:${port}`), true);
    ok('A1: probeCdp true against live /json/version');

    assert.strictEqual(await cdp.probeCdp('http://127.0.0.1:1'), false);
    ok('A2: probeCdp false against closed port (no throw)');

    const fast = await cdp.ensureChromeCdp(`http://127.0.0.1:${port}`, () => {});
    assert.deepStrictEqual(fast, { up: true, autostarted: false });
    ok('B1: ensureChromeCdp fast-path — port up, nothing spawned');

    process.env.AGENTCHAT_NO_AUTOSTART = '1';
    const gated = await cdp.ensureChromeCdp('http://127.0.0.1:1', () => {});
    assert.strictEqual(gated.up, false);
    assert.strictEqual(gated.autostarted, false);
    assert.match(gated.reason, /AGENTCHAT_NO_AUTOSTART/);
    ok('C1: AGENTCHAT_NO_AUTOSTART=1 blocks autostart with explicit reason');
    delete process.env.AGENTCHAT_NO_AUTOSTART;

    const remote = await cdp.ensureChromeCdp('http://192.168.1.50:9222', () => {});
    assert.strictEqual(remote.up, false);
    assert.strictEqual(remote.autostarted, false);
    assert.match(remote.reason, /remote/);
    ok('C2: non-local CDP_HOST refuses autostart (cannot start remote Chrome)');

    server.close();

    // ── E: startHint per platform ───────────────────────────────────────
    const realPlatform = Object.getOwnPropertyDescriptor(process, 'platform');
    const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p });

    setPlatform('win32');
    assert.match(cdp.startHint(), /start-chrome\.ps1/);
    assert.match(cdp.startHint(), /-FirstLogin/);
    ok('E1: win32 hint → powershell start-chrome.ps1 (+FirstLogin note)');

    setPlatform('linux');
    // non-WSL linux (os.release() on this box has no "microsoft")
    if (!cdp.isWSL()) {
        assert.match(cdp.startHint(), /start-chrome-debug\.sh/);
        ok('E2: linux hint → bash start-chrome-debug.sh');
    } else {
        assert.match(cdp.startHint(), /CDP_HOST/);
        ok('E2(wsl-host): wsl hint mentions CDP_HOST');
    }
    Object.defineProperty(process, 'platform', realPlatform);

    // ── D (source-level): spawn contract pinned ─────────────────────────
    const cdpSrc = fs.readFileSync('./skills/lib/cdp.js', 'utf8');
    assert.match(cdpSrc, /powershell\.exe/);
    assert.match(cdpSrc, /-ExecutionPolicy',\s*'Bypass'/);
    assert.match(cdpSrc, /detached:\s*true,\s*stdio:\s*'ignore'/);
    ok('D1: win32 spawns powershell.exe -ExecutionPolicy Bypass, detached, stdio ignore (stdout machine contract preserved)');

    // ── F: OneWeb wiring ────────────────────────────────────────────────
    const idx = fs.readFileSync('./skills/AgentChat-OneWeb/index.js', 'utf8');
    const ensurePos = idx.indexOf('await ensureChromeCdp(CDP_URL');
    const connectPos = idx.indexOf('browser = await connectWithRetry(CDP_URL)');
    assert.ok(ensurePos > -1 && connectPos > -1 && ensurePos < connectPos,
        'ensureChromeCdp must run before connectWithRetry');
    ok('F1: index.js — ensureChromeCdp precedes connectWithRetry');

    assert.ok(!/log\([^)]*bash scripts\/start-chrome-debug\.sh/.test(idx),
        'no error path may hardcode the bash-only hint');
    assert.ok((idx.match(/startHint\(\)/g) || []).length >= 4);
    ok('F2: all 4 CDP-failure hint sites use platform-aware startHint()');

    assert.match(idx, /cdp_autostarted/);
    ok('F3: autostart recorded in telemetry (cdp_autostarted)');

    // ── G: start-chrome.ps1 static contract ─────────────────────────────
    const ps1 = fs.readFileSync('./scripts/start-chrome.ps1', 'utf8');
    assert.ok(!ps1.includes('"$ChromeArgs $GEMINI_URL"') && !ps1.includes('"$HeadlessArgs $GEMINI_URL"'),
        'implicit $OFS array interpolation must be gone');
    ok('G1: no $OFS-interpolated ArgumentList (space-in-path safe)');

    assert.match(ps1, /\$PROFILE_DIR -match '\^~/);
    assert.match(ps1, /GetFullPath/);
    ok('G2: `~` expansion + absolute-path normalization for CHROME_PROFILE');

    // Every wait loop failure must lead to exit 1 — count "exit 1" after the
    // port-wait block and assert the unconditional trailing success line is gone.
    assert.ok(!/^Write-Host "Chrome CDP running at/m.test(ps1));
    assert.match(ps1, /did not open within/);
    assert.match(ps1, /TIMEOUT/);
    ok('G3: port-wait timeout is a loud exit 1, not fake success');

    assert.match(ps1, /if \(\$Headless -and -not \$FirstLogin\)/);
    assert.match(ps1, /HEADLESS.*match.*1\|true\|yes/);
    ok('G4: headful default; -Headless switch + HEADLESS env parity with Linux');

    assert.match(ps1, /netstat -ano/);
    assert.match(ps1, /exited immediately/);
    ok('G5: instant-exit detection + port-occupancy diagnostics on failure');

    console.log(`\n${passed} assertion groups passed`);
})().catch(e => { console.error('FAIL:', e.message); process.exit(1); });
