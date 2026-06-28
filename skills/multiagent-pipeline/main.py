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
        └─ AbortableBarrier(6) → ALL SEND SIMULTANEOUSLY
"""

import argparse, asyncio, json, logging, os, sys, time

from playwright.async_api import async_playwright

from common import (
    cdp_url, AbortableBarrier, setup_logging,
)
from adapters import (
    ADAPTER_REGISTRY, PLATFORM_MATURITY, GeminiAdapter, DeepSeekAdapter,
    BaseAdapter,
)

log = setup_logging("master")

DEFAULT_TIMEOUT = 300      # seconds per platform
MAX_RESPONSE_DISPLAY = 8000  # chars per response in text mode
SHARED_CDP_PORT = "9222"


async def worker(adapter, prompt: str, barrier, results: dict,
                 timeout_s: int, shared_context) -> None:
    """Single adapter worker: connect → prepare → barrier → send → receive."""
    name = adapter.name
    page = None
    try:
        page = await adapter.connect(context=shared_context)
        await adapter.ensure_fresh_conversation(page)

        # Platform-specific init
        if isinstance(adapter, GeminiAdapter):
            await adapter.ensure_pro_extended(page)
        if isinstance(adapter, DeepSeekAdapter):
            await adapter.ensure_expert_mode(page)
            await adapter.ensure_deep_think(page)
            await adapter.ensure_smart_search(page)

        await adapter.ensure_ready(page)

        await adapter.clear_input(page)
        await adapter.inject_prompt(page, prompt)
        log.info("[%s] Ready (waiting for barrier)", name)

        if barrier:
            ok = await barrier.wait()
            if not ok:
                log.warning("[%s] Barrier timeout — sending anyway", name)
            else:
                log.info("[%s] Barrier released — SENDING", name)

        await adapter.trigger_send(page)

        raw_response = await adapter.wait_response(
            page, timeout_ms=timeout_s * 1000
        )
        cleaned = adapter.clean_response(raw_response, prompt)

        is_valid, reason = adapter.validate_response(cleaned, prompt)
        p2_ok = BaseAdapter.is_pipeline_usable(is_valid, reason, len(cleaned))

        results[name] = {
            "platform": name,
            "success": p2_ok,
            "response": cleaned if p2_ok else "",
            "raw_response": raw_response,
            "length": len(cleaned),
            "raw_length": len(raw_response),
            "quality": reason,
        }
        if p2_ok:
            log.info("[%s] Complete — %d chars ✅", name, len(cleaned))
        else:
            log.warning("[%s] REJECTED: %s — %d chars discarded",
                        name, reason, len(cleaned))

    except asyncio.TimeoutError:
        log.error("[%s] TIMEOUT after %ds", name, timeout_s)
        results[name] = {
            "platform": name, "success": False,
            "error": "TIMEOUT", "response": "",
        }
        if barrier:
            await barrier.abort()
    except Exception as e:
        log.error("[%s] FAILED: %s", name, e)
        results[name] = {
            "platform": name, "success": False,
            "error": str(e), "response": "",
        }
        if barrier:
            await barrier.abort()
    finally:
        await adapter.cleanup()


async def main():
    parser = argparse.ArgumentParser(
        description="MultiAgent Concurrent Chat — up to 7 platforms"
    )
    parser.add_argument("prompt", nargs="?")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT)
    parser.add_argument(
        "--adapters", type=str,
        default="gemini,chatgpt,claude,kimi,qianwen,deepseek",
    )
    parser.add_argument("--no-barrier", action="store_true")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("--maturity", action="store_true")
    parser.add_argument("--synthesize", action="store_true")
    args = parser.parse_args()

    if args.maturity:
        print("Platform Maturity Levels:")
        for name, maturity in PLATFORM_MATURITY.items():
            print(f"  {name:10s}  {maturity}")
        return

    prompt = args.prompt
    if not prompt:
        if not sys.stdin.isatty():
            prompt = sys.stdin.read().strip()
        if not prompt:
            print("Usage: python3 main.py [--timeout N] [--adapters ...] "
                  "'your prompt'", file=sys.stderr)
            print("       python3 main.py --maturity", file=sys.stderr)
            sys.exit(1)

    adapter_names = [a.strip().lower() for a in args.adapters.split(",")]
    selected = []
    for name in adapter_names:
        if name in ADAPTER_REGISTRY:
            selected.append(ADAPTER_REGISTRY[name](cdp_port=SHARED_CDP_PORT))
        else:
            log.warning("Unknown adapter: %s (available: %s)",
                        name, ",".join(ADAPTER_REGISTRY.keys()))

    if not selected:
        log.error("No valid adapters selected")
        sys.exit(1)

    log.info("MultiAgent: %d platforms | prompt=%d chars", len(selected), len(prompt))
    log.info("Barrier: %s",
             "OFF" if args.no_barrier
             else f"ON (AbortableBarrier({len(selected)}) simultaneous send)")
    for adp in selected:
        log.info("  %-10s → %s", adp.name, adp.URL)

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(cdp_url(SHARED_CDP_PORT))
        shared_context = browser.contexts[0]
        await shared_context.grant_permissions(["clipboard-read", "clipboard-write"])
        log.info("Shared context: %d context(s), %d existing page(s)",
                 len(browser.contexts), len(shared_context.pages))

        barrier = None if args.no_barrier else AbortableBarrier(
            len(selected), timeout=60
        )
        results = {}
        start_time = time.time()

        tasks = [
            asyncio.create_task(
                worker(adp, prompt, barrier, results, args.timeout, shared_context)
            )
            for adp in selected
        ]
        await asyncio.gather(*tasks)

        log.info("Shared context kept alive — %d tabs remain",
                 len(shared_context.pages))
        elapsed = time.time() - start_time

    log.info("All done in %.0fs", elapsed)
    successes = sum(1 for r in results.values() if r.get("success"))

    if args.json or args.synthesize:
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
                    "platform": adp.name, "success": True,
                    "answer": r["response"], "length": r["length"],
                }
            else:
                output["responses"][adp.name] = {
                    "platform": adp.name, "success": False,
                    "error": r.get("quality", r.get("error", "unknown")),
                    "raw_preview": (
                        r.get("raw_response", "") or r.get("response", "")
                    )[:200],
                }
        print(json.dumps(output, ensure_ascii=False, indent=2))
    else:
        for adp in selected:
            r = results.get(adp.name, {})
            if r.get("success"):
                text = r["response"]
                if len(text) > MAX_RESPONSE_DISPLAY:
                    text = (
                        text[:MAX_RESPONSE_DISPLAY]
                        + f"\n... [truncated, {r['length']} total chars]"
                    )
                print(f"\n{'='*70}")
                print(f"  {r['platform']} ({r['length']} chars)")
                print(f"{'='*70}")
                print(text)
            else:
                print(f"\n{'='*70}")
                print(f"  {r.get('platform', adp.name)} ❌ FAILED: "
                      f"{r.get('error', 'unknown')}")
                print(f"{'='*70}")

    log.info("Summary: %d/%d succeeded in %.0fs",
             successes, len(selected), elapsed)
    for adp in selected:
        r = results.get(adp.name, {})
        status = (f"✅ {r.get('length', 0)} chars" if r.get("success")
                  else f"❌ {r.get('error', 'unknown')[:60]}")
        log.info("  %-10s %s", adp.name, status)

    return results


if __name__ == "__main__":
    asyncio.run(main())
