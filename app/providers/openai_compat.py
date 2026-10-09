"""OpenAI-compatible providers.

One implementation covers every OpenAI-shaped API:
  - OpenRouter  (openrouter.ai, /key ping)
  - OpenAI      (api.openai.com)
  - Anything else speaking the same dialect: Groq, LM Studio, vLLM, llama.cpp,
    Together, OpenRouter-compatible proxies… just change the base URL.
"""
from __future__ import annotations

import json
from typing import Any, AsyncIterator, Dict, List

import httpx

from ..config import Settings
from .base import ChatRequest, Provider, ProviderError

_timeout = httpx.Timeout(600.0, connect=8.0)


class OpenAICompatProvider(Provider):
    id = "openai_compat"
    display = "OpenAI-compatible"
    # GET path used by ping(); /key is OpenRouter-specific, /models is universal
    ping_path = "/models"

    def __init__(self, settings: Settings, *, base_url: str, api_key: str,
                 site_url: str = "", ping_path: str = "/models"):
        self.s = settings
        self.base = base_url.rstrip("/")
        self.api_key = api_key
        self.site_url = site_url
        self.ping_path = ping_path

    # -- wire format ------------------------------------------------------

    def _headers(self) -> Dict[str, str]:
        h = {"Content-Type": "application/json"}
        if self.api_key:
            h["Authorization"] = f"Bearer {self.api_key}"
        if self.site_url:
            h["HTTP-Referer"] = self.site_url
        h["X-Title"] = "CortexSpace"
        return h

    @staticmethod
    def _normalize_messages(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
        """OpenAI wire format: tool_call arguments must be a JSON string."""
        out = []
        for m in messages:
            m = dict(m)
            tcs = m.get("tool_calls")
            if tcs:
                m["tool_calls"] = [
                    {
                        "id": tc.get("id"),
                        "type": "function",
                        "function": {
                            "name": tc["function"]["name"],
                            "arguments": tc["function"]["arguments"]
                            if isinstance(tc["function"]["arguments"], str)
                            else json.dumps(tc["function"].get("arguments") or {}),
                        },
                    }
                    for tc in tcs
                ]
            if m.get("content") is None:
                m["content"] = ""
            out.append(m)
        return out

    # -- streaming ---------------------------------------------------------

    async def stream(self, req: ChatRequest) -> AsyncIterator[Dict[str, Any]]:
        if self.id == "cortex":
            req = ChatRequest(**{**req.__dict__, "model": await self._model(req.model)})
        body: Dict[str, Any] = {
            "model": req.model,
            "messages": self._normalize_messages(req.messages),
            "stream": True,
            "temperature": req.temperature,
            "max_tokens": req.max_tokens,
        }
        # stream_options/include_usage is not supported by every compatible
        # server; OpenRouter + OpenAI are. We try it and tolerate its absence.
        if self.id in ("openrouter", "openai"):
            body["stream_options"] = {"include_usage": True}
        if req.tools:
            body["tools"] = req.tools
            body["tool_choice"] = "auto"

        async with httpx.AsyncClient(timeout=_timeout) as client:
            async with client.stream("POST", f"{self.base}/chat/completions",
                                     json=body, headers=self._headers()) as resp:
                if resp.status_code != 200:
                    detail = (await resp.aread()).decode("utf-8", "replace")[:500]
                    try:
                        j = json.loads(detail)
                        detail = j.get("error", {}).get("message", detail) or detail
                    except Exception:  # noqa: BLE001
                        pass
                    raise RuntimeError(f"{self.display} {resp.status_code}: {detail}")

                acc: Dict[int, Dict[str, Any]] = {}
                finish = "stop"
                usage: Dict[str, Any] = {}
                buffer = ""
                async for chunk in resp.aiter_text():
                    buffer += chunk
                    while "\n" in buffer:
                        line, buffer = buffer.split("\n", 1)
                        line = line.strip()
                        if not line.startswith("data:"):
                            continue
                        payload = line[5:].strip()
                        if payload == "[DONE]":
                            break
                        try:
                            obj = json.loads(payload)
                        except json.JSONDecodeError:
                            continue
                        if obj.get("usage"):
                            u = obj["usage"]
                            usage = {
                                "prompt_tokens": u.get("prompt_tokens", 0),
                                "completion_tokens": u.get("completion_tokens", 0),
                            }
                        choices = obj.get("choices") or [{}]
                        delta = choices[0].get("delta") or {}
                        if choices[0].get("finish_reason"):
                            finish = choices[0]["finish_reason"]
                        if delta.get("content"):
                            yield {"type": "delta", "text": delta["content"]}
                        for tc in delta.get("tool_calls") or []:
                            idx = tc.get("index", 0)
                            slot = acc.setdefault(idx, {"id": "", "name": "", "arguments": ""})
                            if tc.get("id"):
                                slot["id"] = tc["id"]
                            fn = tc.get("function") or {}
                            if fn.get("name"):
                                slot["name"] = fn["name"]
                            if fn.get("arguments"):
                                slot["arguments"] += fn["arguments"]

        calls = []
        for idx in sorted(acc):
            slot = acc[idx]
            try:
                args = json.loads(slot["arguments"] or "{}")
            except json.JSONDecodeError:
                args = {"_raw": slot["arguments"]}
            calls.append({"id": slot["id"] or f"oai_{idx}", "name": slot["name"], "arguments": args})
        if calls:
            yield {"type": "tool_calls", "calls": calls}
        yield {"type": "done", "usage": usage, "finish": finish}

    # -- models / ping ------------------------------------------------------

    async def list_models(self) -> List[str]:
        async with httpx.AsyncClient(timeout=httpx.Timeout(15.0)) as client:
            r = await client.get(f"{self.base}/models", headers=self._headers())
            r.raise_for_status()
            data = r.json().get("data", [])
            ids = [m.get("id", "") for m in data if m.get("id")]
            return ids

    async def ping(self) -> tuple[bool, str]:
        if not self.api_key:
            return False, "no API key set"
        try:
            async with httpx.AsyncClient(timeout=httpx.Timeout(8.0)) as client:
                r = await client.get(f"{self.base}{self.ping_path}", headers=self._headers())
                if r.status_code == 200:
                    if self.ping_path == "/key":
                        label = r.json().get("label", "key")
                        return True, f"key active ({label})"
                    return True, f"{self.base} reachable"
                return False, f"HTTP {r.status_code}"
        except Exception as e:  # noqa: BLE001
            return False, f"cannot reach {self.base} ({type(e).__name__})"


class OpenRouterProvider(OpenAICompatProvider):
    id = "openrouter"
    display = "OpenRouter (cloud)"

    def __init__(self, settings: Settings):
        super().__init__(
            settings,
            base_url=settings.openrouter_base_url,
            api_key=settings.openrouter_api_key,
            site_url=settings.openrouter_site_url,
            ping_path="/key",
        )


class OpenAIProvider(OpenAICompatProvider):
    id = "openai"
    display = "OpenAI-compatible"

    def __init__(self, settings: Settings):
        super().__init__(
            settings,
            base_url=settings.openai_base_url,
            api_key=settings.openai_api_key,
            ping_path="/models",
        )


class CortexHosterProvider(OpenAICompatProvider):
    """Cortex LLMHoster (github.com/codero-sus/Cortex_LLMHoster).

    Free personal-use local model hoster: llama.cpp/GGUF first-class plus a
    supervised adapter for any local engine that speaks OpenAI-compatible
    HTTP. Default endpoint http://127.0.0.1:8624/v1. The API key, if set,
    is the LOCAL bearer secret protecting that install — it never leaves
    your machine. If no model is configured, the first model from
    /v1/models is used."""
    id = "cortex"
    display = "Cortex LLMHoster (local)"
    _resolved: str | None = None
    last_model: str = ""  # model actually used on the most recent stream

    def __init__(self, settings: Settings):
        super().__init__(
            settings,
            base_url=settings.cortex_base_url,
            api_key=settings.cortex_api_key,
            ping_path="/models",
        )
        self._configured_model = settings.cortex_model

    async def _model(self, req_model: str) -> str:
        m = (req_model or self._configured_model or "").strip()
        if m:
            self.last_model = m
            return m
        if self._resolved:
            self.last_model = self._resolved
            return self._resolved
        models = await self.list_models()
        if not models:
            raise ProviderError("Cortex LLMHoster is reachable but has no models loaded — start one in its dashboard (port 8624)")
        self._resolved = models[0]
        self.last_model = models[0]
        return models[0]
