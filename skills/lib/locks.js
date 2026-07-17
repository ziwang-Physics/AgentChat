/**
 * Shared file locking — atomic mkdir-based mutex for provider mutual exclusion.
 *
 * Used by AgentChat-IndependentTasks and AgentChat-WebSubAgent.
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

/**
 * Reclaim a stale lock via atomic rename.
 *
 * @param {string} lockDir
 * @param {string|null} expectedPidData — the exact pid-file content we based the
 *        "stale" decision on, or null when the pid file was missing (orphan dir).
 *
 * RACE FIX: renameSync is the atomic arbiter between concurrent reclaimers, but
 * the old "last resort" branch blind-rmSync'ed lockDir when rename failed. The
 * rename LOSER would then delete the WINNER's freshly recreated lock and mkdir
 * its own — leaving TWO processes convinced they hold the same provider lock
 * (exactly the tab-collision class the locks exist to prevent). Now the loser
 * only falls back to direct removal if the pid file provably still contains the
 * same stale content it originally judged (rename can fail spuriously on
 * Windows when a handle inside the dir is open); any other state means another
 * process won the race, so we bail with false.
 */
function tryReclaim(lockDir, expectedPidData = null) {
    // Unique suffix — a fixed `.stale.<pid>` target collides (rename onto an
    // existing non-empty dir throws) when the same process reclaims twice.
    const staleDir = `${lockDir}.stale.${process.pid}.${Date.now()}`;
    try {
        fs.renameSync(lockDir, staleDir);
        try { fs.rmSync(staleDir, { recursive: true, force: true }); } catch (_) {}
    } catch (_) {
        // Rename failed — most likely another reclaimer already won.
        try {
            const current = fs.readFileSync(path.join(lockDir, "pid"), "utf8").trim();
            if (expectedPidData === null || current !== expectedPidData) {
                return false; // lock changed hands — it is NOT ours to remove
            }
            // Same stale content still in place → rename failed for another
            // reason (e.g. Windows EPERM). Direct removal is safe-ish here.
            fs.rmSync(lockDir, { recursive: true, force: true });
        } catch (_) {
            return false; // can't verify ownership — never delete blind
        }
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
                    return tryReclaim(lockDir, null); // orphan — no pid to verify
                }
                return false;
            }

            const lines = data.split("\n");
            const oldPid = parseInt(lines[0], 10);
            const ts = parseInt(lines[1] || "0", 10);

            // Hard TTL: timestamp was never used before — OS can reuse PIDs
            // after the original process dies, making process.kill() unsafe.
            if (ts && Date.now() - ts > LOCK_TTL_MS) {
                return tryReclaim(lockDir, data);
            }

            // Check if the process is still alive
            try {
                process.kill(oldPid, 0);
                return false; // process alive — lock is valid
            } catch (_) {
                // Process dead — safe to reclaim
                return tryReclaim(lockDir, data);
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
        if (parseInt(data.split("\n")[0], 10) !== process.pid) return;
        // Atomic release: rename-then-delete, matching tryReclaim. A direct
        // rmSync had a narrow TOCTOU — if OUR lock was TTL-reclaimed by another
        // process between the read above and the removal (run > 30min), we'd
        // delete the new holder's lock. If the rename loses that race, the
        // lock is no longer ours and we leave it alone.
        const staleDir = `${lockDir}.release.${process.pid}.${Date.now()}`;
        try {
            fs.renameSync(lockDir, staleDir);
            fs.rmSync(staleDir, { recursive: true, force: true });
        } catch (_) { /* reclaimed concurrently — not ours anymore */ }
    } catch (_) {}
}

