/* ============================================================
   app.js — CortexSpace SPA
   Vanilla JS, no framework, no build step.
   ============================================================ */
(function () {
  "use strict";

  /* one-time migration: legacy "mwai-*" storage keys -> "cs-*" (name change) */
  try {
    Object.keys(localStorage)
      .filter((k) => k.startsWith("mwai-"))
      .forEach((k) => {
        const v = localStorage.getItem(k);
        localStorage.setItem("cs-" + k.slice(5), v);
        localStorage.removeItem(k);
      });
  } catch {}

  /* ---------------- helpers ---------------- */

  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));

  function el(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") e.className = v;
      else if (k === "html") e.innerHTML = v;
      else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
      else if (v !== false && v != null) e.setAttribute(k, v === true ? "" : v);
    }
    for (const kid of kids.flat()) {
      if (kid == null || kid === false) continue;
      e.append(kid.nodeType ? kid : document.createTextNode(kid));
    }
    return e;
  }

  const relTime = (ms) => {
    const d = Date.now() - ms;
    if (d < 60e3) return "now";
    if (d < 3600e3) return Math.floor(d / 60e3) + "m";
    if (d < 86400e3) return Math.floor(d / 3600e3) + "h";
    if (d < 7 * 86400e3) return Math.floor(d / 86400e3) + "d";
    return new Date(ms).toLocaleDateString();
  };
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  const human = (n) => (n < 1024 ? n + "B" : n < 1048576 ? (n / 1024).toFixed(1) + "KB" : (n / 1048576).toFixed(1) + "MB");

  async function api(path, opts = {}) {
    const res = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined,
    });
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).detail || res.statusText; } catch { msg = res.statusText; }
      throw new Error(msg);
    }
    return res.json();
  }

  async function ssePost(path, body, onEvent, signal) {
    const res = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "text/event-stream" },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).detail || res.statusText; } catch { msg = res.statusText; }
      throw new Error(msg);
    }
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf("\n\n")) >= 0) {
        const frame = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        let ev = "message", data = "";
        for (const line of frame.split("\n")) {
          if (line.startsWith("event:")) ev = line.slice(6).trim();
          else if (line.startsWith("data:")) data += line.slice(5).trim();
        }
        if (!data) continue;
        try { onEvent(ev, JSON.parse(data)); } catch { /* ignore */ }
      }
    }
  }

  /* ---------------- state ---------------- */

  const state = {
    chats: [],
    chat: null,
    messages: [],
    streaming: false,
    controller: null,
    settings: null,
    tree: [],
    openFile: null,        // {path, content, saved:bool, view:'preview'|'source'}
    panelTab: "file",
    panelOpen: true,
    sidebarOpen: true,
    theme: localStorage.getItem("cs-theme") || (window.matchMedia && matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark"),
    context: [],           // attached file paths
    paletteOpen: false,
    activity: [],          // current chat tool events
    streamText: "",
    actFilter: "all",      // activity feed filter
    expanded: null,        // Set of expanded dir paths (init on first tree load)
    bookmarks: JSON.parse(localStorage.getItem("cs-bookmarks") || "[]"),
    unread: 0,             // new items while scrolled up
    nearBottom: true,
    secs: JSON.parse(localStorage.getItem("cs-secs") || "{}"),
    focusPrev: null,
  };

  document.documentElement.dataset.theme = state.theme;

  function saveExpanded() { localStorage.setItem("cs-expanded", JSON.stringify([...state.expanded])); }
  function saveBookmarks() { localStorage.setItem("cs-bookmarks", JSON.stringify(state.bookmarks)); }
  function bumpUnread(delta) { if (!state.nearBottom) { state.unread += delta || 1; updateJumpBtn(false); } }

  /* ---------------- modal ---------------- */

  function showModal(title, bodyNode) {
    $("#modal-title").textContent = title;
    const body = $("#modal-body");
    body.innerHTML = "";
    body.append(bodyNode);
    $("#modal").classList.remove("hidden");
    const input = body.querySelector("input");
    if (input) { input.focus(); input.select && input.select(); }
    body.onkeydown = (e) => {
      if (e.key === "Enter" && e.target.tagName === "INPUT") {
        e.preventDefault();
        const ok = body.querySelector("[data-modal-ok]");
        if (ok) ok.click();
      }
      if (e.key === "Escape") closeModal();
    };
  }
  function closeModal() { $("#modal").classList.add("hidden"); }

  function pathModal(title, placeholder, value, okLabel, onOk) {
    const field = el("label", { class: "set-field" },
      el("span", null, "Path"),
      el("input", { type: "text", spellcheck: "false", placeholder, value: value || "" }));
    const input = field.querySelector("input");
    const box = el("div", null,
      el("div", { class: "modal-hint" }, "Relative to the workspace root. Parent folders are created as needed."),
      field,
      el("div", { class: "modal-actions" },
        el("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
        el("button", {
          class: "btn primary", "data-modal-ok": "1",
          onclick: () => {
            const v = input.value.trim();
            if (!v || v.includes("..")) { toast("Invalid path", "err"); return; }
            closeModal();
            onOk(v);
          },
        }, okLabel)));
    showModal(title, box);
  }

  /* ---------------- toasts ---------------- */

  function toast(msg, kind = "ok", ms = 3200, action) {
    histPush(msg, kind);
    if (DND) return;
    const box = $("#toasts");
    while (box.children.length >= 5) box.firstElementChild.remove();
    const t = el("div", { class: "toast " + kind },
      el("svg", null, el("use", { href: kind === "ok" ? "#i-check" : kind === "ach" ? "#i-trophy" : "#i-alert" })),
      el("span", { class: "t-text" }, esc(msg)));
    if (action) t.append(el("button", { class: "t-undo", onclick: () => { action.fn(); t.remove(); } }, action.label));
    t.append(el("span", { class: "t-progress", style: "animation-duration:" + ms + "ms" }));
    let paused = false;
    t.addEventListener("mouseenter", () => { paused = true; t.lastElementChild.style.animationPlayState = "paused"; });
    t.addEventListener("mouseleave", () => { paused = false; t.lastElementChild.style.animationPlayState = "running"; });
    box.append(t);
    if (kind === "err") beep("err");
    else if (kind === "ach") beep("ding");
    setTimeout(() => { if (t.isConnected) { t.classList.add("out"); setTimeout(() => t.remove(), 260); } }, ms);
    return t;
  }
  function toastUndo(msg, label, fn) { return toast(msg, "ok", 6500, { label, fn }); }

  /* ---------------- icons ---------------- */

  const TOOL_ICONS = {
    list_workspace: "#i-folder-open", read_file: "#i-eye", write_file: "#i-edit",
    delete_file: "#i-trash", search_workspace: "#i-search", web_search: "#i-globe",
    fetch_page: "#i-external", run_python: "#i-terminal",
  };
  const ico = (href) => el("svg", null, el("use", { href }));

  /* ---------------- sidebar: chats ---------------- */

  async function loadChats() {
    const d = await api("/api/chats");
    state.chats = d.chats;
    renderChatList();
  }

  function renderChatList() {
    const box = $("#chat-list");
    box.innerHTML = "";
    const q = ($("#chat-filter").value || "").toLowerCase();
    box.classList.toggle("stagger", !q);
    const list = state.chats.filter((c) => !q || c.title.toLowerCase().includes(q) || (c.preview || "").toLowerCase().includes(q));
    if (!list.length) {
      box.append(el("div", { class: "ft-row", style: "opacity:.55;cursor:default" }, ico("#i-chat"), "No chats yet"));
      return;
    }
    for (const c of list) {
      const item = el("div", {
        class: "chat-item" + (state.chat && state.chat.id === c.id ? " active" : "") + (c.pin ? " pinned" : ""),
        onclick: () => openChat(c.id),
      },
        ico("#i-chat", ),
        el("span", { class: "ci-title", title: c.title }, c.title),
        el("span", { class: "ci-time rt", "data-ts": c.updated_at }, relTime(c.updated_at)),
        el("button", {
          class: "icon-btn ci-pin", title: c.pin ? "Unpin chat" : "Pin chat",
          onclick: (e) => { e.stopPropagation(); pinToggle(c); },
        }, ico("#i-pin")),
        el("button", {
          class: "icon-btn ci-del", title: "Delete chat",
          onclick: (e) => { e.stopPropagation(); delChat(c.id); },
        }, ico("#i-trash"))
      );
      item.querySelector(".ci-icon") || item.children[0].classList.add("ci-icon");
      box.append(item);
    }
  }

  async function newChat() {
    const d = await api("/api/chats", { method: "POST", body: {} });
    state.chat = { id: d.id, title: "New chat" };
    state.messages = [];
    state.activity = [];
    state.context = [];
    renderContextChips();
    await loadChats();
    showView("chat");
    renderMessages();
    $("#chat-title").value = "New chat";
    $("#composer").focus();
  }

  async function openChat(id) {
    if (state.streaming) return;
    const d = await api("/api/chats/" + id);
    state.chat = d.chat;
    updateModelBadge();
    state.messages = d.messages.map(historyMsg);
    state.activity = [];
    for (const m of state.messages) for (const t of m.tools) state.activity.push({ ...t, when: m.created_at });
    state.context = [];
    renderContextChips();
    await loadChats();
    showView("chat");
    renderMessages();
    $("#chat-title").value = d.chat.title;
  }

  async function delChat(id) {
    if (!confirm("Delete this chat?")) return;
    let backup = null;
    try {
      const d = await api("/api/chats/" + id);
      backup = { chats: [{ ...d.chat, messages: d.messages.map((m) => ({ id: m.id, chat_id: d.chat.id, role: m.role, content: m.content, meta: m.meta || {}, seq: m.seq != null ? m.seq : 0, created_at: m.created_at })) }] };
      localStorage.setItem("cs-trash-chat", JSON.stringify(backup));
    } catch { /* snapshot best-effort */ }
    await api("/api/chats/" + id, { method: "DELETE" });
    if (state.chat && state.chat.id === id) { state.chat = null; state.messages = []; renderMessages(); }
    await loadChats();
    if (backup) toastUndo("Chat deleted", "Undo", async () => {
      try {
        await api("/api/backup", { method: "POST", body: backup });
        await loadChats();
        toast("Chat restored");
      } catch (e) { toast("Restore failed: " + e.message, "err"); }
    });
  }

  function historyMsg(m) {
    const out = { id: m.id, role: m.role, content: m.content, meta: m.meta || {}, created_at: m.created_at, tools: [] };
    if (m.role === "user") out.context = (m.meta && m.meta.context) || [];
    if (m.role === "assistant") {
      const calls = (m.meta.tool_calls || []);
      const results = (m.meta.tool_results || []);
      for (const c of calls) {
        const r = results.find((x) => x.id === c.id);
        out.tools.push({
          id: c.id, name: c.function.name, arguments: c.function.arguments,
          description: descOf(c.function.name, c.function.arguments),
          status: r ? (r.ok ? "ok" : "err") : "ok",
          output: r ? r.output : "", ok: r ? r.ok : true,
        });
      }
    }
    return out;
  }

  function descOf(name, args) {
    args = args || {};
    switch (name) {
      case "write_file": return `Write ${human((args.content || "").length)} to ${args.path || "?"}`;
      case "read_file": return `Read ${args.path || "?"}`;
      case "list_workspace": return `List ${args.path || "workspace root"}`;
      case "delete_file": return `Delete ${args.path || "?"}`;
      case "search_workspace": return `Search workspace for “${args.query || "?"}”`;
      case "web_search": return `Web search: ${args.query || "?"}`;
      case "fetch_page": return `Fetch ${args.url || "?"}`;
      case "run_python": {
        const l = (args.code || "").trim().split("\n");
        return `Run Python (${l.length} line${l.length > 1 ? "s" : ""})`;
      }
      default: return name;
    }
  }

  /* ---------------- sidebar: workspace tree ---------------- */

  function collectDirs(nodes, acc) {
    acc = acc || new Set();
    for (const n of nodes || []) {
      if (n.is_dir) { acc.add(n.path); collectDirs(n.children, acc); }
    }
    return acc;
  }

  async function loadTree() {
    const d = await api("/api/files");
    state.tree = d.tree;
    if (state.expanded === null) {
      const saved = localStorage.getItem("cs-expanded");
      if (saved !== null) { try { state.expanded = new Set(JSON.parse(saved)); } catch { state.expanded = collectDirs(state.tree); } }
      else state.expanded = collectDirs(state.tree);
    }
    const hasDir = state.tree.some((n) => n.is_dir);
    $("#btn-tree-expand").style.display = hasDir ? "" : "none";
    $("#btn-tree-collapse").style.display = hasDir ? "" : "none";
    renderTree();
  }

  function renderTree() {
    const box = $("#file-tree");
    box.innerHTML = "";
    let nodes = sortNodes(state.tree, treeSortMode);
    const q = (($("#tree-filter") && $("#tree-filter").value) || "").toLowerCase();
    if (q || treeFavsOnly) {
      nodes = nodes.filter((n) => (q ? treeMatch(n, q) : true) && (treeFavsOnly ? TREE_FAVS.has(n.path) || (n.children || []).some((c) => favIn(c)) : true));
      for (const n of nodes) if (n.children) n.children = keepMatching(n.children, q);
    }
    box.append(renderTreeNodes(nodes, 0));
  }
  function favIn(n) { return TREE_FAVS.has(n.path) || (n.children || []).some(favIn); }
  function keepMatching(children, q) {
    return children.filter((c) => (q ? treeMatch(c, q) : true)).map((c) => c.children ? { ...c, children: keepMatching(c.children, q) } : c);
  }

  function renderTreeNodes(nodes, depth) {
    const frag = document.createDocumentFragment();
    for (const n of nodes) {
      if (n.is_dir) {
        const open = state.expanded && state.expanded.has(n.path);
        const wrap = el("div");
        const row = el("div", {
          class: "ft-row" + (open ? " open" : ""),
          onclick: () => {
            if (!state.expanded) state.expanded = new Set();
            if (state.expanded.has(n.path)) state.expanded.delete(n.path);
            else state.expanded.add(n.path);
            saveExpanded();
            renderTree();
          },
          title: n.path,
        },
          ico("#i-chev-r", ),
          ico("#i-folder"),
          el("span", { class: "ft-name" }, n.name),
          el("span", {
            class: "ft-actions",
            onclick: (e) => { e.stopPropagation(); renameItem(n.path, true); },
            title: "Rename folder",
          }, ico("#i-edit")),
        );
        row.children[0].classList.add("ft-caret");
        const children = el("div", { class: "ft-children" + (open ? "" : " hidden") }, renderTreeNodes(n.children || [], depth + 1));
        wrap.append(row, children);
        frag.append(wrap);
      } else {
        const row = el("div", {
          class: "ft-row" + (state.openFile && state.openFile.path === n.path ? " active" : ""),
          onclick: () => openFile(n.path),
          title: n.path,
        },
          ico("#i-file"),
          el("span", { class: "ft-name" }, n.name),
          el("span", { class: "ft-size" }, n.mtime ? human(n.size) + " · " + relTime(n.mtime * 1000) : human(n.size)),
          el("span", {
            class: "ft-actions",
            onclick: (e) => { e.stopPropagation(); renameItem(n.path, false); },
            title: "Rename",
          }, ico("#i-edit")),
          el("button", {
            class: "icon-btn sm ft-fav" + (TREE_FAVS.has(n.path) ? " on" : ""),
            title: "Favorite this file",
            style: TREE_FAVS.has(n.path) ? "color:var(--warn)" : "",
            onclick: (e) => { e.stopPropagation(); toggleFav(n.path); },
          }, ico("#i-star")),
        );
        if (TREE_FAVS.has(n.path)) row.classList.add("fav");
        frag.append(row);
      }
    }
    return frag;
  }

  /* ---------------- messages ---------------- */

  function showView(v) {
    $("#view-chat").classList.toggle("hidden", v !== "chat");
    $("#view-settings").classList.toggle("hidden", v !== "settings");
    state.view = v;
  }

  function renderMessages() {
    const list = $("#msg-list");
    list.innerHTML = "";
    const has = state.messages.length > 0;
    $("#messages").dataset.empty = has ? "false" : "true";
    let lastAssistantIdx = -1;
    for (let i = 0; i < state.messages.length; i++) if (state.messages[i].role === "assistant") lastAssistantIdx = i;
    for (let i = 0; i < state.messages.length; i++) {
      list.append(messageNode(state.messages[i], { isLastAssistant: i === lastAssistantIdx && !state.streaming }));
    }
    updateExportButton();
    applyPins();
    renderFollowUps();
    scrollBottom();
  }
  function applyPins() {
    const chatId = state.chat && state.chat.id;
    if (!chatId) return;
    const pins = new Set((JSON.parse(localStorage.getItem("cs-pins") || "{}")[chatId]) || []);
    $$("#msg-list .msg").forEach((n) => n.classList.toggle("pinned", pins.has(n.dataset.mid)));
  }

  function updateExportButton() {
    const btn = $("#btn-export-chat");
    if (!btn) return;
    btn.disabled = !state.chat || !state.messages.some((m) => m.role === "user");
  }

  function ctxLabel(p) {
    if (p.startsWith("page:")) {
      try { return "page: " + new URL(p.slice(5)).host; } catch { return p.slice(5, 40); }
    }
    return p.split("/").pop();
  }

  function msgActions(m, isLastAssistant) {
    const actions = el("div", { class: "msg-actions" });
    actions.append(el("button", {
      class: "ma-btn", title: "Copy message",
      onclick: () => {
        navigator.clipboard.writeText(m.content).then(() => toast("Copied to clipboard")).catch(() => toast("Copy failed", "err"));
      },
    }, ico("#i-copy"), "Copy"));
    if (m.content) {
      actions.append(el("button", { class: "ma-btn", title: "Copy as Markdown", "data-mact": "copymd", onclick: () => copyAsMarkdown(m) }, ico("#i-code"), "MD"));
      actions.append(el("button", { class: "ma-btn", title: "Quote in composer", "data-mact": "quote", onclick: () => quoteMessage(m) }, ico("#i-chat"), "Quote"));
    }
    if (m.role === "user") {
      actions.append(el("button", { class: "ma-btn", title: "Edit & resend", "data-mact": "edit", onclick: () => editResendUser(m) }, ico("#i-edit"), "Edit"));
    }
    if (m.id) {
      actions.append(el("button", { class: "ma-btn", title: "Delete message", "data-mact": "del", onclick: () => deleteMessage(m.id) }, ico("#i-trash"), "Del"));
    }
    if (m.role === "assistant") {
      actions.append(el("button", {
        class: "ma-btn", title: "Fork a new chat from this point",
        onclick: () => forkChatFrom(m.id),
      }, ico("#i-fork"), "Fork here"));
    }
    if (isLastAssistant) {
      actions.append(el("button", {
        class: "ma-btn", title: "Regenerate this response",
        onclick: () => regenerate(m),
      }, ico("#i-refresh"), "Regenerate"));
    }
    return actions;
  }

  function messageNode(m, opts = {}) {
    if (m.role === "user") {
      const chips = (m.context || []).map((p) =>
        p.startsWith("page:")
          ? el("span", { class: "ctx-chip", title: "Attached page" }, ico("#i-globe"), esc(ctxLabel(p)))
          : el("span", { class: "ctx-chip", title: "Attached file", onclick: () => openFile(p) }, ico("#i-file"), esc(ctxLabel(p))));
      return el("div", { class: "msg user" },
        el("div", { class: "bubble" }, esc(m.content)),
        chips.length ? el("div", { class: "ctx-chip-row", style: "display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end" }, chips) : null,
        el("div", { class: "msg-meta-row" },
          el("div", { class: "msg-meta rt", "data-ts": m.created_at || Date.now() }, clock(m.created_at || Date.now())),
          msgActions(m, false),
        ),
      );
    }
    // assistant
    const node = el("div", { class: "msg assistant", "data-mid": m.id });
    node.append(
      el("div", { class: "assistant-head" },
        el("div", { class: "mark" }, el("svg", { viewBox: "0 0 24 24", html: '<path d="M12 2l2.4 6.2L21 10.5l-5.4 4 1.7 6.6L12 17.4l-5.3 3.7 1.7-6.6-5.4-4 6.6-2.3z" fill="currentColor"/>' })),
        el("span", { class: "who" }, "CortexSpace"),
        m.meta && m.meta.model ? el("span", { class: "when" }, m.meta.model) : null,
      ),
    );
    const body = el("div", { class: "assistant-body" });
    node.append(body);
    if (m.tools && m.tools.length) {
      // history: show compact tool cards, then the final answer
      for (const t of m.tools) body.append(staticToolCard(t));
      if (m.content) body.append(el("div", { class: "md", html: MD.render(m.content) }));
    } else if (m.content) {
      body.append(el("div", { class: "md", html: MD.render(m.content) }));
    }
    if (m.meta && m.meta.stopped) body.append(el("div", { class: "msg-meta" }, "⏹ stopped"));
    const stats = assistantStats(m);
    if (stats) body.append(el("div", { class: "msg-meta" },
      el("span", null, esc(stats)),
      el("span", { class: "msg-stats rt", "data-ts": m.created_at || Date.now() }, relTime(m.created_at || Date.now())),
    ));
    body.append(msgActions(m, !!opts.isLastAssistant));
    return node;
  }

  function assistantStats(m) {
    const meta = m.meta || {};
    const u = meta.usage || {};
    const inT = u.prompt_tokens || 0, outT = u.completion_tokens || 0;
    const secs = meta.duration_ms ? meta.duration_ms / 1000 : 0;
    const bits = [];
    if (meta.ttft_ms != null) bits.push("⚡ " + (meta.ttft_ms / 1000).toFixed(1) + "s first token");
    if (m.tools && m.tools.length) bits.push(m.tools.length + " tool" + (m.tools.length > 1 ? "s" : ""));
    if (inT) bits.push(inT + " in");
    if (outT) bits.push(outT + " out");
    if (secs && outT) bits.push(Math.round(outT / secs) + " tok/s");
    if (secs) bits.push(secs.toFixed(1) + "s");
    return bits.join(" · ");
  }

  function regenerate(lastAssistantMsg) {
    if (state.streaming) return;
    // find the last user message before (or at) this assistant message
    const idx = state.messages.indexOf(lastAssistantMsg);
    let userIdx = -1;
    for (let i = idx; i >= 0; i--) {
      if (state.messages[i].role === "user") { userIdx = i; break; }
    }
    if (userIdx < 0) return;
    const userMsg = state.messages[userIdx];
    // drop this assistant message (and anything after it), resend
    state.messages = state.messages.slice(0, userIdx + 1);
    renderMessages();
    doSend(userMsg.content, userMsg.context || []);
  }

  function staticToolCard(t) {
    const node = el("div", { class: "tool-card" + (typeof pref === "function" && pref("toolcards") ? " open" : "") });
    const ok = t.ok !== false && t.status !== "err";
    node.append(
      el("div", { class: "tool-head", onclick: () => node.classList.toggle("open") },
        el("span", { class: "t-ic " + (ok ? "ok" : "err"), html: `<svg><use href="${TOOL_ICONS[t.name] || "#i-zap"}"/></svg>` }),
        el("span", { class: "t-desc" }, el("b", null, esc(t.name)), "  " + esc(t.description || "")),
        el("span", { class: "t-state" }, ok ? "✓" : "✗"),
        ico("#i-chev-r"),
      ),
      el("div", { class: "tool-io" },
        el("div", { class: "io-label" }, "arguments"),
        el("pre", null, JSON.stringify(t.arguments || {}, null, 2)),
        t.output ? el("div", { class: "io-label" }, "result") : null,
        t.output ? el("pre", null, t.output) : null,
      ),
    );
    return node;
  }

  /* streaming message node */
  let streamNode = null, streamBody = null, streamMd = null, streamCaret = null, streamPending = "";
  let rafPending = false;
  let streamStats = { tokens: 0, start: 0 };
  let streamDone = null;

  function beginStreamNode() {
    const list = $("#msg-list");
    $("#messages").dataset.empty = "false";
    streamNode = el("div", { class: "msg assistant" });
    streamBody = el("div", { class: "assistant-body" });
    newStreamBlock();
    streamPending = "";
    streamStats = { tokens: 0, start: performance.now() };
    streamNode.append(
      el("div", { class: "assistant-head" },
        el("div", { class: "mark" }, el("svg", { viewBox: "0 0 24 24", html: '<path d="M12 2l2.4 6.2L21 10.5l-5.4 4 1.7 6.6L12 17.4l-5.3 3.7 1.7-6.6-5.4-4 6.6-2.3z" fill="currentColor"/>' })),
        el("span", { class: "who" }, "CortexSpace"),
        el("span", { class: "when stream-stats" }),
      ),
      streamBody,
    );
    streamPending = "";
    list.append(streamNode);
    scrollBottom();
  }

  function renderStreamText() {
    if (!streamMd) return;
    // rebuild: highlighted md + caret
    const tmp = el("div");
    tmp.innerHTML = MD.render(streamPending);
    streamMd.innerHTML = "";
    while (tmp.firstChild) streamMd.append(tmp.firstChild);
    streamMd.append(streamCaret);
    const st = streamNode && streamNode.querySelector(".stream-stats");
    if (st && streamStats.tokens > 2) {
      const secs = (performance.now() - streamStats.start) / 1000;
      st.textContent = Math.round(streamStats.tokens / Math.max(secs, 0.5)) + " tok/s · " + streamStats.tokens + " tok";
    }
    const got = streamStats.tokens - (streamStats.lastRendered || 0);
    streamStats.lastRendered = streamStats.tokens;
    scrollBottom();
    if (got > 0) bumpUnread(got);
  }

  function newStreamBlock() {
    streamMd = el("div", { class: "md" });
    if (!streamPending) streamMd.append(el("div", { class: "typing-dots" }, el("span"), el("span"), el("span")));
    streamCaret = el("span", { class: "caret" });
    streamMd.append(streamCaret);
    streamBody.append(streamMd);
  }

  function pushStreamToken(text) {
    if (!streamNode) beginStreamNode();
    if (!streamMd || !streamMd.isConnected) newStreamBlock();
    streamPending += text;
    streamStats.tokens++;
    if (!rafPending) {
      rafPending = true;
      requestAnimationFrame(() => { rafPending = false; renderStreamText(); });
    }
  }

  function detachStreamBlock() {
    if (streamMd && streamMd.isConnected) streamMd.remove();
    streamMd = null;
    streamCaret = null;
  }

  /* tool + approval cards */
  const liveTools = new Map(); // id -> {tool, node, approvalNode, approvalId}

  function appendToolCard(tool) {
    if (!streamNode) beginStreamNode();
    detachStreamBlock();
    const node = el("div", { class: "tool-card" + (typeof pref === "function" && pref("toolcards") ? " open" : "") });
    const head = el("div", { class: "tool-head", onclick: () => node.classList.toggle("open") },
      el("span", { class: "t-ic run", html: `<svg class="spin"><use href="${TOOL_ICONS[tool.name] || "#i-zap"}"/></svg>` }),
      el("span", { class: "t-desc" }, el("b", null, esc(tool.name)), "  " + esc(tool.description)),
      el("span", { class: "t-state" }, "running…"),
      ico("#i-chev-r", ),
    );
    head.children[head.children.length - 1].classList.add("t-caret");
    const io = el("div", { class: "tool-io" },
      el("div", { class: "io-label" }, "arguments"),
      el("pre", null, JSON.stringify(tool.arguments || {}, null, 2)),
    );
    node.append(head, io);
    streamBody.append(node);
    liveTools.set(tool.id, { tool, node, io, state: head.querySelector(".t-state"), ic: head.querySelector(".t-ic") });
    logActivity({ ...tool, status: "running", kind: "tool", when: Date.now() });
    scrollBottom();
    bumpUnread();
  }

  function finishToolCard(id, ok, output, ms) {
    const entry = liveTools.get(id);
    if (!entry) return;
    entry.state.textContent = ok ? `✓ ${ms}ms` : "✗ failed";
    entry.ic.classList.remove("run");
    entry.ic.classList.add(ok ? "ok" : "err");
    entry.ic.innerHTML = `<svg><use href="${TOOL_ICONS[entry.tool.name] || "#i-zap"}"/></svg>`;
    entry.io.append(el("div", { class: "io-label" }, "result"), el("pre", null, output || "(empty)"));
    entry.node.classList.add(ok ? "flash-ok" : "flash-err");
    setTimeout(() => entry.node.classList.remove("flash-ok", "flash-err"), 950);
    entry.tool.status = ok ? "ok" : "err";
    entry.tool.ok = ok;
    entry.tool.output = output;
    updateActivity(entry.tool);
    scrollBottom();
    bumpUnread();
  }

  /* approvals */
  function appendApprovalCard(a) {
    if (!streamNode) beginStreamNode();
    detachStreamBlock();
    const node = el("div", { class: "approval-card" });
    node.append(
      el("div", { class: "approval-head" },
        el("span", { class: "a-ic" }, el("svg", null, ico("#i-alert"))),
        el("div", null,
          el("div", { class: "a-title" }, "Agent wants to act"),
          el("div", { class: "a-sub" }, esc(a.description)),
        ),
      ),
      el("div", { class: "approval-desc" }, JSON.stringify(a.arguments, null, 2).slice(0, 600)),
      el("div", { class: "approval-actions" },
        el("button", { class: "btn approve", onclick: () => decide(a.id, "approved") }, ico("#i-check"), "Approve"),
        el("button", { class: "btn deny", onclick: () => decide(a.id, "denied") }, ico("#i-x"), "Deny"),
      ),
    );
    streamBody.append(node);
    // map to tool entry if exists (tool_call event came first)
    for (const [tid, e] of liveTools) {
      if (!e.approvalNode) e.approvalNode = node;
    }
    logActivity({ name: a.name, description: a.description, status: "approval", kind: "approval", when: Date.now() });
    scrollBottom();
    bumpUnread();
  }

  async function decide(aid, decision) {
    try {
      await api("/api/approvals/" + aid, { method: "POST", body: { decision } });
    } catch (e) {
      toast("Approval failed: " + e.message, "err");
    }
  }

  function resolveApprovalCard(aid, decision) {
    for (const [, e] of liveTools) {
      if (e.approvalNode) {
        e.approvalNode.classList.add("resolved", decision);
        const sub = e.approvalNode.querySelector(".a-sub");
        if (sub) sub.textContent = decision === "approved" ? "Approved — action completed or in progress" : `You ${decision} this action`;
        const ic = e.approvalNode.querySelector(".a-ic");
        if (ic) ic.innerHTML = `<svg><use href="${decision === "approved" ? "#i-check" : "#i-x"}"/></svg>`;
        e.approvalNode = null;
      }
    }
    updateActivityByStatus("approval", decision === "approved" ? "ok" : "err", decision);
  }

  /* ---------------- activity feed ---------------- */

  function logActivity(t) {
    state.activity.push(t);
    renderActivity();
  }
  function updateActivity(tool) {
    for (let i = state.activity.length - 1; i >= 0; i--) {
      const a = state.activity[i];
      if (a.name === tool.name && a.description === tool.description && (a.status === "running" || a.status === "approval")) {
        state.activity[i] = { ...a, status: tool.status, ok: tool.ok, ms: tool.duration_ms };
        break;
      }
    }
    renderActivity();
  }
  function updateActivityByStatus(from, to, note) {
    for (let i = state.activity.length - 1; i >= 0; i--) {
      if (state.activity[i].status === from) {
        state.activity[i] = { ...state.activity[i], status: to, note };
        break;
      }
    }
    renderActivity();
  }
  function renderActivity() {
    const box = $("#activity-list");
    const cb = $("#activity-count");
    if (cb) {
      const n = state.activity.length;
      cb.textContent = n > 99 ? "99+" : String(n);
      cb.classList.toggle("hidden", n === 0);
    }
    const shown = state.activity.filter((a) =>
      state.actFilter === "all" ||
      (state.actFilter === "tools" && a.kind !== "approval") ||
      (state.actFilter === "approvals" && a.kind === "approval")
    );
    if (!state.activity.length) {
      box.innerHTML = `<div class="panel-empty"><svg><use href="#i-activity"/></svg><p>Tool calls and approvals<br>appear here live.</p></div>`;
      return;
    }
    box.innerHTML = "";
    if (!shown.length) {
      box.append(el("div", { class: "panel-empty" }, "Nothing in this filter yet."));
      return;
    }
    for (const a of shown.slice(-60)) {
      box.append(
        el("div", { class: "act-item " + (a.status || "") },
          el("div", { class: "ai-head" },
            el("span", { class: "ai-dot" }),
            el("span", { class: "ai-name" }, esc(a.name || "event")),
            el("span", { class: "ai-ms" }, a.status === "ok" ? (a.ms != null ? a.ms + "ms" : "done") : a.status === "err" ? "failed" : a.status === "approval" ? (a.note || "waiting") : "…"),
          ),
          el("div", { class: "ai-desc" }, esc(a.description || "")),
        )
      );
    }
    box.scrollTop = box.scrollHeight;
  }

  /* ---------------- chat flow ---------------- */

  function scrollBottom(force) {
    const box = $("#messages");
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 140;
    if (force || nearBottom) box.scrollTop = box.scrollHeight;
    state.nearBottom = nearBottom;
    updateJumpBtn(nearBottom);
  }

  function updateJumpBtn(near) {
    const btn = $("#jump-btn");
    if (!btn) return;
    if (near || !state.streaming) { btn.classList.add("hidden"); return; }
    btn.classList.remove("hidden");
    $("#jump-count").textContent = state.unread;
  }

  async function send() {
    const input = $("#composer");
    const text = input.value.trim();
    if (!text || state.streaming) return;
    if (!state.chat) await newChat();
    input.value = "";
    autosize(input);
    const myContext = [...state.context];
    renderContextChips();
    await doSend(text, myContext);
  }

  async function doSend(text, myContext) {
    hulluCheck(text);
    if (state._editMid) {
      const i = state.messages.findIndex((m) => m.id === state._editMid);
      if (i >= 0) state.messages.splice(i, 1);
      const oldId = state._editMid;
      const cid = state.chat && state.chat.id;
      if (cid && oldId) api(`/api/chats/${cid}/messages/${oldId}`, { method: "DELETE" }).catch(() => {});
      state._editMid = null;
    }
    localStorage.removeItem(state.chat ? "cs-draft-" + state.chat.id : "cs-draft-new");
    const df = $("#draft-flag"); if (df) df.classList.add("hidden");
    W5_STATS.msgs++; w5stat("msgs", W5_STATS.msgs);
    checkAchievements();
    renderGoal();
    setStreaming(true);
    state.streamText = "";
    streamDone = null;
    state.unread = 0;
    state.nearBottom = true;
    updateJumpBtn(true);
    liveTools.clear();
    state.activity = [];
    renderActivity();

    // user bubble immediately
    const userMsg = { role: "user", content: text, context: myContext, created_at: Date.now() };
    state.messages.push(userMsg);
    renderMessages();

    state.controller = new AbortController();
    try {
      const _pin = pinnedModel(state.chat.id);
      const _body = { content: text, context: myContext };
      if (_pin) _body.model = _pin;
      await ssePost(`/api/chats/${state.chat.id}/messages`, _body, (ev, data) => {
        switch (ev) {
          case "token":
            state.streamText += data.text;
            pushStreamToken(data.text);
            break;
          case "tool_call": {
            appendToolCard({ id: data.id, name: data.name, arguments: data.arguments, description: data.description });
            $("#status-left").textContent = "Working… " + (data.description || data.name);
            break;
          }
          case "approval_request":
            appendApprovalCard(data);
            toast("Approval needed: " + data.description, "warn", 6000);
            break;
          case "approval_resolved":
            resolveApprovalCard(data.id, data.decision);
            break;
          case "tool_result":
            finishToolCard(data.id, data.ok, data.output, data.duration_ms);
            W5_STATS.tools++; w5stat("tools", W5_STATS.tools);
            checkAchievements();
            break;
          case "done":
            streamDone = data;
            break;
          case "error":
            toast(data.message, "err", 6000);
            break;
        }
      }, state.controller.signal);
    } catch (e) {
      if (e.name !== "AbortError") toast(e.message, "err");
    } finally {
      setStreaming(false);
      await afterTurn();
    }
  }

  async function afterTurn() {
    // finalize the streaming node into a stored message by re-fetching
    const hadStream = !!streamNode;
    if (hadStream) {
      streamCaret && streamCaret.remove();
      const finalText = state.streamText || "";
      const tools = [...liveTools.values()].map((e) => ({ ...e.tool }));
      streamNode.remove();
      streamNode = null;
      const meta = streamDone ? { model: streamDone.model, usage: streamDone.usage, duration_ms: streamDone.duration_ms, ttft_ms: streamDone.ttft_ms } : {};
      state.messages.push({ role: "assistant", content: finalText, tools, meta, created_at: Date.now() });
      renderMessages();
    }
    state.streamText = "";
    if (state.chat) {
      try {
        const d = await api("/api/chats/" + state.chat.id);
        state.chat = d.chat;
        state.messages = d.messages.map(historyMsg);
        renderMessages();
        renderChatList();
        const st = state.messages[state.messages.length - 1];
        if (st && st.role === "assistant" && st.meta) {
          $("#status-left").textContent = "Ready";
          $("#status-right").textContent =
            `${st.meta.model || ""} · ${st.meta.duration_ms != null ? (st.meta.duration_ms / 1000).toFixed(1) + "s" : ""}` +
            `${st.meta.usage ? " · " + ((st.meta.usage.prompt_tokens || 0) + (st.meta.usage.completion_tokens || 0)) + " tok" : ""}`;
        }
      } catch { /* keep live state */ }
    }
    if (state.openFile) { /* file may have changed on disk via agent */ }
    loadTree().catch(() => {});
    loadUsage().catch(() => {});
    loadChats().then(() => {
      // flash the chat item if it just got auto-titled
      const item = $$("#chat-list .chat-item").find((n) => n.querySelector(".ci-title")?.textContent === state.chat?.title);
      if (item) { item.classList.remove("retitled"); void item.offsetWidth; item.classList.add("retitled"); }
    }).catch(() => {});
    if (localStorage.getItem("cs-notify") === "1" && "Notification" in window && Notification.permission === "granted" && !document.hasFocus()) {
      try {
        new Notification("CortexSpace — done", { body: state.chat ? state.chat.title : "Your turn finished" });
      } catch { /* no Notification support */ }
    }
    $("#composer").focus();
  }

  function setStreaming(on) {
    state.streaming = on;
    const btn = $("#btn-send");
    btn.classList.toggle("streaming", on);
    btn.disabled = on ? false : !$("#composer").value.trim();
    $("#composer-hint").textContent = on ? "Agent is working…  (button = stop)" : "Enter to send · Shift+Enter for a new line";
    $("#status-left").textContent = on ? "Working…" : "Ready";
    if (!on) state.controller = null;
  }

  function stop() {
    if (state.controller) state.controller.abort();
  }

  /* ---------------- composer ---------------- */

  function autosize(t) {
    t.style.height = "auto";
    t.style.height = Math.min(t.scrollHeight, 220) + "px";
  }

  function renderContextChips() {
    const box = $("#context-chips");
    box.innerHTML = "";
    for (const p of state.context) {
      const isPage = p.startsWith("page:");
      box.append(
        el("span", { class: "cc", title: p },
          ico(isPage ? "#i-globe" : "#i-file"),
          esc(isPage ? "page: " + (p.slice(5).split("/")[2] || p.slice(5)) : p),
          el("button", { title: "Remove", onclick: () => { state.context = state.context.filter((x) => x !== p); renderContextChips(); } }, ico("#i-x")))
      );
    }
  }

  function flatFiles() {
    const out = [];
    const walk = (nodes) => {
      for (const n of nodes) {
        if (n.is_dir) walk(n.children || []);
        else out.push(n.path);
      }
    };
    walk(state.tree);
    return out;
  }

  /* attach popover */
  function openAttach() {
    const pop = $("#attach-pop");
    const rect = $("#btn-attach").getBoundingClientRect();
    pop.style.bottom = (window.innerHeight - rect.top + 8) + "px";
    pop.style.left = Math.max(12, rect.left - 160) + "px";
    pop.style.top = "auto";
    pop.classList.remove("hidden");
    $("#attach-filter").value = "";
    renderAttachList();
    $("#attach-filter").focus();
  }
  function renderAttachList() {
    const list = $("#attach-list");
    list.innerHTML = "";
    const q = ($("#attach-filter").value || "").toLowerCase();
    const files = flatFiles().filter((f) => !q || f.toLowerCase().includes(q)).slice(0, 60);
    if (!files.length) list.append(el("div", { class: "pop-item", style: "opacity:.5;cursor:default" }, "No matching files"));
    for (const f of files) {
      list.append(el("div", {
        class: "pop-item",
        onclick: () => {
          if (!state.context.includes(f)) state.context.push(f);
          renderContextChips();
          $("#attach-pop").classList.add("hidden");
          $("#composer").focus();
        },
      }, ico("#i-file"), esc(f)));
    }
  }

  /* ---------------- file panel ---------------- */

  async function openFile(path) {
    try {
      const d = await api("/api/files/read?path=" + encodeURIComponent(path));
      state.openFile = { path, content: d.content, saved: true, binary: d.binary, view: /\.(md|markdown|txt)$/.test(path) ? "preview" : "source" };
      setPanelTab("file");
      ensurePanelOpen();
      renderFilePanel();
      renderTree();
    } catch (e) {
      toast("Cannot open file: " + e.message, "err");
    }
  }

  function syncGutter(gut, ta) {
    const lines = ta.value.split("\n").length;
    let t = "";
    for (let i = 1; i <= lines; i++) t += i + "\n";
    gut.innerHTML = "<pre>" + t + "</pre>";
  }

  function updateFileStats(f) {
    const words = (f.content.match(/\S+/g) || []).length;
    const lines = f.content ? f.content.split("\n").length : 0;
    const s = $("#file-stats");
    if (s) s.textContent = `${lines} lines · ${words} words · ${human(f.content.length)}`;
  }

  function renderFilePanel() {
    const box = $("#file-content");
    const path = $("#file-path");
    const dot = $("#dirty-dot");
    if (!state.openFile) {
      path.textContent = "No file open";
      box.innerHTML = `<div class="panel-empty"><svg><use href="#i-file"/></svg><p>Select a file from the workspace tree,<br>or let the agent create one.</p><button class="btn ghost sm" id="btn-new-note-2b">New note</button></div>`;
      $("#btn-file-save").disabled = true;
      $("#btn-file-send").disabled = true;
      if (dot) dot.hidden = true;
      const st = $("#file-stats"); if (st) st.textContent = "";
      const nb = $("#btn-new-note-2b");
      if (nb) nb.onclick = promptNewNote;
      return;
    }
    const f = state.openFile;
    path.textContent = f.path;
    box.innerHTML = "";
    if (dot) dot.hidden = f.saved;
    if (f.binary) {
      box.append(el("div", { class: "panel-empty" }, el("svg", null, ico("#i-file")), "Binary file — nothing to preview."));
      const st = $("#file-stats"); if (st) st.textContent = "";
    } else if (f.view === "preview" && /\.(md|markdown|txt)$/.test(f.path)) {
      const p = el("div", { class: "file-preview" }, el("div", { class: "md", html: MD.render(f.content) }));
      box.append(p);
      updateFileStats(f);
    } else {
      const ta = el("textarea", { class: "file-editor", spellcheck: "false" });
      ta.value = f.content;
      if (f.locked) { ta.classList.add("readonly"); $("#btn-file-lock").classList.add("on"); ta.addEventListener("keydown", (e) => { if (e.key !== "Shift" && e.key !== "Meta" && e.key !== "Control") e.preventDefault(); }, { capture: true }); }
      ta.addEventListener("keyup", updateCursorPos);
      ta.addEventListener("click", updateCursorPos);
      const gut = el("div", { class: "ln-gutter" });
      ta.addEventListener("input", () => {
        f.content = ta.value;
        f.saved = false;
        $("#btn-file-save").disabled = false;
        if (dot) dot.hidden = false;
        syncGutter(gut, ta);
        updateFileStats(f);
      });
      ta.addEventListener("scroll", () => { gut.scrollTop = ta.scrollTop; });
      ta.addEventListener("keydown", (e) => {
        if (e.key === "Tab") {
          e.preventDefault();
          const s = ta.selectionStart, ep = ta.selectionEnd;
          ta.setRangeText("\t", s, ep, "end");
          ta.dispatchEvent(new Event("input"));
        }
      });
      const wrap = el("div", { class: "editor-wrap" });
      wrap.append(gut, ta);
      box.append(wrap);
      syncGutter(gut, ta);
      updateFileStats(f);
    }
    $("#btn-file-save").disabled = f.saved;
    $("#btn-file-send").disabled = false;
  }

  async function saveFile() {
    const f = state.openFile;
    if (!f || f.binary) return;
    try {
      await api("/api/files/write", { method: "PUT", body: { path: f.path, content: f.content } });
      f.saved = true;
      $("#btn-file-save").disabled = true;
      const dot = $("#dirty-dot");
      if (dot) dot.hidden = true;
      toast("Saved " + f.path);
      loadTree();
    } catch (e) {
      toast("Save failed: " + e.message, "err");
    }
  }

  async function deleteFile() {
    const f = state.openFile;
    if (!f) return;
    if (!confirm(`Delete ${f.path}?`)) return;
    const snap = f.binary ? null : { path: f.path, content: f.content };
    try {
      await api("/api/files?path=" + encodeURIComponent(f.path), { method: "DELETE" });
      state.openFile = null;
      renderFilePanel();
      loadTree();
      if (snap) toastUndo("Deleted " + snap.path, "Undo", async () => {
        try { await api("/api/files/write", { method: "PUT", body: snap }); loadTree(); toast("File restored"); }
        catch (e) { toast(e.message, "err"); }
      });
      else toast("Deleted " + f.path);
    } catch (e) {
      toast(e.message, "err");
    }
  }

  function promptNewNote() {
    pathModal("New note", "notes/my-note.md", "notes/", "Create", (path) => {
      const clean = path.replace(/[^A-Za-z0-9_\-. ]/g, "");
      const finalPath = clean.includes(".") ? clean : clean + ".md";
      const title = clean.split("/").pop().replace(/\.md$/i, "").replace(/[-_]/g, " ");
      api("/api/files/write", { method: "PUT", body: { path: finalPath, content: "# " + title + "\n\n" } })
        .then(() => { loadTree(); return openFile(finalPath); })
        .catch((e) => toast(e.message, "err"));
    });
  }

  function promptNewFolder() {
    pathModal("New folder", "projects/next-quarter", "", "Create", (path) => {
      const clean = path.replace(/[^A-Za-z0-9_\-./ ]/g, "");
      api("/api/files/mkdir", { method: "POST", body: { path: clean } })
        .then(() => { loadTree(); toast("Created " + clean); })
        .catch((e) => toast(e.message, "err"));
    });
  }

  function renameItem(path, isDir) {
    pathModal(isDir ? "Rename folder" : "Rename file", path, path, "Rename", (dst) => {
      const clean = dst.replace(/[^A-Za-z0-9_\-./ ]/g, "");
      if (!clean || clean === path) return;
      api("/api/files/rename", { method: "POST", body: { src: path, dst: clean } })
        .then(() => {
          if (state.openFile && state.openFile.path === path) { state.openFile = null; renderFilePanel(); }
          loadTree();
          toast("Renamed to " + clean);
        })
        .catch((e) => toast(e.message, "err"));
    });
  }

  /* ---------------- browser panel ---------------- */

  let browserUrl = "";
  function ensureBrowserLoad() {
    if (!browserUrl) return;
    const frame = $("#browser-frame");
    frame.classList.remove("hidden");
    $("#browser-fallback").classList.add("hidden");
    frame.src = browserUrl;
    $("#browser-status").textContent = "loading…";
    $("#btn-browser-chat").disabled = false;
    frame.onload = () => { $("#browser-status").textContent = "loaded (may be restricted by the site)"; };
  }
  function browserGo() {
    let u = $("#browser-url").value.trim();
    if (!u) return;
    if (!/^https?:\/\//i.test(u)) u = "https://" + u;
    browserUrl = u;
    ensureBrowserLoad();
  }
  async function browserToChat() {
    if (!browserUrl) return;
    if (!state.context.includes("page:" + browserUrl)) state.context.push("page:" + browserUrl);
    renderContextChips();
    toast("Page added to chat context");
    $("#composer").focus();
  }

  /* ---------------- settings ---------------- */

  async function loadSettings() {
    state.settings = await api("/api/settings");
    fillSettings();
    updateProviderChip();
    updateModelBadge();
    refreshProviderStatus();
  }

  function fillSettings() {
    const s = state.settings;
    $("#set-ollama-url").value = s.ollama_base_url;
    $("#set-ollama-model").value = s.ollama_model;
    $("#set-or-key").value = s.openrouter_api_key;
    $("#set-or-model").value = s.openrouter_model;
    $("#set-or-url").value = s.openrouter_site_url;
    $("#set-oai-url").value = s.openai_base_url;
    $("#set-oai-key").value = s.openai_api_key;
    $("#set-oai-model").value = s.openai_model;
    $("#set-temp").value = s.temperature;
    $("#temp-val").textContent = s.temperature;
    $("#set-mtok").value = s.max_tokens;
    $("#mtok-val").textContent = s.max_tokens;
    $("#set-steps").value = s.max_steps;
    $("#set-allow-py").checked = s.allow_python;
    $("#set-auto-approve").checked = s.auto_approve;
    $("#set-ddg").checked = s.ddg_enabled;
    $("#set-searxng").value = s.searxng_url;
    $("#set-prompt").value = s.system_prompt;
    renderProviderCards();
    if (typeof renderToolToggles === "function") renderToolToggles();
  }

  function renderProviderCards() {
    const box = $("#provider-cards");
    box.innerHTML = "";
    const defs = [
      { id: "demo", name: "Demo (built-in)", blurb: "Zero-config, offline. Try everything instantly." },
      { id: "ollama", name: "Ollama", blurb: "Local models on your machine. Private by default." },
      { id: "openrouter", name: "OpenRouter", blurb: "One key → 300+ cloud models." },
      { id: "openai", name: "OpenAI-compatible", blurb: "OpenAI, Groq, LM Studio, vLLM — set the base URL." },
    ];
    for (const d of defs) {
      const card = el("button", {
        class: "prov-card" + (state.settings.provider === d.id ? " active" : ""),
        type: "button",
        "data-pid": d.id,
        onclick: () => {
          state.settings.provider = d.id;
          renderProviderCards();
        },
      },
        el("span", { class: "pc-name" }, el("span", { class: "radio" }), esc(d.name), el("span", { class: "pc-dot", "data-dot": d.id })),
        el("span", { class: "pc-blurb" }, d.blurb),
      );
      box.append(card);
    }
    $("#prov-ollama").classList.toggle("hidden", state.settings.provider !== "ollama");
    $("#prov-openrouter").classList.toggle("hidden", state.settings.provider !== "openrouter");
    $("#prov-openai").classList.toggle("hidden", state.settings.provider !== "openai");
  }

  async function refreshProviderStatus() {
    for (const dot of $$(".pc-dot")) dot.classList.add("busy");
    try {
      const d = await api("/api/providers/status");
      for (const [pid, st] of Object.entries(d.status)) {
        const dot = document.querySelector(`.pc-dot[data-dot="${pid}"]`);
        if (dot) {
          dot.classList.remove("busy");
          dot.classList.add(st.ok ? "ok" : "err");
          dot.title = st.message;
        }
      }
    } catch (e) { /* non-fatal */ }
  }

  async function saveSettings() {
    const s = state.settings;
    s.ollama_base_url = $("#set-ollama-url").value.trim();
    s.ollama_model = $("#set-ollama-model").value.trim() || "llama3.2";
    s.openrouter_api_key = $("#set-or-key").value.trim();
    s.openrouter_model = $("#set-or-model").value.trim() || "openrouter/auto";
    s.openrouter_site_url = $("#set-or-url").value.trim();
    s.openai_base_url = $("#set-oai-url").value.trim() || "https://api.openai.com/v1";
    s.openai_api_key = $("#set-oai-key").value.trim();
    s.openai_model = $("#set-oai-model").value.trim() || "gpt-4o-mini";
    s.temperature = parseFloat($("#set-temp").value);
    s.max_tokens = parseInt($("#set-mtok").value, 10);
    s.max_steps = Math.min(20, Math.max(1, parseInt($("#set-steps").value, 10) || 6));
    s.allow_python = $("#set-allow-py").checked;
    s.auto_approve = $("#set-auto-approve").checked;
    s.ddg_enabled = $("#set-ddg").checked;
    s.searxng_url = $("#set-searxng").value.trim();
    s.system_prompt = $("#set-prompt").value;
    s.disabled_tools = Array.isArray(s.disabled_tools) ? s.disabled_tools : [];
    s.strict_approve = !!s.strict_approve;
    try {
      state.settings = await api("/api/settings", { method: "PUT", body: s });
      const badge = $("#settings-saved");
      badge.textContent = "Saved ✓";
      badge.classList.add("show");
      setTimeout(() => badge.classList.remove("show"), 1800);
      updateProviderChip();
      updateModelBadge();
      toast("Settings saved");
      refreshProviderStatus();
    } catch (e) {
      toast("Save failed: " + e.message, "err");
    }
  }

  const REFRESH_BTN = { ollama: "#btn-refresh-ollama", openrouter: "#btn-refresh-or", openai: "#btn-refresh-oai" };
  const MODELS_LIST = { ollama: "#ollama-models", openrouter: "#or-models", openai: "#oai-models" };

  async function refreshModels(pid) {
    const btn = $(REFRESH_BTN[pid]);
    const out = $(MODELS_LIST[pid]);
    btn.disabled = true;
    try {
      const d = await api("/api/models?provider=" + pid);
      out.innerHTML = d.models.map((m) => `<option value="${esc(m)}">`).join("");
      if (!d.ok) toast(d.error, "warn");
      else toast(`Loaded ${d.models.length} models`);
    } catch (e) {
      toast(e.message, "err");
    }
    btn.disabled = false;
  }

  async function pingProvider(pid) {
    const out = $("#ping-" + (pid === "openrouter" ? "or" : pid === "ollama" ? "ollama" : "oai"));
    out.className = "set-test-out";
    out.textContent = "testing…";
    try {
      const d = await api(`/api/providers/${pid}/ping`);
      out.textContent = d.ok ? `✓ ${d.message}` : `✗ ${d.message}`;
      out.classList.add(d.ok ? "ok" : "err");
    } catch (e) {
      out.textContent = "✗ " + e.message;
      out.classList.add("err");
    }
  }

  function updateProviderChip() {
    const s = state.settings;
    if (!s) return;
    const dot = $("#provider-dot");
    const label = $("#provider-label");
    if (s.provider === "demo") { dot.className = "dot ok"; label.textContent = "Demo · offline"; }
    else if (s.provider === "ollama") { dot.className = "dot"; label.textContent = "Ollama · " + s.ollama_model; }
    else if (s.provider === "openrouter") { dot.className = s.openrouter_api_key ? "dot ok" : "dot err"; label.textContent = "OpenRouter · " + s.openrouter_model; }
    else if (s.provider === "openai") { dot.className = s.openai_api_key ? "dot ok" : "dot err"; label.textContent = "OpenAI · " + s.openai_model; }
  }

  function currentModel(s) {
    if (!s) return "—";
    if (s.provider === "ollama") return s.ollama_model;
    if (s.provider === "openrouter") return s.openrouter_model;
    if (s.provider === "openai") return s.openai_model;
    return "cortexspace-demo";
  }

  /* ---- per-chat model pinning (wrapper's model freedom) ---- */
  function chatPins() { try { return JSON.parse(localStorage.getItem("cs-chat-model") || "{}"); } catch { return {}; } }
  function pinnedModel(cid) { return (cid && chatPins()[cid]) || ""; }
  function setPinnedModel(cid, model) {
    const p = chatPins();
    if (model) p[cid] = model; else delete p[cid];
    localStorage.setItem("cs-chat-model", JSON.stringify(p));
    updateModelBadge();
    toast(model ? "Pinned " + model + " to this chat" : "Model pin cleared");
  }
  let pinMenu = null;
  function closePinMenu() { if (pinMenu) { pinMenu.remove(); pinMenu = null; } }
  async function togglePinMenu(ev) {
    ev && ev.stopPropagation();
    if (pinMenu) return closePinMenu();
    const cid = state.chat && state.chat.id;
    if (!cid) return toast("Start a chat first", "warn");
    const cur = pinnedModel(cid);
    let models = [];
    try { models = (await api("/api/models")).models || []; } catch {}
    const item = (label, active, fn, sub) => el("button", {
      class: "pin-item" + (active ? " on" : ""),
      onclick: () => { fn(); closePinMenu(); },
    }, el("span", null, label), sub ? el("span", { class: "pin-sub" }, sub) : null);
    pinMenu = el("div", { class: "pin-menu", style: "position:fixed;z-index:999" },
      el("div", { class: "pin-title" }, "Model for this chat"),
      item("Settings default", !cur, () => setPinnedModel(cid, ""), "whatever Settings says"),
    );
    for (const m of models) pinMenu.append(item(m, m === cur, () => setPinnedModel(cid, m)));
    if (!models.length) pinMenu.append(el("div", { class: "pin-sub", style: "padding:4px 12px 8px" }, "no models available"));
    if (cur) pinMenu.append(item("Clear pin", false, () => setPinnedModel(cid, ""), "back to default"));
    document.body.append(pinMenu);
    const r = ev && ev.currentTarget ? ev.currentTarget.getBoundingClientRect() : { bottom: 60, right: innerWidth - 250 };
    pinMenu.style.top = (r.bottom + 6) + "px";
    pinMenu.style.left = Math.max(8, r.right - 250) + "px";
    setTimeout(() => document.addEventListener("click", closePinMenu, { once: true }), 0);
  }

  function updateModelBadge() {
    const s = state.settings;
    if (!s) return;
    const pinned = pinnedModel(state.chat && state.chat.id);
    const badge = $("#model-badge");
    if (pinned) {
      $("#model-badge-text").textContent = "📌 " + pinned;
      if (badge) badge.title = "Pinned model for this chat — click to change";
    } else {
      $("#model-badge-text").textContent = s.provider === "demo" ? "demo (offline)" : `${s.provider} · ${currentModel(s)}`;
      if (badge) badge.title = "Active model — click to pin one to this chat";
    }
  }

  /* ---------------- palette ---------------- */

  function paletteItems() {
    const items = [
      { icon: "#i-plus", title: "New chat", sub: "Start a fresh conversation", key: "⌘N", run: newChat },
      { icon: "#i-search", title: "Search everything", sub: "Search chats and workspace files", key: "⌘F", run: openSearch },
      { icon: "#i-file", title: "New note", sub: "Create a note in the workspace", run: promptNewNote },
      { icon: "#i-folder", title: "New folder", sub: "Create a folder in the workspace", run: promptNewFolder },
      { icon: "#i-download", title: "Export current chat", sub: "Download this chat as Markdown", run: exportChat },
      { icon: "#i-gear", title: "Settings", sub: "Provider, model, agent behavior", key: "⌘,", run: () => showView("settings") },
      { icon: state.theme === "dark" ? "#i-sun" : "#i-moon", title: state.theme === "dark" ? "Switch to light theme" : "Switch to dark theme", key: "⌘.", run: toggleTheme },
      { icon: "#i-sidebar", title: "Toggle sidebar", key: "⌘B", run: () => toggleSidebar() },
      { icon: "#i-panel", title: "Toggle panel", key: "⌘J", run: () => togglePanel() },
      { icon: "#i-focus", title: "Focus mode", key: "⌘\\", run: () => toggleFocusMode() },
      { icon: "#i-pin", title: "Pin / unpin current chat", run: () => state.chat && pinToggle(state.chat) },
      { icon: "#i-fork", title: "Fork current chat", run: () => forkChatFrom(null) },
      { icon: "#i-chart", title: "Usage insights", run: () => { ensurePanelOpen(); setPanelTab("insights"); renderInsights(); } },
      { icon: "#i-keyboard", title: "Keyboard shortcuts", key: "?", run: () => openShortcuts() },
      { icon: "#i-spark", title: "Replay the tour", run: () => { tourIdx = 0; tourShow(); } },
      { icon: "#i-download", title: "Download workspace as .zip", run: () => { window.location.href = "/api/workspace/zip"; toast("Downloading workspace…"); } },
    ];
    for (const c of state.chats.slice(0, 12)) {
      items.push({ icon: "#i-chat", title: "Open chat: " + c.title, sub: relTime(c.updated_at), run: () => openChat(c.id) });
    }
    for (const f of flatFiles().slice(0, 40)) {
      items.push({ icon: "#i-file", title: "Open file: " + f, run: () => openFile(f) });
    }
    if (state._paletteExtra) for (const x of state._paletteExtra) items.push({ icon: x.icon, title: x.label, run: x.run });
    return items;
  }

  let palSel = 0, palFiltered = [];
  function openPalette() {
    state.paletteOpen = true;
    palSel = 0;
    $("#palette").classList.remove("hidden");
    const inp = $("#palette-input");
    inp.value = "";
    renderPalette();
    inp.focus();
  }
  function closePalette() {
    state.paletteOpen = false;
    $("#palette").classList.add("hidden");
  }
  function renderPalette() {
    const q = ($("#palette-input").value || "").toLowerCase();
    const all = paletteItems();
    palFiltered = q ? all.filter((i) => (i.title + " " + (i.sub || "")).toLowerCase().includes(q)).slice(0, 14) : all.slice(0, 14);
    if (palSel >= palFiltered.length) palSel = 0;
    const list = $("#palette-list");
    list.innerHTML = "";
    if (!palFiltered.length) list.append(el("div", { class: "pal-item", style: "opacity:.5;cursor:default" }, el("div", { class: "pi-main" }, el("div", { class: "pi-title" }, "No matches"))));
    palFiltered.forEach((it, idx) => {
      const node = el("div", {
        class: "pal-item" + (idx === palSel ? " sel" : ""),
        onmouseenter: () => { palSel = idx; renderPalette(); },
        onclick: () => runPal(it),
      },
        el("div", { class: "pi-ic" }, el("svg", null, ico(it.icon))),
        el("div", { class: "pi-main" }, el("div", { class: "pi-title" }, esc(it.title)), it.sub ? el("div", { class: "pi-sub" }, esc(it.sub)) : null),
        it.key ? el("span", { class: "pi-key" }, it.key) : null,
      );
      list.append(node);
      if (idx === palSel) node.scrollIntoView({ block: "nearest" });
    });
  }
  function runPal(it) {
    closePalette();
    it.run();
  }

  /* ---------------- global search ---------------- */

  let searchTimer = null;
  function openSearch() {
    $("#search-overlay").classList.remove("hidden");
    const inp = $("#search-input");
    inp.value = "";
    inp.focus();
    $("#search-results").innerHTML = '<div class="search-hint">Type to search everything — your chats and the whole workspace.</div>';
  }
  function closeSearch() { $("#search-overlay").classList.add("hidden"); }

  function hi(text, q) {
    const safe = esc(text);
    if (!q) return safe;
    const re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
    return safe.replace(re, "<mark>$1</mark>");
  }

  async function runSearch() {
    const q = $("#search-input").value.trim();
    const box = $("#search-results");
    if (!q) {
      box.innerHTML = '<div class="search-hint">Type to search everything — your chats and the whole workspace.</div>';
      return;
    }
    try {
      const d = await api("/api/search/global", { method: "POST", body: { q } });
      box.innerHTML = "";
      if (!d.chats.length && !d.files.length) {
        box.innerHTML = `<div class="search-hint">Nothing found for “${esc(q)}”.</div>`;
        return;
      }
      if (d.chats.length) {
        box.append(el("div", { class: "search-section-label" }, `Chats · ${d.chats.length}`));
        for (const c of d.chats) {
          box.append(el("div", { class: "search-item", onclick: () => { closeSearch(); openChat(c.id); } },
            el("div", { class: "si-ic" }, el("svg", null, ico("#i-chat"))),
            el("div", { class: "si-main" },
              el("div", { class: "si-title", html: hi(c.title, q) }),
              el("div", { class: "si-sub", html: hi(c.snippet, q) }),
            )));
        }
      }
      if (d.files.length) {
        box.append(el("div", { class: "search-section-label" }, `Workspace files · ${d.files.length}`));
        for (const f of d.files) {
          box.append(el("div", { class: "search-item", onclick: () => { closeSearch(); openFile(f.path); } },
            el("div", { class: "si-ic" }, el("svg", null, ico("#i-file"))),
            el("div", { class: "si-main" },
              el("div", { class: "si-title" }, esc(f.path)),
              el("div", { class: "si-sub" }, (f.matches && f.matches[0] ? f.matches[0].text : "") + `  ·  ${f.count} match${f.count > 1 ? "es" : ""}`),
            )));
        }
      }
    } catch (e) {
      box.innerHTML = `<div class="search-hint">${esc(e.message)}</div>`;
    }
  }

  /* ---------------- chat export ---------------- */

  async function exportChat() {
    if (!state.chat) return;
    try {
      const res = await fetch("/api/chats/" + state.chat.id + "/export");
      if (!res.ok) throw new Error(res.statusText);
      const blob = await res.blob();
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (state.chat.title.replace(/[^\w\- ]+/g, "").trim() || "chat") + ".md";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Chat exported as Markdown");
    } catch (e) {
      toast("Export failed: " + e.message, "err");
    }
  }

  /* ---------------- drag & drop upload ---------------- */

  let dragDepth = 0;
  function hasFiles(e) { return e.dataTransfer && [...(e.dataTransfer.types || [])].includes("Files"); }
  async function uploadFile(file, dir) {
    const form = new FormData();
    form.append("file", file);
    form.append("dir", dir || "");
    const res = await fetch("/api/files/upload", { method: "POST", body: form });
    if (!res.ok) {
      let msg;
      try { msg = (await res.json()).detail || res.statusText; } catch { msg = res.statusText; }
      throw new Error(msg);
    }
    return res.json();
  }

  /* ---------------- layout toggles ---------------- */

  function toggleSidebar() {
    state.sidebarOpen = !state.sidebarOpen;
    $("#app").classList.toggle("no-sidebar", !state.sidebarOpen);
  }
  function togglePanel() {
    state.panelOpen = !state.panelOpen;
    $("#app").classList.toggle("no-panel", !state.panelOpen);
  }
  function ensurePanelOpen() {
    if (!state.panelOpen) togglePanel();
  }
  function setPanelTab(tab) {
    state.panelTab = tab;
    $$(".ptab").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    $$(".panel-body").forEach((b) => b.classList.add("hidden"));
    $("#panel-" + tab).classList.remove("hidden");
    if (tab === "insights") renderInsights();
  }
  function toggleTheme() {
    state.theme = state.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = state.theme;
    localStorage.setItem("cs-theme", state.theme);
    $("#btn-theme svg use").setAttribute("href", state.theme === "dark" ? "#i-sun" : "#i-moon");
  }

  /* ---------------- wave 4: pin / fork ---------------- */

  async function pinToggle(chat) {
    try {
      await api("/api/chats/" + chat.id + "/pin", { method: "POST", body: { pin: !chat.pin } });
      await loadChats();
    } catch (e) { toast("Pin failed: " + e.message, "err"); }
  }

  async function forkChatFrom(mid) {
    if (!state.chat) return;
    try {
      const d = await api("/api/chats/" + state.chat.id + "/fork", {
        method: "POST",
        body: { message_id: mid || null },
      });
      toast(mid ? "Forked up to that message" : "Chat forked");
      await openChat(d.id);
    } catch (e) { toast("Fork failed: " + e.message, "err"); }
  }

  /* ---------------- wave 4: slash commands ---------------- */

  const SLASH = [
    { cmd: "new", desc: "Start a fresh chat", run: () => newChat() },
    { cmd: "note", arg: "title", desc: "Create a note", run: (a) => promptNewNoteAt(a) },
    { cmd: "folder", arg: "name", desc: "Create a folder", run: (a) => promptNewFolderAt(a) },
    { cmd: "search", arg: "query", desc: "Search chats + workspace", run: (a) => { openSearch(); $("#search-input").value = a; runSearch(); } },
    { cmd: "python", arg: "code", desc: "Run Python via the agent", run: (a) => doSend("Run this Python code and show the output:\n```python\n" + a + "\n```", []) },
    { cmd: "read", arg: "path", desc: "Agent reads a file", run: (a) => doSend("Read the file " + a + " and give me the key points.", []) },
    { cmd: "export", desc: "Export current chat (Markdown)", run: () => exportChat() },
    { cmd: "pin", desc: "Pin / unpin this chat", run: () => state.chat && pinToggle(state.chat) },
    { cmd: "fork", desc: "Fork this chat", run: () => forkChatFrom(null) },
    { cmd: "stats", desc: "Open usage insights", run: () => { ensurePanelOpen(); setPanelTab("insights"); renderInsights(); } },
    { cmd: "theme", desc: "Toggle light / dark", run: () => toggleTheme() },
    { cmd: "focus", desc: "Toggle focus mode", run: () => toggleFocusMode() },
    { cmd: "settings", desc: "Open settings", run: () => showView("settings") },
    { cmd: "help", desc: "Keyboard shortcuts", run: () => openShortcuts() },
  ];
  let slashSel = 0, slashFiltered = [];

  function promptNewNoteAt(title) {
    title = (title || "").trim().replace(/[^A-Za-z0-9_\- ]/g, "").replace(/\s+/g, "-").toLowerCase() || "new-note";
    pathModal("New note", "notes/my-note.md", "notes/" + title + ".md", "Create", (path) => {
      const clean = path.replace(/[^A-Za-z0-9_\-./ ]/g, "");
      const finalPath = clean.includes(".") ? clean : clean + ".md";
      const t = clean.split("/").pop().replace(/\.md$/i, "").replace(/[-_]/g, " ");
      api("/api/files/write", { method: "PUT", body: { path: finalPath, content: "# " + t + "\n\n" } })
        .then(() => { loadTree(); return openFile(finalPath); })
        .catch((e) => toast(e.message, "err"));
    });
  }
  function promptNewFolderAt(name) {
    name = (name || "").trim().replace(/[^A-Za-z0-9_\-./ ]/g, "").replace(/\s+/g, "-");
    pathModal("New folder", "projects/next-quarter", name, "Create", (path) => {
      const clean = path.replace(/[^A-Za-z0-9_\-./ ]/g, "");
      api("/api/files/mkdir", { method: "POST", body: { path: clean } })
        .then(() => { loadTree(); toast("Created " + clean); })
        .catch((e) => toast(e.message, "err"));
    });
  }

  function slashParse() {
    const v = $("#composer").value;
    if (!v.startsWith("/") || v.includes("\n")) return null;
    const m = v.slice(1).match(/^([\w-]*)(?:\s+(.*))?$/s);
    if (!m) return null;
    return { cmd: m[1].toLowerCase(), arg: (m[2] || "").trim(), line: v };
  }

  function renderSlashMenu() {
    const menu = $("#slash-menu");
    const p = slashParse();
    if (!p) { menu.classList.add("hidden"); return; }
    slashFiltered = SLASH.filter((s) => !p.cmd || s.cmd.startsWith(p.cmd));
    if (!slashFiltered.length) { menu.classList.add("hidden"); return; }
    if (slashSel >= slashFiltered.length) slashSel = 0;
    const list = $("#slash-list");
    list.innerHTML = "";
    slashFiltered.forEach((s, i) => {
      const needsArg = !!s.arg && !p.arg;
      list.append(el("div", {
        class: "pop-item sl-item" + (i === slashSel ? " sel" : ""),
        onmouseenter: () => { slashSel = i; renderSlashMenu(); },
        onclick: () => slashRun(s),
      },
        el("kbd", null, "/" + s.cmd),
        el("span", { class: "sl-desc" }, s.desc + (s.arg ? " /" + s.cmd + " " + s.arg : "")),
      ));
    });
    const comp = $("#composer");
    const r = comp.getBoundingClientRect();
    menu.style.transform = "none";
    menu.style.bottom = "auto";
    menu.style.top = Math.max(8, r.top - 8 - 300) + "px";
    menu.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 392)) + "px";
    menu.classList.remove("hidden");
  }

  function slashRun(s) {
    const p = slashParse();
    $("#slash-menu").classList.add("hidden");
    const comp = $("#composer");
    if (s.arg && (!p || !p.arg)) {
      comp.value = "/" + s.cmd + " ";
      comp.focus();
      return; // let them type the argument
    }
    comp.value = "";
    autosize(comp);
    s.run(p ? p.arg : "");
  }

  function slashKeydown(e) {
    const p = slashParse();
    if (!p) return false;
    if (e.key === "ArrowDown") { e.preventDefault(); slashSel = Math.min(slashFiltered.length - 1, slashSel + 1); renderSlashMenu(); return true; }
    if (e.key === "ArrowUp") { e.preventDefault(); slashSel = Math.max(0, slashSel - 1); renderSlashMenu(); return true; }
    if (e.key === "Enter" && !e.shiftKey && $("#slash-menu").classList.contains("hidden") === false) {
      e.preventDefault();
      const target = slashFiltered[slashSel] || slashFiltered[0];
      if (target) slashRun(target);
      return true;
    }
    if (e.key === "Escape") { $("#slash-menu").classList.add("hidden"); return true; }
    return false;
  }

  /* ---------------- wave 4: shortcuts overlay ---------------- */

  function openShortcuts() { $("#shortcuts").classList.remove("hidden"); }
  function closeShortcuts() { $("#shortcuts").classList.add("hidden"); }

  /* ---------------- wave 4: onboarding tour ---------------- */

  const TOUR_STEPS = [
    { anchor: null, title: "Welcome to CortexSpace", text: "A fast, self-hosted AI workspace: chat with an agent that can read, write and search your files, browse the web, and run Python. Everything stays on this machine." },
    { anchor: "#sidebar", title: "Your workspace", text: "Chats on the left — pin the important ones. Below, the live file tree: click to open, drag files in anywhere to upload, collapse folders or whole sections." },
    { anchor: "#composer-box", title: "The composer", text: "Type to chat. @ attaches a workspace file, / opens slash commands, drag & drop uploads, ↑ re-edits your last message, ⌘K jumps to the command palette." },
    { anchor: "#panel", title: "The panel", text: "A real editor with line numbers and version history, a built-in browser for pages the agent can read, a live activity feed, and usage Insights with charts." },
    { anchor: ".topbar", title: "Find anything", text: "⌘F searches every chat and every file. ⌘\\ is focus mode. Settings (⌘,) holds your providers, agent behavior, theme and font size. You're ready — go build something." },
  ];
  let tourIdx = 0, tourSpot = null;

  function tourShow() {
    $("#tour").classList.remove("hidden");
    tourStep();
  }
  function tourHide() {
    $("#tour").classList.add("hidden");
    if (tourSpot) { tourSpot.remove(); tourSpot = null; }
  }
  function tourStep() {
    const s = TOUR_STEPS[tourIdx];
    $("#tour-num").textContent = (tourIdx + 1) + "/" + TOUR_STEPS.length;
    $("#tour-title").textContent = s.title;
    $("#tour-text").textContent = s.text;
    $("#tour-next").textContent = tourIdx === TOUR_STEPS.length - 1 ? "Start" : "Next";
    const card = $("#tour-card");
    if (tourSpot) { tourSpot.remove(); tourSpot = null; }
    let x = 16, y = 16, w = 0, h = 0;
    const t = s.anchor ? $(s.anchor) : null;
    if (t) {
      const r = t.getBoundingClientRect();
      w = Math.min(r.width, 480);
      h = Math.min(r.height, 480);
      x = r.left; y = r.top;
      tourSpot = el("div", { class: "tour-spot" });
      Object.assign(tourSpot.style, { left: x + "px", top: y + "px", width: w + "px", height: h + "px" });
      document.body.append(tourSpot);
    }
    card.classList.remove("hidden");
    const cw = 300, ch = 170;
    let cx = 24, cy = Math.max(24, Math.min(window.innerHeight - ch - 24, (window.innerHeight - ch) / 2));
    if (t) {
      const r = t.getBoundingClientRect();
      const below = r.bottom + 16 + ch < window.innerHeight;
      cx = Math.min(Math.max(12, r.left), window.innerWidth - cw - 12);
      cy = below ? r.bottom + 16 : Math.max(12, r.top - ch - 16);
    }
    Object.assign(card.style, { left: cx + "px", top: cy + "px" });
  }

  /* ---------------- wave 4: file history + diff ---------------- */

  function renderDiff(current, previous) {
    const a = previous.split("\n").slice(0, 4000);
    const b = current.split("\n").slice(0, 4000);
    // LCS-based line diff
    const n = a.length, m = b.length;
    const dp = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
    for (let i = n - 1; i >= 0; i--)
      for (let j = m - 1; j >= 0; j--)
        dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
    const out = [];
    let i = 0, j = 0, hunk = false;
    const push = (type, text, lno) => {
      if (type !== "ctx" && !hunk) { out.push('<div class="diff-hunk">···</div>'); hunk = true; }
      if (type === "ctx" && hunk) { hunk = false; }
      out.push(`<div class="diff-line ${type === "ctx" ? "" : type === "add" ? "diff-add" : "diff-del"}"><span class="ln">${lno}</span><span class="tx">${esc(text)}</span></div>`);
    };
    let ctxRun = 0;
    const skipCtx = () => { while (ctxRun > 2) { out.push('<div class="diff-hunk">⋮</div>'); ctxRun -= 4; if (ctxRun < 0) break; } ctxRun = 0; };
    while (i < n && j < m) {
      if (a[i] === b[j]) { ctxRun++; skipCtx(); push("ctx", a[i], j + 1); i++; j++; }
      else if (dp[i + 1][j] >= dp[i][j + 1]) { push("del", a[i], i + 1); i++; }
      else { push("add", b[j], j + 1); j++; }
    }
    while (i < n) { push("del", a[i], i + 1); i++; }
    while (j < m) { push("add", b[j], j + 1); j++; }
    if (!out.length) out.push('<div class="diff-line"><span class="ln"></span><span class="tx">(empty file)</span></div>');
    return out.join("");
  }

  async function openHistory() {
    const f = state.openFile;
    if (!f || f.binary) return;
    const pop = $("#history-pop");
    const list = $("#history-list");
    $("#hist-path").textContent = f.path;
    list.innerHTML = '<div class="panel-empty">Loading…</div>';
    const btn = $("#btn-file-history");
    const r = btn.getBoundingClientRect();
    pop.style.top = (r.bottom + 6) + "px";
    pop.style.left = Math.min(window.innerWidth - 336, Math.max(8, r.left - 240)) + "px";
    pop.classList.remove("hidden");
    try {
      const d = await api("/api/files/history?path=" + encodeURIComponent(f.path));
      list.innerHTML = "";
      if (!d.versions.length) {
        list.append(el("div", { class: "bm-empty" }, "No previous versions yet — a snapshot is saved on every edit."));
        return;
      }
      for (const v of d.versions) {
        const item = el("div", { class: "hist-item" },
          el("div", { class: "hi-head" },
            el("svg", null, el("use", { href: "#i-clock" })),
            el("span", { class: "hi-time" }, relTime(v.created_at) + " · " + clock(v.created_at)),
            el("span", { class: "hi-size" }, human(v.size)),
          ),
          el("div", { class: "hi-actions" },
            el("button", { class: "btn ghost sm", onclick: () => viewVersion(f.path, v.version) }, "Compare"),
            el("button", { class: "btn primary sm", onclick: () => restoreVersion(f.path, v.version) }, "Restore"),
          ),
        );
        list.append(item);
      }
    } catch (e) {
      list.innerHTML = "";
      list.append(el("div", { class: "bm-empty" }, e.message));
    }
  }

  async function viewVersion(path, version) {
    try {
      const v = await api(`/api/files/history/${version}?path=${encodeURIComponent(path)}`);
      const f = state.openFile;
      showModal("Compare · " + path + " (" + relTime(+version) + ")",
        el("div", null,
          el("div", { class: "modal-hint" }, "Current file vs the saved version. Green = current, red = old."),
          el("div", { class: "diffbox", html: renderDiff(f ? f.content : "", v.content) }),
          el("div", { class: "modal-actions" },
            el("button", { class: "btn ghost", onclick: closeModal }, "Close"))));
    } catch (e) { toast("Compare failed: " + e.message, "err"); }
  }

  async function restoreVersion(path, version) {
    if (!confirm("Restore this file to an earlier version? The current content becomes a new version.")) return;
    try {
      await api("/api/files/restore", { method: "POST", body: { path, version } });
      $("#history-pop").classList.add("hidden");
      toast("Restored " + path);
      loadTree();
      openFile(path);
    } catch (e) { toast("Restore failed: " + e.message, "err"); }
  }

  /* ---------------- wave 4: insights ---------------- */

  async function renderInsights() {
    const days = parseInt($("#ins-days").value, 10) || 14;
    try {
      const d = await api("/api/stats?days=" + days);
      $("#ins-chats").textContent = d.chats;
      $("#ins-msgs").textContent = d.messages;
      $("#ins-toks").textContent = d.tokens >= 1000 ? (d.tokens / 1000).toFixed(1) + "k" : d.tokens;
      $("#ins-files").textContent = d.workspace.files;
      $("#ins-size").textContent = human(d.workspace.bytes);
      $("#ins-range").textContent = days + " days";
      barChart($("#ins-chart-msgs"), d.per_day_messages, days, "");
      barChart($("#ins-chart-toks"), d.per_day_tokens, days, "tok");
      toolBars($("#ins-tools"), d.top_tools);
      toolBars($("#ins-models"), d.top_models);
      renderInsightsV2(d);
      $("#ins-streak").style.display = d.streak >= 2 ? "" : "none";
    } catch (e) {
      $("#ins-chats").textContent = "–";
    }
  }

  function barChart(box, data, days, cls) {
    box.innerHTML = "";
    const W = 300, H = 90, pad = 4;
    const max = Math.max(1, ...data.map((x) => x[1]));
    const bw = (W - pad * 2) / days;
    const svg = el("svg", { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: "none" });
    let html = "";
    data.forEach(([ts, v], i) => {
      const h = Math.round((H - 18) * (v / max));
      const x = pad + i * bw + 1;
      const y = H - 14 - h;
      const label = new Date(ts).toLocaleDateString([], { month: "numeric", day: "numeric" });
      html += v > 0
        ? `<rect class="bar ${cls}" x="${x}" y="${y}" width="${Math.max(2, bw - 2.5)}" height="${h}" rx="2"><title>${label}: ${v.toLocaleString()}</title></rect>`
        : `<rect class="bar ${cls}" x="${x}" y="${H - 15}" width="${Math.max(2, bw - 2.5)}" height="1.5" rx="1" opacity="0.25"><title>${label}: 0</title></rect>`;
      if (days <= 14 || i % 5 === 0) html += `<text class="axis" x="${x + (bw - 2.5) / 2}" y="${H - 3}" text-anchor="middle">${label}</text>`;
    });
    svg.innerHTML = html;
    box.append(svg);
  }

  function toolBars(box, rows) {
    box.innerHTML = "";
    if (!rows.length) { box.append(el("div", { class: "ins-empty" }, "No data yet.")); return; }
    const max = rows[0][1];
    for (const [name, n] of rows) {
      box.append(el("div", { class: "ins-tool-row" },
        el("span", { class: "t-name", title: name }, name),
        el("span", { class: "t-bar" }, el("i", { style: "width:" + Math.max(4, Math.round(100 * n / max)) + "%" })),
        el("span", { class: "t-n" }, n)));
    }
  }

  async function loadUsage() {
    try {
      const d = await api("/api/stats?days=14");
      $("#ws-usage-text").textContent =
        d.workspace.files + " files · " + human(d.workspace.bytes) + " · " + d.chats + " chats";
    } catch { /* non-fatal */ }
  }

  /* ---------------- wave 4: export (md + html) ---------------- */

  function openExportPop() {
    const pop = $("#export-pop");
    const btn = $("#btn-export-chat");
    const r = btn.getBoundingClientRect();
    pop.style.bottom = "auto";
    pop.style.top = (r.bottom + 6) + "px";
    pop.style.left = Math.min(window.innerWidth - 244, Math.max(8, r.left - 120)) + "px";
    pop.classList.toggle("hidden");
  }

  async function exportChatHTML() {
    if (!state.chat) return;
    try {
      const res = await fetch("/api/chats/" + state.chat.id + "/export");
      if (!res.ok) throw new Error(res.statusText);
      const md = await res.text();
      // re-render each message through the local renderer for a faithful page
      const msgs = state.messages;
      const body = msgs.map((m) => {
        const who = m.role === "user" ? "You" : "CortexSpace";
        const tools = (m.tools && m.tools.length)
          ? '<div class="tools">' + m.tools.map((t) => `<div class="tool">• <b>${esc(t.name)}</b> ${esc(t.description || "")} — ${t.ok !== false ? "✓" : "✗"}</div>`).join("") + "</div>"
          : "";
        return `<section class="msg ${m.role}"><div class="who">${who}</div>${tools}<div class="md">${MD.render(m.content || "")}</div></section>`;
      }).join("\n");
      const page = `<!doctype html><html><head><meta charset="utf-8"><title>${esc(state.chat.title)}</title>
<style>
body{font:15px/1.6 -apple-system,"Segoe UI",Roboto,sans-serif;max-width:760px;margin:40px auto;padding:0 20px;color:#1c2130;background:#faf9f7}
h1{font-size:24px} .msg{margin:26px 0;padding:16px 18px;border-radius:12px}
.msg.user{background:#eee9ff} .msg.assistant{background:#fff;border:1px solid #e5e2da}
.who{font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;color:#6b6480;margin-bottom:8px}
.md pre{background:#12141c;color:#e6e2f2;padding:12px;border-radius:8px;overflow-x:auto;font-size:13px}
.md code{background:#eee9ff;padding:1px 5px;border-radius:4px;font-size:13px} .md pre code{background:none;padding:0}
.md table{border-collapse:collapse} .md th,.md td{border:1px solid #ddd;padding:5px 10px}
.tools{font-size:12px;color:#6b6480;margin-bottom:8px} footer{margin-top:40px;font-size:12px;color:#8a8577}
</style></head><body>
<h1>${esc(state.chat.title)}</h1>
<p>${new Date().toLocaleString()} · exported from CortexSpace</p>
${body}
<footer>Generated by CortexSpace — self-hosted workspace</footer>
</body></html>`;
      const blob = new Blob([page], { type: "text/html" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = (state.chat.title.replace(/[^\w\- ]+/g, "").trim() || "chat") + ".html";
      a.click();
      URL.revokeObjectURL(a.href);
      toast("Chat exported as HTML");
    } catch (e) { toast("Export failed: " + e.message, "err"); }
  }

  /* ---------------- wave 4: danger zone ---------------- */

  function confirmDanger(title, text, okLabel, onOk) {
    showModal(title,
      el("div", null,
        el("p", { style: "color:var(--text-dim);font-size:13px;margin-bottom:4px" }, text),
        el("div", { class: "modal-actions" },
          el("button", { class: "btn ghost", onclick: closeModal }, "Cancel"),
          el("button", { class: "btn ghost danger", "data-modal-ok": "1", onclick: () => { closeModal(); onOk(); } }, okLabel))));
  }

  async function dangerDeleteChats() {
    confirmDanger("Delete all chats", "This permanently deletes every chat and its messages. Workspace files are kept.", "Delete everything", async () => {
      try {
        const d = await api("/api/chats", { method: "DELETE" });
        state.chat = null;
        state.messages = [];
        renderMessages();
        await loadChats();
        toast("Deleted " + d.deleted + " chats");
        loadUsage();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  async function dangerResetWs() {
    confirmDanger("Reset workspace", "This deletes every file in the workspace plus all version history. This cannot be undone.", "Reset workspace", async () => {
      try {
        const d = await api("/api/workspace", { method: "DELETE" });
        state.openFile = null;
        renderFilePanel();
        await loadTree();
        toast("Workspace reset (" + d.deleted_files + " files)");
        loadUsage();
      } catch (e) { toast(e.message, "err"); }
    });
  }

  /* ---------------- wave 4: personas ---------------- */

  const PERSONAS = {
    concise: "You are CortexSpace, a fast, self-hosted personal AI workspace. Keep answers short and direct: lead with the result, then at most a few bullets. Use your tools (list_workspace, read_file, write_file, search_workspace, run_python, web_search, fetch_page) whenever the task references files or the web. Use Markdown. State file paths clearly when creating or editing files.",
    detailed: "You are CortexSpace, a self-hosted personal AI workspace. Give thorough, well-structured answers: explain your reasoning, show steps, and add context so the user learns. Use headings and lists in Markdown. Prefer using your tools when a task references files or the web, and say which file paths you touched.",
    coder: "You are CortexSpace, a pragmatic programming copilot in a self-hosted workspace. Be code-first: show working code, note pitfalls in one line each. Prefer run_python to verify snippets when useful. Use your file tools to read and edit code in the workspace, and always name the paths you change.",
    writer: "You are CortexSpace, a sharp writing partner in a self-hosted workspace. Produce clear, polished prose with strong structure. When the task touches notes or documents, use write_file and read_file and confirm the path. Keep tone professional and warm; avoid filler.",
    brain: "You are CortexSpace, an idea machine. When asked for options, give at least three distinct alternatives with one-line trade-offs, then recommend one. Explore the workspace with your tools when it might inform ideas. Use Markdown lists; keep each idea tight.",
  };

  /* ---------------- init ---------------- */

  function initSeg(sel, key, apply) {
    const seg = $(sel);
    if (!seg) return;
    const mark = (v) => $$("button", seg).forEach((b) => b.classList.toggle("active", b.dataset.v === v));
    const cur = localStorage.getItem(key);
    if (cur) mark(cur);
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      localStorage.setItem(key, b.dataset.v);
      mark(b.dataset.v);
      apply(b.dataset.v);
    });
  }

  function initResize(handleSel, cssVar, min, max, lsKey, side) {
    const handle = $(handleSel);
    if (!handle) return;
    const apply = (w) => document.documentElement.style.setProperty(cssVar, w + "px");
    handle.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const startX = e.clientX;
      const cur = parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar)) || (side === "side" ? 288 : 380);
      const startW = cur;
      handle.classList.add("active");
      document.body.classList.add("resizing");
      const onMove = (ev) => {
        let w = startW + (ev.clientX - startX);
        w = Math.max(min, Math.min(max, w));
        if (side === "panel") w = Math.min(w, window.innerWidth - (document.documentElement.style.getPropertyValue("--side-w") ? parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--side-w")) : 288) - 640);
        apply(w);
      };
      const onUp = () => {
        handle.classList.remove("active");
        document.body.classList.remove("resizing");
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
        localStorage.setItem(lsKey, Math.round(parseFloat(getComputedStyle(document.documentElement).getPropertyValue(cssVar))) + "px");
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    });
    handle.addEventListener("dblclick", () => {
      localStorage.removeItem(lsKey);
      document.documentElement.style.removeProperty(cssVar);
    });
  }

  function toggleFocusMode() {
    const app = $("#app");
    if (app.classList.contains("focus-mode")) {
      app.classList.remove("focus-mode", "no-sidebar", "no-panel");
      if (state.focusPrev) {
        if (state.focusPrev.side) app.classList.add("no-sidebar");
        if (state.focusPrev.panel) app.classList.add("no-panel");
        state.focusPrev = null;
      }
      $("#btn-focus").classList.remove("active");
    } else {
      state.focusPrev = { side: app.classList.contains("no-sidebar"), panel: app.classList.contains("no-panel") };
      app.classList.add("focus-mode", "no-sidebar", "no-panel");
      $("#btn-focus").classList.add("active");
      $("#composer").focus();
    }
  }

  function renderBookmarks() {
    const list = $("#bookmark-list");
    const cnt = $("#bm-count");
    if (!list) return;
    if (cnt) cnt.textContent = state.bookmarks.length ? "(" + state.bookmarks.length + ")" : "";
    list.innerHTML = "";
    if (!state.bookmarks.length) {
      list.append(el("div", { class: "bm-empty" }, "No bookmarks yet — add the current page below."));
      return;
    }
    state.bookmarks.forEach((u, i) => {
      list.append(el("div", { class: "bm-item", title: u, onclick: () => { browserGoUrl(u); $("#bookmark-pop").classList.add("hidden"); } },
        el("svg", null, el("use", { href: "#i-star" })),
        el("span", { class: "bm-url" }, u),
        el("button", { class: "icon-btn sm bm-del", title: "Remove bookmark", onclick: (e) => { e.stopPropagation(); state.bookmarks.splice(i, 1); saveBookmarks(); renderBookmarks(); } }, ico("#i-x"))));
    });
  }

  function browserGoUrl(u) {
    $("#browser-url").value = u;
    browserGo();
  }

  const SURPRISES = [
    "Summarize every note in my workspace",
    "Find any TODO or FIXME comments in my files",
    "Create a reusable meeting-notes template",
    "Explain the fibonacci snippet in my workspace",
    "Write a haiku about self-hosted software",
    "Review my roadmap and suggest the next step",
    "Refactor the fibonacci function to be iterative",
    "Draft a short release announcement for this project",
  ];

  async function init() {
    // ---- appearance: theme / font size / motion ----
    document.documentElement.dataset.theme = state.theme;
    $("#btn-theme svg use").setAttribute("href", state.theme === "dark" ? "#i-sun" : "#i-moon");
    const fsCur = localStorage.getItem("cs-fs") || "m";
    if (fsCur !== "m") document.documentElement.dataset.fs = fsCur;
    const motionOn = localStorage.getItem("cs-motion") !== "off";
    document.documentElement.dataset.motion = motionOn ? "on" : "off";
    const motionBox = $("#set-motion");
    if (motionBox) {
      motionBox.checked = motionOn;
      motionBox.addEventListener("change", (e) => {
        document.documentElement.dataset.motion = e.target.checked ? "on" : "off";
        localStorage.setItem("cs-motion", e.target.checked ? "on" : "off");
      });
    }
    const notifyBox = $("#set-notify");
    if (notifyBox) {
      notifyBox.checked = localStorage.getItem("cs-notify") === "1";
      notifyBox.addEventListener("change", (e) => {
        localStorage.setItem("cs-notify", e.target.checked ? "1" : "0");
        if (e.target.checked && "Notification" in window && Notification.permission === "default") {
          Notification.requestPermission();
        }
      });
    }
    initSeg("#seg-theme", "cs-theme", (v) => {
      state.theme = v;
      document.documentElement.dataset.theme = v;
      $("#btn-theme svg use").setAttribute("href", v === "dark" ? "#i-sun" : "#i-moon");
    });
    initSeg("#seg-fs", "cs-fs", (v) => {
      if (v === "m") document.documentElement.removeAttribute("data-fs");
      else document.documentElement.dataset.fs = v;
    });

    // ---- time-of-day greeting ----
    const h = new Date().getHours();
    $("#empty-greet").textContent = h < 5 ? "Up late" : h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";

    // ---- resizable regions ----
    const savedSide = localStorage.getItem("cs-side-w");
    if (savedSide) document.documentElement.style.setProperty("--side-w", savedSide);
    const savedPanel = localStorage.getItem("cs-panel-w");
    if (savedPanel) document.documentElement.style.setProperty("--panel-w", savedPanel);
    initResize("#rs-side", "--side-w", 200, 440, "cs-side-w", "side");
    initResize("#rs-panel", "--panel-w", 300, 640, "cs-panel-w", "panel");

    // ---- collapsible sidebar sections ----
    for (const id of ["chats", "workspace"]) {
      const sec = $("#sec-" + id);
      if (!sec) continue;
      if (state.secs[id]) sec.classList.add("collapsed");
      const head = $("#sec-" + id + "-head");
      if (head) head.onclick = () => {
        sec.classList.toggle("collapsed");
        state.secs[id] = sec.classList.contains("collapsed");
        localStorage.setItem("cs-secs", JSON.stringify(state.secs));
      };
    }

    // wire static buttons
    $("#btn-new-chat-top").onclick = newChat;
    $("#btn-sidebar-toggle").onclick = toggleSidebar;
    $("#btn-panel-toggle").onclick = togglePanel;
    $("#btn-panel-close").onclick = togglePanel;
    $("#btn-theme").onclick = toggleTheme;
    $("#provider-chip").onclick = () => showView("settings");
    $("#btn-settings-back").onclick = () => showView("chat");
    $("#btn-new-note").onclick = promptNewNote;
    $("#btn-new-note-2").onclick = promptNewNote;
    $("#btn-new-folder").onclick = promptNewFolder;
    $("#btn-global-search").onclick = openSearch;
    $("#btn-export-chat").onclick = openExportPop;
    $("#exp-md").onclick = () => { $("#export-pop").classList.add("hidden"); exportChat(); };
    $("#exp-html").onclick = () => { $("#export-pop").classList.add("hidden"); exportChatHTML(); };
    $("#btn-file-history").onclick = openHistory;
    $("#shortcuts-x").onclick = closeShortcuts;
    $("#shortcuts").addEventListener("click", (e) => { if (e.target.id === "shortcuts") closeShortcuts(); });
    $("#ins-days").addEventListener("change", renderInsights);
    $("#persona-preset").addEventListener("change", (e) => {
      const p = PERSONAS[e.target.value];
      if (p) { $("#set-prompt").value = p; e.target.value = ""; }
    });
    $("#btn-danger-chats").onclick = dangerDeleteChats;
    $("#btn-danger-ws").onclick = dangerResetWs;
    $("#btn-dl-ws").onclick = (e) => {
      e.stopPropagation();
      window.location.href = "/api/workspace/zip";
      toast("Downloading workspace…");
    };
    $("#tour-skip").onclick = () => { localStorage.setItem("cs-tour", "done"); tourHide(); };
    $("#tour-next").onclick = () => {
      if (tourIdx >= TOUR_STEPS.length - 1) { localStorage.setItem("cs-tour", "done"); tourHide(); }
      else { tourIdx++; tourStep(); }
    };

    // focus mode
    $("#btn-focus").onclick = toggleFocusMode;

    // tree expand / collapse all
    $("#btn-tree-expand").onclick = () => { state.expanded = collectDirs(state.tree); saveExpanded(); renderTree(); };
    $("#btn-tree-collapse").onclick = () => { state.expanded = new Set(); saveExpanded(); renderTree(); };

    // jump to bottom
    $("#jump-btn").onclick = () => {
      state.unread = 0;
      const box = $("#messages");
      box.scrollTop = box.scrollHeight;
      state.nearBottom = true;
      updateJumpBtn(true);
    };
    const jb = $("#jump-count");
    if (jb) jb.className = "jump-badge";

    // bookmarks
    $("#btn-bookmarks").onclick = (e) => { e.stopPropagation(); renderBookmarks(); $("#bookmark-pop").classList.toggle("hidden"); };
    const bmInput = $("#bm-add-url");
    if (bmInput) bmInput.addEventListener("input", (e) => { if (browserUrl && !e.target.value) e.target.value = browserUrl; });
    $("#bm-add-btn").onclick = () => {
      const u = bmInput.value.trim();
      if (!u) return;
      if (!state.bookmarks.includes(u)) state.bookmarks.unshift(u);
      saveBookmarks();
      bmInput.value = "";
      renderBookmarks();
      toast("Bookmark added");
    };

    // activity filters
    $$("#act-filters .fchip").forEach((b) => (b.onclick = () => {
      const f = b.dataset.f;
      if (f === "clear") {
        state.activity = [];
        renderActivity();
        return;
      }
      state.actFilter = f;
      $$("#act-filters .fchip").forEach((x) => x.classList.toggle("active", x === b));
      renderActivity();
    }));

    // modal
    $("#modal-x").onclick = closeModal;
    $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });

    // global search
    const sInp = $("#search-input");
    sInp.addEventListener("input", () => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(runSearch, 180);
    });
    sInp.addEventListener("keydown", (e) => {
      if (e.key === "Escape") closeSearch();
      if (e.key === "Enter") {
        const first = $("#search-results").querySelector(".search-item");
        if (first) first.click();
      }
    });
    $("#search-overlay").addEventListener("click", (e) => { if (e.target.id === "search-overlay") closeSearch(); });
    $("#btn-file-view").onclick = () => {
      if (!state.openFile) return;
      state.openFile.view = state.openFile.view === "preview" ? "source" : "preview";
      renderFilePanel();
    };
    $("#btn-file-save").onclick = saveFile;
    $("#btn-file-delete").onclick = deleteFile;
    $("#btn-file-download").onclick = () => {
      const f = state.openFile;
      if (!f || f.binary) return;
      const blob = new Blob([f.content], { type: "text/plain" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = f.path.split("/").pop();
      a.click();
      URL.revokeObjectURL(a.href);
    };
    $("#btn-file-send").onclick = () => {
      const f = state.openFile;
      if (!f) return;
      if (!state.context.includes(f.path)) state.context.push(f.path);
      renderContextChips();
      toast(f.path + " added to context");
      $("#composer").focus();
    };
    $("#btn-browser-go").onclick = browserGo;
    $("#browser-url").addEventListener("keydown", (e) => { if (e.key === "Enter") browserGo(); });
    $("#btn-browser-chat").onclick = browserToChat;

    // tabs
    $$(".ptab").forEach((b) => (b.onclick = () => setPanelTab(b.dataset.tab)));

    // chat list
    $("#chat-filter").addEventListener("input", renderChatList);
    $("#chat-title").addEventListener("change", async (e) => {
      if (state.chat) {
        const t = e.target.value.trim() || "New chat";
        state.chat.title = t;
        try { await api(`/api/chats/${state.chat.id}/rename`, { method: "POST", body: { title: t } }); } catch {}
        loadChats();
      }
    });

    // composer
    const comp = $("#composer");
    comp.addEventListener("input", () => {
      autosize(comp);
      renderSlashMenu();
      if (!state.streaming) $("#btn-send").disabled = !comp.value.trim();
    });
    comp.addEventListener("keydown", (e) => {
      if (slashKeydown(e)) return;
      if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
      if (e.key === "@" && comp.selectionStart === comp.value.length) { e.preventDefault(); openAttach(); }
      if (e.key === "ArrowUp" && !comp.value && state.messages.length) {
        for (let i = state.messages.length - 1; i >= 0; i--) {
          if (state.messages[i].role === "user") {
            comp.value = state.messages[i].content;
            autosize(comp);
            $("#btn-send").disabled = false;
            break;
          }
        }
      }
    });
    $("#btn-send").onclick = () => (state.streaming ? stop() : send());
    $("#btn-attach").onclick = (e) => { e.stopPropagation(); openAttach(); };
    $("#attach-filter").addEventListener("input", renderAttachList);
    $$(".suggestion").forEach((b) => (b.onclick = () => {
      if (!b.dataset.text) return; // e.g. the surprise chip has its own handler
      const inp = $("#composer");
      inp.value = b.dataset.text;
      autosize(inp);
      $("#btn-send").disabled = false;
      inp.focus();
    }));
    const surprise = $("#suggestion-surprise");
    if (surprise) surprise.onclick = () => {
      const inp = $("#composer");
      inp.value = SURPRISES[Math.floor(Math.random() * SURPRISES.length)];
      autosize(inp);
      $("#btn-send").disabled = false;
      inp.focus();
    };

    // settings
    $("#btn-save-settings").onclick = saveSettings;
    $("#btn-refresh-ollama").onclick = () => refreshModels("ollama");
    $("#btn-refresh-or").onclick = () => refreshModels("openrouter");
    $("#btn-refresh-oai").onclick = () => refreshModels("openai");
    $("#btn-ping-ollama").onclick = () => pingProvider("ollama");
    $("#btn-ping-or").onclick = () => pingProvider("openrouter");
    $("#btn-ping-oai").onclick = () => pingProvider("openai");
    $("#btn-reset-prompt").onclick = async () => {
      const d = await fetch("/api/providers").then((r) => r.json());
      // fetch default via settings reset field
      $("#set-prompt").value = "You are CortexSpace, a fast, self-hosted personal AI workspace. You have a private file workspace you can read, write and search, plus web search and page fetching. Be concise and practical. Prefer using your tools when a task references files or the web. Use Markdown. When you create or edit a file, say its path clearly.";
    };
    $("#set-temp").addEventListener("input", (e) => ($("#temp-val").textContent = e.target.value));
    $("#set-mtok").addEventListener("input", (e) => ($("#mtok-val").textContent = e.target.value));

    // copy buttons (event delegation for md code blocks)
    document.addEventListener("click", async (e) => {
      const btn = e.target.closest(".cb-copy");
      if (!btn) return;
      const block = btn.closest(".codeblock");
      const code = block.querySelector("pre code").innerText;
      try {
        await navigator.clipboard.writeText(code);
        btn.innerHTML = '<svg><use href="#i-check"/></svg>';
        setTimeout(() => (btn.innerHTML = '<svg><use href="#i-copy"/></svg>'), 1200);
      } catch { toast("Copy failed", "err"); }
    });

    // close popovers on outside click
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#attach-pop") && !e.target.closest("#btn-attach")) $("#attach-pop").classList.add("hidden");
      if (!e.target.closest("#bookmark-pop") && !e.target.closest("#btn-bookmarks")) $("#bookmark-pop").classList.add("hidden");
      if (!e.target.closest("#export-pop") && !e.target.closest("#btn-export-chat")) $("#export-pop").classList.add("hidden");
      if (!e.target.closest("#history-pop") && !e.target.closest("#btn-file-history")) $("#history-pop").classList.add("hidden");
      if (!e.target.closest("#slash-menu") && !e.target.closest("#composer")) $("#slash-menu").classList.add("hidden");
    });

    // ticking relative times (every 30s)
    setInterval(() => {
      $$(".rt[data-ts]").forEach((n) => (n.textContent = relTime(+n.dataset.ts)));
    }, 30000);

    // keyboard
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === "k") { e.preventDefault(); state.paletteOpen ? closePalette() : openPalette(); }
      if (mod && e.key.toLowerCase() === "n") { e.preventDefault(); newChat(); }
      if (mod && e.key.toLowerCase() === "b") { e.preventDefault(); toggleSidebar(); }
      if (mod && e.key.toLowerCase() === "j") { e.preventDefault(); togglePanel(); }
      if (mod && e.key === ".") { e.preventDefault(); toggleTheme(); }
      if (mod && e.key === ",") { e.preventDefault(); showView("settings"); }
      if (mod && e.key.toLowerCase() === "s") { e.preventDefault(); saveFile(); }
      if (mod && e.key === "\\") { e.preventDefault(); toggleFocusMode(); }
      if (mod && e.key.toLowerCase() === "f") { e.preventDefault(); $("#search-overlay").classList.contains("hidden") ? openSearch() : closeSearch(); }
      if (!mod && e.key === "?" && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName || "")) { e.preventDefault(); openShortcuts(); }
      if (e.key === "Escape") {
        if (!$("#modal").classList.contains("hidden")) closeModal();
        else if (state.paletteOpen) closePalette();
        else if (!$("#search-overlay").classList.contains("hidden")) closeSearch();
        else if (!$("#shortcuts").classList.contains("hidden")) closeShortcuts();
        else if (!$("#tour").classList.contains("hidden")) tourHide();
        else if (!$("#attach-pop").classList.contains("hidden")) $("#attach-pop").classList.add("hidden");
        else if (!$("#slash-menu").classList.contains("hidden")) $("#slash-menu").classList.add("hidden");
        else if (!$("#history-pop").classList.contains("hidden")) $("#history-pop").classList.add("hidden");
        else if (!$("#export-pop").classList.contains("hidden")) $("#export-pop").classList.add("hidden");
        else if (state.panelOpen && window.innerWidth < 1200) togglePanel();
      }
    });

    // drag & drop file upload
    window.addEventListener("dragenter", (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth++;
      $("#drop-overlay").classList.remove("hidden");
    });
    window.addEventListener("dragleave", (e) => {
      if (!hasFiles(e)) return;
      dragDepth = Math.max(0, dragDepth - 1);
      if (dragDepth === 0) $("#drop-overlay").classList.add("hidden");
    });
    window.addEventListener("dragover", (e) => { if (hasFiles(e)) e.preventDefault(); });
    window.addEventListener("drop", async (e) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      dragDepth = 0;
      $("#drop-overlay").classList.add("hidden");
      const files = [...(e.dataTransfer.files || [])];
      if (!files.length) return;
      for (const f of files) {
        try {
          const res = await uploadFile(f, "uploads");
          toast(`Added ${res.path} (${human(res.size)})`);
        } catch (err) {
          toast(`Upload failed: ${err.message}`, "err");
        }
      }
      loadTree();
    });

    // palette keys
    $("#palette-input").addEventListener("input", () => { palSel = 0; renderPalette(); });
    $("#palette-input").addEventListener("keydown", (e) => {
      if (e.key === "ArrowDown") { e.preventDefault(); palSel = Math.min(palFiltered.length - 1, palSel + 1); renderPalette(); }
      if (e.key === "ArrowUp") { e.preventDefault(); palSel = Math.max(0, palSel - 1); renderPalette(); }
      if (e.key === "Enter" && palFiltered[palSel]) { e.preventDefault(); runPal(palFiltered[palSel]); }
      if (e.key === "Escape") closePalette();
    });

    // load everything
    try {
      await Promise.all([loadSettings(), loadChats(), loadTree()]);
    } catch (e) {
      toast("Startup error: " + e.message, "err");
    }
    setPanelTab("file");
    renderMessages();
    // auto-open welcome file in panel
    openFile("welcome.md").catch(() => {});
    loadUsage().catch(() => {});
    // first-run onboarding tour
    if (!localStorage.getItem("cs-tour")) {
      setTimeout(() => { tourIdx = 0; tourShow(); }, 900);
    }
    $("#composer").focus();

    // ---- wave 5 ----
    csWave5Init();
  }

  /* ============================================================
     WAVE 5 — features
     ============================================================ */

  /* ---- interface preferences (data-driven registry) ---- */

  const PREF_DEFS = [
    { key: "accent", label: "Accent color", type: "swatches", options: [["default", "#6e5df0"], ["blue", "#3b82f6"], ["violet", "#8b5cf6"], ["green", "#10b981"], ["rose", "#f43f5e"], ["amber", "#f59e0b"], ["cyan", "#06b6d4"]], def: "default" },
    { key: "radius", label: "Corner radius", type: "seg", options: [["0", "Sharp"], ["6", "Slight"], ["12", "Soft"], ["18", "Round"]], def: "12" },
    { key: "density", label: "Density", type: "seg", options: [["comfy", "Comfy"], ["compact", "Compact"]], def: "comfy" },
    { key: "glass", label: "Frosted glass", type: "toggle", def: true },
    { key: "contrast", label: "High contrast", type: "toggle", def: false },
    { key: "mono", label: "Monochrome mode", type: "toggle", def: false },
    { key: "anim", label: "Animation speed", type: "seg", options: [["normal", "Normal"], ["fast", "Fast"], ["instant", "Instant"]], def: "normal" },
    { key: "gradient", label: "Ambient gradient", type: "toggle", def: false },
    { key: "wide", label: "Wide chat column", type: "toggle", def: false },
    { key: "avatars", label: "Assistant avatar", type: "toggle", def: true },
    { key: "timestamps", label: "Message times", type: "toggle", def: true },
    { key: "toolcards", label: "Open tool cards", type: "toggle", def: true },
    { key: "sound", label: "Sound effects", type: "toggle", def: true },
    { key: "toastPos", label: "Toast position", type: "seg", options: [["bottom", "Bottom"], ["top", "Top"]], def: "bottom" },
    { key: "wordcount", label: "Character counter", type: "toggle", def: true },
    { key: "statusbar", label: "Status bar", type: "toggle", def: true },
    { key: "followOs", label: "Follow OS theme", type: "toggle", def: false },
    { key: "night", label: "Night schedule (auto dark)", type: "toggle", def: false },
    { key: "nightFrom", label: "Night from", type: "time", def: "21:00" },
    { key: "nightTo", label: "Night to", type: "time", def: "07:00" },
  ];
  let PREFS = {};
  try { PREFS = JSON.parse(localStorage.getItem("cs-prefs") || "{}"); } catch { PREFS = {}; }
  const pref = (k) => (PREFS[k] !== undefined ? PREFS[k] : (PREF_DEFS.find((d) => d.key === k) || { def: undefined }).def);
  function setPref(k, v) { PREFS[k] = v; localStorage.setItem("cs-prefs", JSON.stringify(PREFS)); applyPrefs(); }
  function applyPrefs() {
    const root = document.documentElement;
    for (const d of PREF_DEFS) {
      const v = pref(d.key);
      if (v === undefined) continue;
      const attr = d.key.replace(/([A-Z])/g, "-$1").toLowerCase();
      if (d.type === "swatches") root.dataset.accent = v === "default" ? "" : v;
      else if (d.type === "seg") root.dataset[attr] = v;
      else if (d.type === "toggle") root.dataset[attr] = v ? "on" : "off";
      else root.dataset[attr] = v;
    }
    if (pref("toastPos") === "top") $("#toasts").classList.add("top"); else $("#toasts").classList.remove("top");
    if (pref("statusbar")) $("#status-left").parentElement.style.display = ""; else $("#status-left").parentElement.style.display = "none";
    const cs = pref("customCss");
    let st = $("#w5-custom-css");
    if (cs) {
      if (!st) { st = document.createElement("style"); st.id = "w5-custom-css"; document.head.append(st); }
      st.textContent = cs;
    } else if (st) st.remove();
  }
  function prefExport() {
    const data = { prefs: PREFS, bookmarks: state.bookmarks, theme: state.theme, version: "1.0.0", at: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cortexspace-preferences.json";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Preferences exported");
  }
  function prefImport(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        if (d.prefs && typeof d.prefs === "object") { PREFS = d.prefs; localStorage.setItem("cs-prefs", JSON.stringify(PREFS)); }
        if (Array.isArray(d.bookmarks)) { state.bookmarks = d.bookmarks; saveBookmarks(); }
        applyPrefs();
        renderAppearSettings();
        renderBookmarks();
        toast("Preferences imported");
      } catch { toast("Bad preferences file", "err"); }
    };
    r.readAsText(file);
  }

  /* ---- sounds (WebAudio) ---- */

  let audioCtx = null;
  function beep(kind = "ok") {
    if (!pref("sound")) return;
    try {
      audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.connect(g); g.connect(audioCtx.destination);
      const seq = kind === "err" ? [220, 180] : kind === "ding" ? [880, 1320] : [520, 780];
      seq.forEach((f, i) => {
        o.frequency.setValueAtTime(f, audioCtx.currentTime + i * 0.09);
      });
      g.gain.setValueAtTime(0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + 0.22);
      o.start();
      o.stop(audioCtx.currentTime + 0.24);
    } catch { /* audio unavailable */ }
  }
  function setMute(muted) { setPref("sound", !muted); toast(muted ? "Sounds muted" : "Sounds on"); }

  /* ---- toast history ---- */

  let TOASTS_HIST = [];
  try { TOASTS_HIST = JSON.parse(localStorage.getItem("cs-thist") || "[]"); } catch { TOASTS_HIST = []; }
  function histPush(msg, kind) {
    TOASTS_HIST.unshift({ t: Date.now(), msg, kind });
    TOASTS_HIST = TOASTS_HIST.slice(0, 60);
    localStorage.setItem("cs-thist", JSON.stringify(TOASTS_HIST));
    renderToastHistory();
  }

  /* ---- toast v2: undo, progress, DND, cap ---- */

  let DND = false;
  function toast(msg, kind = "ok", ms = 3200, action) {
    histPush(msg, kind);
    if (DND) return;
    const box = $("#toasts");
    while (box.children.length >= 5) box.firstElementChild.remove(); // stack cap
    const t = el("div", { class: "toast " + kind },
      el("svg", null, el("use", { href: kind === "ok" ? "#i-check" : kind === "ach" ? "#i-trophy" : "#i-alert" })),
      el("span", { class: "t-text" }, esc(msg)),
    );
    if (action) t.append(el("button", { class: "t-undo", onclick: () => { action.fn(); t.remove(); } }, action.label));
    const bar = el("span", { class: "t-progress", style: `animation-duration:${ms}ms` });
    t.append(bar);
    let paused = false;
    t.addEventListener("mouseenter", () => { paused = true; bar.style.animationPlayState = "paused"; });
    t.addEventListener("mouseleave", () => { paused = false; bar.style.animationPlayState = "running"; });
    box.append(t);
    if (kind === "err") beep("err");
    else if (kind === "ach") beep("ding");
    const kill = () => { if (t.isConnected) { t.classList.add("out"); setTimeout(() => t.remove(), 260); } };
    setTimeout(kill, ms);
    if (action) t.dataset.keep = "1"; // undo toasts linger a bit
    return t;
  }
  function toastUndo(msg, label, fn) { return toast(msg, "ok", 6500, { label, fn }); }

  /* ---- confetti ---- */

  function confetti(burst = 120) {
    const c = $("#confetti");
    if (!c) return;
    c.width = innerWidth; c.height = innerHeight;
    const ctx = c.getContext("2d");
    const colors = ["#6e5df0", "#34d399", "#f5b453", "#f43f5e", "#3b82f6", "#fbbf24"];
    const parts = Array.from({ length: burst }, () => ({
      x: innerWidth / 2 + (Math.random() - 0.5) * 200,
      y: innerHeight * 0.35,
      vx: (Math.random() - 0.5) * 11,
      vy: -Math.random() * 10 - 3,
      s: Math.random() * 6 + 3,
      r: Math.random() * Math.PI,
      vr: (Math.random() - 0.5) * 0.3,
      col: colors[Math.floor(Math.random() * colors.length)],
    }));
    let frames = 0;
    (function tick() {
      ctx.clearRect(0, 0, c.width, c.height);
      for (const p of parts) {
        p.x += p.vx; p.y += p.vy; p.vy += 0.28; p.r += p.vr;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.col; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6);
        ctx.restore();
      }
      if (++frames < 150) requestAnimationFrame(tick);
      else ctx.clearRect(0, 0, c.width, c.height);
    })();
  }

  /* ---- achievements ---- */

  const ACHIEVEMENTS = [
    { id: "first-chat", name: "First contact", desc: "Start your first chat", icon: "💬" },
    { id: "chatterbox", name: "Chatterbox", desc: "Send 10 messages", icon: "🗨️" },
    { id: "power-user", name: "Power user", desc: "Send 50 messages", icon: "⚡" },
    { id: "file-fixer", name: "File fixer", desc: "Save a file 10 times", icon: "📁" },
    { id: "tool-master", name: "Tool master", desc: "Watch 20 tool calls run", icon: "🔧" },
    { id: "streak-3", name: "On fire", desc: "Keep a 3-day streak", icon: "🔥" },
    { id: "night-owl", name: "Night owl", desc: "Chat between 1am and 4am", icon: "🦉" },
    { id: "explorer", name: "Explorer", desc: "Open the Insights panel", icon: "📊" },
  ];
  let ACH = {};
  try { ACH = JSON.parse(localStorage.getItem("cs-ach") || "{}"); } catch { ACH = {}; }
  const W5_STATS = { msgs: 0, saves: 0, tools: 0, streak: 0 };
  try { Object.assign(W5_STATS, JSON.parse(localStorage.getItem("cs-w5s") || "{}")); } catch { /* keep defaults */ }
  function w5stat(k, v) { W5_STATS[k] = v; localStorage.setItem("cs-w5s", JSON.stringify(W5_STATS)); }
  function checkAchievements() {
    const now = new Date();
    const h = now.getHours();
    const conds = {
      "first-chat": W5_STATS.msgs >= 1,
      "chatterbox": W5_STATS.msgs >= 10,
      "power-user": W5_STATS.msgs >= 50,
      "file-fixer": W5_STATS.saves >= 10,
      "tool-master": W5_STATS.tools >= 20,
      "streak-3": W5_STATS.streak >= 3,
      "night-owl": h >= 1 && h < 4,
      "explorer": ACH._explored === true,
    };
    for (const a of ACHIEVEMENTS) {
      if (ACH[a.id] || !conds[a.id]) continue;
      ACH[a.id] = now.toISOString();
      localStorage.setItem("cs-ach", JSON.stringify(ACH));
      confetti(90);
      toast(`${a.icon} Achievement unlocked: ${a.name} — ${a.desc}`, "ach", 6000);
    }
  }
  function achievementsModal() {
    const body = el("div");
    const grid = el("div", { class: "ach-grid" });
    for (const a of ACHIEVEMENTS) {
      const got = !!ACH[a.id];
      grid.append(el("div", { class: "ach-item" + (got ? " got" : "") },
        el("span", { class: "ach-ic" }, a.icon),
        el("span", null,
          el("b", { class: "ach-name" }, a.name),
          el("em", { class: "ach-desc" }, got ? (ACH[a.id].slice(0, 10) + " ✓") : a.desc),
        )));
    }
    body.append(grid, el("p", { class: "ach-note" }, ACHIEVEMENTS.filter((a) => ACH[a.id]).length + " / " + ACHIEVEMENTS.length + " unlocked"));
    showModal("Achievements", body);
  }

  /* ---- quotes / facts / moods ---- */

  const QUOTES = [
    "A room without books is like a body without a soul. — Cicero",
    "The best way out is always through. — Robert Frost",
    "Simplicity is the ultimate sophistication. — Leonardo da Vinci",
    "First, solve the problem. Then, write the code. — John Johnson",
    "Well done is better than well said. — Benjamin Franklin",
    "It always seems impossible until it's done. — Nelson Mandela",
    "Code is like humor. When you have to explain it, it's bad. — Cory House",
    "The trouble with programming is that it is hard to get right. — Dijkstra",
    "Stay hungry, stay foolish. — Steve Jobs",
    "Make it work, make it right, make it fast. — Kent Beck",
    "Perfection is achieved when there is nothing left to take away. — da Vinci",
    "Talk is cheap. Show me the code. — Linus Torvalds",
    "The scariest moment is always just before you start. — Stephen King",
    "Any fool can write code that a computer can understand. — Martin Fowler",
    "Simplicity is the soul of efficiency. — Austin Freeman",
  ];
  const FACTS = [
    "The first computer bug was a literal moth, found in 1947.",
    "Python was named after Monty Python, not the snake.",
    "A day on Venus is longer than a year on Venus.",
    "Honey never spoils — 3000-year-old honey is still edible.",
    "The first emoji were black-and-white, on a Japanese phone in 1999.",
    "SQLite powers more devices than any other database engine.",
    "The T90 tank would be overqualified to crush a mainframe server.",
    "CamelCase was invented by Brendan Eich in 1997 at Sun.",
  ];
  const MOODS = ["😎", "🤔", "🔥", "😌", "🚀", "🌙", "☕", "🎯", "🧠", "🐢", "🌊", "⚡"];

  /* ---- templates (5 built-ins + custom CRUD) ---- */

  const TPL_BUILTIN = [
    { name: "Weekly review", body: "# Weekly review — {date}\n\n## Wins\n- \n\n## In progress\n- \n\n## Blockers\n- \n\n## Next week's priorities\n1. \n\n## One thing to stop doing\n- \n" },
    { name: "Project kickoff", body: "# {title}\n\n## Goal\n\n## Success criteria\n- [ ] \n\n## Scope (in)\n- \n\n## Scope (out)\n- \n\n## Owners\n| Area | Owner | Status |\n|---|---|---|\n|  |  |  |\n\n## Risks\n- \n" },
    { name: "Meeting notes", body: "# Meeting — {date}\n\n**Attendees:** \n\n## Agenda\n1. \n\n## Decisions\n- \n\n## Action items\n- [ ] — owner, due\n\n## Parking lot\n- \n" },
    { name: "Bug report", body: "# Bug: {title}\n\n**Severity:** P2 · **Component:** \n\n## Steps to reproduce\n1. \n2. \n\n## Expected\n\n## Actual\n\n## Environment\n- \n\n## Logs\n```\n```\n" },
    { name: "Reading log", body: "# Reading log\n\n## Currently reading\n- \n\n## Finished this month\n| Book | Pages | Rating |\n|---|---|---|\n|  |  | ⭐⭐⭐ |\n\n## Highlights\n> \n" },
  ];
  let TPL_CUSTOM = [];
  try { TPL_CUSTOM = JSON.parse(localStorage.getItem("cs-tpl") || "[]"); } catch { TPL_CUSTOM = []; }
  function saveTplCustom() { localStorage.setItem("cs-tpl", JSON.stringify(TPL_CUSTOM)); }
  const todayStr = () => new Date().toLocaleDateString(undefined, { weekday: "long", year: "numeric", month: "long", day: "numeric" });

  /* ---- prompt library (10 built-ins + star/search/CRUD) ---- */

  const PL_BUILTIN = [
    { name: "Explain like I'm five", body: "Explain this like I'm five years old, using one everyday analogy:" },
    { name: "Summarize in bullets", body: "Summarize the following in 5 crisp bullets, most important first:" },
    { name: "Review my code", body: "Review this code. List bugs, security issues, and style smells — each with a concrete fix:" },
    { name: "Make it shorter", body: "Rewrite the following to be 40% shorter without losing meaning:" },
    { name: "Make it formal", body: "Rewrite the following in a formal, professional tone:" },
    { name: "Brainstorm 10 ideas", body: "Brainstorm 10 distinct ideas for the following. Number them, vary the risk level:" },
    { name: "Find the gaps", body: "Play devil's advocate: what's missing, what assumptions are untested, what could break? List 5 concrete risks:" },
    { name: "Turn into a plan", body: "Turn the following into a step-by-step plan with owners, estimates, and a done-definition for each step:" },
    { name: "Draft the email", body: "Draft a short, friendly email from the following situation. Keep it under 120 words:" },
    { name: "Teach me in 3 steps", body: "Teach me this in exactly 3 steps, from basics to practice, with one check-question after each step:" },
  ];
  let PL_CUSTOM = [];
  try { PL_CUSTOM = JSON.parse(localStorage.getItem("cs-pl") || "[]"); } catch { PL_CUSTOM = []; }
  let PL_STARS = new Set(JSON.parse(localStorage.getItem("cs-plstars") || "[]"));
  function savePL() { localStorage.setItem("cs-pl", JSON.stringify(PL_CUSTOM)); localStorage.setItem("cs-plstars", JSON.stringify([...PL_STARS])); }

  /* ---- quick actions (8) ---- */

  const QUICK_ACTIONS = [
    { id: "tldr", label: "TL;DR", make: (t) => `TL;DR — give me the 3-sentence version of this:\n\n${t}` },
    { id: "eli5", label: "ELI5", make: (t) => `Explain this like I'm 5:\n\n${t}` },
    { id: "improve", label: "Improve", make: (t) => `Improve the writing below — fix clarity, flow, and typos. Return only the improved text:\n\n${t}` },
    { id: "shorten", label: "Shorten", make: (t) => `Shorten this by ~50% while keeping every key point:\n\n${t}` },
    { id: "expand", label: "Expand", make: (t) => `Expand on this with more detail, examples, and context:\n\n${t}` },
    { id: "bullets", label: "Bullets", make: (t) => `Convert this into tight action bullets:\n\n${t}` },
    { id: "translate", label: "Translate → EN", make: (t) => `Translate the following into natural English:\n\n${t}` },
    { id: "hindi", label: "हindi में", make: (t) => `अनुवाद करें हिंदी में:\n\n${t}` },
  ];
  function lastAssistantText() {
    for (let i = state.messages.length - 1; i >= 0; i--) {
      const m = state.messages[i];
      if (m.role === "assistant" && m.content) return m.content;
    }
    return "";
  }
  function runQuickAction(a) {
    const src = lastAssistantText();
    if (!src) { toast("Send a message first — quick actions act on the last answer", "err"); return; }
    doSend(a.make(src));
  }
  function followUpsFor(text) {
    const t = (text || "").slice(0, 600);
    const words = t.split(/\s+/).filter(Boolean).length;
    const out = [];
    if (/code|function|implement|script|bug/i.test(t)) { out.push("Write tests for this", "What would you refactor first?", "Explain the trickiest line"); }
    else if (/\d+\.|step|plan|list/i.test(t)) { out.push("Turn this into a checklist", "Which step is riskiest?", "Estimate how long this takes"); }
    else if (words > 120) { out.push("Summarize in 3 bullets", "What did I miss?", "Make it 50% shorter"); }
    else { out.push("Give a concrete example", "What are the trade-offs?", "What would a senior expert add?"); }
    return out.slice(0, 3);
  }

  /* ---- cost estimate (approx, public list prices) ---- */

  const MODEL_PRICING = {
    "gpt-4o": [2.5, 10], "gpt-4o-mini": [0.15, 0.6], "gpt-4-turbo": [10, 30],
    "llama3.2": [0, 0], "llama3.1": [0, 0], "cortexspace-demo": [0, 0],
    "claude-3.5-sonnet": [3, 15], "claude-3-haiku": [0.25, 1.25], "mistral": [0.2, 0.6],
  };
  function costEstimate(d) {
    const per = d.per_provider || {};
    const top = (d.top_models || [])[0];
    const p = top ? MODEL_PRICING[top.name] : null;
    if (!p) return "local/free model — $0.00";
    const inT = d.tokens || 0;
    const outT = Math.min(inT, Math.round(inT * 0.35));
    const usd = (inT * p[0] + outT * p[1]) / 1e6;
    return `${top.name}: <b>$${usd.toFixed(4)}</b> / 14d (approx, list price)`;
  }

  /* ---- PWA / offline / install ---- */

  function initPWA() {
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("/static/sw.js").catch(() => {});
    }
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      state._installEvt = e;
      const b = $("#btn-install");
      if (b) b.hidden = false;
    });
    const b = $("#btn-install");
    if (b) b.onclick = async () => {
      if (!state._installEvt) return;
      state._installEvt.prompt();
      b.hidden = true;
    };
    const setConn = (on) => {
      navigator.onLine = on;
      $("#conn-ind")?.classList.toggle("off", !on);
      $("#online-dot")?.classList.toggle("off", !on);
      $("#offline-banner")?.classList.toggle("hidden", on);
    };
    setConn(navigator.onLine);
    window.addEventListener("online", () => setConn(true));
    window.addEventListener("offline", () => setConn(false));
  }

  /* ---- dev console ---- */

  function initDevConsole() {
    window.cortexspace = {
      help: () => console.log("%cCortexSpace dev console", "font-weight:bold",
        "\n• cortexspace.dump() — dump state", "\n• cortexspace.stats() — usage stats",
        "\n• cortexspace.prefs — interface prefs", "\n• cortexspace.toast('msg') — test toast",
        "\n• cortexspace.confetti() — confetti", "\n• cortexspace.party() — party mode"),
      dump: () => console.log(JSON.stringify({
        chat: state.chat && state.chat.id, messages: state.messages.length,
        chats: state.chats.length, files: state.tree.length, openFile: state.openFile && state.openFile.path,
        prefs: PREFS, settings: state.settings,
      }, null, 2)),
      stats: async () => console.log(await api("/api/stats?days=14")),
      prefs: new Proxy(PREFS, { get: (t, k) => t[k], set: (t, k, v) => { t[k] = v; localStorage.setItem("cs-prefs", JSON.stringify(t)); applyPrefs(); return true; } }),
      toast: (m) => toast(m),
      confetti: () => confetti(160),
      party: () => toggleParty(),
    };
    const btn = $("#btn-dev");
    if (btn) btn.onclick = () => {
      cortexspace.help();
      toast("Dev console ready: cortexspace.help() in DevTools console");
    };
  }
  async function copyDiagnostics() {
    const s = state.settings || {};
    const d = await api("/api/stats?days=7").catch(() => ({}));
    const text = [
      "CortexSpace — diagnostics",
      "app: " + (location.origin),
      "browser: " + navigator.userAgent,
      "online: " + navigator.onLine,
      "screen: " + innerWidth + "x" + innerHeight,
      "provider: " + s.provider + " / " + (s.provider_model ? s.provider_model() : ""),
      "chats: " + (d.chats ?? "?"), "messages(7d): " + (d.messages ?? "?"),
      "localStorage keys: " + Object.keys(localStorage).filter((k) => k.startsWith("cs")).join(", "),
      "time: " + new Date().toISOString(),
    ].join("\n");
    try { await navigator.clipboard.writeText(text); toast("Diagnostics copied to clipboard"); }
    catch { toast("Copy failed", "err"); }
  }

  /* ---- about ---- */

  async function aboutModal() {
    const d = await api("/api/about");
    const body = el("div", { class: "about-box" },
      el("div", { class: "about-mark" }, "✦"),
      el("h3", null, d.name + " " + d.version),
      el("p", { class: "about-sub" }, "A fast, self-hosted AI workspace. Chat, files, an agent, web tools — one small Python process."),
      el("table", { class: "about-table" },
        row("Provider", d.provider + " · " + d.model),
        row("Chats", String(d.chats)),
        row("Workspace files", String(d.workspace_files)),
        row("Database", human(d.sizes.database)),
        row("Workspace", human(d.sizes.workspace)),
        row("File versions", human(d.sizes.versions)),
        row("Python", d.python),
        row("Frontend", "vanilla JS · no framework · no build step"),
      ),
      el("p", { class: "about-sub", style: "margin-top:10px" }, "Wrappers, not models — that's the whole point. CortexSpace wins where wrappers actually compete: speed you can measure, models you can choose (Ollama local, OpenRouter cloud, any OpenAI-compatible), an agent you can approve action-by-action, and zero telemetry. The intelligence is the model you point it at; everything around it is built to get out of the way."),
      el("p", { class: "about-note" }, "Everything lives on this machine. Outbound calls only go where you point them."),
    );
    showModal("About", body);
  }
  function row(k, v) { return el("tr", null, el("td", { class: "k" }, k), el("td", null, v)); }

  /* ============================================================
     WAVE 5 — UI builders
     ============================================================ */

  /* ---- settings: appearance registry ---- */

  function renderAppearSettings() {
    const box = $("#set-appear");
    if (!box) return;
    box.innerHTML = "";
    for (const d of PREF_DEFS) {
      const v = pref(d.key);
      const ctrl = el("span", { class: "pref-ctrl" });
      if (d.type === "swatches") {
        for (const [id, color] of d.options) {
          ctrl.append(el("button", {
            class: "swatch" + (v === id ? " on" : ""),
            style: `background:${color}`,
            title: id, type: "button",
            onclick: () => { setPref(d.key, id); renderAppearSettings(); },
          }));
        }
      } else if (d.type === "seg") {
        const seg = el("span", { class: "seg mini" });
        for (const [id, label] of d.options) {
          seg.append(el("button", {
            type: "button", class: v === id ? "on" : "",
            onclick: () => { setPref(d.key, id); renderAppearSettings(); },
          }, label));
        }
        ctrl.append(seg);
      } else if (d.type === "toggle") {
        const sw = el("label", { class: "switch mini" });
        const inp = el("input", { type: "checkbox" });
        inp.checked = !!v;
        inp.onchange = () => setPref(d.key, inp.checked);
        sw.append(inp, el("span"));
        ctrl.append(sw);
      } else if (d.type === "time") {
        const inp = el("input", { type: "time", class: "mini-time" });
        inp.value = v || d.def;
        inp.onchange = () => setPref(d.key, inp.value);
        ctrl.append(inp);
      }
      box.append(el("div", { class: "pref-row" }, el("span", null, d.label), ctrl));
    }
  }
  function initSettingsSearch() {
    const inp = $("#set-search");
    if (!inp) return;
    const CARDS = [
      ["Model provider", "provider model ollama openrouter openai"],
      ["Agent", "agent temperature tokens steps python auto-approve approval web search searxng system prompt persona"],
      ["Agent tools", "tools disabled run_python fetch web_search search"],
      ["Appearance", "theme dark light font size motion"],
      ["Interface preferences", "accent radius density glass contrast mono animation gradient wide avatars timestamps sound toast wordcount statusbar night os"],
      ["Private by design", "privacy data security"],
      ["Data & maintenance", "backup export import vacuum about storage size"],
      ["Danger zone", "delete reset permanent"],
    ];
    inp.addEventListener("input", () => {
      const q = inp.value.trim().toLowerCase();
      let hits = 0;
      for (const card of $$("#view-settings .set-card")) {
        const h3 = card.querySelector("h3");
        const key = CARDS.find((c) => h3 && h3.textContent === c[0]);
        const hay = ((h3 ? h3.textContent : "") + " " + (key ? key[1] : "")).toLowerCase();
        const on = !q || hay.includes(q);
        card.style.display = on ? "" : "none";
        if (on && q) hits++;
      }
      $("#set-search-count").textContent = q ? hits + " match" + (hits === 1 ? "" : "es") : "";
    });
    inp.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const q = inp.value.trim().toLowerCase();
      const first = $$("#view-settings .set-card").find((c) => c.style.display !== "none" && c.querySelector("h3"));
      if (first) { first.classList.add("flash"); first.scrollIntoView({ behavior: "smooth", block: "center" }); setTimeout(() => first.classList.remove("flash"), 1200); }
    });
  }
  const TOOL_DEFS = [
    ["list_workspace", "List files & folders"],
    ["read_file", "Read file contents"],
    ["write_file", "Create / overwrite files"],
    ["mkdir", "Create folders"],
    ["delete_file", "Delete files"],
    ["search_workspace", "Search file contents"],
    ["fetch_page", "Fetch a web page"],
    ["web_search", "Web search"],
    ["run_python", "Run Python (sandboxed)"],
  ];
  function renderToolToggles() {
    const box = $("#set-tools");
    if (!box || !state.settings) return;
    const disabled = new Set(state.settings.disabled_tools || []);
    box.innerHTML = "";
    for (const [name, desc] of TOOL_DEFS) {
      const off = disabled.has(name);
      const chip = el("label", { class: "tool-chip" + (off ? " off" : "") },
        el("input", { type: "checkbox" }),
        el("span", null,
          el("span", { class: "t-name" }, name),
          el("span", { class: "t-desc" }, desc),
        ),
      );
      const inp = chip.querySelector("input");
      inp.checked = !off;
      inp.onchange = () => {
        const s = state.settings;
        const cur = new Set(s.disabled_tools || []);
        if (inp.checked) cur.delete(name); else cur.add(name);
        s.disabled_tools = [...cur];
        chip.classList.toggle("off", !inp.checked);
        toast((inp.checked ? "Enabled" : "Disabled") + " tool: " + name + " (press Save)");
      };
      box.append(chip);
    }
    const pol = $("#set-approve-policy");
    if (pol) {
      pol.value = state.settings.auto_approve ? "auto" : (state.settings.strict_approve ? "strict" : "ask");
      pol.onchange = () => {
        state.settings.auto_approve = pol.value === "auto";
        state.settings.strict_approve = pol.value === "strict";
      };
    }
  }
  function initSettingsExtras() {
    for (const b of $$("#temp-presets .chip-btn")) b.onclick = () => {
      $("#set-temp").value = b.dataset.t;
      $("#set-temp").dispatchEvent(new Event("input"));
      toast("Temperature set to " + b.dataset.t);
    };
    for (const b of $$("#steps-presets .chip-btn")) b.onclick = () => {
      $("#set-steps").value = b.dataset.s;
      toast("Max steps set to " + b.dataset.s);
    };
    $("#btn-backup-dl").onclick = () => { window.location.href = "/api/backup"; toast("Backup downloading…"); };
    $("#backup-file").onchange = async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      try {
        const data = JSON.parse(await f.text());
        const res = await api("/api/backup", { method: "POST", body: data });
        toast(`Backup imported: ${res.imported} new chat(s), ${res.skipped} skipped`);
        loadChats();
      } catch (err) { toast("Import failed: " + err.message, "err"); }
      e.target.value = "";
    };
    $("#btn-export-all").onclick = () => { window.location.href = "/api/chats/export-all"; toast("Exporting all chats…"); };
    $("#btn-vacuum").onclick = async () => {
      try { await api("/api/db/vacuum", { method: "POST" }); toast("Database vacuumed"); renderStorageMeter(); }
      catch (e) { toast(e.message, "err"); }
    };
    $("#btn-about-set").onclick = aboutModal;
    const cc = $("#set-custom-css");
    if (cc) {
      cc.value = localStorage.getItem("cs-custom-css") || "";
      if (cc.value) { PREFS.customCss = cc.value; }
      cc.addEventListener("input", () => { localStorage.setItem("cs-custom-css", cc.value); PREFS.customCss = cc.value; localStorage.setItem("cs-prefs", JSON.stringify(PREFS)); applyPrefs(); });
    }
    const btns = { reset: null };
    const resetBtn = document.createElement("button");
    resetBtn.className = "btn ghost sm";
    resetBtn.textContent = "Reset interface prefs";
    resetBtn.onclick = resetPrefs;
    const expBtn = document.createElement("button");
    expBtn.className = "btn ghost sm";
    expBtn.textContent = "Export prefs";
    expBtn.onclick = prefExport;
    const impBtn = document.createElement("label");
    impBtn.className = "btn ghost sm";
    impBtn.textContent = "Import prefs";
    const fi = document.createElement("input");
    fi.type = "file"; fi.accept = "application/json"; fi.hidden = true;
    fi.onchange = () => { if (fi.files[0]) prefImport(fi.files[0]); fi.value = ""; };
    impBtn.append(fi);
    const holder = $("#set-appear").closest(".set-card");
    const grid = holder.querySelector(".set-grid");
    grid.append(el("div", { class: "set-field row", style: "flex-wrap:wrap;gap:8px" },
      el("span", null, "Preferences"), resetBtn, expBtn, impBtn));
  }
  async function renderStorageMeter() {
    const box = $("#storage-meter");
    if (!box) return;
    try {
      const d = await api("/api/about");
      const max = Math.max(d.sizes.total, 1);
      box.innerHTML = "";
      for (const [k, label] of [["database", "Database"], ["workspace", "Workspace"], ["versions", "Versions"]]) {
        box.append(el("div", { class: "sm-row" },
          el("span", null, label),
          el("span", { class: "sm-bar" }, el("i", { style: `width:${Math.max(2, (d.sizes[k] / max) * 100).toFixed(1)}%` })),
          el("span", { style: "text-align:right;font-family:var(--font-mono)" }, human(d.sizes[k])),
        ));
      }
    } catch { /* server down */ }
  }
  async function renderCostEstimate() {
    const box = $("#cost-est");
    if (!box) return;
    try { box.innerHTML = costEstimate(await api("/api/stats?days=14")); }
    catch { box.textContent = "unavailable"; }
  }

  /* ---- editor: find / wrap / goto / font / lock / dup / move / toc ---- */

  let FIND = { idx: -1, count: 0 };
  function editorTA() { const w = $(".editor-wrap"); return w ? w.querySelector(".file-editor") : null; }
  function editorWrap() { return $(".editor-wrap"); }
  function openFind() {
    const f = state.openFile;
    if (!f || f.binary) { toast("Open a text file first", "err"); return; }
    if (f.view === "preview") { f.view = "source"; renderFilePanel(); }
    const bar = $("#file-find-bar");
    bar.classList.remove("hidden");
    $("#find-input").value = "";
    $("#find-input").focus();
  }
  function closeFind() { $("#file-find-bar").classList.add("hidden"); clearFindMarks(); }
  function clearFindMarks() {
    const ta = editorTA();
    if (!ta) return;
    $$(".md mark.find-mark").forEach((m) => m.replaceWith(document.createTextNode(m.textContent)));
    FIND = { idx: -1, count: 0 };
    const c = $("#find-count"); if (c) c.textContent = "";
  }
  function doFind(dir) {
    const f = state.openFile;
    if (!f || f.binary) return;
    const q = $("#find-input").value;
    const ta = editorTA();
    if (!ta) return;
    if (!q) { clearFindMarks(); return; }
    const flags = ($("#find-case").checked ? "" : "i") + ($("#find-word").checked ? "g" : "g");
    let re;
    try {
      re = new RegExp($("#find-word").checked ? `\\b${q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b` : q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        $("#find-case").checked ? "g" : "gi");
    } catch { toast("Bad pattern", "err"); return; }
    const matches = ta.value.match(re);
    FIND.count = matches ? matches.length : 0;
    $("#find-count").textContent = FIND.count ? (FIND.idx + 1 < 0 ? 0 : (FIND.idx + 1) + "/" + FIND.count) : "0/0";
    if (!FIND.count) return;
    FIND.idx = (FIND.idx + dir + FIND.count) % FIND.count;
    let n = 0, m;
    re.lastIndex = 0;
    while ((m = re.exec(ta.value))) {
      if (n === FIND.idx) {
        const start = m.index, end = start + m[0].length;
        ta.focus();
        ta.setSelectionRange(start, end);
        const line = ta.value.slice(0, start).split("\n").length - 1;
        ta.scrollTop = Math.max(0, line * ta.clientHeight / 20 - 60);
        break;
      }
      n++;
      if (m.index === re.lastIndex) re.lastIndex++;
    }
    updateCursorPos();
  }
  function updateCursorPos() {
    const ta = editorTA();
    const c = $("#file-cursor");
    if (!c || !ta) { if (c) c.textContent = ""; return; }
    const pos = ta.selectionStart;
    const before = ta.value.slice(0, pos);
    const line = before.split("\n").length;
    const col = pos - before.lastIndexOf("\n");
    c.textContent = `Ln ${line}, Col ${col} · ${before.split("\n").length} lines`;
  }
  function gotoLine() {
    const f = state.openFile;
    if (!f || f.binary) return;
    if (f.view === "preview") { f.view = "source"; renderFilePanel(); }
    const total = f.content.split("\n").length;
    const n = prompt(`Go to line (1–${total}):`, "1");
    if (!n) return;
    const ln = parseInt(n, 10);
    if (!ln || ln < 1) return;
    const ta = editorTA();
    if (!ta) return;
    const lines = ta.value.split("\n");
    const target = Math.min(ln, lines.length);
    let pos = 0;
    for (let i = 0; i < target - 1; i++) pos += lines[i].length + 1;
    ta.focus();
    ta.setSelectionRange(pos, pos + (lines[target - 1] || "").length);
    ta.scrollTop = Math.max(0, (target - 5) * 19);
    updateCursorPos();
  }
  function toggleWrap() {
    const w = editorWrap();
    if (!w) { toast("Open a file to edit first", "err"); return; }
    w.classList.toggle("nowrap");
    $("#btn-file-wrap").classList.toggle("on", w.classList.contains("nowrap"));
    localStorage.setItem("cs-wrap", w.classList.contains("nowrap") ? "off" : "on");
  }
  function bumpEditorFont(dir) {
    const cur = parseFloat(localStorage.getItem("cs-ffs") || "1");
    const next = Math.min(2, Math.max(0.6, +(cur + dir * 0.12).toFixed(2)));
    localStorage.setItem("cs-ffs", String(next));
    document.documentElement.style.setProperty("--ffs-scale", String(next));
    toast("Editor font ×" + next.toFixed(2));
  }
  async function discardFile() {
    const f = state.openFile;
    if (!f || f.saved || f.binary) return;
    if (!confirm("Discard unsaved changes to " + f.path + "?")) return;
    try {
      const d = await api("/api/files?path=" + encodeURIComponent(f.path));
      f.content = d.content;
      f.saved = true;
      renderFilePanel();
      toast("Discarded changes");
    } catch (e) { toast(e.message, "err"); }
  }
  function toggleFileLock() {
    const f = state.openFile;
    if (!f) return;
    f.locked = !f.locked;
    $("#btn-file-lock").classList.toggle("on", f.locked);
    const ta = editorTA();
    if (ta) ta.classList.toggle("readonly", f.locked);
    toast(f.locked ? "File is read-only" : "File unlocked");
  }
  async function duplicateFile() {
    const f = state.openFile;
    if (!f || f.binary) { toast("Open a text file first", "err"); return; }
    const dot = f.path.lastIndexOf(".");
    const base = dot > 0 ? f.path.slice(0, dot) : f.path;
    const ext = dot > 0 ? f.path.slice(dot) : "";
    const dst = base + "-copy" + ext;
    try {
      await api("/api/files/write", { method: "PUT", body: { path: dst, content: f.content } });
      loadTree();
      toast("Created " + dst);
    } catch (e) { toast(e.message, "err"); }
  }
  function moveFile() {
    const f = state.openFile;
    if (!f) return;
    pathModal("Move file", f.path, f.path, "Move", (dst) => {
      const clean = dst.replace(/[^A-Za-z0-9_\-./ ]/g, "");
      if (!clean || clean === f.path) return;
      api("/api/files/rename", { method: "POST", body: { src: f.path, dst: clean } })
        .then(() => {
          const wasOpen = f.path;
          f.path = clean;
          renderFilePanel();
          loadTree();
          toast("Moved to " + clean);
        })
        .catch((e) => toast(e.message, "err"));
    });
  }
  function showTOC() {
    const f = state.openFile;
    if (!f || f.binary) return;
    if ($(".md-toc")) { $(".md-toc").remove(); return; }
    const heads = [...f.content.matchAll(/^(#{1,4})\s+(.+)$/gm)];
    if (!heads.length) { toast("No headings in this file", "err"); return; }
    const toc = el("div", { class: "md-toc" }, el("h5", null, "On this page"));
    for (const h of heads) {
      const id = "h-" + encodeURIComponent(h[2].trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40));
      toc.append(el("a", { class: "l" + h[1].length, href: "#", onclick: (e) => {
        e.preventDefault();
        const ta = editorTA();
        if (!ta) return;
        const idx = f.content.indexOf(h[2].trim());
        if (idx < 0) return;
        const line = f.content.slice(0, idx).split("\n").length - 1;
        ta.focus();
        const pos = idx;
        ta.setSelectionRange(pos, pos + h[2].length);
        ta.scrollTop = Math.max(0, (line - 4) * 19);
      } }, h[2].trim()));
    }
    document.body.append(toc);
    setTimeout(() => document.addEventListener("click", (e) => { if (!e.target.closest(".md-toc") && !e.target.closest("#btn-file-toc")) toc.remove(); }, { once: false }));
  }
  function copyFileContents() {
    const f = state.openFile;
    if (!f || f.binary) return;
    navigator.clipboard.writeText(f.content).then(() => toast("Contents copied")).catch(() => toast("Copy failed", "err"));
  }

  /* ---- tree: filter / sort / favorites ---- */

  let TREE_FAVS = new Set(JSON.parse(localStorage.getItem("cs-favs") || "[]"));
  function saveFavs() { localStorage.setItem("cs-favs", JSON.stringify([...TREE_FAVS])); }
  let treeSortMode = localStorage.getItem("cs-treesort") || "name";
  let treeFavsOnly = false;
  function sortNodes(nodes, mode) {
    const arr = [...nodes];
    if (mode === "size") arr.sort((a, b) => b.size - a.size);
    else if (mode === "mtime") arr.sort((a, b) => (b.mtime || 0) - (a.mtime || 0));
    else arr.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
    for (const n of arr) if (n.children) n.children = sortNodes(n.children, mode);
    return arr;
  }
  function treeMatch(node, q) {
    if (!q) return true;
    if (node.name.toLowerCase().includes(q)) return true;
    if (node.path.toLowerCase().includes(q)) return true;
    return (node.children || []).some((c) => treeMatch(c, q));
  }
  function toggleFav(path) {
    if (TREE_FAVS.has(path)) TREE_FAVS.delete(path); else TREE_FAVS.add(path);
    saveFavs();
    renderTree();
  }

  /* ---- browser: history / nav ---- */

  let B_HIST = JSON.parse(localStorage.getItem("cs-bhist") || "[]");
  let B_HIST_IDX = -1;
  function bhistPush(u) {
    B_HIST = B_HIST.filter((x) => x !== u);
    B_HIST.push(u);
    B_HIST = B_HIST.slice(-25);
    B_HIST_IDX = B_HIST.length - 1;
    localStorage.setItem("cs-bhist", JSON.stringify(B_HIST));
    updateNavBtns();
  }
  function bhistGo(delta) {
    const ni = B_HIST_IDX + delta;
    if (ni < 0 || ni >= B_HIST.length) return;
    B_HIST_IDX = ni;
    $("#browser-url").value = B_HIST[ni];
    browserGo();
  }
  function updateNavBtns() {
    $("#btn-b-back").disabled = B_HIST_IDX <= 0;
    $("#btn-b-fwd").disabled = B_HIST_IDX >= B_HIST.length - 1;
  }
  function renderBrowseHistory() {
    const list = $("#b-history-list");
    list.innerHTML = "";
    if (!B_HIST.length) { list.append(el("div", { class: "search-hint" }, "No visits yet.")); return; }
    for (let i = B_HIST.length - 1; i >= 0; i--) {
      list.append(el("div", { class: "pop-item", onclick: () => { B_HIST_IDX = i; $("#browser-url").value = B_HIST[i]; browserGo(); $("#b-history-pop").classList.add("hidden"); } },
        ico("#i-history"), el("span", { style: "word-break:break-all" }, B_HIST[i])));
    }
  }

  /* ---- insights v2 ---- */

  async function renderInsightsV2(d) {
    const set = (id, v) => { const n = $(id); if (n) n.textContent = v; };
    set("#ins-words", d.words ? Math.round(d.words / 1000) + "k" : "0");
    set("#ins-avg-ms", d.avg_response_ms ? (d.avg_response_ms / 1000).toFixed(1) + "s" : "—");
    set("#ins-tools-total", d.tools_total);
    set("#ins-top-day", d.top_day || "—");
    set("#ins-busy-hour", d.busiest_hour != null ? String(d.busiest_hour).padStart(2, "0") + ":00" : "—");
    set("#ins-streak-num", d.streak);
    set("#ins-today-msgs", d.messages_today);
    set("#ins-today-toks", d.tokens_today);
    const pm = d.prev_messages || 0, pt = d.prev_tokens || 0;
    const md = $("#ins-msgs-delta");
    if (md) {
      if (!pm) md.textContent = "";
      else { const pct = Math.round(((d.messages - pm) / pm) * 100); md.textContent = (pct >= 0 ? "▲" : "▼") + Math.abs(pct) + "%"; md.className = "ins-delta " + (pct >= 0 ? "up" : "down"); }
    }
    const td = $("#ins-toks-delta");
    if (td) {
      if (!pt) td.textContent = "";
      else { const pct = Math.round(((d.tokens - pt) / pt) * 100); td.textContent = (pct >= 0 ? "▲" : "▼") + Math.abs(pct) + "%"; td.className = "ins-delta " + (pct >= 0 ? "up" : "down"); }
    }
    // heatmap
    const hm = $("#ins-heatmap");
    hm.innerHTML = "";
    const days = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
    const max = Math.max(1, ...d.heatmap.flat());
    d.heatmap.forEach((row, di) => {
      hm.append(el("span", { class: "ins-heat-day" }, days[di]));
      row.forEach((v, hi) => {
        const lvl = v === 0 ? "" : v < max * 0.25 ? "l1" : v < max * 0.5 ? "l2" : v < max * 0.8 ? "l3" : "l4";
        hm.append(el("span", { class: "ins-heat-cell " + lvl, title: days[di] + " " + String(hi).padStart(2, "0") + ":00 — " + v + " msg(s)" }));
      });
    });
    // per provider
    const pp = $("#ins-providers");
    pp.innerHTML = "";
    const provs = Object.entries(d.per_provider || {});
    if (!provs.length) pp.append(el("div", { class: "search-hint" }, "No provider usage yet."));
    const tot = provs.reduce((s, [, v]) => s + v.tokens, 0) || 1;
    for (const [p, v] of provs.sort((a, b) => b[1].tokens - a[1].tokens)) {
      pp.append(el("div", { class: "tool-bar-row" },
        el("span", { class: "tb-name" }, p),
        el("span", { class: "tb-bar" }, el("i", { style: `width:${Math.max(3, (v.tokens / tot) * 100).toFixed(0)}%` })),
        el("span", { class: "tb-val" }, v.messages + " msgs · " + v.tokens + " tok")));
    }
    if (d.streak >= 3) w5stat("streak", d.streak);
  }
  function insightsCSV(d) {
    const lines = [["day", "messages", "tokens"].join(",")];
    const days = d.per_day_messages.length;
    for (let i = 0; i < days; i++) {
      const row = d.per_day_messages[i];
      const ts = Array.isArray(row) ? row[0] : row;
      const v = Array.isArray(row) ? row[1] : row;
      const tr = (d.per_day_tokens || [])[i];
      const tv = Array.isArray(tr) ? tr[1] : (tr || 0);
      lines.push([new Date(ts).toISOString().slice(0, 10), v, tv].join(","));
    }
    lines.push("");
    lines.push("metric,value");
    lines.push("words," + d.words);
    lines.push("tools_total," + d.tools_total);
    lines.push("avg_response_ms," + d.avg_response_ms);
    lines.push("streak," + d.streak);
    lines.push("messages_today," + d.messages_today);
    lines.push("tokens_today," + d.tokens_today);
    for (const [p, v] of Object.entries(d.per_provider || {})) lines.push(`provider:${p},${v.messages} msgs, ${v.tokens} tokens`.replace(",", ", "));
    const blob = new Blob([lines.join("\n")], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "cortexspace-insights.csv";
    a.click();
    URL.revokeObjectURL(a.href);
    toast("Insights exported as CSV");
  }

  /* ---- templates popover ---- */

  function allTemplates() {
    return TPL_BUILTIN.map((t) => ({ ...t, builtin: true })).concat(
      TPL_CUSTOM.map((t) => ({ name: t.name, body: t.body, builtin: false })));
  }
  function renderTemplates() {
    const list = $("#tpl-list");
    const q = ($("#tpl-filter").value || "").toLowerCase();
    list.innerHTML = "";
    const items = allTemplates().filter((t) => !q || t.name.toLowerCase().includes(q) || t.body.toLowerCase().includes(q));
    $("#tpl-count").textContent = items.length;
    for (const t of items) {
      const item = el("div");
      const main = el("button", { class: "lib-item", type: "button" },
        el("span", { class: "li-title" }, ico("#i-file"), t.name, t.builtin ? "" : el("span", { class: "li-star", style: "color:var(--text-faint);font-size:10px" }, "custom")),
        el("span", { class: "li-body" }, t.body.split("\n").slice(1, 3).join(" ").slice(0, 90) + "…"));
      main.onclick = () => createFromTemplate(t);
      item.append(main);
      if (!t.builtin) {
        item.append(el("button", {
          class: "icon-btn sm", title: "Delete template", style: "position:absolute;right:8px;top:8px",
          onclick: () => { TPL_CUSTOM = TPL_CUSTOM.filter((x) => x.name !== t.name); saveTplCustom(); renderTemplates(); toast("Template deleted"); },
        }, ico("#i-trash")));
      }
      list.append(item);
    }
    if (!items.length) list.append(el("div", { class: "search-hint" }, "No templates match."));
  }
  async function createFromTemplate(t) {
    const name = prompt("Template: " + t.name + "\n\nFile path:", "notes/" + t.name.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-" + new Date().toISOString().slice(0, 10) + ".md");
    if (!name) return;
    const clean = name.replace(/[^A-Za-z0-9_\-./ ]/g, "");
    const finalPath = clean.includes(".") ? clean : clean + ".md";
    try {
      const body = t.body.replace(/\{date\}/g, todayStr()).replace(/\{title\}/g, clean.split("/").pop().replace(/\.md$/i, "").replace(/[-_]/g, " "));
      await api("/api/files/write", { method: "PUT", body: { path: finalPath, content: body } });
      loadTree();
      openFile(finalPath);
      $("#templates-pop").classList.add("hidden");
      toast("Created from template: " + finalPath);
    } catch (e) { toast(e.message, "err"); }
  }
  function saveCurrentAsTemplate() {
    const f = state.openFile;
    if (!f || f.binary) { toast("Open a file first", "err"); return; }
    const name = prompt("Save " + f.path + " as template:", f.path.split("/").pop());
    if (!name) return;
    if (allTemplates().some((t) => t.name === name)) { toast("Template name already exists", "err"); return; }
    TPL_CUSTOM.push({ name, body: f.content });
    saveTplCustom();
    renderTemplates();
    toast("Saved template: " + name);
  }

  /* ---- prompt library popover ---- */

  let plStarredOnly = false;
  function allPrompts() {
    return PL_BUILTIN.map((p) => ({ ...p, builtin: true })).concat(PL_CUSTOM.map((p) => ({ ...p, builtin: false })));
  }
  function renderPromptLib() {
    const list = $("#pl-list");
    const q = ($("#pl-filter").value || "").toLowerCase();
    list.innerHTML = "";
    let items = allPrompts().filter((p) => !q || p.name.toLowerCase().includes(q) || p.body.toLowerCase().includes(q));
    if (plStarredOnly) items = items.filter((p) => PL_STARS.has(p.name));
    $("#pl-count").textContent = items.length;
    for (const p of items) {
      const starred = PL_STARS.has(p.name);
      const row = el("div", { style: "position:relative" });
      const main = el("button", { class: "lib-item", type: "button" },
        el("span", { class: "li-title" }, starred ? el("span", { class: "li-star" }, "★") : ico("#i-wand"), p.name),
        el("span", { class: "li-body" }, p.body.slice(0, 100) + (p.body.length > 100 ? "…" : "")));
      main.onclick = () => {
        const c = $("#composer");
        c.value = p.body;
        autosize(c);
        c.focus();
        $("#prompt-pop").classList.add("hidden");
      };
      const star = el("button", { class: "icon-btn sm", title: starred ? "Unstar" : "Star", style: "position:absolute;right:8px;top:10px;color:" + (starred ? "var(--warn)" : "var(--text-faint)"),
        onclick: () => { if (PL_STARS.has(p.name)) PL_STARS.delete(p.name); else PL_STARS.add(p.name); savePL(); renderPromptLib(); } }, ico("#i-star"));
      row.append(main, star);
      if (!p.builtin) {
        row.append(el("button", { class: "icon-btn sm", title: "Delete prompt", style: "position:absolute;right:34px;top:10px",
          onclick: () => { PL_CUSTOM = PL_CUSTOM.filter((x) => x.name !== p.name); savePL(); renderPromptLib(); } }, ico("#i-trash")));
      }
      list.append(row);
    }
    if (!items.length) list.append(el("div", { class: "search-hint" }, "No prompts match."));
  }
  function newPrompt() {
    const name = prompt("Prompt name:");
    if (!name) return;
    const body = prompt("Prompt text:");
    if (!body) return;
    if (allPrompts().some((p) => p.name === name)) { toast("Name already exists", "err"); return; }
    PL_CUSTOM.push({ name, body });
    savePL();
    renderPromptLib();
    toast("Prompt saved: " + name);
  }

  /* ---- pomodoro ---- */

  const POMO = { mode: "focus", total: 25 * 60, left: 25 * 60, tick: null, runs: 0 };
  function pomoSetMode(mode) {
    POMO.mode = mode;
    POMO.total = (mode === "focus" ? 25 : 5) * 60;
    POMO.left = POMO.total;
    $("#pomo-mode").textContent = mode === "focus" ? "Focus" : "Break";
    pomoPaint();
  }
  function pomoPaint() {
    const m = Math.floor(POMO.left / 60), s = POMO.left % 60;
    const label = String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    $("#pomo-time").textContent = label;
    $("#pomo-bar-fill").style.width = ((1 - POMO.left / POMO.total) * 100).toFixed(1) + "%";
    $("#pomo-badge").textContent = m + ":" + String(s).padStart(2, "0");
    $("#pomo-badge").classList.toggle("hidden", POMO.tick === null);
  }
  function pomoStartPause() {
    if (POMO.tick) {
      clearInterval(POMO.tick);
      POMO.tick = null;
      $("#pomo-start").textContent = "Start";
    } else {
      POMO.tick = setInterval(() => {
        POMO.left--;
        if (POMO.left <= 0) {
          clearInterval(POMO.tick);
          POMO.tick = null;
          if (POMO.mode === "focus") {
            POMO.runs++;
            beep("ding");
            confetti(60);
            toast("Focus done! Take a 5-minute break. 🍅", "ach", 5000);
            pomoSetMode("break");
          } else {
            beep("ok");
            toast("Break over — back to focus.");
            pomoSetMode("focus");
          }
          $("#pomo-start").textContent = "Start";
        }
        pomoPaint();
      }, 1000);
      $("#pomo-start").textContent = "Pause";
    }
  }
  function togglePomodoro() {
    const w = $("#pomo-widget");
    if (w.classList.contains("hidden")) {
      w.classList.remove("hidden");
      if (!$("#pomo-widget").contains(document.activeElement)) $("#pomo-start").focus();
    } else w.classList.add("hidden");
  }

  /* ---- zoom ---- */

  function setZoom(z) {
    z = Math.min(1.4, Math.max(0.7, z));
    localStorage.setItem("cs-zoom", String(z));
    document.documentElement.style.setProperty("--zoom", z === 1 ? "" : String(z));
    if (z === 1) document.documentElement.style.removeProperty("--zoom");
    toast("Zoom " + Math.round(z * 100) + "%");
  }

  /* ---- chat menu / follow-up / message ops ---- */

  function toggleChatMenu() {
    $("#chat-menu-pop").classList.toggle("hidden");
  }
  function printChat() { window.print(); }
  function dupChat() { forkChatFrom(state.messages.filter((m) => m.role === "assistant").pop()); }
  function newChatWithContext() {
    const ctx = [...state.context];
    newChat().then(() => {
      if (ctx.length) { state.context = ctx; renderContextChips(); toast("Context carried over"); }
    });
  }
  function pinMessage() {
    const chatId = state.chat && state.chat.id;
    if (!chatId) return;
    let pins = JSON.parse(localStorage.getItem("cs-pins") || "{}");
    const key = chatId;
    const cur = new Set(pins[key] || []);
    // pin the last assistant message
    for (let i = state.messages.length - 1; i >= 0; i--) {
      if (state.messages[i].role === "assistant") {
        const mid = state.messages[i].id;
        if (cur.has(mid)) cur.delete(mid); else cur.add(mid);
        break;
      }
    }
    pins[key] = [...cur];
    localStorage.setItem("cs-pins", JSON.stringify(pins));
    renderMessages();
  }
  function searchInChat() {
    const q = prompt("Search in this chat:");
    if (!q) return;
    const idx = state.messages.findIndex((m) => (m.content || "").toLowerCase().includes(q.toLowerCase()));
    if (idx < 0) { toast("No match in this chat", "err"); return; }
    const node = $(`#msg-list .msg[data-mid="${state.messages[idx].id}"]`);
    if (node) { node.scrollIntoView({ behavior: "smooth", block: "center" }); node.classList.add("flash-msg"); setTimeout(() => node.classList.remove("flash-msg"), 1500); }
  }
  function renderFollowUps() {
    const last = [...state.messages].reverse().find((m) => m.role === "assistant");
    if (!last || state.streaming) return;
    const node = $(`#msg-list .msg[data-mid="${last.id}"]`);
    if (!node || node.querySelector(".followups")) return;
    const chips = el("div", { class: "followups" });
    for (const q of followUpsFor(last.content)) {
      chips.append(el("button", { class: "followup-chip", onclick: () => doSend(q) }, "→ " + q));
    }
    node.append(chips);
  }
  function editResendUser(m) {
    const c = $("#composer");
    c.value = m.content;
    state._editMid = m.id;
    autosize(c);
    c.focus();
    c.setSelectionRange(c.value.length, c.value.length);
    toast("Editing — press Enter to resend, Esc to cancel", "ok", 4000);
  }
  function cancelEdit() {
    if (state._editMid) { state._editMid = null; renderMessages(); }
  }
  async function deleteMessage(mid) {
    if (!state.chat) return;
    const idx = state.messages.findIndex((m) => m.id === mid);
    if (idx < 0) return;
    const snapshot = state.messages[idx];
    try {
      await api(`/api/chats/${state.chat.id}/messages/${mid}`, { method: "DELETE" });
      state.messages = state.messages.filter((m) => m.id !== mid);
      renderMessages();
      toastUndo("Message deleted", "Undo", () => {
        state.messages.splice(idx, 0, snapshot);
        renderMessages();
      });
    } catch (e) { toast(e.message, "err"); }
  }
  function quoteMessage(m) {
    const c = $("#composer");
    const quoted = m.content.split("\n").slice(0, 4).map((l) => "> " + l).join("\n");
    c.value = (c.value ? c.value + "\n\n" : "") + quoted + "\n";
    autosize(c);
    c.focus();
  }
  function copyAsMarkdown(m) {
    navigator.clipboard.writeText(m.content).then(() => toast("Copied as Markdown")).catch(() => toast("Copy failed", "err"));
  }
  async function saveAnswerToFile() {
    const text = lastAssistantText();
    if (!text) { toast("Nothing to save yet", "err"); return; }
    const name = prompt("Save last answer to file:", "notes/answer-" + new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-") + ".md");
    if (!name) return;
    try {
      await api("/api/files/write", { method: "PUT", body: { path: name, content: text } });
      loadTree();
      toast("Saved to " + name);
    } catch (e) { toast(e.message, "err"); }
  }
  function jumpToMessage() {
    const n = prompt("Jump to message # (1 = oldest):", "1");
    if (!n) return;
    const idx = parseInt(n, 10) - 1;
    if (!state.messages[idx]) { toast("No such message", "err"); return; }
    const node = $(`#msg-list .msg[data-mid="${state.messages[idx].id}"]`) || $("#msg-list").children[idx];
    if (node) { node.scrollIntoView({ behavior: "smooth", block: "center" }); node.classList.add("flash-msg"); setTimeout(() => node.classList.remove("flash-msg"), 1500); }
  }

  /* ---- fun: party / konami / hullu / logo taps / random fact ---- */

  let PARTY = false;
  function toggleParty() {
    PARTY = !PARTY;
    document.body.classList.toggle("party-mode", PARTY);
    if (PARTY) { confetti(180); toast("🎉 PARTY MODE — type the Konami code to toggle it off", "ach", 5000); }
    else toast("Party's over. Back to work.");
  }
  const KONAMI = ["arrowup", "arrowup", "arrowdown", "arrowdown", "arrowleft", "arrowright", "arrowleft", "arrowright", "b", "a"];
  let konamiBuf = [];
  function konamiCheck(key) {
    konamiBuf.push(key);
    konamiBuf = konamiBuf.slice(-KONAMI.length);
    if (KONAMI.every((k, i) => konamiBuf[i] === k)) {
      konamiBuf = [];
      toggleParty();
      return true;
    }
    return false;
  }
  function hulluCheck(text) {
    if (!/^\s*hullu\s*\??\.?\s*$/i.test(text || "")) return false;
    setTimeout(() => {
      confetti(200);
      toast("🚀 HULLU! Warp speed engaged… just kidding — but nice one.", "ach", 5000);
    }, 400);
    return true;
  }
  let logoTaps = 0, logoTapTimer = null;
  function logoTap() {
    logoTaps++;
    clearTimeout(logoTapTimer);
    logoTapTimer = setTimeout(() => { logoTaps = 0; }, 1500);
    if (logoTaps === 5) {
      logoTaps = 0;
      confetti(140);
      toast("✦✦ warp speed ✦✦ — that's 5 logo taps. Legend.");
    }
  }
  function moodPicker() {
    const chatId = state.chat && state.chat.id;
    if (!chatId) { toast("Start a chat first", "err"); return; }
    let moods = JSON.parse(localStorage.getItem("cs-moods") || "{}");
    const cur = moods[chatId] || "";
    const pick = prompt("Pick a mood for this chat (or blank to clear):\n\n" + MOODS.join("  "), cur);
    if (pick === null) return;
    if (pick.trim()) moods[chatId] = pick.trim(); else delete moods[chatId];
    localStorage.setItem("cs-moods", JSON.stringify(moods));
    const titleEl = $("#chat-title");
    renderMoodBadge();
  }
  function renderMoodBadge() {
    const chatId = state.chat && state.chat.id;
    const badge = $("#chat-mood");
    if (!badge) return;
    if (!chatId) { badge.textContent = ""; return; }
    const moods = JSON.parse(localStorage.getItem("cs-moods") || "{}");
    badge.textContent = moods[chatId] || "";
  }

  /* ---- daily goal ---- */

  function goalData() {
    return JSON.parse(localStorage.getItem("cs-goal") || "{}");
  }
  function setGoal(n) {
    const v = prompt("Daily goal — how many messages a day? (blank to clear)", goalData().n || 10);
    if (v === null) return;
    const num = parseInt(v, 10);
    if (!num || num < 1) { localStorage.removeItem("cs-goal"); renderGoal(); return; }
    localStorage.setItem("cs-goal", JSON.stringify({ n: num, day: todayStr(), count: W5_STATS.msgs }));
    renderGoal();
    toast("Daily goal: " + num + " messages/day");
  }
  async function renderGoal() {
    const g = goalData();
    const ring = $("#goal-ring");
    if (!ring) return;
    if (!g.n) { ring.style.display = "none"; return; }
    ring.style.display = "";
    let today = 0;
    try {
      const d = await api("/api/stats?days=1");
      today = d.messages_today || 0;
    } catch { today = 0; }
    const pct = Math.min(100, Math.round((today / g.n) * 100));
    ring.style.setProperty("--goal-pct", pct + "%");
    $("#goal-txt").textContent = today + "/" + g.n;
    ring.title = `Daily goal: ${today}/${g.n} messages — click to change`;
    if (pct >= 100 && g.done !== today) {
      g.done = today;
      localStorage.setItem("cs-goal", JSON.stringify(g));
      confetti(100);
      toast("🎯 Daily goal hit! " + today + " messages.", "ach", 5000);
    }
  }

  /* ============================================================
     WAVE 5 — wiring
     ============================================================ */

  /* ---- extra slash commands (30) ---- */

  const SLASH_EXTRA = [
    { cmd: "tldr", desc: "Summarize the last answer in 3 sentences", run: () => runQuickAction(QUICK_ACTIONS[0]) },
    { cmd: "eli5", desc: "Explain the last answer like I'm 5", run: () => runQuickAction(QUICK_ACTIONS[1]) },
    { cmd: "improve", desc: "Improve the last answer's writing", run: () => runQuickAction(QUICK_ACTIONS[2]) },
    { cmd: "shorten", desc: "Shorten the last answer by 50%", run: () => runQuickAction(QUICK_ACTIONS[3]) },
    { cmd: "expand", desc: "Expand the last answer with detail", run: () => runQuickAction(QUICK_ACTIONS[4]) },
    { cmd: "bullets", desc: "Turn the last answer into bullets", run: () => runQuickAction(QUICK_ACTIONS[5]) },
    { cmd: "translate", desc: "Translate the last answer to English", run: () => runQuickAction(QUICK_ACTIONS[6]) },
    { cmd: "hindi", desc: "Translate the last answer to Hindi", run: () => runQuickAction(QUICK_ACTIONS[7]) },
    { cmd: "save", desc: "Save the last answer to a file", run: saveAnswerToFile },
    { cmd: "quote", desc: "Quote the last message into the composer", run: () => { const m = [...state.messages].reverse().find((x) => x.content); if (m) quoteMessage(m); else toast("Nothing to quote", "err"); } },
    { cmd: "print", desc: "Print this chat", run: printChat },
    { cmd: "dup", desc: "Duplicate this chat", run: dupChat },
    { cmd: "clear", desc: "Clear the composer", run: () => { $("#composer").value = ""; autosize($("#composer")); toast("Composer cleared"); } },
    { cmd: "find", desc: "Find in the open file", run: openFind },
    { cmd: "goto", desc: "Go to a line in the open file", run: gotoLine },
    { cmd: "toc", desc: "Table of contents for the open file", run: showTOC },
    { cmd: "dupfile", desc: "Duplicate the open file", run: duplicateFile },
    { cmd: "movefile", desc: "Move the open file", run: moveFile },
    { cmd: "lock", desc: "Toggle read-only on the open file", run: toggleFileLock },
    { cmd: "discard", desc: "Discard unsaved changes", run: discardFile },
    { cmd: "wrap", desc: "Toggle word wrap", run: toggleWrap },
    { cmd: "zoomin", desc: "Zoom in", run: () => setZoom(parseFloat(localStorage.getItem("cs-zoom") || "1") + 0.1) },
    { cmd: "zoomout", desc: "Zoom out", run: () => setZoom(parseFloat(localStorage.getItem("cs-zoom") || "1") - 0.1) },
    { cmd: "zoomreset", desc: "Reset zoom", run: () => setZoom(1) },
    { cmd: "pomo", desc: "Toggle pomodoro timer", run: togglePomodoro },
    { cmd: "party", desc: "Party mode", run: toggleParty },
    { cmd: "confetti", desc: "Confetti!", run: () => confetti(160) },
    { cmd: "mute", desc: "Mute sounds", run: () => setMute(true) },
    { cmd: "unmute", desc: "Unmute sounds", run: () => setMute(false) },
    { cmd: "ach", desc: "Show achievements", run: achievementsModal },
    { cmd: "about", desc: "About CortexSpace", run: aboutModal },
    { cmd: "backup", desc: "Download backup", run: () => { window.location.href = "/api/backup"; } },
    { cmd: "csv", desc: "Export insights as CSV", run: async () => { const d = await api("/api/stats?days=" + (($("#ins-days") && $("#ins-days").value) || 14)); insightsCSV(d); } },
    { cmd: "diag", desc: "Copy diagnostics to clipboard", run: copyDiagnostics },
    { cmd: "goal", desc: "Set your daily message goal", run: setGoal },
  ];

  /* ---- extra palette items (30+) ---- */

  function paletteExtra() {
    return [
      { label: "Save last answer to file", icon: "#i-cloud-dl", run: saveAnswerToFile },
      { label: "Print current chat", icon: "#i-print", run: printChat },
      { label: "Duplicate chat", icon: "#i-copy", run: dupChat },
      { label: "New chat with context", icon: "#i-fork", run: newChatWithContext },
      { label: "Pin last message", icon: "#i-pin", run: pinMessage },
      { label: "Search in this chat", icon: "#i-search", run: searchInChat },
      { label: "Jump to message", icon: "#i-target", run: jumpToMessage },
      { label: "Delete last message", icon: "#i-trash", run: () => { const m = [...state.messages].reverse().find((x) => x.id); if (m) deleteMessage(m.id); } },
      { label: "Quick action: TL;DR", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[0]) },
      { label: "Quick action: ELI5", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[1]) },
      { label: "Quick action: Improve", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[2]) },
      { label: "Quick action: Shorten", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[3]) },
      { label: "Quick action: Expand", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[4]) },
      { label: "Quick action: Bullets", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[5]) },
      { label: "Quick action: Translate", icon: "#i-wand", run: () => runQuickAction(QUICK_ACTIONS[6]) },
      { label: "Find in file", icon: "#i-find", run: openFind },
      { label: "Go to line", icon: "#i-target", run: gotoLine },
      { label: "File: table of contents", icon: "#i-list", run: showTOC },
      { label: "File: duplicate", icon: "#i-copy", run: duplicateFile },
      { label: "File: move to folder", icon: "#i-move", run: moveFile },
      { label: "File: toggle read-only", icon: "#i-lock", run: toggleFileLock },
      { label: "File: discard changes", icon: "#i-restore", run: discardFile },
      { label: "Toggle word wrap", icon: "#i-wrap", run: toggleWrap },
      { label: "Reset zoom", icon: "#i-zoom-in", run: () => setZoom(1) },
      { label: "Pomodoro timer", icon: "#i-timer", run: togglePomodoro },
      { label: "Party mode", icon: "#i-party", run: toggleParty },
      { label: "Confetti", icon: "#i-spark", run: () => confetti(180) },
      { label: "Achievements", icon: "#i-trophy", run: achievementsModal },
      { label: "Set daily goal", icon: "#i-target", run: setGoal },
      { label: "Export insights CSV", icon: "#i-download", run: async () => { const d = await api("/api/stats?days=14"); insightsCSV(d); } },
      { label: "Copy diagnostics", icon: "#i-cpu", run: copyDiagnostics },
      { label: "About CortexSpace", icon: "#i-info", run: aboutModal },
      { label: "Download backup", icon: "#i-cloud-dl", run: () => { window.location.href = "/api/backup"; } },
      { label: "Vacuum database", icon: "#i-refresh", run: async () => { await api("/api/db/vacuum", { method: "POST" }); toast("Vacuumed"); } },
      { label: "Save current file as template", icon: "#i-layers", run: saveCurrentAsTemplate },
      { label: "New prompt", icon: "#i-wand", run: () => { openPromptLib(); setTimeout(newPrompt, 100); } },
      { label: "Mood for this chat", icon: "#i-smile", run: moodPicker },
    ];
  }

  /* ---- popover toggles for libraries ---- */

  function openTemplates() {
    renderTemplates();
    $("#templates-pop").classList.toggle("hidden");
  }
  function openPromptLib() {
    renderPromptLib();
    $("#prompt-pop").classList.toggle("hidden");
  }

  /* ---- main init for wave 5 ---- */

  function csWave5Init() {
    // restore zoom / editor font / wrap + apply prefs
    const z = parseFloat(localStorage.getItem("cs-zoom") || "1");
    if (z !== 1) document.documentElement.style.setProperty("--zoom", String(z));
    const ffs = parseFloat(localStorage.getItem("cs-ffs") || "1");
    if (ffs !== 1) document.documentElement.style.setProperty("--ffs-scale", String(ffs));
    const wrapOn = localStorage.getItem("cs-wrap") !== "off";
    applyPrefs();

    // quick actions row
    const qaRow = $("#qa-row");
    qaRow.innerHTML = "";
    for (const a of QUICK_ACTIONS) {
      qaRow.append(el("button", { class: "qa-chip", title: a.label, onclick: () => runQuickAction(a) }, a.label));
    }
    if (localStorage.getItem("qa-visible") !== "0") $("#quick-actions").hidden = false;

    // composer: counts, clear, paste-upload, draft autosave
    const comp = $("#composer");
    const counts = $("#comp-counts");
    comp.addEventListener("input", () => {
      const v = comp.value;
      const words = v.trim() ? v.trim().split(/\s+/).length : 0;
      counts.textContent = pref("wordcount") ? v.length + " chars · " + words + " words" : "";
      const key = state.chat ? "cs-draft-" + state.chat.id : "cs-draft-new";
      if (v) {
        localStorage.setItem(key, v);
        const flag = $("#draft-flag");
        if (flag) { flag.classList.remove("hidden"); clearTimeout(comp._dt); comp._dt = setTimeout(() => flag.classList.add("hidden"), 1600); }
      } else localStorage.removeItem(key);
    });
    $("#btn-clear-composer").onclick = () => {
      comp.value = "";
      autosize(comp);
      $("#btn-send").disabled = !state.streaming;
      counts.textContent = "";
      comp.focus();
    };
    comp.addEventListener("paste", (e) => {
      const items = e.clipboardData && e.clipboardData.items;
      if (!items) return;
      for (const it of items) {
        if (it.type.startsWith("image/")) {
          e.preventDefault();
          const file = it.getAsFile();
          uploadFile(file, "uploads").then((r) => toast("Pasted image saved: " + r.path)).catch((err) => toast(err.message, "err"));
          return;
        }
      }
    });
    // restore draft when a chat opens
    const _openChat = openChat;
    openChat = async (id) => {
      await _openChat(id);
      const draft = localStorage.getItem("cs-draft-" + id);
      if (draft && !state.streaming) {
        const c = $("#composer");
        if (!c.value) { c.value = draft; autosize(c); $("#draft-flag").classList.remove("hidden"); setTimeout(() => $("#draft-flag").classList.add("hidden"), 2500); }
      }
    };

    // message action additions (delegated)
    document.addEventListener("click", (e) => {
      const b = e.target.closest("[data-mact]");
      if (!b) return;
      const node = b.closest(".msg");
      const mid = node && node.dataset.mid;
      const m = mid ? state.messages.find((x) => x.id === mid) : null;
      if (!m) return;
      const act = b.dataset.mact;
      if (act === "quote") quoteMessage(m);
      else if (act === "edit") editResendUser(m);
      else if (act === "del") deleteMessage(m.id);
      else if (act === "copymd") copyAsMarkdown(m);
    });

    // topbar
    $("#btn-zoom-in").onclick = () => setZoom(parseFloat(localStorage.getItem("cs-zoom") || "1") + 0.1);
    $("#btn-zoom-out").onclick = () => setZoom(parseFloat(localStorage.getItem("cs-zoom") || "1") - 0.1);
    $("#btn-mute").onclick = () => { setMute(!pref("sound")); $("#btn-mute").classList.toggle("on", !pref("sound")); };
    $("#btn-mute").classList.toggle("on", !pref("sound"));
    $("#btn-dnd").onclick = (e) => {
      DND = !DND;
      e.currentTarget.classList.toggle("on", DND);
      toast(DND ? "Do not disturb: on" : "Do not disturb: off");
    };
    $("#btn-about").onclick = aboutModal;
  $("#model-badge").onclick = togglePinMenu;
    $("#btn-pomodoro").onclick = togglePomodoro;
    $("#btn-chat-menu").onclick = (e) => { e.stopPropagation(); toggleChatMenu(); };

    // chat menu items
    $("#cm-print").onclick = () => { toggleChatMenu(); printChat(); };
    $("#cm-dup").onclick = () => { toggleChatMenu(); dupChat(); };
    $("#cm-ctx").onclick = () => { toggleChatMenu(); newChatWithContext(); };
    $("#cm-pin-msg").onclick = () => { toggleChatMenu(); pinMessage(); };
    $("#cm-search").onclick = () => { toggleChatMenu(); searchInChat(); };
    $("#cm-del").onclick = () => { toggleChatMenu(); if (state.chat) delChat(state.chat.id); };

    // sidebar library buttons
    $("#btn-templates").onclick = (e) => { e.stopPropagation(); openTemplates(); };
    $("#btn-prompt-lib").onclick = (e) => { e.stopPropagation(); openPromptLib(); };
    $("#tpl-filter").addEventListener("input", renderTemplates);
    $("#pl-filter").addEventListener("input", renderPromptLib);
    $("#pl-starred").onclick = () => { plStarredOnly = !plStarredOnly; $("#pl-starred").classList.toggle("on", plStarredOnly); renderPromptLib(); };
    $("#pl-add").onclick = newPrompt;
    $("#streak-flame").onclick = () => { ensurePanelOpen(); setPanelTab("insights"); renderInsights(); };
    $("#goal-ring").onclick = setGoal;

    // daily quote + random fact
    const q = QUOTES[Math.floor(Date.now() / 86400e3) % QUOTES.length];
    const sq = $("#side-quote");
    if (sq) sq.textContent = "“" + q.split("—")[0].trim().slice(0, 52) + "”";
    const fact = FACTS[Math.floor(Date.now() / 86400e3) % FACTS.length];
    const esub = $("#empty-state .empty-sub");
    if (esub) esub.textContent = esub.textContent + " · Did you know? " + fact;

    // editor toolbar
    $("#btn-file-find").onclick = openFind;
    $("#btn-file-goto").onclick = gotoLine;
    $("#btn-file-wrap").onclick = toggleWrap;
    $("#btn-file-ffs-up").onclick = () => bumpEditorFont(1);
    $("#btn-file-ffs-down").onclick = () => bumpEditorFont(-1);
    $("#btn-file-discard").onclick = discardFile;
    $("#btn-file-lock").onclick = toggleFileLock;
    $("#btn-file-dup").onclick = duplicateFile;
    $("#btn-file-move").onclick = moveFile;
    $("#btn-file-copy").onclick = copyFileContents;
    $("#btn-file-toc").onclick = showTOC;
    if (!wrapOn) { const w = editorWrap(); if (w) w.classList.add("nowrap"); }
    $("#find-input").addEventListener("input", () => { FIND.idx = -1; doFind(1); });
    $("#find-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); doFind(e.shiftKey ? -1 : 1); }
      if (e.key === "Escape") closeFind();
    });
    $("#find-next").onclick = () => doFind(1);
    $("#find-prev").onclick = () => doFind(-1);
    $("#find-close").onclick = closeFind;

    // tree tools
    $("#tree-filter").addEventListener("input", renderTree);
    $("#tree-sort").value = treeSortMode;
    $("#tree-sort").addEventListener("change", (e) => { treeSortMode = e.target.value; localStorage.setItem("cs-treesort", treeSortMode); renderTree(); });
    $("#btn-tree-favs").onclick = (e) => {
      treeFavsOnly = !treeFavsOnly;
      e.currentTarget.classList.toggle("on", treeFavsOnly);
      renderTree();
    };

    // browser nav
    $("#btn-b-back").onclick = () => bhistGo(-1);
    $("#btn-b-fwd").onclick = () => bhistGo(1);
    $("#btn-b-reload").onclick = () => { if (browserUrl) browserGo(); };
    $("#btn-b-home").onclick = () => { $("#browser-url").value = ""; browserGo(); };
    $("#btn-b-extern").onclick = () => { const u = $("#browser-url").value.trim(); if (u) window.open(u, "_blank", "noopener"); };
    $("#btn-b-history").onclick = (e) => { e.stopPropagation(); renderBrowseHistory(); $("#b-history-pop").classList.toggle("hidden"); };
    updateNavBtns();

    // insights v2
    $("#btn-ins-csv").onclick = async () => { try { insightsCSV(await api("/api/stats?days=" + ($("#ins-days").value || 14))); } catch (e) { toast(e.message, "err"); } };
    $("#btn-ins-refresh").onclick = renderInsights;

    // pomodoro
    $("#pomo-start").onclick = pomoStartPause;
    $("#pomo-reset").onclick = () => { if (POMO.tick) { clearInterval(POMO.tick); POMO.tick = null; } pomoSetMode(POMO.mode); $("#pomo-start").textContent = "Start"; };
    $("#pomo-skip").onclick = () => { if (POMO.tick) { clearInterval(POMO.tick); POMO.tick = null; } pomoSetMode(POMO.mode === "focus" ? "break" : "focus"); $("#pomo-start").textContent = "Start"; };
    $("#pomo-close").onclick = () => $("#pomo-widget").classList.add("hidden");
    pomoSetMode("focus");

    // toast history
    $("#btn-toast-history").onclick = (e) => { e.stopPropagation(); renderToastHistory(); $("#toast-history").classList.toggle("hidden"); };
    $("#th-clear").onclick = () => { TOASTS_HIST = []; localStorage.removeItem("cs-thist"); renderToastHistory(); };

    // settings
    renderAppearSettings();
    initSettingsSearch();
    initSettingsExtras();
    renderStorageMeter();
    renderCostEstimate();

    // dev + pwa
    initPWA();
    initDevConsole();

    // close lib popovers on outside click
    document.addEventListener("click", (e) => {
      if (!e.target.closest("#templates-pop") && !e.target.closest("#btn-templates")) $("#templates-pop").classList.add("hidden");
      if (!e.target.closest("#prompt-pop") && !e.target.closest("#btn-prompt-lib")) $("#prompt-pop").classList.add("hidden");
      if (!e.target.closest("#chat-menu-pop") && !e.target.closest("#btn-chat-menu")) $("#chat-menu-pop").classList.add("hidden");
      if (!e.target.closest("#b-history-pop") && !e.target.closest("#btn-b-history")) $("#b-history-pop").classList.add("hidden");
      if (!e.target.closest("#toast-history") && !e.target.closest("#btn-toast-history")) $("#toast-history").classList.add("hidden");
    });

    // version footer
    api("/api/about").then((d) => { $("#app-version").textContent = d.name + " v" + d.version; }).catch(() => {});

    renderToastHistory();

    // keyboard: wave 5
    document.addEventListener("keydown", (e) => {
      const mod = e.metaKey || e.ctrlKey;
      const tag = (document.activeElement && document.activeElement.tagName) || "";
      const typing = /INPUT|TEXTAREA|SELECT/.test(tag);
      if (konamiCheck(e.key.toLowerCase())) return;
      if (mod && e.key === "=") { e.preventDefault(); setZoom(parseFloat(localStorage.getItem("cs-zoom") || "1") + 0.1); }
      if (mod && e.key === "-") { e.preventDefault(); setZoom(parseFloat(localStorage.getItem("cs-zoom") || "1") - 0.1); }
      if (mod && e.key === "0" && !typing) { e.preventDefault(); setZoom(1); }
      if (mod && e.shiftKey && e.key.toLowerCase() === "f") { e.preventDefault(); openFind(); return; }
      if (mod && e.key.toLowerCase() === "p" && !typing) { e.preventDefault(); quickOpen(); return; }
      if (mod && e.key.toLowerCase() === "l") { e.preventDefault(); $("#composer").focus(); return; }
      if (mod && e.key.toLowerCase() === "g" && !typing) { e.preventDefault(); jumpToMessage(); return; }
      if (mod && e.key.toLowerCase() === "e" && !typing) { e.preventDefault(); openExportPop(); return; }
      if (mod && e.key.toLowerCase() === "i" && !typing) { e.preventDefault(); ensurePanelOpen(); setPanelTab("insights"); renderInsights(); return; }
      if (mod && e.key.toLowerCase() === "d" && !typing) { e.preventDefault(); duplicateFile(); return; }
      if (mod && e.key.toLowerCase() === "w" && !typing) { e.preventDefault(); comp.value = ""; autosize(comp); counts.textContent = ""; return; }
      if (mod && !typing && ["1", "2", "3", "4"].includes(e.key)) {
        e.preventDefault();
        ensurePanelOpen();
        setPanelTab(["file", "browser", "activity", "insights"][+e.key - 1]);
        if (e.key === "4") renderInsights();
        return;
      }
      if (!typing && !mod) {
        if (e.key === "f" && editorWrap() && document.activeElement !== comp) { e.preventDefault(); toggleWrap(); }
        if (e.key === "t") { e.preventDefault(); promptNewNote(); }
        if (e.key === "p") { e.preventDefault(); togglePomodoro(); }
        if (e.key === "m") { e.preventDefault(); setMute(!pref("sound")); }
        if (e.key === "[") { e.preventDefault(); stepChat(-1); }
        if (e.key === "]") { e.preventDefault(); stepChat(1); }
      }
    });

    // logo tap easter egg
    const bm = $(".brand-mark");
    if (bm) bm.addEventListener("click", logoTap);

    // night schedule + follow-OS theme
    const applyThemeAttr = (t) => {
      document.documentElement.dataset.theme = t;
      state.theme = t;
      const u = $("#btn-theme svg use");
      if (u) u.setAttribute("href", t === "dark" ? "#i-sun" : "#i-moon");
    };
    if (pref("followOs") && window.matchMedia) {
      const mq = matchMedia("(prefers-color-scheme: light)");
      const osApply = () => applyThemeAttr(mq.matches ? "light" : "dark");
      osApply();
      if (mq.addEventListener) mq.addEventListener("change", osApply);
    }
    const nightTick = () => {
      if (!pref("night")) return;
      const now = new Date();
      const [fh, fm] = String(pref("nightFrom") || "21:00").split(":").map(Number);
      const [th, tm] = String(pref("nightTo") || "07:00").split(":").map(Number);
      const mins = now.getHours() * 60 + now.getMinutes();
      const from = (fh || 0) * 60 + (fm || 0), to = (th || 0) * 60 + (tm || 0);
      const isNight = from <= to ? (mins >= from && mins < to) : (mins >= from || mins < to);
      if (isNight && document.documentElement.dataset.theme !== "dark") applyThemeAttr("dark");
    };
    nightTick();
    setInterval(nightTick, 60000);

    // goal + streak footer
    renderGoal();
    loadStreak();

    // register extra slash + palette items
    SLASH.push(...SLASH_EXTRA);
    state._paletteExtra = paletteExtra();

    // insights-explored achievement when tab opens
    const _setPanelTab = setPanelTab;
    setPanelTab = (tab) => {
      _setPanelTab(tab);
      if (tab === "insights" && !ACH._explored) {
        ACH._explored = true;
        localStorage.setItem("cs-ach", JSON.stringify(ACH));
        checkAchievements();
      }
    };

    // mood badge next to chat title
    const titleWrap = $(".chat-title-wrap");
    if (titleWrap) {
      const badge = el("span", { id: "chat-mood", title: "Chat mood — click to change" });
      badge.style.cssText = "font-size:15px;cursor:pointer;margin-left:6px";
      badge.onclick = moodPicker;
      titleWrap.append(badge);
      renderMoodBadge();
    }

    // stats-driven achievements
    api("/api/stats?days=14").then((d) => {
      if (d.streak >= 3) w5stat("streak", d.streak);
      checkAchievements();
    }).catch(() => {});
  }

  /* ---- quick open (⌘P) ---- */

  function quickOpen() {
    openPalette();
    $("#palette-input").value = "file:";
    palSel = 0;
    renderPalette();
  }

  /* ---- chat stepping ([ / ]) ---- */

  function stepChat(delta) {
    if (!state.chats.length) return;
    const idx = state.chats.findIndex((c) => c.id === (state.chat && state.chat.id));
    const ni = idx < 0 ? 0 : Math.max(0, Math.min(state.chats.length - 1, idx + delta));
    openChat(state.chats[ni].id);
  }

  /* ---- streak footer ---- */

  async function loadStreak() {
    try {
      const d = await api("/api/stats?days=30");
      const n = $("#streak-num");
      if (!n) return;
      n.textContent = d.streak;
      n.parentElement.classList.toggle("cold", d.streak < 2);
    } catch { /* server down */ }
  }

  /* ---- toast history render ---- */

  function renderToastHistory() {
    const list = $("#th-list");
    if (!list) return;
    list.innerHTML = "";
    for (const t of TOASTS_HIST.slice(0, 30)) {
      list.append(el("div", { class: "th-item" },
        el("span", { class: "th-t" }, clock(t.t)),
        el("span", null, t.msg)));
    }
    if (!TOASTS_HIST.length) list.append(el("div", { class: "search-hint" }, "No notifications yet."));
  }


  document.addEventListener("DOMContentLoaded", init);
})();
