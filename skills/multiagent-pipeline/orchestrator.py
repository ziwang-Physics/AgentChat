#!/usr/bin/env python3
"""
MultiAgent Pipeline — Browser Automation Tool.

Handles the two phases that require Playwright/Chrome:
  phase2  — concurrent dispatch to 4 web platforms
  phase4  — Gemini 3.1 Pro Extended Thinking final adjudication

Phases 1 & 3 are done by Claude Code itself (running on DeepSeek backend)
— no browser needed. This tool ONLY does the browser-heavy phases.

Usage:
  python3 orchestrator.py phase2 '{"chatgpt":"prompt...","claude":"...","kimi":"...","qianwen":"..."}'
  python3 orchestrator.py phase4 "matrix text" "task core summary"
"""

import asyncio, sys, time, json, logging, os

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [orch] %(message)s",
    datefmt="%H:%M:%S",
    stream=sys.stderr,
)
log = logging.getLogger("orchestrator")

from playwright.async_api import async_playwright
from adapters import (
    ChatGPTAdapter, ClaudeAdapter, KimiAdapter, QianwenAdapter, GeminiAdapter,
)

SHARED_CDP_PORT = "9222"
P2_DEFAULT_TIMEOUT = 60

# ── CDP Security (P0 fix 2026-06-28) ───────────────────────────────────────
_CDP_TOKEN = os.environ.get("CHROME_CDP_TOKEN", "")


def _cdp_url(port: str = "9222") -> str:
    """Build CDP endpoint URL. Appends ?token= if CHROME_CDP_TOKEN is set."""
    base = f"http://127.0.0.1:{port}"
    return f"{base}?token={_CDP_TOKEN}" if _CDP_TOKEN else base

P2_CLASSES = {
    "chatgpt": ChatGPTAdapter,
    "claude":  ClaudeAdapter,
    "kimi":    KimiAdapter,
    "qianwen": QianwenAdapter,
}


# ── Barrier (asyncio.Condition — atomic, abort-safe) ────────────────────────

class Barrier:
    """Thread-safe asyncio barrier with timeout and abort.
    Uses asyncio.Condition for atomic state transitions — no count+=1 races.
    Supports abort() to force-release all waiters on worker failure."""
    def __init__(self, n, timeout=30):
        self.n = n
        self.timeout = timeout
        self._count = 0
        self._aborted = False
        self._released = False
        self._cond = asyncio.Condition()

    async def wait(self) -> bool:
        """Wait for all N parties or timeout. Returns True if normal release,
        False if timeout or aborted."""
        async with self._cond:
            self._count += 1
            if self._count >= self.n:
                self._released = True
                self._cond.notify_all()

            try:
                await asyncio.wait_for(
                    self._cond.wait_for(lambda: self._released or self._aborted),
                    timeout=self.timeout,
                )
                return not self._aborted
            except asyncio.TimeoutError:
                pass

            # Timeout: abort and release all remaining waiters
            if not self._released and not self._aborted:
                self._aborted = True
                self._cond.notify_all()
            return False

    def abort(self):
        """Force-release all waiters. Safe to call from any context."""
        self._aborted = True
        self._released = True


# ── Helpers ──────────────────────────────────────────────────────────────────

async def _extract_partial_text(page, adapter) -> str:
    """Extract whatever response text exists right now."""
    try:
        text = await adapter.extract_response(page)
        if text and len(text) > 5:
            return text
    except Exception:
        pass
    try:
        text = await page.evaluate("() => document.body.innerText || ''")
        return text[:50000] if text else ""
    except Exception:
        return ""


# ── Phase 2 Worker ───────────────────────────────────────────────────────────

