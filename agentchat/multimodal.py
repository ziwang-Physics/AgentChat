"""
多模态输入 — 将图片发送给 Gemini Web 做视觉分析。

通过系统剪贴板粘贴图片到 Gemini 输入框。
Gemini 支持接收图片 + 文本混合 prompt。

技术原理:
  1. 图片写入系统剪贴板（Windows: PowerShell, macOS: osascript, Linux: xclip）
  2. 连接 Chrome CDP → 找到/创建 Gemini tab
  3. 聚焦输入框 → Ctrl+V 粘贴图片 → 输入文本 → 发送
  4. 等待 Gemini 响应

依赖: pip install playwright（Python 版）

使用示例:
    async with GeminiSession() as gs:
        result = await gs.ask_with_image(
            "描述这张图片的内容",
            image_path="photo.png",
        )
"""

from pathlib import Path
import subprocess, platform, os
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .session import GeminiSession, AskResult


async def ask_with_image(
    session: "GeminiSession",
    prompt: str,
    image_path: str,
    timeout_ms: int = 300_000,
) -> "AskResult":
    """发送文本 + 图片到 Gemini Web。

    图片通过系统剪贴板粘贴。Windows 使用 PowerShell SetImage，
    macOS 使用 osascript，Linux 使用 xclip。

    Args:
        session: GeminiSession 实例
        prompt: 文本问题
        image_path: 图片文件路径（支持 PNG/JPG/GIF/WebP）
        timeout_ms: 超时（毫秒）

    Returns:
        AskResult
    """
    from .result import AskResult

    image_path = os.path.abspath(image_path)
    if not os.path.isfile(image_path):
        return AskResult(
            response=f"Image not found: {image_path}",
            success=False, exit_code=4,
        )

    # ── Step 1: 图片写入系统剪贴板 ──
    ok = _copy_image_to_clipboard(image_path)
    if not ok:
        return AskResult(
            response="Failed to copy image to system clipboard",
            success=False, exit_code=4,
        )

    # ── Step 2: 通过 Playwright CDP 连接 Chrome，粘贴图片 + 输入文本 ──
    import asyncio
    loop = asyncio.get_running_loop()

    def _sync_paste_and_send():
        from playwright.sync_api import sync_playwright
        import time

        with sync_playwright() as p:
            b = p.chromium.connect_over_cdp(
                f"http://127.0.0.1:{session._cdp_port}"
            )

            # 找到/创建 Gemini tab
            page = None
            created_page = False  # keep-tabs policy: only close tabs WE created
            for ctx in b.contexts:
                for pg in ctx.pages:
                    if "gemini.google.com" in pg.url and pg.title() not in (
                        "", "about:blank"
                    ):
                        page = pg
                        break
                if page:
                    break

            if not page:
                page = b.contexts[0].new_page() if b.contexts else None
                if not page:
                    b.close()
                    return None
                created_page = True
                page.goto(
                    "https://gemini.google.com/u/0/app",
                    wait_until="domcontentloaded", timeout=30000,
                )
                time.sleep(3)

            page.keyboard.press("Escape")
            time.sleep(0.5)

            # 聚焦输入框
            editor = page.locator(
                'rich-textarea, [contenteditable="true"]'
            ).first
            editor.wait_for(state="visible", timeout=10000)
            editor.click()
            time.sleep(0.5)

            # 授予剪贴板权限
            try:
                cdp = page.context.new_cdp_session(page)
                cdp.send("Browser.grantPermissions", {
                    "permissions": [
                        "clipboardReadWrite",
                        "clipboardSanitizedWrite",
                    ],
                    "origin": "https://gemini.google.com",
                })
            except Exception:
                pass  # 非致命

            # Ctrl+V 粘贴图片
            page.keyboard.press("Control+v")
            time.sleep(2)

            # 输入文本 prompt
            page.keyboard.insert_text(prompt)
            time.sleep(0.5)

            # 点击发送
            send_btn = page.locator(
                'button[aria-label*="发送"], button[aria-label*="Send"], button[aria-label*="傳送"]'
            ).first
            try:
                send_btn.wait_for(state="visible", timeout=5000)
                send_btn.click()
            except Exception:
                page.keyboard.press("Enter")

            # 等待响应完成
            time.sleep(3)
            try:
                stop = page.locator(
                    'button[aria-label*="停止"], button[aria-label*="Stop"]'
                ).first
                if stop.count():
                    try:
                        stop.wait_for(state="hidden", timeout=timeout_ms)
                    except Exception:
                        pass
            except Exception:
                pass

            # 等待 Action Toolbar
            try:
                page.locator(
                    'button[aria-label*="复制"], button[aria-label*="Copy"], button[aria-label*="Good"]'
                ).last.wait_for(state="visible", timeout=30000)
            except Exception:
                pass
            time.sleep(2)

            # 提取响应
            response_text = ""
            try:
                response_text = (
                    page.locator(".model-response-text")
                    .last.inner_text()
                )
            except Exception:
                pass

            # POLICY FIX: unconditional page.close() violated the project-wide
            # "never close the user's tabs" rule — when the Gemini tab was
            # REUSED (found among existing pages), it belonged to the user's
            # session and closing it destroyed their conversation. Close only
            # the tab we created ourselves; b.close() merely disconnects the
            # CDP client for connect_over_cdp, it does not kill the browser.
            if created_page:
                page.close()
            b.close()
            return response_text

    response_text = await loop.run_in_executor(None, _sync_paste_and_send)

    if response_text is None:
        return AskResult(
            response="Failed to connect to Chrome CDP or create Gemini tab",
            success=False, exit_code=1,
        )

    if not response_text.strip():
        return AskResult(
            response="(no response — Gemini may still be thinking, try longer timeout)",
            success=True,
            provider_used="Gemini",
        )

    return AskResult(
        response=response_text.strip(),
        success=True,
        provider_used="Gemini",
        model_used="",
    )


