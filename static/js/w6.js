/* ============================================================
   w6.js — MyWorkspace AI · wave 6 module (part 1/7: core)
   Self-contained: no access to app.js internals, DOM-level only.
   ============================================================ */
(function () {
  "use strict";
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => Array.from((r || document).querySelectorAll(s));
  const esc = (s) => (s == null ? "" : String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"));
  const root = document.documentElement;

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

  /* ---------------- persistent store (mwai-w6-*) ---------------- */
  const LS = {
    get(key, def) { try { const v = localStorage.getItem("mwai-w6-" + key); return v == null ? def : JSON.parse(v); } catch { return def; } },
    set(key, val) { try { localStorage.setItem("mwai-w6-" + key, JSON.stringify(val)); return true; } catch { return false; } },
  };
  const counters = LS.get("counters", {});
  function count(key, n = 1) { counters[key] = (counters[key] || 0) + n; LS.set("counters", counters); return counters[key]; }

  /* ---------------- api ---------------- */
  async function api(path, opts) {
    const r = await fetch(path, opts);
    const ct = r.headers.get("content-type") || "";
    if (r.status === 204) return null;
    if (ct.includes("json")) return r.json();
    return r.text();
  }
  function dl(name, blob) {
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
  }
  async function copy(text, msg) {
    try { await navigator.clipboard.writeText(text); toast(msg || "Copied to clipboard"); return true; }
    catch { toast("Copy failed — clipboard blocked", "err"); return false; }
  }
  const fmtB = (b) => b > 1048576 ? (b / 1048576).toFixed(1) + " MB" : b > 1024 ? (b / 1024).toFixed(1) + " KB" : b + " B";
  const fmtN = (n) => (n == null ? "—" : Number(n).toLocaleString());

  /* ---------------- toast (into existing #toasts) ---------------- */
  function toast(msg, kind = "info", opts = {}) {
    const box = $("#toasts");
    if (!box) { console.log("[w6]", msg); return; }
    const t = el("div", { class: "toast toast-" + kind + " w6-toast" },
      el("span", { class: "w6-toast-msg" }, msg));
    if (opts.action) {
      const b = el("button", { class: "w6-toast-act", onclick: () => { opts.action(); t.remove(); } }, opts.action);
      t.append(b);
    }
    box.append(t);
    requestAnimationFrame(() => t.classList.add("in"));
    const dur = (prefs.toast_ms || 4200);
    setTimeout(() => { t.classList.remove("in"); setTimeout(() => t.remove(), 300); }, dur);
  }

  /* ---------------- preferences ---------------- */
  const PREF_DEFAULTS = {
    font_size: 15, ui_font: "system", msg_font: "system", accent: "indigo",
    msg_gap: 14, line_height: 1.65, msg_max_width: 86, code_font_size: 13,
    border_radius: 10, zebra: true, wrap_words: false,
    sidebar_density: "comfortable", chat_style: "card", ts_style: "always",
    auto_scroll: true, autofocus: true, enter_sends: true,
    sound_on: false, sound_vol: 60,
    toast_pos: "bottom-right", toast_ms: 4200,
    confirm_del: true, show_tokens: true, char_count: true,
    provider_badge: false, model_badge: true, day_dividers: true,
    compact_tools: false, avatar: true, greeting: true, empty_hint: true,
    title_flash: true, status_chips: "full", clock_24h: true,
    follow_os: false, reduced_motion: false, high_contrast: false,
    highlight_links: true, spellcheck: false, focus_mode: false,
    sort_chats: "recent", msg_ts: true,
  };
  let prefs = Object.assign({}, PREF_DEFAULTS, LS.get("prefs", {}));
  window.w6prefs = prefs;
  function savePrefs() { LS.set("prefs", prefs); }
  function setPref(key, val) {
    prefs[key] = val; savePrefs(); applyPrefs(); count("pref_changes");
  }

  function applyPrefs() {
    const p = prefs;
    const st = root.style;
    st.setProperty("--w6-font-size", p.font_size + "px");
    st.setProperty("--w6-msg-gap", p.msg_gap + "px");
    st.setProperty("--w6-line-height", p.line_height);
    st.setProperty("--w6-msg-max", p.msg_max_width + "%");
    st.setProperty("--w6-code-font", p.code_font_size + "px");
    st.setProperty("--w6-radius", p.border_radius + "px");
    st.setProperty("--w6-accent", ACENTS[p.accent] || ACENTS.indigo);
    st.setProperty("--w6-font-ui", FONT_STACKS[p.ui_font]);
    st.setProperty("--w6-font-msg", FONT_STACKS[p.msg_font]);
    root.classList.toggle("w6-compact-tools", !!p.compact_tools);
    root.classList.toggle("w6-no-avatars", !p.avatar);
    root.classList.toggle("w6-no-greeting", !p.greeting);
    root.classList.toggle("w6-no-hint", !p.empty_hint);
    root.classList.toggle("w6-zebra-off", !p.zebra);
    root.classList.toggle("w6-wrap-words", !!p.wrap_words);
    root.classList.toggle("w6-chat-flat", p.chat_style === "flat");
    root.classList.toggle("w6-chat-bubble", p.chat_style === "bubble");
    root.classList.toggle("w6-ts-hover", p.ts_style === "hover");
    root.classList.toggle("w6-ts-off", p.ts_style === "off");
    root.classList.toggle("w6-compact-side", p.sidebar_density === "compact");
    root.classList.toggle("w6-reduced-motion", !!p.reduced_motion);
    root.classList.toggle("w6-high-contrast", !!p.high_contrast);
    root.classList.toggle("w6-no-links", !p.highlight_links);
    root.classList.toggle("w6-day-divs-off", !p.day_dividers);
    const t = $("#composer"); if (t) t.spellcheck = !!p.spellcheck;
  }

  const ACENTS = {
    indigo: "#6366f1", violet: "#8b5cf6", blue: "#3b82f6", cyan: "#06b6d4",
    teal: "#14b8a6", green: "#22c55e", amber: "#f59e0b", rose: "#f43f5e",
  };
  const FONT_STACKS = {
    system: "-apple-system, 'Segoe UI', Roboto, sans-serif",
    mono: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace",
    serif: "Georgia, 'Times New Roman', serif",
    rounded: "'Trebuchet MS', Verdana, sans-serif",
  };

  /* ---------------- sound engine ---------------- */
  let audioCtx = null;
  function ac() {
    if (!audioCtx) { try { audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch { return null; } }
    return audioCtx;
  }
  function beep(freq = 880, dur = 0.09, vol) {
    if (!prefs.sound_on) return;
    const c = ac(); if (!c) return;
    const g = c.createGain();
    g.gain.value = (prefs.sound_vol / 100) * 0.22 * (vol || 1);
    g.gain.exponentialRampToValueAtTime(0.0001, c.currentTime + dur);
    g.connect(c.destination);
    const o = c.createOscillator();
    o.type = "sine"; o.frequency.value = freq;
    o.connect(g); o.start(); o.stop(c.currentTime + dur);
  }
  const sfx = {
    send: () => beep(660, 0.07), reply: () => { beep(880, 0.08); setTimeout(() => beep(1175, 0.1), 90); },
    err: () => beep(220, 0.2), click: () => beep(520, 0.03, 0.5),
    done: () => { beep(784, 0.09); setTimeout(() => beep(988, 0.09), 100); setTimeout(() => beep(1175, 0.14), 200); },
  };
  let noiseNode = null, noiseType = null;
  function ambient(kind) { // "off" | "noise" | "rain"
    if (kind === noiseType) { kind = "off"; }
    const c = ac();
    if (noiseNode) { try { noiseNode.stop(); } catch {} noiseNode = null; }
    noiseType = kind;
    if (kind === "off" || !c) return "off";
    const len = c.sampleRate * 2;
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = kind === "rain" ? last * 0.97 + white * 0.03 : white * 0.35;
      d[i] = last;
    }
    const src = c.createBufferSource();
    src.buffer = buf; src.loop = true;
    const g = c.createGain(); g.gain.value = (prefs.sound_vol / 100) * (kind === "rain" ? 0.25 : 0.08);
    const f = c.createBiquadFilter();
    if (kind === "rain") { f.type = "lowpass"; f.frequency.value = 1200; f.connect(g); g.connect(c.destination); src.connect(f); }
    else { f.type = "bandpass"; f.frequency.value = 3000; f.connect(g); g.connect(c.destination); src.connect(f); }
    src.start();
    noiseNode = src;
    return kind;
  }

  /* ---------------- status bar chips ---------------- */
  const chips = {};
  function chip(id, label, title, click) {
    const c = el("span", { class: "w6-chip", title: title || label }, label);
    if (click) { c.style.cursor = "pointer"; c.onclick = click; }
    chips[id] = c;
    return c;
  }
  function buildStatusBar() {
    const left = $("#status-left"), right = $("#status-right");
    if (!left || !right) return;
    const L = el("span", { class: "w6-chips" });
    const R = el("span", { class: "w6-chips" });
    L.append(
      chip("clock", "·:·", "Local time — click for date", () => toast(new Date().toDateString())),
      chip("date", "", "Date"),
      chip("uptime", "▲ 0s", "Server uptime — click for details"),
      chip("streams", "0⚡", "Active SSE streams"),
      chip("reqs", "0↻", "Requests served this session"),
      chip("mem", "— MB", "Server memory"),
      chip("words", "0 words", "Words today"),
      chip("msgs", "0 msg", "Messages today"),
    );
    R.append(
      chip("provider", "provider", "Active provider"),
      chip("model", "model", "Active model"),
      chip("theme", "theme", "Theme — click to cycle", () => w6cycleTheme()),
      chip("offline", "", "Connection / offline mode"),
      chip("zen", "", "Mode badge (zen / focus / offline)"),
      chip("sound", "🔇", "Sound — click to toggle", () => { setPref("sound_on", !prefs.sound_on); refreshStatusChips(); toast(prefs.sound_on ? "Sound on" : "Sound off"); sfx.click(); }),
      chip("unread", "", "Unread chats — click: mark all read", markAllRead),
      chip("dev", "⌁", "Dev log — click to open", openDevLog),
    );
    left.append(L); right.append(R);
    setInterval(tickStatus, 1000);
    refreshStatusChips();
  }
  function tickStatus() {
    const d = new Date();
    const hh = String(d.getHours()).padStart(2, "0"), mm = String(d.getMinutes()).padStart(2, "0"), ss = String(d.getSeconds()).padStart(2, "0");
    if (chips.clock) {
      const h24 = prefs.clock_24h;
      const h = h24 ? d.getHours() : (d.getHours() % 12 || 12);
      const ap = h24 ? "" : (d.getHours() < 12 ? " AM" : " PM");
      chips.clock.textContent = h + ":" + mm + ap;
      chips.clock.title = h24 ? d.toTimeString() : new Date().toLocaleTimeString();
    }
    if (chips.date) chips.date.textContent = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
    const u = cache.uptime || {};
    if (chips.uptime) chips.uptime.textContent = "▲ " + fmtUp(u.uptime_s);
    if (chips.streams) chips.streams.textContent = (u.active_streams || 0) + "⚡";
    if (chips.reqs) chips.reqs.textContent = fmtN(u.requests) + "↻";
    if (chips.mem) chips.mem.textContent = (u.memory_mb != null ? Math.round(u.memory_mb) + " MB" : "— MB");
    const s = cache.stats || {};
    const t = s.today || {};
    if (chips.words) chips.words.textContent = fmtN(s.words_today != null ? s.words_today : (t.words || 0)) + " words";
    if (chips.msgs) chips.msgs.textContent = fmtN(t.msgs) + " msg";
    if (chips.unread) { const n = unreadCount(); chips.unread.textContent = n ? n + "●" : ""; chips.unread.title = n ? n + " unread — click to mark all read" : "No unread chats"; }
  }
  function fmtUp(s) {
    if (s == null) return "—";
    if (s < 90) return Math.round(s) + "s";
    if (s < 5400) return Math.round(s / 60) + "m";
    if (s < 172800) return (s / 3600).toFixed(1) + "h";
    return (s / 86400).toFixed(1) + "d";
  }
  const cache = { uptime: null, stats: null };
  async function pollStatus() {
    try { cache.uptime = await api("/api/uptime"); } catch {}
    try { cache.stats = await api("/api/stats?days=14"); } catch {}
    refreshStatusChips();
  }
  function refreshStatusChips() {
    const s = (window.W6 && window.W6.state) || {};
    const set = (id, text) => { if (chips[id]) chips[id].textContent = text; };
    if (s.provider) set("provider", s.provider);
    if (s.model) set("model", s.model.slice(0, 18));
    const theme = document.body.dataset.w6theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    set("theme", theme);
    const off = offlineMode || !navigator.onLine;
    chips.offline && chips.offline.classList.toggle("warn", !!off);
    set("offline", off ? "OFFLINE" : "");
    const mode = zenOn ? "zen" : focusOn ? "focus" : "";
    set("zen", mode);
    set("sound", prefs.sound_on ? "🔊" : "🔇");
  }

  /* ---------------- theme ---------------- */
  function w6cycleTheme() {
    const order = ["dark", "light"];
    const cur = document.body.dataset.w6theme || (matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
    const next = order[(order.indexOf(cur) + 1) % order.length];
    setW6Theme(next);
    toast("Theme: " + next);
  }
  function setW6Theme(t) {
    document.body.dataset.w6theme = t;
    document.body.classList.toggle("w6-force-light", t === "light");
    document.body.classList.toggle("w6-force-dark", t === "dark");
    localStorage.setItem("mwai-w6-theme", t);
    refreshStatusChips();
  }
  function initTheme() {
    const saved = localStorage.getItem("mwai-w6-theme");
    if (saved) { setW6Theme(saved); return; }
    if (prefs.follow_os) {
      const mq = matchMedia("(prefers-color-scheme: dark)");
      setW6Theme(mq.matches ? "dark" : "light");
      mq.addEventListener("change", (e) => setW6Theme(e.matches ? "dark" : "light"));
    }
  }

  /* ---------------- unread / archive / tags / tints (LS) ---------------- */
  let unread = LS.get("unread", {});
  let tints = LS.get("tints", {});
  let tags = LS.get("tags", {});
  function markRead(cid) { if (unread[cid]) { unread[cid] = 0; LS.set("unread", unread); refreshStatusChips(); } }
  function markUnread(cid) { unread[cid] = Date.now(); LS.set("unread", unread); refreshStatusChips(); }
  function unreadCount() { return Object.values(unread).filter(Boolean).length; }
  function markAllRead() { unread = {}; LS.set("unread", unread); refreshStatusChips(); toast("All chats marked read"); }
  function setTint(cid, c) { tints[cid] = c; LS.set("tints", tints); }
  function setTags(cid, arr) { tags[cid] = arr; LS.set("tags", tags); }
  const TINTS = ["none", "blue", "green", "amber", "rose", "violet", "cyan"];

  /* ---------------- offline / zen / focus state ---------------- */
  let offlineMode = false, zenOn = false, focusOn = false;
  function setOffline(v) {
    offlineMode = v;
    root.classList.toggle("w6-offline", v);
    const banner = $("#offline-banner");
    if (banner && v) { banner.style.display = ""; banner.textContent = "⚠ Offline mode (fake) — outgoing requests are blocked until re-enabled"; }
    refreshStatusChips();
    toast(v ? "Offline mode ON (fake)" : "Offline mode OFF", v ? "warn" : "ok");
  }
  function setZen(v) {
    zenOn = v;
    root.classList.toggle("w6-zen", v);
    refreshStatusChips();
  }
  function setFocusMode(v) {
    focusOn = v;
    root.classList.toggle("w6-focus", v);
    setPref("focus_mode", v);
    refreshStatusChips();
  }

  /* ---------------- misc shared ---------------- */
  function later(fn, ms = 350) { setTimeout(fn, ms); }
  function modal(title, node) {
    const m = $("#modal"), b = $("#modal-body"), t = $("#modal-title");
    if (!m || !b) { console.log(title, node); return; }
    if (t) t.textContent = title;
    b.innerHTML = ""; b.append(node);
    m.classList.add("open");
    const close = () => m.classList.remove("open");
    const x = $("#modal-x"); if (x) x.onclick = close;
    m.onclick = (e) => { if (e.target === m) close(); };
  }
  /* ============================================================
     part 2/7 — wave-6 settings rows + agent controls
     ============================================================ */
  const PREF_ROWS = [
    { id: "font_size", label: "Base font size", hint: "UI base size in px", type: "range", min: 12, max: 20, step: 1, unit: "px" },
    { id: "code_font_size", label: "Code font size", hint: "Code blocks & inline code", type: "range", min: 10, max: 18, step: 1, unit: "px" },
    { id: "msg_gap", label: "Message spacing", hint: "Vertical gap between messages", type: "range", min: 6, max: 30, step: 2, unit: "px" },
    { id: "line_height", label: "Line height", hint: "Text line-height in messages", type: "range", min: 1.4, max: 2, step: 0.05, unit: "" },
    { id: "msg_max_width", label: "Message max width", hint: "Readable column width", type: "range", min: 50, max: 100, step: 2, unit: "%" },
    { id: "border_radius", label: "Corner radius", hint: "Rounded corners everywhere", type: "range", min: 0, max: 16, step: 1, unit: "px" },
    { id: "ui_font", label: "UI font", hint: "Chips, panels, sidebar", type: "sel", options: [["system", "System"], ["mono", "Monospace"], ["serif", "Serif"], ["rounded", "Rounded"]] },
    { id: "msg_font", label: "Message font", hint: "Chat bubble font", type: "sel", options: [["system", "System"], ["mono", "Monospace"], ["serif", "Serif"]] },
    { id: "accent", label: "Accent color", hint: "Buttons, highlights, links", type: "swatches" },
    { id: "chat_style", label: "Message style", hint: "How bubbles render", type: "sel", options: [["card", "Card"], ["flat", "Flat"], ["bubble", "Bubble"]] },
    { id: "ts_style", label: "Timestamps", hint: "Message time labels", type: "sel", options: [["always", "Always"], ["hover", "On hover"], ["off", "Off"]] },
    { id: "msg_ts", label: "Show HH:MM", hint: "Time on each message", type: "chk" },
    { id: "sidebar_density", label: "Sidebar density", hint: "Chat list & tree spacing", type: "sel", options: [["comfortable", "Comfortable"], ["compact", "Compact"]] },
    { id: "wrap_words", label: "Wrap long words", hint: "Break unbreakable lines", type: "chk" },
    { id: "zebra", label: "Zebra tables", hint: "Striped markdown tables", type: "chk" },
    { id: "compact_tools", label: "Compact tool cards", hint: "One-line tool results", type: "chk" },
    { id: "avatar", label: "Avatars", hint: "Model avatar chips", type: "chk" },
    { id: "greeting", label: "Greeting line", hint: "Per-chat greeting", type: "chk" },
    { id: "empty_hint", label: "Empty-chat hint", hint: "Suggestion text on new chats", type: "chk" },
    { id: "day_dividers", label: "Day dividers", hint: "Separate messages by day", type: "chk" },
    { id: "highlight_links", label: "Highlight links", hint: "Underline + color links", type: "chk" },
    { id: "auto_scroll", label: "Auto-scroll", hint: "Follow new tokens", type: "chk" },
    { id: "autofocus", label: "Input auto-focus", hint: "Focus composer on open", type: "chk" },
    { id: "enter_sends", label: "Enter sends", hint: "Enter=send, Shift+Enter=newline", type: "chk" },
    { id: "char_count", label: "Char counter", hint: "Live count under composer", type: "chk" },
    { id: "show_tokens", label: "Token usage", hint: "Per-message token counts", type: "chk" },
    { id: "provider_badge", label: "Provider badge", hint: "Show provider on messages", type: "chk" },
    { id: "model_badge", label: "Model badge", hint: "Show model chip", type: "chk" },
    { id: "confirm_del", label: "Confirm destructive", hint: "Ask before delete/archive", type: "chk" },
    { id: "toast_ms", label: "Toast duration", hint: "How long toasts stay", type: "range", min: 2000, max: 10000, step: 500, unit: "ms" },
    { id: "toast_pos", label: "Toast position", hint: "Where toasts appear", type: "sel", options: [["bottom-right", "Bottom right"], ["top-right", "Top right"], ["top-center", "Top center"]] },
    { id: "sound_on", label: "Sound effects", hint: "Beeps on send/reply/error", type: "chk" },
    { id: "sound_vol", label: "Sound volume", hint: "Effect volume", type: "range", min: 0, max: 100, step: 5, unit: "%" },
    { id: "title_flash", label: "Title flash", hint: "Flash tab title on reply", type: "chk" },
    { id: "clock_24h", label: "24h clock", hint: "Status-bar clock format", type: "chk" },
    { id: "follow_os", label: "Follow OS theme", hint: "Light/dark from system", type: "chk" },
    { id: "reduced_motion", label: "Reduce motion", hint: "Minimize animations", type: "chk" },
    { id: "high_contrast", label: "High contrast", hint: "Stronger text/borders", type: "chk" },
    { id: "spellcheck", label: "Spellcheck input", hint: "Browser spellcheck on composer", type: "chk" },
    { id: "focus_mode", label: "Focus mode", hint: "Hide chrome, big composer", type: "chk" },
    { id: "sort_chats", label: "Chat sort", hint: "Sidebar chat order", type: "sel", options: [["recent", "Recent"], ["name", "Name"], ["tint", "Color"]] },
    { id: "status_chips", label: "Status bar", hint: "Widget density", type: "sel", options: [["full", "Full"], ["compact", "Compact"], ["minimal", "Minimal"]] },
  ];

  function settingsSection(id, title, hint, rows) {
    const sec = el("section", { class: "set-section w6-set-section" },
      el("h3", { class: "set-h" }, title),
      el("p", { class: "set-sub" }, hint));
    rows.forEach((r) => sec.append(settingRow(r)));
    return sec;
  }
  function settingRow(def) {
    const wrap = el("div", { class: "w6-row", "data-w6pref": def.id });
    const head = el("div", { class: "w6-row-head" }, el("label", {}, def.label),
      el("span", { class: "w6-row-hint" }, def.hint));
    wrap.append(head);
    const ctl = el("div", { class: "w6-row-ctl" });
    const apply = (v) => setPref(def.id, v);
    if (def.type === "range") {
      const val = el("span", { class: "w6-range-val" });
      const inp = el("input", { type: "range", min: def.min, max: def.max, step: def.step,
        oninput: () => { apply(parseFloat(inp.value)); val.textContent = inp.value + (def.unit || ""); } });
      inp.value = prefs[def.id]; val.textContent = prefs[def.id] + (def.unit || "");
      ctl.append(inp, val);
    } else if (def.type === "sel") {
      const sel = el("select", { onchange: () => apply(sel.value) });
      def.options.forEach(([v, l]) => sel.append(el("option", { value: v, selected: String(prefs[def.id]) === v }, l)));
      ctl.append(sel);
    } else if (def.type === "chk") {
      const cb = el("input", { type: "checkbox", onchange: () => apply(cb.checked) });
      cb.checked = !!prefs[def.id];
      ctl.append(cb);
    } else if (def.type === "swatches") {
      const sw = el("div", { class: "w6-swatches" });
      Object.entries(ACENTS).forEach(([name, hex]) => {
        const b = el("button", { class: "w6-swatch" + (prefs.accent === name ? " on" : ""), style: "background:" + hex,
          title: name, onclick: () => { $$(".w6-swatch", sw).forEach((x) => x.classList.remove("on")); b.classList.add("on"); apply(name); } });
        sw.append(b);
      });
      ctl.append(sw);
    }
    wrap.append(ctl);
    return wrap;
  }
  function buildSettings() {
    const anchor = $("#set-custom-css");
    if (!anchor) return;
    let section = anchor.closest("section") || anchor.parentElement;
    const host = section && section.parentElement ? section : $("#view-settings");
    const a1 = settingsSection("w6-sec-look", "Appearance · wave 6", "Fine-grained visual controls — all live, all saved.",
      PREF_ROWS.filter((r) => ["font_size", "code_font_size", "msg_gap", "line_height", "msg_max_width", "border_radius", "ui_font", "msg_font", "accent", "chat_style", "ts_style", "msg_ts", "sidebar_density", "wrap_words", "zebra", "compact_tools", "avatar", "greeting", "empty_hint", "day_dividers", "highlight_links", "high_contrast", "reduced_motion"].includes(r.id)));
    const a2 = settingsSection("w6-sec-beh", "Behavior · wave 6", "Composer, scrolling, sounds, toasts, keyboard.",
      PREF_ROWS.filter((r) => ["auto_scroll", "autofocus", "enter_sends", "char_count", "show_tokens", "provider_badge", "model_badge", "confirm_del", "toast_ms", "toast_pos", "sound_on", "sound_vol", "title_flash", "clock_24h", "follow_os", "spellcheck", "focus_mode", "sort_chats", "status_chips"].includes(r.id)));
    host.insertBefore(a1, section && section.nextSibling && section !== host ? section.nextSibling : null);
    host.insertBefore(a2, a1.nextSibling);
    buildAgentSection(host, a2.nextSibling);
  }

  /* ---------------- agent controls (15) ---------------- */
  const SP_PRESETS = {
    "Concise": "You are MyWorkspace AI. Answer in as few words as possible. No filler, no preamble, no closing remarks. Use Markdown only when it helps.",
    "Verbose": "You are MyWorkspace AI. Be thorough and explanatory. Show your reasoning step by step. Cover edge cases. It is fine to be long.",
    "Coder": "You are MyWorkspace AI, a senior software engineer. Prioritize correctness, tests, and idiomatic code. Use your file tools proactively to read and write code in the workspace.",
    "Teacher": "You are MyWorkspace AI, a patient tutor. Explain concepts from first principles, give small examples, and ask a checking question at the end of long explanations.",
    "Friendly": "You are MyWorkspace AI, a warm and encouraging assistant. Keep it light and human, but stay accurate. Celebrate small wins.",
    "Strict": "You are MyWorkspace AI. You never speculate: state confidence, cite the source of every factual claim, and refuse gracefully when you do not know.",
  };
  function buildAgentSection(host, afterEl) {
    const sec = settingsSection("w6-sec-agent", "Agent controls · wave 6",
      "Prompt presets, tokens, temperature and safety — applied straight to the server.", []);
    sec.append(agentRow("System prompt preset", "Replace the system prompt", () => {
      const sel = el("select", { onchange: () => {
        const p = sel.value;
        if (!p) { toast("Prompt preset reset (custom)", "info"); return; }
        putSettings({ system_prompt: SP_PRESETS[p] }).then(() => toast("Prompt preset: " + p));
      } }, el("option", { value: "" }, "— custom (unchanged) —"),
      ...Object.keys(SP_PRESETS).map((k) => el("option", { value: k }, k)));
      return sel;
    }));
    sec.append(agentRow("Style addendum", "Appended to the system prompt (saved locally)", () => {
      const ta = el("textarea", { rows: "2", placeholder: "e.g. Always answer in bullet points.",
        oninput: () => debounceApplyAddendum(ta.value) });
      ta.value = LS.get("addendum", "");
      return ta;
    }));
    sec.append(agentRow("Max tokens · quick set", "Cap per response", () => {
      const box = el("div", { class: "w6-chip-row" });
      [1024, 4096, 8192].forEach((n) => box.append(el("button", { class: "w6-chip-btn", onclick: () => putSettings({ max_tokens: n }).then(() => toast("max_tokens = " + n)) }, String(n))));
      return box;
    }));
    sec.append(agentRow("Temperature · quick set", "0 = deterministic", () => {
      const box = el("div", { class: "w6-chip-row" });
      [[0, "0 · exact"], [0.5, "0.5"], [0.8, "0.8"], [1, "1 · wild"]].forEach(([v, l]) =>
        box.append(el("button", { class: "w6-chip-btn", onclick: () => putSettings({ temperature: v }).then(() => toast("temperature = " + v)) }, l)));
      return box;
    }));
    sec.append(agentRow("Deterministic mode", "One click: temperature 0, max steps 6", () =>
      el("button", { class: "w6-chip-btn", onclick: () => putSettings({ temperature: 0, max_steps: 6 }).then(() => toast("Deterministic mode ON")) }, "Enable")));
    sec.append(agentRow("Echo mode", "Provider=demo, instant canned replies", () =>
      el("button", { class: "w6-chip-btn", onclick: () => putSettings({ provider: "demo" }).then(() => toast("Echo mode (demo provider) ON")) }, "Enable")));
    sec.append(agentRow("Strict safety", "Approve every tool call, even auto-approved", () => {
      const cb = el("input", { type: "checkbox" });
      return el("label", { class: "w6-lab" }, "strict_approve: ", cb, " — saved on change",
        el("span", { html: "&nbsp;" }, (cb.addEventListener("change", () => putSettings({ strict_approve: cb.checked }).then(() => toast("strict_approve = " + cb.checked))))));
    }));
    sec.append(agentRow("Offline mode (fake)", "Block outgoing chat; badge in status bar", () =>
      el("button", { class: "w6-chip-btn", onclick: () => setOffline(!offlineMode) }, "Toggle")));
    sec.append(agentRow("Zen mode", "Hide all chrome for deep work", () =>
      el("button", { class: "w6-chip-btn", onclick: () => { setZen(!zenOn); toast(zenOn ? "Zen ON" : "Zen OFF"); } }, "Toggle")));
    sec.append(agentRow("Focus mode", "Minimal sidebar, large composer", () =>
      el("button", { class: "w6-chip-btn", onclick: () => { setFocusMode(!focusOn); } }, "Toggle")));
    sec.append(agentRow("Verbose tool results", "Show tool arguments in cards", () => {
      const cb = el("input", { type: "checkbox", checked: String(LS.get("verbose_tools", "")) === "1",
        onchange: () => { LS.set("verbose_tools", cb.checked ? "1" : ""); toast("Verbose tools " + (cb.checked ? "on" : "off")); } });
      return cb;
    }));
    sec.append(agentRow("Ambient sound", "White noise / rain / off", () => {
      const box = el("div", { class: "w6-chip-row" });
      ["off", "noise", "rain"].forEach((k) => box.append(el("button", { class: "w6-chip-btn", onclick: () => { const on = ambient(k); toast("Ambient: " + on); } }, k)));
      return box;
    }));
    sec.append(agentRow("Settings presets (server)", "One-click bundles", () => {
      const box = el("div", { class: "w6-chip-row" });
      [["local-first", "Local-first"], ["cautious", "Cautious"], ["turbo", "Turbo"], ["cloud-power", "Cloud power"]].forEach(([n, l]) =>
        box.append(el("button", { class: "w6-chip-btn", onclick: () => api("/api/settings/preset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }).then(() => toast("Preset applied: " + l)) }, l)));
      return box;
    }));
    sec.append(agentRow("Style addendum (live)", "What is currently appended", () => {
      const d = el("div", { class: "w6-addendum-view" }, esc(LS.get("addendum", "")) || "(none)");
      return d;
    }));
    host.insertBefore(sec, afterEl);
    later(() => {
      api("/api/settings").then((s) => {
        const sa = $("#w6-addendum-view");
        if (sa) sa.textContent = LS.get("addendum", "") || "(none)";
        stateLike.provider = s.provider;
        const mb = $("#model-badge-text");
        if (mb) stateLike.model = mb.textContent;
      }).catch(() => {});
    }, 800);
  }
  const stateLike = { provider: "demo", model: "" };
  function agentRow(label, hint, controlFactory) {
    const wrap = el("div", { class: "w6-row w6-agent-row" },
      el("div", { class: "w6-row-head" }, el("label", {}, label), el("span", { class: "w6-row-hint" }, hint)));
    const ctl = el("div", { class: "w6-row-ctl" });
    ctl.append(controlFactory());
    wrap.append(ctl);
    return wrap;
  }
  let addendumTimer = null;
  function debounceApplyAddendum(v) {
    LS.set("addendum", v);
    const d = $("#w6-addendum-view"); if (d) d.textContent = v || "(none)";
    clearTimeout(addendumTimer);
    addendumTimer = setTimeout(() => applyAddendum(), 900);
  }
  async function applyAddendum() {
    const base = await api("/api/settings").catch(() => null);
    if (!base) return;
    const basePrompt = (base.system_prompt || "").replace(/\n\[style\].*$/, "");
    const add = LS.get("addendum", "").trim();
    const prompt = add ? basePrompt + "\n[style] " + add : basePrompt;
    await putSettings({ system_prompt: prompt });
    toast("Style addendum applied to system prompt");
  }
  async function putSettings(patch) {
    return api("/api/settings", { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(patch) });
  }
  /* ============================================================
     part 3/7 — chat sidebar, chat menu, message actions
     ============================================================ */
  const w6Chats = new Map(); // id -> {title, updated_at, pin, model, provider}
  async function refreshChatMap() {
    try {
      const d = await api("/api/chats");
      w6Chats.clear();
      (d.chats || []).forEach((c) => w6Chats.set(c.id, c));
      decorateChatList();
    } catch {}
  }
  function currentChatId() {
    const item = $("#chat-list .chat-item.active");
    if (!item) return null;
    const t = item.querySelector(".ci-title")?.textContent?.trim();
    for (const [id, c] of w6Chats) if (c.title === t) return id;
    return item.dataset.w6id || null;
  }

  function buildChatHead() {
    const head = $("#sec-chats-head");
    if (!head || $("#w6-chat-seg")) return;
    const seg = el("div", { class: "w6-seg", id: "w6-chat-seg" });
    const mode = LS.get("chatview", "all");
    ["all", "active", "archived"].forEach((m) => {
      const b = el("button", { class: "w6-seg-b" + (mode === m ? " on" : ""), "data-w6mode": m,
        onclick: () => { $$(".w6-seg-b", seg).forEach((x) => x.classList.remove("on")); b.classList.add("on"); LS.set("chatview", m); decorateChatList(); } },
        m === "all" ? "All" : m === "active" ? "Live" : "Archived");
      seg.append(b);
    });
    const mr = el("button", { class: "w6-icon-btn", title: "Mark all read", onclick: markAllRead }, "✓");
    const imp = el("input", { type: "file", accept: ".json", style: "display:none",
      onchange: (e) => importChatJson(e.target.files[0]) });
    head.append(seg, mr, imp);
    const ib = el("button", { class: "w6-icon-btn", title: "Import chat JSON", onclick: () => imp.click() }, "⇪");
    head.append(ib);
    const tagf = el("input", { class: "w6-tagfilter", placeholder: "filter #tag",
      oninput: () => { LS.set("tagfilter", tagf.value); decorateChatList(); } });
    tagf.value = LS.get("tagfilter", "");
    head.append(tagf);
  }

  function decorateChatList() {
    const mode = LS.get("chatview", "all");
    const tagf = (LS.get("tagfilter", "") || "").toLowerCase();
    const q = ($("#chat-filter")?.value || "").toLowerCase();
    const sort = prefs.sort_chats;
    let items = $$("#chat-list .chat-item");
    if (sort === "name") {
      const list = $("#chat-list");
      items.slice().sort((a, b) => (a.querySelector(".ci-title")?.textContent || "").localeCompare(b.querySelector(".ci-title")?.textContent || "")).forEach((n) => list.append(n));
      items = $$("#chat-list .chat-item");
    }
    items.forEach((item) => {
      const t = item.querySelector(".ci-title")?.textContent?.trim() || "";
      let cid = null;
      for (const [id, c] of w6Chats) if (c.title === t) { cid = id; break; }
      item.dataset.w6id = cid || "";
      // unread dot
      let dot = item.querySelector(".w6-und");
      const isUnread = cid && unread[cid];
      if (isUnread && !dot) { dot = el("span", { class: "w6-und", title: "Unread" }); item.prepend(dot); }
      else if (!isUnread && dot) dot.remove();
      // tint bar
      const tint = cid ? tints[cid] : "none";
      item.classList.remove("w6-tint-blue", "w6-tint-green", "w6-tint-amber", "w6-tint-rose", "w6-tint-violet", "w6-tint-cyan");
      if (tint && tint !== "none") item.classList.add("w6-tint-" + tint);
      // tag chip
      const tg = cid ? tags[cid] || [] : [];
      let chip = item.querySelector(".w6-chip-tags");
      if (tg.length && !chip) {
        chip = el("span", { class: "w6-chip-tags", title: "Tags — click chat menu to edit" }, tg.slice(0, 2).map((x) => "#" + x).join(" ") + (tg.length > 2 ? "…" : ""));
        item.append(chip);
      } else if ((!tg.length) && chip) chip.remove();
      // model chip (short)
      let mc = item.querySelector(".w6-chip-model");
      const mdl = cid && w6Chats.get(cid).model;
      if (mc) mc.remove();
      if (mdl && prefs.model_badge) {
        mc = el("span", { class: "w6-chip-model", title: mdl }, mdl.split("/").pop().slice(0, 14));
        item.append(mc);
      }
      // relative time
      let rt = item.querySelector(".w6-rel");
      const up = cid ? w6Chats.get(cid).updated_at : null;
      if (rt) rt.remove();
      if (up) {
        rt = el("span", { class: "w6-rel", title: new Date(up).toLocaleString() }, relW6(up));
        item.append(rt);
      }
      // archive filter visibility
      const archived = cid && LS.get("arch-" + cid, false);
      let hide = false;
      if (mode === "active" && archived) hide = true;
      if (mode === "archived" && !archived) hide = true;
      if (tagf && !tg.some((x) => ("#" + x.toLowerCase()).includes(tagf) || x.toLowerCase().includes(tagf))) hide = true;
      if (q && !t.toLowerCase().includes(q)) hide = true;
      item.style.display = hide ? "none" : "";
    });
  }
  const relW6 = (ms) => {
    const d = Date.now() - ms;
    if (d < 60000) return "now";
    if (d < 3600000) return Math.round(d / 60000) + "m";
    if (d < 86400000) return Math.round(d / 3600000) + "h";
    if (d < 604800000) return Math.round(d / 86400000) + "d";
    return new Date(ms).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  };

  function initChatClicks() {
    const list = $("#chat-list");
    if (!list) return;
    list.addEventListener("click", (e) => {
      const item = e.target.closest(".chat-item");
      if (!item) return;
      const cid = item.dataset.w6id;
      if (cid) { markRead(cid); }
    });
    new MutationObserver(() => decorateChatList()).observe(list, { childList: true, subtree: true });
    setInterval(decorateChatList, 30000);
    setInterval(refreshChatMap, 60000);
  }

  /* ---------------- chat menu extension ---------------- */
  function buildChatMenuItems() {
    const pop = $("#chat-menu-pop");
    if (!pop) return;
    const mk = (label, icon, fn) => el("button", { class: "w6-cm-item", onclick: fn }, icon + " " + label);
    const items = el("div", { class: "w6-cm-group", id: "w6-cm-items" });
    const push = (node) => { items.append(el("div", { class: "w6-cm-sep" }), node); };
    push(mk("Archive / unarchive", "🗄", () => {
      const cid = currentChatId(); if (!cid) return;
      const on = !LS.get("arch-" + cid, false);
      if (on && prefs.confirm_del) { toast("Archive this chat?", "warn", { action: () => doArchive(cid, true) }); return; }
      doArchive(cid, on);
    }));
    push(mk("Copy as text", "📋", () => copyChatText()));
    push(mk("Copy as JSON", "🧾", () => copyChatJson()));
    push(mk("Export chat JSON", "⬇", () => exportChatJson()));
    push(mk("Pin / unpin", "📌", () => togglePin()));
    push(mk("Rename", "✏️", () => {
      const cid = currentChatId(); if (!cid) return;
      const c = w6Chats.get(cid);
      const nt = prompt("New title:", c ? c.title : "");
      if (nt) api("/api/chats/" + cid + "/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: nt }) }).then(() => { toast("Renamed"); refreshChatMap(); }).catch(() => toast("Rename failed", "err"));
    }));
    push(el("div", { class: "w6-cm-tintrow" }, el("span", {}, "Tint"), ...TINTS.map((t) =>
      el("button", { class: "w6-swatch w6-menu-swatch" + (t === "none" ? "" : " tint-" + t), title: t,
        style: t === "none" ? "" : "background:var(--w6-tint-" + t + ")" ,
        onclick: () => { const cid = currentChatId(); if (cid) { setTint(cid, t); decorateChatList(); toast("Tint: " + t); } } }))));
    push(el("div", { class: "w6-cm-tagrow" },
      el("input", { id: "w6-cm-tagin", placeholder: "tags, comma, separated" }),
      el("button", { class: "w6-chip-btn", onclick: () => {
        const cid = currentChatId(); if (!cid) return;
        const arr = $("#w6-cm-tagin").value.split(",").map((x) => x.trim().replace(/^#/, "")).filter(Boolean).slice(0, 6);
        setTags(cid, arr); decorateChatList(); toast("Tags: " + (arr.join(", ") || "(none)"));
      } }, "Save")));
    pop.append(items);
    const tagIn = $("#w6-cm-tagin");
    new MutationObserver(() => {
      const cid = currentChatId();
      if (tagIn && cid) tagIn.value = (tags[cid] || []).join(", ");
    }).observe(pop, { childList: true, subtree: true });
  }
  async function doArchive(cid, on) {
    try {
      await api("/api/chats/" + cid + "/archive", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ archived: on }) });
      LS.set("arch-" + cid, on);
      toast(on ? "Chat archived" : "Chat unarchived");
      count("archive");
      refreshChatMap();
    } catch { toast("Archive failed", "err"); }
  }
  function chatContent() {
    const cid = currentChatId();
    if (!cid) return null;
    const c = w6Chats.get(cid);
    return { cid, title: c ? c.title : "chat" };
  }
  async function copyChatText() {
    const { cid, title } = chatContent() || {};
    if (!cid) return toast("No chat selected", "err");
    try {
      const d = await api("/api/chats/" + cid);
      const lines = (d.messages || []).map((m) => (m.role === "user" ? "You: " : "AI: ") + (m.content || ""));
      await copy("— " + title + " —\n\n" + lines.join("\n\n"), "Chat copied as text");
      count("copy_chat");
    } catch { toast("Copy failed", "err"); }
  }
  async function copyChatJson() {
    const { cid } = chatContent() || {};
    if (!cid) return toast("No chat selected", "err");
    try {
      const d = await api("/api/chats/" + cid);
      await copy(JSON.stringify(d, null, 2), "Chat copied as JSON");
      count("copy_chat");
    } catch { toast("Copy failed", "err"); }
  }
  async function exportChatJson() {
    const { cid, title } = chatContent() || {};
    if (!cid) return toast("No chat selected", "err");
    try {
      const r = await fetch("/api/chats/" + cid + "/export/json");
      const blob = await r.blob();
      dl(title.replace(/\s+/g, "-").toLowerCase() + ".chat.json", blob);
      toast("Chat JSON exported");
      count("export");
    } catch { toast("Export failed", "err"); }
  }
  function importChatJson(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = async () => {
      try {
        const d = JSON.parse(fr.result);
        const chat = d.chat || {};
        const msgs = d.messages || [];
        const created = await api("/api/chats", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: chat.title || file.name.replace(/\.chat\.json$/, "") }) });
        for (const m of msgs) {
          await api("/api/chats/" + created.id + "/messages", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ role: m.role, content: m.content, provider: m.provider, model: m.model }) }).catch(() => {});
        }
        toast("Imported chat with " + msgs.length + " messages");
        count("import");
        later(() => { refreshChatMap().then(() => openChatByTitle(chat.title || file.name.replace(/\.chat\.json$/, ""))); }, 400);
      } catch (err) { toast("Import failed: " + err.message, "err"); }
    };
    fr.readAsText(file);
  }
  async function togglePin() {
    const cid = currentChatId(); if (!cid) return;
    const c = w6Chats.get(cid);
    try {
      await api("/api/chats/" + cid + "/pin", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pin: !(c && c.pin) }) });
      toast(c && c.pin ? "Unpinned" : "Pinned");
      refreshChatMap();
    } catch { toast("Pin failed", "err"); }
  }
  function nextUnread(delta = 1) {
    const ids = Object.keys(unread).filter((k) => unread[k]);
    if (!ids.length) return toast("No unread chats");
    const cur = currentChatId();
    const idx = cur ? ids.indexOf(cur) : -1;
    const next = ids[(idx + delta + ids.length) % ids.length];
    const c = w6Chats.get(next);
    if (c) openChatByTitle(c.title); else toast("Chat list stale", "warn");
  }

  /* ---------------- message hover actions ---------------- */
  function initMsgActions() {
    const list = $("#msg-list");
    if (!list) return;
    list.addEventListener("mouseover", (e) => {
      const msg = e.target.closest(".msg");
      if (!msg || msg.querySelector(".w6-msg-tools") || msg.classList.contains("streaming")) return;
      const bar = el("div", { class: "w6-msg-tools" },
        mkBtn("Copy", "📋", () => { const b = msg.querySelector(".md"); copy(b ? b.innerText : "", "Message copied"); count("copy_msg"); }),
        mkBtn("Copy JSON", "🧾", () => { const b = msg.querySelector(".md"); copy(JSON.stringify({ role: msg.classList.contains("user") ? "user" : "assistant", content: b ? b.innerText : "" }, null, 2), "Copied as JSON"); }),
        mkBtn("Retry", "↻", retryLast),
        mkBtn("Regenerate", "⟳", regenerate),
      );
      msg.append(bar);
    });
    list.addEventListener("mouseout", (e) => {
      const msg = e.target.closest(".msg");
      if (msg && !msg.contains(e.relatedTarget)) {
        const bar = msg.querySelector(".w6-msg-tools");
        if (bar) setTimeout(() => { if (!msg.matches(":hover")) bar.remove(); }, 250);
      }
    });
  }
  function mkBtn(label, icon, fn) {
    return el("button", { class: "w6-mini-btn", title: label, onclick: fn }, icon);
  }
  let lastUserMsg = null;
  function initLastMsgTracker() {
    const list = $("#msg-list");
    if (!list) return;
    new MutationObserver(() => {
      const users = $$("#msg-list .msg.user");
      lastUserMsg = users.length ? users[users.length - 1] : null;
    }).observe(list, { childList: true, subtree: true });
  }
  function retryLast() {
    if (!lastUserMsg) return toast("Nothing to retry", "warn");
    const t = lastUserMsg.querySelector(".md")?.innerText || "";
    if (!t) return;
    const comp = $("#composer");
    if (comp) { comp.value = t; comp.dispatchEvent(new Event("input", { bubbles: true })); comp.focus(); toast("Last prompt restored — hit send"); }
    else toast("Composer not found", "err");
    count("retry");
  }
  function regenerate() {
    const send = $("#btn-send");
    if (!send) return toast("No send button", "err");
    const comp = $("#composer");
    if (comp && !comp.value.trim()) {
      // resubmit last user message
      const t = lastUserMsg ? lastUserMsg.querySelector(".md")?.innerText : "";
      if (!t) return toast("Nothing to regenerate", "warn");
      comp.value = t;
      comp.dispatchEvent(new Event("input", { bubbles: true }));
    }
    send.click();
    count("regen");
  }

  function openChatByTitle(title) {
    const items = $$("#chat-list .chat-item");
    const hit = items.find((n) => n.querySelector(".ci-title")?.textContent?.trim() === title);
    if (hit) hit.click();
    else { const t = $("#chat-filter"); if (t) { t.value = title; t.dispatchEvent(new Event("input", { bubbles: true })); } }
  }
  /* ============================================================
     part 4/7 — composer text operations + composer behavior
     ============================================================ */
  const TEXT_OPS = [
    { id: "upper", label: "UPPERCASE", icon: "AA", fn: (s) => s.toUpperCase() },
    { id: "lower", label: "lowercase", icon: "aa", fn: (s) => s.toLowerCase() },
    { id: "cap", label: "Capitalize words", icon: "Aa", fn: (s) => s.replace(/\b\w/g, (c) => c.toUpperCase()) },
    { id: "sentence", label: "Sentence case", icon: "A.", fn: (s) => s.toLowerCase().replace(/(^\s*\w|[.!?]\s+\w)/g, (c) => c.toUpperCase()) },
    { id: "title", label: "Title Case", icon: "Tc", fn: (s) => s.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()) },
    { id: "reverse", label: "Reverse chars", icon: "⇄", fn: (s) => [...s].reverse().join("") },
    { id: "revlines", label: "Reverse lines", icon: "⇅", fn: (s) => s.split("\n").reverse().join("\n") },
    { id: "shuffle", label: "Shuffle words", icon: "🎲", fn: (s) => s.split("\n").map((l) => l.split(/\s+/).sort(() => Math.random() - 0.5).join(" ")).join("\n") },
    { id: "sortwords", label: "Sort words A→Z", icon: "A-Z", fn: (s) => s.split("\n").map((l) => l.split(/\s+/).sort().join(" ")).join("\n") },
    { id: "dedupwords", label: "Dedupe words", icon: "Aa−", fn: (s) => s.split("\n").map((l) => [...new Set(l.split(/\s+/))].join(" ")).join("\n") },
    { id: "deduplines", label: "Dedupe lines", icon: "≠", fn: (s) => [...new Set(s.split("\n"))].join("\n") },
    { id: "trimlines", label: "Trim lines", icon: "✂", fn: (s) => s.split("\n").map((l) => l.trim()).join("\n") },
    { id: "noblanks", label: "Remove blank lines", icon: "⊘", fn: (s) => s.split("\n").filter((l) => l.trim()).join("\n") },
    { id: "numlines", label: "Number lines", icon: "123", fn: (s) => s.split("\n").map((l, i) => (i + 1) + ". " + l).join("\n") },
    { id: "bullets", label: "Bullet lines", icon: "•", fn: (s) => s.split("\n").filter((l) => l.trim()).map((l) => "- " + l.trim()).join("\n") },
    { id: "checklist", label: "Toggle checklist", icon: "☑", fn: (s) => s.split("\n").map((l) => l.trim().startsWith("- [x] ") ? "- [ ] " + l.slice(6) : l.trim().startsWith("- [ ] ") ? "- [x] " + l.slice(6) : "- [ ] " + l.trim()).join("\n") },
    { id: "code", label: "Inline `code`", icon: "‹›", wrap: "`", fn: null },
    { id: "codeblock", label: "Code block", icon: "{ }", wrap: "```\\n", wrapEnd: "\\n```", fn: null },
    { id: "bold", label: "**Bold**", icon: "B", wrap: "**", fn: null },
    { id: "ital", label: "*Italic*", icon: "I", wrap: "*", fn: null },
    { id: "strike", label: "~~Strike~~", icon: "S", wrap: "~~", fn: null },
    { id: "link", label: "[link](url)", icon: "🔗", fn: (s) => "[" + s + "](https://)" },
    { id: "quote", label: "> Quote", icon: "❝", fn: (s) => s.split("\n").map((l) => "> " + l).join("\n") },
    { id: "table", label: "Lines → table", icon: "▦", fn: (s) => { const rows = s.split("\n").filter((l) => l.trim()).map((l) => l.split(/[|,;]\s*/)); const w = rows[0] ? rows[0].length : 1; const out = rows.map((r) => "| " + [...Array(w)].map((_, i) => (r[i] || "")).join(" | ") + " |"); out.splice(1, 0, "| " + [...Array(w)].map(() => "---").join(" | ") + " |"); return out.join("\n"); } },
    { id: "csv", label: "Lines → CSV", icon: ",", fn: (s) => s.split("\n").map((l) => l.split(/\s*\|\s*/).map((c) => '"' + c.replace(/"/g, '""') + '"').join(",")).join("\n") },
    { id: "camel", label: "camelCase", icon: "cC", fn: (s) => s.toLowerCase().split(/[\s_\-]+/).map((w, i) => i ? w[0].toUpperCase() + w.slice(1) : w).join("") },
    { id: "snake", label: "snake_case", icon: "s_c", fn: (s) => s.trim().replace(/\s+/g, "_").replace(/-/g, "_").toLowerCase() },
    { id: "kebab", label: "kebab-case", icon: "k-c", fn: (s) => s.trim().replace(/\s+/g, "-").replace(/_/g, "-").toLowerCase() },
    { id: "scream", label: "SCREAMING_SNAKE", icon: "S_S", fn: (s) => s.trim().toUpperCase().replace(/\s+/g, "_").replace(/-/g, "_") },
    { id: "slug", label: "slugify", icon: "/", fn: (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") },
    { id: "nomd", label: "Strip markdown", icon: "MD×", fn: (s) => s.replace(/```[\s\S]*?```/g, (m) => m.replace(/```/g, "")).replace(/[*_~`>#|[\]()!-]/g, "").replace(/\s+/g, " ").trim() },
    { id: "compact", label: "Compact spaces", icon: "⎵", fn: (s) => s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim() },
    { id: "emoji", label: "Emoji-fy", icon: "😀", fn: (s) => s.replace(/\b(good|great|love|amazing|cool)\b/gi, "✨").replace(/\b(bad|sad|awful|bug)\b/gi, "💥").replace(/\b(fire|hot|fast)\b/gi, "🔥").replace(/\b(okay|ok|yes|done|ship it)\b/gi, "👍").replace(/\b(idea|think|brain)\b/gi, "💡").replace(/\b(time|deadline|late)\b/gi, "⏰") },
    { id: "todo", label: "Prefix TODO:", icon: "☐", fn: (s) => s.split("\n").filter((l) => l.trim()).map((l) => "TODO: " + l.trim()).join("\n") },
    { id: "words", label: "Count words", icon: "w#", stat: (s) => s.split(/\s+/).filter(Boolean).length + " words" },
    { id: "chars", label: "Count chars", icon: "c#", stat: (s) => s.length + " chars" },
    { id: "lines", label: "Count lines", icon: "l#", stat: (s) => s.split("\n").length + " lines" },
    { id: "indent", label: "Indent lines", icon: "→", fn: (s) => s.split("\n").map((l) => (l.trim() ? "  " + l : l)).join("\n") },
    { id: "dedent", label: "Dedent lines", icon: "←", fn: (s) => s.split("\n").map((l) => l.replace(/^\s{2,}/, "")).join("\n") },
    { id: "rtrim", label: "Trim line ends", icon: "␣✂", fn: (s) => s.split("\n").map((l) => l.replace(/\s+$/, "")).join("\n") },
    { id: "wrap80", label: "Wrap at 80 cols", icon: "80", fn: (s) => s.split("\n").map((l) => { const out = []; let cur = ""; l.split(/\s+/).forEach((w) => { if ((cur + " " + w).trim().length > 80) { out.push(cur.trim()); cur = w; } else cur = (cur ? cur + " " : "") + w; }); out.push(cur.trim()); return out.filter(Boolean).join("\n"); }).join("\n") },
    { id: "swapcase", label: "Swap case", icon: "aA", fn: (s) => s.split("").map((c) => (c === c.toLowerCase() ? c.toUpperCase() : c.toLowerCase())).join("") },
    { id: "nospace", label: "Remove all spaces", icon: "⊟", fn: (s) => s.replace(/\s+/g, "") },
    { id: "blanksep", label: "Blank line between", icon: "≡", fn: (s) => s.split("\n").filter((l) => l.trim()).join("\n\n") },
  ];
  function applyTextOp(op) {
    const comp = $("#composer");
    if (!comp) return;
    if (op.stat) { toast(op.stat(comp.value)); return; }
    const v = comp.value, s = comp.selectionStart, e = comp.selectionEnd;
    const sel = v.slice(s, e) || v;
    let out;
    if (op.fn) out = op.fn(sel);
    else if (op.wrap) out = (op.wrap === "`" ? "`" : op.wrap) + sel + (op.wrapEnd ? op.wrapEnd : (op.wrap === "`" ? "`" : op.wrap));
    comp.value = v.slice(0, s) + out + v.slice(e);
    comp.selectionStart = s;
    comp.selectionEnd = s + out.length;
    comp.dispatchEvent(new Event("input", { bubbles: true }));
    sfx.click();
    count("textop");
    closeTextOps();
  }
  let textOpsPop = null;
  function toggleTextOps() {
    if (textOpsPop) { closeTextOps(); return; }
    const host = $("#composer-hint") || $("#composer");
    if (!host) return;
    const pop = el("div", { class: "w6-pop w6-ops-pop" });
    const grid = el("div", { class: "w6-ops-grid" });
    TEXT_OPS.forEach((op) => grid.append(el("button", { class: "w6-op", title: op.label, onclick: () => applyTextOp(op) },
      el("span", { class: "w6-op-ic" }, op.icon), el("span", { class: "w6-op-lb" }, op.label))));
    pop.append(el("div", { class: "w6-pop-head" }, "Text operations — acts on selection (or all text)"), grid);
    document.body.append(pop);
    textOpsPop = pop;
    const r = host.getBoundingClientRect();
    pop.style.bottom = (window.innerHeight - r.top + 6) + "px";
    pop.style.right = "24px";
    setTimeout(() => document.addEventListener("mousedown", outsideOps, { once: true }));
  }
  function outsideOps(e) { if (textOpsPop && !textOpsPop.contains(e.target)) closeTextOps(); }
  function closeTextOps() { if (textOpsPop) { textOpsPop.remove(); textOpsPop = null; } }
  function buildComposerExtras() {
    const hint = $("#composer-hint");
    if (!hint || $("#w6-ops-btn")) return;
    const btn = el("button", { class: "w6-icon-btn w6-ops-btn", title: "Text operations (35)", id: "w6-ops-btn", onclick: toggleTextOps }, "Aa");
    hint.prepend(btn);
    const counter = el("span", { class: "w6-counter", id: "w6-counter", title: "chars · words · lines" });
    hint.append(counter);
    const comp = $("#composer");
    const upd = () => {
      const v = comp.value;
      counter.textContent = prefs.char_count ? (v.length + "c · " + v.split(/\s+/).filter(Boolean).length + "w") : "";
      counter.style.display = v.length && prefs.char_count ? "" : "none";
    };
    comp.addEventListener("input", upd);
    upd();
  }

  /* ---------------- composer behavior prefs ---------------- */
  function initComposerBehavior() {
    const comp = $("#composer");
    if (!comp) return;
    if (prefs.autofocus) setTimeout(() => comp.focus(), 600);
    // enter-to-send override: when pref off, intercept Enter to insert newline
    comp.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey && !prefs.enter_sends) {
        e.preventDefault();
        const s = comp.selectionStart, en = comp.selectionEnd, v = comp.value;
        comp.value = v.slice(0, s) + "\n" + v.slice(en);
        comp.selectionStart = comp.selectionEnd = s + 1;
        comp.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });
    // autoscroll control
    const msgs = $("#messages");
    if (msgs) {
      let pinned = true;
      msgs.addEventListener("scroll", () => { pinned = msgs.scrollHeight - msgs.scrollTop - msgs.clientHeight < 60; });
      const list = $("#msg-list");
      new MutationObserver(() => {
        if (!prefs.auto_scroll && !pinned) {
          // restore position so old content isn't yanked down
          const at = msgs.scrollTop;
          requestAnimationFrame(() => { msgs.scrollTop = at + (msgs.scrollHeight - 0); });
        }
      }).observe(list, { childList: true, subtree: true });
    }
  }

  /* ============================================================
     part 5/7 — slash commands
     ============================================================ */
  const SLASH = [
    { c: "/help", d: "Show all slash commands", f: () => { toast("Slash: " + SLASH.map((s) => s.c).join(" "), "info", { action: () => {} }); const m = el("pre", { class: "w6-pre" }, SLASH.map((s) => s.c.padEnd(14) + " " + s.d).join("\n")); modal("Slash commands", m); } },
    { c: "/new", d: "New chat", f: () => { const b = $("#btn-new-chat-top"); if (b) b.click(); } },
    { c: "/clear", d: "Clear composer", f: () => { const c = $("#composer"); if (c) { c.value = ""; c.dispatchEvent(new Event("input", { bubbles: true })); } } },
    { c: "/stats", d: "Open insights panel", f: openInsights },
    { c: "/insights", d: "Open insights panel", f: openInsights },
    { c: "/uptime", d: "Server uptime + memory", f: async () => { const u = await api("/api/uptime").catch(() => ({})); toast(`uptime ${fmtUp(u.uptime_s)} · ${Math.round(u.memory_mb || 0)} MB · ${u.requests || 0} reqs · ${u.active_streams || 0} streams`); } },
    { c: "/sessions", d: "Active streams + requests", f: async () => { const s = await api("/api/sessions").catch(() => ({})); toast(`streams: ${s.active_streams ?? "?"} · logged: ${s.logged_requests ?? "?"}`); } },
    { c: "/workspace", d: "Workspace summary", f: async () => { const w = await api("/api/workspace/info").catch(() => ({})); const grid = el("div", { class: "w6-grid2" }); grid.append(kv("Files", w.files), kv("Folders", w.dirs), kv("Size", fmtB(w.bytes || 0)), kv("Largest", (w.largest || [])[0] ? w.largest[0].path + " (" + fmtB(w.largest[0].size) + ")" : "—"), kv("Empty dirs", (w.empty_dirs || []).length)); modal("Workspace", grid); count("ws_view"); } },
    { c: "/cleanup", d: "Remove empty folders", f: async () => { const d = await api("/api/workspace/cleanup", { method: "POST" }).catch(() => ({})); toast((d.removed || []).length ? "Removed: " + d.removed.join(", ") : "No empty folders"); } },
    { c: "/preset", d: "Apply settings preset (local-first|cautious|turbo|cloud-power)", f: (arg) => { const n = arg || "turbo"; api("/api/settings/preset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }).then(() => toast("Preset: " + n)).catch((e) => toast("Unknown preset", "err")); } },
    { c: "/temp", d: "Set temperature 0..1", f: (arg) => { const v = parseFloat(arg); if (isNaN(v)) return toast("Usage: /temp 0.7", "warn"); putSettings({ temperature: v }).then(() => toast("temperature = " + v)); } },
    { c: "/maxtok", d: "Set max_tokens", f: (arg) => { const v = parseInt(arg, 10); if (!v) return toast("Usage: /maxtok 4096", "warn"); putSettings({ max_tokens: v }).then(() => toast("max_tokens = " + v)); } },
    { c: "/model", d: "Show current provider/model", f: async () => { const s = await api("/api/settings").catch(() => ({})); toast((s.provider || "?") + " / " + modelFor(s)); } },
    { c: "/provider", d: "Show providers + ping status", f: async () => { const d = await api("/api/providers/status").catch(() => ({})); toast(JSON.stringify(d).slice(0, 200)); } },
    { c: "/search", d: "Global search <query>", f: (arg) => { if (!arg) return toast("Usage: /search <query>", "warn"); openSearchWith(arg); } },
    { c: "/list", d: "List workspace files", f: async () => { const w = await api("/api/workspace/info").catch(() => ({})); const pre = el("pre", { class: "w6-pre" }, ((w.recent || []).concat(w.largest || [])).slice(0, 30).map((x) => x.path + "  " + fmtB(x.size)).join("\n")); modal("Files", pre); } },
    { c: "/file", d: "Open a file: /file <path>", f: (arg) => { if (!arg) return toast("Usage: /file notes/todo.md", "warn"); openFileDeep(arg); } },
    { c: "/read", d: "Show file content", f: (arg) => { if (!arg) return toast("Usage: /read <path>", "warn"); api("/api/files/read?path=" + encodeURIComponent(arg)).then((d) => modal(arg, el("pre", { class: "w6-pre" }, d.content || ""))).catch(() => toast("Read failed", "err")); } },
    { c: "/diff", d: "Diff two files: /diff a.md b.md", f: (arg) => { const [a, b] = (arg || "").split(/\s+/); if (!a || !b) return toast("Usage: /diff <a> <b>", "warn"); openDiff(a, b); } },
    { c: "/export", d: "Export this chat as JSON", f: () => exportChatJson() },
    { c: "/copy", d: "Copy this chat as text", f: () => copyChatText() },
    { c: "/copyjson", d: "Copy this chat as JSON", f: () => copyChatJson() },
    { c: "/archive", d: "Archive this chat", f: () => { const cid = currentChatId(); if (cid) doArchive(cid, true); } },
    { c: "/unarchive", d: "Unarchive this chat", f: () => { const cid = currentChatId(); if (cid) doArchive(cid, false); } },
    { c: "/tag", d: "Tag this chat: /tag work, urgent", f: (arg) => { const cid = currentChatId(); if (!cid) return; setTags(cid, (arg || "").split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6)); decorateChatList(); toast("Tags saved"); } },
    { c: "/tags", d: "Show this chat's tags", f: () => { const cid = currentChatId(); toast("Tags: " + ((cid && tags[cid]) || []).join(", ") || "(none)"); } },
    { c: "/title", d: "Rename this chat: /title <name>", f: (arg) => { if (!arg) return toast("Usage: /title <name>", "warn"); const cid = currentChatId(); if (cid) api("/api/chats/" + cid + "/rename", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title: arg }) }).then(() => { toast("Renamed"); refreshChatMap(); }); } },
    { c: "/theme", d: "dark | light | cycle", f: (arg) => { if (arg === "dark" || arg === "light") setW6Theme(arg); else w6cycleTheme(); } },
    { c: "/zen", d: "Toggle zen mode", f: () => { setZen(!zenOn); toast(zenOn ? "Zen ON" : "Zen OFF"); } },
    { c: "/focus", d: "Toggle focus mode", f: () => setFocusMode(!focusOn) },
    { c: "/sidebar", d: "Toggle sidebar", f: () => { const b = $("#btn-sidebar-toggle"); if (b) b.click(); } },
    { c: "/status", d: "Server + session snapshot", f: async () => { const u = await api("/api/uptime").catch(() => ({})); const s = await api("/api/stats?days=7").catch(() => ({})); modal("Status", el("div", { class: "w6-grid2" }, kv("Uptime", fmtUp(u.uptime_s)), kv("Memory", (u.memory_mb || 0) + " MB"), kv("Requests", u.requests), kv("Streams", u.active_streams), kv("Messages(7d)", s.messages), kv("Tokens(7d)", fmtN(s.tokens)), kv("Streak", s.streak + " days"), kv("Best day", s.best_day || "—"))); } },
    { c: "/browser", d: "Open URL in workspace browser: /browser <url>", f: (arg) => { if (!arg) return toast("Usage: /browser <url>", "warn"); openBrowserUrl(arg); } },
    { c: "/bookmarks", d: "Show bookmarks", f: () => { const b = $("#btn-bookmarks"); if (b) b.click(); } },
    { c: "/ach", d: "Show achievements", f: openAchievements },
    { c: "/mood", d: "Cycle chat mood", f: () => { const b = $("#chat-mood"); if (b) b.click(); } },
    { c: "/goal", d: "Show streak goal", f: () => { const b = $("#streak-goal"); if (b) b.click(); toast("Streak goal panel"); } },
    { c: "/shortcuts", d: "Show keyboard shortcuts", f: () => { const s = $("#shortcuts"); if (s) s.classList.add("open"); } },
    { c: "/cheatsheet", d: "Shortcuts cheatsheet (same)", f: () => { const s = $("#shortcuts"); if (s) s.classList.add("open"); } },
    { c: "/prompt", d: "Insert prompt: /prompt <name>", f: (arg) => insertPromptByName(arg) },
    { c: "/prompts", d: "Open prompt library", f: () => { const b = $("#btn-prompt-lib"); if (b) b.click(); } },
    { c: "/template", d: "Insert template: /template <name>", f: (arg) => insertTemplateByName(arg) },
    { c: "/templates", d: "Open templates", f: () => { const b = $("#btn-templates"); if (b) b.click(); } },
    { c: "/recents", d: "Show search recents", f: () => openSearchWith("") },
    { c: "/about", d: "About this app", f: () => { const b = $("#btn-about"); if (b) b.click(); } },
    { c: "/requests", d: "Open dev request log", f: openDevLog },
    { c: "/backup", d: "Download full backup", f: async () => { const r = await fetch("/api/backup"); dl("myworkspace-backup.zip", await r.blob()); toast("Backup downloaded"); count("backup"); } },
    { c: "/vacuum", d: "Vacuum the database", f: async () => { await api("/api/db/vacuum", { method: "POST" }).then(() => toast("Vacuumed")).catch(() => toast("Vacuum failed", "err")); } },
    { c: "/sound", d: "Toggle sound", f: () => { setPref("sound_on", !prefs.sound_on); toast(prefs.sound_on ? "Sound on" : "Sound off"); } },
    { c: "/noise", d: "Toggle white noise", f: () => { const k = ambient("noise"); toast("Ambient: " + k); } },
    { c: "/rain", d: "Toggle rain", f: () => { const k = ambient("rain"); toast("Ambient: " + k); } },
    { c: "/zoom", d: "Zoom in | out | reset", f: (arg) => zoomBy(arg === "in" ? 1 : arg === "out" ? -1 : 0) },
    { c: "/font", d: "Font size in | out | reset", f: (arg) => { const d = arg === "in" ? 1 : arg === "out" ? -1 : 0; if (d === 0) setPref("font_size", 15); else setPref("font_size", Math.max(12, Math.min(20, prefs.font_size + d))); toast("Font " + prefs.font_size + "px"); } },
    { c: "/density", d: "Toggle sidebar density", f: () => setPref("sidebar_density", prefs.sidebar_density === "compact" ? "comfortable" : "compact") },
    { c: "/wrap", d: "Toggle word wrap", f: () => setPref("wrap_words", !prefs.wrap_words) },
    { c: "/markallread", d: "Mark all chats read", f: markAllRead },
    { c: "/nextunread", d: "Go to next unread chat", f: () => nextUnread(1) },
    { c: "/offline", d: "Toggle fake offline mode", f: () => setOffline(!offlineMode) },
    { c: "/dev", d: "Open dev log", f: openDevLog },
    { c: "/state", d: "Copy full app state as JSON", f: () => copyState() },
    { c: "/party", d: "Party mode", f: () => partyMode() },
    { c: "/matrix", d: "Matrix rain (5s)", f: () => { root.classList.add("w6-matrix"); setTimeout(() => root.classList.remove("w6-matrix"), 5000); } },
    { c: "/retro", d: "Retro mode (10s)", f: () => { root.classList.add("w6-retro"); setTimeout(() => root.classList.remove("w6-retro"), 10000); } },
    { c: "/rainbow", d: "Rainbow drift (10s)", f: () => { root.classList.add("w6-rainbow"); setTimeout(() => root.classList.remove("w6-rainbow"), 10000); } },
    { c: "/breathe", d: "Breathing overlay (60s)", f: () => breatheOverlay(60) },
    { c: "/202020", d: "20-20-20 eye break", f: () => eyeBreak() },
    { c: "/timer", d: "One-minute focus timer", f: () => minTimer(60) },
    { c: "/easter", d: "Easter eggs list", f: () => toast("Try: /hello, /ssss, konami ↑↑↓↓←→←→BA, triple-click the logo", "info") },
    { c: "/hello", d: "A classic", f: () => helloType() },
    { c: "/ssss", d: "snake mode", f: () => snakeEgg() },
    { c: "/ping", d: "Ping all providers", f: async () => { const d = await api("/api/providers/status").catch(() => ({})); modal("Provider status", el("pre", { class: "w6-pre" }, JSON.stringify(d, null, 2).slice(0, 1500))); } },
    { c: "/models", d: "List models for current provider", f: async () => { const s = await api("/api/settings").catch(() => ({})); const d = await api("/api/models?provider=" + (s.provider || "demo")).catch(() => ({})); toast((d.models || []).length + " models (" + (s.provider || "?") + "): " + (d.models || []).slice(0, 5).join(", ")); } },
    { c: "/clearrecents", d: "Clear search recents", f: () => { LS.set("srec", []); toast("Search recents cleared"); } },
    { c: "/watch", d: "Watch a file: /watch <path>", f: (arg) => { if (!arg) return toast("Usage: /watch <path>", "warn"); watchFile(arg); } },
    { c: "/unwatch", d: "Manage watched files", f: manageWatched },
    { c: "/topsites", d: "Show top browser sites", f: () => { const ts = LS.get("bsites", {}); const top = Object.entries(ts).sort((a, b) => b[1] - a[1]).slice(0, 10); toast(top.length ? "Top sites: " + top.map(([u, n]) => u.replace(/^https?:\/\//, "").split("/")[0] + "×" + n).join(", ") : "No visited sites yet"); } },
    { c: "/speak", d: "Read last answer aloud", f: speakLast },
    { c: "/stop", d: "Stop speaking", f: () => { if (speaking) { speechSynthesis.cancel(); speaking = false; toast("Stopped speaking"); } else toast("Not speaking"); } },
    { c: "/confetti", d: "Confetti!", f: () => { confettiW6(); sfx.done(); } },
    { c: "/bzoom", d: "Browser zoom in | out | reset", f: (arg) => { const d = arg === "in" ? 1 : arg === "out" ? -1 : 0; const f = $("#browser-frame"); if (!f) return toast("Browser not available", "err"); let z = parseFloat(LS.get("bzoom", "100")); z = d ? Math.max(50, Math.min(200, z + d * 10)) : 100; LS.set("bzoom", z); f.style.transform = "scale(" + z / 100 + ")"; f.style.transformOrigin = "top left"; f.style.width = (10000 / z) + "%"; toast("Browser zoom " + z + "%"); } },
  ];
  function initSlash() {
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      const comp = $("#composer");
      if (!comp || comp !== e.target) return;
      const v = comp.value.trim();
      const sp = v.indexOf(" ");
      const cmd = sp < 0 ? v : v.slice(0, sp);
      const hit = SLASH.find((s) => s.c === cmd.toLowerCase());
      if (!hit) return;
      e.preventDefault();
      e.stopPropagation();
      hit.f(sp < 0 ? "" : v.slice(sp + 1).trim());
      count("slash");
      comp.value = "";
      comp.dispatchEvent(new Event("input", { bubbles: true }));
    }, true);
  }
  function modelFor(s) {
    const m = { demo: "demo (echo)", ollama: s.ollama_model, openrouter: s.openrouter_model, openai: s.openai_model };
    return m[s.provider] || s.provider;
  }
  function kv(k, v) { return el("div", { class: "w6-kv" }, el("span", { class: "w6-kv-k" }, k + ":"), el("span", { class: "w6-kv-v" }, String(v))); }
  /* ============================================================
     part 6/7 — command palette, quick actions, libraries, achievements
     ============================================================ */
  function buildPalette() {
    const box = $("#palette");
    if (!box || $("#w6-pal")) return;
    const list = el("div", { class: "w6-pal", id: "w6-pal" });
    box.append(list);
    const inp = $("#palette-input");
    const paint = () => {
      const q = (inp && inp.value || "").toLowerCase();
      const entries = palEntries();
      const hit = entries.filter((e) => e.label.toLowerCase().includes(q) || (e.grp || "").includes(q));
      list.innerHTML = "";
      list.style.display = box.classList.contains("hidden") ? "none" : "";
      let lastGrp = "";
      hit.slice(0, 40).forEach((e) => {
        if (e.grp && e.grp !== lastGrp) { lastGrp = e.grp; list.append(el("div", { class: "w6-pal-grp" }, e.grp)); }
        const b = el("button", { class: "w6-pal-item", onclick: () => { e.f(); closePalette(); } },
          el("span", { class: "w6-pal-ic" }, e.ic), el("span", { class: "w6-pal-lb" }, e.label),
          e.hint ? el("span", { class: "w6-pal-hint" }, e.hint) : null);
        list.append(b);
      });
    };
    if (inp) inp.addEventListener("input", paint);
    new MutationObserver(paint).observe(box, { attributes: true, childList: true, subtree: true });
    const iv = setInterval(() => { if (box.classList.contains("hidden")) { paint(); } }, 300);
  }
  function closePalette() { const x = $("#palette"); if (x) x.classList.add("hidden"); }
  function palEntries() {
    const E = [];
    const chat = currentChatId();
    E.push({ grp: "Navigate", ic: "➜", label: "Chat", f: () => showView("chat") },
      { ic: "📊", label: "Insights", f: openInsights },
      { ic: "⚙️", label: "Settings", f: () => showView("settings") },
      { ic: "🔍", label: "Global search", f: () => openSearchWith("") },
      { ic: "⌨️", label: "Keyboard shortcuts", f: () => { const s = $("#shortcuts"); if (s) s.classList.add("open"); } },
      { ic: "🏆", label: "Achievements", f: openAchievements },
      { ic: "⌁", label: "Dev request log", f: openDevLog });
    (w6Chats.size ? [...w6Chats.values()].slice(0, 12) : []).forEach((c) =>
      E.push({ grp: "Chats", ic: "💬", label: c.title, f: () => openChatByTitle(c.title) }));
    E.push({ grp: "Theme & modes", ic: "🌗", label: "Cycle theme", f: w6cycleTheme },
      { ic: "🌑", label: "Dark mode", f: () => setW6Theme("dark") },
      { ic: "☀️", label: "Light mode", f: () => setW6Theme("light") },
      { ic: "🧘", label: "Zen mode", f: () => setZen(!zenOn) },
      { ic: "🎯", label: "Focus mode", f: () => setFocusMode(!focusOn) },
      { ic: "✈️", label: "Offline mode (fake)", f: () => setOffline(!offlineMode) },
      { ic: "📼", label: "Retro flash (10s)", f: () => { root.classList.add("w6-retro"); setTimeout(() => root.classList.remove("w6-retro"), 10000); } },
      { ic: "🟩", label: "Matrix rain (5s)", f: () => { root.classList.add("w6-matrix"); setTimeout(() => root.classList.remove("w6-matrix"), 5000); } },
      { ic: "🌈", label: "Rainbow drift (10s)", f: () => { root.classList.add("w6-rainbow"); setTimeout(() => root.classList.remove("w6-rainbow"), 10000); } },
      { ic: "🎉", label: "Party mode", f: partyMode },
      { ic: "🫁", label: "Breathing (60s)", f: () => breatheOverlay(60) },
      { ic: "👁", label: "20-20-20 eye break", f: eyeBreak },
      { ic: "⏱", label: "1-minute timer", f: () => minTimer(60) },
      { ic: "🤍", label: "White noise", f: () => ambient("noise") },
      { ic: "🌧", label: "Rain sounds", f: () => ambient("rain") });
    E.push({ grp: "Chat actions", ic: "＋", label: "New chat", f: () => { const b = $("#btn-new-chat-top"); if (b) b.click(); } },
      { ic: "🗄", label: "Archive this chat", f: () => chat && doArchive(chat, true) },
      { ic: "📋", label: "Copy chat as text", f: copyChatText },
      { ic: "🧾", label: "Copy chat as JSON", f: copyChatJson },
      { ic: "⬇", label: "Export chat JSON", f: exportChatJson },
      { ic: "✓", label: "Mark all read", f: markAllRead },
      { ic: "●", label: "Next unread", f: () => nextUnread(1) },
      { ic: "📌", label: "Pin this chat", f: togglePin });
    E.push({ grp: "Data", ic: "📦", label: "Download backup", f: async () => { const r = await fetch("/api/backup"); dl("myworkspace-backup.zip", await r.blob()); toast("Backup downloaded"); } },
      { ic: "🗜", label: "Download workspace zip", f: async () => { const r = await fetch("/api/workspace/zip"); dl("workspace.zip", await r.blob()); toast("Workspace zipped"); } },
      { ic: "🧹", label: "Cleanup empty folders", f: async () => { const d = await api("/api/workspace/cleanup", { method: "POST" }); toast((d.removed || []).length ? "Removed: " + d.removed.join(", ") : "No empty folders"); } },
      { ic: "🧯", label: "Vacuum database", f: async () => { await api("/api/db/vacuum", { method: "POST" }).then(() => toast("Vacuumed")); } },
      { ic: "📤", label: "Copy full state JSON", f: copyState },
      { ic: "🚀", label: "Turbo preset", f: () => preset("turbo") },
      { ic: "🛟", label: "Cautious preset", f: () => preset("cautious") },
      { ic: "🏠", label: "Local-first preset", f: () => preset("local-first") },
      { ic: "☁️", label: "Cloud-power preset", f: () => preset("cloud-power") });
    E.push({ grp: "View tweaks", ic: "🔍+", label: "Zoom in", f: () => zoomBy(1) },
      { ic: "🔍−", label: "Zoom out", f: () => zoomBy(-10) },
      { ic: "1:1", label: "Zoom reset", f: () => zoomBy(0) },
      { ic: "A+", label: "Font larger", f: () => setPref("font_size", Math.min(20, prefs.font_size + 1)) },
      { ic: "A−", label: "Font smaller", f: () => setPref("font_size", Math.max(12, prefs.font_size - 1)) },
      { ic: "▤", label: "Toggle density", f: () => setPref("sidebar_density", prefs.sidebar_density === "compact" ? "comfortable" : "compact") },
      { ic: "↩", label: "Toggle word wrap", f: () => setPref("wrap_words", !prefs.wrap_words) },
      { ic: "🔊", label: "Toggle sound", f: () => setPref("sound_on", !prefs.sound_on) },
      { ic: "👁", label: "Watched files", f: manageWatched },
      { ic: "🧽", label: "Clear search recents", f: () => { LS.set("srec", []); toast("Search recents cleared"); } },
      { ic: "▤", label: "Toggle zebra tables", f: () => setPref("zebra", !prefs.zebra) },
      { ic: "🃏", label: "Toggle compact tools", f: () => setPref("compact_tools", !prefs.compact_tools) },
      { ic: "😀", label: "Toggle avatars", f: () => setPref("avatar", !prefs.avatar) },
      { ic: "📅", label: "Toggle day dividers", f: () => setPref("day_dividers", !prefs.day_dividers) });
    return E;
  }
  function preset(n) { api("/api/settings/preset", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: n }) }).then(() => toast("Preset: " + n)); }
  function zoomBy(d) { let v = parseFloat(localStorage.getItem("mwai-zoom") || "100"); if (d) v += d; else v = 100; v = Math.max(60, Math.min(160, v)); localStorage.setItem("mwai-zoom", String(v)); document.body.style.zoom = v / 100; toast("Zoom " + v + "%"); }
  function showView(v) {
    if (v === "settings") { const p = $("#provider-chip"); if (p) p.click(); }
    else { const b = $("#btn-settings-back"); if (b && !$("#view-settings").classList.contains("hidden")) b.click(); }
  }

  /* ---------------- quick actions (18) ---------------- */
  const QUICK = [
    { l: "Summarize", p: "Summarize your last answer in 3 bullet points." },
    { l: "Continue", p: "Continue from exactly where your last answer ended, without repeating it." },
    { l: "Fix grammar", p: "Rewrite your last answer with corrected grammar and punctuation only. No other changes." },
    { l: "Simplify", p: "Rewrite your last answer as if explaining to a smart 12-year-old." },
    { l: "Shorten", p: "Rewrite your last answer in half the words, keeping every fact." },
    { l: "Expand", p: "Expand your last answer with examples and edge cases." },
    { l: "Bulletize", p: "Convert your last answer into concise bullet points." },
    { l: "Table it", p: "Present the key points of your last answer as a markdown table." },
    { l: "Code review", p: "Review the code in your last answer: bugs, style, and one improvement." },
    { l: "Edge cases", p: "List 5 edge cases your last answer missed." },
    { l: "10 ideas", p: "Brainstorm 10 distinct ideas related to the topic of your last answer." },
    { l: "Email it", p: "Turn your last answer into a short, professional email." },
    { l: "Tweet it", p: "Turn your last answer into one punchy tweet under 280 characters." },
    { l: "Commit msg", p: "Write a git commit message for the changes described in your last answer." },
    { l: "TODOs", p: "Extract every action item from your last answer as a - [ ] checklist." },
    { l: "Fact check", p: "Re-verify the factual claims in your last answer and flag any uncertainty." },
    { l: "Re-ask", p: "(re-sends your last question)" },
    { l: "Speak", p: "(reads last answer aloud via speech synthesis)" },
    { l: "Pro / Con", p: "List the pros and cons of your last answer as two markdown tables." },
    { l: "Haiku", p: "Summarize your last answer as a haiku (5-7-5)." },
    { l: "Translate", p: "Translate your last answer into Spanish. Keep formatting." },
    { l: "3 questions", p: "Ask me the 3 most important follow-up questions about your last answer." },
  ];
  function buildQuickActions() {
    const row = $("#qa-row") || $("#quick-actions");
    const comp = $("#composer");
    if (!comp) return;
    const wrap = el("div", { class: "w6-qa-row", id: "w6-qa-row" });
    QUICK.forEach((q) => wrap.append(el("button", { class: "w6-qa", title: q.p.slice(0, 80),
      onclick: () => {
        if (q.l === "Re-ask") { retryLast(); return; }
        if (q.l === "Speak") { speakLast(); return; }
        const last = lastAssistantText();
        const full = last ? q.p.replace("{answer}", last.slice(0, 4000)) : q.p;
        comp.value = full;
        comp.dispatchEvent(new Event("input", { bubbles: true }));
        comp.focus();
        toast("Prompt ready — hit send");
        count("quickaction");
      } }, q.l)));
    const host = comp.closest(".composer-box") || $("#composer-box") || comp.parentElement;
    host.prepend(wrap);
  }
  function lastAssistantText() {
    const as = $$("#msg-list .msg.assistant .md");
    return as.length ? as[as.length - 1].innerText : "";
  }
  let speaking = false;
  function speakLast() {
    if (!("speechSynthesis" in window)) return toast("Speech not supported", "err");
    if (speaking) { speechSynthesis.cancel(); speaking = false; return toast("Stopped speaking"); }
    const t = lastAssistantText();
    if (!t) return toast("Nothing to read yet", "warn");
    const u = new SpeechSynthesisUtterance(t.slice(0, 2000));
    u.onend = () => { speaking = false; };
    speaking = true;
    speechSynthesis.speak(u);
    toast("Reading aloud… (Speak again to stop)");
    count("speak");
  }

  /* ---------------- templates (15) + prompts (20) ---------------- */
  const TEMPLATES = [
    { n: "Bug report", t: "# Bug report\n\n**What happened:** \n\n**Steps to reproduce:**\n1. \n2. \n\n**Expected:** \n\n**Actual:** \n\n**Environment:** " },
    { n: "Standup update", t: "## Standup — {date}\n\n**Done yesterday:**\n- \n\n**Doing today:**\n- \n\n**Blockers:**\n- " },
    { n: "Weekly report", t: "# Weekly report\n\n## Highlights\n- \n\n## Progress\n- \n\n## Risks\n- \n\n## Next week\n- " },
    { n: "Meeting notes", t: "# Meeting notes — {date}\n\n**Attendees:** \n\n**Agenda:**\n1. \n\n**Decisions:**\n- \n\n**Action items:**\n- [ ] " },
    { n: "PR description", t: "## What & why\n\n## How it works\n\n## Test plan\n- [ ] unit\n- [ ] manual\n\n## Screenshots\n" },
    { n: "Release notes", t: "# Release {ver}\n\n## Added\n- \n\n## Fixed\n- \n\n## Changed\n- " },
    { n: "Onboarding doc", t: "# Onboarding: {role}\n\n## Week 1 — orient\n- [ ] \n\n## Week 2 — first task\n- [ ] \n\n## Useful links\n- " },
    { n: "Runbook", t: "# Runbook: {incident}\n\n## Symptoms\n\n## Mitigation (order matters)\n1. \n2. \n\n## Root-cause follow-up\n- [ ] " },
    { n: "ADR", t: "# ADR: {decision}\n\n**Status:** proposed\n\n## Context\n\n## Decision\n\n## Consequences\n- " },
    { n: "Brainstorm", t: "# Brainstorm: {topic}\n\n## Constraints\n\n## Ideas (quantity first)\n1. \n\n## Top 3 to pursue\n1. " },
    { n: "Decision matrix", t: "| Option | Cost | Risk | Speed | Score |\n|---|---|---|---|---|\n| A | | | | |\n| B | | | | |\n\n**Winner:** " },
    { n: "Retrospective", t: "# Retro\n\n**Went well:**\n- \n\n**To improve:**\n- \n\n**Experiments:**\n- [ ] " },
    { n: "User story", t: "**As a** {user}\n**I want** {capability}\n**So that** {benefit}\n\n**Acceptance criteria:**\n- [ ] " },
    { n: "Email draft", t: "Subject: \n\nHi {name},\n\n\n\nBest,\n" },
    { n: "Checklist", t: "## Checklist\n\n- [ ] \n- [ ] \n- [ ] " },
  ];
  const PROMPTS = [
    { n: "Code reviewer", p: "Act as a strict code reviewer. Critique the code I paste for correctness, security, readability, and performance. List issues by severity (blocker / major / nit). Then suggest the single highest-value refactor." },
    { n: "Critic", p: "Be a constructive critic. Steelman the strongest objections to my idea, rank the real weaknesses, and end with the 3 changes that would make it defensible." },
    { n: "Summarizer", p: "Summarize what I paste in: 1) one sentence, 2) five bullets, 3) a TL;DR for a busy executive. Preserve numbers and names exactly." },
    { n: "Tutor", p: "You are a patient tutor. Teach me the topic I name by building up from first principles, using one small concrete example per concept, and checking my understanding with a question every few steps." },
    { n: "Interviewer", p: "Interview me for the role I name. Ask one question at a time, wait for my answer, give brief feedback after each answer, and keep going for 10 questions. End with a score out of 10 and the 2 skills I should sharpen." },
    { n: "Negotiator", p: "I'm negotiating {situation}. Play the other side against me for 5 rounds. After the roleplay, list the 3 tactics I used well and the 2 mistakes I made." },
    { n: "Editor", p: "Edit the text I paste for clarity, rhythm, and concision. Keep my voice. Show the result, then a change-log table (before → after → why) for every edit." },
    { n: "Marketer", p: "Write 5 marketing variants for {product}: headline + subhead + CTA, each with a different angle (pain, curiosity, proof, status, simplicity). Then rank them and say which to test first." },
    { n: "Data analyst", p: "Analyze the data I paste. Start with 3 headline findings, show the math for each, note sample-size caveats, and end with 2 questions worth asking next." },
    { n: "Storyteller", p: "Tell me a short story using the words I provide as constraints. Make it vivid, give it a twist in the last line, and keep it under 300 words." },
    { n: "Planner", p: "Turn my vague goal into a plan: 30/60/90 day milestones, the 2 riskiest assumptions, the cheapest experiment to test each, and a weekly rhythm I can actually keep." },
    { n: "Debugger", p: "Help me debug. Ask me for the exact error, the last change I made, and what I expected. Then hypothesize in order of likelihood and give me one test to run per hypothesis — one at a time." },
    { n: "Security auditor", p: "Audit the code or architecture I paste for security issues: injection, auth flaws, secrets handling, supply chain, and input validation. Rank by exploitability and give a concrete fix for each." },
    { n: "UX auditor", p: "Audit the flow I describe for UX: friction points, missing feedback, confusing labels, and edge cases. Output a table (element → problem → fix → priority)." },
    { n: "Copywriter", p: "Write landing-page copy for {product}: hero headline (3 options), subhead, 3 feature blocks (benefit-first), social proof placeholder, and final CTA. Match the tone I specify." },
    { n: "Brainstorm partner", p: "Be a brainstorming partner. I give a seed; you generate 12 divergent ideas in 30 seconds of thought, then we converge: you help me pick the 3 best and pressure-test them." },
    { n: "Fact checker", p: "Check the claims I paste. For each claim: verdict (true / false / unverifiable / misleading), the key evidence, and confidence 1-5. End with the single most important correction." },
    { n: "Translator", p: "Translate the text I paste into {language}. Preserve formatting, names, and tone. After the translation, list 2 terms that don't translate cleanly and how you handled them." },
    { n: "Exec brief", p: "Compress what I paste into a one-page executive brief: Situation, Complication, Resolution, Asks. Maximum 150 words. No jargon." },
    { n: "A11y checker", p: "Review the UI code or description I paste for accessibility: contrast, keyboard paths, ARIA usage, focus order, and screen-reader labels. List violations by WCAG level." },
  ];
  function buildLibraries() {
    const tl = $("#tpl-list");
    if (tl) {
      const grp = el("div", { class: "w6-lib-grp" }, el("div", { class: "w6-lib-head" }, "Templates · wave 6"));
      TEMPLATES.forEach((t) => grp.append(libItem(t.n, t.t, "tpl")));
      tl.prepend(grp);
    }
    const pl = $("#pl-list");
    if (pl) {
      const grp = el("div", { class: "w6-lib-grp" }, el("div", { class: "w6-lib-head" }, "Prompts · wave 6"));
      PROMPTS.forEach((p) => grp.append(libItem(p.n, p.p, "pl")));
      pl.prepend(grp);
    }
  }
  function libItem(name, body, kind) {
    const row = el("div", { class: "w6-lib-item" },
      el("span", { class: "w6-lib-name", title: body.slice(0, 160) }, name),
      el("span", { class: "w6-lib-acts" },
        mkBtn("Insert", "⤵", () => { insertIntoComposer(body); toast("Inserted: " + name); count(kind); }),
        mkBtn("Copy", "📋", () => copy(body, name + " copied"))));
    return row;
  }
  function insertIntoComposer(text) {
    const comp = $("#composer");
    if (!comp) return;
    comp.value = comp.value ? comp.value + "\n\n" + text : text;
    comp.dispatchEvent(new Event("input", { bubbles: true }));
    comp.focus();
  }
  function insertTemplateByName(name) {
    const t = TEMPLATES.find((x) => x.n.toLowerCase() === (name || "").toLowerCase());
    if (!t) return toast("Templates: " + TEMPLATES.map((x) => x.n).join(", "), "info");
    insertIntoComposer(t.t.replace("{date}", new Date().toDateString()));
    toast("Template: " + t.n);
  }
  function insertPromptByName(name) {
    const p = PROMPTS.find((x) => x.n.toLowerCase() === (name || "").toLowerCase());
    if (!p) return toast("Prompts: " + PROMPTS.map((x) => x.n).join(", "), "info");
    insertIntoComposer(p.p);
    toast("Prompt: " + p.n);
  }

  /* ---------------- achievements (16) ---------------- */
  const ACHS = [
    { id: "chats10", n: "10 chats created", d: "Start ten conversations", check: () => (LS.get("chats_created") || 0) >= 10 },
    { id: "msgs50", n: "50 messages", d: "Send 50 messages", check: () => (counters.msgs || 0) >= 50 },
    { id: "msgs100", n: "100 messages", d: "Send 100 messages", check: () => (counters.msgs || 0) >= 100 },
    { id: "files10", n: "10 files touched", d: "Open/create 10 workspace files", check: () => (counters.files || 0) >= 10 },
    { id: "files25", n: "25 files touched", d: "Open/create 25 workspace files", check: () => (counters.files || 0) >= 25 },
    { id: "export1", n: "First export", d: "Export a chat or backup", check: () => (counters.export || 0) + (counters.backup || 0) >= 1 },
    { id: "export5", n: "Archivist", d: "Export 5 times", check: () => (counters.export || 0) + (counters.backup || 0) >= 5 },
    { id: "insights", n: "Explorer", d: "Visit the insights panel", check: () => (counters.insights || 0) >= 1 },
    { id: "nightowl", n: "Night owl", d: "Send a message after midnight", check: () => !!LS.get("egg-night") },
    { id: "earlybird", n: "Early bird", d: "Send a message before 6am", check: () => !!LS.get("egg-early") },
    { id: "streak3", n: "3-day streak", d: "Keep a 3-day streak", check: async () => (await api("/api/stats?days=14").catch(() => ({}))).streak >= 3 },
    { id: "power", n: "Power user", d: "Use 100 slash/palette commands", check: () => (counters.slash || 0) + (counters.pal || 0) >= 100 },
    { id: "tinkerer", n: "Tinkerer", d: "Change 50 settings", check: () => (counters.pref_changes || 0) >= 50 },
    { id: "zen10", n: "Zen master", d: "10 zen sessions", check: () => (counters.zen || 0) >= 10 },
    { id: "wordy", n: "Wordy", d: "Write 20k words", check: () => (counters.words || 0) >= 20000 },
    { id: "easter", n: "Egg hunter", d: "Find 3 easter eggs", check: () => (counters.eggs || 0) >= 3 },
    { id: "diff10", n: "Differential", d: "Diff 10 pairs of files", check: () => (counters.diff || 0) >= 10 },
    { id: "reader30", n: "Reader", d: "Open 30 workspace files", check: () => (counters.files || 0) >= 30 },
    { id: "sprinter", n: "Sprinter", d: "Send 3 messages within 20 seconds", check: () => (counters.sprint3 || 0) >= 1 },
  ];
  function checkAchievements() {
    const got = new Set(LS.get("ach", []));
    ACHS.forEach((a) => {
      if (got.has(a.id)) return;
      Promise.resolve(a.check()).then((ok) => {
        if (!ok) return;
        got.add(a.id);
        LS.set("ach", [...got]);
        count("ach_unlock");
        confettiW6();
        toast("🏆 Achievement: " + a.n + " — " + a.d, "ok", { action: () => openAchievements() });
        sfx.done();
      }).catch(() => {});
    });
  }
  function openAchievements() {
    count("insights");
    const got = new Set(LS.get("ach", []));
    const grid = el("div", { class: "w6-ach-grid" });
    ACHS.forEach((a) => {
      const on = got.has(a.id);
      grid.append(el("div", { class: "w6-ach" + (on ? " on" : "") },
        el("div", { class: "w6-ach-ic" }, on ? "🏆" : "🔒"),
        el("div", { class: "w6-ach-n" }, a.n),
        el("div", { class: "w6-ach-d" }, a.d)));
    });
    modal("Achievements — " + got.size + "/" + ACHS.length, grid);
  }
  function confettiW6() {
    const c = document.createElement("canvas");
    c.className = "w6-confetti";
    document.body.append(c);
    const ctx = c.getContext("2d");
    c.width = innerWidth; c.height = innerHeight;
    const P = [...Array(120)].map(() => ({
      x: Math.random() * c.width, y: -20 - Math.random() * 200,
      vy: 2 + Math.random() * 3.5, vx: (Math.random() - 0.5) * 2,
      s: 4 + Math.random() * 6, r: Math.random() * Math.PI,
      col: ["#6366f1", "#f59e0b", "#22c55e", "#f43f5e", "#06b6d4", "#eab308"][Math.floor(Math.random() * 6)],
    }));
    let t = 0;
    (function frame() {
      t++;
      ctx.clearRect(0, 0, c.width, c.height);
      P.forEach((p) => {
        p.x += p.vx; p.y += p.vy; p.r += 0.1;
        ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r);
        ctx.fillStyle = p.col; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s / 2);
        ctx.restore();
      });
      if (t < 180) requestAnimationFrame(frame);
      else c.remove();
    })();
  }
  /* ============================================================
     part 7/7 — keyboard shortcuts, insights, browser, files
     ============================================================ */
  function keyComboKey(parts, e) {
    const [k, shift, alt, altShift] = parts;
    const mod = e.metaKey || e.ctrlKey;
    if (!mod) return false;
    if (k === "ArrowUp" || k === "ArrowDown" || k === "ArrowLeft" || k === "ArrowRight") {
      if (!alt) return false;
      return e.key === k && (!shift || !!altShift);
    }
    if (e.key.toLowerCase() !== k.toLowerCase()) return false;
    if (shift !== e.shiftKey) return false;
    if (alt !== e.altKey) return false;
    return true;
  }
  function keyLabel(parts) {
    const [k, shift, alt, altShift] = parts;
    let s = (navigator.platform.includes("Mac") ? "⌘" : "Ctrl") + "+";
    if (shift || altShift) s += "Shift+";
    if (alt) s += "Alt+";
    return s + (k.length > 1 ? k : k.toUpperCase());
  }
  const SHORTCUTS = [
    // ---- meta+shift ----
    [["a", true, false], () => { const b = $("#btn-new-chat-top"); if (b) b.click(); }],
    [["e", true, false], () => { const b = $("#btn-export-all"); if (b) b.click(); }],
    [["i", true, false], () => { const f = $("#sec-chats-head input[type=file]"); if (f) f.click(); }],
    [["c", true, false], () => copy(lastAssistantText(), "Last answer copied")],
    [["x", true, false], copyChatJson],
    [["r", true, false], copyState],
    [["d", true, false], () => setW6Theme("dark")],
    [["l", true, false], () => setW6Theme("light")],
    [["t", true, false], w6cycleTheme],
    [["h", true, false], () => { const b = $("#btn-sidebar-toggle"); if (b) b.click(); }],
    [["g", true, false], () => setFocusMode(!focusOn)],
    [["z", true, false], () => { setZen(!zenOn); count("zen"); }],
    [["j", true, false], openDevLog],
    [["m", true, false], markAllRead],
    [["n", true, false], () => nextUnread(1)],
    [["u", true, false], () => { const u = $("#browser-url"); if (u && u.value) copy(u.value, "Browser URL copied"); }],
    [["s", true, false], () => showView("settings")],
    [["p", true, false], partyMode],
    [["o", true, false], () => setOffline(!offlineMode)],
    [["k", true, false], () => { LS.set("bhist", []); LS.set("bsites", {}); if (window.__w6renderAutocomplete) window.__w6renderAutocomplete(); toast("Browser history cleared"); }],
    // ---- meta+alt+shift ----
    [["r", true, true], hardReloadBrowser],
    [["b", true, true], () => ambient("rain")],
    // ---- meta+alt ----
    [["1", false, true], () => openChatByIndex(0)], [["2", false, true], () => openChatByIndex(1)], [["3", false, true], () => openChatByIndex(2)],
    [["4", false, true], () => openChatByIndex(3)], [["5", false, true], () => openChatByIndex(4)], [["6", false, true], () => openChatByIndex(5)],
    [["7", false, true], () => openChatByIndex(6)], [["8", false, true], () => openChatByIndex(7)], [["9", false, true], () => openChatByIndex(8)],
    [["0", false, true], () => openChatByIndex(-1)],
    [["ArrowUp", false, true], () => stepChatW6(-1)], [["ArrowDown", false, true], () => stepChatW6(1)],
    [["v", false, true], () => { const b = $("#btn-panel-toggle"); if (b) b.click(); }],
    [["r", false, true], () => { const b = $("#btn-b-reload"); if (b) b.click(); }],
    [["ArrowLeft", false, true], () => { const b = $("#btn-b-back"); if (b) b.click(); }],
    [["ArrowRight", false, true], () => { const b = $("#btn-b-fwd"); if (b) b.click(); }],
    [["d", false, true], openDiffPicker],
    [["q", false, true], () => { const r = $("#w6-qa-row"); if (r) r.classList.toggle("w6-hidden"); }],
    [["b", false, true], () => ambient("noise")],
    [["n", false, true], () => { const b = $("#btn-new-chat-top"); if (b) b.click(); }],
    [["t", false, true], () => { const cid = currentChatId(); if (cid) prompt("Tag this chat (comma-separated):", (tags[cid] || []).join(", ")).then((v) => { if (v != null) { setTags(cid, v.split(",").map((x) => x.trim()).filter(Boolean).slice(0, 6)); decorateChatList(); } }); }],
    [["h", false, true], eyeBreak],
    [["m", false, true], () => minTimer(60)],
    [["e", false, true], openAchievements],
    [["s", false, true], () => { const l = $("#status-left"), r = $("#status-right"); const on = l && l.style.display !== "none"; if (l) l.style.display = on ? "none" : ""; if (r) r.style.display = on ? "none" : ""; }],
    [["/", false, true], () => { const s2 = $("#shortcuts"); if (s2) s2.classList.add("open"); }],
    [["w", false, true], async () => { const w = await api("/api/workspace/info").catch(() => ({})); modal("Workspace", el("div", { class: "w6-grid2" }, kv("Files", w.files), kv("Folders", w.dirs), kv("Size", fmtB(w.bytes || 0)), kv("Largest", (w.largest || [])[0]?.path || "—"), kv("Empty dirs", (w.empty_dirs || []).length))); }],
    [["c", false, true], async () => { const d = await api("/api/workspace/cleanup", { method: "POST" }); toast((d.removed || []).length ? "Removed: " + d.removed.join(", ") : "No empty folders"); }],
    [["p", false, true], () => { const b = $("#btn-prompt-lib"); if (b) b.click(); }],
    [["l", false, true], () => { const b = $("#btn-templates"); if (b) b.click(); }],
    [["a", false, true], () => ambient("off")],
    [["k", false, true], () => copy(JSON.stringify({ role: "assistant", content: lastAssistantText() }, null, 2), "Last answer copied as JSON")],
    [["y", false, true], () => setPref("sound_on", !prefs.sound_on)],
    [["u", false, true], async () => { const u = await api("/api/uptime").catch(() => ({})); toast("uptime " + fmtUp(u.uptime_s) + " · " + Math.round(u.memory_mb || 0) + " MB"); }],
  ];
  function initShortcuts() {
    document.addEventListener("keydown", (e) => {
      const inField = /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName);
      if (inField && !e.metaKey && !e.ctrlKey) return;
      for (let i = 0; i < SHORTCUTS.length; i++) {
        const parts = SHORTCUTS[i][0];
        if (keyComboKey(parts, e)) {
          e.preventDefault();
          e.stopPropagation();
          SHORTCUTS[i][1]();
          count("pal");
          return;
        }
      }
    }, true);
  }
  function openChatByIndex(i) {
    const items = $$("#chat-list .chat-item").filter((n) => n.style.display !== "none");
    if (!items.length) return toast("No chats");
    const n = i < 0 ? items.length - 1 : Math.min(i, items.length - 1);
    items[n].click();
  }
  function stepChatW6(d) {
    const items = $$("#chat-list .chat-item");
    const idx = items.findIndex((n) => n.classList.contains("active"));
    const ni = idx < 0 ? 0 : Math.max(0, Math.min(items.length - 1, idx + d));
    items[ni].click();
  }
  function focusPane(p) {
    if (p === "files") { const b = $("#file-tree"); if (b) b.focus(); const t = $("#tree-filter"); if (t) t.focus(); }
    else if (p === "browser") { const u = $("#browser-url"); if (u) u.focus(); }
    else if (p === "insights") openInsights();
    else { const c = $("#composer"); if (c) c.focus(); }
  }

  /* ---------------- insights cards (9) ---------------- */
  function openInsights() {
    const b = $("#streak-flame") || document.querySelector('.ptab[data-tab="insights"]');
    if (b) b.click();
    count("insights");
  }
  function openBrowserUrl(u) {
    const input = $("#browser-url");
    if (!input) return toast("Browser panel not available", "err");
    const btab = document.querySelector('.ptab[data-tab="browser"]');
    if (btab) btab.click();
    input.value = /^https?:\/\//.test(u) ? u : "https://" + u;
    input.dispatchEvent(new Event("change", { bubbles: true }));
    const go = $("#btn-browser-go");
    if (go) go.click();
  }
  function buildInsights() {
    const host = $("#panel-insights");
    if (!host || $("#w6-ins")) return;
    const sec = el("section", { class: "w6-ins", id: "w6-ins" }, el("h3", { class: "set-h" }, "Insights · wave 6"));
    const card = (id, title, body) => el("div", { class: "w6-ins-card", id }, el("div", { class: "w6-ins-t" }, title), body);
    sec.append(
      card("w6i-words", "Words today", el("div", { class: "w6-big" }, "—"), el("div", { class: "w6-sub" }, "typed in this workspace today")),
      card("w6i-longest", "Longest day", el("div", { class: "w6-mid" }, "—"), el("div", { class: "w6-sub" }, "most messages on one day")),
      card("w6i-tool", "Top tool", el("div", { class: "w6-mid" }, "—"), el("div", { class: "w6-sub" }, "most-used agent tool")),
      card("w6i-avg", "Avg chat length", el("div", { class: "w6-mid" }, "—"), el("div", { class: "w6-sub" }, "messages per chat")),
      card("w6i-range", "Activity span", el("div", { class: "w6-mid" }, "—"), el("div", { class: "w6-sub" }, "first → last activity")),
      card("w6i-week", "This week", el("div", { class: "w6-mid" }, "—"), el("div", { class: "w6-sub" }, "7-day messages / tokens")),
      card("w6i-len", "Message length mix", el("div", { class: "w6-bars" })),
      card("w6i-resp", "Response times", el("div", { class: "w6-bars" })),
      card("w6i-days", "Active days", el("div", { class: "w6-days" })),
    );
    host.append(sec);
    setInterval(refreshInsightsW6, 15000);
    setTimeout(refreshInsightsW6, 1200);
  }
  async function refreshInsightsW6() {
    let s;
    try { s = await api("/api/stats?days=14"); } catch { return; }
    const set = (id, v) => { const n = $("#" + id); if (n) { const b = n.querySelector(".w6-big, .w6-mid"); if (b) b.textContent = v; } };
    set("w6i-words", fmtN(s.words_today) + " words");
    set("w6i-longest", s.longest_day || "—");
    set("w6i-tool", s.top_tool || "—");
    set("w6i-avg", s.avg_chat_len ? s.avg_chat_len + " msgs" : "—");
    set("w6i-range", s.first_activity ? relW6(s.first_activity) + " → " + relW6(s.last_activity) : "—");
    set("w6i-week", fmtN(s.week_messages) + " msgs · " + fmtN(s.week_tokens) + " tok");
    bars("w6i-len", s.len_hist || {});
    bars("w6i-resp", s.resp_hist || {});
    const days = $("#w6i-days .w6-days");
    if (days) {
      days.innerHTML = "";
      const hm = s.heatmap || [];
      for (let i = 13; i >= 0; i--) {
        const d = new Date(Date.now() - i * 86400000);
        const key = time.strftime ? null : null;
        const v = (s.by_day && s.by_day[d.toISOString().slice(0, 10)]) || null;
        const n = v ? (typeof v === "number" ? v : (v.msgs || 0)) : (hm.find((h) => String(h.day) === d.toISOString().slice(0, 10)) || {}).n || 0;
        const dot = el("span", { class: "w6-day" + (n ? " on" : ""), title: d.toDateString() + ": " + (n || 0), style: n ? "opacity:" + Math.min(1, 0.25 + n / 12) : "" });
        days.append(dot);
      }
    }
  }
  function bars(id, hist) {
    const box = $("#" + id + " .w6-bars");
    if (!box) return;
    box.innerHTML = "";
    const max = Math.max(1, ...Object.values(hist));
    Object.entries(hist).forEach(([k, v]) => {
      box.append(el("div", { class: "w6-bar-row" },
        el("span", { class: "w6-bar-k" }, k),
        el("span", { class: "w6-bar" }, el("span", { class: "w6-bar-f", style: "width:" + Math.round((v / max) * 100) + "%" })),
        el("span", { class: "w6-bar-v" }, String(v))));
    });
  }

  /* ---------------- browser extensions (9) ---------------- */
  function buildBrowser() {
    const frame = $("#browser-frame");
    const url = $("#browser-url");
    if (!frame || !url) return;
    // visit history + top sites
    const log = (u) => {
      if (!u || u.startsWith("about:") || u.startsWith("data:")) return;
      const h = LS.get("bhist", []);
      LS.set("bhist", [u, ...h.filter((x) => x !== u)].slice(0, 40));
      const ts = LS.get("bsites", {});
      ts[u] = (ts[u] || 0) + 1;
      LS.set("bsites", ts);
      renderAutocomplete();
    };
    url.addEventListener("change", () => log(url.value));
    frame.addEventListener("load", () => { const u = frame.src; if (u && u !== "about:blank") log(u); });
    window.__w6renderAutocomplete = renderAutocomplete;
    function renderAutocomplete() {
      let dl = document.getElementById("w6-url-dl");
      if (!dl) { dl = el("datalist", { id: "w6-url-dl" }); url.parentElement.append(dl); url.setAttribute("list", "w6-url-dl"); }
      dl.innerHTML = "";
      LS.get("bhist", []).slice(0, 15).forEach((u) => dl.append(el("option", { value: u })));
    }
    renderAutocomplete();
    // toolbar buttons
    const tb = url.parentElement;
    const mk = (icon, title, fn) => el("button", { class: "w6-icon-btn", title, onclick: fn }, icon);
    tb.append(
      mk("📋", "Copy URL", () => copy(url.value, "URL copied")),
      mk("💬", "Insert URL into chat", () => { const c = $("#composer"); if (c) { c.value = (c.value ? c.value + " " : "") + url.value; c.dispatchEvent(new Event("input", { bubbles: true })); c.focus(); } }),
      mk("＋", "Zoom in", () => bzoom(1)), mk("−", "Zoom out", () => bzoom(-1)), mk("1:1", "Zoom reset", () => bzoom(0)),
      mk("⟳", "Hard reload (bypass cache)", hardReloadBrowser),
      mk("🧽", "Clear browser history", () => { LS.set("bhist", []); LS.set("bsites", {}); renderAutocomplete(); renderTopSites(); toast("Browser history cleared"); }),
    );
    // top sites row
    const top = el("div", { class: "w6-top-sites", id: "w6-top-sites" });
    tb.after(top);
    function renderTopSites() {
      top.innerHTML = el("span", { class: "w6-top-lab" }, "top:");
      Object.entries(LS.get("bsites", {})).sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([u, n]) =>
        top.append(el("button", { class: "w6-top-s", title: u, onclick: () => gotoUrl(u) }, (u.replace(/^https?:\/\//, "").split("/")[0]).slice(0, 16))));
    }
    renderTopSites();
    function gotoUrl(u) {
      url.value = /^https?:\/\//.test(u) ? u : "https://" + u;
      url.dispatchEvent(new Event("change", { bubbles: true }));
      const go = $("#btn-browser-go"); if (go) go.click();
    }
    function bzoom(d) {
      let z = parseFloat(LS.get("bzoom", "100"));
      if (d) z += d * 10; else z = 100;
      z = Math.max(50, Math.min(200, z));
      LS.set("bzoom", z);
      frame.style.transform = "scale(" + z / 100 + ")";
      frame.style.transformOrigin = "top left";
      frame.style.width = (10000 / z) + "%";
      toast("Browser zoom " + z + "%");
    }
    frame.style.transform = "scale(" + (parseFloat(LS.get("bzoom", "100")) / 100) + ")";
    frame.style.transformOrigin = "top left";
  }
  function hardReloadBrowser() {
    const f = $("#browser-frame");
    if (!f || !f.src) return;
    const u = f.src.split("?")[0] + "?w6bust=" + Date.now();
    f.src = u;
    toast("Hard reload (cache bypassed)");
  }
  /* ============================================================
     part 8/7 (extended) — files, dev log, search, fun, init
     ============================================================ */
  function flatTree(node, out = []) {
    (node || []).forEach((n) => {
      out.push(n);
      if (n.children) flatTree(n.children, out);
    });
    return out;
  }
  function buildFiles() {
    const tree = $("#file-tree");
    const filter = $("#tree-filter");
    if (!tree) return;
    const bar = el("div", { class: "w6-files-bar" });
    const mode = LS.get("fview", "tree");
    ["tree", "largest", "recent", "ext", "empty"].forEach((m) =>
      bar.append(el("button", { class: "w6-seg-b" + (mode === m ? " on" : ""), "data-fv": m,
        onclick: () => { $$("#w6-files-bar .w6-seg-b").forEach((x) => x.classList.remove("on")); bar.querySelector('[data-fv="' + m + '"]').classList.add("on"); LS.set("fview", m); renderFilesView(); } },
        { tree: "Tree", largest: "Largest", recent: "Recent", ext: "By ext", empty: "Empty" }[m])));
    bar.append(el("button", { class: "w6-icon-btn", id: "w6-watched-btn", title: "Watched files — click to manage", onclick: manageWatched }, "👁"));
    tree.parentElement.insertBefore(bar, tree);
    const view = el("div", { class: "w6-files-view", id: "w6-files-view" });
    tree.parentElement.insertBefore(view, tree.nextSibling);
    // recent click history
    tree.addEventListener("click", (e) => {
      const item = e.target.closest(".tree-item, .file-node");
      if (!item) return;
      const path = item.dataset.path || item.title || item.textContent.trim();
      count("files");
      const h = LS.get("frecent", []);
      LS.set("frecent", [path, ...h.filter((x) => x !== path)].slice(0, 20));
    });
    if (mode !== "tree") later(renderFilesView, 400);
    setInterval(() => { if (LS.get("fview", "tree") !== "tree") renderFilesView(); }, 20000);
  }
  async function renderFilesView() {
    const view = $("#w6-files-view");
    if (!view) return;
    const mode = LS.get("fview", "tree");
    if (mode === "tree") { view.innerHTML = ""; $("#file-tree").style.display = ""; return; }
    let info = null, tree = null;
    try { info = await api("/api/workspace/info"); } catch { return; }
    try { tree = (await api("/api/files")).tree; } catch {}
    view.innerHTML = "";
    $("#file-tree").style.display = "none";
    const files = flatTree(tree).filter((n) => !n.is_dir);
    const mk = (label, path, sub, extra) => el("div", { class: "w6-frow", onclick: () => revealInTree(path) },
      el("span", { class: "w6-fname", title: path }, label),
      sub ? el("span", { class: "w6-fsub" }, sub) : null,
      extra);
    if (mode === "largest") {
      const top = files.slice().sort((a, b) => b.size - a.size).slice(0, 40);
      const maxSz = top.length ? top[0].size : 1;
      top.forEach((f) => {
        view.append(mk(f.path, f.path, fmtB(f.size) + " · " + timeAgo(f.mtime * 1000),
          el("span", { class: "w6-fbar" }, el("span", { style: "width:" + Math.round((f.size / maxSz) * 100) + "%" }))));
      });
    } else if (mode === "recent") {
      files.slice().sort((a, b) => b.mtime - a.mtime).slice(0, 40).forEach((f) => {
        view.append(mk(f.path, f.path, timeAgo(f.mtime * 1000) + " · " + fmtB(f.size)));
      });
    } else if (mode === "ext") {
      const byExt = {};
      files.forEach((f) => {
        const e = (f.name.includes(".") ? "." + f.name.split(".").pop() : "(none)");
        byExt[e] = byExt[e] || { n: 0, b: 0 };
        byExt[e].n++; byExt[e].b += f.size;
      });
      Object.entries(byExt).sort((a, b) => b[1].b - a[1].b).forEach(([e, v]) =>
        view.append(mk(e, e, v.n + " files · " + fmtB(v.b))));
    } else if (mode === "empty") {
      (info.empty_dirs || []).length ? info.empty_dirs.forEach((d) =>
        view.append(mk(d, d, "empty folder", el("button", { class: "w6-mini-btn", title: "Remove", onclick: (ev) => { ev.stopPropagation(); api("/api/workspace/cleanup", { method: "POST" }).then(renderFilesView); } }, "🗑"))))
        : view.append(el("div", { class: "w6-empty" }, "No empty folders 🎉"));
    }
  }
  const timeAgo = (ms) => {
    const d = Date.now() - ms;
    if (d < 60000) return "just now";
    if (d < 3600000) return Math.round(d / 60000) + "m ago";
    if (d < 86400000) return Math.round(d / 3600000) + "h ago";
    return Math.round(d / 86400000) + "d ago";
  };
  function revealInTree(path) {
    LS.set("fview", "tree");
    later(() => {
      $("#file-tree").style.display = "";
      $("#w6-files-view").innerHTML = "";
      const items = $$("#file-tree .tree-item, #file-tree .file-node, #file-tree [data-path]");
      const hit = items.find((n) => (n.dataset.path || n.title || n.textContent).trim() === path || (n.dataset.path || "").includes(path));
      if (hit) {
        hit.scrollIntoView({ block: "center" });
        hit.classList.add("w6-flash");
        setTimeout(() => hit.classList.remove("w6-flash"), 1600);
        hit.click();
      } else toast("Could not find " + path + " in tree", "warn");
    }, 300);
  }
  function openFileDeep(path) {
    LS.set("fview", "tree");
    later(() => {
      const t = $("#tree-filter");
      if (t) { t.value = path.split("/").pop(); t.dispatchEvent(new Event("input", { bubbles: true })); }
      revealInTree(path);
    }, 300);
  }
  /* file watching */
  let watchTimer = null;
  function manageWatched() {
    const w = LS.get("watched", []);
    if (!w.length) return toast("No watched files. Watch one from a file's actions.", "info");
    const grid = el("div");
    w.forEach((p) => grid.append(el("div", { class: "w6-frow" }, el("span", {}, p),
      el("button", { class: "w6-mini-btn", title: "Unwatch", onclick: () => { LS.set("watched", w.filter((x) => x !== p)); count("unwatch"); renderFilesView(); manageWatched(); } }, "✖"))));
    modal("Watched files", grid);
  }
  function watchFile(path) {
    const w = LS.get("watched", []);
    LS.set("watched", [...new Set([...w, path])]);
    toast("Watching " + path);
    count("watch");
    if (!watchTimer) watchTimer = setInterval(pollWatched, 8000);
  }
  async function pollWatched() {
    const w = LS.get("watched", []);
    if (!w.length) return;
    try {
      const tree = (await api("/api/files")).tree;
      const all = flatTree(tree);
      w.forEach((p) => {
        const f = all.find((x) => x.path === p);
        const before = LS.get("wstate-" + p);
        if (!f) { toast("Watched file gone: " + p, "err"); LS.set("wstate-" + p, null); return; }
        const sig = f.size + ":" + Math.round(f.mtime);
        if (before && before !== sig) {
          toast("👁 " + p + " changed", "ok", { action: () => revealInTree(p) });
          sfx.reply();
        }
        LS.set("wstate-" + p, sig);
      });
    } catch {}
  }
  async function fileInfoModal(path) {
    try {
      const d = await api("/api/files/read?path=" + encodeURIComponent(path));
      const content = d.content || "";
      const lines = content.split("\n").length;
      const words = content.split(/\s+/).filter(Boolean).length;
      const info = await api("/api/workspace/info").catch(() => ({}));
      const f = flatTree((await api("/api/files").catch(() => ({ tree: [] }))).tree).find((x) => x.path === path);
      const all2 = flatTree((await api("/api/files").catch(() => ({ tree: [] }))).tree);
      const sibs = f ? all2.filter((x) => !x.is_dir && x.path.split("/").slice(0, -1).join("/") === f.path.split("/").slice(0, -1).join("/")).length : 0;
      modal(path, el("div", { class: "w6-grid2" },
        kv("Size", fmtB(f ? f.size : content.length)),
        kv("Modified", f ? new Date(f.mtime * 1000).toLocaleString() : "—"),
        kv("Lines", String(lines)),
        kv("Words", String(words)),
        kv("Chars", String(content.length)),
        kv("Ext", ("." + path.split(".").pop())),
        el("button", { class: "w6-chip-btn", onclick: () => copy(path, "Path copied") }, "Copy path"),
        el("button", { class: "w6-chip-btn", onclick: () => copy(content, "Content copied") }, "Copy content"),
        el("button", { class: "w6-chip-btn", onclick: () => { dl(path.split("/").pop(), new Blob([content], { type: "text/plain" })); } }, "Download"),
        el("button", { class: "w6-chip-btn", onclick: () => { watchFile(path); } }, "Watch changes")));
      if (/\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
        const img = el("img", { class: "w6-fimg", src: "/api/files/raw?path=" + encodeURIComponent(path), alt: path });
        modal(path + " · preview", img);
      }
    } catch { toast("Info failed for " + path, "err"); }
  }
  function openDiffPicker() {
    const a = prompt("Diff file A (path):", "");
    if (!a) return;
    const b = prompt("Diff file B (path):", "");
    if (!b) return;
    openDiff(a, b);
  }
  async function openDiff(a, b) {
    try {
      const [da, db] = await Promise.all([
        api("/api/files/read?path=" + encodeURIComponent(a)),
        api("/api/files/read?path=" + encodeURIComponent(b)),
      ]);
      const la = (da.content || "").split("\n"), lb = (db.content || "").split("\n");
      const pre = el("pre", { class: "w6-diff" });
      const max = Math.max(la.length, lb.length);
      for (let i = 0; i < max; i++) {
        const A = la[i], B = lb[i];
        if (A === B) pre.append(el("span", { class: "w6-diff-same" }, (A || " ") + "\n"));
        else {
          if (A != null) pre.append(el("span", { class: "w6-diff-del" }, "- " + A + "\n"));
          if (B != null) pre.append(el("span", { class: "w6-diff-add" }, "+ " + B + "\n"));
        }
      }
      modal("Diff: " + a + " ⇄ " + b, pre);
      count("diff");
    } catch (e) { toast("Diff failed: " + e.message, "err"); }
  }

  /* ---------------- dev log drawer ---------------- */
  let devLog = null, devTimer = null;
  function openDevLog() {
    if (devLog) { closeDevLog(); return; }
    devLog = el("div", { class: "w6-devlog" },
      el("div", { class: "w6-devlog-head" }, "Request log",
        el("span", { class: "w6-devlog-meta" }),
        el("button", { class: "w6-mini-btn", title: "Copy all", onclick: () => { const t = devLog.querySelector("pre").innerText; copy(t, "Log copied"); } }, "📋"),
        el("button", { class: "w6-mini-btn", title: "Auto-refresh", onclick: (e) => { e.target.classList.toggle("on"); devAuto = !devAuto; } }, "⟳"),
        el("button", { class: "w6-mini-btn", title: "Close", onclick: closeDevLog }, "✕")));
    devLog.append(el("pre", { class: "w6-devlog-pre" }, "loading…"));
    document.body.append(devLog);
    devLogFetch();
    devTimer = setInterval(() => { if (devAuto) devLogFetch(); }, 3000);
    count("devlog");
  }
  let devAuto = true;
  async function devLogFetch() {
    if (!devLog) return;
    try {
      const d = await api("/api/requests");
      const rs = d.requests || [];
      devLog.querySelector(".w6-devlog-meta").textContent = rs.length + " logged";
      devLog.querySelector("pre").innerHTML = rs.slice(-60).reverse().map((r) =>
        `<span class="w6-req ${r.status >= 500 ? "bad" : r.status >= 400 ? "warn" : "ok"}">${esc(r.method)} ${esc(r.path)} → ${r.status} (${r.ms}ms)</span> ${new Date(r.at).toLocaleTimeString()}`).join("\n");
    } catch { devLog.querySelector("pre").textContent = "server unreachable"; }
  }
  function closeDevLog() {
    if (devTimer) clearInterval(devTimer);
    devTimer = null; devLog = null;
  }

  /* ---------------- search extensions (9) ---------------- */
  function buildSearch() {
    const ov = $("#search-overlay");
    if (!ov || $("#w6-search-ex")) return;
    const bar = el("div", { class: "w6-search-bar", id: "w6-search-ex" });
    const chipsBar = el("div", { class: "w6-search-chips" });
    const opts = { scope: "all", regex: false, cased: false, word: false, fname: false };
    const chip = (id, label, on, title) => {
      const b = el("button", { class: "w6-schip" + (on ? " on" : ""), title }, label);
      b.onclick = () => { b.classList.toggle("on"); on = b.classList.contains("on"); opts[id] = on; doW6Search(); };
      return b;
    };
    const scopes = el("div", { class: "w6-search-scopes" });
    ["all", "chats", "files"].forEach((s, i) => {
      const b = el("button", { class: "w6-schip" + (i === 0 ? " on" : ""), title: "Scope: " + s }, s);
      b.onclick = () => { $$(".w6-search-scopes .w6-schip").forEach((x) => x.classList.remove("on")); b.classList.add("on"); opts.scope = s; doW6Search(); };
      scopes.append(b);
    });
    chipsBar.append(scopes,
      chip("regex", ".*", opts.regex, "Regex match"),
      chip("cased", "Aa", opts.cased, "Case-sensitive"),
      chip("word", "word", opts.word, "Whole word"),
      chip("fname", "name", opts.fname, "Filenames only"));
    const rec = el("div", { class: "w6-search-rec" },
      el("button", { class: "w6-icon-btn", title: "Clear recents", onclick: () => { LS.set("srec", []); renderRec(); } }, "🧽"));
    bar.append(chipsBar, rec);
    const input = $("#search-input");
    if (input) {
      input.addEventListener("input", () => {
        if (input.value.trim()) doW6Search();
        else renderRec();
      });
      input.addEventListener("focus", renderRec);
    }
    const host = $("#search-results");
    const wrap = el("div", { class: "w6-search-results", id: "w6-search-w" });
    (host || ov).prepend(wrap);
    bar.insertAdjacentElement("afterbegin", wrap);
    ov.prepend(bar);
    function renderRec() {
      rec.querySelectorAll(".w6-rec").forEach((n) => n.remove());
      (LS.get("srec", []) || []).slice(0, 6).forEach((q) =>
        rec.append(el("button", { class: "w6-rec", onclick: () => { if (input) { input.value = q; doW6Search(); } } }, "🕘 " + q)));
    }
    renderRec();
    let navIdx = -1;
    async function doW6Search() {
      const q = input ? input.value.trim() : "";
      if (!q) return;
      LS.set("srec", [q, ...(LS.get("srec", []) || []).filter((x) => x !== q)].slice(0, 10));
      renderRec();
      const body = { q, scope: opts.scope, regex: opts.regex, case_sensitive: opts.cased, whole_word: opts.word, filename_only: opts.fname };
      try {
        const d = await api("/api/search/global", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
        const chatHits = (d.chats || []).map((c) => ({ kind: "chat", title: c.chat_title || "chat", sub: (c.snippet || c.content || "") + " · " + (c.count || "") + " matches", open: () => openChatByTitle(c.chat_title) }));
        const fileHits = (d.files || []).map((f) => ({ kind: "file", title: f.path, sub: (f.snippet || "") + " · " + (f.count || "") + " matches", open: () => revealInTree(f.path) }));
        const hits = [...chatHits, ...fileHits];
        wrap.innerHTML = el("div", { class: "w6-search-count" }, hits.length + " results — " + (chatHits.length) + " chats · " + (fileHits.length) + " files");
        hits.slice(0, 30).forEach((h) => {
          const b = el("button", { class: "w6-hit" },
            el("span", { class: "w6-hit-t" }, (h.kind === "chat" ? "💬 " : "📄 ") + h.title),
            el("span", { class: "w6-hit-s" }, h.sub.slice(0, 140)));
          b.onclick = () => { h.open(); ov.classList.add("hidden"); };
          wrap.append(b);
        });
      } catch (e) {
        wrap.innerHTML = el("div", { class: "w6-hit-err" }, "search failed: " + esc(e.message || String(e)));
      }
    }
  }
  function openSearchWith(q) {
    const ov = $("#search-overlay"), inp = $("#search-input");
    if (!ov) return;
    ov.classList.remove("hidden");
    if (inp) { inp.value = q || ""; inp.focus(); if (q) inp.dispatchEvent(new Event("input", { bubbles: true })); }
  }

  /* ---------------- fun & easter eggs (20) ---------------- */
  function partyMode() {
    root.classList.add("w6-party");
    confettiW6();
    sfx.done();
    toast("🎉 Party mode!");
    count("eggs");
    setTimeout(() => root.classList.remove("w6-party"), 6000);
  }
  function helloType() {
    const t = "Hello, world! 👋";
    let i = 0;
    const tick = () => {
      toast(t.slice(0, ++i), "ok");
      if (i < t.length) setTimeout(tick, 120);
    };
    tick();
    count("eggs");
  }
  function snakeEgg() {
    toast("🐍 sssssss…", "warn");
    document.body.classList.add("w6-snake");
    setTimeout(() => document.body.classList.remove("w6-snake"), 8000);
    count("eggs");
  }
  function breatheOverlay(sec) {
    const o = el("div", { class: "w6-breathe" },
      el("div", { class: "w6-breathe-circle" }),
      el("div", { class: "w6-breathe-txt" }, "Breathe in… hold… out…"),
      el("button", { class: "w6-breathe-x", onclick: () => o.remove() }, "✕ stop"));
    document.body.append(o);
    setTimeout(() => o.remove(), sec * 1000);
    toast("Breathing overlay — " + sec + "s");
    count("eggs");
  }
  function eyeBreak() {
    const o = el("div", { class: "w6-2020" },
      el("div", { class: "w6-2020-t" }, "20-20-20"),
      el("div", { class: "w6-2020-d" }, "Look at something 20 feet away\nfor 20 seconds."),
      el("div", { class: "w6-2020-n", id: "w6-2020-n" }, "20"),
      el("button", { class: "w6-breathe-x", onclick: () => o.remove() }, "✕"));
    document.body.append(o);
    let n = 20;
    const iv = setInterval(() => {
      n--;
      const eln = $("#w6-2020-n");
      if (eln) eln.textContent = String(Math.max(0, n));
      if (n <= 0) { clearInterval(iv); o.remove(); toast("Eyes rested 👁"); sfx.done(); }
    }, 1000);
    toast("20-20-20 eye break");
    count("eggs");
  }
  function minTimer(sec) {
    const o = el("div", { class: "w6-min-timer" },
      el("div", { class: "w6-min-n", id: "w6-min-n" }, fmtClock(sec)),
      el("button", { class: "w6-breathe-x", onclick: () => o.remove() }, "✕"));
    document.body.append(o);
    let n = sec;
    const iv = setInterval(() => {
      n--;
      const eln = $("#w6-min-n");
      if (eln) eln.textContent = fmtClock(Math.max(0, n));
      if (n <= 0) { clearInterval(iv); o.remove(); toast("1 minute up ⏱"); sfx.done(); }
    }, 1000);
    toast("1-minute timer");
    count("eggs");
  }
  const fmtClock = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  function initEggs() {
    // konami
    const seq = ["ArrowUp", "ArrowUp", "ArrowDown", "ArrowDown", "ArrowLeft", "ArrowRight", "ArrowLeft", "ArrowRight", "b", "a"];
    let pos = 0;
    document.addEventListener("keydown", (e) => {
      pos = e.key === seq[pos] ? pos + 1 : (e.key === seq[0] ? 1 : 0);
      if (pos === seq.length) { pos = 0; partyMode(); toast("Konami code! 🕹"); }
    });
    // triple logo click
    const logo = $(".brand-mark") || $("#app")?.querySelector(".logo, .brand, h1");
    if (logo) {
      let n = 0, t = null;
      logo.addEventListener("click", () => {
        n++;
        clearTimeout(t);
        t = setTimeout(() => (n = 0), 700);
        if (n >= 3) { n = 0; partyMode(); toast("Secret: triple logo 👀"); }
      });
    }
    // night / early bird
    setInterval(() => {
      const h = new Date().getHours();
      if (h >= 0 && h < 4) LS.set("egg-night", Date.now());
      if (h >= 4 && h < 6) LS.set("egg-early", Date.now());
    }, 60000);
  }

  /* ---------------- pwa / a11y / state (12) ---------------- */
  function copyState() {
    const state = {
      time: new Date().toISOString(),
      chat: currentChatId(),
      prefs, tints, tags,
      counters,
      achievements: LS.get("ach", []),
      templates_custom: LS.get("tcpl", []),
      watched: LS.get("watched", []),
      urls: LS.get("bhist", []),
      localStorage: Object.keys(localStorage).filter((k) => k.startsWith("mwai")).reduce((o, k) => (o[k] = localStorage.getItem(k), o), {}),
    };
    copy(JSON.stringify(state, null, 2), "Full state copied");
    count("state");
  }
  function exportStateFile() {
    const state = { app: "MyWorkspace AI", version: "6.0", time: new Date().toISOString(), prefs, counters, tags, tints, ach: LS.get("ach", []) };
    dl("myworkspace-state.json", new Blob([JSON.stringify(state, null, 2)], { type: "application/json" }));
    toast("State file downloaded");
  }
  function importStateFile(file) {
    if (!file) return;
    const fr = new FileReader();
    fr.onload = () => {
      try {
        const d = JSON.parse(fr.result);
        if (d.prefs) { prefs = Object.assign({}, PREF_DEFAULTS, d.prefs); savePrefs(); applyPrefs(); }
        if (d.counters) Object.assign(counters, d.counters);
        if (d.tags) tags = d.tags;
        if (d.tints) tints = d.tints;
        if (d.ach) LS.set("ach", d.ach);
        LS.set("counters", counters); LS.set("tags", tags); LS.set("tints", tints);
        toast("State imported ✓");
      } catch (e) { toast("Import failed: " + e.message, "err"); }
    };
    fr.readAsText(file);
  }
  function buildA11y() {
    // skip link
    const skip = el("a", { class: "w6-skip", href: "#composer" }, "Skip to chat input");
    document.body.prepend(skip);
    // aria-live on toasts container
    const toasts = $("#toasts");
    if (toasts) toasts.setAttribute("aria-live", "polite");
    // dev console extras
    if (window.mwai) {
      window.mwai.uptime = async () => console.log(await api("/api/uptime"));
      window.mwai.sessions = async () => console.log(await api("/api/sessions"));
      window.mwai.workspace = async () => console.log(await api("/api/workspace/info"));
      window.mwai.easter = () => { helloType(); };
      window.mwai.archive = () => { const c = currentChatId(); if (c) doArchive(c, true); };
      window.mwai.state = copyState;
    }
    // footer button: state export/import + dev log
    const foot = $("#app-footer") || $("#app");
    if (foot) {
      const grp = el("span", { class: "w6-foot" },
        el("button", { class: "w6-icon-btn", title: "Export state JSON", onclick: exportStateFile }, "💾"),
        el("button", { class: "w6-icon-btn", title: "Import state JSON", onclick: () => {
          const i = el("input", { type: "file", accept: ".json", style: "display:none", onchange: (e) => importStateFile(e.target.files[0]) });
          document.body.append(i); i.click();
        } }, "📥"),
        el("button", { class: "w6-icon-btn", title: "Dev request log", onclick: openDevLog }, "⌁"));
      foot.append(grp);
    }
  }

  /* ---------------- title flash ---------------- */
  let flashIv = null;
  function initTitleFlash() {
    const base = document.title;
    const list = $("#msg-list");
    if (!list) return;
    let lastN = 0;
    new MutationObserver(() => {
      const n = $$("#msg-list .msg").length;
      if (n > lastN && lastN > 0 && document.hidden && prefs.title_flash) {
        let on = true;
        clearInterval(flashIv);
        flashIv = setInterval(() => {
          document.title = on ? "● " + base : base;
          on = !on;
        }, 800);
        setTimeout(() => { clearInterval(flashIv); document.title = base; }, 15000);
      }
      lastN = n;
    }).observe(list, { childList: true, subtree: true });
  }

  /* ---------------- init ---------------- */
  async function initW6() {
    applyPrefs();
    initTheme();
    buildStatusBar();
    buildSettings();
    buildChatHead();
    buildChatMenuItems();
    initChatClicks();
    initMsgActions();
    initLastMsgTracker();
    buildComposerExtras();
    initComposerBehavior();
    initSlash();
    buildPalette();
    buildQuickActions();
    buildLibraries();
    buildFiles();
    buildBrowser();
    buildInsights();
    buildSearch();
    buildA11y();
    initShortcuts();
    initEggs();
    initTitleFlash();
    // intercept send clicks for counters/sfx
    const send = $("#btn-send");
    if (send) send.addEventListener("click", () => {
      count("msgs");
      const comp = $("#composer");
      if (comp) count("words", (comp.value.split(/\s+/).filter(Boolean).length) || 1);
      const now = Date.now();
      const lastSends = (LS.get("lastsends") || []).filter((t) => now - t < 20000);
      lastSends.push(now);
      LS.set("lastsends", lastSends);
      if (lastSends.length >= 3) count("sprint3");
      sfx.send();
      LS.set("chats_created", (LS.get("chats_created") || 0) + 1);
      checkAchievements();
    });
    refreshChatMap();
    pollStatus();
    setInterval(pollStatus, 15000);
    setInterval(checkAchievements, 20000);
    setTimeout(() => { buildSettings(); }, 1500); // re-run in case settings view was hidden and rebuilt
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initW6);
  else setTimeout(initW6, 60);
  window.W6 = { state: stateLike, prefs, toast, count };
})();
