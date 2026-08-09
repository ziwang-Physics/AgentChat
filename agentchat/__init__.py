"""
AgentChat Python SDK — 程序化调用多 AI Provider 降级链（纯国内）。

使用示例:
    from agentchat import AgentSession

    async with AgentSession() as gs:
        # 基础问答
        result = await gs.ask("分析沪深300的因子暴露")
        print(result.response)

        # 结构化输出
        from pydantic import BaseModel
        class FactorReport(BaseModel):
            name: str; ic_mean: float; risk: str
        report = await gs.ask_structured("分析动量因子", schema=FactorReport)
"""

from .result import AskResult
from .session import AgentSession

__all__ = ["AgentSession", "AskResult"]
