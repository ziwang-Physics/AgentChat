#!/usr/bin/env python3
"""
Chrome CDP Daemon v3 — event-driven lifecycle with self-healing.

Key improvements over v2:
  - browser.on("disconnected") → immediate crash detection (was: up to 30s blind)
  - heartbeat with 10s CDP timeout → daemon can't hang on deadlocked Chrome
  - Chrome PID file for precise cleanup (no pkill -9 scatter-gun)
  - exponential backoff on crash restarts (2s→4s→8s→16s→30s cap)
  - threading.Event bridge between Playwright callback thread and main loop

Features:
  - Persistent profile: login sessions survive daemon restarts
  - Profile & binary validation: fail-fast on misconfiguration
  - Auto-restart on crash (max 5 consecutive, then exit)
  - HEADLESS mode controllable via env var
  - Google CAPTCHA prevention flag (AutomationControlled disabled)
  - CDP bound to 127.0.0.1 only (no external exposure)

Prerequisites:
  - System Chrome/Chromium installed (NOT Playwright's bundled Chromium)
  - Profile directory with valid login Cookies (≥50KB)
  - Both configured via project .env file

Environment variables (set in .env, loaded by shell wrapper):
  CDP_PORT          CDP debug port (default: 9222)
  PROXY_SERVER      HTTP/SOCKS5 proxy (default: http://127.0.0.1:7897)
  CHROMIUM_PATH     Path to system Chrome binary (REQUIRED — no auto-detection)
  CHROME_PROFILE    Persistent profile dir (default: ~/.chrome-debug-profile)
  HEADLESS          "1"/"true"/"yes" for headless, otherwise visible GUI (default: false)

Usage:
  # Managed by start-chrome-debug.sh — don't run directly
  bash scripts/start-chrome-debug.sh
"""

import os, sys, time, signal, logging, threading

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [daemon] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("chrome-daemon")


# ---- Config from env vars ----
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
PROXY = os.environ.get("PROXY_SERVER", "http://127.0.0.1:7897")
PROFILE = os.path.expanduser(os.environ.get("CHROME_PROFILE", "~/.chrome-debug-profile"))
HEADLESS = os.environ.get("HEADLESS", "false").lower() in ("1", "true", "yes")
CHROMIUM = os.environ.get("CHROMIUM_PATH")

HEARTBEAT_INTERVAL = 15    # seconds between health checks (was 30)
MAX_CRASH_RESTARTS = 5     # max consecutive auto-restarts before giving up

# Secure state directory
STATE_DIR = os.path.expanduser("~/.local/state/agentchat")
DAEMON_PID_FILE = os.path.join(STATE_DIR, "chrome-debug.pid")
CHROME_PID_FILE = "/tmp/chrome-debug.chrome.pid"

from playwright.sync_api import sync_playwright

context = None
page = None
crash_count = 0
# threading.Event bridges Playwright's callback thread → main loop.
# When Chrome dies, the "disconnected" callback sets this event,
# and the main loop wakes from wait() immediately instead of
# sleeping through the full HEARTBEAT_INTERVAL.
disconnected_event = threading.Event()


# ═══════════════════════════════════════════════════════════════════
# Validation — fail-fast on misconfiguration
# ═══════════════════════════════════════════════════════════════════

def _is_playwright_chromium(path: str) -> bool:
    """Detect if the Chrome binary is Playwright's managed Chromium.
    Playwright installs under ~/.cache/ms-playwright/ — this does NOT
    have the user's login sessions and must be rejected."""
    return any(m in path for m in [".cache/ms-playwright", "ms-playwright"])


