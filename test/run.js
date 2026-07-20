#!/usr/bin/env node
/**
 * Zero-dependency test runner for AgentChat's root-level regression suites.
 *
 * Why this exists: the four `test_*.js` files at the repo root each encode real
 * invariants (selector fallbacks, ⚙-hold caps, image capture wiring, resilience
 * gates), but there was no `npm test`, no runner, and no discovery — so they
 * read as loose files a cloner is tempted to delete. This runner turns them into
 * an executable, CI-friendly suite WITHOUT changing any test or any product code.
 *
 * Isolation: every suite ends with `process.exit(...)`, so they cannot share a
 * process. Each is spawned in its own `node` child; a non-zero exit (or a suite
 * that cannot load its deps) fails the run. jsdom-dependent suites are skipped
 * with a clear notice — not failed — when devDependencies aren't installed, so
 * `npm test` degrades gracefully on a bare clone instead of erroring opaquely.
 */
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
// Suites now live under skills/lib/test/ (moved from repo root; see CHANGELOG).
const SUITE_DIR = path.join(ROOT, 'skills', 'lib', 'test');

// Suites that perform real network I/O (they spin up a localhost HTTP server and
// attempt actual downloads). Their pass/fail depends on the sandbox's network
// policy, so they are NOT part of the deterministic default run — gate them
// behind AGENTCHAT_TEST_NETWORK=1 so `npm test` stays green and reproducible on
// any machine. Nothing about the suites themselves changes; they are simply
// opt-in.
const NETWORK_SUITES = new Set(['test_v13_image_capture.js']);
const RUN_NETWORK = process.env.AGENTCHAT_TEST_NETWORK === '1';

// Discover suites: every top-level test_*.js. New suites are picked up
// automatically — no registry to keep in sync.
const suites = fs
    .readdirSync(SUITE_DIR)
    .filter((f) => /^test_.*\.js$/.test(f))
    .sort();

// External modules a suite may need at load time. A bare `git clone` has no
// node_modules, so if any required module is absent we SKIP the suite (with a
// clear notice) instead of failing — the suite's assertions never ran, which is
// not the same as a regression. jsdom is a devDependency; playwright-core is a
// runtime dependency pulled in transitively by suites that require
// AgentChat-OneWeb/index.js.
const OPTIONAL_DEPS = ['jsdom', 'playwright-core'];

function missingDepsFor(file) {
    let src;
    try {
        src = fs.readFileSync(path.join(SUITE_DIR, file), 'utf8');
    } catch (_) {
        return [];
    }
    return OPTIONAL_DEPS.filter((dep) => {
        // Suite pulls the dep in directly, or indirectly via AgentChat-OneWeb.
        const referenced =
            new RegExp(`require\\(['"]${dep}['"]\\)`).test(src) ||
            /AgentChat-OneWeb\/index\.js/.test(src);
        if (!referenced) return false;
        try {
            require.resolve(dep, { paths: [ROOT] });
            return false; // installed
        } catch (_) {
            return true; // missing
        }
    });
}

let failed = 0;
let skipped = 0;
let ran = 0;

if (suites.length === 0) {
    console.log('No test_*.js suites found in skills/lib/test/.');
    process.exit(0);
}

for (const file of suites) {
    if (NETWORK_SUITES.has(file) && !RUN_NETWORK) {
        console.log(`SKIP  ${file}  (network suite — set AGENTCHAT_TEST_NETWORK=1 to run)`);
        skipped++;
        continue;
    }
    const missing = missingDepsFor(file);
    if (missing.length) {
        console.log(
            `SKIP  ${file}  (missing: ${missing.join(', ')} — run \`npm install\` to enable)`
        );
        skipped++;
        continue;
    }
    process.stdout.write(`RUN   ${file}\n`);
    const res = spawnSync('node', [path.join(SUITE_DIR, file)], {
        cwd: ROOT,
        stdio: 'inherit',
    });
    ran++;
    if (res.status !== 0) {
        console.log(`FAIL  ${file}  (exit ${res.status})`);
        failed++;
    } else {
        console.log(`PASS  ${file}`);
    }
}

console.log(`\n${ran} ran, ${failed} failed, ${skipped} skipped`);
process.exit(failed ? 1 : 0);
