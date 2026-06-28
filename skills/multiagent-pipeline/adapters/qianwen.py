#!/usr/bin/env python3
"""Qianwen adapter — Alibaba Tongyi Qianwen (⭐⭐⭐ DOM verified).

DOM-probed 2026-06-27: [class*="message"] containers, "Qwen3.7-Max\\n<answer>"
response format.  Stability improved after selector refinements.
"""

from .base import BaseAdapter


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