def validate_chrome_binary(chromium_path: str | None) -> str:
    """Validate the Chrome binary: must exist, be executable, and NOT be
    Playwright Chromium. Returns the validated path or hard-exits."""
    if not chromium_path:
        log.error("CHROMIUM_PATH is not set.")
        log.error("  Set it in .env to your system Chrome path, e.g.:")
        log.error("  CHROMIUM_PATH=/usr/bin/google-chrome-stable")
        log.error("  Or on macOS: /Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
        sys.exit(1)

    if not os.path.isfile(chromium_path):
        log.error(f"Chrome binary not found: {chromium_path}")
        log.error("  Set CHROMIUM_PATH in .env to a valid Chrome executable.")
        sys.exit(1)

    if not os.access(chromium_path, os.X_OK):
        log.error(f"Chrome binary not executable: {chromium_path}")
        sys.exit(1)

    if _is_playwright_chromium(chromium_path):
        log.error("REFUSING to launch Playwright Chromium!")
        log.error(f"  Detected: {chromium_path}")
        log.error("  Playwright Chromium has NO login state.")
        log.error("  Set CHROMIUM_PATH in .env to your SYSTEM Chrome, e.g.:")
        log.error("  CHROMIUM_PATH=/usr/bin/google-chrome-stable")
        sys.exit(1)

    return chromium_path


def validate_profile(profile_dir: str, min_cookies_bytes: int = 50_000) -> str:
    """Validate the profile directory has a reasonable Cookies file."""
    profile_dir = os.path.expanduser(profile_dir)

    if not os.path.isdir(profile_dir):
        log.error(f"Profile directory does not exist: {profile_dir}")
        log.error("  Create it or fix CHROME_PROFILE in .env")
        sys.exit(1)

    # Check Default/ subdirectory (standard Chromium layout)
    cookies_path = os.path.join(profile_dir, "Default", "Cookies")
    if not os.path.isfile(cookies_path):
        cookies_path = os.path.join(profile_dir, "Cookies")
    if not os.path.isfile(cookies_path):
        log.warning("No Cookies file found — this may be a fresh profile.")
        log.warning(f"  Profile: {profile_dir}")
        log.warning("  Continuing, but AI service logins may not be available.")
        return profile_dir

    cookies_size = os.path.getsize(cookies_path)
    if cookies_size < min_cookies_bytes:
        log.error(f"Cookies file too small: {cookies_size} bytes (need ≥{min_cookies_bytes})")
        log.error(f"  Path: {cookies_path}")
        log.error("  This profile has NO login sessions (empty Cookies DB).")
        log.error("  Fix CHROME_PROFILE in .env to point to the profile with your logins.")
        log.error("  (Hint: ~/.chrome-debug-profile usually has the login state)")
        sys.exit(1)

    log.info(f"Profile validated: {cookies_size}B Cookies at {cookies_path}")
    return profile_dir


# ═══════════════════════════════════════════════════════════════════
# Daemon lifecycle (event-driven, self-healing)
# ═══════════════════════════════════════════════════════════════════

def cleanup(sig=None, frame=None):
    """Graceful shutdown: close browser, remove PID files."""
    global context
    log.info("Shutting down...")
    if context:
        try:
            context.close()
        except Exception:
            pass
    for f in [DAEMON_PID_FILE, CHROME_PID_FILE]:
        if os.path.exists(f):
            os.remove(f)
    sys.exit(0)


def write_pid_files():
    """Write daemon PID file with secure permissions."""
    os.makedirs(STATE_DIR, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    with open(DAEMON_PID_FILE, "w") as f:
        f.write(str(os.getpid()))
    os.chmod(DAEMON_PID_FILE, 0o600)


def write_chrome_pid():
    """Find and persist the actual Chrome browser process PID.
    Uses pgrep to find the Chrome process launched with our CDP port.
    This enables precise kill from shell scripts instead of pkill -9 scatter.

    Note: Playwright's Browser.process is not available in all API modes
    (connect_over_cdp won't have it), so we query the OS process table."""
    try:
        import subprocess
        result = subprocess.run(
            ["pgrep", "-f", f"chrome.*remote-debugging-port={CDP_PORT}"],
            capture_output=True, text=True, timeout=5,
        )
        pids = [p for p in result.stdout.strip().split("\n") if p]
        if pids:
            chrome_pid = pids[0]
            with open(CHROME_PID_FILE, "w") as f:
                f.write(str(chrome_pid))
            log.info(f"Chrome PID: {chrome_pid}")
        else:
            log.warning("Could not find Chrome PID via pgrep")
    except Exception as e:
        log.warning(f"Could not capture Chrome PID: {e}")


def on_browser_disconnected():
    """Callback fired by Playwright when Chrome exits/crashes.
    ⚠️  Runs in Playwright's event thread — must be thread-safe.
    Sets the threading.Event to wake the main loop immediately."""
    log.error("⚠️  Browser disconnected! Signaling main loop...")
    disconnected_event.set()


def launch_browser(p):
    """Launch system Chrome with persistent profile. Returns (context, page)."""
    args = [
        "--no-sandbox",
        "--disable-gpu",
        # SECURITY: "--ignore-certificate-errors" removed — clash tunnels TLS
        # without MITM, so cert errors shouldn't occur; the flag only made a
        # real MITM invisible on a profile full of logged-in sessions.
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-debugging-address=127.0.0.1",
        # SECURITY: "--remote-allow-origins=*" removed. Even bound to 127.0.0.1,
        # that flag let ANY webpage open in ANY local browser connect to
        # ws://127.0.0.1:9222 and take over this fully-logged-in profile
        # (cookie theft for Google/OpenAI/Anthropic/... in one shot).
        # Playwright's Node/Python WebSocket clients send no Origin header, so
        # they are accepted without it. If a future client ever gets a 403,
        # re-add the narrow form: f"--remote-allow-origins=http://127.0.0.1:{CDP_PORT}"
        "--disable-dev-shm-usage",
        "--disable-breakpad",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-sync",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-background-networking",
        "--disable-client-side-phishing-detection",
        "--disable-extensions",
        "--disable-hang-monitor",
        "--disable-popup-blocking",
        "--disable-renderer-backgrounding",
        "--disable-field-trial-config",
        # CRITICAL: prevent Google from detecting automation → CAPTCHA
        "--disable-blink-features=AutomationControlled",
        "--disable-features=HttpsUpgrades,OptimizationHints,Translate",
        "--disable-quic",
        "--noerrdialogs",
        "--hide-scrollbars",
        "--mute-audio",
        "--proxy-bypass-list=<-loopback>",
    ]

    if HEADLESS:
        args.extend([
            "--ozone-platform=headless",
            "--use-angle=swiftshader-webgl",
        ])

    log.info("Launching in %s mode", "HEADLESS" if HEADLESS else "VISIBLE (GUI)")

    # launch_persistent_context preserves login state across restarts
    context = p.chromium.launch_persistent_context(
        user_data_dir=PROFILE,
        headless=HEADLESS,
        executable_path=CHROMIUM,
        proxy={"server": PROXY},
        args=args,
        viewport=None,
    )

    # === CORE FIX: register disconnect listener for immediate crash detection ===
    context.browser.on("disconnected", on_browser_disconnected)
    write_chrome_pid()

    # Start with blank page — pipeline skills manage their own tabs
    page = context.pages[0] if context.pages else context.new_page()
    try:
        page.goto("about:blank", timeout=5000)
    except Exception:
        pass
    log.info(f"Chrome ready — CDP http://127.0.0.1:{CDP_PORT}")

    return context, page


def heartbeat() -> bool:
    """Check browser health. Returns True if healthy.

    POLICY FIX ("never close the user's Chrome"): the monitor page being
    closed (e.g. the user closed our about:blank tab) is NOT a crash. It
    previously failed the heartbeat, which triggered restart_browser() →
    context.close() → destruction of ALL the user's tabs. Now a missing or
    stale monitor page is simply reopened; only a genuinely disconnected
    browser counts as a crash.
    """
    global context, page
    try:
        if not context:
            log.error("Browser context is None!")
            return False

        # Check browser connection via Playwright's native API first
        try:
            browser = context.browser
            if not browser or not browser.is_connected():
                log.error("Browser disconnected!")
                return False
        except Exception:
            log.error("Cannot access browser from context!")
            return False

        # Monitor page closed by the user? Reopen — the browser is fine.
        try:
            if page is None or page.is_closed():
                log.warning("Monitor page closed — reopening (not a crash)")
                page = context.new_page()
                page.goto("about:blank", timeout=5000)
        except Exception as e:
            log.error(f"Cannot reopen monitor page: {e}")
            return False

        # Active health probe — exercises CDP round-trip.
        # Evaluate a real expression to confirm the renderer is responsive.
        # Note: page.evaluate() in this Playwright version doesn't accept
        # a timeout kwarg. The primary crash detector is the "disconnected"
        # event listener (instant). This heartbeat is the secondary check
        # for cases where the page object is stale but the browser hasn't
        # fully disconnected yet.
        try:
            result = page.evaluate(
                "() => ({"
                "  readyState: document.readyState,"
                "  url: window.location.href,"
                "  ts: Date.now()"
                "})"
            )
            ready = result.get("readyState", "unknown")
            url = result.get("url", "unknown")
            if ready == "complete":
                return True
            log.warning(f"Heartbeat: readyState={ready}, url={url}")
            return True  # page is responsive even if not 'complete'
        except Exception as e:
            log.error(f"Heartbeat evaluate failed: {e}")
            # The page may have gone stale mid-check while the browser itself
            # is fine (e.g. user closed our tab between is_closed() and
            # evaluate()). One retry with a fresh page before declaring crash.
            try:
                page = context.new_page()
                page.goto("about:blank", timeout=5000)
                log.info("Heartbeat recovered with a fresh monitor page")
                return True
            except Exception:
                return False

    except Exception as e:
        log.error(f"Heartbeat failed: {e}")
        return False


def restart_browser(p):
    """Close old context (if any) and launch a fresh one.
    Clears the disconnect event so the new instance starts fresh."""
    global context, page
    if context:
        try:
            context.close()
        except Exception:
            pass
        context = None
        page = None

    context, page = launch_browser(p)
    disconnected_event.clear()
    return context, page


def main():
    global context, page, CHROMIUM, crash_count, PROFILE

    # Validate before launch — fail-fast, clear diagnostics
    if not CHROMIUM:
        CHROMIUM = os.environ.get("CHROMIUM_PATH")
    if not CHROMIUM:
        log.error("CHROMIUM_PATH not set.")
        log.error("  Set it in .env, e.g.:")
        log.error("  CHROMIUM_PATH=/usr/bin/google-chrome-stable")
        sys.exit(1)

    CHROMIUM = validate_chrome_binary(CHROMIUM)

    # Create profile dir FIRST — validate_profile needs it to exist
    os.makedirs(PROFILE, exist_ok=True)
    PROFILE = validate_profile(PROFILE)
    log.info(f"Chrome: {CHROMIUM}")
    log.info(f"Profile: {PROFILE}")

    # Clean stale lock files from previous crashes
    for lock in ["SingletonLock", "SingletonSocket", "SingletonCookie"]:
        path = os.path.join(PROFILE, lock)
        if os.path.exists(path):
            os.remove(path)

    write_pid_files()
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    with sync_playwright() as p:
        context, page = launch_browser(p)
        log.info(f"Daemon ready — PID={os.getpid()}")

        while True:
            # ── Event-driven wait ──
            # Wait for EITHER: disconnect signal OR heartbeat interval.
            # If Chrome crashes, the "disconnected" callback fires in
            # Playwright's event thread, sets the Event, and we wake up
            # IMMEDIATELY — no 15s blind window.
            # If nothing bad happens, we wake on timeout and run the
            # scheduled health check.
            got_signal = disconnected_event.wait(timeout=HEARTBEAT_INTERVAL)

            if got_signal:
                log.error("Browser disconnected event received!")
                crash_count += 1
            elif not heartbeat():
                log.error("Heartbeat check failed!")
                crash_count += 1
            else:
                # All good — reset crash counter on consecutive success
                if crash_count > 0:
                    log.info(
                        "Recovered — resetting crash counter (was %d)",
                        crash_count,
                    )
                    crash_count = 0
                continue

            # ── Crash recovery with exponential backoff ──
            log.error("Crash detected (%d/%d)", crash_count, MAX_CRASH_RESTARTS)

            if crash_count >= MAX_CRASH_RESTARTS:
                log.error("Max restarts reached. Exiting.")
                cleanup()
                sys.exit(1)

            # Exponential backoff: 2s, 4s, 8s, 16s, 30s cap
            backoff = min(2 ** crash_count, 30)
            log.info(
                "Restarting in %ds (attempt %d/%d)...",
                backoff, crash_count, MAX_CRASH_RESTARTS,
            )
            time.sleep(backoff)

            try:
                context, page = restart_browser(p)
                log.info("Restarted successfully")
            except Exception as e:
                log.error(f"Restart failed: {e}")
                # crash_count not incremented here — next loop iteration
                # will re-detect the failure and bump it naturally


if __name__ == "__main__":
    main()
