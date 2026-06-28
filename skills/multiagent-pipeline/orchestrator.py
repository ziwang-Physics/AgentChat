#!/usr/bin/env python3
"""
MultiAgent Pipeline — Browser Automation + API Orchestrator.

Handles the three phases that require external execution:
  phase2  — concurrent dispatch to 5 web platforms (incl. Gemini Pro Extended)
  phase4  — DeepSeek V4 Pro API final adjudication (no browser, direct API)

Phases 1 & 3 are done by Claude Code itself (running on DeepSeek backend)
— no browser needed. This tool ONLY does the browser-heavy + API phases.

Usage:
  python3 orchestrator.py phase2 --file prompts.json --json
  python3 orchestrator.py phase4 --file matrix.md --prompts-file prompts.json
"""

import argparse, asyncio, json, logging, os, sys, time
from urllib.request import Request, urlopen
from urllib.error import URLError, HTTPError

from playwright.async_api import async_playwright

from common import (
    cdp_url, setup_logging, PAGE_LOAD_WAIT_MS, SPA_WAKE_WAIT_MS,
)
from adapters import (
    ChatGPTAdapter, ClaudeAdapter, KimiAdapter, QianwenAdapter, GeminiAdapter,
    BaseAdapter,
)

log = setup_logging("orchestrator")

SHARED_CDP_PORT = "9222"
P2_DEFAULT_TIMEOUT = 60

P2_CLASSES = {
    "chatgpt": ChatGPTAdapter,
    "kimi":    KimiAdapter,
    "gemini":  GeminiAdapter,
}
# ClaudeAdapter + QianwenAdapter kept as spares — see SKILL.md #20
_P2_SPARE = {
    "claude":  ClaudeAdapter,
    "qianwen": QianwenAdapter,
}

# ── DeepSeek API configuration (P4 adjudicator) ──────────────────────────
DEEPSEEK_API_KEY = os.environ.get("DEEPSEEK_API_KEY", "")
DEEPSEEK_API_URL = "https://api.deepseek.com/anthropic/v1/messages"
DEEPSEEK_MODEL = "deepseek-v4-pro"
DEEPSEEK_MAX_TOKENS = 4096
DEEPSEEK_TIMEOUT_S = 120  # API HTTP timeout (not reasoning timeout)


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
        text = await page.evaluate("() => document.body.textContent || document.body.innerText || ''")
        return text[:50000] if text else ""
    except Exception:
        return ""


# ── Phase 2 Worker (P1: fire-and-collect — no Barrier) ───────────────────

async def _p2_worker(adapter, prompt: str, results: dict,
                     timeout_s: int, shared_context) -> None:
    """Single Phase 2 worker.  Fires independently — no Barrier sync point.

    P1 change: each worker sends as soon as its page is ready, eliminating
    the artificial Barrier sync that amplified tail latency.  Workers that
    finish preparation faster start generating sooner.
    """
    name = adapter.name
    page = None
    try:
        page = await adapter.connect(context=shared_context)
        await adapter.ensure_fresh_conversation(page)

        # Enable deep-thinking mode (no-op on most platforms, toggle on Qianwen)
        try:
            await adapter.ensure_thinking_mode(page)
        except Exception as e:
            log.warning("[P2:%s] Thinking mode toggle failed (non-fatal): %s", name, e)

        await adapter.ensure_ready(page)

        await adapter.clear_input(page)
        await adapter.inject_prompt(page, prompt)
        log.info("[P2:%s] Ready — SENDING (fire-and-collect)", name)

        # P1: fire immediately — no barrier wait
        await adapter.trigger_send(page)

        truncated = False
        try:
            raw = await adapter.wait_response(page, timeout_ms=timeout_s * 1000)
        except asyncio.TimeoutError:
            log.warning("[P2:%s] HARD TIMEOUT (%ds)", name, timeout_s)
            raw = await _extract_partial_text(page, adapter)
            truncated = True

        cleaned = adapter.clean_response(raw, prompt)
        if truncated and cleaned:
            cleaned = (
                f"[WARNING: NODE_TIMEOUT_TRUNCATED — {timeout_s}s截断]\n\n{cleaned}"
            )

        is_valid, reason = adapter.validate_response(cleaned, prompt)
        p2_ok = BaseAdapter.is_pipeline_usable(is_valid, reason, len(cleaned))

        results[name] = {
            "platform": name, "success": p2_ok,
            "response": cleaned, "length": len(cleaned),
            "timeout": truncated, "quality": reason,
        }
        status = "✅" if p2_ok else "❌"
        log.info("[P2:%s] %s %d chars (%s)", name, status, len(cleaned), reason)

    except Exception as e:
        log.error("[P2:%s] EXCEPTION: %s", name, e)
        partial = ""
        if page:
            try:
                partial = await _extract_partial_text(page, adapter)
            except Exception:
                pass
        results[name] = {
            "platform": name,
            "success": bool(partial and len(partial) > 20),
            "response": partial, "length": len(partial),
            "timeout": False, "error": str(e)[:200],
            "quality": "EXCEPTION_RECOVERED" if partial else "FATAL",
        }
    finally:
        if page:
            try:
                await adapter.cleanup()
            except Exception:
                pass


