"""Agent loop: provider stream → tool calls (with approval gate) → results → repeat.

Yields SSE-ready event dicts:
    token            {"text"}
    assistant_start  {"message_id"}
    tool_call        {"id","name","arguments","description"}
    approval_request {"id","name","arguments","description"}
    approval_resolved{"id","decision"}
    tool_result      {"id","name","ok","output","duration_ms"}
    done             {"usage","iterations","duration_ms","model","provider"}
    error            {"message"}
"""
from __future__ import annotations

import asyncio
import time
import uuid
from typing import AsyncIterator, Dict, Optional

from . import tools
from .config import Settings, get_settings_holder
from .db import DB
from .providers import Provider, get_provider
from .providers.base import ChatRequest

APPROVAL_TIMEOUT_S = 10 * 60

# id -> {"event": asyncio.Event, "decision": Optional[str], "spec_name": str}
_approvals: Dict[str, dict] = {}


def register_approval(spec_name: str) -> str:
    aid = f"ap_{uuid.uuid4().hex[:12]}"
    _approvals[aid] = {"event": asyncio.Event(), "decision": None, "spec_name": spec_name}
    return aid


def resolve_approval(aid: str, decision: str) -> bool:
    a = _approvals.get(aid)
    if not a:
        return False
    a["decision"] = decision
    a["event"].set()
    return True


def cancel_all_approvals(decision: str = "denied") -> None:
    for a in _approvals.values():
        if a["decision"] is None:
            a["decision"] = decision
            a["event"].set()


async def _await_approval(aid: str, spec_name: str) -> Optional[str]:
    a = _approvals.get(aid)
    if not a:
        return "denied"
    try:
        await asyncio.wait_for(a["event"].wait(), timeout=APPROVAL_TIMEOUT_S)
    except asyncio.TimeoutError:
        a["decision"] = "timeout"
        return "timeout"
    return a["decision"] or "denied"


def _strip_tool_calls_for_prompt(messages: list) -> list:
    """Ollama accepts tool messages; OpenRouter too. Keep as-is (OpenAI style)."""
    return messages


