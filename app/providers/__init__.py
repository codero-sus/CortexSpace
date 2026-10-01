"""Provider registry."""
from __future__ import annotations

from typing import Dict

from ..config import Settings
from .base import Provider
from .demo import DemoProvider
from .ollama import OllamaProvider
from .openai_compat import OpenAIProvider, OpenRouterProvider

__all__ = ["Provider", "ProviderError", "get_provider", "PROVIDER_INFO"]


class ProviderError(Exception):
    pass


PROVIDER_IDS = ("demo", "ollama", "openrouter", "openai")


def get_provider(settings: Settings) -> Provider:
    s = settings
    if s.provider == "ollama":
        return OllamaProvider(s)
    if s.provider == "openrouter":
        return OpenRouterProvider(s)
    if s.provider == "openai":
        return OpenAIProvider(s)
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
}
