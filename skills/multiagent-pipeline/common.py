#!/usr/bin/env python3
"""
Shared utilities for the MultiAgent pipeline.

Provides:
  - cdp_url() — CDP endpoint URL with optional token auth (P0 security)
  - AbortableBarrier — race-condition-free asyncio barrier with timeout + abort
  - setup_logging() — uniform logging configuration across all modules

All three were previously duplicated across orchestrator.py, adapters.py, and
main.py. Single source of truth avoids divergence and fixes the Barrier race
where abort() was setting flags outside the Condition lock.
"""

import asyncio, logging, os, sys

# ── Timing constants (previously magic numbers in adapters.py) ─────────────

PAGE_GOTO_TIMEOUT_MS  = 45_000   # page.goto() max wait
PAGE_LOAD_WAIT_MS     =  3_000   # post-navigation settle time
SPA_WAKE_WAIT_MS      =  2_000   # after click-to-wake SPA
EDITOR_READY_TIMEOUT_MS = 15_000  # editor visible wait
INSERT_TEXT_LIMIT     = 50_000   # threshold: keyboard.insert_text vs clipboard
RESPONSE_STABILITY_S  =     15   # seconds of no-growth before declaring done
STABILITY_POLL_MS     =  2_000   # interval between stability checks

# ── CDP Security (P0 fixes 2026-06-28) ─────────────────────────────────────

# ⚠️  CDP token is passed as a URL query parameter (?token=).
# This is the only mechanism Chrome supports for --remote-debugging-token
# auth when using Playwright's connect_over_cdp().  Mitigations:
#   1. Chrome MUST bind to 127.0.0.1 ONLY (never 0.0.0.0)
#   2. Token file (~/.chrome-debug-profile/.cdp_token) permissions: 0600
#   3. Never pass the token as a CLI argument (use env var CHROME_CDP_TOKEN)
#   4. CDP port 9222 must be firewalled from external interfaces
#   5. Token is auto-generated per Chrome daemon session (not static)


def cdp_url(port: str = "9222") -> str:
    """Build CDP endpoint URL.

    If CHROME_CDP_TOKEN is set in the environment, appends ?token= so that
    Chrome's --remote-debugging-token bearer-auth accepts the connection.
    Otherwise returns the bare http://127.0.0.1:<port> URL.

    Always binds to 127.0.0.1 (localhost) — never exposes CDP to the network.
    """
    token = os.environ.get("CHROME_CDP_TOKEN", "")
    base = f"http://127.0.0.1:{port}"
    return f"{base}?token={token}" if token else base


def verify_cdp_localhost(port: str = "9222") -> tuple[bool, str]:
    """Deprecated — use verify_cdp_safe() instead.

    This function does a TCP connectivity check only; it does NOT validate
    the resolved IP address is actually a loopback address, leaving a DNS
    rebinding attack vector (e.g. localhost.evil.com → 1.2.3.4).
    """
    return verify_cdp_safe(port)


