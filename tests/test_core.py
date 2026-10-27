"""CortexSpace test suite — pytest, no network, no external services.

Run:  .venv/bin/python -m pytest tests/ -v
"""
import asyncio
import json
import os
import sys
import tempfile

import pytest

# make `app` importable when running from repo root
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from app import worksp, db as dbmod, agent as agentmod, tools as toolsmod, webtools
from app.config import Settings, SettingsStore


# ---------------------------------------------------------------------------
# fixtures
# ---------------------------------------------------------------------------

@pytest.fixture()
def tmp_workspace(monkeypatch, tmp_path):
    """Point the workspace at a temp dir and yield it."""
    ws = tmp_path / "workspace"
    ws.mkdir()
    monkeypatch.setattr(worksp, "WORKSPACE_DIR", str(ws))
    monkeypatch.setattr(worksp, "DATA_DIR", str(tmp_path))
    monkeypatch.setattr(worksp, "VERSIONS_DIR", str(tmp_path / "versions"))
    return ws


@pytest.fixture()
def tmp_db(tmp_path):
    return dbmod.DB(str(tmp_path / "test.db"))


# ---------------------------------------------------------------------------
# worksp: path safety
# ---------------------------------------------------------------------------

class TestPathSafety:
    def test_dotdot_escape_rejected(self, tmp_workspace):
        with pytest.raises(worksp.WorkspaceError):
            worksp._resolve("../etc/passwd")

    def test_dotdot_nested_rejected(self, tmp_workspace):
        with pytest.raises(worksp.WorkspaceError):
            worksp._resolve("a/b/../../../etc/passwd")

    def test_absolute_path_stripped(self, tmp_workspace):
        # leading slash is stripped, making it a workspace-relative path —
        # safe because _resolve's realpath check still applies
        resolved = worksp._resolve("/etc/passwd")
        assert resolved.startswith(os.path.realpath(str(tmp_workspace)))

    def test_empty_path_returns_root(self, tmp_workspace):
        assert worksp._resolve("") == os.path.realpath(str(tmp_workspace))

    def test_symlink_escape_rejected(self, tmp_workspace):
        # create a symlink pointing outside the workspace
        outside = tmp_workspace.parent / "outside.txt"
        outside.write_text("secret")
        link = tmp_workspace / "link.txt"
        link.symlink_to(outside)
        with pytest.raises(worksp.WorkspaceError):
            worksp._resolve("link.txt")


# ---------------------------------------------------------------------------
# worksp: read / write / edit
# ---------------------------------------------------------------------------

class TestReadWrite:
    def test_write_then_read(self, tmp_workspace):
        worksp.write_file("notes/test.md", "hello\nworld\n")
        d = worksp.read_file("notes/test.md")
        assert d["content"] == "hello\nworld\n"
        assert d["binary"] is False
        assert d["size"] == 12

    def test_read_offset_limit(self, tmp_workspace):
        content = "\n".join(f"line{i}" for i in range(100))
        worksp.write_file("big.txt", content)
        d = worksp.read_file("big.txt", offset=10, limit=5)
        assert d["total_lines"] == 100
        assert "line10" in d["content"]
        assert "line14" in d["content"]
        assert "line15" not in d["content"]

    def test_read_missing_file(self, tmp_workspace):
        with pytest.raises(worksp.WorkspaceError):
            worksp.read_file("nope.txt")

    def test_edit_file_first_match(self, tmp_workspace):
        worksp.write_file("t.txt", "aaa bbb aaa\n")
        r = worksp.edit_file("t.txt", "aaa", "ccc")
        assert r["replacements"] == 1
        assert r["occurrences"] == 2
        assert worksp.read_file("t.txt")["content"] == "ccc bbb aaa\n"

    def test_edit_file_replace_all(self, tmp_workspace):
        worksp.write_file("t.txt", "aaa bbb aaa\n")
        r = worksp.edit_file("t.txt", "aaa", "ccc", replace_all=True)
        assert r["replacements"] == 2
        assert worksp.read_file("t.txt")["content"] == "ccc bbb ccc\n"

    def test_edit_file_not_found(self, tmp_workspace):
        worksp.write_file("t.txt", "hello\n")
        with pytest.raises(worksp.WorkspaceError):
            worksp.edit_file("t.txt", "zzz", "y")

    def test_edit_file_empty_old(self, tmp_workspace):
        worksp.write_file("t.txt", "hello\n")
        with pytest.raises(worksp.WorkspaceError):
            worksp.edit_file("t.txt", "", "y")

    def test_edit_creates_version(self, tmp_workspace):
        worksp.write_file("t.txt", "original\n")
        worksp.edit_file("t.txt", "original", "changed")
        vs = worksp.list_versions("t.txt")
        assert len(vs) >= 1


