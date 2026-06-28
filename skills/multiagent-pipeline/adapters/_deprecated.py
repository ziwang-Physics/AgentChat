#!/usr/bin/env python3
"""Doubao adapter — ByteDance Doubao (🚫 DEPRECATED 2026-06-27).

Retained for manual opt-in via ``--adapters doubao``.  CSS-module hashed class
names make selectors fragile; not recommended for automated pipelines.
"""

import logging

from .base import BaseAdapter

log = logging.getLogger("adapters.doubao")


class DoubaoAdapter(BaseAdapter):
    name = "Doubao"
    EDITOR_SELECTOR = (
        'textarea, div[contenteditable="true"], [role="textbox"], '
        '.input-area textarea, .chat-input'
    )
    SEND_SELECTOR = (
        'button[aria-label*="发送"], button[aria-label*="Send"], '
        '.send-button, [class*="send"]'
    )
    STOP_SELECTOR = (
        'button[aria-label*="停止"], button[aria-label*="Stop"], .stop-button'
    )
    TOOLBAR_SELECTOR = (
        'button[aria-label*="复制"], button[aria-label*="Copy"], .copy-button'
    )
    URL = "https://www.doubao.com/chat/?from_login=1&login_source=chat"
    RESPONSE_STRATEGIES = [
        '[class*="message-list"]:not([class*="suggest"])',
        'div.whitespace-pre-wrap',
        '[class*="message"] [class*="content"]',
    ]
