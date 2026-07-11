"""
结构化输出 — 让 AI 返回 Pydantic 对象而非原始文本。

核心思路：
  1. 在 prompt 末尾注入 JSON schema 指令
  2. LLM 返回 JSON → Pydantic 验证
  3. 验证失败 → 告诉 LLM 哪里错了 → 重试（最多 3 次）

使用示例:
    from pydantic import BaseModel, Field

    class FactorAnalysis(BaseModel):
        factor_name: str
        ic_mean: float = Field(ge=-1, le=1)
        icir: float
        win_rate: float = Field(ge=0, le=100)
        risk_warning: str | None = None

    async with GeminiSession() as gs:
        result = await gs.ask_structured(
            "分析 momentum_20d 因子的表现",
            schema=FactorAnalysis,
        )
        print(result.ic_mean)  # 0.035 (float, 已验证)
"""

import json
import re
from typing import Type, TypeVar

T = TypeVar("T")


async def ask_structured(
    session: "GeminiSession",
    prompt: str,
    schema: Type[T],
    max_retries: int = 3,
) -> T:
    """发送 prompt，返回 Pydantic 验证的结构化对象。

    Args:
        session: GeminiSession 实例
        prompt: 问题文本
        schema: Pydantic BaseModel 子类
        max_retries: JSON 格式不正确时的最大重试次数

    Returns:
        验证通过的 Pydantic 实例

    Raises:
        ValueError: 所有重试后仍无法解析
    """
    try:
        # P0 FIX: was `_build_schema_json(schema)` — that name is never defined
        # (the function below is `_build_json_schema`), so EVERY call raised
        # NameError, wrapped as "Invalid Pydantic schema: name '_build_schema_json'
        # is not defined". ask_structured() has never worked.
        schema_json = _build_json_schema(schema)
    except Exception as e:
        raise ValueError(f"Invalid Pydantic schema: {e}") from e

    # 注入 JSON schema 指令
    json_instruction = f"""
请严格按照以下 JSON 格式返回（不要额外文字，不要 markdown 代码块标记）：
{schema_json}
"""
    full_prompt = f"{prompt}\n\n{json_instruction}"

    last_error = None
    for attempt in range(max_retries):
        result = await session.ask(full_prompt)
        if not result.success:
            last_error = ValueError(f"Provider call failed: {result.response[:200]}")
            continue

        try:
            json_str = _extract_json(result.response)
            return schema.model_validate_json(json_str)
        except Exception as e:
            last_error = e
            if attempt < max_retries - 1:
                # P1 FIX: the old correction prompt was JUST "你的上一个回复格式
                # 有误：…" and relied on "复用同一个 session tab，LLM 能看到上下文"。
                # That assumption is false: each session.ask() spawns a fresh
                # WebExtended subprocess, and WebExtended's tab reuse does a
                # page.goto(url) that STARTS A NEW CHAT (see findProviderPage's
                # comment in AgentChat-WebExtended/index.js). The model receiving
                # the retry had never seen the original prompt, the schema, or
                # its "previous" reply — retries 2..N were guaranteed garbage.
                # The correction must therefore be fully self-contained.
                bad_snippet = (result.response or "")[:800]
                correction = (
                    f"{prompt}\n\n{json_instruction}\n\n"
                    f"注意：针对同样的问题，之前的一次回复未能通过格式校验。\n"
                    f"校验错误：{e}\n"
                    f"未通过校验的回复片段：\n{bad_snippet}\n\n"
                    f"请重新回答，只输出一个符合上述格式的纯 JSON 对象，"
                    f"不要 markdown 代码块标记，不要任何额外文字。"
                )
                full_prompt = correction

    raise ValueError(f"Failed after {max_retries} retries. Last error: {last_error}")


def _build_json_schema(schema: Type) -> str:
    """从 Pydantic model 构建 JSON schema 文本"""
    try:
        s = schema.model_json_schema()
    except AttributeError:
        # Pydantic v1 fallback
        s = schema.schema()

    # 简化 schema 输出（只保留核心字段信息）
    props = s.get("properties", {})
    required = s.get("required", [])

    lines = ["{"]
    for name, info in props.items():
        typ = _type_str(info)
        desc = info.get("description", "")
        comment = f"  // {desc}" if desc else ""
        req_mark = " (required)" if name in required else " (optional)"
        lines.append(f'  "{name}": {typ},{comment}{req_mark}')
    lines.append("}")

    return "\n".join(lines)


def _type_str(info: dict) -> str:
    """Pydantic JSON schema type → 人类可读的类型标注"""
    typ = info.get("type", "string")
    if "anyOf" in info:
        types = [t.get("type", "string") for t in info["anyOf"] if "type" in t]
        if "null" in types:
            types.remove("null")
            return f"{'|'.join(types)} | null"
        return " | ".join(types)
    if typ == "array":
        items = info.get("items", {})
        return f"[{_type_str(items)}]"
    if typ == "number":
        minimum = info.get("minimum")
        maximum = info.get("maximum")
        if minimum is not None and maximum is not None:
            return f"number ({minimum}-{maximum})"
    return typ


def _extract_json(text: str) -> str:
    """从 LLM 响应中提取 JSON（处理各种格式变体）"""
    text = text.strip()

    # 尝试直接解析
    try:
        json.loads(text)
        return text
    except (json.JSONDecodeError, ValueError):
        pass

    # 尝试提取 ```json ... ``` 块
    m = re.search(r"```(?:json)?\s*\n?([\s\S]*?)\n?```", text)
    if m:
        candidate = m.group(1).strip()
        try:
            json.loads(candidate)
            return candidate
        except (json.JSONDecodeError, ValueError):
            pass

    # 尝试提取 { ... } 最外层
    m = re.search(r"\{[\s\S]*\}", text)
    if m:
        candidate = m.group(0)
        try:
            json.loads(candidate)
            return candidate
        except (json.JSONDecodeError, ValueError):
            pass

    raise ValueError(f"Cannot extract valid JSON from: {text[:200]}...")


# 便捷函数：无需 session，直接给纯文本提取 JSON
def parse_json_response(
    text: str, schema: Type[T],
) -> T:
    """从已有文本中提取并验证 JSON。

    用于兼容非 AgentChat 来源的 LLM 输出。
    """
    json_str = _extract_json(text)
    return schema.model_validate_json(json_str)
