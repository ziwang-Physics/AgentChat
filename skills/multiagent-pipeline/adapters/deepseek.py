#!/usr/bin/env python3
"""DeepSeek adapter — DeepSeek Chat (⭐⭐⭐ DOM verified).

DOM-probed 2026-06-27: textarea editor, Expert mode (专家模式) radio,
Deep Think (深度思考) toggle, Smart Search (智能搜索) toggle.
Supports mode-aware connection for maximum reasoning capability.
"""

import logging

from .base import BaseAdapter

log = logging.getLogger("adapters.deepseek")


class DeepSeekAdapter(BaseAdapter):
    name = "DeepSeek"
    EDITOR_SELECTOR = 'textarea'
    SEND_SELECTOR = 'button[aria-label*="发送"], button[aria-label*="Send"]'
    STOP_SELECTOR = 'button[aria-label*="停止"], button[aria-label*="Stop"]'
    TOOLBAR_SELECTOR = 'button[aria-label*="复制"], button[aria-label*="Copy"]'
    URL = "https://chat.deepseek.com/"
    RESPONSE_STRATEGIES = [
        '[class*="assistant"]',
        '[class*="message"]:last-of-type',
        '[class*="markdown"]',
        '[class*="content"]',
    ]

    # Mode / Toggle selectors
    EXPERT_MODE_RADIO = '[role="radio"]'
    DEEP_THINK_TOGGLE = '.ds-toggle-button'
    SMART_SEARCH_TOGGLE = '.ds-toggle-button'
    TOGGLE_SELECTED_CLASS = 'ds-toggle-button--selected'

    async def ensure_expert_mode(self, page) -> bool:
        """Switch to Expert mode (专家模式). Idempotent."""
        try:
            expert = page.locator(self.EXPERT_MODE_RADIO).filter(
                has_text="专家模式"
            ).first
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
            log.warning("[DeepSeek] Expert mode switch failed: %s", e)
            return False

    async def ensure_deep_think(self, page) -> bool:
        """Enable Deep Think (深度思考, R1 reasoning). Idempotent."""
        try:
            toggle = page.locator(self.DEEP_THINK_TOGGLE).filter(
                has_text="深度思考"
            ).first
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
            log.warning("[DeepSeek] Deep Think toggle failed: %s", e)
            return False

    async def ensure_smart_search(self, page) -> bool:
        """Enable Smart Search (智能搜索). Non-fatal if missing."""
        try:
            toggle = page.locator(self.SMART_SEARCH_TOGGLE).filter(
                has_text="智能搜索"
            ).first
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
            log.info("[DeepSeek] Smart Search toggle skipped: %s", e)
            return False