def verify_cdp_safe(port: str = "9222") -> tuple[bool, str]:
    """P1 security: strict loopback validation with DNS rebinding protection.

    Performs two checks:
      1. Resolves 'localhost' and verifies the IP is in 127.0.0.0/8 (IPv4)
         or is ::1 (IPv6).  A naive string-match on 'localhost' is vulnerable
         to DNS rebinding (localhost.evil.com → attacker IP).
      2. TCP connectivity — confirms Chrome CDP is actually listening.

    Returns (ok, message).  Failure is a CRITICAL security risk.
    Call this in pre-flight checks before any CDP operations.
    """
    import socket, ipaddress

    # ── Step 1: DNS rebinding check — resolve + validate IP ──
    try:
        resolved = socket.getaddrinfo("localhost", None, socket.AF_UNSPEC,
                                      socket.SOCK_STREAM)
    except socket.gaierror as e:
        return False, f"DNS resolution for 'localhost' failed: {e}"

    loopback_ips = set()
    for family, _, _, _, sockaddr in resolved:
        ip = sockaddr[0]
        if family == socket.AF_INET:
            # 127.0.0.0/8
            if ipaddress.IPv4Address(ip) in ipaddress.IPv4Network("127.0.0.0/8"):
                loopback_ips.add(ip)
        elif family == socket.AF_INET6:
            if ip == "::1":
                loopback_ips.add(ip)

    if not loopback_ips:
        return False, (
            "DNS rebinding risk: 'localhost' resolved to non-loopback IP(s). "
            "Check /etc/hosts — 'localhost' must map to 127.0.0.1 or ::1 only."
        )
    if any(ip for ip in loopback_ips if ip != "127.0.0.1" and ip != "::1"):
        return False, (
            f"DNS: localhost resolved to unusual loopback IPs {loopback_ips}. "
            "Expected 127.0.0.1 or ::1. Check /etc/hosts."
        )

    # ── Step 2: TCP connectivity check ──
    try:
        s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        s.settimeout(2)
        s.connect(("127.0.0.1", int(port)))
        # Now verify it's NOT listening on external interfaces
        try:
            hostname = socket.gethostname()
            external_ip = socket.gethostbyname(hostname)
            if external_ip not in ("127.0.0.1", "127.0.1.1", "127.0.0.2"):
                s2 = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                s2.settimeout(1)
                try:
                    s2.connect((external_ip, int(port)))
                    s2.close()
                    s.close()
                    return False, (
                        f"CDP accessible on external IP {external_ip}:{port}! "
                        "Chrome must bind to 127.0.0.1 only. "
                        "Fix: --remote-debugging-address=127.0.0.1"
                    )
                except (socket.timeout, ConnectionRefusedError, OSError):
                    pass  # External connection failed — good
                finally:
                    try: s2.close()
                    except: pass
        except Exception:
            pass  # Can't determine external IP — skip external check
        s.close()
        return True, f"CDP safe — localhost only (resolved: {loopback_ips})"
    except (socket.timeout, ConnectionRefusedError, OSError) as e:
        return False, f"CDP TCP check failed (Chrome not running?): {e}"


# ── Logging ────────────────────────────────────────────────────────────────

def setup_logging(name: str, level: int = logging.INFO) -> logging.Logger:
    """Configure a uniform logger for pipeline modules.

    Writes timestamped [tag] messages to stderr so they stay separate from
    JSON/text output on stdout.  Call once per module at import time.
    """
    logging.basicConfig(
        level=level,
        format="%(asctime)s [%(name)s] %(message)s",
        datefmt="%H:%M:%S",
        stream=sys.stderr,
    )
    return logging.getLogger(name)


# ── Abortable Barrier (asyncio.Condition, race-free) ───────────────────────

class AbortableBarrier:
    """N-party asyncio barrier with per-waiter timeout and safe abort.

    **Race-condition fix (2026-06-28):**  ``abort()`` is now ``async`` and
    acquires ``self._cond`` before mutating ``_aborted`` / ``_released`` and
    calling ``notify_all()``.  The previous version set flags without the lock,
    which meant a waiter spinning inside ``wait_for()`` could miss the wake-up
    and block forever.

    Usage::

        barrier = AbortableBarrier(4, timeout=60)
        # in each worker:
        ok = await barrier.wait()         # True = normal, False = timeout/abort
        # on fatal error in any worker:
        await barrier.abort()             # releases ALL waiters immediately
    """

    def __init__(self, n: int, timeout: float = 60.0):
        if n < 1:
            raise ValueError(f"Barrier requires n >= 1, got {n}")
        self.n = n
        self.timeout = timeout
        self._count = 0
        self._aborted = False
        self._released = False
        self._cond = asyncio.Condition()

    async def wait(self) -> bool:
        """Wait until all N parties arrive, or until timeout/abort.

        Returns:
            True  — normal release (all parties arrived)
            False — timeout expired or ``abort()`` was called
        """
        async with self._cond:
            self._count += 1
            if self._count >= self.n:
                self._released = True
                self._cond.notify_all()

            try:
                await asyncio.wait_for(
                    self._cond.wait_for(lambda: self._released or self._aborted),
                    timeout=self.timeout,
                )
                return not self._aborted
            except asyncio.TimeoutError:
                # Timeout: auto-abort so other waiters don't hang
                if not self._released and not self._aborted:
                    self._aborted = True
                    self._cond.notify_all()
                return False

    async def abort(self) -> None:
        """Force-release ALL waiters immediately.  Safe to call from any context.

        **Must be awaited** — this acquires the Condition lock before mutating
        state, closing the race window that existed in the pre-2026-06-28 code.
        """
        async with self._cond:
            self._aborted = True
            self._released = True
            self._cond.notify_all()
