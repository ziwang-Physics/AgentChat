#!/usr/bin/env python3
"""
MultiAgent Concurrent Chat — 6-Platform Master Controller.

Sends the same prompt to up to 6 AI chat platforms simultaneously:
  Gemini, ChatGPT, Claude, Kimi (Moonshot), Qianwen (Alibaba), DeepSeek

All platforms share ONE Chrome window (CDP port 9222) via browser.contexts[0].
Each platform opens as a TAB in the existing window — no separate windows.
Barrier synchronization ensures truly simultaneous sends (<10ms delta).

Usage:
  python3 main.py "Your prompt"
  python3 main.py --adapters gemini,chatgpt,kimi "Your prompt"
  python3 main.py --no-barrier "Your prompt"       # sequential (debug)
  python3 main.py --json "Your prompt"             # JSON output
  python3 main.py --timeout 300 "Your prompt"      # custom timeout

Architecture:
  Master (main.py) creates ONE shared BrowserContext
   ├─ GeminiAdapter   → tab → gemini.google.com
   ├─ ChatGPTAdapter  → tab → chatgpt.com
   ├─ ClaudeAdapter   → tab → claude.ai
   ├─ KimiAdapter     → tab → kimi.com
   ├─ QianwenAdapter  → tab → qianwen.com
   └─ DeepSeekAdapter → tab → chat.deepseek.com  (Expert + Deep Think)
        │
        └─ Barrier(6) → ALL SEND SIMULTANEOUSLY
"""

import asyncio, sys, time, json, logging, os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [master] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stderr,
)
log = logging.getLogger("master")

from playwright.async_api import async_playwright
from adapters import ADAPTER_REGISTRY, PLATFORM_MATURITY, GeminiAdapter, DeepSeekAdapter

DEFAULT_TIMEOUT = 300  # seconds per platform
MAX_RESPONSE_DISPLAY = 8000  # chars per response in text mode

# Shared Chrome port — all platforms use the same browser for login sharing
SHARED_CDP_PORT = "9222"

# ── CDP Security (P0 fix 2026-06-28) ───────────────────────────────────────
_CDP_TOKEN = os.environ.get("CHROME_CDP_TOKEN", "")


def _cdp_url(port: str = "9222") -> str:
    base = f"http://127.0.0.1:{port}"
    return f"{base}?token={_CDP_TOKEN}" if _CDP_TOKEN else base


class Barrier:
    """Thread-safe asyncio Barrier using asyncio.Condition (Python < 3.11 compat).
    Fixed: count+=1 is now atomic under Condition lock."""
    def __init__(self, n):
        self.n = n
        self._count = 0
        self._released = False
        self._cond = asyncio.Condition()

    async def wait(self):
        async with self._cond:
            self._count += 1
            if self._count >= self.n:
                self._released = True
                self._cond.notify_all()
            await self._cond.wait_for(lambda: self._released)


async def worker(adapter, prompt, barrier, results, timeout_s, shared_context):
    """Single adapter worker: connect → prepare → barrier → send → receive.
    Uses shared_context so all platforms open as TABS in one Chrome window."""
    name = adapter.name
    try:
        # ── Connect via shared context (one tab per platform) ──
        page = await adapter.connect(context=shared_context)

        # ── Fresh conversation (prevents old history bleed) ──
        await adapter.ensure_fresh_conversation(page)

        # ── Platform-specific init ──
        if isinstance(adapter, GeminiAdapter):
            await adapter.ensure_pro_extended(page)

        if isinstance(adapter, DeepSeekAdapter):
            await adapter.ensure_expert_mode(page)
            await adapter.ensure_deep_think(page)
            await adapter.ensure_smart_search(page)

        await adapter.ensure_ready(page)

        # ── Prepare: fill text, DON'T send ──
        await adapter.clear_input(page)
        await adapter.inject_prompt(page, prompt)
        log.info(f"[{name}] Ready (waiting for barrier)")

        # ── Barrier sync ──
        if barrier:
            await barrier.wait()
            log.info(f"[{name}] Barrier released — SENDING")

        # ── Send ──
        await adapter.trigger_send(page)

        # ── Receive ──
        raw_response = await adapter.wait_response(page, timeout_ms=timeout_s * 1000)
        cleaned = adapter.clean_response(raw_response, prompt)

        # ── Validate: is this a real answer or garbage? ──
        is_valid, reason = adapter.validate_response(cleaned, prompt)

        results[name] = {
            "platform": name,
            "success": is_valid,
            "response": cleaned if is_valid else "",
            "raw_response": raw_response,
            "length": len(cleaned),
            "raw_length": len(raw_response),
            "quality": reason,
        }
        if is_valid:
            log.info(f"[{name}] Complete — {len(cleaned)} chars ✅")
        else:
            log.warning(f"[{name}] REJECTED: {reason} — {len(cleaned)} chars discarded")

        # Close tab (context stays alive for other platforms)
        await adapter.cleanup()

    except asyncio.TimeoutError:
        log.error(f"[{name}] TIMEOUT after {timeout_s}s")
        results[name] = {"platform": name, "success": False, "error": "TIMEOUT", "response": ""}
        await adapter.cleanup()
    except Exception as e:
        log.error(f"[{name}] FAILED: {e}")
        results[name] = {"platform": name, "success": False, "error": str(e), "response": ""}
        await adapter.cleanup()