async def _p2_worker(adapter, prompt: str, barrier, results: dict,
                     timeout_s: int, shared_context) -> None:
    """Single Phase 2 worker. Per-platform prompt, hard timeout, never blocks."""
    name = adapter.name
    page = None
    try:
        page = await adapter.connect(context=shared_context)
        await adapter.ensure_fresh_conversation(page)
        await adapter.ensure_ready(page)

        await adapter.clear_input(page)
        await adapter.inject_prompt(page, prompt)
        log.info(f"[P2:{name}] Ready (waiting for barrier)")

        if barrier:
            ok = await barrier.wait()
            if not ok:
                log.warning(f"[P2:{name}] Barrier timeout — sending anyway (others may have failed)")
            else:
                log.info(f"[P2:{name}] Barrier released — SENDING")

        await adapter.trigger_send(page)

        truncated = False
        try:
            raw = await adapter.wait_response(page, timeout_ms=timeout_s * 1000)
        except asyncio.TimeoutError:
            log.warning(f"[P2:{name}] HARD TIMEOUT ({timeout_s}s)")
            raw = await _extract_partial_text(page, adapter)
            truncated = True

        cleaned = adapter.clean_response(raw, prompt)
        if truncated and cleaned:
            cleaned = f"[WARNING: NODE_TIMEOUT_TRUNCATED — {timeout_s}s截断]\n\n{cleaned}"

        is_valid, reason = adapter.validate_response(cleaned, prompt)

        # P2 leniency: UI_CHROME_DOMINANT still has usable content
        p2_ok = is_valid or (reason == "UI_CHROME_DOMINANT" and len(cleaned) > 200)

        results[name] = {
            "platform": name, "success": p2_ok,
            "response": cleaned, "length": len(cleaned),
            "timeout": truncated, "quality": reason,
        }
        status = "✅" if p2_ok else "❌"
        log.info(f"[P2:{name}] {status} {len(cleaned)} chars ({reason})")

    except Exception as e:
        log.error(f"[P2:{name}] EXCEPTION: {e}")
        if barrier:
            barrier.abort()  # release other stuck waiters
        partial = ""
        if page:
            try: partial = await _extract_partial_text(page, adapter)
            except Exception: pass
        results[name] = {
            "platform": name, "success": bool(partial and len(partial) > 20),
            "response": partial, "length": len(partial),
            "timeout": False, "error": str(e)[:200],
            "quality": "EXCEPTION_RECOVERED" if partial else "FATAL",
        }
    finally:
        if page:
            try: await adapter.cleanup()
            except Exception: pass


# ── Phase 2: Dispatch ────────────────────────────────────────────────────────

async def phase2_dispatch(prompts: dict, timeout_s: int = P2_DEFAULT_TIMEOUT) -> dict:
    """Send 4 different prompts to GPT/Claude/Kimi/Qianwen concurrently.
    Returns {results: [...], success_count: N, timeout_count: N}"""
    log.info(f"🟡 Phase 2: Dispatch — {len(prompts)} platforms")

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(_cdp_url(SHARED_CDP_PORT))
        context = browser.contexts[0]
        await context.grant_permissions(["clipboard-read", "clipboard-write"])

        selected = []
        for name, adapter_cls in P2_CLASSES.items():
            prompt = prompts.get(name, "")
            if not prompt or not prompt.strip():
                log.warning(f"[P2] No prompt for {name}, skipping")
                continue
            selected.append((adapter_cls(), prompt, name))

        if not selected:
            return {"success": False, "results": [], "error": "No valid prompts"}

        barrier = Barrier(len(selected))
        results: dict = {}

        tasks = [
            asyncio.create_task(
                _p2_worker(adapter, prompt, barrier, results, timeout_s, context)
            )
            for adapter, prompt, name in selected
        ]
        await asyncio.gather(*tasks)

        worker_list = []
        for adapter, prompt, name in selected:
            r = results.get(adapter.name, {})
            worker_list.append({
                "platform": name,
                "success": r.get("success", False),
                "response": r.get("response", ""),
                "length": r.get("length", 0),
                "timeout": r.get("timeout", False),
                "error": r.get("error", ""),
                "quality": r.get("quality", "unknown"),
            })

        success_count = sum(1 for w in worker_list if w["success"])
        timeout_count = sum(1 for w in worker_list if w.get("timeout"))
        log.info(f"[P2] Done: {success_count}/{len(worker_list)} success, {timeout_count} timeout(s)")

        return {
            "success": success_count > 0,
            "results": worker_list,
            "success_count": success_count,
            "timeout_count": timeout_count,
        }


# ── Phase 4: Adjudicate ──────────────────────────────────────────────────────

