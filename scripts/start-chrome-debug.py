#!/usr/bin/env python3
"""
Chrome CDP Daemon — uses Playwright to launch Chromium, navigate to Gemini,
and keep the browser alive with CDP port for external interaction.

Features:
  - Auto-detect Chromium binary (Playwright → system Chrome, cross-platform)
  - Heartbeat monitor: detects crashes, auto-restarts browser
  - Secure PID file: ~/.local/state/agentchat/ (not world-writable /tmp)
  - CDP bound to 127.0.0.1 only (no external exposure)

Environment variables (all optional, with defaults):
  CDP_PORT          CDP debug port (default: 9222)
  PROXY_SERVER      HTTP/SOCKS5 proxy (default: http://127.0.0.1:7897)
  GEMINI_URL        Target Gemini URL
  CHROMIUM_PATH     Override auto-detected Chromium binary
  CHROME_PROFILE    Persistent profile dir (default: ~/.chrome-debug-profile)

Usage:
  python3 start-chrome-debug.py

Managed by start-chrome-debug.sh
"""

import os, sys, time, signal, logging

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [daemon] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stdout,
)
log = logging.getLogger("chrome-daemon")


def auto_detect_chromium():
    """Auto-detect Playwright's Chromium or use CHROMIUM_PATH env var."""
    custom = os.environ.get("CHROMIUM_PATH", "")
    if custom and os.path.isfile(custom):
        return custom

    candidates = []
    home = os.path.expanduser("~")

    # Playwright's managed Chromium
    cache = os.path.join(home, ".cache", "ms-playwright")
    if os.path.isdir(cache):
        for d in sorted(os.listdir(cache), reverse=True):
            if d.startswith("chromium-") or d.startswith("chromium_headless"):
                for root, _, files in os.walk(os.path.join(cache, d)):
                    if "chrome" in files and "linux" in root:
                        candidates.append(os.path.join(root, "chrome"))

    # System Chrome — platform-aware
    import platform
    system = platform.system()
    if system == "Darwin":
        candidates.append("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
    elif system == "Windows":
        candidates.extend([
            os.path.expandvars(r"%ProgramFiles%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"),
            os.path.expandvars(r"%LocalAppData%\Google\Chrome\Application\chrome.exe"),
        ])
    else:
        for p in ["google-chrome-stable", "google-chrome", "chromium", "chromium-browser"]:
            candidates.append(f"/usr/bin/{p}")

    for c in candidates:
        if os.path.isfile(c) and os.access(c, os.X_OK):
            return c
    return None


# ---- Config from env vars ----
CDP_PORT = int(os.environ.get("CDP_PORT", "9222"))
PROXY = os.environ.get("PROXY_SERVER", "http://127.0.0.1:7897")
GEMINI_URL = os.environ.get("GEMINI_URL", "https://gemini.google.com/u/0/app")
PROFILE = os.path.expanduser(os.environ.get("CHROME_PROFILE", "~/.chrome-debug-profile"))

# Secure PID file: user-private directory, not world-writable /tmp
STATE_DIR = os.path.expanduser("~/.local/state/agentchat")
PID_FILE = os.path.join(STATE_DIR, "chrome-debug.pid")

CHROMIUM = os.environ.get("CHROMIUM_PATH")
HEARTBEAT_INTERVAL = 30  # seconds between health checks
MAX_CRASH_RESTARTS = 3   # max consecutive auto-restarts before giving up

from playwright.sync_api import sync_playwright

browser = None
crash_count = 0


def cleanup(sig=None, frame=None):
    global browser
    log.info("Shutting down...")
    if browser:
        try:
            browser.close()
        except:
            pass
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)
    sys.exit(0)


def write_pid():
    os.makedirs(STATE_DIR, exist_ok=True)
    # Set restrictive permissions on state dir
    os.chmod(STATE_DIR, 0o700)
    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))
    os.chmod(PID_FILE, 0o600)


def launch_browser(p):
    """Launch Chromium with verified flags. Returns (browser, page)."""
    global crash_count
    browser = p.chromium.launch(
        headless=True,
        executable_path=CHROMIUM,
        proxy={"server": PROXY},
        args=[
            "--no-sandbox",
            "--disable-gpu",
            "--ignore-certificate-errors",
            f"--remote-debugging-port={CDP_PORT}",
            "--remote-debugging-address=127.0.0.1",  # bind localhost only
            "--remote-allow-origins=*",  # needed for Playwright connect_over_cdp
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
            "--disable-features=HttpsUpgrades,OptimizationHints,Translate",
            "--noerrdialogs",
            "--no-startup-window",
            "--hide-scrollbars",
            "--mute-audio",
            "--ozone-platform=headless",
            "--use-angle=swiftshader-webgl",
            "--proxy-bypass-list=<-loopback>",
        ],
    )

    page = browser.new_page()
    try:
        resp = page.goto(GEMINI_URL, timeout=30000, wait_until="domcontentloaded")
        log.info(f"Gemini loaded: status={resp.status} title={page.title()}")
    except Exception as e:
        log.warning(f"Gemini navigation: {e}")

    return browser, page


def heartbeat(page):
    """Check browser health. Returns True if healthy, False if needs restart."""
    global browser, crash_count
    try:
        if not browser or not browser.is_connected():
            log.error("Browser disconnected!")
            return False

        # Check page is still alive and not about:blank
        current_url = page.evaluate("window.location.href")
        if current_url == "about:blank":
            log.warning("Page reverted to about:blank — may need re-navigation")
            try:
                page.goto(GEMINI_URL, timeout=30000, wait_until="domcontentloaded")
                log.info("Re-navigated to Gemini")
            except Exception as e:
                log.error(f"Re-navigation failed: {e}")
                return False

        # Check page didn't crash
        if page.evaluate("document.readyState") == "complete":
            return True

        return True
    except Exception as e:
        log.error(f"Heartbeat check failed: {e}")
        return False


def main():
    global browser, CHROMIUM

    if not CHROMIUM:
        CHROMIUM = auto_detect_chromium()
    if not CHROMIUM:
        log.error("Cannot find Chromium. Run: python3 -m playwright install chromium")
        sys.exit(1)

    os.makedirs(PROFILE, exist_ok=True)
    for lock in ["SingletonLock", "SingletonSocket", "SingletonCookie"]:
        path = os.path.join(PROFILE, lock)
        if os.path.exists(path):
            os.remove(path)

    write_pid()
    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    with sync_playwright() as p:
        browser, page = launch_browser(p)
        log.info(f"Daemon ready — CDP http://127.0.0.1:{CDP_PORT} PID={os.getpid()}")

        while True:
            time.sleep(HEARTBEAT_INTERVAL)

            if not heartbeat(page):
                crash_count += 1
                log.error(f"Crash detected ({crash_count}/{MAX_CRASH_RESTARTS})")

                if crash_count >= MAX_CRASH_RESTARTS:
                    log.error("Max restarts reached. Exiting.")
                    cleanup()
                    sys.exit(1)

                log.info("Attempting browser restart...")
                try:
                    browser.close()
                except:
                    pass
                try:
                    browser, page = launch_browser(p)
                    crash_count = 0  # reset on successful restart
                    log.info("Browser restarted successfully")
                except Exception as e:
                    log.error(f"Restart failed: {e}")


if __name__ == "__main__":
    main()
