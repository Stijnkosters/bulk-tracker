const CACHE = "bulk-v1";
const ASSETS = ["/", "/index.html", "/manifest.json", "/icon.svg"];
self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
  self.skipWaiting();
});
self.addEventListener("activate", (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))));
  self.clients.claim();
});
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  // API altijd live, nooit cachen
  if (url.pathname.startsWith("/api/")) return;
  e.respondWith(
    fetch(e.request).then((r) => r).catch(() => caches.match(e.request).then((m) => m || caches.match("/")))
  );
});
