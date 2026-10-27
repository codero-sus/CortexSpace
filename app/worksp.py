"""Workspace file operations with strict path containment.

All paths are relative to WORKSPACE_DIR. Absolute paths and `..` are rejected,
and the resolved real path must stay inside the workspace root.
"""
from __future__ import annotations

import hashlib
import os
import shutil
import time
from dataclasses import dataclass
from typing import List, Optional

from .config import DATA_DIR, WORKSPACE_DIR

MAX_READ_BYTES = 400_000          # cap what tools may return into model context
MAX_PREVIEW_CHARS = 200_000


class WorkspaceError(Exception):
    pass


def _resolve(rel: str) -> str:
    rel = (rel or "").strip().lstrip("/")
    root = os.path.realpath(WORKSPACE_DIR)
    if not rel:
        return root
    full = os.path.realpath(os.path.join(root, rel))
    if full != root and not full.startswith(root + os.sep):
        raise WorkspaceError(f"Path escapes the workspace: {rel}")
    return full


def safe_join(rel: str) -> str:
    return _resolve(rel)


def to_rel(full: str) -> str:
    return os.path.relpath(full, WORKSPACE_DIR).replace(os.sep, "/")


@dataclass
class FileEntry:
    path: str
    name: str
    is_dir: bool
    size: int
    mtime: float


def list_dir(rel: str = "") -> List[FileEntry]:
    full = _resolve(rel)
    if not os.path.exists(full):
        raise WorkspaceError(f"Not found: {rel or '/'}")
    if not os.path.isdir(full):
        raise WorkspaceError(f"Not a directory: {rel}")
    entries: List[FileEntry] = []
    for name in sorted(os.listdir(full), key=lambda n: (not os.path.isdir(os.path.join(full, n)), n.lower())):
        if name.startswith("."):
            continue
        p = os.path.join(full, name)
        st = os.stat(p)
        entries.append(
            FileEntry(
                path=to_rel(p),
                name=name,
                is_dir=os.path.isdir(p),
                size=st.st_size,
                mtime=st.st_mtime,
            )
        )
    return entries


def tree(depth: int = 3) -> List[dict]:
    """Recursive tree for the sidebar (skips dotfiles, caps breadth)."""
    def walk(rel: str, d: int) -> List[dict]:
        out = []
        try:
            entries = list_dir(rel)
        except WorkspaceError:
            return out
        for e in entries[:200]:
            node = {"path": e.path, "name": e.name, "is_dir": e.is_dir, "size": e.size, "mtime": e.mtime}
            if e.is_dir and d < depth:
                node["children"] = walk(e.path, d + 1)
            out.append(node)
        return out
    return walk("", 1)


def read_file(rel: str, max_bytes: int = MAX_READ_BYTES) -> dict:
    full = _resolve(rel)
    if not os.path.isfile(full):
        raise WorkspaceError(f"Not a file: {rel}")
    size = os.path.getsize(full)
    raw = open(full, "rb").read(max_bytes + 1)
    truncated = len(raw) > max_bytes
    raw = raw[:max_bytes]
    try:
        text = raw.decode("utf-8")
        binary = False
    except UnicodeDecodeError:
        text = ""
        binary = True
    return {
        "path": rel,
        "size": size,
        "truncated": truncated,
        "binary": binary,
        "mtime": os.stat(full).st_mtime,
        "content": text,
    }


def write_file(rel: str, content: str, create_dirs: bool = True) -> dict:
    full = _resolve(rel)
    if os.path.exists(full) and os.path.isdir(full):
        raise WorkspaceError(f"Is a directory: {rel}")
    if create_dirs:
        os.makedirs(os.path.dirname(full) or WORKSPACE_DIR, exist_ok=True)
    save_version(rel)  # keep a snapshot of the previous content, if any
    with open(full, "w", encoding="utf-8") as f:
        f.write(content)
    return {"path": rel, "size": os.path.getsize(full)}


# ---------------------------------------------------------------------------
# File history (version snapshots on every write)
# ---------------------------------------------------------------------------

VERSIONS_DIR = os.path.join(DATA_DIR, "versions")
MAX_VERSIONS = 20


def _vdir(rel: str) -> str:
    h = hashlib.md5(rel.encode("utf-8")).hexdigest()
    return os.path.join(VERSIONS_DIR, h)


def save_version(rel: str) -> None:
    full = _resolve(rel)
    if not os.path.exists(full) or os.path.isdir(full):
        return
    try:
        with open(full, "r", encoding="utf-8") as f:
            content = f.read()
    except (UnicodeDecodeError, OSError):
        return
    vdir = _vdir(rel)
    os.makedirs(vdir, exist_ok=True)
    ts = int(time.time() * 1000)
    with open(os.path.join(vdir, f"{ts}.txt"), "w", encoding="utf-8") as f:
        f.write(content)
    # cap: keep the newest MAX_VERSIONS
    try:
        files = sorted(os.listdir(vdir))
        for old in files[: max(0, len(files) - MAX_VERSIONS)]:
            os.remove(os.path.join(vdir, old))
    except OSError:
        pass