// ══════════════════════════════════════════════════════════════════════════════
// BROWSER ADMISSION SLOTS — cross-process cap on CONCURRENT page automations
// ══════════════════════════════════════════════════════════════════════════════
//
// Provider locks serialize same-provider access, but 7 workers each grabbing a
// DIFFERENT provider still means 7 simultaneous page automations inside ONE
// shared Chrome — CPU contention plus a burst pattern that trips per-browser
// throttling on some provider sites. The mainstream fix is client-side
// bounded concurrency (semaphore / token bucket), NOT anti-bot evasion.
//
// Implementation: N slot locks named browser-slot-0..N-1, acquired through the
// SAME acquireLock/releaseLock machinery above — inheriting, for free, the
// atomic-mkdir mutex, orphan recovery, dead-PID reclaim, 30min TTL, and the
// rename-based TOCTOU protections. cleanupAllLocks() sweeps held slots too.
//
// Failure policy (deliberate): acquireBrowserSlot returning null after waitMs
// means "browser is busy", and the CALLER decides — OneWeb logs a loud warning
// and proceeds uncapped rather than failing, so admission control can never
// introduce a new deadlock/starvation failure class. Crash safety needs no
// extra code: a crashed holder's slot is reclaimed by the dead-PID check.

const BROWSER_SLOT_PREFIX = "browser-slot-";
const DEFAULT_MAX_SLOTS = 3;

/** Resolve the slot cap: AGENTCHAT_MAX_CONCURRENT_PAGES env, clamped 1..16. */
function resolveMaxSlots(env = process.env) {
    const n = parseInt(env.AGENTCHAT_MAX_CONCURRENT_PAGES, 10);
    if (Number.isFinite(n) && n >= 1) return Math.min(n, 16);
    return DEFAULT_MAX_SLOTS;
}

/**
 * Acquire one browser-automation slot.
 *
 * @param {object} [o]
 * @param {number} [o.max]     slot count (default: resolveMaxSlots())
 * @param {number} [o.waitMs]  how long to keep retrying (0 = single pass)
 * @param {(msg: string) => void} [o.log]
 * @returns {Promise<number|null>} slot index, or null if none free in time
 */
async function acquireBrowserSlot({ max, waitMs = 0, log = () => {} } = {}) {
    const slots = max || resolveMaxSlots();
    const deadline = Date.now() + waitMs;
    for (;;) {
        for (let i = 0; i < slots; i++) {
            if (acquireLock(BROWSER_SLOT_PREFIX + i)) return i;
        }
        const left = deadline - Date.now();
        if (left <= 0) return null;
        // Jittered retry — de-synchronizes workers that arrived in a wave
        // (fixed intervals re-collide forever under barrier-released workers).
        const nap = Math.min(left, 1500 + Math.floor(Math.random() * 1500));
        log(`browser busy (all ${slots} automation slots taken) — retrying in ${(nap / 1000).toFixed(1)}s`);
        await new Promise(r => setTimeout(r, nap));
    }
}

/** Release a slot from acquireBrowserSlot. null/undefined no-ops. */
function releaseBrowserSlot(slot) {
    if (Number.isInteger(slot) && slot >= 0) releaseLock(BROWSER_SLOT_PREFIX + slot);
}

function cleanupAllLocks() {
    let entries;
    try { entries = fs.readdirSync(LOCK_DIR); } catch (_) { return; }
    for (const name of entries) {
        // Skip leftover .stale./.release. transfer dirs — best-effort sweep of
        // our own, in case an rmSync was interrupted mid-teardown.
        if (name.includes(".stale.") || name.includes(".release.")) {
            if (name.includes(`.${process.pid}.`)) {
                try { fs.rmSync(path.join(LOCK_DIR, name), { recursive: true, force: true }); } catch (_) {}
            }
            continue;
        }
        releaseLock(name); // pid-verified atomic release (see above)
    }
}

module.exports = {
    acquireLock, releaseLock, cleanupAllLocks, LOCK_DIR,
    // v17: browser-level admission control
    acquireBrowserSlot, releaseBrowserSlot, resolveMaxSlots, BROWSER_SLOT_PREFIX,
};