async def phase4_adjudicate(matrix: str, task_core: str) -> str:
    """Send compressed matrix to Gemini 3.1 Pro Extended Thinking."""
    log.info("🔴 Phase 4: Adjudicate — sending matrix to Gemini")
    gm = GeminiAdapter()

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(_cdp_url(SHARED_CDP_PORT))
        context = browser.contexts[0]
        page = await gm.connect(context=context)

        try:
            await gm.ensure_fresh_conversation(page)

            # Pro Extended — non-fatal
            try:
                await gm.ensure_pro_extended(page)
            except Exception as e:
                log.warning(f"[P4] Pro Extended unavailable: {e}")

            await gm.ensure_ready(page)

            prompt = (
                "你现在是拥有长链条推理能力的终审法官。请审视以下专家分析矩阵，给出最终裁决。\n\n"
                f"## 原始问题\n{task_core}\n\n"
                f"## 专家分析矩阵\n{matrix}\n\n"
                "请按以下结构输出：\n\n"
                "## 综合结论\n"
                "基于共识区和特色区，给出最可靠全面的回答。技术问题请输出可直接执行的方案。\n\n"
                "## 争议裁决\n"
                "逐条裁决冲突区。根据'生产环境零容错、高并发最优化'原则权衡。\n\n"
                "## 缝合方案\n"
                "将特色区的优化、基准参数、防坑逻辑整合进共识区核心方案。\n\n"
                "## 可信度评估\n"
                "评估可信度（高/中/低），标注需进一步验证的内容。\n\n"
                "## 补充说明\n"
                "未解决的问题、建议的后续行动。\n\n"
                "原则：优先共识、冲突必裁、技术细节不简化、信息不足时明确指出、用中文回答。"
            )

            await gm.clear_input(page)
            await gm.inject_prompt(page, prompt)
            await gm.trigger_send(page)

            raw = await gm.wait_response(page, timeout_ms=300_000)
            cleaned = gm.clean_response(raw, prompt)
            log.info(f"[P4] Final output: {len(cleaned)} chars")
            return cleaned

        finally:
            await gm.cleanup()


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  orchestrator.py phase2 '{\"chatgpt\":\"...\",\"claude\":\"...\",...}'", file=sys.stderr)
        print("  orchestrator.py phase2 --file prompts.json", file=sys.stderr)
        print("  orchestrator.py phase4 'matrix text' 'task core'", file=sys.stderr)
        print("  orchestrator.py phase4 --file matrix.md 'task core'", file=sys.stderr)
        print("\nOptions:", file=sys.stderr)
        print("  --timeout N          Phase 2 per-platform timeout (default: 60s)", file=sys.stderr)
        print("  --json               Output Phase 2 results as JSON", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "phase2":
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("phase2_cmd", nargs="?")
        parser.add_argument("prompts_json", nargs="?")
        parser.add_argument("--file", type=str, help="Read prompts from JSON file")
        parser.add_argument("--timeout", type=int, default=P2_DEFAULT_TIMEOUT)
        parser.add_argument("--json", action="store_true")
        args = parser.parse_args()

        if args.file:
            with open(args.file) as f:
                prompts = json.load(f)
        elif args.prompts_json:
            prompts = json.loads(args.prompts_json)
        elif not sys.stdin.isatty():
            prompts = json.loads(sys.stdin.read())
        else:
            print("ERROR: No prompts provided", file=sys.stderr)
            sys.exit(1)

        # Support nested {"worker_prompts": {...}} format from Phase 1
        if "worker_prompts" in prompts and isinstance(prompts["worker_prompts"], dict):
            prompts = prompts["worker_prompts"]

        result = asyncio.run(phase2_dispatch(prompts, args.timeout))
        if args.json:
            print(json.dumps(result, ensure_ascii=False, indent=2))
        else:
            for r in result.get("results", []):
                status = "✅" if r["success"] else "❌"
                print(f"\n{'='*60}")
                print(f"  {r['platform']} {status} ({r['length']} chars)")
                if r.get("timeout"):
                    print(f"  [TIMEOUT]")
                if r.get("error"):
                    print(f"  Error: {r['error']}")
                print(f"{'='*60}")
                print(r["response"][:5000])

    elif cmd == "phase4":
        import argparse
        parser = argparse.ArgumentParser()
        parser.add_argument("phase4_cmd", nargs="?")
        parser.add_argument("matrix", nargs="?")
        parser.add_argument("--file", type=str, help="Read matrix from file")
        parser.add_argument("--task-core", type=str, default="Task",
                            help="Task core summary for Gemini")
        args, unknown = parser.parse_known_args()

        if args.file:
            with open(args.file) as f:
                matrix = f.read()
            task_core = args.task_core
        elif args.matrix:
            matrix = args.matrix
            task_core = args.task_core
        elif not sys.stdin.isatty():
            matrix = sys.stdin.read()
            task_core = "Task"
        else:
            print("ERROR: No matrix provided", file=sys.stderr)
            sys.exit(1)

        final = asyncio.run(phase4_adjudicate(matrix, task_core))
        print(final)

    else:
        print(f"Unknown command: {cmd}", file=sys.stderr)
        print("Use 'phase2' or 'phase4'", file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