# ── Phase 2: Dispatch (P1: fire-and-collect) ─────────────────────────────

async def phase2_dispatch(prompts: dict,
                          timeout_s: int = P2_DEFAULT_TIMEOUT) -> dict:
    """Send prompts to GPT/Claude/Kimi/Qianwen/Gemini concurrently (5 platforms).

    P1 change: fire-and-collect replaces Barrier.  Each worker sends as soon
    as its page is ready — no artificial sync point.  Uses asyncio.wait() with
    per-task timeouts (Python 3.10 compatible, no TaskGroup needed).

    Returns {results: [...], success_count: N, timeout_count: N}.
    """
    log.info("🟡 Phase 2: Dispatch (fire-and-collect) — %d platforms", len(prompts))

    async with async_playwright() as pw:
        browser = await pw.chromium.connect_over_cdp(cdp_url(SHARED_CDP_PORT))
        context = browser.contexts[0]
        await context.grant_permissions(["clipboard-read", "clipboard-write"])

        selected = []
        for name, adapter_cls in P2_CLASSES.items():
            prompt_text = prompts.get(name, "")
            if not prompt_text or not prompt_text.strip():
                log.warning("[P2] No prompt for %s, skipping", name)
                continue
            selected.append((adapter_cls(), prompt_text, name))

        if not selected:
            return {"success": False, "results": [], "error": "No valid prompts"}

        results: dict = {}

        # P1: fire-and-collect — each worker fires independently
        tasks = {
            name: asyncio.create_task(
                _p2_worker(adapter, prompt, results, timeout_s, context)
            )
            for adapter, prompt, name in selected
        }

        # Wait for all to complete (or first exception)
        done, pending = await asyncio.wait(
            tasks.values(),
            timeout=timeout_s + 30,  # global deadline: worker timeout + buffer
            return_when=asyncio.ALL_COMPLETED,
        )

        # Cancel any stragglers
        for t in pending:
            t.cancel()
        # Absorb CancelledError from cancelled tasks
        for t in pending:
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass

        worker_list = []
        for adapter, _prompt, name in selected:
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
        log.info("[P2] Done: %d/%d success, %d timeout(s)",
                 success_count, len(worker_list), timeout_count)

        return {
            "success": success_count > 0,
            "results": worker_list,
            "success_count": success_count,
            "timeout_count": timeout_count,
        }


# ── Phase 4: Adjudicate (DeepSeek V4 Pro API) ──────────────────────────────