def list_versions(rel: str) -> List[dict]:
    full = _resolve(rel)
    vdir = _vdir(rel)
    if not os.path.isdir(vdir) or not os.path.exists(full):
        return []
    out = []
    for name in sorted(os.listdir(vdir), reverse=True):
        if not name.endswith(".txt"):
            continue
        p = os.path.join(vdir, name)
        out.append(
            {
                "version": name[:-4],
                "size": os.path.getsize(p),
                "created_at": int(name[:-4]),
            }
        )
    return out


def read_version(rel: str, version: str) -> dict:
    _resolve(rel)  # validate path safety
    if not version.isdigit():
        raise WorkspaceError("Bad version id")
    p = os.path.join(_vdir(rel), version + ".txt")
    if not os.path.exists(p):
        raise WorkspaceError("Version not found")
    with open(p, "r", encoding="utf-8") as f:
        return {"path": rel, "version": version, "content": f.read()}


def restore_version(rel: str, version: str) -> dict:
    data = read_version(rel, version)
    return write_file(rel, data["content"])


def delete(rel: str) -> dict:
    full = _resolve(rel)
    if os.path.isdir(full):
        if full == os.path.realpath(WORKSPACE_DIR):
            raise WorkspaceError("Refusing to delete the workspace root")
        shutil.rmtree(full)
        kind = "dir"
    elif os.path.isfile(full):
        os.remove(full)
        kind = "file"
    else:
        raise WorkspaceError(f"Not found: {rel}")
    return {"path": rel, "deleted": kind}


def write_bytes(rel: str, data: bytes, create_dirs: bool = True) -> dict:
    full = _resolve(rel)
    if os.path.exists(full) and os.path.isdir(full):
        raise WorkspaceError(f"Is a directory: {rel}")
    if create_dirs:
        os.makedirs(os.path.dirname(full) or WORKSPACE_DIR, exist_ok=True)
    with open(full, "wb") as f:
        f.write(data)
    return {"path": rel, "size": os.path.getsize(full)}


def rename(src: str, dst: str) -> dict:
    s = _resolve(src)
    d = _resolve(dst)
    if not os.path.exists(s):
        raise WorkspaceError(f"Source not found: {src}")
    if os.path.exists(d):
        raise WorkspaceError(f"Target already exists: {dst}")
    parent = os.path.dirname(d)
    if not os.path.isdir(parent):
        raise WorkspaceError(f"Parent directory does not exist: {os.path.dirname(dst)}")
    shutil.move(s, d)
    return {"path": dst}


def make_dir(rel: str) -> dict:
    full = _resolve(rel)
    os.makedirs(full, exist_ok=True)
    return {"path": rel, "created": "dir"}


def search(query: str, max_results: int = 40, regex: bool = False,
           case_sensitive: bool = False, whole_word: bool = False,
           filename_only: bool = False) -> List[dict]:
    """Search across workspace text files. Supports regex / case / whole-word / filename-only."""
    import re as _re

    root = os.path.realpath(WORKSPACE_DIR)
    hits: List[dict] = []
    pat = None
    if regex:
        try:
            pat = _re.compile(query, 0 if case_sensitive else _re.IGNORECASE)
        except _re.error as e:
            raise WorkspaceError(f"Bad regex: {e.msg}")
    elif whole_word:
        flags = 0 if case_sensitive else _re.IGNORECASE
        pat = _re.compile(r"\b" + _re.escape(query) + r"\b", flags)
    q_low = query.lower()

    def line_match(line: str) -> bool:
        if pat is not None:
            return pat.search(line) is not None
        if case_sensitive:
            return query in line
        return q_low in line.lower()

    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if not d.startswith(".") and d not in {"node_modules", ".venv"}]
        for fn in filenames:
            if fn.startswith(".") or fn in {".DS_Store"}:
                continue
            fp = os.path.join(dirpath, fn)
            rel = to_rel(fp)
            if filename_only:
                if line_match(rel):
                    hits.append({"path": rel, "count": 1, "matches": []})
                if len(hits) >= max_results:
                    return hits
                continue
            try:
                if os.path.getsize(fp) > 512_000:
                    continue
                text = open(fp, "r", encoding="utf-8", errors="ignore").read()
            except OSError:
                continue
            lines = text.splitlines()
            if not any(line_match(l) for l in lines):
                continue
            matches = []
            for i, line in enumerate(lines):
                if line_match(line):
                    matches.append({"line": i + 1, "text": line.strip()[:200]})
                    if len(matches) >= 5:
                        break
            hits.append({"path": rel, "count": sum(1 for l in lines if line_match(l)), "matches": matches})
            if len(hits) >= max_results:
                return hits
    return hits


def word_count(text: str) -> int:
    return len(text.split())


def rel_or_none(rel: str) -> Optional[str]:
    try:
        return _resolve(rel)
    except WorkspaceError:
        return None


def human_size(n: int) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f}{unit}" if unit == "B" else f"{n:.1f}{unit}"
        n /= 1024
    return f"{n}B"
