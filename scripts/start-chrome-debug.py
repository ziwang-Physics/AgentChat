#!/usr/bin/env python3
"""
Chrome CDP Daemon — uses Playwright to launch system Chrome with persistent profile,
and keep the browser alive with CDP port for external interaction.

Features:
  - Persistent profile: login sessions survive daemon restarts
  - Profile & binary validation: fail-fast on misconfiguration
  - Auto-restart on crash (max 3 consecutive, then exit)
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

import os, sys, time, signal, logging

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

HEARTBEAT_INTERVAL = 30   # seconds between health checks
MAX_CRASH_RESTARTS = 3    # max consecutive auto-restarts before giving up

# Secure PID file: user-private directory
STATE_DIR = os.path.expanduser("~/.local/state/agentchat")
PID_FILE = os.path.join(STATE_DIR, "chrome-debug.pid")

from playwright.sync_api import sync_playwright

context = None
crash_count = 0


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
# Daemon lifecycle
# ═══════════════════════════════════════════════════════════════════

def cleanup(sig=None, frame=None):
    global context
    log.info("Shutting down...")
    if context:
        try:
            context.close()
        except Exception:
            pass
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)
    sys.exit(0)


def write_pid():
    os.makedirs(STATE_DIR, exist_ok=True)
    os.chmod(STATE_DIR, 0o700)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))
    os.chmod(PID_FILE, 0o600)


def launch_browser(p):
    """Launch system Chrome with persistent profile. Returns (context, page)."""
    global crash_count

    args = [
        "--no-sandbox",
        "--disable-gpu",
        "--ignore-certificate-errors",
        f"--remote-debugging-port={CDP_PORT}",
        "--remote-debugging-address=127.0.0.1",
        "--remote-allow-origins=*",
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

    # Start with blank page — pipeline skills manage their own tabs
    page = context.pages[0] if context.pages else context.new_page()
    try:
        page.goto("about:blank", timeout=5000)
    except Exception:
        pass
    log.info(f"Chrome ready — CDP http://127.0.0.1:{CDP_PORT}")

    return context, page


def heartbeat(page):
    """Check browser health. Returns True if healthy."""
    global context, crash_count
    try:
        if not context:
            log.error("Browser context is None!")
            return False

        try:
            if not context.browser or not context.browser.is_connected():
                log.error("Browser disconnected!")
                return False
        except Exception:
            log.error("Cannot access browser from context!")
            return False

        current_url = page.evaluate("window.location.href")
        if current_url == "about:blank":
            log.warning("Page reverted to about:blank — keeping alive")
        if page.evaluate("document.readyState") == "complete":
            return True

        return True
    except Exception as e:
        log.error(f"Heartbeat failed: {e}")
        return False


def main():
    global context, CHROMIUM, crash_count, PROFILE

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

    write_pid()
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    with sync_playwright() as p:
        context, page = launch_browser(p)
        log.info(f"Daemon ready — PID={os.getpid()}")

        while True:
            time.sleep(HEARTBEAT_INTERVAL)

            if not heartbeat(page):
                crash_count += 1
                log.error(f"Crash detected ({crash_count}/{MAX_CRASH_RESTARTS})")

                if crash_count >= MAX_CRASH_RESTARTS:
                    log.error("Max restarts reached. Exiting.")
                    cleanup()
                    sys.exit(1)

                log.info("Attempting restart...")
                try:
                    context.close()
                except Exception:
                    pass
                try:
                    context, page = launch_browser(p)
                    crash_count = 0
                    log.info("Restarted successfully")
                except Exception as e:
                    log.error(f"Restart failed: {e}")


if __name__ == "__main__":
    main()
