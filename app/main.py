"""MyWorkspace AI — FastAPI application.

One uvicorn process serves the JSON API and the static UI.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import shutil
import sys
import time
from typing import Optional

from fastapi import FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, PlainTextResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import agent, worksp
from .config import (
    DATA_DIR,
    Settings,
    WORKSPACE_DIR,
    data_path,
    get_settings_holder,
    init_settings_store,
)
from .db import DB, now_ms
from .providers import PROVIDER_IDS, ProviderError, PROVIDER_INFO, get_provider

VERSION = "1.0.0"
STATIC_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "static")
SEED_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "seed")


def _seed_workspace() -> None:
    """Copy seed files into an empty workspace on first boot."""
    marker = os.path.join(DATA_DIR, ".seeded")
    if os.path.exists(marker):
        return
    if os.path.isdir(SEED_DIR):
        for root, _dirs, files in os.walk(SEED_DIR):
            for fn in files:
                src = os.path.join(root, fn)
                rel = os.path.relpath(src, SEED_DIR)
                dst = os.path.join(WORKSPACE_DIR, rel)
                os.makedirs(os.path.dirname(dst), exist_ok=True)
                if not os.path.exists(dst):
                    shutil.copy2(src, dst)
    with open(marker, "w") as f:
        f.write("ok")


db = DB(data_path())
init_settings_store(db)
_seed_workspace()

app = FastAPI(title="MyWorkspace AI", version=VERSION)
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# ---------------------------------------------------------------------------
# Request log (dev): in-memory ring buffer of the last 200 API calls
# ---------------------------------------------------------------------------
import collections  # noqa: E402

REQUEST_LOG: "collections.deque" = collections.deque(maxlen=200)


@app.middleware("http")
async def _log_requests(request: Request, call_next):
    t0 = time.time()
    resp = await call_next(request)
    if request.url.path.startswith("/api/"):
        REQUEST_LOG.appendleft({
            "method": request.method,
            "path": request.url.path,
            "status": resp.status_code,
            "ms": round((time.time() - t0) * 1000),
            "at": now_ms(),
        })
        if len(REQUEST_LOG) > 200:
            REQUEST_LOG.pop()
    return resp


@app.get("/api/requests")
async def request_log(limit: int = 100):
    return {"requests": list(REQUEST_LOG)[: max(0, min(limit, 200))]}


# live SSE stream counter (for /api/sessions)
import threading  # noqa: E402

_stream_lock = threading.Lock()
_stream_count = 0
_process_start = time.time()


def _stream_bump(delta: int) -> None:
    global _stream_count
    with _stream_lock:
        _stream_count = max(0, _stream_count + delta)


# ---------------------------------------------------------------------------
# Pydantic models
# ---------------------------------------------------------------------------

class ChatCreate(BaseModel):
    title: Optional[str] = None
    provider: Optional[str] = None
    model: Optional[str] = None


class ChatRename(BaseModel):
    title: str


class ChatPin(BaseModel):
    pin: bool = True


class ChatFork(BaseModel):
    message_id: str | None = None


class FileRestoreIn(BaseModel):
    path: str
    version: str


class MessageIn(BaseModel):
    content: str
    context: Optional[list[str]] = None


class ApprovalIn(BaseModel):
    decision: str  # approved | denied


class FileWriteIn(BaseModel):
    path: str
    content: str


class FileMkdirIn(BaseModel):
    path: str


class FileRenameIn(BaseModel):
    src: str
    dst: str


class GlobalSearchIn(BaseModel):
    q: str
    regex: bool = False
    case_sensitive: bool = False
    whole_word: bool = False
    filename_only: bool = False
    scope: str = "all"  # all | chats | files


# ---------------------------------------------------------------------------
# Health / settings
# ---------------------------------------------------------------------------

@app.get("/api/health")
async def health():
    s = get_settings_holder().get()
    return {
        "ok": True,
        "version": VERSION,
        "provider": s.provider,
        "model": s.provider_model(),
        "workspace": WORKSPACE_DIR,
        "time_ms": now_ms(),
    }


@app.get("/api/providers")
async def providers_info():
    return {"providers": PROVIDER_INFO, "version": VERSION}


def _public_settings(s: Settings) -> dict:
    d = s.__dict__.copy()
    if d.get("openrouter_api_key"):
        d["openrouter_api_key"] = d["openrouter_api_key"]  # local app: keep visible for editing
    return d


@app.get("/api/settings")
async def get_settings():
    return _public_settings(get_settings_holder().get())


@app.put("/api/settings")
async def put_settings(patch: dict):
    s = get_settings_holder().update(patch)
    return _public_settings(s)


@app.get("/api/models")
async def list_models(provider: Optional[str] = None):
    s = get_settings_holder().get()
    pid = provider or s.provider
    p = get_provider(Settings(**{**s.__dict__, "provider": pid}))
    try:
        models = await p.list_models()
        ok, err = True, ""
    except Exception as e:  # noqa: BLE001
        models, ok, err = [], False, f"{type(e).__name__}: {e}"
    return {"provider": pid, "ok": ok, "error": err, "models": models}


@app.get("/api/providers/{pid}/ping")
async def ping_provider(pid: str):
    s = get_settings_holder().get()
    p = get_provider(Settings(**{**s.__dict__, "provider": pid}))
    ok, msg = await p.ping()
    return {"provider": pid, "ok": ok, "message": msg}


@app.get("/api/providers/status")
async def providers_status():
    """Ping every provider in parallel for the settings status dots."""
    s = get_settings_holder().get()
    async def one(pid: str):
        p = get_provider(Settings(**{**s.__dict__, "provider": pid}))
        ok, msg = await p.ping()
        return pid, {"ok": ok, "message": msg}
    results = await asyncio.gather(*(one(pid) for pid in PROVIDER_IDS))
    return {"status": dict(results)}


# ---------------------------------------------------------------------------
# Chats
# ---------------------------------------------------------------------------

@app.get("/api/chats")
async def chats_list():
    return {"chats": db.list_chats()}


@app.post("/api/chats")
async def chats_create(body: ChatCreate):
    cid = db.create_chat(
        title=body.title or "New chat",
        provider=body.provider or get_settings_holder().get().provider,
        model=body.model or get_settings_holder().get().provider_model(),
    )
    return {"id": cid}


@app.get("/api/chats/export-all")
async def chats_export_all():
    import io
    import zipfile

    buf = io.BytesIO()
    used: dict = {}
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for ch in db.list_chats():
            if not ch.get("preview") and ch["user_msgs"] == 0:
                continue
            cid = ch["id"]
            messages = db.list_messages(cid)
            when = time.strftime("%Y-%m-%d %H:%M", time.localtime(ch["updated_at"] / 1000))
            lines = [f"# {ch['title']}", "", f"> Exported from MyWorkspace AI · {when}", ""]
            for m in messages:
                if m["role"] == "user":
                    lines += ["## You", "", m["content"], ""]
                elif m["role"] == "assistant":
                    meta = m.get("meta") or {}
                    for c in meta.get("tool_calls", []):
                        fn = c.get("function", {})
                        lines.append(f"> 🔧 `{fn.get('name')}` — {json.dumps(fn.get('arguments', {}), ensure_ascii=False)[:160]}")
                    if m["content"]:
                        lines += ["## MyWorkspace AI", "", m["content"], ""]
            base = re.sub(r"[^A-Za-z0-9_\-]+", "-", ch["title"]).strip("-")[:60] or cid
            n = used.get(base, 0)
            used[base] = n + 1
            safe = base if n == 0 else f"{base}-{n + 1}"
            zf.writestr(f"{safe}.md", "\n".join(lines))
    data = buf.getvalue()
    return Response(content=data, media_type="application/zip",
                    headers={"Content-Disposition": 'attachment; filename="myworkspace-chats.zip"'})


@app.get("/api/chats/archived")
async def chats_archived():
    all_chats = db.list_chats(include_archived=True)
    return {"chats": [c for c in all_chats if c.get("archived")]}


@app.get("/api/chats/{cid}")
async def chat_get(cid: str):
    chat = db.get_chat(cid)
    if not chat:
        raise HTTPException(404, "chat not found")
    return {"chat": chat, "messages": db.list_messages(cid)}


@app.delete("/api/chats")
async def chats_delete_all():
    n = db.delete_all_chats()
    return {"ok": True, "deleted": n}


@app.delete("/api/chats/{cid}")
async def chat_delete(cid: str):
    db.delete_chat(cid)
    return {"ok": True}


@app.post("/api/chats/{cid}/rename")
async def chat_rename(cid: str, body: ChatRename):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    db.rename_chat(cid, body.title[:120])
    return {"ok": True}


@app.post("/api/chats/{cid}/pin")
async def chat_pin(cid: str, body: ChatPin):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    db.pin_chat(cid, body.pin)
    return {"ok": True, "pin": body.pin}


@app.post("/api/chats/{cid}/fork")
async def chat_fork(cid: str, body: ChatFork):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    new_cid = db.fork_chat(cid, body.message_id)
    if not new_cid:
        raise HTTPException(404, "cannot fork (unknown message)")
    return {"id": new_cid}


@app.get("/api/stats")
async def stats_endpoint(days: int = 14):
    days = max(7, min(90, days))
    import os as _os

    n_files = 0
    total_bytes = 0
    for _root, _dirs, files in _os.walk(WORKSPACE_DIR):
        for f in files:
            n_files += 1
            try:
                total_bytes += _os.path.getsize(_os.path.join(_root, f))
            except OSError:
                pass
    return {
        **db.stats(days),
        "workspace": {"files": n_files, "bytes": total_bytes},
    }


# ---------------------------------------------------------------------------
# The chat stream (SSE)
# ---------------------------------------------------------------------------

@app.post("/api/chats/{cid}/messages")
async def chat_send(cid: str, body: MessageIn):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    content = body.content.strip()
    if not content:
        raise HTTPException(400, "empty message")

    db.add_message(cid, "user", content, {"context": body.context or []})
    db.touch_chat(cid)

    # auto-title from first user message
    chat = db.get_chat(cid)
    if chat and chat["title"] in ("New chat", ""):
        db.rename_chat(cid, content[:60].replace("\n", " ").strip() or "New chat")

    async def gen():
        _stream_bump(+1)
        try:
            async for ev in agent.run_agent(cid, db, content, body.context):
                if ev["type"] == "done":
                    u = ev.get("usage") or {}
                    try:
                        db.record_usage(
                            cid,
                            ev.get("model", "") or "",
                            ev.get("provider", "") or "",
                            int(u.get("prompt_tokens", 0) or 0),
                            int(u.get("completion_tokens", 0) or 0),
                            int(ev.get("duration_ms", 0) or 0),
                        )
                    except Exception:  # noqa: BLE001
                        pass
                yield f"event: {ev['type']}\ndata: {json.dumps(ev, ensure_ascii=False)}\n\n"
        finally:
            _stream_bump(-1)

    return StreamingResponse(
        gen(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "X-Accel-Buffering": "no",
            "Connection": "keep-alive",
        },
    )


@app.post("/api/approvals/{aid}")
async def approvals(aid: str, body: ApprovalIn):
    if body.decision not in ("approved", "denied"):
        raise HTTPException(400, "decision must be approved|denied")
    if not agent.resolve_approval(aid, body.decision):
        raise HTTPException(404, "approval not found or already resolved")
    return {"ok": True, "id": aid, "decision": body.decision}


# ---------------------------------------------------------------------------
# Chat export
# ---------------------------------------------------------------------------

@app.get("/api/chats/{cid}/export")
async def chat_export(cid: str):
    chat = db.get_chat(cid)
    if not chat:
        raise HTTPException(404, "chat not found")
    messages = db.list_messages(cid)
    when = time.strftime("%Y-%m-%d %H:%M", time.localtime(chat["updated_at"] / 1000))
    lines = [
        f"# {chat['title']}",
        "",
        f"> Exported from MyWorkspace AI · {when} · {chat.get('provider') or '—'} · {chat.get('model') or '—'}",
        "",
    ]
    for m in messages:
        if m["role"] == "user":
            ctx = (m.get("meta") or {}).get("context") or []
            if ctx:
                lines.append(f"*Attached: {', '.join(ctx)}*")
            lines += ["## You", "", m["content"], ""]
        elif m["role"] == "assistant":
            lines += ["## MyWorkspace AI", ""]
            meta = m.get("meta") or {}
            for c in meta.get("tool_calls", []):
                fn = c.get("function", {})
                lines.append(f"> 🔧 `{fn.get('name')}` — {json.dumps(fn.get('arguments', {}), ensure_ascii=False)[:160]}")
            if m["content"]:
                lines += ["", m["content"], ""]
    name = re.sub(r"[^A-Za-z0-9_\-]+", "-", chat["title"]).strip("-")[:60] or "chat"
    return PlainTextResponse(
        "\n".join(lines),
        headers={"Content-Disposition": f'attachment; filename="{name}.md"'},
    )


@app.delete("/api/chats/{cid}/messages/{mid}")
async def chat_message_delete(cid: str, mid: str):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    if not db.delete_message(cid, mid):
        raise HTTPException(404, "message not found")
    return {"ok": True}


# ---------------------------------------------------------------------------
# Data: backup / import / maintenance / about
# ---------------------------------------------------------------------------

@app.get("/api/backup")
async def backup_export():
    data = db.export_backup()
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=1),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="myworkspace-backup-{int(time.time())}.json"'},
    )


@app.post("/api/backup")
async def backup_import(body: dict):
    try:
        result = db.import_backup(body)
    except Exception as e:  # noqa: BLE001
        raise HTTPException(400, f"Bad backup file: {e}")
    return {"ok": True, **result}


@app.post("/api/db/vacuum")
async def db_vacuum():
    db.vacuum()
    return {"ok": True}


@app.get("/api/about")
async def about():
    def dir_size(p: str) -> int:
        total = 0
        for root, _dirs, files in os.walk(p):
            for f in files:
                try:
                    total += os.path.getsize(os.path.join(root, f))
                except OSError:
                    pass
        return total

    db_size = os.path.getsize(db.path) if os.path.exists(db.path) else 0
    versions_dir = getattr(worksp, "VERSIONS_DIR", "")
    versions_size = dir_size(versions_dir) if versions_dir else 0
    ws_size = dir_size(WORKSPACE_DIR)
    s = get_settings_holder().get()
    return {
        "name": "MyWorkspace AI",
        "version": "1.0.0",
        "provider": s.provider,
        "model": s.provider_model(),
        "chats": len(db.list_chats()),
        "workspace_files": sum(1 for _r, _d, fs in os.walk(WORKSPACE_DIR) for _f in fs),
        "sizes": {
            "database": db_size,
            "workspace": ws_size,
            "versions": versions_size,
            "total": db_size + ws_size + versions_size,
        },
        "python": f"{sys.version_info.major}.{sys.version_info.minor}.{sys.version_info.micro}",
    }


# ---------------------------------------------------------------------------
# Wave 6: ops endpoints
# ---------------------------------------------------------------------------

@app.get("/api/uptime")
async def uptime():
    import resource
    ru = resource.getrusage(resource.RUSAGE_SELF)
    return {
        "uptime_s": round(time.time() - _process_start, 1),
        "requests": len(REQUEST_LOG),
        "memory_mb": round(ru.ru_maxrss / 1024, 1),
        "active_streams": _stream_count,
        "version": VERSION,
    }


@app.get("/api/sessions")
async def sessions():
    return {"active_streams": _stream_count, "logged_requests": len(REQUEST_LOG)}


@app.get("/api/workspace/info")
async def workspace_info():
    by_ext: dict = {}
    largest, recent, empty_dirs = [], [], []
    total_files = total_dirs = total_bytes = 0
    for root, dirs, files in os.walk(WORKSPACE_DIR):
        rel_root = os.path.relpath(root, WORKSPACE_DIR)
        if not files and not dirs and rel_root != ".":
            empty_dirs.append(rel_root.replace(os.sep, "/"))
        total_dirs += len(dirs)
        for f in files:
            if f.startswith("."):
                continue
            fp = os.path.join(root, f)
            try:
                st = os.stat(fp)
            except OSError:
                continue
            total_files += 1
            total_bytes += st.st_size
            ext = os.path.splitext(f)[1].lower() or "(none)"
            e = by_ext.setdefault(ext, {"count": 0, "bytes": 0})
            e["count"] += 1
            e["bytes"] += st.st_size
            rel = os.path.relpath(fp, WORKSPACE_DIR).replace(os.sep, "/")
            largest.append((rel, st.st_size))
            recent.append((rel, st.st_mtime, st.st_size))
    largest.sort(key=lambda x: -x[1])
    recent.sort(key=lambda x: -x[1])
    return {
        "files": total_files,
        "dirs": total_dirs,
        "bytes": total_bytes,
        "by_ext": dict(sorted(by_ext.items(), key=lambda kv: -kv[1]["bytes"])),
        "largest": [{"path": r, "size": s} for r, s in largest[:10]],
        "recent": [{"path": r, "mtime": int(m * 1000), "size": s} for r, m, s in recent[:10]],
        "empty_dirs": empty_dirs[:20],
    }


@app.post("/api/workspace/cleanup")
async def workspace_cleanup():
    removed = []
    for root, dirs, files in os.walk(WORKSPACE_DIR, topdown=False):
        for d in dirs:
            full = os.path.join(root, d)
            try:
                if not os.listdir(full):
                    os.rmdir(full)
                    removed.append(os.path.relpath(full, WORKSPACE_DIR).replace(os.sep, "/"))
            except OSError:
                pass
    return {"ok": True, "removed": removed}


class SettingsPresetIn(BaseModel):
    name: str


PRESETS = {
    "local-first": {"provider": "demo", "temperature": 0.4, "max_steps": 10,
                    "auto_approve": False, "ddg_enabled": False},
    "cautious": {"provider": "demo", "temperature": 0.2, "max_steps": 6,
                 "auto_approve": False, "strict_approve": True, "allow_python": False,
                 "ddg_enabled": False},
    "turbo": {"provider": "demo", "temperature": 0.8, "max_steps": 16,
              "auto_approve": True, "max_tokens": 4096},
    "cloud-power": {"provider": "openrouter", "temperature": 0.7, "max_steps": 16,
                    "auto_approve": True, "max_tokens": 8192, "ddg_enabled": True},
}


@app.post("/api/settings/preset")
async def settings_preset(body: SettingsPresetIn):
    preset = PRESETS.get(body.name)
    if not preset:
        raise HTTPException(400, "unknown preset; options: " + ", ".join(PRESETS))
    s = get_settings_holder().update(preset)
    return _public_settings(s)


class ChatArchiveIn(BaseModel):
    archived: bool = True


@app.post("/api/chats/{cid}/archive")
async def chat_archive(cid: str, body: ChatArchiveIn):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    db.archive_chat(cid, body.archived)
    return {"ok": True, "archived": body.archived}


@app.get("/api/chats/{cid}/export/json")
async def chat_export_json(cid: str):
    if not db.get_chat(cid):
        raise HTTPException(404, "chat not found")
    chat = db.get_chat(cid)
    data = {"app": "myworkspace-ai", "format": "chat-json", "version": 1,
            "chat": chat, "messages": db.list_messages(cid)}
    safe = re.sub(r"[^A-Za-z0-9_\-]+", "-", chat["title"]).strip("-")[:60] or cid
    return Response(
        content=json.dumps(data, ensure_ascii=False, indent=1),
        media_type="application/json",
        headers={"Content-Disposition": f'attachment; filename="{safe}.json"'},
    )





# ---------------------------------------------------------------------------
# Global search (chats + workspace files)
# ---------------------------------------------------------------------------

@app.post("/api/search/global")
async def search_global(body: GlobalSearchIn):
    q = body.q.strip()
    if not q:
        return {"chats": [], "files": [], "total_chats": 0, "total_files": 0}
    chats = []
    files = []
    if body.scope in ("all", "chats"):
        try:
            chats = db.search_messages(q, limit=10, regex=body.regex,
                                       case_sensitive=body.case_sensitive,
                                       whole_word=body.whole_word)
        except Exception:  # noqa: BLE001
            chats = []
    if body.scope in ("all", "files"):
        try:
            files = worksp.search(q, max_results=10, regex=body.regex,
                                  case_sensitive=body.case_sensitive,
                                  whole_word=body.whole_word,
                                  filename_only=body.filename_only)
        except worksp.WorkspaceError as e:
            raise HTTPException(400, str(e))
    total_chats = sum(c["count"] for c in chats)
    total_files = sum(f["count"] for f in files)
    return {"chats": chats, "files": files, "query": q,
            "total_chats": total_chats, "total_files": total_files}


# ---------------------------------------------------------------------------
# Workspace files
# ---------------------------------------------------------------------------

def _fs_error(e: Exception) -> HTTPException:
    if isinstance(e, worksp.WorkspaceError):
        return HTTPException(400, str(e))
    return HTTPException(500, f"{type(e).__name__}: {e}")


@app.get("/api/files")
async def files_tree():
    return {"tree": worksp.tree(depth=4)}


@app.get("/api/files/entries")
async def files_entries(path: str = ""):
    try:
        entries = worksp.list_dir(path)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)
    return {
        "entries": [
            {"path": e.path, "name": e.name, "is_dir": e.is_dir, "size": e.size, "mtime": e.mtime}
            for e in entries
        ]
    }


@app.get("/api/files/read")
async def files_read(path: str):
    try:
        return worksp.read_file(path)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.put("/api/files/write")
async def files_write(body: FileWriteIn):
    try:
        res = worksp.write_file(body.path, body.content)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)
    return res


@app.post("/api/files/mkdir")
async def files_mkdir(body: FileMkdirIn):
    try:
        return worksp.make_dir(body.path)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.get("/api/files/history")
async def files_history(path: str):
    try:
        return {"versions": worksp.list_versions(path)}
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.get("/api/files/history/{version}")
async def files_history_get(path: str, version: str):
    try:
        return worksp.read_version(path, version)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.post("/api/files/restore")
async def files_restore(body: FileRestoreIn):
    try:
        return worksp.restore_version(body.path, body.version)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.post("/api/files/rename")
async def files_rename(body: FileRenameIn):
    try:
        return worksp.rename(body.src, body.dst)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.post("/api/files/upload")
async def files_upload(file: UploadFile = File(...), dir: str = Form("")):
    raw_name = os.path.basename(file.filename or "upload.bin").strip()
    name = re.sub(r"[^A-Za-z0-9_\-. ]", "_", raw_name)[:120] or "upload.bin"
    rel_dir = (dir or "").strip().strip("/")
    if rel_dir and ".." in rel_dir.split("/"):
        raise HTTPException(400, "invalid directory")
    rel = f"{rel_dir}/{name}" if rel_dir else name
    data = await file.read(25 * 1024 * 1024)  # 25MB cap
    if len(data) > 25 * 1024 * 1024:
        raise HTTPException(413, "file too large (25MB cap)")
    try:
        res = worksp.write_bytes(rel, data)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)
    res["uploaded"] = True
    return res


@app.get("/api/workspace/zip")
async def workspace_zip():
    import io
    import zipfile

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED) as zf:
        for root, _dirs, files in os.walk(WORKSPACE_DIR):
            for fn in files:
                full = os.path.join(root, fn)
                rel = os.path.relpath(full, WORKSPACE_DIR)
                zf.write(full, rel)
    data = buf.getvalue()
    return Response(
        content=data,
        media_type="application/zip",
        headers={"Content-Disposition": 'attachment; filename="myworkspace-files.zip"'},
    )


@app.delete("/api/workspace")
async def workspace_reset():
    import shutil as _shutil

    n_files = 0
    try:
        for _root, _dirs, files in os.walk(WORKSPACE_DIR):
            for f in files:
                try:
                    os.remove(os.path.join(_root, f))
                    n_files += 1
                except OSError:
                    pass
        for d in list(_dirs):
            try:
                _shutil.rmtree(os.path.join(_root, d), ignore_errors=True)
            except Exception:  # noqa: BLE001
                pass
    except Exception:  # noqa: BLE001
        pass
    vdir = getattr(worksp, "VERSIONS_DIR", None)
    if vdir and os.path.isdir(vdir):
        _shutil.rmtree(vdir, ignore_errors=True)
    return {"ok": True, "deleted_files": n_files}


@app.get("/api/files/raw")
async def file_raw(path: str):
    try:
        full = worksp._resolve(path)
    except worksp.WorkspaceError as e:
        raise HTTPException(400, str(e))
    if not os.path.isfile(full):
        raise HTTPException(404, "not a file")
    with open(full, "rb") as f:
        data = f.read(8 * 1024 * 1024)
    ext = os.path.splitext(full)[1].lower()
    mimes = {
        ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml",
        ".txt": "text/plain", ".md": "text/markdown", ".json": "application/json",
        ".css": "text/css", ".js": "application/javascript", ".html": "text/html",
        ".pdf": "application/pdf", ".zip": "application/zip",
    }
    return Response(
        content=data,
        media_type=mimes.get(ext, "application/octet-stream"),
        headers={"Content-Disposition": f'inline; filename="{os.path.basename(full)}"'},
    )


@app.delete("/api/files")
async def files_delete(path: str):
    try:
        return worksp.delete(path)
    except Exception as e:  # noqa: BLE001
        raise _fs_error(e)


@app.post("/api/files/search")
async def files_search(body: dict):
    q = (body.get("query") or "").strip()
    if not q:
        return {"hits": []}
    return {"hits": worksp.search(q, max_results=30)}


# ---------------------------------------------------------------------------
# Browser / page tools
# ---------------------------------------------------------------------------

@app.get("/api/page")
async def page_fetch(url: str):
    from . import webtools

    if not url:
        raise HTTPException(400, "url required")
    try:
        return await webtools.fetch_page(url)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


@app.get("/api/search")
async def search_endpoint(q: str):
    from . import webtools

    s = get_settings_holder().get()
    try:
        return await webtools.web_search(q, searxng_url=s.searxng_url, ddg_enabled=s.ddg_enabled)
    except Exception as e:  # noqa: BLE001
        return JSONResponse({"error": str(e)}, status_code=400)


# ---------------------------------------------------------------------------
# Static UI
# ---------------------------------------------------------------------------

app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
async def index():
    return FileResponse(os.path.join(STATIC_DIR, "index.html"))


@app.get("/favicon.ico")
async def favicon():
    return FileResponse(os.path.join(STATIC_DIR, "favicon.svg"))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8787)
