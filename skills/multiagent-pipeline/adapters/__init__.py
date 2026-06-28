#!/usr/bin/env python3
"""
MultiAgent platform adapters package.

Backward-compatible: ``from adapters import GeminiAdapter`` still works.
Also provides the registry and maturity metadata for dynamic dispatch.

Exports:
    BaseAdapter        — abstract base class
    GeminiAdapter      — Google Gemini (P4 adjudicator)
    ChatGPTAdapter     — OpenAI ChatGPT (P2 code/performance expert)
    ClaudeAdapter      — Anthropic Claude (P2 defensive architecture expert)
    KimiAdapter        — Moonshot Kimi (P2 literature/benchmark expert)
    QianwenAdapter     — Alibaba Qianwen (P2 security audit expert)
    DeepSeekAdapter    — DeepSeek Chat (optional, with Expert + Deep Think)
    DoubaoAdapter      — (deprecated, manual opt-in only)
    ADAPTER_REGISTRY   — dict[name, AdapterClass]
    PLATFORM_MATURITY  — dict[name, maturity_string]
"""

from .base import BaseAdapter
from .gemini import GeminiAdapter
from .chatgpt import ChatGPTAdapter
from .claude import ClaudeAdapter
from .kimi import KimiAdapter
from .qianwen import QianwenAdapter
from .deepseek import DeepSeekAdapter
from ._deprecated import DoubaoAdapter

ADAPTER_REGISTRY = {
    "gemini":    GeminiAdapter,
    "chatgpt":   ChatGPTAdapter,
    "claude":    ClaudeAdapter,
    "kimi":      KimiAdapter,
    "doubao":    DoubaoAdapter,
    "qianwen":   QianwenAdapter,
    "deepseek":  DeepSeekAdapter,
}

PLATFORM_MATURITY = {
    "gemini":    "⭐⭐⭐⭐⭐ Verified — DOM injection, extraction, Pro Extended",
    "chatgpt":   "⭐⭐⭐⭐   Verified — works, response selector tuned",
    "claude":    "⭐⭐⭐     Works — rate-limit sensitive on free tier",
    "kimi":      "⭐⭐⭐     DOM selectors verified (2026-06-27 probe) — needs field test",
    "doubao":    "🚫 DEPRECATED — removed from defaults, use --adapters doubao to opt-in",
    "qianwen":   "⭐⭐⭐     DOM selectors verified (2026-06-27 probe) — stability improved",
    "deepseek":  "⭐⭐⭐     DOM verified (2026-06-27) — Expert + Deep Think + Smart Search",
}

__all__ = [
    "BaseAdapter",
    "GeminiAdapter", "ChatGPTAdapter", "ClaudeAdapter",
    "KimiAdapter", "QianwenAdapter", "DeepSeekAdapter", "DoubaoAdapter",
    "ADAPTER_REGISTRY", "PLATFORM_MATURITY",
]
