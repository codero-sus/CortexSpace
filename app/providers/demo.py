"""Built-in offline demo model.

Zero-config, works with no network and no API key, so the workspace is
usable the second it starts. It is a small scripted agent: it reads the user's
last message, picks a plan (a short preamble + real tool calls), and after the
agent loop feeds tool results back, it composes a final answer that references
the *actual* results. This exercises the entire streaming + tools + approvals
pipeline exactly like a real model would.
"""
from __future__ import annotations

import asyncio
import json
import re
from typing import Any, AsyncIterator, Dict, List

from .. import worksp
from .base import ChatRequest, Provider

GREETING = (
    "Hey — I'm **CortexSpace**, your self-hosted workspace agent. I'm running on the "
    "built-in **demo model** right now, so you can try everything instantly with zero config.\n\n"
    "Here's what I can do:\n\n"
    "- 📁 **Browse your workspace** — *try: `list my files`*\n"
    "- 📖 **Read & explain files** — *try: `read welcome.md`*\n"
    "- ✍️ **Create & edit notes** — *try: `create a note about my coffee habits`*\n"
    "- 🔎 **Search everything** — *try: `find the word roadmap`*\n"
    "- 🐍 **Run Python** — *try: `run python that prints 21*21`*\n"
    "- 🌐 **Web search & page fetch** — needs outbound network on your machine\n\n"
    "To get real model intelligence, open **Settings** and switch the provider to "
    "**Ollama** (local, private) or **OpenRouter** (any model, one API key). "
    "Everything else — files, search, Python, approvals — works identically."
)

FALLBACK = (
    "I'm the **offline demo model**, so I understand a fixed set of intents — but every "
    "tool I use is the real thing. Try one of these:\n\n"
    "- `list my files`\n"
    "- `read welcome.md`\n"
    "- `create a note about my coffee habits`\n"
    "- `find the word roadmap`\n"
    "- `run python that prints 21*21`\n"
    "- `search the web for latest LLM news`\n\n"
    "Or switch to **Ollama** or **OpenRouter** in Settings for fully general intelligence."
)


def _last_user_text(messages: List[Dict[str, Any]]) -> str:
    for m in reversed(messages):
        if m.get("role") == "user":
            c = m.get("content")
            if isinstance(c, list):  # content-parts format
                c = "".join(p.get("text", "") for p in c if isinstance(p, dict))
            return (c or "").strip()
    return ""


def _has_tool_results(messages: List[Dict[str, Any]]) -> bool:
    return any(m.get("role") == "tool" for m in messages)


def _extract_path(text: str) -> str | None:
    m = re.search(r"(?:read|open|show)\s+(?:me\s+)?([A-Za-z0-9_\-./]+\.(?:md|txt|py|js|json|csv|html|toml|ya?ml))", text, re.I)
    if m:
        cand = m.group(1)
        try:
            worksp.read_file(cand)
            return cand
        except Exception:  # noqa: BLE001
            pass
        # try to locate by basename anywhere in the workspace
        base = cand.rsplit("/", 1)[-1]
        try:
            stack = list(worksp.tree(depth=4))
            while stack:
                n = stack.pop()
                if n["is_dir"]:
                    stack.extend(n.get("children", []))
                elif n["name"].lower() == base.lower():
                    return n["path"]
        except Exception:  # noqa: BLE001
            pass
        return cand
    # "read the roadmap" → try to find a matching workspace file
    m = re.search(r"(?:read|open)\s+(?:the\s+|my\s+)?([a-z0-9_\- ]{3,40})", text, re.I)
    if m:
        word = m.group(1).strip()
        try:
            for node in worksp.tree(depth=3):
                stack = [node]
                while stack:
                    n = stack.pop()
                    if not n["is_dir"] and n["name"].lower().startswith(word.lower().split()[0]):
                        return n["path"]
                    stack.extend(n.get("children", []))
        except Exception:  # noqa: BLE001
            pass
    return None


def _extract_note_topic(text: str) -> str | None:
    m = re.search(r"(?:create|write|make|draft)\s+(?:me\s+)?(?:a\s+|an\s+|the\s+)?(?:note|file|doc|document|list)\s*(?:about|called|named|for)\s+(.{3,80})", text, re.I)
    if m:
        return m.group(1).strip().rstrip(".!")
    return None


def _extract_search(text: str) -> str | None:
    m = re.search(r"\bthe word\s+([a-z0-9_\-]+)", text, re.I)
    if m:
        return m.group(1)
    m = re.search(r"(?:search|find|look for)\s+(?:for\s+)?[\"']?(.{3,80})[\"']?\s*$", text, re.I)
    if m:
        q = m.group(1)
        q = re.sub(r"^(the|for|my) ", "", q)
        if "web" not in text.lower():
            return q
    return None


