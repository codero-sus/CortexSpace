"""Application configuration.

Settings live in SQLite (persisted) and can be changed from the UI at runtime.
"""
from __future__ import annotations

import os
import threading
from dataclasses import dataclass, asdict, field
from typing import Any, Dict

_BASE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.environ.get("MW_AI_DATA_DIR", os.path.join(_BASE, "data"))
WORKSPACE_DIR = os.environ.get("MW_AI_WORKSPACE", os.path.join(DATA_DIR, "workspace"))

os.makedirs(DATA_DIR, exist_ok=True)
os.makedirs(WORKSPACE_DIR, exist_ok=True)


DEFAULT_SYSTEM_PROMPT = (
    "You are MyWorkspace AI, a fast, self-hosted personal AI workspace. "
    "You have a private file workspace you can read, write and search, plus web "
    "search and page fetching. Be concise and practical. Prefer using your tools "
    "when a task references files or the web. Use Markdown. When you create or "
    "edit a file, say its path clearly."
)


@dataclass
class Settings:
    # provider: "demo" | "ollama" | "openrouter"
    provider: str = "demo"
    ollama_base_url: str = "http://127.0.0.1:11434"
    ollama_model: str = "llama3.2"
    openrouter_base_url: str = "https://openrouter.ai/api/v1"
    openrouter_api_key: str = ""
    openrouter_model: str = "openrouter/auto"
    openrouter_site_url: str = ""
    # Any OpenAI-shaped API: OpenAI, Groq, LM Studio, vLLM, llama.cpp, …
    openai_base_url: str = "https://api.openai.com/v1"
    openai_api_key: str = ""
    openai_model: str = "gpt-4o-mini"
    temperature: float = 0.4
    max_tokens: int = 2048
    max_steps: int = 6
    system_prompt: str = DEFAULT_SYSTEM_PROMPT
    allow_python: bool = False
    auto_approve: bool = False
    disabled_tools: list = field(default_factory=list)  # tool names hidden from the agent
    strict_approve: bool = False  # ask for approval on every tool call
    searxng_url: str = ""  # e.g. https://searxng.example.com  (JSON API)
    ddg_enabled: bool = True

    def provider_model(self) -> str:
        if self.provider == "ollama":
            return self.ollama_model
        if self.provider == "openrouter":
            return self.openrouter_model
        if self.provider == "openai":
            return self.openai_model
        return "myworkspace-demo"


class SettingsStore:
    def __init__(self, db):
        self._db = db
        self._lock = threading.Lock()

    def get(self) -> Settings:
        row = self._db.get_setting("settings")
        base = Settings()
        if not row:
            return base
        data: Dict[str, Any] = {}
        import json
        try:
            data = json.loads(row)
        except Exception:
            data = {}
        merged = {**asdict(base), **{k: v for k, v in data.items() if v is not None}}
        return Settings(**merged)

    def save(self, s: Settings) -> None:
        import json
        with self._lock:
            self._db.set_setting("settings", json.dumps(asdict(s)))

    def update(self, patch: Dict[str, Any]) -> Settings:
        import json
        with self._lock:
            current = self.get()
            data = asdict(current)
            valid = {f for f in data}
            for k, v in patch.items():
                if k in valid and v is not None:
                    data[k] = v
            nxt = Settings(**data)
            self._db.set_setting("settings", json.dumps(asdict(nxt)))
            return nxt


def data_path() -> str:
    return os.path.join(DATA_DIR, "state.db")


_store: SettingsStore | None = None


def init_settings_store(db) -> SettingsStore:
    global _store
    _store = SettingsStore(db)
    return _store


def get_settings_holder() -> SettingsStore:
    if _store is None:
        raise RuntimeError("Settings store not initialized")
    return _store

