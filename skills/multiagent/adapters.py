#!/usr/bin/env python3
"""
6-Platform Adapters for MultiAgent Concurrent Chat.

Unified interface for: Gemini, ChatGPT, Claude, Kimi, Doubao, Qianwen.
All adapters share proven DOM interaction patterns:
  - Keyboard clearing (Ctrl+A+Backspace) — triggers framework zone.js
  - keyboard.insertText() for input — no TrustedHTML issues
  - DOM innerText extraction — no OS clipboard races
  - Stop button / toolbar for completion detection

Maturity levels:
  ⭐⭐⭐⭐⭐ = Field-verified, proven reliable
  ⭐⭐⭐⭐   = Tested, needs selector tuning
  ⭐⭐⭐     = Baseline selectors set, needs first field test
  ⭐⭐       = Placeholder selectors, needs discovery
"""

import asyncio, time, logging, os

log = logging.getLogger("adapters")

# ── CDP Security (P0 fix 2026-06-28) ───────────────────────────────────────
# Chrome --remote-debugging-token provides bearer-token auth on CDP port.
# If CHROME_CDP_TOKEN is set, it MUST be passed to connect_over_cdp.
_CDP_TOKEN = os.environ.get("CHROME_CDP_TOKEN", "")


def _cdp_url(port: str = "9222") -> str:
    """Build CDP endpoint URL. Appends ?token= if CHROME_CDP_TOKEN is set."""
    base = f"http://127.0.0.1:{port}"
    return f"{base}?token={_CDP_TOKEN}" if _CDP_TOKEN else base


# ── Base Adapter ────────────────────────────────────────────────────────────

