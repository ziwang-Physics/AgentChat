#!/usr/bin/env python3
"""
Chrome CDP Daemon — uses Playwright to launch Chromium, navigate to Gemini,
and keep the browser alive with CDP port 9222 for external interaction.

Managed by start-chrome-debug.sh
"""

import os, sys, time, signal, json

CHROMIUM = "/home/user/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome"
PROXY = "http://127.0.0.1:7897"
DEBUG_PORT = 9222
GEMINI_URL = "https://gemini.google.com/u/0/app"
PID_FILE = "/tmp/chrome-debug.pid"

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
    global browser

    # Write PID
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
                f"--remote-debugging-port={DEBUG_PORT}",
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
            print(f"⚠️  Gemini nav: {e}", flush=True)

        print(f"🔗 CDP: http://127.0.0.1:{DEBUG_PORT}", flush=True)

        # Keep alive until killed
        while True:
            time.sleep(60)


if __name__ == "__main__":
    main()
