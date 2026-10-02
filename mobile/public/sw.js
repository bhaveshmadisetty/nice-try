const CACHE = "nice-try-shell-v1";
const isAsset = url => url.origin === self.location.origin && (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/_next/static/") || ["/icon.png", "/logo-mark.png", "/manifest.webmanifest"].includes(url.pathname));
self.addEventListener("message", event => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    const urls = ["/", "/manifest.webmanifest", "/icon.png", "/logo-mark.png", ...event.data.urls.filter(value => {
      try { return isAsset(new URL(value)); } catch { return false; }
    })];
    await Promise.all(urls.map(async url => {
      try { const response = await fetch(url); if (response.ok && !response.redirected) await cache.put(url, response); } catch {}
    }));
  })());
});
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("nice-try-shell-") && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  const shell = event.request.mode === "navigate" && url.pathname === "/";
  const asset = isAsset(url);
  if (!shell && !asset) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    try {
      const response = await fetch(event.request);
      if (response.ok && !response.redirected) await cache.put(shell ? "/" : event.request, response.clone());
      return response;
    } catch { return (await cache.match(shell ? "/" : event.request)) || new Response("Open Nice Try once while online to use it offline.", { status: 503 }); }
  })());
});
