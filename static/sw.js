/* CortexSpace — minimal service worker:
   cache-first for static assets, network-first for the UI shell. */
const CACHE = "cortexspace-v7";
const SHELL = ["/", "/static/styles.css?v=7", "/static/styles-w6.css?v=7", "/static/styles-w8.css?v=7",
              "/static/js/app.js?v=7", "/static/js/md.js?v=7", "/static/js/w6.js?v=7", "/static/js/w8.js?v=7",
              "/static/favicon.svg", "/static/manifest.json"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).catch(() => {}));
  self.skipWaiting();
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
  );
  self.clients.claim();
});

self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.origin !== location.origin) return;
  if (url.pathname.startsWith("/api/")) return; // never cache API
  if (url.pathname.startsWith("/static/") || url.pathname === "/") {
    e.respondWith(
      fetch(e.request, {cache: "no-store"})
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
          return res;
        })
        .catch(() => caches.match(e.request).then((hit) => hit || caches.match("/")))
    );
    return;
  }
});
