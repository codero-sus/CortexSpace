#!/usr/bin/env node
/* ============================================================
   CortexSpace — DOM smoke test
   Loads the REAL served page in jsdom, executes ALL page scripts
   (app.js, md.js, plus the lazy-loaded w6.js/w8.js) against a live
   server, and asserts the UI actually initializes without errors.

   Why this exists: Wave 14b found six load-path bugs (a tab-freezing
   MutationObserver loop, a dataset SyntaxError, ...) that HTTP-level
   tests can never see. Run this after any frontend change:

       npm install
       npm run test:dom          # server must be running on :8787
   BASE=http://localhost:9999 npm run test:dom   # other port

   Exit code 0 = pass, 1 = fail.
   ============================================================ */
"use strict";
const { JSDOM, VirtualConsole } = require("jsdom");

const BASE = (process.env.BASE || "http://127.0.0.1:8787").replace(/\/+$/, "") + "/";
const WAIT_MS = 10000; // covers: parse + load + lazy w6/w8 (load event) + their 60ms init + first ticks

const failures = [];
const info = [];
function check(name, ok, detail) {
  if (ok) info.push("  PASS  " + name);
  else failures.push(name + (detail ? "  — " + detail : ""));
}

function stubs(window) {
  // --- browser APIs jsdom lacks; keep them minimal but shaped like the real thing ---
  window.matchMedia = window.matchMedia || ((q) => ({
    matches: false, media: q, onchange: null,
    addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {},
    dispatchEvent() { return false; },
  }));
  window.AudioContext = window.AudioContext || class {
    constructor() { this.state = "running"; this.currentTime = 0; this.destination = {}; }
    resume() { return Promise.resolve(); }
    createGain() { return { gain: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, disconnect() {} }; }
    createOscillator() { return { type: "sine", frequency: { value: 0, setValueAtTime() {}, linearRampToValueAtTime() {} }, connect() {}, start() {}, stop() {} }; }
  };
  window.speechSynthesis = window.speechSynthesis || {
    speak() {}, cancel() {}, getVoices() { return []; },
    paused: false, speaking: false, pending: false,
    addEventListener() {}, removeEventListener() {},
  };
  window.SpeechSynthesisUtterance = window.SpeechSynthesisUtterance || class {
    constructor(t) { this.text = t; }
    addEventListener() {}
  };
  window.Notification = window.Notification || class {
    static permission = "default";
    static requestPermission() { return Promise.resolve("denied"); }
    close() {}
    addEventListener() {}
  };
  window.URL.createObjectURL = window.URL.createObjectURL || (() => "blob:fake");
  window.URL.revokeObjectURL = window.URL.revokeObjectURL || (() => {});
  window.Element.prototype.scrollIntoView = window.Element.prototype.scrollIntoView || function () {};
  window.requestIdleCallback = window.requestIdleCallback || ((cb) => setTimeout(cb, 0));
  // node fetch bound into the page (relative URLs resolved against the live server)
  const nf = global.fetch;
  window.fetch = (url, opts) => nf(new URL(String(url), BASE).toString(), opts);
}

(async () => {
  // ---- preflight: is the server up? ----
  let health;
  try {
    health = await (await global.fetch(BASE + "api/health", { signal: AbortSignal.timeout(4000) })).json();
  } catch (e) {
    console.error("FATAL: cannot reach " + BASE + "api/health — start the server first (.venv/bin/uvicorn app.main:app --port 8787)");
    process.exit(2);
  }
  if (!health.ok) { console.error("FATAL: server reported not ok"); process.exit(2); }
  console.log("DOM smoke test — " + BASE + " (health ok, " + (health.model || "unknown model") + ")");

  const html = await (await global.fetch(BASE)).text();

  const errors = []; // window "error" events (uncaught exceptions in any script)
  const rejections = []; // unhandled promise rejections
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => {
    const msg = String(e.message || "");
    if (msg.includes("Not implemented")) return; // jsdom noise (navigation etc.)
    errors.push("jsdomError: " + ((e.detail && e.detail.stack) || e.stack || msg));
  });
  vc.on("error", (...a) => errors.push("console.error: " + a.map(String).join(" ").slice(0, 400)));

  const dom = new JSDOM(html, {
    url: BASE,
    runScripts: "dangerously",
    resources: "usable",
    pretendToBeVisual: true,
    virtualConsole: vc,
    beforeParse(window) { stubs(window); },
  });
  const w = dom.window;
  w.addEventListener("error", (e) => errors.push("window.onerror: " + ((e.error && e.error.stack) || e.message)));
  w.addEventListener("unhandledrejection", (e) => rejections.push((e.reason && e.reason.stack) || String(e.reason)));
  process.on("unhandledRejection", (r) => rejections.push("node-level: " + ((r && r.stack) || String(r))));

  // ---- wait for: parse, external scripts, window load, lazy w6/w8, their inits, first status ticks ----
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, WAIT_MS));
  const d = w.document;
  const q = (s) => d.querySelectorAll(s).length;

  // ---- assertions ----
  check("no uncaught script errors", errors.length === 0, errors.slice(0, 3).map((e) => e.split("\n")[0]).join(" | "));
  check("no unhandled rejections", rejections.length === 0, rejections.slice(0, 3).map((e) => e.split("\n")[0]).join(" | "));
  check("w6 module initialized (window.W6)", typeof w.W6 === "object");
  check("w8 module initialized (window.W8)", typeof w.W8 === "object");
  check("quick-actions row built (app.js init completed)", q("#qa-row .qa-chip") >= 4, "found " + q("#qa-row .qa-chip"));
  check("status bar chips built (w6 buildStatusBar ran)", q("#status-left .w6-chip") >= 8, "found " + q("#status-left .w6-chip"));
  check("status stream slot present (#status-stream)", !!d.getElementById("status-stream"));
  check("boot splash removed", !d.getElementById("splash") || d.getElementById("splash").classList.contains("gone"));
  check("event loop alive (wait completed — no infinite loops)", Date.now() - t0 < WAIT_MS + 5000);

  // ---- report ----
  console.log(info.join("\n"));
  if (failures.length) {
    console.log("\n" + failures.length + " FAILURE(S):");
    failures.forEach((f) => console.log("  FAIL  " + f));
    process.exit(1);
  }
  console.log("\nALL CHECKS PASSED (" + (Date.now() - t0) + " ms)");
  process.exit(0);
})().catch((e) => {
  console.error("TEST HARNESS FAIL:", (e && e.stack) || e);
  process.exit(2);
});
