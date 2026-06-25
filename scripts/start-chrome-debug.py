#!/usr/bin/env python3
"""
Chrome CDP Daemon — uses Playwright to launch Chromium, navigate to Gemini,
and keep the browser alive with CDP port for external interaction.

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

import os, sys, time, signal


def auto_detect_chromium():
    """Auto-detect Playwright's Chromium or use CHROMIUM_PATH env var."""
    custom = os.environ.get("CHROMIUM_PATH", "")
    if custom and os.path.isfile(custom):
        return custom

    # Common Playwright install locations
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

    # System Chrome
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
PROFILE = os.path.expanduser(
    os.environ.get("CHROME_PROFILE", "~/.chrome-debug-profile")
)
PID_FILE = os.environ.get("PID_FILE", "/tmp/chrome-debug.pid")

CHROMIUM = os.environ.get("CHROMIUM_PATH")  # will be set below

# We import playwright only after config to allow --help without install
from playwright.sync_api import sync_playwright

browser = None


def cleanup(sig=None, frame=None):
    global browser
    if browser:
        try:
            browser.close()
        except:
            pass
    if os.path.exists(PID_FILE):
        os.remove(PID_FILE)
    sys.exit(0)


def main():
    global browser, CHROMIUM

    # Auto-detect Chromium if not set
    if not CHROMIUM:
        CHROMIUM = auto_detect_chromium()
    if not CHROMIUM:
        print("❌ Cannot find Chromium. Install with: python3 -m playwright install chromium", flush=True)
        sys.exit(1)

    os.makedirs(PROFILE, exist_ok=True)
    for lock in ["SingletonLock", "SingletonSocket", "SingletonCookie"]:
        path = os.path.join(PROFILE, lock)
        if os.path.exists(path):
            os.remove(path)

    with open(PID_FILE, "w") as f:
        f.write(str(os.getpid()))

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)

    with sync_playwright() as p:
        browser = p.chromium.launch(
            headless=True,
            executable_path=CHROMIUM,
            proxy={"server": PROXY},
            args=[
                "--no-sandbox",
                "--disable-gpu",
                "--ignore-certificate-errors",
                f"--remote-debugging-port={CDP_PORT}",
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
                "--disable-features=HttpsUpgrades,OptimizationHints,Translate",
                "--noerrdialogs",
                "--no-startup-window",
                "--hide-scrollbars",
                "--mute-audio",
                "--ozone-platform=headless",
                "--use-angle=swiftshader-webgl",
            ],
        )

        page = browser.new_page()
        try:
            resp = page.goto(GEMINI_URL, timeout=30000, wait_until="domcontentloaded")
            print(f"✅ Gemini: status={resp.status} url={page.url} title={page.title()}", flush=True)
        except Exception as e:
            print(f"⚠️  Gemini navigation: {e}", flush=True)

        print(f"🔗 CDP: http://127.0.0.1:{CDP_PORT}", flush=True)

        while True:
            time.sleep(60)


if __name__ == "__main__":
    main()
