/**
 * Shared file locking — atomic mkdir-based mutex for provider mutual exclusion.
 *
 * Used by AgentChat-FreeSubAgent and Web-SubAgent-Workflow.
 * Locks live in /tmp/ai_locks/<provider>/ — one directory per provider.
 * Only the process that successfully creates the directory holds the lock.
 * Stale-lock cleanup uses atomic renameSync to avoid TOCTOU races.
 *
 * v2 (2026-07-04):
 *   - Orphan directory recovery (crash between mkdirSync & writeFileSync)
 *   - 30min hard TTL (OS can reuse PIDs after process death)
 *   - All reclaim goes through atomic renameSync
 */

const fs = require("fs");
const path = require("path");
const os = require("os");

const LOCK_DIR = path.join(os.tmpdir(), "ai_locks");
try { fs.mkdirSync(LOCK_DIR, { recursive: true }); } catch (_) {}

const ORPHAN_GRACE_MS = 30_000;   // 30s grace for orphan dirs (no pid file)
const LOCK_TTL_MS = 30 * 60_000;  // 30min hard TTL (OS pid reuse window)

function tryReclaim(lockDir) {
    const staleDir = `${lockDir}.stale.${process.pid}`;
    try {
        fs.renameSync(lockDir, staleDir);
        fs.rmSync(staleDir, { recursive: true, force: true });
    } catch (_) {
        // renameSync failed — try direct removal as last resort
        try { fs.rmSync(lockDir, { recursive: true, force: true }); } catch (_) {}
    }
    try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n${Date.now()}`);
        return true;
    } catch (_) {
        return false;
    }
}

function acquireLock(provider) {
    const lockDir = path.join(LOCK_DIR, provider);
    try {
        fs.mkdirSync(lockDir);
        fs.writeFileSync(path.join(lockDir, "pid"), `${process.pid}\n${Date.now()}`);
        return true;
    } catch (_) {
        // Lock exists — check if stale
        try {
            const pidFile = path.join(lockDir, "pid");
            let data;
            try {
                data = fs.readFileSync(pidFile, "utf8").trim();
            } catch (_) {
                // Orphan directory: pid file missing.
                // Happens when process crashes between mkdirSync and writeFileSync.
                // Recover if the directory is older than the grace period.
                const stat = fs.statSync(lockDir);
                if (Date.now() - stat.mtimeMs > ORPHAN_GRACE_MS) {
                    return tryReclaim(lockDir);
                }
                return false;
            }

            const lines = data.split("\n");
            const oldPid = parseInt(lines[0], 10);
            const ts = parseInt(lines[1] || "0", 10);

            // Hard TTL: timestamp was never used before — OS can reuse PIDs
            // after the original process dies, making process.kill() unsafe.
            if (ts && Date.now() - ts > LOCK_TTL_MS) {
                return tryReclaim(lockDir);
            }

            // Check if the process is still alive
            try {
                process.kill(oldPid, 0);
                return false; // process alive — lock is valid
            } catch (_) {
                // Process dead — safe to reclaim
                return tryReclaim(lockDir);
            }
        } catch (_) {
            return false;
        }
    }
}

function releaseLock(provider) {
    const lockDir = path.join(LOCK_DIR, provider);
    try {
        const pidFile = path.join(lockDir, "pid");
        const data = fs.readFileSync(pidFile, "utf8").trim();
        if (parseInt(data.split("\n")[0], 10) === process.pid) {
            fs.rmSync(lockDir, { recursive: true, force: true });
        }
    } catch (_) {}
}

function cleanupAllLocks() {
    let entries;
    try { entries = fs.readdirSync(LOCK_DIR); } catch (_) { return; }
    for (const name of entries) {
        const lockDir = path.join(LOCK_DIR, name);
        try {
            const pidFile = path.join(lockDir, "pid");
            const data = fs.readFileSync(pidFile, "utf8").trim();
            if (parseInt(data.split("\n")[0], 10) === process.pid) {
                fs.rmSync(lockDir, { recursive: true, force: true });
            }
        } catch (_) {}
    }
}

module.exports = { acquireLock, releaseLock, cleanupAllLocks, LOCK_DIR };
