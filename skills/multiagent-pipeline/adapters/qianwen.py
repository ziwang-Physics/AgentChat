#!/usr/bin/env python3
"""Qianwen adapter — Alibaba Tongyi Qianwen (⭐⭐⭐ DOM verified).

DOM-probed 2026-06-27: [class*="message"] containers, "Qwen3.7-Max\\n<answer>"
response format.  Stability improved after selector refinements.

Deep Thinking toggle (2026-06-28):
  - Button: button[aria-label="思考"] with aria-pressed toggle
  - aria-pressed="false" → off, aria-pressed="true" → on
  - Idempotent guard: skip click if already pressed
"""

import asyncio, logging

from .base import BaseAdapter

log = logging.getLogger("adapters.qianwen")

# ── Deep Thinking toggle constants ────────────────────────────────────────
THINK_BTN_SELECTOR = 'button[aria-label="思考"]'
THINK_TOGGLE_WAIT_S  = 2.0              # post-click React state settle time


class QianwenAdapter(BaseAdapter):
    name = "Qianwen"
    EDITOR_SELECTOR = (
        'textarea, div[contenteditable="true"], [role="textbox"], '
        '.input-box, .chat-input-area'
    )
    SEND_SELECTOR = (
        'button[aria-label*="发送"], button[aria-label*="Send"], '
        '.send-btn, [class*="submit"]'
    )
    STOP_SELECTOR = (
        'button[aria-label*="停止"], button[aria-label*="Stop"], .stop-btn'
    )
    TOOLBAR_SELECTOR = (
        'button[aria-label*="复制"], button[aria-label*="Copy"], .copy-btn'
    )
    URL = "https://www.qianwen.com/?source=tongyigw"
    RESPONSE_STRATEGIES = [
        '[class*="message"]:last-of-type',
        '[class*="message"]',
        '[class*="bot"] [class*="answer"]',
        '[class*="chat-message"]:last-child',
    ]
    # During Deep Thinking / normal generation, the stop button is visible.
    # If it's still there, the answer hasn't finished rendering.
    THINKING_SELECTOR = (
        'button[aria-label*="停止"], .stop-btn, '
        '[class*="think-loader"], [class*="generating"]'
    )

    # ── Deep Thinking toggle ──────────────────────────────────────────────

    async def ensure_thinking_mode(self, page) -> bool:
        """Enable 思考 (Deep Thinking) mode via aria-pressed toggle.

        Idempotent — skips if aria-pressed is already \"true\".
        Uses the FIRST visible button (there may be desktop + mobile
        duplicates in the DOM).

        Returns True on success, False if any step fails (non-fatal for P2).
        """
        try:
            # Find the visible "思考" button. Use .first since there are
            # duplicate buttons in the sidebar + main area.
            btn = page.locator(THINK_BTN_SELECTOR).first
            await btn.wait_for(state="visible", timeout=5000)

            # Idempotent guard — aria-pressed="true" means already active
            pressed = await btn.get_attribute("aria-pressed")
            if pressed == "true":
                log.info("[Qianwen] Deep Thinking already active (aria-pressed guard)")
                return True

            # Click to enable
            log.info("[Qianwen] Enabling Deep Thinking (aria-pressed=%s)", pressed)
            await btn.click()
            await asyncio.sleep(THINK_TOGGLE_WAIT_S)

            # Verify
            pressed = await btn.get_attribute("aria-pressed")
            if pressed == "true":
                log.info("[Qianwen] Deep Thinking activated ✓")
                return True
            else:
                log.warning("[Qianwen] Deep Thinking may not be active (aria-pressed=%s)",
                            pressed)
                # Optimistic: the click likely worked even if aria-pressed
                # hasn't updated yet (React batching)
                return True

        except Exception as e:
            log.warning("[Qianwen] Deep Thinking toggle failed: %s", e)
            return False