class BaseAdapter:
    """Abstract interface. Subclass must define platform-specific selectors."""

    name: str = "base"
    cdp_port: str = "9222"

    # ── Subclass MUST override ──
    EDITOR_SELECTOR: str = ""
    SEND_SELECTOR: str = ""
    STOP_SELECTOR: str = ""
    TOOLBAR_SELECTOR: str = ""
    RESPONSE_SELECTOR: str = ""
    URL: str = ""

    def __init__(self, cdp_port: str = "9222"):
        self.cdp_port = cdp_port

    # ── Response extraction strategies (ordered: first match wins) ──
    # Subclass MUST override with platform-specific selector chains.
    RESPONSE_STRATEGIES: list[str] = []

    async def connect(self, pw=None, context=None):
        """Connect to platform. Two modes:

        1. SHARED CONTEXT (recommended): pass `context=` (a BrowserContext).
           Creates a new TAB in the existing Chrome window. All platforms
           share one window, each in its own tab. Cleanup only closes the tab.

        2. INDEPENDENT CONTEXT (legacy): pass `pw=` (Playwright instance).
           Creates a new BrowserContext (= new Chrome window). Each platform
           gets its own window. Cleanup destroys the context.
        """
        # ── Mode 1: Shared context (one window, many tabs) ──
        if context is not None:
            self._owns_context = False
            self._context = context
            page = await context.new_page()
            await page.goto(self.URL, wait_until="domcontentloaded", timeout=45000)
            await page.wait_for_timeout(3000)
            # Wake SPA
            try:
                await page.mouse.click(400, 400)
            except Exception:
                pass
            await page.wait_for_timeout(2000)
            self._page = page
            log.info(f"[{self.name}] Connected (shared tab) — {await page.title()}")
            return page

        # ── Mode 2: Independent context (legacy, one window per platform) ──
        if pw is None:
            raise ValueError("connect() requires either pw= or context=")

        self._owns_context = True
        browser = await pw.chromium.connect_over_cdp(_cdp_url(self.cdp_port))
        self._browser = browser
        self._context = await browser.new_context(
            viewport={"width": 1280, "height": 800}
        )
        await self._context.grant_permissions(["clipboard-read", "clipboard-write"])

        page = await self._context.new_page()
        await page.goto(self.URL, wait_until="domcontentloaded", timeout=45000)
        await page.wait_for_timeout(3000)

        # Wake SPA
        try:
            await page.mouse.click(400, 400)
        except Exception:
            pass
        await page.wait_for_timeout(2000)

        self._page = page
        log.info(f"[{self.name}] Connected (isolated context) — {await page.title()}")
        return page

    async def cleanup(self) -> None:
        """Clean up: close page (shared mode) or destroy context (legacy mode)."""
        # Shared mode: just close the tab, context stays alive
        if hasattr(self, '_owns_context') and not self._owns_context:
            if hasattr(self, '_page') and self._page:
                try:
                    await self._page.close()
                    log.info(f"[{self.name}] Tab closed")
                except Exception as e:
                    log.warning(f"[{self.name}] Tab close error: {e}")
            return

        # Legacy mode: destroy the entire BrowserContext (window)
        if hasattr(self, '_context') and self._context:
            try:
                await self._context.close()
                log.info(f"[{self.name}] Context destroyed")
            except Exception as e:
                log.warning(f"[{self.name}] Context close error: {e}")

    async def ensure_ready(self, page) -> None:
        """Wait for input editor visible and editable."""
        try:
            editor = page.locator(self.EDITOR_SELECTOR).first
            await editor.wait_for(state="visible", timeout=15000)
            await editor.focus()
            await editor.click()
            log.info(f"[{self.name}] Editor ready")
        except Exception as e:
            log.warning(f"[{self.name}] Editor wait failed: {e}")
            await page.goto(page.url, wait_until="domcontentloaded", timeout=30000)
            await page.wait_for_timeout(5000)
            editor = page.locator(self.EDITOR_SELECTOR).first
            await editor.wait_for(state="visible", timeout=15000)
            await editor.focus()
            await editor.click()

    async def ensure_fresh_conversation(self, page) -> None:
        """Start a new conversation. Override in platform adapters.
        Default: navigate to base URL (strips conversation-specific path)."""
        log.info(f"[{self.name}] Starting fresh conversation via URL navigation")
        await page.goto(self.URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        try:
            await page.mouse.click(400, 400)
        except Exception:
            pass
        await page.wait_for_timeout(2000)

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
        """Type text via keyboard (triggers framework events naturally)."""
        INSERT_LIMIT = 50_000
        if len(text) > INSERT_LIMIT:
            log.info(f"[{self.name}] Large prompt ({len(text)} chars), using clipboard paste")
            try:
                await page.evaluate("(t) => navigator.clipboard.writeText(t)", text)
            except Exception:
                log.warning(f"[{self.name}] Clipboard write failed")
            await page.keyboard.press("ControlOrMeta+v")
            await page.wait_for_timeout(500)
        else:
            await page.keyboard.insert_text(text)

        await page.wait_for_timeout(300)

        # Integrity check
        editor = page.locator(self.EDITOR_SELECTOR).first
        injected = await editor.evaluate("el => (el.innerText || el.textContent || '').trim().length")
        if abs(injected - len(text)) > len(text) * 0.05:
            log.warning(f"[{self.name}] Payload mismatch: expected ~{len(text)}, got {injected}")
            raise RuntimeError(f"Input payload truncated ({injected} vs {len(text)})")

        # Belt-and-suspenders: type char + delete to wake framework
        try:
            await page.keyboard.type(",")
            await page.keyboard.press("Backspace")
            await page.wait_for_timeout(200)
        except Exception:
            pass

        log.info(f"[{self.name}] Prompt injected ({injected} chars OK)")

    async def trigger_send(self, page) -> None:
        """Click send button or press Enter."""
        try:
            send_btn = page.locator(self.SEND_SELECTOR).first
            await send_btn.wait_for(state="visible", timeout=5000)
            if await send_btn.is_enabled():
                await send_btn.click()
                log.info(f"[{self.name}] Sent via button click")
                return
        except Exception:
            pass
        await page.keyboard.press("Enter")
        log.info(f"[{self.name}] Sent via Enter")

    async def wait_response(self, page, timeout_ms: int = 300_000) -> str:
        """Wait for generation complete, then extract response."""
        start = time.time()

        # Wait for stop button appear → disappear
        try:
            stop_btn = page.locator(self.STOP_SELECTOR).first
            await stop_btn.wait_for(state="visible", timeout=30_000)
            log.info(f"[{self.name}] Generation started")
            remaining = max(10_000, timeout_ms - int((time.time() - start) * 1000))
            await stop_btn.wait_for(state="hidden", timeout=remaining)
            log.info(f"[{self.name}] Generation finished")
        except Exception:
            log.info(f"[{self.name}] No prolonged generation phase")

        # Wait for toolbar (completion anchor)
        try:
            toolbar = page.locator(self.TOOLBAR_SELECTOR).first
            remaining = max(10_000, timeout_ms - int((time.time() - start) * 1000))
            await toolbar.wait_for(state="visible", timeout=remaining)
            log.info(f"[{self.name}] Response toolbar detected")
        except Exception:
            log.info(f"[{self.name}] Toolbar not detected, stability fallback")
            last_len = 0
            last_change = time.time()
            while (time.time() - last_change) < 15:
                if (time.time() - start) * 1000 > timeout_ms:
                    break
                try:
                    await page.wait_for_timeout(2000)
                    current = await self.extract_response(page)
                    if len(current) > last_len:
                        last_len = len(current)
                        last_change = time.time()
                except Exception as e:
                    log.warning(f"[{self.name}] Stability poll interrupted: {e}")
                    break

        try:
            return await self.extract_response(page)
        except Exception as e:
            log.warning(f"[{self.name}] Final extract failed: {e}")
            return ""

    async def extract_response(self, page) -> str:
        """Solution 1: Multi-strategy DOM extraction. NEVER touches OS clipboard.

        Tries each selector in RESPONSE_STRATEGIES. Returns the first match
        with substantial content (>20 chars). No keyboard copy fallback —
        if all strategies fail, returns empty string."""
        strategies = self.RESPONSE_STRATEGIES
        if not strategies:
            log.warning(f"[{self.name}] No RESPONSE_STRATEGIES defined!")
            return ""

        for i, sel in enumerate(strategies):
            try:
                # P0 security: selector passed as parameter, not string-interpolated
                text = await page.evaluate("""(sel) => {
                    const els = document.querySelectorAll(sel);
                    if (els.length === 0) return '';
                    // Get the LAST matching element (latest response)
                    const el = els[els.length - 1];
                    return (el.innerText || el.textContent || '').trim();
                }""", sel)
                if text and len(text) > 20:
                    log.info(f"[{self.name}] Strategy #{i+1} '{sel[:50]}' → {len(text)} chars")
                    return text
            except Exception as e:
                log.debug(f"[{self.name}] Strategy #{i+1} failed: {e}")
                continue

        # ── Ultimate fallback: find largest text block in page ──
        try:
            text = await page.evaluate("""() => {
                const nodes = document.querySelectorAll('div, article, section');
                let best = '';
                for (let i = nodes.length - 1; i >= 0; i--) {
                    const t = (nodes[i].innerText || '').trim();
                    // Prefer blocks between 30-50000 chars (actual responses, not UI)
                    if (t.length > 30 && t.length < 50000 && t.length > best.length) {
                        best = t;
                    }
                }
                return best;
            }""")
            if text and len(text) > 20:
                log.info(f"[{self.name}] Ultimate fallback: {len(text)} chars")
                return text
        except Exception:
            pass

        log.warning(f"[{self.name}] ALL extraction strategies exhausted — returning empty")
        return ""

    def clean_response(self, raw_text: str, prompt: str = "") -> str:
        """Strip prompt text, navigation labels, and UI chrome from response."""
        if not raw_text:
            return ""
        text = raw_text.strip()

        # Strip the user's prompt if it appears verbatim at the start
        if prompt and text.startswith(prompt):
            text = text[len(prompt):].strip()

        # Strip common navigation/UI labels that bleed into extraction
        noise_patterns = [
            "和 Gemini 的對話", "你說了", "Gemini 說了",
            "ChatGPT", "Claude", "Kimi", "豆包", "千问",
            "Pro", "延長", "Gemini 是 AI",
            "Copy", "複製", "Good response", "好答案",
            "Send", "发送", "傳送",
            "新對話", "搜尋對話",
            "You are out of free messages", "Upgrade to",
            "Cancel anytime",
        ]
        for pattern in noise_patterns:
            if pattern in text:
                # Remove lines containing only noise patterns
                lines = text.split('\n')
                text = '\n'.join(
                    l for l in lines
                    if not any(n in l and len(l.strip()) < len(n) + 10 for n in noise_patterns)
                ).strip()

        # If text starts/ends with lots of newlines, trim
        text = text.strip('\n')

        return text

    # ── Platform-specific error/rate-limit patterns ──
    # Override in subclasses to add platform-specific detection
    ERROR_PATTERNS = [
        # Generic rate-limit / auth errors
        "You are out of free messages",
        "You've hit your limit",
        "You hit your 5-hour message limit",
        "Upgrade to keep chatting",
        "limits will reset",
        "explore our Pro plan",
        "out of free messages until",
        # Generic error pages
        "Please wait",
        "请稍候…",
        "Just a moment",
        "Verify you are human",
        "Cloudflare",
    ]

    def validate_response(self, text: str, prompt: str = "") -> tuple[bool, str]:
        """Check if response is a real answer or garbage (rate-limit, UI, old convo).

        Returns (is_valid, reason).
        """
        if not text or len(text.strip()) < 5:
            return False, "EMPTY_OR_TOO_SHORT"

        # Check for rate-limit / error patterns
        for pattern in self.ERROR_PATTERNS:
            if pattern.lower() in text.lower():
                return False, f"ERROR_PATTERN_DETECTED: {pattern[:40]}"

        # Check if response is mostly the user's own prompt (old convo bleed)
        if len(prompt) > 5:
            prompt_ratio = text.count(prompt) * len(prompt) / max(len(text), 1)
            if prompt_ratio > 0.5:
                return False, "PROMPT_ECHO_DOMINANT"

        # Check if response looks like UI-only (many short lines = navigation)
        lines = [l.strip() for l in text.split('\n') if l.strip()]
        if len(lines) > 20:
            short_lines = sum(1 for l in lines if len(l) < 30)
            if short_lines > len(lines) * 0.7:
                return False, "UI_CHROME_DOMINANT"

        return True, "OK"

    async def submit(self, page, prompt: str, timeout_ms: int = 300_000) -> str:
        """Full pipeline."""
        await self.clear_input(page)
        await self.inject_prompt(page, prompt)
        await self.trigger_send(page)
        return await self.wait_response(page, timeout_ms)


# ── Gemini Adapter (⭐⭐⭐⭐⭐ Verified) ─────────────────────────────────────

class GeminiAdapter(BaseAdapter):
    name = "Gemini"
    EDITOR_SELECTOR = '.ql-editor, [contenteditable="true"][role="textbox"], rich-textarea'
    SEND_SELECTOR = 'button[aria-label*="傳送"], button[aria-label*="发送"], button[aria-label*="Send"]'
    STOP_SELECTOR = 'button[aria-label*="停止"], button[aria-label*="Stop"]'
    TOOLBAR_SELECTOR = 'button[aria-label*="複製"], button[aria-label*="Copy"], button[aria-label*="Good response"]'
    URL = "https://gemini.google.com/u/0/app"
    RESPONSE_STRATEGIES = [
        "model-message",
        ".model-response-text",
        'div[role="listitem"]:last-child',
        '[class*="response-text"]',
        '[class*="model-response"]',
    ]
    ERROR_PATTERNS = BaseAdapter.ERROR_PATTERNS + [
        "和 Gemini 的對話",
        "Gemini 是 AI，有時可能會出錯",
    ]

    async def ensure_fresh_conversation(self, page) -> None:
        """Start a new conversation to avoid old history bleeding into extraction.
        Detects if page has existing messages; if so, clicks 'new chat' button.
        If button not found, navigates to base URL (drops conversation ID)."""
        # Check for existing conversation messages
        msg_count = await page.evaluate(
            "() => document.querySelectorAll('model-message').length"
        )
        if msg_count == 0:
            return  # already fresh

        log.info(f"[Gemini] {msg_count} existing messages — starting fresh conversation")
        # Try clicking the "新對話" / "New chat" button in sidebar
        try:
            new_chat = page.locator(
                'a[aria-label*="新對話"], a[aria-label*="New chat"], '
                'button[aria-label*="新對話"], button[aria-label*="New chat"]'
            ).first
            await new_chat.wait_for(state="visible", timeout=5000)
            await new_chat.click()
            await page.wait_for_timeout(3000)
            # Verify we got a clean page
            new_count = await page.evaluate(
                "() => document.querySelectorAll('model-message').length"
            )
            if new_count == 0:
                log.info("[Gemini] Fresh conversation started via sidebar button")
                # Re-wake editor
                try:
                    await page.mouse.click(400, 400)
                except Exception:
                    pass
                await page.wait_for_timeout(2000)
                return
        except Exception as e:
            log.warning(f"[Gemini] New chat button not found: {e}")

        # Fallback: navigate to base URL (strips conversation ID)
        log.info("[Gemini] Falling back to base URL navigation")
        await page.goto(self.URL, wait_until="domcontentloaded", timeout=30000)
        await page.wait_for_timeout(3000)
        try:
            await page.mouse.click(400, 400)
        except Exception:
            pass
        await page.wait_for_timeout(2000)

    async def ensure_pro_extended(self, page) -> bool:
        """Switch to Pro Extended Thinking. Idempotent."""
        current = await page.evaluate("""() => {
            const btn = document.querySelector('button[aria-label*="模式挑選器"], button[aria-label*="Model selector"]');
            return btn ? btn.textContent.trim() : 'UNKNOWN';
        }""")
        if "延長" in current or "Extended" in current:
            log.info("[Gemini] Pro Extended already active")
            return True

        await page.keyboard.press("Escape")
        await page.wait_for_timeout(500)
        try:
            selector = page.locator(
                'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"]'
            ).first
            await selector.wait_for(state="visible", timeout=5000)
            await selector.click()
            await page.locator('[role="menu"]').wait_for(state="visible", timeout=5000)
        except Exception:
            log.warning("[Gemini] Cannot open model selector")
            return False

        if "Pro" not in current or "Flash" in current:
            try:
                pro = page.locator('[role="menuitem"]', has_text="Pro").filter(has_not_text="Flash").first
                await pro.click()
                await page.wait_for_timeout(2000)
                selector = page.locator(
                    'button[aria-label*="模式挑選器"], button[aria-label*="Model selector"]'
                ).first
                await selector.click()
                await page.locator('[role="menu"]').wait_for(state="visible", timeout=5000)
            except Exception:
                log.warning("[Gemini] Cannot switch to Pro")

        try:
            extended = page.locator('[role="menuitem"]').filter(has_text=r"延長|Extended").filter(has_not_text=r"思考|Thought").first
            if not await extended.is_visible():
                thought = page.locator('[role="menuitem"]', has_text=r"思考|Thought").first
                await thought.click()
                await extended.wait_for(state="visible", timeout=5000)
            await extended.click()
            log.info("[Gemini] Selected Extended thinking")
        except Exception as e:
            log.warning(f"[Gemini] Extended selection failed: {e}")
            return False

        await page.keyboard.press("Escape")
        await page.wait_for_timeout(1000)
        is_active = await page.evaluate("""() => {
            const btn = document.querySelector('button[aria-label*="模式挑選器"], button[aria-label*="Model selector"]');
            if (!btn) return false;
            const t = btn.textContent.trim();
            return t.includes('延長') || t.includes('Extended');
        }""")
        if is_active:
            log.info("[Gemini] Pro Extended verified")
        return bool(is_active)


# ── ChatGPT Adapter (⭐⭐⭐⭐ Tested) ────────────────────────────────────────

class ChatGPTAdapter(BaseAdapter):
    name = "ChatGPT"
    EDITOR_SELECTOR = '#prompt-textarea, div[contenteditable="true"], [data-id="root"]'
    SEND_SELECTOR = 'button[data-testid="send-button"], button[aria-label*="Send"]'
    STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop"]'
    TOOLBAR_SELECTOR = 'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy"]'
    URL = "https://chatgpt.com/"
    RESPONSE_STRATEGIES = [
        '[data-message-author-role="assistant"]',
        'article:last-of-type [class*="markdown"]',
        '.message-group:last-child .content',
        '[class*="assistant"] [class*="prose"]',
    ]


# ── Claude Web Adapter (⭐⭐⭐ Needs selector tuning) ──────────────────────

class ClaudeAdapter(BaseAdapter):
    name = "Claude"
    EDITOR_SELECTOR = 'div.ProseMirror, [contenteditable="true"], textarea, [role="textbox"]'
    SEND_SELECTOR = 'button[aria-label*="Send"], button[type="submit"]'
    STOP_SELECTOR = 'button[aria-label*="Stop"], [data-testid="stop-generation"]'
    TOOLBAR_SELECTOR = 'button[aria-label*="Copy"], [data-testid="copy-button"]'
    URL = "https://claude.ai/new"
    RESPONSE_STRATEGIES = [
        '[data-testid="assistant-message"]',
        '[data-message-author-role="assistant"]',
        '.font-claude-message',
        '[class*="assistant"]',
        'article:last-of-type',
    ]
    ERROR_PATTERNS = BaseAdapter.ERROR_PATTERNS + [
        "Cancel anytime",
        "Plus, get more ways to use Claude",
        "Cowork", "Claude Code", "Microsoft Office",
    ]


# ── Kimi Adapter (⭐⭐ Needs first field test) ─────────────────────────────
# Moonshot AI — https://www.kimi.com/
# Educated guess: React SPA, contenteditable editor, similar to ChatGPT

class KimiAdapter(BaseAdapter):
    name = "Kimi"
    EDITOR_SELECTOR = 'div[contenteditable="true"], textarea, [role="textbox"], .editor-content'
    SEND_SELECTOR = 'button[aria-label*="发送"], button[aria-label*="Send"], button[type="submit"], .send-btn'
    STOP_SELECTOR = 'button[aria-label*="停止"], button[aria-label*="Stop"], .stop-btn'
    TOOLBAR_SELECTOR = 'button[aria-label*="复制"], button[aria-label*="Copy"], .copy-btn'
    URL = "https://www.kimi.com/"
    # DOM probe 2026-06-27: chat-content-item = user/AI messages;
    # chat-content-list = conversation area (no sidebar).
    # Avoid #app / .n-config-provider — includes sidebar with old prompt titles.
    RESPONSE_STRATEGIES = [
        'div.chat-content-item:last-of-type',   # Last message = AI response
        'div.chat-content-list',                 # Full conversation area
        'div.chat-detail-content',               # Wider conversation scope
        'div.main',                              # Content area (excludes sidebar)
    ]


# ── Doubao Adapter (DEPRECATED 2026-06-27) ──────────────────────────────
# ByteDance — https://www.doubao.com/chat/
# Retained for manual use via --adapters doubao; removed from defaults.

class DoubaoAdapter(BaseAdapter):
    name = "Doubao"
    EDITOR_SELECTOR = 'textarea, div[contenteditable="true"], [role="textbox"], .input-area textarea, .chat-input'
    SEND_SELECTOR = 'button[aria-label*="发送"], button[aria-label*="Send"], .send-button, [class*="send"]'
    STOP_SELECTOR = 'button[aria-label*="停止"], button[aria-label*="Stop"], .stop-button'
    TOOLBAR_SELECTOR = 'button[aria-label*="复制"], button[aria-label*="Copy"], .copy-button'
    URL = "https://www.doubao.com/chat/?from_login=1&login_source=chat"
    # DOM probe 2026-06-27: message-list-{hash} = conversation; suggest-{hash} = follow-ups.
    # whitespace-pre-wrap = individual message text blocks.
    # Class names use CSS modules (hashed) — must use [class*=] prefix matchers.
    RESPONSE_STRATEGIES = [
        '[class*="message-list"]:not([class*="suggest"])',  # Messages, not suggestions
        'div.whitespace-pre-wrap',                            # Individual text blocks
        '[class*="message"] [class*="content"]',             # Generic fallback
    ]


# ── Qianwen Adapter (⭐⭐ Needs first field test) ──────────────────────────
# Alibaba Tongyi Qianwen — https://www.qianwen.com/
# Educated guess: React SPA, similar patterns

class QianwenAdapter(BaseAdapter):
    name = "Qianwen"
    EDITOR_SELECTOR = 'textarea, div[contenteditable="true"], [role="textbox"], .input-box, .chat-input-area'
    SEND_SELECTOR = 'button[aria-label*="发送"], button[aria-label*="Send"], .send-btn, [class*="submit"]'
    STOP_SELECTOR = 'button[aria-label*="停止"], button[aria-label*="Stop"], .stop-btn'
    TOOLBAR_SELECTOR = 'button[aria-label*="复制"], button[aria-label*="Copy"], .copy-btn'
    URL = "https://www.qianwen.com/?source=tongyigw"
    # DOM probe 2026-06-27: [class*="message"] matches Qwen's message containers.
    # Response format: "Qwen3.7-Max\\n<answer text>"
    RESPONSE_STRATEGIES = [
        '[class*="message"]:last-of-type',        # Last message = AI response
        '[class*="message"]',                      # All messages (get last via JS)
        '[class*="bot"] [class*="answer"]',       # Legacy patterns
        '[class*="chat-message"]:last-child',     # Alternative structure
    ]


# ── DeepSeek Adapter (⭐⭐⭐ DOM verified 2026-06-27) ──────────────────────
# DeepSeek — https://chat.deepseek.com/
# Modes: 快速模式 (Fast) / 专家模式 (Expert) / 识图模式 (Vision)
# Toggles: 深度思考 (Deep Think, R1-style reasoning) / 智能搜索 (Smart Search)
# DOM probe 2026-06-27: textarea editor, Enter to send,
# [class*="message"] for responses, ds-toggle-button for toggles.

class DeepSeekAdapter(BaseAdapter):
    name = "DeepSeek"
    EDITOR_SELECTOR = 'textarea'
    SEND_SELECTOR = 'button[aria-label*="发送"], button[aria-label*="Send"]'
    STOP_SELECTOR = 'button[aria-label*="停止"], button[aria-label*="Stop"]'
    TOOLBAR_SELECTOR = 'button[aria-label*="复制"], button[aria-label*="Copy"]'
    URL = "https://chat.deepseek.com/"

    # probe-verified: [class*="message"] captures conversation messages
    # [class*="assistant"] targets AI responses specifically
    RESPONSE_STRATEGIES = [
        '[class*="assistant"]',                 # AI message container (probe: len=34)
        '[class*="message"]:last-of-type',       # Last conversation message
        '[class*="markdown"]',                   # Markdown-rendered content
        '[class*="content"]',                    # Generic content fallback
    ]

    # ── Mode / Toggle selectors ──
    EXPERT_MODE_RADIO = '[role="radio"]'         # filter by has_text="专家模式"
    DEEP_THINK_TOGGLE = '.ds-toggle-button'      # filter by has_text="深度思考"
    SMART_SEARCH_TOGGLE = '.ds-toggle-button'    # filter by has_text="智能搜索"
    TOGGLE_SELECTED_CLASS = 'ds-toggle-button--selected'

    async def ensure_expert_mode(self, page) -> bool:
        """Switch to Expert mode (专家模式). Idempotent — checks aria-checked first."""
        try:
            expert = page.locator(self.EXPERT_MODE_RADIO).filter(has_text="专家模式").first
            await expert.wait_for(state="visible", timeout=10000)
            is_checked = await expert.get_attribute("aria-checked")
            if is_checked == "true":
                log.info("[DeepSeek] Expert mode already active")
                return True
            await expert.click()
            await page.wait_for_timeout(1500)
            log.info("[DeepSeek] Expert mode activated")
            return True
        except Exception as e:
            log.warning(f"[DeepSeek] Expert mode switch failed: {e}")
            return False

    async def ensure_deep_think(self, page) -> bool:
        """Enable Deep Think (深度思考, R1 reasoning). Idempotent."""
        try:
            toggle = page.locator(self.DEEP_THINK_TOGGLE).filter(has_text="深度思考").first
            await toggle.wait_for(state="visible", timeout=10000)
            cls = await toggle.get_attribute("class") or ""
            if self.TOGGLE_SELECTED_CLASS in cls:
                log.info("[DeepSeek] Deep Think already ON")
                return True
            await toggle.click()
            await page.wait_for_timeout(500)
            log.info("[DeepSeek] Deep Think enabled")
            return True
        except Exception as e:
            log.warning(f"[DeepSeek] Deep Think toggle failed: {e}")
            return False

    async def ensure_smart_search(self, page) -> bool:
        """Enable Smart Search (智能搜索). Idempotent.
        Note: May be hidden or integrated in Expert mode — failure is non-fatal."""
        try:
            toggle = page.locator(self.SMART_SEARCH_TOGGLE).filter(has_text="智能搜索").first
            await toggle.wait_for(state="visible", timeout=5000)
            cls = await toggle.get_attribute("class") or ""
            if self.TOGGLE_SELECTED_CLASS in cls:
                log.info("[DeepSeek] Smart Search already ON")
                return True
            await toggle.click()
            await page.wait_for_timeout(500)
            log.info("[DeepSeek] Smart Search enabled")
            return True
        except Exception as e:
            log.info(f"[DeepSeek] Smart Search toggle skipped (may be integrated in Expert mode): {e}")
            return False  # Non-fatal


# ── Registry ────────────────────────────────────────────────────────────────

ADAPTER_REGISTRY = {
    "gemini": GeminiAdapter,
    "chatgpt": ChatGPTAdapter,
    "claude": ClaudeAdapter,
    "kimi": KimiAdapter,
    "doubao": DoubaoAdapter,
    "qianwen": QianwenAdapter,
    "deepseek": DeepSeekAdapter,
}

PLATFORM_MATURITY = {
    "gemini":  "⭐⭐⭐⭐⭐ Verified — DOM injection, extraction, Pro Extended",
    "chatgpt": "⭐⭐⭐⭐   Verified — works, response selector tuned",
    "claude":  "⭐⭐⭐     Works — rate-limit sensitive on free tier",
    "kimi":    "⭐⭐⭐     DOM selectors verified (2026-06-27 probe) — needs field test",
    "doubao":  "🚫 DEPRECATED — removed from defaults, use --adapters doubao to opt-in",
    "qianwen": "⭐⭐⭐     DOM selectors verified (2026-06-27 probe) — stability improved",
    "deepseek":"⭐⭐⭐     DOM verified (2026-06-27) — Expert + Deep Think + Smart Search",
}
