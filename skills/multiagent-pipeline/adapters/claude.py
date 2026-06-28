#!/usr/bin/env python3
"""Claude adapter — Anthropic Claude Web (⭐⭐⭐ Tested).

Free-tier rate limiting makes this the most fragile adapter.  Selectors tuned
for claude.ai/new with ProseMirror editor.
"""

from .base import BaseAdapter


class ClaudeAdapter(BaseAdapter):
    name = "Claude"
    EDITOR_SELECTOR = (
        'div.ProseMirror, [contenteditable="true"], textarea, [role="textbox"]'
    )
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
    ERROR_PATTERNS = [
        "Cancel anytime",
        "Plus, get more ways to use Claude",
        "Cowork",
        "Claude Code",
        "Microsoft Office",
    ]