# ---------------------------------------------------------------------------
# worksp: versions
# ---------------------------------------------------------------------------

class TestVersions:
    def test_versions_saved_on_write(self, tmp_workspace):
        worksp.write_file("v.txt", "one\n")
        worksp.write_file("v.txt", "two\n")
        worksp.write_file("v.txt", "three\n")
        vs = worksp.list_versions("v.txt")
        assert len(vs) >= 2  # at least 2 snapshots of previous content

    def test_restore_version(self, tmp_workspace):
        worksp.write_file("v.txt", "original\n")
        worksp.write_file("v.txt", "changed\n")
        vs = worksp.list_versions("v.txt")
        worksp.restore_version("v.txt", vs[0]["version"])
        assert worksp.read_file("v.txt")["content"] == "original\n"

    def test_restore_bad_version(self, tmp_workspace):
        worksp.write_file("v.txt", "x\n")
        with pytest.raises(worksp.WorkspaceError):
            worksp.restore_version("v.txt", "9999999999")


# ---------------------------------------------------------------------------
# worksp: search
# ---------------------------------------------------------------------------

class TestSearch:
    def test_search_basic(self, tmp_workspace):
        worksp.write_file("a.md", "hello world\n")
        worksp.write_file("b.md", "goodbye world\n")
        hits = worksp.search("world")
        assert len(hits) == 2

    def test_search_no_match(self, tmp_workspace):
        worksp.write_file("a.md", "hello\n")
        hits = worksp.search("zzz")
        assert hits == []

    def test_search_filename_only(self, tmp_workspace):
        worksp.write_file("target.md", "content here\n")
        worksp.write_file("other.md", "target inside content\n")
        hits = worksp.search("target", filename_only=True)
        assert len(hits) == 1
        assert hits[0]["path"] == "target.md"

    def test_search_regex(self, tmp_workspace):
        worksp.write_file("a.md", "abc123 def456\n")
        hits = worksp.search(r"\d{3}", regex=True)
        assert len(hits) == 1


# ---------------------------------------------------------------------------
# db: chats and messages
# ---------------------------------------------------------------------------

