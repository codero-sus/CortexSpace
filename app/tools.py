"""Agent tools: OpenAI-style schemas + executors.

Tools marked `dangerous=True` require an explicit user approval (UI card)
unless auto-approve is on in Settings — same trust model as Odysseus, but
the decision is always visible.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
import sys
import time
from dataclasses import dataclass, field
from typing import Any, Dict, List

from . import worksp, webtools


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: Dict[str, Any]
    dangerous: bool = False
    run: Any = None  # async fn(args: dict) -> str


# ---------------------------------------------------------------------------
# Executors
# ---------------------------------------------------------------------------

async def _list_workspace(args: dict) -> str:
    entries = worksp.list_dir(args.get("path", ""))
    if not entries:
        return "(directory is empty)"
    lines = []
    for e in entries:
        if e.is_dir:
            lines.append(f"📁 {e.path}/")
        else:
            lines.append(f"📄 {e.path}  ({worksp.human_size(e.size)})")
    return "\n".join(lines)


async def _read_file(args: dict) -> str:
    data = worksp.read_file(args["path"])
    if data["binary"]:
        return f"[binary file, {data['size']} bytes — no text content]"
    head = data["content"]
    note = f"\n[... truncated, {data['size']} bytes total]" if data["truncated"] else ""
    return f"# {args['path']}\n{head}{note}"


async def _write_file(args: dict) -> str:
    res = worksp.write_file(args["path"], args.get("content", ""))
    return f"Saved {res['path']} ({worksp.human_size(res['size'])})."


async def _delete_file(args: dict) -> str:
    res = worksp.delete(args["path"])
    return f"Deleted {res['deleted']} {res['path']}."


async def _search_workspace(args: dict) -> str:
    hits = worksp.search(args["query"], max_results=30)
    if not hits:
        return f"No matches for {args['query']!r}."
    out = [f"{len(hits)} file(s) match {args['query']!r}:"]
    for h in hits:
        out.append(f"\n## {h['path']}  ({h['count']} match(es))")
        for m in h["matches"]:
            out.append(f"  L{m['line']}: {m['text']}")
    return "\n".join(out)


async def _web_search(args: dict) -> str:
    from .config import SettingsStore, get_settings_holder
    s = get_settings_holder().get()
    res = await webtools.web_search(
        args["query"], searxng_url=s.searxng_url, ddg_enabled=s.ddg_enabled, max_results=6
    )
    out = [f"Web search ({res['engine']}) for {res['query']!r}:\n"]
    for i, r in enumerate(res["results"], 1):
        out.append(f"{i}. {r['title']}\n   {r['url']}\n   {r['snippet'][:240]}")
    return "\n".join(out)


async def _fetch_page(args: dict) -> str:
    res = await webtools.fetch_page(args["url"])
    return f"Title: {res['title']}\nURL: {res['final_url']}\n\n{res['text'][:12000]}"


async def _run_python(args: dict) -> str:
    code = args.get("code", "")
    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        sys.executable, "-I", "-c", code,
        stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
    try:
        out, err = await asyncio.wait_for(proc.communicate(), timeout=30)
    except asyncio.TimeoutError:
        proc.kill()
        return "[run_python timed out after 30s]"
    elapsed = int((time.monotonic() - started) * 1000)
    so = out.decode("utf-8", "replace")[:8000]
    se = err.decode("utf-8", "replace")[:4000]
    parts = [f"[exit {proc.returncode} in {elapsed}ms]"]
    if so:
        parts.append(f"stdout:\n{so}")
    if se:
        parts.append(f"stderr:\n{se}")
    return "\n".join(parts)


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

TOOLS: List[ToolSpec] = [
    ToolSpec(
        "list_workspace",
        "List files and folders in the user's workspace. path is optional, relative to the workspace root.",
        {"type": "object", "properties": {"path": {"type": "string"}}, "required": []},
        run=_list_workspace,
    ),
    ToolSpec(
        "read_file",
        "Read a text file from the workspace. Returns its content (truncated for very large files).",
        {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        run=_read_file,
    ),
    ToolSpec(
        "write_file",
        "Create or overwrite a file in the workspace. Parent folders are created automatically.",
        {
            "type": "object",
            "properties": {
                "path": {"type": "string"},
                "content": {"type": "string"},
            },
            "required": ["path", "content"],
        },
        dangerous=True,
        run=_write_file,
    ),
    ToolSpec(
        "delete_file",
        "Delete a file or folder from the workspace.",
        {"type": "object", "properties": {"path": {"type": "string"}}, "required": ["path"]},
        dangerous=True,
        run=_delete_file,
    ),
    ToolSpec(
        "search_workspace",
        "Case-insensitive text search across all workspace files. Returns matching files and lines.",
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        run=_search_workspace,
    ),
    ToolSpec(
        "web_search",
        "Search the web (DuckDuckGo, or a configured SearXNG instance). Returns titles, URLs and snippets.",
        {"type": "object", "properties": {"query": {"type": "string"}}, "required": ["query"]},
        run=_web_search,
    ),
    ToolSpec(
        "fetch_page",
        "Fetch a public web page and return its readable text (HTML stripped).",
        {"type": "object", "properties": {"url": {"type": "string"}}, "required": ["url"]},
        run=_fetch_page,
    ),
    ToolSpec(
        "run_python",
        "Run a short Python 3 script in the workspace directory (30s limit). Read-only by convention unless the user asked for changes.",
        {"type": "object", "properties": {"code": {"type": "string"}}, "required": ["code"]},
        dangerous=True,
        run=_run_python,
    ),
]

_BY_NAME = {t.name: t for t in TOOLS}


def schemas(include_dangerous: bool = True) -> List[Dict[str, Any]]:
    out = []
    for t in TOOLS:
        if t.dangerous and not include_dangerous:
            continue
        out.append(
            {
                "type": "function",
                "function": {
                    "name": t.name,
                    "description": t.description,
                    "parameters": t.parameters,
                },
            }
        )
    return out


def describe(spec: ToolSpec, args: dict) -> str:
    """Human-readable one-liner for the approval card / activity feed."""
    a = args or {}
    if spec.name == "write_file":
        size = len(a.get("content", ""))
        return f"Write {worksp.human_size(size)} to `{a.get('path','?')}`"
    if spec.name == "read_file":
        return f"Read `{a.get('path','?')}`"
    if spec.name == "list_workspace":
        return f"List `{a.get('path','') or 'workspace root'}`"
    if spec.name == "delete_file":
        return f"Delete `{a.get('path','?')}`"
    if spec.name == "search_workspace":
        return f"Search workspace for “{a.get('query','?')}”"
    if spec.name == "web_search":
        return f"Web search: {a.get('query','?')}"
    if spec.name == "fetch_page":
        return f"Fetch `{a.get('url','?')}`"
    if spec.name == "run_python":
        first = (a.get("code") or "").strip().splitlines()
        preview = first[0][:70] if first else "?"
        return f"Run Python ({len((a.get('code') or '').splitlines())} lines): {preview}"
    return f"{spec.name}({json.dumps(a)[:80]})"


async def execute(name: str, args: dict) -> str:
    spec = _BY_NAME.get(name)
    if spec is None:
        return f"error: unknown tool {name!r}"
    try:
        return await asyncio.wait_for(spec.run(args or {}), timeout=60)
    except Exception as e:  # noqa: BLE001
        return f"error: {type(e).__name__}: {e}"
