#!/usr/bin/env python3
"""
Base adapter — generic browser-automation primitives shared by all platforms.

Subclasses MUST override: name, EDITOR_SELECTOR, SEND_SELECTOR, STOP_SELECTOR,
TOOLBAR_SELECTOR, RESPONSE_STRATEGIES, URL.
"""

import asyncio, logging, time
from contextlib import asynccontextmanager, suppress

from common import (
    cdp_url, PAGE_GOTO_TIMEOUT_MS, PAGE_LOAD_WAIT_MS, SPA_WAKE_WAIT_MS,
    EDITOR_READY_TIMEOUT_MS, INSERT_TEXT_LIMIT, RESPONSE_STABILITY_S,
    STABILITY_POLL_MS,
)

log = logging.getLogger("adapters.base")


# ── P1: Safe Page lifecycle (RAII, prevents CDP leaks) ───────────────────

@asynccontextmanager
async def safe_page(context):
    """Async context manager for RAII Page lifecycle.

    Guarantees page.close() even if the body raises.  Uses suppress() in the
    finally block so that a Target-already-closed error during cleanup does
    not mask the original exception.

    Usage:
        async with safe_page(context) as page:
            await page.goto(url)
            result = await extract(page)
    """
    page = await context.new_page()
    try:
        yield page
    finally:
        with suppress(Exception):
            await page.close()


