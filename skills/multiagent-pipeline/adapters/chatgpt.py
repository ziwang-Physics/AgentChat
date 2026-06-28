#!/usr/bin/env python3
"""ChatGPT adapter — OpenAI ChatGPT (⭐⭐⭐⭐ Tested).

Proven DOM selectors for prompt-textarea, send-button, and assistant messages.
"""

from .base import BaseAdapter


class ChatGPTAdapter(BaseAdapter):
    name = "ChatGPT"
    EDITOR_SELECTOR = (
        '#prompt-textarea, div[contenteditable="true"], [data-id="root"]'
    )
    SEND_SELECTOR = 'button[data-testid="send-button"], button[aria-label*="Send"]'
    STOP_SELECTOR = 'button[data-testid="stop-button"], button[aria-label*="Stop"]'
    TOOLBAR_SELECTOR = (
        'button[data-testid="copy-turn-action-button"], button[aria-label*="Copy"]'
    )
    URL = "https://chatgpt.com/"
    RESPONSE_STRATEGIES = [
        '[data-message-author-role="assistant"]',
        'article:last-of-type [class*="markdown"]',
        '.message-group:last-child .content',
        '[class*="assistant"] [class*="prose"]',
    ]
