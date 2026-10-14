"""Provider registry."""
from __future__ import annotations

from typing import Dict

from ..config import Settings
from .base import Provider, ProviderError
from .demo import DemoProvider
from .ollama import OllamaProvider
from .openai_compat import CortexHosterProvider, OpenAIProvider, OpenRouterProvider

__all__ = ["Provider", "ProviderError", "get_provider", "PROVIDER_INFO"]


PROVIDER_IDS = ("demo", "ollama", "openrouter", "openai", "cortex")


def get_provider(settings: Settings) -> Provider:
    s = settings
    if s.provider == "ollama":
        return OllamaProvider(s)
    if s.provider == "openrouter":
        return OpenRouterProvider(s)
    if s.provider == "openai":
        return OpenAIProvider(s)
    if s.provider == "cortex":
        return CortexHosterProvider(s)
    return DemoProvider()


PROVIDER_INFO: Dict[str, dict] = {
    "demo": {
        "id": "demo",
        "label": "Demo",
        "blurb": "Zero-config offline model. Great for trying the workspace, tools and approvals.",
    },
    "ollama": {
        "id": "ollama",
        "label": "Ollama",
        "blurb": "Run fully local models on your machine (ollama serve). Private by default.",
    },
    "openrouter": {
        "id": "openrouter",
        "label": "OpenRouter",
        "blurb": "One API key for 300+ models (Claude, GPT, Gemini, Llama…).",
    },
    "openai": {
        "id": "openai",
        "label": "OpenAI-compatible",
        "blurb": "OpenAI, Groq, LM Studio, vLLM, llama.cpp — anything OpenAI-shaped. Just set the base URL.",
    },
    "cortex": {
        "id": "cortex",
        "label": "Cortex LLMHoster",
        "blurb": "Free local GGUF hosting (llama.cpp runtime) — no Ollama, no cloud key. Default http://127.0.0.1:8624/v1.",
    },
}