def _extract_code(text: str) -> str | None:
    m = re.search(r"(?:run|execute)\s+(?:some\s+)?python\s*(?:that\s+)?(?:prints?|computes?|that\s+)?(.{3,200})", text, re.I)
    if m:
        expr = m.group(1).strip().rstrip(".")
        # "prints 21*21" / "21*21" → print(expr)
        if re.fullmatch(r"[0-9+\-*/().%\s^]+", expr):
            return f"print({expr})"
        if re.fullmatch(r"[\w\s+\-*/().%]+", expr) and ("+" in expr or "*" in expr or "/" in expr):
            return f"print({expr})"
        return expr if expr.startswith("print") else f"print({expr})"
    m = re.search(r"what\s+is\s+([0-9+\-*/().\s]+)\??\s*$", text, re.I)
    if m:
        return f"print({m.group(1).strip()})"
    if re.search(r"\brun\s+(some\s+)?python\b", text, re.I):
        return "print('hello from your workspace')"
    return None


def _extract_web_query(text: str) -> str | None:
    m = re.search(r"(?:search\s+the\s+web|web\s+search|look\s+up|google)\s*(?:for\s+)?[\"']?(.{5,120})[\"']?\s*[.!?]?\s*$", text, re.I)
    if m:
        return m.group(1).strip()
    return None


def _extract_url(text: str) -> str | None:
    m = re.search(r"(https?://[^\s]+)", text)
    return m.group(1) if m else None


