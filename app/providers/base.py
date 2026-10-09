"""Provider abstraction.

A provider turns (messages, tools, settings) into an async stream of events:

    {"type": "delta", "text": "..."}                # visible text token
    {"type": "tool_calls", "calls": [{"id","name","arguments"}]}
    {"type": "done", "usage": {...}, "finish": "stop"}
"""
from __future__ import annotations

import abc
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List

from ..config import Settings


class ProviderError(Exception):
    """Raised when a provider cannot complete a request (bad config, no model, etc.)."""


@dataclass
class ChatRequest:
    messages: List[Dict[str, Any]]
    tools: List[Dict[str, Any]]
    model: str
    temperature: float = 0.4
    max_tokens: int = 2048


@dataclass
class Usage:
    prompt_tokens: int = 0
    completion_tokens: int = 0
    extra: Dict[str, Any] = field(default_factory=dict)


class Provider(abc.ABC):
    id: str = "base"
    display: str = "Base"

    @abc.abstractmethod
    async def stream(self, req: ChatRequest) -> AsyncIterator[Dict[str, Any]]:  # pragma: no cover
        raise NotImplementedError
        yield  # noqa: W0101

    async def list_models(self) -> List[str]:
        return []

    async def ping(self) -> tuple[bool, str]:
        try:
            return True, "ok"
        except Exception as e:  # noqa: BLE001
            return False, str(e)
