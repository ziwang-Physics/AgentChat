#!/usr/bin/env python3
"""Kimi adapter — Moonshot AI Kimi (⭐⭐⭐ DOM verified).

DOM-probed 2026-06-27: React SPA, chat-content-item messages,
chat-content-list conversation area.  Needs first field test.
"""

from .base import BaseAdapter


class KimiAdapter(BaseAdapter):
    name = "Kimi"
    EDITOR_SELECTOR = (
        'div[contenteditable="true"], textarea, [role="textbox"], .editor-content'
    )
    SEND_SELECTOR = (
        'button[aria-label*="发送"], button[aria-label*="Send"], '
        'button[type="submit"], .send-btn'
    )
    STOP_SELECTOR = (
        'button[aria-label*="停止"], button[aria-label*="Stop"], .stop-btn'
    )
    TOOLBAR_SELECTOR = (
        'button[aria-label*="复制"], button[aria-label*="Copy"], .copy-btn'
    )
    URL = "https://www.kimi.com/"
    RESPONSE_STRATEGIES = [
        'div.chat-content-item:last-of-type',
        'div.chat-content-list',
        'div.chat-detail-content',
        'div.main',
    ]
    # During generation Kimi shows typing dots / loading indicator.
    # Stability fallback checks this — if still visible, the real answer
    # hasn't arrived yet and we must keep waiting.
    THINKING_SELECTOR = (
        '[class*="typing"], [class*="loading-indicator"], '
        '[class*="stop-generate"]'
    )