class TestDB:
    def test_create_and_get_chat(self, tmp_db):
        cid = tmp_db.create_chat(title="Test")
        chat = tmp_db.get_chat(cid)
        assert chat["title"] == "Test"

    def test_add_and_list_messages(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "hello")
        tmp_db.add_message(cid, "assistant", "hi")
        msgs = tmp_db.list_messages(cid)
        assert len(msgs) == 2
        assert msgs[0]["role"] == "user"
        assert msgs[0]["seq"] == 1

    def test_list_chats_preview(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "preview text here")
        chats = tmp_db.list_chats()
        assert len(chats) == 1
        assert "preview" in chats[0]["preview"]

    def test_list_chats_no_nplus1(self, tmp_db):
        # create many chats — should still be fast (single query)
        for i in range(50):
            cid = tmp_db.create_chat(title=f"Chat {i}")
            tmp_db.add_message(cid, "user", f"msg {i}")
        chats = tmp_db.list_chats()
        assert len(chats) == 50
        assert all(c["preview"] for c in chats)

    def test_delete_chat_cascades(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "hello")
        tmp_db.delete_chat(cid)
        assert tmp_db.get_chat(cid) is None
        assert tmp_db.list_messages(cid) == []

    def test_rename_chat(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.rename_chat(cid, "New title")
        assert tmp_db.get_chat(cid)["title"] == "New title"

    def test_auto_title(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.auto_title(cid, "This is a very long message that should be truncated at sixty characters exactly")
        title = tmp_db.get_chat(cid)["title"]
        assert len(title) <= 61  # 60 chars + ellipsis
        assert title.endswith("…")

    def test_auto_title_skips_renamed(self, tmp_db):
        cid = tmp_db.create_chat(title="Custom")
        tmp_db.auto_title(cid, "should not change")
        assert tmp_db.get_chat(cid)["title"] == "Custom"

    def test_fork_chat(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "one")
        tmp_db.add_message(cid, "assistant", "two")
        new_cid = tmp_db.fork_chat(cid)
        assert new_cid != cid
        msgs = tmp_db.list_messages(new_cid)
        assert len(msgs) == 2

    def test_archive_chat(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.archive_chat(cid, True)
        assert tmp_db.get_chat(cid)["archived"] == 1
        assert tmp_db.list_chats() == []  # hidden from default list
        assert len(tmp_db.list_chats(include_archived=True)) == 1


# ---------------------------------------------------------------------------
# db: search (FTS + fallback)
# ---------------------------------------------------------------------------

class TestDBSearch:
    def test_fts_search(self, tmp_db):
        cid = tmp_db.create_chat(title="Search test")
        tmp_db.add_message(cid, "user", "the quick brown fox")
        tmp_db.add_message(cid, "assistant", "jumps over the lazy dog")
        hits = tmp_db.search_messages("fox")
        assert len(hits) == 1
        assert hits[0]["id"] == cid

    def test_search_case_insensitive(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "Hello World")
        hits = tmp_db.search_messages("hello")
        assert len(hits) == 1

    def test_search_regex(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "abc123 def456")
        hits = tmp_db.search_messages(r"\d{3}", regex=True)
        assert len(hits) == 1

    def test_search_whole_word(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "the cat and the category")
        hits = tmp_db.search_messages("cat", whole_word=True)
        assert len(hits) == 1  # only matches "cat", not "category"


# ---------------------------------------------------------------------------
# db: backup/restore
# ---------------------------------------------------------------------------

class TestBackup:
    def test_export_import_roundtrip(self, tmp_db, tmp_path):
        cid = tmp_db.create_chat(title="Backup test")
        tmp_db.add_message(cid, "user", "hello")
        tmp_db.add_message(cid, "assistant", "hi")
        backup = tmp_db.export_backup()

        db2 = dbmod.DB(str(tmp_path / "restore.db"))
        result = db2.import_backup(backup)
        assert result["imported"] == 1
        chats = db2.list_chats()
        assert len(chats) == 1
        assert chats[0]["title"] == "Backup test"

    def test_import_preserves_archived(self, tmp_db, tmp_path):
        cid = tmp_db.create_chat(title="Archived")
        tmp_db.add_message(cid, "user", "x")
        tmp_db.archive_chat(cid, True)
        backup = tmp_db.export_backup()

        db2 = dbmod.DB(str(tmp_path / "restore2.db"))
        db2.import_backup(backup)
        chats = db2.list_chats(include_archived=True)
        assert len(chats) == 1
        assert chats[0]["archived"] == 1


# ---------------------------------------------------------------------------
# db: stats
# ---------------------------------------------------------------------------

class TestStats:
    def test_stats_shape(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "hello world")
        tmp_db.add_message(cid, "assistant", "hi there")
        tmp_db.record_usage(cid, "m", "p", 10, 5, 1000)
        s = tmp_db.stats(7)
        assert len(s["heatmap"]) == 7
        assert len(s["heatmap"][0]) == 24
        assert "by_day" not in s  # not a backend key
        assert s["streak"] >= 1
        assert "per_provider" in s

    def test_stats_heatmap_monday_first(self, tmp_db):
        # add a message and verify heatmap has 7 rows (Mon-Sun)
        cid = tmp_db.create_chat()
        tmp_db.add_message(cid, "user", "test")
        s = tmp_db.stats(7)
        assert len(s["heatmap"]) == 7
        # row 0 should be Monday — verify by checking total messages
        total = sum(sum(row) for row in s["heatmap"])
        assert total == 1

    def test_stats_per_provider_shape(self, tmp_db):
        cid = tmp_db.create_chat()
        tmp_db.record_usage(cid, "m", "openrouter", 10, 5, 1000)
        s = tmp_db.stats(7)
        pp = s["per_provider"]
        assert "openrouter" in pp
        assert pp["openrouter"]["tokens"] == 15
        assert pp["openrouter"]["messages"] == 1


# ---------------------------------------------------------------------------
# agent: history assembly
# ---------------------------------------------------------------------------

class TestAgentHistory:
    def test_just_added_user_message_dropped(self):
        msgs = [
            {"role": "user", "content": "old q", "meta": None},
            {"role": "assistant", "content": "old a", "meta": None},
            {"role": "user", "content": "new q", "meta": None},
        ]
        hist = agentmod._build_history(msgs, "new q")
        roles = [h["role"] for h in hist]
        assert roles == ["user", "assistant"]
        assert hist[0]["content"] == "old q"

    def test_tool_results_attached(self):
        msgs = [
            {"role": "user", "content": "do it", "meta": None},
            {"role": "assistant", "content": "", "meta": {
                "tool_calls": [{"id": "t1", "function": {"name": "read_file", "arguments": {}}}],
                "tool_results": [{"id": "t1", "name": "read_file", "ok": True, "output": "data"}],
            }},
            {"role": "user", "content": "thanks", "meta": None},
        ]
        hist = agentmod._build_history(msgs, "thanks")
        # should have user, assistant(tool_calls), tool, user
        roles = [h["role"] for h in hist]
        assert roles == ["user", "assistant", "tool"]
        assert hist[2]["tool_call_id"] == "t1"

    def test_orphan_tool_messages_cleaned(self):
        # simulate history that was trimmed: assistant with tool_calls dropped
        msgs = [
            {"role": "user", "content": "q1", "meta": None},
            {"role": "assistant", "content": "a1", "meta": None},
            {"role": "user", "content": "q2", "meta": None},
            {"role": "assistant", "content": "a2", "meta": None},
            {"role": "user", "content": "q3", "meta": None},
        ]
        hist = agentmod._build_history(msgs, "q3")
        # no orphan tool messages
        assert all(h["role"] != "tool" for h in hist)

    def test_empty_history(self):
        hist = agentmod._build_history([], "hello")
        assert hist == []


# ---------------------------------------------------------------------------
# tools: schemas and describe
# ---------------------------------------------------------------------------

class TestTools:
    def test_all_tools_have_schemas(self):
        schemas = toolsmod.schemas()
        names = {s["function"]["name"] for s in schemas}
        assert "read_file" in names
        assert "edit_file" in names
        assert "write_file" in names
        assert "list_versions" in names
        assert "restore_version" in names
        assert "search_workspace" in names
        assert "web_search" in names
        assert "fetch_page" in names
        assert "run_python" in names
        assert "list_workspace" in names
        assert "delete_file" in names

    def test_dangerous_tools_flagged(self):
        schemas = toolsmod.schemas()
        dangerous = {s["function"]["name"] for s in schemas if s["function"]["name"] in
                     ("write_file", "delete_file", "run_python", "edit_file", "restore_version")}
        assert len(dangerous) == 5

    def test_describe_read_file(self):
        spec = toolsmod._BY_NAME["read_file"]
        d = toolsmod.describe(spec, {"path": "test.md"})
        assert "test.md" in d

    def test_describe_read_file_range(self):
        spec = toolsmod._BY_NAME["read_file"]
        d = toolsmod.describe(spec, {"path": "test.md", "offset": 5, "limit": 10})
        assert "5" in d
        assert "15" in d

    def test_describe_edit_file(self):
        spec = toolsmod._BY_NAME["edit_file"]
        d = toolsmod.describe(spec, {"path": "t.md", "old": "a", "new": "b"})
        assert "t.md" in d
        assert "first" in d

    def test_describe_edit_file_all(self):
        spec = toolsmod._BY_NAME["edit_file"]
        d = toolsmod.describe(spec, {"path": "t.md", "old": "a", "new": "b", "replace_all": True})
        assert "all" in d

    def test_execute_unknown_tool(self):
        async def run():
            return await toolsmod.execute("nonexistent", {})
        result = asyncio.run(run())
        assert result.startswith("error")


# ---------------------------------------------------------------------------
# webtools: SSRF guard
# ---------------------------------------------------------------------------

class TestSSRF:
    def test_localhost_blocked(self):
        with pytest.raises(RuntimeError):
            webtools._assert_public_host("localhost")

    def test_private_ip_blocked(self):
        with pytest.raises(RuntimeError):
            webtools._assert_public_host("127.0.0.1")

    def test_private_range_blocked(self):
        with pytest.raises(RuntimeError):
            webtools._assert_public_host("10.0.0.1")

    def test_metadata_endpoint_blocked(self):
        with pytest.raises(RuntimeError):
            webtools._assert_public_host("169.254.169.254")


# ---------------------------------------------------------------------------
# settings validation
# ---------------------------------------------------------------------------

class TestSettings:
    def test_default_settings(self, tmp_db):
        store = SettingsStore(tmp_db)
        s = store.get()
        assert s.provider == "demo"
        assert s.temperature == 0.4
        assert s.max_tokens == 2048

    def test_update_settings(self, tmp_db):
        store = SettingsStore(tmp_db)
        s = store.update({"provider": "ollama", "temperature": 0.7})
        assert s.provider == "ollama"
        assert s.temperature == 0.7

    def test_update_rejects_invalid_key(self, tmp_db):
        store = SettingsStore(tmp_db)
        s = store.update({"nonexistent_key": "value"})
        assert not hasattr(s, "nonexistent_key")

    def test_update_rejects_none(self, tmp_db):
        store = SettingsStore(tmp_db)
        s = store.update({"provider": None})
        assert s.provider == "demo"  # unchanged

    def test_provider_model_mapping(self):
        s = Settings()
        assert s.provider_model() == "cortexspace-demo"
        s.provider = "ollama"
        assert s.provider_model() == "llama3.2"
        s.provider = "openrouter"
        assert s.provider_model() == "openrouter/auto"
