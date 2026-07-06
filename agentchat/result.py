"""AskResult — GeminiSession 返回的统一结果类型"""
from dataclasses import dataclass, field


@dataclass
class AskResult:
    """一次 AI 调用的完整结果"""

    response: str
    """AI 返回的文本内容"""

    provider_used: str = ""
    """实际使用的 Provider（如 'Gemini', 'ChatGPT', 'Qwen'）"""

    model_used: str = ""
    """模型模式（如 'Pro Extended', 'Flash', '3.5 Flash'）"""

    thinking_time_ms: int = 0
    """从发送到收到第一条响应的时间（毫秒）"""

    total_time_ms: int = 0
    """总耗时（毫秒）"""

    fallback_chain: list = field(default_factory=list)
    """降级链经过的 Provider 列表（如 ['gemini', 'chatgpt', 'qwen']）"""

    exit_code: int = 0
    """CLI 退出码：0=成功，1=CDP不可达，2=无可用Provider，3=安全过滤..."""

    success: bool = True
    """是否成功获取响应"""

    @property
    def time_seconds(self) -> float:
        """总耗时（秒）"""
        return self.total_time_ms / 1000.0

    @property
    def had_fallback(self) -> bool:
        """是否触发了降级"""
        return len(self.fallback_chain) > 1

    def __repr__(self) -> str:
        status = "OK" if self.success else "FAIL"
        prov = f"{self.provider_used}({self.model_used})" if self.model_used else self.provider_used
        return (f"AskResult({status} {prov}, {len(self.response)} chars, "
                f"{self.time_seconds:.0f}s)")