# ═══════════════════════════════════════════════════════════════════════════
# 平台剪贴板
# ═══════════════════════════════════════════════════════════════════════════

def _copy_image_to_clipboard(image_path: str) -> bool:
    """图片写入系统剪贴板。成功返回 True。"""
    system = platform.system()

    if system == "Windows":
        return _copy_windows(image_path)
    elif system == "Darwin":
        return _copy_macos(image_path)
    else:
        return _copy_linux(image_path)


def _copy_windows(image_path: str) -> bool:
    """PowerShell [System.Windows.Forms.Clipboard]::SetImage()"""
    ps_script = f"""
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
$img = [System.Drawing.Image]::FromFile('{image_path}')
[System.Windows.Forms.Clipboard]::SetImage($img)
$img.Dispose()
"""
    try:
        # PRIVACY FIX: verify the clipboard write actually succeeded. Returning
        # True unconditionally meant a failed SetImage left the USER'S previous
        # clipboard content in place — and the subsequent Ctrl+V pasted (and
        # potentially sent) their private data to the Gemini page. Same class
        # as the defaultInput clipboard fix in lib/providerFactory.js.
        r = subprocess.run(
            ["powershell", "-NoProfile", "-Command", ps_script],
            capture_output=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


def _copy_macos(image_path: str) -> bool:
    """osascript 设置剪贴板图片"""
    script = f'''
set theImage to (read (POSIX file "{image_path}") as «class PNGf»)
set the clipboard to theImage
'''
    try:
        # PRIVACY FIX: same returncode verification as _copy_windows.
        r = subprocess.run(
            ["osascript", "-e", script],
            capture_output=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False


def _copy_linux(image_path: str) -> bool:
    """xclip 设置剪贴板图片"""
    try:
        # PRIVACY FIX: same returncode verification as _copy_windows. A failed
        # xclip (e.g. no X display over SSH) previously returned True and let
        # Ctrl+V paste the user's private clipboard into the Gemini page.
        r = subprocess.run(
            ["xclip", "-selection", "clipboard", "-t", "image/png", "-i", image_path],
            capture_output=True, timeout=10,
        )
        if r.returncode == 0:
            return True
    except FileNotFoundError:
        pass
    except Exception:
        pass
    # fallback: wl-copy (Wayland)
    try:
        r = subprocess.run(
            ["wl-copy", "-t", "image/png", image_path],
            capture_output=True, timeout=10,
        )
        return r.returncode == 0
    except Exception:
        return False
