#!/usr/bin/env node
const AGENTCHAT_ROOT = require("path").resolve(__dirname, "..", "..", "..");
/**
 * v18 regression suite — Windows CDP unreachable fixes.
 *
 * Covers (all runnable on Linux CI; Windows-only branches are exercised via
 * their pure, exported building blocks):
 *   1. Wiring: OneWeb no longer hardcodes http://127.0.0.1 for CDP — it uses
 *      lib/cdp.js's CDP_URL (source-level assertion), and that CDP_URL folds
 *      in CDP_HOST + CDP_PORT (functional assertion via a child process).
 *   2. winArgQuote — CommandLineToArgvW semantics (spaces, embedded quotes,
 *      trailing backslash runs).
 *   3. buildWmiCreatePsCommand — PS single-quote doubling, PID emission,
 *      failure branch.
 *   4. parseProfileHolders — quoted/unquoted --user-data-dir, trailing slash,
 *      case-insensitivity, non-matching dirs excluded, malformed lines.
 *   5. looksLikeDefaultUserDataDir — Chrome ≥136 guard, three platforms,
 *      positive AND negative cases.
 *   6. isProcessAlive — self alive; freshly-exited child dead.
 *   7. waitForPortOrDeath — dead PID aborts the wait early (time-bounded),
 *      instead of burning the full budget.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const cdp = require(AGENTCHAT_ROOT + '/skills/lib/cdp');

let passed = 0;
let failed = 0;
function assert(cond, name) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}`); }
}

// ── 1. CDP_URL wiring ───────────────────────────────────────────────────────
console.log('[1] CDP_URL single source of truth (CDP_HOST regression)');
{
    const src = fs.readFileSync(path.join(AGENTCHAT_ROOT, 'skills', 'AgentChat-OneWeb', 'index.js'), 'utf8');
    assert(!/CDP_URL\s*=\s*`http:\/\/127\.0\.0\.1/.test(src),
        'OneWeb no longer builds its own hardcoded 127.0.0.1 CDP_URL');
    assert(/CDP_URL:\s*LIB_CDP_URL/.test(src) && /const CDP_URL = LIB_CDP_URL/.test(src),
        'OneWeb imports and uses lib/cdp.js CDP_URL');

    // Functional: a fresh child process with CDP_HOST/CDP_PORT set must see
    // them reflected in lib CDP_URL (env is read at require time).
    const libPath = path.join(AGENTCHAT_ROOT, 'skills', 'lib', 'cdp.js');
    const r = spawnSync(process.execPath,
        ['-e', `process.stdout.write(require(${JSON.stringify(libPath)}).CDP_URL)`],
        { env: { ...process.env, CDP_HOST: '10.9.8.7', CDP_PORT: '9333' }, encoding: 'utf8', timeout: 15000 });
    assert(r.status === 0 && r.stdout === 'http://10.9.8.7:9333',
        `lib CDP_URL honors CDP_HOST + CDP_PORT (got ${JSON.stringify(r.stdout)})`);
}

// ── 2. winArgQuote ──────────────────────────────────────────────────────────
console.log('[2] winArgQuote (CommandLineToArgvW semantics)');
{
    const q = cdp.winArgQuote;
    assert(q('--no-first-run') === '--no-first-run', 'plain token passes through unquoted');
    assert(q('--user-data-dir=C:\\Users\\Zi Wang\\.chrome-debug-profile') ===
           '"--user-data-dir=C:\\Users\\Zi Wang\\.chrome-debug-profile"',
        'token with space is wrapped, interior backslashes untouched');
    assert(q('a"b') === '"a\\"b"', 'embedded quote escaped as \\"');
    assert(q('C:\\dir with space\\') === '"C:\\dir with space\\\\"',
        'trailing backslash doubled before closing quote');
    assert(q('end\\\\"x') === '"end\\\\\\\\\\"x"',
        'backslash run before an embedded quote is doubled + quote escaped');
    assert(q('') === '""', 'empty arg becomes ""');
}

// ── 3. buildWmiCreatePsCommand ──────────────────────────────────────────────
console.log('[3] buildWmiCreatePsCommand');
{
    const cmd = cdp.buildWmiCreatePsCommand("C:\\Tom's Apps\\chrome.exe", ['--flag=1', 'C:\\a b\\p']);
    assert(cmd.includes('Invoke-CimMethod -ClassName Win32_Process -MethodName Create'),
        'uses WMI Win32_Process.Create (job breakaway)');
    assert(cmd.includes("Tom''s Apps"), "single quotes doubled for the PS literal");
    assert(cmd.includes('"C:\\a b\\p"'), 'space-bearing arg quoted inside the command line');
    assert(cmd.includes('[Console]::Out.Write($r.ProcessId)'), 'emits the real PID on success');
    assert(cmd.includes('exit 1'), 'non-zero ReturnValue exits non-zero');
}

// ── 4. parseProfileHolders ──────────────────────────────────────────────────
console.log('[4] parseProfileHolders');
{
    const profile = 'C:\\Users\\zi\\.chrome-debug-profile';
    const text = [
        '1234\t"C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --type=utility',                        // no user-data-dir
        '2345\t"C:\\...\\chrome.exe" --user-data-dir="C:\\Users\\ZI\\.chrome-debug-profile\\" --no-first-run',      // quoted, trailing slash, case
        '3456\t"C:\\...\\chrome.exe" --user-data-dir=C:\\Users\\zi\\.chrome-debug-profile https://gemini.google.com', // unquoted
        '4567\t"C:\\...\\msedge.exe" --user-data-dir="C:\\Users\\zi\\AppData\\Local\\Microsoft\\Edge\\User Data"',  // different dir
        'garbage line without tab',
        '\t--user-data-dir=C:\\Users\\zi\\.chrome-debug-profile',                                                   // no pid
    ].join('\r\n');
    const hits = cdp.parseProfileHolders(text, profile);
    assert(hits.length === 2, `exactly the two same-profile processes matched (got ${hits.length})`);
    assert(hits.some(h => h.pid === 2345) && hits.some(h => h.pid === 3456),
        'quoted+trailing-slash+case-insensitive AND unquoted forms both matched');
    assert(!hits.some(h => h.pid === 4567), 'a different user-data-dir is not a holder');
    assert(cdp.parseProfileHolders('', profile).length === 0, 'empty input → no holders');
    assert(cdp.parseProfileHolders(null, profile).length === 0, 'null input → no holders (never throws)');
}

// ── 5. looksLikeDefaultUserDataDir ──────────────────────────────────────────
console.log('[5] looksLikeDefaultUserDataDir (Chrome >=136 guard)');
{
    const f = cdp.looksLikeDefaultUserDataDir;
    assert(f('C:\\Users\\zi\\AppData\\Local\\Google\\Chrome\\User Data') === true, 'Windows Chrome default → true');
    assert(f('C:\\Users\\zi\\AppData\\Local\\Google\\Chrome\\User Data\\') === true, 'trailing slash tolerated');
    assert(f('C:\\Users\\zi\\AppData\\Local\\Microsoft\\Edge\\User Data') === true, 'Edge default → true');
    assert(f('/home/zi/.config/google-chrome') === true, 'Linux Chrome default → true');
    assert(f('/Users/zi/Library/Application Support/Google/Chrome') === true, 'macOS Chrome default → true');
    assert(f('C:\\Users\\zi\\.chrome-debug-profile') === false, 'dedicated debug profile → false');
    assert(f('D:\\stuff\\User Data') === false, 'a "User Data" dir outside vendor layout → false');
    assert(f('') === false && f(null) === false, 'empty/null → false');
}

// ── 6. isProcessAlive ───────────────────────────────────────────────────────
console.log('[6] isProcessAlive');
{
    assert(cdp.isProcessAlive(process.pid) === true, 'own PID is alive');
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 15000 });
    assert(child.status === 0 && cdp.isProcessAlive(child.pid) === false,
        'a freshly-exited child PID reads as dead');
    assert(cdp.isProcessAlive(0) === false && cdp.isProcessAlive(null) === false,
        'falsy PID → false (never throws)');
}

// ── 7. waitForPortOrDeath — early abort on death ────────────────────────────
console.log('[7] waitForPortOrDeath aborts early when the PID dies');
(async () => {
    const child = spawnSync(process.execPath, ['-e', ''], { timeout: 15000 }); // already dead
    const deadUrl = 'http://127.0.0.1:1'; // refused immediately, no server needed
    const t0 = Date.now();
    const res = await cdp.waitForPortOrDeath(deadUrl, child.pid, () => {}, 20_000);
    const elapsed = Date.now() - t0;
    assert(res.up === false && res.died === true, `dead PID reported as died (got ${JSON.stringify(res)})`);
    assert(elapsed < 8_000, `aborted well under the 20s budget (took ${elapsed}ms)`);

    // Budget path: no PID to watch, port never opens → up:false, died:false.
    const t1 = Date.now();
    const res2 = await cdp.waitForPortOrDeath(deadUrl, null, () => {}, 2_500);
    assert(res2.up === false && res2.died === false,
        `no-PID path exhausts budget without a death verdict (got ${JSON.stringify(res2)})`);
    assert(Date.now() - t1 >= 2_000, 'no-PID path actually waited out its budget');

    console.log(`\n${passed} passed, ${failed} failed`);
    process.exit(failed ? 1 : 0);
})();