def _tool_results(messages: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    """Reconstruct (name, args, output) triples from the message history."""
    pairs: List[Dict[str, Any]] = []
    pending: Dict[str, Dict[str, Any]] = {}
    for m in messages:
        if m.get("role") == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                fn = tc.get("function", tc)
                args = fn.get("arguments") or {}
                if isinstance(args, str):
                    try:
                        args = json.loads(args or "{}")
                    except Exception:  # noqa: BLE001
                        args = {"_raw": args}
                pending[tc.get("id", "")] = {"name": fn.get("name"), "args": args}
        elif m.get("role") == "tool":
            info = pending.get(m.get("tool_call_id", ""), {})
            pairs.append(
                {
                    "name": info.get("name"),
                    "args": info.get("args", {}),
                    "output": (m.get("content") or "")[:6000],
                }
            )
    return pairs


def _final_answer(user_text: str, results: List[Dict[str, Any]]) -> str:
    if not results:
        return FALLBACK
    out: List[str] = []
    for r in results:
        name, args, text = r["name"], r["args"], r["output"]
        if name == "list_workspace":
            out.append("Here's what's in your workspace:")
            out.append("```")
            out.append(text)
            out.append("```")
            out.append("\nClick any file in the left sidebar to open it. Want me to read one, or draft a new note?")
        elif name == "read_file":
            lines = [l for l in text.splitlines() if l]
            preview = "\n".join(lines[:12])
            p = args.get("path", "")
            lang = p.rsplit(".", 1)[-1].lower() if "." in p else ""
            lang = {"md": "markdown", "py": "python", "js": "javascript", "json": "json"}.get(lang, lang)
            out.append(f"Here's `{p}`:")
            out.append("")
            out.append("```" + lang)
            out.append(preview)
            out.append("```")
            if "truncated" in text:
                out.append("\n*(truncated — open it in the editor to see the whole file)*")
        elif name == "write_file":
            path = args.get("path", "?")
            out.append(f"Done — I created **`{path}`** in your workspace.")
            content = args.get("content", "")
            out.append("\n```markdown")
            out.append(content[:1500])
            out.append("```")
            out.append("\nIt's open-able from the sidebar under *Workspace*. Want me to revise anything?")
        elif name == "search_workspace":
            out.append(text)
            out.append("\nI can read any of these files in full if you'd like.")
        elif name == "run_python":
            m = re.search(r"stdout:\n(.*?)(?:\nstderr:|\Z)", text, re.S)
            stdout = m.group(1).strip() if m else text
            out.append("I ran that in your workspace:")
            out.append("")
            out.append("```python")
            out.append(args.get("code", ""))
            out.append("```")
            out.append("")
            out.append("**Output:**")
            out.append("```")
            out.append(stdout or "(no output)")
            out.append("```")
        elif name == "web_search":
            if text.startswith("error") or "unavailable" in text.lower():
                out.append("I tried, but web search couldn't reach the outside world from here — "
                           "it looks like this host is offline. It will work the same way on your machine, "
                           "or set a **SearXNG** instance URL in Settings for a private search backend.")
            else:
                out.append("Here's what I found:")
                out.append("")
                out.append(text)
        elif name == "fetch_page":
            if text.startswith("error"):
                out.append(f"Page fetch failed: {text}")
            else:
                out.append(text[:4000])
        else:
            out.append(text[:2000])
    return "\n".join(out)


class DemoProvider(Provider):
    id = "demo"
    display = "Demo (built-in, offline)"

    MODELS = ["myworkspace-demo"]

    async def list_models(self) -> List[str]:
        return list(self.MODELS)

    async def _decide(self, req: ChatRequest) -> tuple[str, List[Dict[str, Any]]]:
        """Return (preamble_text, tool_calls) for the first turn."""
        text = _last_user_text(req.messages).lower()
        original = _last_user_text(req.messages)

        if re.search(r"^\s*(hi|hey|hello|yo|howdy)\b", text) or "who are you" in text or "what can you do" in text or "help" == text.strip():
            return GREETING, []

        url = _extract_url(original)
        if url and re.search(r"fetch|open|read|summarize|page", text):
            return (f"Fetching that page…\n", [{"name": "fetch_page", "arguments": {"url": url}}])

        web_q = _extract_web_query(original)
        if web_q and re.search(r"web|search the|look up|google|news|latest", text):
            return (f"Searching the web for “{web_q}”…\n", [{"name": "web_search", "arguments": {"query": web_q}}])

        code = _extract_code(original)
        if code:
            return ("Let me run that in your workspace.", [{"name": "run_python", "arguments": {"code": code}}])

        note_topic = _extract_note_topic(original)
        if note_topic:
            path = self._note_path(note_topic)
            content = self._draft_note(note_topic)
            return (
                f"Good idea — I'll draft `{path}` now.\n",
                [{"name": "write_file", "arguments": {"path": path, "content": content}}],
            )

        path = _extract_path(original)
        if path and re.search(r"\b(read|open|show)\b", text):
            return (f"Opening `{path}`…\n", [{"name": "read_file", "arguments": {"path": path}}])

        search_q = _extract_search(original)
        if search_q and not re.search(r"web|online|google|news|latest|weather", text):
            return (f"Searching your workspace for “{search_q}”…\n",
                    [{"name": "search_workspace", "arguments": {"query": search_q}}])

        if re.search(r"(list|show)\s*(my\s+)?(files|workspace|notes|folder)|(what|which)\s+files|what'?s\s+in|show me (the|your)", text):
            return ("Let me take a look at your workspace.", [{"name": "list_workspace", "arguments": {}}])

        if "coffee" in text and not search_q:
            path = self._note_path("coffee habits")
            content = self._draft_note("coffee habits")
            return (f"Coffee! Let me capture that in `{path}`.\n",
                    [{"name": "write_file", "arguments": {"path": path, "content": content}}])

        return FALLBACK, []

    def _note_path(self, topic: str) -> str:
        slug = re.sub(r"[^a-z0-9]+", "-", topic.lower()).strip("-")[:40] or "note"
        return f"notes/{slug}.md"

    def _draft_note(self, topic: str) -> str:
        title = topic.strip().capitalize()
        return (
            f"# {title}\n\n"
            f"> Drafted by CortexSpace (demo model) — replace with your own details.\n\n"
            f"## What I know so far\n\n"
            f"- *(nothing yet — add bullet points as they come up)*\n\n"
            f"## Questions to answer\n\n"
            f"- [ ] What triggered the “{title}” note?\n"
            f"- [ ] What do I want to be true about {topic} in a month?\n"
            f"- [ ] What's the first small step?\n\n"
            f"## Log\n\n"
            f"- Today: created this note.\n"
        )

    @staticmethod
    async def _stream_text(text: str) -> AsyncIterator[Dict[str, Any]]:
        words = text.split(" ")
        buf: List[str] = []
        for i, w in enumerate(words):
            buf.append(w)
            if i % 2 == 1 or i == len(words) - 1:
                chunk = " ".join(buf)
                buf = []
                yield {"type": "delta", "text": chunk + (" " if i < len(words) - 1 else "")}
                await asyncio.sleep(0.012)

    async def stream(self, req: ChatRequest) -> AsyncIterator[Dict[str, Any]]:
        if _has_tool_results(req.messages):
            results = _tool_results(req.messages)
            final = _final_answer(_last_user_text(req.messages), results)
            async for ev in self._stream_text(final):
                yield ev
            yield {
                "type": "done",
                "usage": {
                    "prompt_tokens": sum(len(str(m.get("content", ""))) for m in req.messages) // 4,
                    "completion_tokens": len(final) // 4,
                },
                "finish": "stop",
            }
            return

        preamble, calls = await self._decide(req)
        if preamble:
            async for ev in self._stream_text(preamble):
                yield ev
        if calls:
            yield {
                "type": "tool_calls",
                "calls": [
                    {
                        "id": f"demo_{i + 1}",
                        "name": c["name"],
                        "arguments": c["arguments"],
                    }
                    for i, c in enumerate(calls)
                ],
            }
        yield {
            "type": "done",
            "usage": {
                "prompt_tokens": sum(len(str(m.get("content", ""))) for m in req.messages) // 4,
                "completion_tokens": len(preamble) // 4,
            },
            "finish": "tool_calls" if calls else "stop",
        }

    async def ping(self) -> tuple[bool, str]:
        return True, "built-in, always available"
