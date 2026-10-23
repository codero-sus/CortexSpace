"""Ollama provider — local models via the /api/chat NDJSON stream."""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List

import httpx

from ..config import Settings
from .base import ChatRequest, Provider

_timeout = httpx.Timeout(600.0, connect=8.0)


class OllamaProvider(Provider):
    id = "ollama"
    display = "Ollama (local)"

    def __init__(self, settings: Settings):
        self.s = settings
        self.base = settings.ollama_base_url.rstrip("/")

    def _messages(self, req: ChatRequest) -> List[Dict[str, Any]]:
        out = []
        for m in req.messages:
            msg: Dict[str, Any] = {"role": m["role"], "content": m.get("content") or ""}
            if m.get("tool_calls"):
                msg["tool_calls"] = [
                    {"function": {"name": tc["function"]["name"],
                                  "arguments": tc["function"]["arguments"]}}
                    for tc in m["tool_calls"]
                ]
            if m.get("role") == "tool":
                msg["tool_call_id"] = m.get("tool_call_id", "")
            out.append(msg)
        return out

    async def stream(self, req: ChatRequest) -> AsyncIterator[Dict[str, Any]]:
        body = {
            "model": req.model,
            "messages": self._messages(req),
            "stream": True,
            "options": {"temperature": req.temperature, "num_predict": req.max_tokens},
        }
        if req.tools:
            body["tools"] = req.tools
        async with httpx.AsyncClient(timeout=_timeout) as client:
            async with client.stream("POST", f"{self.base}/api/chat", json=body) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode("utf-8", "replace")[:400]
                    raise RuntimeError(f"Ollama {resp.status_code}: {detail}")
                buffer = ""
                async for chunk in resp.aiter_text():
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line:
                            continue
                        try:
                            obj = json.loads(line)
                        except json.JSONDecodeError:
                            continue
                        if obj.get("done"):
                            yield {
                                "type": "done",
                                "usage": {
                                    "prompt_tokens": obj.get("prompt_eval_count", 0),
                                    "completion_tokens": obj.get("eval_count", 0),
                                },
                                "finish": "stop",
                            }
                            return
                        msg = obj.get("message") or {}
                        if msg.get("content"):
                            yield {"type": "delta", "text": msg["content"]}
                        tcs = msg.get("tool_calls")
                        if tcs:
                            yield {
                                "type": "tool_calls",
                                "calls": [
                                    {
                                        "id": f"ol_{i + 1}",
                                        "name": tc["function"]["name"],
                                        "arguments": tc["function"].get("arguments") or {},
                                    }
                                    for i, tc in enumerate(tcs)
                                ],
                            }
        # stream ended without done line
        yield {"type": "done", "usage": {}, "finish": "stop"}

    async def list_models(self) -> List[str]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
            r = await client.get(f"{self.base}/api/tags")
            r.raise_for_status()
            return [m.get("name", "") for m in r.json().get("models", [])]

    async def ping(self) -> tuple[bool, str]:
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(5.0)) as client:
                r = await client.get(f"{self.base}/api/version")
                r.raise_for_status()
                return True, f"v{r.json().get('version', '?')}"
        except Exception as e:  # noqa: BLE001
            return False, f"cannot reach {self.base} ({type(e).__name__})"