async def run_agent(chat_id: str, db: DB, user_content: str, context_paths: list[str] | None = None,
                 model_override: str | None = None) -> AsyncIterator[Dict]:
    t0 = time.monotonic()
    settings_holder = get_settings_holder()
    s = settings_holder.get()
    provider: Provider = get_provider(s)
    model = (model_override or "").strip() or s.provider_model()
    ttft_ms: int | None = None  # time to first token

    # --- assemble prompt -------------------------------------------------
    messages: list[dict] = [{"role": "system", "content": s.system_prompt}]

    if context_paths:
        from . import worksp, webtools
        parts = [
            "The user attached context to this message. Workspace files and page text follow.",
        ]
        for p in context_paths[:6]:
            if p.startswith("page:"):
                url = p[len("page:"):]
                try:
                    res = await webtools.fetch_page(url)
                    parts.append(
                        f"--- page: {res['title']} ({res['final_url']}) ---\n{res['text'][:8000]}"
                    )
                except Exception as e:  # noqa: BLE001
                    parts.append(f"--- page: {url} ---\n[fetch failed: {e}]")
            else:
                try:
                    data = worksp.read_file(p, max_bytes=12_000)
                    if data["binary"]:
                        parts.append(f"--- {p} ---\n[binary file, no text content]")
                    else:
                        parts.append(f"--- {p} ---\n{data['content']}")
                except Exception as e:  # noqa: BLE001
                    parts.append(f"--- {p} ---\n[unreadable: {e}]")
        messages.append({"role": "system", "content": "\n\n".join(parts)})

    # history (skip the just-added user message which the caller appends next)
    for m in db.list_messages(chat_id):
        if m["role"] not in ("user", "assistant"):
            continue
        content = m["content"]
        meta = m.get("meta") or {}
        if m["role"] == "user":
            messages.append({"role": "user", "content": content})
        else:
            msg: dict = {"role": "assistant", "content": content}
            if meta.get("tool_calls"):
                msg["tool_calls"] = meta["tool_calls"]
            messages.append(msg)
            for tr in meta.get("tool_results", []):
                messages.append(
                    {"role": "tool", "tool_call_id": tr["id"], "content": tr["output"][:8000]}
                )

    messages.append({"role": "user", "content": user_content})

    tool_schemas = tools.schemas()
    if not s.allow_python:
        tool_schemas = [t for t in tool_schemas if t["function"]["name"] != "run_python"]
    disabled = set(s.disabled_tools or [])
    if disabled:
        tool_schemas = [t for t in tool_schemas if t["function"]["name"] not in disabled]
    usage_total = {"prompt_tokens": 0, "completion_tokens": 0}
    iterations = 0
    assistant_started = False
    final_text_parts: list[str] = []
    pending_tool_calls: list[dict] = []   # to persist on the assistant message
    pending_tool_results: list[dict] = []

    try:
        while iterations < s.max_steps:
            iterations += 1
            req = ChatRequest(
                messages=messages,
                tools=tool_schemas,
                model=model,
                temperature=s.temperature,
                max_tokens=s.max_tokens,
            )

            turn_text: list[str] = []
            turn_calls: list[dict] = []

            async for ev in provider.stream(req):
                etype = ev.get("type")
                if etype == "delta":
                    if not assistant_started:
                        assistant_started = True
                        if ttft_ms is None:
                            ttft_ms = int((time.monotonic() - t0) * 1000)
                        yield {"type": "assistant_start"}
                    yield {"type": "token", "text": ev["text"]}
                    turn_text.append(ev["text"])
                elif etype == "tool_calls":
                    turn_calls.extend(ev.get("calls") or [])
                elif etype == "done":
                    u = ev.get("usage") or {}
                    usage_total["prompt_tokens"] += int(u.get("prompt_tokens", 0))
                    usage_total["completion_tokens"] += int(u.get("completion_tokens", 0))

            if not turn_calls:
                messages.append({"role": "assistant", "content": "".join(turn_text)})
                break

            # record assistant message with tool_calls into the conversation
            messages.append(
                {
                    "role": "assistant",
                    "content": "".join(turn_text) or None,
                    "tool_calls": [
                        {
                            "id": c["id"],
                            "type": "function",
                            "function": {
                                "name": c["name"],
                                "arguments": c.get("arguments") or {},
                            },
                        }
                        for c in turn_calls
                    ],
                }
            )
            for c in turn_calls:
                pending_tool_calls.append(
                    {
                        "id": c["id"],
                        "function": {
                            "name": c["name"],
                            "arguments": c.get("arguments") or {},
                        },
                    }
                )

            # execute each tool (approval gate for dangerous ones)
            for c in turn_calls:
                spec = tools._BY_NAME.get(c["name"])
                desc = tools.describe(spec, c.get("arguments") or {}) if spec else f"{c['name']}"
                yield {
                    "type": "tool_call",
                    "id": c["id"],
                    "name": c["name"],
                    "arguments": c.get("arguments") or {},
                    "description": desc,
                }

                decision = "approved"
                if c["name"] in (s.disabled_tools or []):
                    out = f"[blocked] The {c['name']} tool is disabled in Settings."
                    yield {
                        "type": "tool_result",
                        "id": c["id"],
                        "name": c["name"],
                        "ok": False,
                        "output": out,
                        "duration_ms": 0,
                    }
                    messages.append({"role": "tool", "tool_call_id": c["id"], "content": out})
                    pending_tool_results.append({"id": c["id"], "name": c["name"], "ok": False, "output": out})
                    continue
                if spec and spec.dangerous and c["name"] == "run_python" and not s.allow_python:
                    out = "[blocked] Python execution is disabled. Enable it in Settings → Agent to allow the agent to run code."
                    yield {
                        "type": "tool_result",
                        "id": c["id"],
                        "name": c["name"],
                        "ok": False,
                        "output": out,
                        "duration_ms": 0,
                    }
                    messages.append({"role": "tool", "tool_call_id": c["id"], "content": out})
                    pending_tool_results.append({"id": c["id"], "name": c["name"], "ok": False, "output": out})
                    continue

                if spec and (spec.dangerous or s.strict_approve) and not s.auto_approve:
                    aid = register_approval(c["name"])
                    yield {
                        "type": "approval_request",
                        "id": aid,
                        "name": c["name"],
                        "arguments": c.get("arguments") or {},
                        "description": desc,
                    }
                    decision = await _await_approval(aid, c["name"])
                    yield {"type": "approval_resolved", "id": aid, "decision": decision}
                    if decision != "approved":
                        out = (
                            f"[skipped] the user {decision} this action. "
                            "Acknowledge briefly and continue without it."
                        )
                        messages.append({"role": "tool", "tool_call_id": c["id"], "content": out})
                        pending_tool_results.append({"id": c["id"], "name": c["name"], "ok": False, "output": out})
                        continue

                t_start = time.monotonic()
                out = await tools.execute(c["name"], c.get("arguments") or {})
                dur = int((time.monotonic() - t_start) * 1000)
                ok = not out.startswith("error")
                # keep context lean, UI shows the same (truncated) text
                out_trim = out[:16000]
                yield {
                    "type": "tool_result",
                    "id": c["id"],
                    "name": c["name"],
                    "ok": ok,
                    "output": out_trim,
                    "duration_ms": dur,
                }
                messages.append({"role": "tool", "tool_call_id": c["id"], "content": out_trim})
                pending_tool_results.append({"id": c["id"], "name": c["name"], "ok": ok, "output": out_trim})

        else:
            final_text_parts.append("\n\n_(stopped: max agent steps reached)_")

        # if the provider resolved a concrete model (e.g. Cortex LLMHoster
        # auto-picked the first loaded model), report the real one
        resolved = getattr(provider, "last_model", "") or ""
        if not model and resolved:
            model = resolved

        # persist the assistant turn
        content = "".join(final_text_parts)
        if not content and not pending_tool_calls:
            content = "…"
        meta = {
            "model": model,
            "provider": s.provider,
            "usage": usage_total,
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "ttft_ms": ttft_ms,
            "tool_calls": pending_tool_calls,
            "tool_results": pending_tool_results,
        }
        # NOTE: stream tokens were already forwarded live; the stored content
        # is the final assistant text accumulated across turns.
        db.add_message(chat_id, "assistant", _final_text(messages), meta)
        db.touch_chat(chat_id, provider=s.provider, model=model)

        yield {
            "type": "done",
            "usage": usage_total,
            "iterations": iterations,
            "duration_ms": int((time.monotonic() - t0) * 1000),
            "ttft_ms": ttft_ms,
            "model": model,
            "provider": s.provider,
        }
    except asyncio.CancelledError:
        # client stopped the stream — still save what we have
        try:
            db.add_message(chat_id, "assistant", _final_text(messages) or "_(stopped)_",
                           {"model": model, "provider": s.provider,
                            "usage": usage_total, "tool_calls": pending_tool_calls,
                            "tool_results": pending_tool_results, "stopped": True})
        except Exception:  # noqa: BLE001
            pass
        cancel_all_approvals("denied")
        raise
    except Exception as e:  # noqa: BLE001
        yield {"type": "error", "message": f"{type(e).__name__}: {e}"}
        raise


def _final_text(messages: list) -> str:
    """Accumulate visible assistant text from the final conversation state.

    We store only the *last* assistant turn's text (tool-carrying assistant
    messages are metadata), matching what the UI rendered as the final answer.
    """
    for m in reversed(messages):
        if m.get("role") == "assistant" and m.get("content"):
            return m["content"]
    return ""