class BaseAdapter:
    """Abstract interface for a web AI chat platform.

    Subclass must define platform-specific selectors and a response-extraction
    strategy list.  The base class provides the full pipeline:
    connect → ensure_fresh → ensure_ready → clear_input → inject_prompt →
    trigger_send → wait_response → extract_response → clean_response →
    validate_response.
    """

    name: str = "base"
    cdp_port: str = "9222"

    # ── Subclass MUST override ──
    EDITOR_SELECTOR: str = ""
    SEND_SELECTOR: str = ""
    STOP_SELECTOR: str = ""
    TOOLBAR_SELECTOR: str = ""
    RESPONSE_SELECTOR: str = ""
    URL: str = ""

    # Response extraction strategies — ordered; first substantial match wins.
    RESPONSE_STRATEGIES: list[str] = []

    # Platform-specific error / rate-limit patterns appended by subclasses.
    ERROR_PATTERNS: list[str] = []

    # CSS selector for "still thinking/loading" indicator (spinner, dots, etc.).
    # Used by stability fallback to avoid extracting mid-generation.
    THINKING_SELECTOR: str = ""

    def __init__(self, cdp_port: str = "9222"):
        self.cdp_port = cdp_port

    # ── Connect ────────────────────────────────────────────────────────────

    async def connect(self, pw=None, context=None):
        """Connect to the platform in one of two modes:

        1. SHARED CONTEXT (recommended): pass ``context=`` (a BrowserContext).
           Creates a new TAB in the existing Chrome window. Cleanup closes tab.

        2. INDEPENDENT CONTEXT (legacy): pass ``pw=`` (Playwright instance).
           Creates a new BrowserContext (= new window). Cleanup destroys it.
        """
        if context is not None:
            self._owns_context = False
            self._context = context
            page = await context.new_page()
            await page.goto(self.URL, wait_until="domcontentloaded",
                            timeout=PAGE_GOTO_TIMEOUT_MS)
            await page.wait_for_timeout(PAGE_LOAD_WAIT_MS)
            try:
                await page.mouse.click(400, 400)
            except Exception:
                pass
            await page.wait_for_timeout(SPA_WAKE_WAIT_MS)
            self._page = page
            log.info("[%s] Connected (shared tab) — %s", self.name, await page.title())
            return page

        if pw is None:
            raise ValueError("connect() requires either pw= or context=")

        self._owns_context = True
        browser = await pw.chromium.connect_over_cdp(cdp_url(self.cdp_port))
        self._browser = browser
        self._context = await browser.new_context(
            viewport={"width": 1280, "height": 800}
        )
        await self._context.grant_permissions(["clipboard-read", "clipboard-write"])

        page = await self._context.new_page()
        await page.goto(self.URL, wait_until="domcontentloaded",
                        timeout=PAGE_GOTO_TIMEOUT_MS)
        await page.wait_for_timeout(PAGE_LOAD_WAIT_MS)
        try:
            await page.mouse.click(400, 400)
        except Exception:
            pass
        await page.wait_for_timeout(SPA_WAKE_WAIT_MS)

        self._page = page
        log.info("[%s] Connected (isolated context) — %s", self.name, await page.title())
        return page

    async def cleanup(self) -> None:
        """Close tab (shared mode) or destroy context (legacy mode)."""
        if hasattr(self, '_owns_context') and not self._owns_context:
            if hasattr(self, '_page') and self._page:
                try:
                    await self._page.close()
                    log.info("[%s] Tab closed", self.name)
                except Exception as e:
                    log.warning("[%s] Tab close error: %s", self.name, e)
            return

        if hasattr(self, '_context') and self._context:
            try:
                await self._context.close()
                log.info("[%s] Context destroyed", self.name)
            except Exception as e:
                log.warning("[%s] Context close error: %s", self.name, e)

    # ── Page readiness ─────────────────────────────────────────────────────

    async def ensure_ready(self, page) -> None:
        """Wait for input editor to be visible and focused."""
        try:
            editor = page.locator(self.EDITOR_SELECTOR).first
            await editor.wait_for(state="visible", timeout=EDITOR_READY_TIMEOUT_MS)
            await editor.focus()
            await editor.click()
            log.info("[%s] Editor ready", self.name)
        except Exception as e:
            log.warning("[%s] Editor wait failed: %s — retrying via reload", self.name, e)
            await page.goto(page.url, wait_until="domcontentloaded",
                            timeout=PAGE_GOTO_TIMEOUT_MS)
            await page.wait_for_timeout(5000)
            editor = page.locator(self.EDITOR_SELECTOR).first
            await editor.wait_for(state="visible", timeout=EDITOR_READY_TIMEOUT_MS)
            await editor.focus()
            await editor.click()

    async def ensure_fresh_conversation(self, page) -> None:
        """Start a new conversation. Override in platform adapters.

        Default: navigate to base URL (strips conversation-specific path)."""
        log.info("[%s] Starting fresh conversation via URL navigation", self.name)
        await page.goto(self.URL, wait_until="domcontentloaded",
                        timeout=PAGE_GOTO_TIMEOUT_MS)
        await page.wait_for_timeout(PAGE_LOAD_WAIT_MS)
        try:
            await page.mouse.click(400, 400)
        except Exception:
            pass
        await page.wait_for_timeout(SPA_WAKE_WAIT_MS)

    async def ensure_thinking_mode(self, page) -> bool:
        """Enable the platform's deep-thinking / reasoning mode.

        Default: no-op (most platforms don't have a toggle).
        Override in platform adapters that have a thinking toggle
        (Qianwen: 思考 button, Gemini: Pro Extended via ensure_pro_extended).

        Returns True on success, False on failure (non-fatal).
        """
        return True

    # ── Input pipeline ─────────────────────────────────────────────────────

    async def clear_input(self, page) -> None:
        """Clear editor via keyboard (triggers framework change detection)."""
        try:
            editor = page.locator(self.EDITOR_SELECTOR).first
            await editor.fill("")
        except Exception:
            await page.locator(self.EDITOR_SELECTOR).first.focus()
            await page.keyboard.press("ControlOrMeta+a")
            await page.keyboard.press("Backspace")
        await page.wait_for_timeout(100)

    async def inject_prompt(self, page, text: str) -> None:
        """Type text via keyboard (triggers framework events naturally).

        For prompts > INSERT_TEXT_LIMIT chars, falls back to clipboard paste
        because Playwright's keyboard.insert_text() has a platform-dependent
        buffer limit.
        """
        if len(text) > INSERT_TEXT_LIMIT:
            log.info("[%s] Large prompt (%d chars), using clipboard paste",
                     self.name, len(text))
            try:
                await page.evaluate("(t) => navigator.clipboard.writeText(t)", text)
            except Exception:
                log.warning("[%s] Clipboard write failed", self.name)
            await page.keyboard.press("ControlOrMeta+v")
            await page.wait_for_timeout(500)
        else:
            await page.keyboard.insert_text(text)

        await page.wait_for_timeout(300)

        # Integrity check — skip for very short prompts (<50 chars) where a
        # single-char delta would trip the threshold.  Use 10% tolerance
        # because editors normalize whitespace/unicode differently, and
        # Chinese text can lose 5-8% from line-break normalization alone.
        if len(text) >= 50:
            editor = page.locator(self.EDITOR_SELECTOR).first
            injected = await editor.evaluate(
                "el => (el.textContent || el.innerText || '').trim().length"
            )
            delta_pct = abs(injected - len(text)) / max(len(text), 1)
            if delta_pct > 0.10:
                log.warning("[%s] Payload mismatch: expected ~%d, got %d (%.1f%%)",
                            self.name, len(text), injected, delta_pct * 100)
                # P1: warn but proceed — partial injection > complete failure.
                # The editor may have normalized whitespace; the LLM usually
                # still receives the full semantic content.
                if delta_pct > 0.30:
                    raise RuntimeError(
                        f"Input payload severely truncated ({injected} vs {len(text)})"
                    )

        # Belt-and-suspenders: type char + delete to wake framework
        try:
            await page.keyboard.type(",")
            await page.keyboard.press("Backspace")
            await page.wait_for_timeout(200)
        except Exception:
            pass

        log.info("[%s] Prompt injected (%d chars)", self.name, len(text))

    async def trigger_send(self, page) -> None:
        """Click send button or press Enter."""
        try:
            send_btn = page.locator(self.SEND_SELECTOR).first
            await send_btn.wait_for(state="visible", timeout=5000)
            if await send_btn.is_enabled():
                await send_btn.click()
                log.info("[%s] Sent via button click", self.name)
                return
        except Exception:
            pass
        await page.keyboard.press("Enter")
        log.info("[%s] Sent via Enter", self.name)

    # ── Response pipeline ──────────────────────────────────────────────────

    async def wait_response(self, page, timeout_ms: int = 300_000) -> str:
        """Wait for generation complete, then extract response."""
        start = time.time()

        # Phase 1: stop button appear → disappear = generation window
        try:
            stop_btn = page.locator(self.STOP_SELECTOR).first
            await stop_btn.wait_for(state="visible", timeout=30_000)
            log.info("[%s] Generation started", self.name)
            remaining = max(10_000, timeout_ms - int((time.time() - start) * 1000))
            await stop_btn.wait_for(state="hidden", timeout=remaining)
            log.info("[%s] Generation finished", self.name)
        except Exception:
            log.info("[%s] No prolonged generation phase", self.name)

        # Phase 2: toolbar = completion anchor
        try:
            toolbar = page.locator(self.TOOLBAR_SELECTOR).first
            remaining = max(10_000, timeout_ms - int((time.time() - start) * 1000))
            await toolbar.wait_for(state="visible", timeout=remaining)
            log.info("[%s] Response toolbar detected", self.name)
        except Exception:
            log.info("[%s] Toolbar not detected, stability fallback", self.name)
            last_len = 0
            last_change = time.time()
            while (time.time() - last_change) < RESPONSE_STABILITY_S:
                if (time.time() - start) * 1000 > timeout_ms:
                    break
                try:
                    await page.wait_for_timeout(STABILITY_POLL_MS)

                    # ── Fix 2026-06-28: check thinking indicator before extracting ──
                    # If the platform still shows a "thinking/loading/spinner" element,
                    # reset the stability timer — the real answer hasn't started yet.
                    # This prevents extracting search queries or intermediate thinking
                    # text as the final response (Kimi/Qianwen session bleed).
                    if self.THINKING_SELECTOR:
                        try:
                            thinking_el = page.locator(self.THINKING_SELECTOR).first
                            if await thinking_el.is_visible():
                                last_change = time.time()
                                continue
                        except Exception:
                            pass  # selector not present → proceed normally

                    current = await self.extract_response(page)
                    if len(current) > last_len:
                        last_len = len(current)
                        last_change = time.time()
                except Exception as e:
                    log.warning("[%s] Stability poll interrupted: %s", self.name, e)
                    break

        try:
            return await self.extract_response(page)
        except Exception as e:
            log.warning("[%s] Final extract failed: %s", self.name, e)
            return ""

    async def extract_response(self, page) -> str:
        """Multi-strategy DOM extraction. NEVER touches OS clipboard.

        Tries each selector in RESPONSE_STRATEGIES. Returns the first match
        with substantial content (>20 chars). If all strategies fail, scans
        the page for the largest text block as an ultimate fallback.
        """
        strategies = self.RESPONSE_STRATEGIES
        if not strategies:
            log.warning("[%s] No RESPONSE_STRATEGIES defined!", self.name)
            return ""

        for i, sel in enumerate(strategies):
            try:
                # P0 security: selector passed as parameter, not interpolated
                # P1: textContent preferred over innerText — no forced reflow,
                # penetrates Shadow DOM, higher performance. innerText is
                # layout-aware (triggers style recalculation on every read).
                text = await page.evaluate("""(sel) => {
                    const els = document.querySelectorAll(sel);
                    if (els.length === 0) return '';
                    const el = els[els.length - 1];
                    return (el.textContent || el.innerText || '').trim();
                }""", sel)
                if text and len(text) > 20:
                    log.info("[%s] Strategy #%d '%s' → %d chars",
                             self.name, i + 1, sel[:50], len(text))
                    return text
            except Exception as e:
                log.debug("[%s] Strategy #%d failed: %s", self.name, i + 1, e)
                continue

        # Ultimate fallback: find largest text block in page
        try:
            text = await page.evaluate("""() => {
                const nodes = document.querySelectorAll('div, article, section');
                let best = '';
                for (let i = nodes.length - 1; i >= 0; i--) {
                    const t = (nodes[i].textContent || nodes[i].innerText || '').trim();
                    if (t.length > 30 && t.length < 50000 && t.length > best.length) {
                        best = t;
                    }
                }
                return best;
            }""")
            if text and len(text) > 20:
                log.info("[%s] Ultimate fallback: %d chars", self.name, len(text))
                return text
        except Exception:
            pass

        log.warning("[%s] ALL extraction strategies exhausted — returning empty", self.name)
        return ""

    # ── Clean & Validate ───────────────────────────────────────────────────

    # Navigation / UI noise markers stripped by clean_response.
    # Each tuple is (marker, max_line_len) — lines containing the marker are
    # dropped ONLY if the line is shorter than max_line_len (prevents false
    # positives when a real response discusses these platforms by name).
    NOISE_MARKERS: list[tuple[str, int]] = [
        ("和 Gemini 的對話", 40),
        ("你說了", 20),
        ("Gemini 說了", 30),
        ("Gemini 是 AI", 40),
        ("ChatGPT", 15),
        ("Claude", 12),
        ("Kimi", 10),
        ("豆包", 8),
        ("千问", 8),
        ("Pro", 5),
        ("延長", 5),
        ("Copy", 8),
        ("複製", 8),
        ("Good response", 20),
        ("好答案", 10),
        ("Send", 8),
        ("发送", 8),
        ("傳送", 8),
        ("新對話", 10),
        ("搜尋對話", 10),
        ("You are out of free messages", 80),
        ("Upgrade to", 30),
        ("Cancel anytime", 30),
    ]

    # Generic error/rate-limit patterns checked by validate_response.
    GENERIC_ERROR_PATTERNS = [
        "You are out of free messages",
        "You've hit your limit",
        "You hit your 5-hour message limit",
        "Upgrade to keep chatting",
        "limits will reset",
        "explore our Pro plan",
        "out of free messages until",
        "Please wait",
        "请稍候…",
        "Just a moment",
        "Verify you are human",
        "Cloudflare",
    ]

    def clean_response(self, raw_text: str, prompt: str = "") -> str:
        """Strip prompt echo, navigation labels, and UI chrome from response.

        Noise filtering uses per-marker max-line-length guards so that a
        legitimate sentence like "Claude Code is great for architecture review"
        is NOT stripped just because it contains the word "Claude".
        """
        if not raw_text:
            return ""
        text = raw_text.strip()

        # Strip the user's prompt if it appears verbatim at the start
        if prompt and text.startswith(prompt):
            text = text[len(prompt):].strip()

        # Noise marker removal with line-length guard
        for marker, max_len in self.NOISE_MARKERS:
            if marker in text:
                lines = text.split('\n')
                text = '\n'.join(
                    l for l in lines
                    if not (marker in l and len(l.strip()) < max_len)
                ).strip()

        text = text.strip('\n')
        return text

    def validate_response(self, text: str, prompt: str = "") -> tuple[bool, str]:
        """Check if response is a real answer or garbage.

        Returns:
            (is_valid, reason) where reason is one of:
            OK, EMPTY_OR_TOO_SHORT, ERROR_PATTERN_DETECTED, PROMPT_ECHO_DOMINANT,
            UI_CHROME_DOMINANT, DEGRADED_BUT_USABLE
        """
        if not text or len(text.strip()) < 5:
            return False, "EMPTY_OR_TOO_SHORT"

        # Check error / rate-limit patterns (combined generic + platform-specific)
        all_patterns = self.GENERIC_ERROR_PATTERNS + list(self.ERROR_PATTERNS)
        for pattern in all_patterns:
            if pattern.lower() in text.lower():
                return False, f"ERROR_PATTERN_DETECTED: {pattern[:40]}"

        # Check if response is mostly the user's own prompt (old convo bleed)
        if len(prompt) > 5:
            prompt_ratio = text.count(prompt) * len(prompt) / max(len(text), 1)
            if prompt_ratio > 0.5:
                return False, "PROMPT_ECHO_DOMINANT"

        # UI chrome detection: many short lines = navigation
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        if len(lines) > 20:
            short_lines = sum(1 for l in lines if len(l) < 30)
            if short_lines > len(lines) * 0.7:
                # UI_CHROME_DOMINANT but still has some content —
                # caller decides whether to use it (orchestrator P2 leniency)
                return False, "UI_CHROME_DOMINANT"

        return True, "OK"

    @staticmethod
    def is_pipeline_usable(is_valid: bool, reason: str, text_len: int) -> bool:
        """Centralised leniency rule for Phase 2 and main.py workers.

        UI_CHROME_DOMINANT responses often still contain usable content — the
        extraction just picked up some navigation chrome.  If the text is
        long enough (>200 chars), treat it as usable for downstream processing.
        """
        if is_valid:
            return True
        if reason == "UI_CHROME_DOMINANT" and text_len > 200:
            return True
        return False

    # ── Full submit pipeline (convenience) ─────────────────────────────────

    async def submit(self, page, prompt: str, timeout_ms: int = 300_000) -> str:
        """Full pipeline: clear → inject → send → wait."""
        await self.clear_input(page)
        await self.inject_prompt(page, prompt)
        await self.trigger_send(page)
        return await self.wait_response(page, timeout_ms)