async def phase4_adjudicate(matrix: str, task_core: str) -> str:
    """Send compressed matrix to DeepSeek V4 Pro API for final adjudication.

    Replaces the previous Gemini Web CDP path (2026-06-28) with a direct API
    call — zero DOM dependency, zero automation failure risk, second-level
    latency.  Uses the Anthropic-compatible Messages endpoint.

    Returns the adjudication text, or empty string on failure.
    """
    log.info("🔴 Phase 4: Adjudicate — sending matrix to DeepSeek V4 Pro API")

    if not DEEPSEEK_API_KEY:
        log.error("[P4] DEEPSEEK_API_KEY not set — cannot adjudicate")
        return ""

    prompt = (
        "你现在是拥有长链条推理能力的终审法官。"
        "请审视以下专家分析矩阵，给出最终裁决。\n\n"
        f"## 原始问题\n{task_core}\n\n"
        f"## 专家分析矩阵\n{matrix}\n\n"
        "请按以下结构输出：\n\n"
        "## 综合结论\n"
        "基于共识区和特色区，给出最可靠全面的回答。"
        "技术问题请输出可直接执行的方案。\n\n"
        "## 争议裁决\n"
        "逐条裁决冲突区。"
        "权衡原则：可靠性优先、证据驱动、不确定性明确指出。\n\n"
        "## 缝合方案\n"
        "将特色区的优化、基准参数、防坑逻辑整合进共识区核心方案。\n\n"
        "## 可信度评估\n"
        "评估可信度（高/中/低），标注需进一步验证的内容。\n\n"
        "## 补充说明\n"
        "未解决的问题、建议的后续行动。\n\n"
        "原则：优先共识、冲突必裁、技术细节不简化、"
        "信息不足时明确指出、用中文回答。"
    )

    body = json.dumps({
        "model": DEEPSEEK_MODEL,
        "max_tokens": DEEPSEEK_MAX_TOKENS,
        "messages": [{"role": "user", "content": prompt}],
    }).encode("utf-8")

    req = Request(DEEPSEEK_API_URL, data=body, method="POST")
    req.add_header("Content-Type", "application/json")
    req.add_header("x-api-key", DEEPSEEK_API_KEY)
    req.add_header("anthropic-version", "2023-06-01")

    try:
        resp = urlopen(req, timeout=DEEPSEEK_TIMEOUT_S)
        raw = resp.read().decode("utf-8")
        data = json.loads(raw)

        # Anthropic Messages format: content is a list of blocks
        content_blocks = data.get("content", [])
        text = "".join(
            block.get("text", "") for block in content_blocks
            if block.get("type") == "text"
        )

        # Fallback: try OpenAI-compatible format (choices[0].message.content)
        if not text and "choices" in data:
            text = data["choices"][0].get("message", {}).get("content", "")

        if text:
            log.info("[P4] DeepSeek API returned %d chars", len(text))
            return text.strip()
        else:
            log.warning("[P4] DeepSeek API returned empty content")
            return ""

    except HTTPError as e:
        body_snippet = ""
        try:
            body_snippet = e.read().decode("utf-8", errors="replace")[:300]
        except Exception:
            pass
        log.error("[P4] DeepSeek API HTTP %d: %s", e.code, body_snippet)
        return ""
    except URLError as e:
        log.error("[P4] DeepSeek API connection failed: %s", e.reason)
        return ""
    except Exception as e:
        log.error("[P4] DeepSeek API unexpected error: %s", e)
        return ""


# ── CLI ──────────────────────────────────────────────────────────────────────

def main():
    if len(sys.argv) < 2:
        print("Usage:", file=sys.stderr)
        print("  orchestrator.py phase2 --file prompts.json --json", file=sys.stderr)
        print("  orchestrator.py phase4 --file matrix.md --prompts-file prompts.json",
              file=sys.stderr)
        print("\nOptions:", file=sys.stderr)
        print("  --timeout N    Phase 2 per-platform timeout (default: 60s)",
              file=sys.stderr)
        print("  --json         Output Phase 2 results as JSON", file=sys.stderr)
        sys.exit(1)

    cmd = sys.argv[1]

    if cmd == "phase2":
        parser = argparse.ArgumentParser()
        parser.add_argument("phase2_cmd", nargs="?")
        parser.add_argument("prompts_json", nargs="?")
        parser.add_argument("--file", type=str)
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
        if "worker_prompts" in prompts and isinstance(
            prompts["worker_prompts"], dict
        ):
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
                    print("  [TIMEOUT]")
                if r.get("error"):
                    print(f"  Error: {r['error']}")
                print(f"{'='*60}")
                print(r["response"][:5000])

    elif cmd == "phase4":
        parser = argparse.ArgumentParser()
        parser.add_argument("phase4_cmd", nargs="?")
        parser.add_argument("matrix", nargs="?")
        parser.add_argument("--file", type=str, help="Read matrix from file")
        parser.add_argument("--task-core", type=str, default="Task",
                            help="Task summary for Gemini (deprecated: use"
                                 " --prompts-file for secure auto-extraction)")
        parser.add_argument("--prompts-file", type=str,
                            help="Read task_core from Phase 1 prompts JSON"
                                 " (P0 fix: avoids shell command substitution)")
        args, _unknown = parser.parse_known_args()

        # ── P0 fix: auto-extract task_core from prompts file (no shell) ──
        task_core = args.task_core  # default fallback
        if args.prompts_file:
            try:
                with open(args.prompts_file) as f:
                    prompts_data = json.load(f)
                extracted = prompts_data.get("task_core", "")
                if extracted and extracted != "Task":
                    task_core = extracted
                # Also accept nested format from Phase 1
                if "worker_prompts" in prompts_data:
                    extracted2 = prompts_data.get("task_core", "")
                    if extracted2 and extracted2 != "Task":
                        task_core = extracted2
            except Exception as e:
                log.warning("[CLI] prompts-file read failed: %s — using default", e)

        if args.file:
            with open(args.file) as f:
                matrix = f.read()
        elif args.matrix:
            matrix = args.matrix
        elif not sys.stdin.isatty():
            matrix = sys.stdin.read()
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