async def main():
    import argparse
    parser = argparse.ArgumentParser(description="MultiAgent Concurrent Chat — 6 platforms")
    parser.add_argument("prompt", nargs="?", help="Prompt to send to all platforms")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT,
                        help="Timeout per platform (seconds)")
    parser.add_argument("--adapters", type=str,
                        default="gemini,chatgpt,claude,kimi,qianwen,deepseek",
                        help="Comma-separated: gemini,chatgpt,claude,kimi,qianwen,deepseek")
    parser.add_argument("--no-barrier", action="store_true",
                        help="Send without barrier sync (sequential debug)")
    parser.add_argument("--json", action="store_true",
                        help="Output results as JSON")
    parser.add_argument("--maturity", action="store_true",
                        help="Show platform maturity levels and exit")
    parser.add_argument("--synthesize", action="store_true",
                        help="Output synthesis-ready clean JSON for Claude meta-judge")
    args = parser.parse_args()

    if args.maturity:
        print("Platform Maturity Levels:")
        for name, maturity in PLATFORM_MATURITY.items():
            print(f"  {name:10s}  {maturity}")
        return

    # Read prompt
    prompt = args.prompt
    if not prompt:
        if not sys.stdin.isatty():
            prompt = sys.stdin.read().strip()
        if not prompt:
            print("Usage: python3 main.py [--timeout N] [--adapters ...] 'your prompt'", file=sys.stderr)
            print("       python3 main.py --maturity", file=sys.stderr)
            sys.exit(1)

    # Parse adapter list
    adapter_names = [a.strip().lower() for a in args.adapters.split(",")]
    selected = []
    for name in adapter_names:
        if name in ADAPTER_REGISTRY:
            selected.append(ADAPTER_REGISTRY[name](cdp_port=SHARED_CDP_PORT))
        else:
            log.warning(f"Unknown adapter: {name} (available: {','.join(ADAPTER_REGISTRY.keys())})")

    if not selected:
        log.error("No valid adapters selected")
        sys.exit(1)

    log.info(f"MultiAgent: {len(selected)} platforms | prompt={len(prompt)} chars")
    log.info(f"Barrier: {'OFF' if args.no_barrier else f'ON (Barrier({len(selected)}) simultaneous send)'}")
    for adp in selected:
        log.info(f"  {adp.name:10s} → {adp.URL}")

    # ── Execute ──
    # Create ONE shared browser context: all platforms open as TABS
    # in the existing Chrome window (CDP port 9222), not separate windows.
    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(_cdp_url(SHARED_CDP_PORT))
        # Use the default context (= existing Chrome window with Gemini tab)
        shared_context = browser.contexts[0]
        await shared_context.grant_permissions(["clipboard-read", "clipboard-write"])
        log.info(f"Shared context: {len(browser.contexts)} context(s), "
                 f"{len(shared_context.pages)} existing page(s)")

        barrier = None if args.no_barrier else Barrier(len(selected))
        results = {}
        start_time = time.time()

        tasks = [asyncio.create_task(
            worker(adp, prompt, barrier, results, args.timeout, shared_context))
                 for adp in selected]
        await asyncio.gather(*tasks)

        # Keep shared context alive — tabs were closed by worker cleanup()
        log.info(f"Shared context kept alive — {len(shared_context.pages)} tabs remain")

        elapsed = time.time() - start_time

    # ── Output ──
    log.info(f"All done in {elapsed:.0f}s")

    successes = sum(1 for r in results.values() if r.get("success"))

    if args.json or args.synthesize:
        # Build synthesis-ready output
        output = {
            "question": prompt,
            "platforms_queried": len(selected),
            "success_count": successes,
            "elapsed_seconds": round(elapsed, 1),
            "responses": {}
        }
        for adp in selected:
            r = results.get(adp.name, {})
            if r.get("success"):
                output["responses"][adp.name] = {
                    "platform": adp.name,
                    "success": True,
                    "answer": r["response"],
                    "length": r["length"],
                }
            else:
                output["responses"][adp.name] = {
                    "platform": adp.name,
                    "success": False,
                    "error": r.get("quality", r.get("error", "unknown")),
                    "raw_preview": (r.get("raw_response", "") or r.get("response", ""))[:200],
                }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        for adp in selected:
            r = results.get(adp.name, {})
            if r.get("success"):
                text = r["response"]
                if len(text) > MAX_RESPONSE_DISPLAY:
                    text = text[:MAX_RESPONSE_DISPLAY] + f"\n... [truncated, {r['length']} total chars]"
                print(f"\n{'='*70}")
                print(f"  {r['platform']} ({r['length']} chars)")
                print(f"{'='*70}")
                print(text)
            else:
                print(f"\n{'='*70}")
                print(f"  {r.get('platform', adp.name)} ❌ FAILED: {r.get('error', 'unknown')}")
                print(f"{'='*70}")

    # Summary
    log.info(f"Summary: {successes}/{len(selected)} succeeded in {elapsed:.0f}s")
    for adp in selected:
        r = results.get(adp.name, {})
        status = f"✅ {r.get('length', 0)} chars" if r.get("success") else f"❌ {r.get('error', 'unknown')[:60]}"
        log.info(f"  {adp.name:10s} {status}")

    return results


if __name__ == "__main__":
    asyncio.run(main())
