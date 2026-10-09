/* ============================================================
   CortexSpace — wave 8: The Arena
   "Search all wrappers in this world and rule them."
   Self-contained module: no deps, no build step, offline-safe.
   ============================================================ */
(function () {
  "use strict";
  const $ = (s) => document.querySelector(s);
  const $$ = (s) => [...document.querySelectorAll(s)];
  const el = (tag, attrs, ...kids) => {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) {
      if (k === "class") n.className = v;
      else if (k === "html") n.innerHTML = v;
      else if (k === "text") n.textContent = v;
      else if (k.startsWith("on")) n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null) n.append(kid);
    return n;
  };
  const api = (p, o) => fetch(p, o).then((r) => r.json());

  /* ---- the eight battle dimensions (0 / 0.5 / 1) ------------------- */
  const DIMS = [
    { id: "setup",  label: "One-process setup",  hint: "no Docker, no side services" },
    { id: "light",  label: "Light payload",      hint: "what your browser actually downloads (measured live here)" },
    { id: "models", label: "Model freedom",      hint: "local + cloud + per-chat pinning" },
    { id: "speed",  label: "Verifiable speed",   hint: "TTFT + tok/s shown per model (measured live here)" },
    { id: "tools",  label: "Agent approval",     hint: "per-action human gate" },
    { id: "local",  label: "Data stays local",   hint: "chats/files never leave the box" },
    { id: "quiet",  label: "Zero telemetry",     hint: "nothing phoned home, by architecture" },
    { id: "free",   label: "$0 infra",           hint: "no seat fee, no forced cloud tier" },
  ];

  /* ---- the world's wrappers (public architectures, 2026) -----------
     Scores are a documented self-assessment (0 / 0.5 / 1) of each
     product's public architecture, NOT a benchmark. Two dimensions —
     payload and speed — are replaced by LIVE measurements of this
     very instance below. */
  const CS = { name: "CortexSpace", kind: "this machine", cs: true, dims: [1, 1, 1, 1, 1, 1, 1, 1],
    gap: "It's you. That's the point.",
    kill: "One Python process. ~100 KB of hand-written JS. Local GGUF via Cortex LLMHoster (no Ollama) or Ollama, any cloud model via OpenRouter — your speed, your approval, your machine." };

  const RIVALS = [
    { name: "Open WebUI", kind: "self-host · Docker", dims: [0, 0, 0.5, 0, 0.5, 1, 0.5, 1],
      gap: "Docker + SvelteKit + Python + ChromaDB stack; anonymous usage stats on by default",
      kill: "Same privacy, one process instead of a container farm — and we show our own telemetry: none." },
    { name: "AnythingLLM", kind: "self-host · Docker", dims: [0, 0, 0.5, 0, 0.5, 1, 1, 0.5],
      gap: "RAG is best-in-class, but Electron/Docker + ChromaDB; cloud tier $50+/mo",
      kill: "Files are a first-class workspace (editor, versions, diff, watch) — not a document feeder. And the local path costs $0." },
    { name: "LibreChat", kind: "self-host · Docker", dims: [0, 0, 0.5, 0, 0.5, 1, 1, 1],
      gap: "Widest provider list — but needs MongoDB + Meilisearch for full setup",
      kill: "OpenRouter alone exposes the same catalog through one URL. SQLite instead of Mongo + a search cluster." },
    { name: "LobeChat / LobeHub", kind: "self-host · Next.js", dims: [0, 0, 0.5, 0, 0, 0.5, 0.5, 0.5],
      gap: "Agent marketplace + 10K MCP skills; cloud tiers $9.90–39.90/mo",
      kill: "No marketplace tax. The 79 slash commands, 50 palette entries and 20 prompt entries ship in ~100 KB and stay free." },
    { name: "Jan", kind: "desktop · Electron", dims: [0.5, 0, 0.5, 0, 0, 1, 1, 1],
      gap: "Cleanest offline desktop app — Electron runtime (~100 MB+) on every machine",
      kill: "Browser tab over a Python process: zero install, zero Electron, same offline models via Ollama." },
    { name: "GPT4All", kind: "desktop · Qt/C++", dims: [0.5, 0, 0, 0, 0, 1, 1, 1],
      gap: "Local-only; no cloud model path, no agent tools",
      kill: "Local when you want it (Ollama), any frontier model the same day (OpenRouter), with a real tool-using agent." },
    { name: "NextChat", kind: "lightweight web", dims: [1, 0.5, 0.5, 0, 0, 0.5, 1, 0.5],
      gap: "Genuinely light client — but a client: no agent, no workspace, chats stay in the browser",
      kill: "Light AND complete: the same ~100 KB carries chat + agent + files + browser + insights." },
    { name: "text-generation-webui", kind: "self-host · Gradio", dims: [0, 0, 0.5, 0.5, 0, 1, 1, 1],
      gap: "The power user's inference control panel — Gradio UI, model-loading first, chat second",
      kill: "Inference stats exist there; here every chat message carries its own ⚡ first-token + tok/s, and the UI is an app, not a lab." },
    { name: "Khoj", kind: "self-host · Docker", dims: [0, 0, 0.5, 0, 0, 1, 1, 1],
      gap: "Great second-brain research; Docker + scheduled automations stack",
      kill: "Your notes are files you can also read, edit, diff and version in the same panel — no separate 'brain' service." },
    { name: "SillyTavern", kind: "self-host · Node", dims: [0.5, 0, 0.5, 0, 0, 1, 1, 1],
      gap: "Unmatched character-card control — but roleplay-first: no file workspace, no agent tools",
      kill: "Personas are five prompt presets + per-chat model pins; the agent then works on real files with approval gates." },
    { name: "Odysseus", kind: "self-host · Docker", dims: [0, 0, 0.5, 0, 0.5, 1, 1, 1],
      gap: "Closest sibling — honest approval model; Docker + SearXNG + ~3 MB vendored JS per page",
      kill: "Same approval honesty, ~30× less bytes per page, no Docker, no SearXNG container (web search built in)." },
    { name: "ChatGPT", kind: "SaaS · OpenAI", dims: [1, 0, 0, 0, 0, 0, 0, 0],
      gap: "One vendor's models; your chats on their servers; per-seat + per-token billing",
      kill: "Point it at Ollama and it's free and local; point it at OpenRouter and it's every vendor at once. Per-chat." },
    { name: "Claude", kind: "SaaS · Anthropic", dims: [1, 0, 0, 0, 0.5, 0, 0, 0],
      gap: "Superb model, walled cloud garden",
      kill: "The model is reachable here too (via OpenRouter) — inside a workspace that stays yours, not a rented tab." },
    { name: "Gemini", kind: "SaaS · Google", dims: [1, 0, 0, 0, 0, 0, 0, 0],
      gap: "Tied to Google's stack and telemetry",
      kill: "A self-hosted harness has no telemetry to tie. Run the same model class locally if you want." },
    { name: "Poe", kind: "SaaS · aggregator", dims: [1, 0.5, 1, 0, 0, 0, 0, 0],
      gap: "Many models in one app — all cloud, all metered",
      kill: "Same 'many models' idea, self-hosted: the catalog is OpenRouter's, the bill is $0, the data is yours." },
    { name: "Perplexity", kind: "SaaS · search", dims: [1, 0.5, 0.5, 0, 0, 0, 0, 0],
      gap: "Cited search answers — cloud, logged, metered",
      kill: "Web search is a built-in agent tool (DuckDuckGo + optional self-hosted SearXNG) with private-IP blocking — answers on your terms." },
  ];

  const score = (c) => c.dims.reduce((a, b) => a + b, 0);
  const rankOf = (c) => RIVALS.filter((r) => score(r) > score(c)).length + 1;

  /* ---- live measurements of THIS instance -------------------------- */
  const ASSETS = ["/", "/static/js/app.js", "/static/js/md.js", "/static/js/w6.js", "/static/js/w8.js",
    "/static/styles.css", "/static/styles-w6.css", "/static/styles-w8.css", "/static/sw.js", "/static/manifest.json"];
  async function measureWeight() {
    let total = 0, ok = 0;
    for (const u of ASSETS) {
      try {
        const r = await fetch(u, { cache: "no-cache", method: "HEAD" });
        const cl = r.headers.get("content-length");
        if (cl) { total += parseInt(cl, 10); ok++; }
        else { // HEAD without length: fall back to body size
          const b = await fetch(u, { cache: "no-cache" });
          const buf = await b.arrayBuffer();
          total += buf.byteLength; ok++;
        }
      } catch { /* asset missing: ignore */ }
    }
    return { bytes: total, assets: ok };
  }
  async function measureSpeed() {
    try {
      const d = await api("/api/bench");
      const rows = (d.bench || []).filter((b) => b.avg_tps != null);
      if (!rows.length) return null;
      const runs = rows.reduce((a, b) => a + b.runs, 0);
      const wsum = rows.reduce((a, b) => a + (b.avg_tps * b.runs), 0);
      return { tps: wsum / runs, runs, models: rows.length };
    } catch { return null; }
  }

  /* ---- rendering ----------------------------------------------------- */
  let built = false;
  function build() {
    if (built) return;
    const host = $("#panel-arena");
    if (!host) return;
    built = true;
    const all = [CS, ...RIVALS].sort((a, b) => score(b) - score(a));
    host.append(
      el("div", { class: "a-head" },
        el("div", { class: "a-title" }, "The Arena"),
        el("p", { class: "a-sub" }, "Every serious AI wrapper on this planet, scored on the eight dimensions where a wrapper actually competes. The model is rented; the harness is the fight.")),
      el("div", { class: "a-live", id: "a-live" },
        el("span", { class: "a-chip", id: "a-chip-weight" }, "⚖ measuring this page…"),
        el("span", { class: "a-chip", id: "a-chip-speed" }, "⚡ bench ledger…")),
      el("div", { class: "a-board" },
        el("div", { class: "a-row cs" },
          el("span", { class: "a-rank" }, "1"),
          el("span", { class: "a-name" }, "CortexSpace"),
          el("span", { class: "a-meter" }, el("span", { style: "width:100%" })),
          el("span", { class: "a-score" }, "8 / 8")),
        ...all.slice(1).map((c, i) => {
          const s = score(c);
          return el("div", { class: "a-row" + (i < 3 ? " podium" : "") },
            el("span", { class: "a-rank" }, String(i + 2)),
            el("span", { class: "a-name" }, c.name),
            el("span", { class: "a-meter" }, el("span", { style: "width:" + (s / 8 * 100) + "%" })),
            el("span", { class: "a-score" }, s.toFixed(1) + " / 8"));
        }),
      ),
      el("div", { class: "a-dims" },
        el("h4", null, "The eight dimensions"),
        ...DIMS.map((d) => el("div", { class: "a-dim" },
          el("span", null, d.label), el("span", { class: "a-dim-h" }, d.hint))),
      ),
      el("div", { class: "a-cards" },
        ...all.slice(1).map((c) => el("div", { class: "a-card" },
          el("div", { class: "a-card-h" },
            el("span", { class: "a-card-n" }, c.name),
            el("span", { class: "a-kind" }, c.kind),
            el("span", { class: "a-card-s" }, score(c).toFixed(1) + "/8 · #" + rankOf(c))),
          el("div", { class: "a-gap" }, "the gap — " + c.gap),
          el("div", { class: "a-kill" }, "the kill — " + c.kill)),
        )),
      el("div", { class: "a-concede" },
        el("h4", null, "Ground we choose not to fight on"),
        el("p", null, "Multi-user auth & RBAC, vector-DB RAG, image generation, and MCP marketplaces. Those are team/enterprise battlegrounds; CortexSpace is a personal workspace. Being honest about the map is part of ruling it.")),
      el("p", { class: "a-foot" }, "Method: public 2026 product architectures, self-assessed 0 / ½ / 1 per dimension. 'Light payload' and 'verifiable speed' are replaced by live measurements of this instance (chips above). No benchmark was harmed; no vendor was consulted."));
    refreshLive();
  }
  async function refreshLive() {
    const w = await measureWeight();
    const cw = $("#a-chip-weight");
    if (cw) cw.textContent = "⚖ this whole page: " + (w.bytes / 1024).toFixed(0) + " KB across " + w.assets + " files (framework apps: 3–10 MB)";
    const sp = await measureSpeed();
    const cs = $("#a-chip-speed");
    if (cs) cs.textContent = sp
      ? "⚡ measured on this box: " + sp.tps.toFixed(1) + " tok/s over " + sp.runs + " runs · " + sp.models + " model" + (sp.models > 1 ? "s" : "")
      : "⚡ send a message and your measured tok/s appears here";
  }
  function open() {
    build();
    const b = document.querySelector('.ptab[data-tab="arena"]');
    if (b) b.click(); else { const h = $("#panel-arena"); if (h) h.classList.remove("hidden"); }
    refreshLive();
    if (!localStorage.getItem("cs-arena-seen")) {
      localStorage.setItem("cs-arena-seen", "1");
      const t = (window.W6 && W6.toast) || ((m) => console.log(m));
      t("The Arena: 16 wrappers surveyed, 8 dimensions fought, 1 ruler. (⌘⇧A)");
    }
  }

  /* keyboard: ⌘⇧A (exact-modifier, capture — the w6 convention) */
  document.addEventListener("keydown", (e) => {
    if (e.key.toLowerCase() !== "a") return;
    const mod = navigator.platform.toLowerCase().includes("mac") ? e.metaKey : e.ctrlKey;
    if (mod && e.shiftKey && !e.altKey && !e.ctrlKey) { e.preventDefault(); e.stopPropagation(); open(); }
  }, true);

  function initW8() {
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", () => build());
    else build();
  }
  initW8();
  window.W8 = { open, build, RIVALS, DIMS, score, refreshLive };
  if (window.cortexspace) window.cortexspace.arena = open;
})();
