"""
GeminiSession — AgentChat WebExtended 的 Python 异步接口。

通过 subprocess 调用 AgentChat-WebExtended CLI，管理 CDP 连接、
tab 生命周期、降级链。

使用示例:
    async with GeminiSession() as gs:
        result = await gs.ask("分析因子暴露")
        result2 = await gs.ask("继续分析风险")  # 复用 tab
"""

import asyncio
import os
import re
import json
from pathlib import Path
from typing import Optional

from .result import AskResult


class GeminiSession:
    """Gemini Web Extended Thinking 会话管理器（异步）"""

    def __init__(
        self,
        cdp_port: int = 9222,
        locale: Optional[str] = None,
        timeout_ms: int = 600_000,
        provider_timeout_ms: int = 180_000,
        start_from: str = "gemini",
        keep_tabs: bool = True,
    ):
        """
        Args:
            cdp_port: Chrome CDP 端口，默认 9222
            locale: 'zh_CN' | 'zh_TW' | 'en' | 'ja' | None（自动检测）
            timeout_ms: 总超时（毫秒）
            provider_timeout_ms: 单 Provider 超时（毫秒）
            start_from: 起始 Provider（gemini / chatgpt / claude / ...）
            keep_tabs: 是否保留 tab（多轮对话设为 True）
        """
        self._cdp_port = cdp_port
        self._locale = locale
        self._timeout_ms = timeout_ms
        self._provider_timeout_ms = provider_timeout_ms
        self._start_from = start_from
        self._keep_tabs = keep_tabs
        self._project_dir = self._find_project_dir()
        self._node_exe = self._find_node()
        self._index_js = os.path.join(
            self._project_dir,
            "skills", "AgentChat-WebExtended", "index.js"
        )

    # ── 核心 API ──────────────────────────────────────────────────────────

    async def ask(self, prompt: str) -> AskResult:
        """发送 prompt，等待完整响应。

        Args:
            prompt: 要发送的问题文本

        Returns:
            AskResult 包含响应文本、使用的 Provider、耗时等
        """
        args = [
            self._node_exe,
            self._index_js,
            f"--timeout={self._timeout_ms}",
            f"--timeout-per-provider={self._provider_timeout_ms}",
            f"--from={self._start_from}",
        ]
        if self._keep_tabs:
            args.append("--keep-tabs")
        if self._locale:
            args.append(f"--locale={self._locale}")

        return await self._run(args, prompt)

    async def chat(self, prompt: str) -> AskResult:
        """多轮对话：复用已有 tab（保留上下文）。

        第一次调用创建新 tab，后续调用在同一 tab 中继续对话。
        """
        return await self.ask(prompt)  # --keep-tabs 已开启，tab 会被复用

    async def ask_structured(self, prompt: str, schema: type) -> any:
        """发送 prompt，返回 Pydantic 验证的结构化对象。

        自动在 prompt 末尾注入 JSON schema 指令，提取响应中的 JSON，
        用 Pydantic 验证。格式不对则重试（最多 3 次）。

        Args:
            prompt: 问题文本
            schema: Pydantic BaseModel 子类

        Returns:
            验证通过的 Pydantic 实例

        Raises:
            ValidationError: 3 次重试后仍无法解析
        """
        from .structured import ask_structured
        return await ask_structured(self, prompt, schema)

    async def ask_with_image(
        self, prompt: str, image_path: str
    ) -> AskResult:
        """发送文本 + 图片到 Gemini（多模态分析）。

        通过 CDP 模拟拖拽操作，将图片上传到 Gemini 输入框。
        需要 Playwright Python 包（pip install playwright）。

        Args:
            prompt: 文本问题
            image_path: 图片文件路径（PNG/JPG）

        Returns:
            AskResult
        """
        from .multimodal import ask_with_image
        return await ask_with_image(self, prompt, image_path)

    async def batch(
        self, prompts: list[str], max_concurrency: int = 4
    ) -> list[AskResult]:
        """批量推理（并行 tab）。

        每个 prompt 创建独立 tab，并发执行。

        Args:
            prompts: 问题列表
            max_concurrency: 最大并发数

        Returns:
            结果列表（与 prompts 一一对应）
        """
        semaphore = asyncio.Semaphore(max_concurrency)

        async def _one(prompt):
            async with semaphore:
                return await self.ask(prompt)

        return await asyncio.gather(*[_one(p) for p in prompts])

    # ── 内部实现 ──────────────────────────────────────────────────────────

    async def _run(self, args: list[str], prompt: str) -> AskResult:
        """执行 Node.js CLI 并解析输出"""
        import time
        start = time.time()

        proc = await asyncio.create_subprocess_exec(
            *args,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=self._project_dir,
        )

        try:
            stdout, stderr = await asyncio.wait_for(
                proc.communicate(input=prompt.encode("utf-8")),
                timeout=self._timeout_ms / 1000 + 60,  # +60s buffer
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            return AskResult(
                response="",
                success=False,
                exit_code=10,
                total_time_ms=int((time.time() - start) * 1000),
            )

        elapsed_ms = int((time.time() - start) * 1000)
        stderr_text = stderr.decode("utf-8", errors="replace")
        stdout_text = stdout.decode("utf-8", errors="replace")

        return self._parse_result(
            stdout_text.strip(),
            stderr_text,
            elapsed_ms,
            proc.returncode or 0,
        )

    def _parse_result(
        self, stdout: str, stderr: str, elapsed_ms: int, exit_code: int
    ) -> AskResult:
        """从 CLI 输出中提取结构化信息"""
        result = AskResult(
            response=stdout,
            exit_code=exit_code,
            total_time_ms=elapsed_ms,
        )

        if exit_code != 0:
            result.success = False
            if not stdout:
                result.response = self._extract_error(stderr)
            return result

        if not stdout or len(stdout) < 5:
            result.success = False
            result.response = self._extract_error(stderr) or "(empty response)"
            return result

        # 提取 Provider 信息
        for line in stderr.split("\n"):
            # "✓ Gemini: USED (849 chars, 156982ms total)"
            m = re.search(r"✓\s*(\w+):\s*USED", line)
            if m:
                result.provider_used = m.group(1)
                break

        # 提取降级链
        for line in stderr.split("\n"):
            # "Fallback chain: gemini → chatgpt → claude → qwen (3 provider(s) skipped)"
            m = re.search(r"Fallback chain:\s*(.+)", line)
            if m:
                # 去掉末尾的 "(N provider(s) skipped)" 括号说明
                raw = re.sub(r"\s*\(\d+\s*provider\(s\)\s*skipped\)", "", m.group(1))
                result.fallback_chain = [
                    p.strip() for p in raw.split("→") if p.strip()
                ]
                # 如果有降级链，设置 provider_used 为最后一个
                if result.fallback_chain and not result.provider_used:
                    result.provider_used = result.fallback_chain[-1]
                break

        # 提取模型信息
        if "Pro Extended" in stderr:
            result.model_used = "Pro Extended"
        elif "Flash" in stderr or "Flash-Lite" in stderr:
            result.model_used = "Flash"

        # 提取时间信息
        m = re.search(r"(\d+)ms total", stderr)
        if m:
            result.total_time_ms = int(m.group(1))

        return result

    @staticmethod
    def _extract_error(stderr: str) -> str:
        """从 stderr 中提取错误信息"""
        for line in stderr.split("\n"):
            if "FATAL:" in line:
                return line.split("FATAL:", 1)[-1].strip()
            if "FAILED" in line and "—" in line:
                return line.split("—", 1)[-1].strip()
        return stderr[-500:] if stderr else "unknown error"

    # ── 环境检测 ──────────────────────────────────────────────────────────

    @staticmethod
    def _find_project_dir() -> str:
        """自动定位 AgentChat 项目根目录"""
        # 从这个文件的位置向上找
        d = Path(__file__).resolve().parent.parent
        index = d / "skills" / "AgentChat-WebExtended" / "index.js"
        if index.exists():
            return str(d)
        raise FileNotFoundError(
            "Cannot find AgentChat project root. "
            "Set AGENTCHAT_HOME environment variable."
        )

    @staticmethod
    def _find_node() -> str:
        """查找 Node.js 可执行文件"""
        # 优先环境变量
        node = os.environ.get("AGENTCHAT_NODE", "")
        if node and os.path.isfile(node):
            return node

        # 常见路径
        import platform
        system = platform.system()
        candidates = []
        if system == "Windows":
            home = os.path.expandvars(r"%LOCALAPPDATA%")
            candidates = [
                os.path.join(home, "node-v24.18.0-win-x64", "node.exe"),
                os.path.join(home, "node-v22.11.0-win-x64", "node.exe"),
            ]
            # 也检查 Program Files
            for ver in ["24", "22", "20", "18"]:
                candidates.append(
                    rf"C:\Program Files\nodejs-v{ver}\node.exe"
                )
            candidates.append(r"C:\Program Files\nodejs\node.exe")

        # 最后尝试 PATH 中的
        candidates.append("node")

        for c in candidates:
            if os.path.isfile(c):
                return c

        # 如果都不存在，直接返回 "node" 让系统找
        return "node"

    # ── 上下文管理器 ──────────────────────────────────────────────────────

    async def __aenter__(self):
        return self

    async def __aexit__(self, *args):
        pass  # tab 由 --keep-tabs 管理，无需手动清理
