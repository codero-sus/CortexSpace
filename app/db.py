"""SQLite persistence layer (stdlib only — no ORM, no migrations needed)."""
from __future__ import annotations

import json
import os
import sqlite3
import threading
import time
import uuid
from typing import Dict


def now_ms() -> int:
    return int(time.time() * 1000)


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex[:16]}"


class DB:
    def __init__(self, path: str):
        self.path = path
        os.makedirs(os.path.dirname(path), exist_ok=True)
        self._local = threading.local()
        self._init_schema()

    def _conn(self) -> sqlite3.Connection:
        conn = getattr(self._local, "conn", None)
        if conn is None:
            conn = sqlite3.connect(self.path, check_same_thread=False)
            conn.row_factory = sqlite3.Row
            conn.execute("PRAGMA journal_mode=WAL")
            conn.execute("PRAGMA foreign_keys=ON")
            self._local.conn = conn
        return conn

    def _init_schema(self) -> None:
        c = self._conn()
        c.executescript(
            """
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL DEFAULT 'New chat',
                provider TEXT,
                model TEXT,
                created_at INTEGER NOT NULL,
                updated_at INTEGER NOT NULL,
                pin INTEGER NOT NULL DEFAULT 0
            );
            CREATE TABLE IF NOT EXISTS messages (
                id TEXT PRIMARY KEY,
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                seq INTEGER NOT NULL,
                role TEXT NOT NULL,
                content TEXT NOT NULL DEFAULT '',
                meta TEXT,
                created_at INTEGER NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, seq);
            CREATE TABLE IF NOT EXISTS settings (
                key TEXT PRIMARY KEY,
                value TEXT
            );
            CREATE TABLE IF NOT EXISTS usage_log (
                id TEXT PRIMARY KEY,
                chat_id TEXT,
                model TEXT,
                provider TEXT,
                prompt_tokens INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            CREATE TABLE IF NOT EXISTS bench (
                id TEXT PRIMARY KEY,
                provider TEXT NOT NULL,
                model TEXT NOT NULL,
                ttft_ms INTEGER,
                duration_ms INTEGER NOT NULL DEFAULT 0,
                completion_tokens INTEGER NOT NULL DEFAULT 0,
                created_at INTEGER NOT NULL
            );
            """
        )
        # light migration: add columns to pre-existing databases
        for stmt in (
            "ALTER TABLE chats ADD COLUMN pin INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE chats ADD COLUMN archived INTEGER NOT NULL DEFAULT 0",
        ):
            try:
                c.execute(stmt)
            except sqlite3.OperationalError:
                pass
        c.commit()

    # --- settings -------------------------------------------------------
    def get_setting(self, key: str):
        row = self._conn().execute(
            "SELECT value FROM settings WHERE key=?", (key,)
        ).fetchone()
        return row["value"] if row else None

    def set_setting(self, key: str, value: str) -> None:
        c = self._conn()
        c.execute(
            "INSERT INTO settings(key,value) VALUES(?,?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )
        c.commit()

    # --- chats ----------------------------------------------------------
    def create_chat(self, title: str = "New chat", provider: str = "", model: str = "") -> str:
        cid = new_id("c_")
        c = self._conn()
        c.execute(
            "INSERT INTO chats(id,title,provider,model,created_at,updated_at) VALUES(?,?,?,?,?,?)",
            (cid, title, provider, model, now_ms(), now_ms()),
        )
        c.commit()
        return cid

    def list_chats(self, include_archived: bool = False):
        where = "" if include_archived else "WHERE c.archived=0"
        rows = self._conn().execute(
            f"""
            SELECT c.id, c.title, c.provider, c.model, c.created_at, c.updated_at, c.pin, c.archived,
                   (SELECT COUNT(*) FROM messages m WHERE m.chat_id=c.id AND m.role='user') AS user_msgs
            FROM chats c {where} ORDER BY c.pin DESC, c.updated_at DESC
            """
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            prev = self._conn().execute(
                "SELECT content FROM messages WHERE chat_id=? AND role IN ('user','assistant') "
                "ORDER BY seq DESC LIMIT 1",
                (r["id"],),
            ).fetchone()
            d["preview"] = (prev["content"][:120].replace("\n", " ").strip() if prev else "")
            out.append(d)
        return out

    def get_chat(self, cid: str):
        row = self._conn().execute("SELECT * FROM chats WHERE id=?", (cid,)).fetchone()
        return dict(row) if row else None

    def rename_chat(self, cid: str, title: str) -> None:
        c = self._conn()
        c.execute("UPDATE chats SET title=?, updated_at=? WHERE id=?", (title, now_ms(), cid))
        c.commit()

    def pin_chat(self, cid: str, pin: bool) -> None:
        c = self._conn()
        c.execute("UPDATE chats SET pin=? WHERE id=?", (1 if pin else 0, cid))
        c.commit()

    def auto_title(self, cid: str, text: str) -> None:
        """Give a fresh 'New chat' a title from its first user message."""
        c = self._conn()
        row = c.execute("SELECT title FROM chats WHERE id=?", (cid,)).fetchone()
        if not row or row["title"] not in ("New chat", ""):
            return
        title = " ".join(text.split())[:60] or "New chat"
        if len(" ".join(text.split())) > 60:
            title += "…"
        c.execute("UPDATE chats SET title=? WHERE id=?", (title, cid))
        c.commit()

    def fork_chat(self, src_cid: str, upto_mid: str | None = None) -> str | None:
        """Copy a chat (optionally truncated at a message) into a new chat."""
        c = self._conn()
        src = c.execute("SELECT * FROM chats WHERE id=?", (src_cid,)).fetchone()
        if not src:
            return None
        if upto_mid:
            mrow = c.execute(
                "SELECT seq FROM messages WHERE id=? AND chat_id=?", (upto_mid, src_cid)
            ).fetchone()
            if not mrow:
                return None
            seq_cut = mrow["seq"]
        else:
            seq_cut = None
        new_cid = new_id("c_")
        c.execute(
            "INSERT INTO chats(id,title,provider,model,created_at,updated_at,pin) VALUES(?,?,?,?,?,?,0)",
            (new_cid, src["title"] + " (fork)", src["provider"], src["model"], now_ms(), now_ms()),
        )
        q = "SELECT * FROM messages WHERE chat_id=?"
        args: list = [src_cid]
        if seq_cut is not None:
            q += " AND seq <= ?"
            args.append(seq_cut)
        q += " ORDER BY seq"
        for r in c.execute(q, args).fetchall():
            c.execute(
                "INSERT INTO messages(id,chat_id,seq,role,content,meta,created_at) VALUES(?,?,?,?,?,?,?)",
                (new_id("m_"), new_cid, r["seq"], r["role"], r["content"], r["meta"], now_ms()),
            )
        c.commit()
        return new_cid

    def search_messages(self, q: str, limit: int = 20, regex: bool = False,
                        case_sensitive: bool = False, whole_word: bool = False) -> list[dict]:
        """Full-text-ish search across chat messages; grouped per chat with a snippet."""
        c = self._conn()
        if regex:
            import re as _re
            try:
                pat = _re.compile(q, 0 if case_sensitive else _re.IGNORECASE)
            except _re.error:
                pat = None
            rows = c.execute(
                """
                SELECT m.chat_id, m.content, m.role, m.created_at,
                       (SELECT title FROM chats c WHERE c.id = m.chat_id) AS chat_title
                FROM messages m
                WHERE m.role IN ('user','assistant')
                ORDER BY m.created_at DESC
                LIMIT 400
                """,
            ).fetchall()
            if pat is not None:
                rows = [r for r in rows if pat.search(r["content"])]
            rows = rows[: limit * 2]
            finder = (lambda s, qq=q: (m := pat.search(s)) and m.start()) if pat else None
        else:
            esc_q = q.replace("%", r"\%").replace("_", r"\_")
            like = f"%{esc_q}%"
            if not case_sensitive:
                like_sql = f"LOWER(m.content) LIKE LOWER(?)"
            else:
                # SQLite LIKE is case-insensitive for ASCII; instr() is not
                like_sql = "instr(m.content, ?) > 0"
                like = q  # instr takes the raw needle, no % wrapping
            rows = c.execute(
                f"""
                SELECT m.chat_id, m.content, m.role, m.created_at,
                       (SELECT title FROM chats c WHERE c.id = m.chat_id) AS chat_title
                FROM messages m
                WHERE {like_sql} AND m.role IN ('user','assistant')
                ORDER BY m.created_at DESC
                LIMIT ?
                """,
                (like, limit * 2),
            ).fetchall()
            finder = lambda s, qq=q: s.lower().find(qq.lower())  # noqa: E731
            if case_sensitive:
                finder = lambda s, qq=q: s.find(qq)  # noqa: E731
        by_chat: Dict[str, dict] = {}
        for r in rows:
            content = r["content"]
            pos = finder(content) if finder else 0
            pos = max(0, pos or 0)
            entry = by_chat.setdefault(
                r["chat_id"],
                {"id": r["chat_id"], "title": r["chat_title"], "count": 0, "snippet": "", "created_at": 0},
            )
            entry["count"] += 1
            entry["created_at"] = max(entry["created_at"], r["created_at"])
            if not entry["snippet"]:
                start = max(0, pos - 40)
                entry["snippet"] = ("…" if start > 0 else "") + content[start:pos + 120].replace("\n", " ")
        return list(by_chat.values())[:limit]

    def archive_chat(self, cid: str, archived: bool) -> bool:
        cur = self._conn().execute(
            "UPDATE chats SET archived=? WHERE id=?", (1 if archived else 0, cid)
        )
        self._conn().commit()
        return cur.rowcount > 0

    def delete_chat(self, cid: str) -> None:
        c = self._conn()
        c.execute("DELETE FROM chats WHERE id=?", (cid,))
        c.commit()

    def delete_all_chats(self) -> int:
        c = self._conn()
        n = c.execute("SELECT COUNT(*) n FROM chats").fetchone()["n"]
        c.execute("DELETE FROM chats")
        c.execute("DELETE FROM usage_log")
        c.commit()
        return n

    def delete_message(self, cid: str, mid: str) -> bool:
        c = self._conn()
        cur = c.execute("DELETE FROM messages WHERE id=? AND chat_id=?", (mid, cid))
        c.commit()
        return cur.rowcount > 0

    def update_message(self, cid: str, mid: str, content: str) -> bool:
        """Edit the text of a user message in place (Edit & resend flow)."""
        c = self._conn()
        cur = c.execute(
            "UPDATE messages SET content=? WHERE id=? AND chat_id=? AND role='user'",
            (content, mid, cid),
        )
        if cur.rowcount:
            self.touch_chat(cid)
            c.commit()
        return cur.rowcount > 0

    def record_bench(self, provider: str, model: str, ttft_ms: int | None,
                     duration_ms: int, completion_tokens: int) -> None:
        """Keep a rolling speed ledger (last 400 runs) for the Measured speed card."""
        c = self._conn()
        c.execute(
            "INSERT INTO bench(id, provider, model, ttft_ms, duration_ms, completion_tokens, created_at)"
            " VALUES(?,?,?,?,?,?,?)",
            (f"b_{uuid.uuid4().hex[:12]}", provider, model, ttft_ms,
             int(duration_ms or 0), int(completion_tokens or 0), now_ms()),
        )
        c.execute(
            "DELETE FROM bench WHERE id NOT IN (SELECT id FROM bench ORDER BY created_at DESC LIMIT 400)"
        )
        c.commit()

    def bench_summary(self) -> list:
        """Per provider/model: runs, avg TTFT, avg tokens/s."""
        c = self._conn()
        rows = c.execute(
            """
            SELECT provider, model,
                   COUNT(*) AS runs,
                   AVG(ttft_ms) AS avg_ttft,
                   AVG(CASE WHEN duration_ms > 0 AND completion_tokens > 0
                            THEN completion_tokens * 1000.0 / duration_ms END) AS avg_tps
            FROM bench GROUP BY provider, model
            ORDER BY avg_tps DESC
            """
        ).fetchall()
        out = []
        for r in rows:
            out.append({
                "provider": r["provider"],
                "model": r["model"],
                "runs": r["runs"],
                "avg_ttft_ms": round(r["avg_ttft"], 0) if r["avg_ttft"] is not None else None,
                "avg_tps": round(r["avg_tps"], 1) if r["avg_tps"] is not None else None,
            })
        return out

    def export_backup(self) -> dict:
        c = self._conn()
        chats = []
        for r in c.execute("SELECT * FROM chats ORDER BY created_at").fetchall():
            chat = dict(r)
            chat["messages"] = [dict(m) for m in c.execute(
                "SELECT * FROM messages WHERE chat_id=? ORDER BY seq", (r["id"],)
            ).fetchall()]
            chats.append(chat)
        settings = {r["key"]: r["value"] for r in c.execute("SELECT key,value FROM settings").fetchall()}
        return {
            "app": "cortexspace",
            "version": 1,
            "exported_at": now_ms(),
            "chats": chats,
            "settings": settings,
        }

    def import_backup(self, data: dict) -> dict:
        c = self._conn()
        imported = 0
        for ch in data.get("chats", []):
            if not isinstance(ch, dict) or not ch.get("id"):
                continue
            exists = c.execute("SELECT 1 FROM chats WHERE id=?", (ch["id"],)).fetchone()
            if exists:
                continue
            c.execute(
                "INSERT INTO chats(id,title,provider,model,created_at,updated_at,pin) VALUES(?,?,?,?,?,?,?)",
                (
                    ch["id"], ch.get("title", "Imported chat"), ch.get("provider") or "",
                    ch.get("model") or "", ch.get("created_at") or now_ms(),
                    ch.get("updated_at") or now_ms(), 1 if ch.get("pin") else 0,
                ),
            )
            for m in ch.get("messages", []):
                if not isinstance(m, dict) or not m.get("id"):
                    continue
                try:
                    meta = m.get("meta")
                    meta_json = meta if isinstance(meta, str) else json.dumps(meta or {})
                except Exception:
                    meta_json = "{}"
                c.execute(
                    "INSERT OR IGNORE INTO messages(id,chat_id,seq,role,content,meta,created_at) VALUES(?,?,?,?,?,?,?)",
                    (m["id"], ch["id"], m.get("seq") or imported, m.get("role", "user"),
                     m.get("content", ""), meta_json, m.get("created_at") or now_ms()),
                )
            imported += 1
        c.commit()
        return {"imported": imported}

    def vacuum(self) -> None:
        c = self._conn()
        c.execute("VACUUM")

    def touch_chat(self, cid: str, provider: str = None, model: str = None) -> None:
        c = self._conn()
        c.execute(
            "UPDATE chats SET updated_at=?, provider=COALESCE(?,provider), model=COALESCE(?,model) WHERE id=?",
            (now_ms(), provider, model, cid),
        )
        c.commit()

    # --- messages -------------------------------------------------------
    def next_seq(self, cid: str) -> int:
        row = self._conn().execute(
            "SELECT COALESCE(MAX(seq),0)+1 AS n FROM messages WHERE chat_id=?", (cid,)
        ).fetchone()
        return int(row["n"])

    def add_message(self, cid: str, role: str, content: str, meta: dict | None = None) -> str:
        mid = new_id("m_")
        c = self._conn()
        c.execute(
            "INSERT INTO messages(id,chat_id,seq,role,content,meta,created_at) VALUES(?,?,?,?,?,?,?)",
            (mid, cid, self.next_seq(cid), role, content, json.dumps(meta or {}), now_ms()),
        )
        c.commit()
        return mid

    def list_messages(self, cid: str):
        rows = self._conn().execute(
            "SELECT * FROM messages WHERE chat_id=? ORDER BY seq", (cid,)
        ).fetchall()
        out = []
        for r in rows:
            d = dict(r)
            try:
                d["meta"] = json.loads(d.get("meta") or "{}")
            except Exception:
                d["meta"] = {}
            out.append(d)
        return out

    # --- usage & stats ---------------------------------------------------
    def record_usage(self, chat_id: str, model: str, provider: str,
                     prompt_tokens: int, completion_tokens: int, duration_ms: int) -> None:
        c = self._conn()
        c.execute(
            "INSERT INTO usage_log(id,chat_id,model,provider,prompt_tokens,completion_tokens,duration_ms,created_at) "
            "VALUES(?,?,?,?,?,?,?,?)",
            (new_id("u_"), chat_id, model, provider, prompt_tokens, completion_tokens, duration_ms, now_ms()),
        )
        c.commit()

    def stats(self, days: int = 14) -> dict:
        c = self._conn()
        day = 86400e3
        start = now_ms() - days * day
        day_start = lambda ms: (ms // 86400000) * 86400000  # noqa: E731

        n_chats = c.execute("SELECT COUNT(*) n FROM chats").fetchone()["n"]
        n_msgs = c.execute("SELECT COUNT(*) n FROM messages").fetchone()["n"]
        n_toks = c.execute(
            "SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) n FROM usage_log"
        ).fetchone()["n"]

        per_day_msgs: Dict[str, int] = {}
        per_day_toks: Dict[str, int] = {}
        for i in range(days - 1, -1, -1):
            key = day_start(now_ms() - i * day)
            per_day_msgs[key] = 0
            per_day_toks[key] = 0
        for r in c.execute(
            "SELECT created_at, COUNT(*) n FROM messages WHERE created_at>=? GROUP BY created_at",
            (start,),
        ).fetchall():
            k = day_start(r["created_at"])
            if k in per_day_msgs:
                per_day_msgs[k] = r["n"]
        for r in c.execute(
            "SELECT created_at, SUM(prompt_tokens+completion_tokens) n FROM usage_log WHERE created_at>=? GROUP BY created_at",
            (start,),
        ).fetchall():
            k = day_start(r["created_at"])
            if k in per_day_toks:
                per_day_toks[k] = r["n"]

        # top tools: aggregate tool_calls stored in assistant meta
        tools: Dict[str, int] = {}
        for r in c.execute("SELECT meta FROM messages WHERE role='assistant' AND meta LIKE '%tool_calls%'").fetchall():
            try:
                meta = json.loads(r["meta"] or "{}")
            except Exception:
                continue
            for call in meta.get("tool_calls") or []:
                name = (call.get("function") or {}).get("name", "?")
                tools[name] = tools.get(name, 0) + 1
        top_tools = sorted(tools.items(), key=lambda kv: -kv[1])[:8]

        models: Dict[str, int] = {}
        for r in c.execute("SELECT model, COUNT(*) n FROM usage_log WHERE model IS NOT NULL AND model!='' GROUP BY model ORDER BY n DESC LIMIT 5").fetchall():
            models[r["model"]] = r["n"]

        # --- extended metrics ---
        tools_total = sum(tools.values())
        avg_ms = c.execute(
            "SELECT COALESCE(AVG(duration_ms),0) n FROM usage_log WHERE duration_ms>0"
        ).fetchone()["n"]
        words = 0
        for r in c.execute("SELECT content FROM messages").fetchall():
            words += len((r["content"] or "").split())
        per_provider: Dict[str, int] = {}
        for r in c.execute(
            "SELECT provider, SUM(prompt_tokens+completion_tokens) n FROM usage_log WHERE provider!='' GROUP BY provider ORDER BY n DESC"
        ).fetchall():
            per_provider[r["provider"]] = r["n"]
        today_start = day_start(now_ms())
        toks_today = c.execute(
            "SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) n FROM usage_log WHERE created_at>=?",
            (today_start,),
        ).fetchone()["n"]
        msgs_today = c.execute(
            "SELECT COUNT(*) n FROM messages WHERE created_at>=?", (today_start,)
        ).fetchone()["n"]
        # weekday x hour heatmap (last 7 days)
        heatmap = [[0] * 24 for _ in range(7)]
        week_start = today_start - 6 * 86400000
        for r in c.execute(
            "SELECT created_at FROM messages WHERE created_at>=?", (week_start,)
        ).fetchall():
            d = r["created_at"]
            dow = (d // 86400000) % 7
            hour = int(time.strftime("%H", time.gmtime(d / 1000)))
            heatmap[dow][hour] += 1
        # streak: consecutive days (ending today or yesterday) with >=1 message
        active_days = {r["d"] for r in c.execute(
            "SELECT DISTINCT (created_at/86400000) d FROM messages"
        ).fetchall()}
        streak = 0
        cur = int(now_ms() // 86400000)
        if cur not in active_days:
            cur -= 1
        while cur in active_days:
            streak += 1
            cur -= 1
        # busiest hour + top day
        hour_counts: Dict[int, int] = {}
        for row in heatmap:
            for h, v in enumerate(row):
                hour_counts[h] = hour_counts.get(h, 0) + v
        busiest_hour = max(hour_counts, key=hour_counts.get) if hour_counts else None
        day_counts = {k: v for k, v in per_day_msgs.items()}
        top_day = max(day_counts, key=day_counts.get) if any(day_counts.values()) else None
        # --- wave 6 metrics ---
        active_day_count = len(active_days)
        longest_day = None
        if any(per_day_msgs.values()):
            ld = max(per_day_msgs, key=per_day_msgs.get)
            longest_day = f"{time.strftime('%b %d', time.gmtime(ld / 1000))} ({per_day_msgs[ld]})"
        chats_with_msgs = c.execute(
            "SELECT COUNT(DISTINCT chat_id) n FROM messages"
        ).fetchone()["n"]
        avg_chat_len = round(n_msgs / chats_with_msgs, 1) if chats_with_msgs else 0
        first_act = c.execute("SELECT MIN(created_at) n FROM messages").fetchone()["n"]
        last_act = c.execute("SELECT MAX(created_at) n FROM messages").fetchone()["n"]
        top_tool = top_tools[0][0] if top_tools else None
        week_start = now_ms() - 7 * day
        week_msgs = c.execute(
            "SELECT COUNT(*) n FROM messages WHERE created_at>=?", (week_start,)
        ).fetchone()["n"]
        week_toks = c.execute(
            "SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) n FROM usage_log WHERE created_at>=?",
            (week_start,),
        ).fetchone()["n"]
        words_today = 0
        for r in c.execute("SELECT content FROM messages WHERE created_at>=?", (today_start,)).fetchall():
            words_today += len((r["content"] or "").split())
        len_hist = {"<50": 0, "50-200": 0, "200-1k": 0, "1k+": 0}
        for r in c.execute("SELECT content FROM messages").fetchall():
            w = len((r["content"] or "").split())
            if w < 50: len_hist["<50"] += 1
            elif w < 200: len_hist["50-200"] += 1
            elif w < 1000: len_hist["200-1k"] += 1
            else: len_hist["1k+"] += 1
        resp_hist = {"<1s": 0, "1-3s": 0, "3-10s": 0, ">10s": 0}
        for r in c.execute("SELECT duration_ms d FROM usage_log WHERE duration_ms>0").fetchall():
            d = r["d"] / 1000
            if d < 1: resp_hist["<1s"] += 1
            elif d < 3: resp_hist["1-3s"] += 1
            elif d < 10: resp_hist["3-10s"] += 1
            else: resp_hist[">10s"] += 1
        # previous period comparison
        prev_start = now_ms() - 2 * days * 86400000
        prev_msgs = c.execute(
            "SELECT COUNT(*) n FROM messages WHERE created_at>=? AND created_at<?",
            (prev_start, start),
        ).fetchone()["n"]
        prev_toks = c.execute(
            "SELECT COALESCE(SUM(prompt_tokens+completion_tokens),0) n FROM usage_log WHERE created_at>=? AND created_at<?",
            (prev_start, start),
        ).fetchone()["n"]

        return {
            "days": days,
            "chats": n_chats,
            "messages": n_msgs,
            "tokens": n_toks,
            "words": words,
            "tools_total": tools_total,
            "avg_response_ms": round(avg_ms),
            "per_provider": per_provider,
            "tokens_today": toks_today,
            "messages_today": msgs_today,
            "heatmap": heatmap,
            "streak": streak,
            "busiest_hour": busiest_hour,
            "top_day": top_day,
            "prev_messages": prev_msgs,
            "prev_tokens": prev_toks,
            "active_day_count": active_day_count,
            "longest_day": longest_day,
            "avg_chat_len": avg_chat_len,
            "first_activity": first_act,
            "last_activity": last_act,
            "top_tool": top_tool,
            "week_messages": week_msgs,
            "week_tokens": week_toks,
            "words_today": words_today,
            "len_hist": len_hist,
            "resp_hist": resp_hist,
            "per_day_messages": [[k, v] for k, v in per_day_msgs.items()],
            "per_day_tokens": [[k, v] for k, v in per_day_toks.items()],
            "top_tools": [[k, v] for k, v in top_tools],
            "top_models": [[k, v] for k, v in models.items()],
        }
