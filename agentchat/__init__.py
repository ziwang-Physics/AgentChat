"""
AgentChat Python SDK — 程序化调用多 AI Provider 降级链。

使用示例:
    from agentchat import GeminiSession

    async with GeminiSession() as gs:
        # 基础问答
        result = await gs.ask("分析沪深300的因子暴露")
        print(result.response)

        # 结构化输出
        from pydantic import BaseModel
        class FactorReport(BaseModel):
            name: str; ic_mean: float; risk: str
        report = await gs.ask_structured("分析动量因子", schema=FactorReport)

        # 多模态分析
        result = await gs.ask_with_image(
            "这张资金曲线有什么异常？",
            image_path="nav_chart.png"
        )
"""

from .result import AskResult
from .session import GeminiSession

__all__ = ["GeminiSession", "AskResult"]
