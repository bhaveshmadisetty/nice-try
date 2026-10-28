// Offline shell for the phone app. Tasks themselves live in localStorage; this
// only has to make sure the page and its bundle open without a network.
// - Hashed /assets/ files never change, so they are served cache-first.
//   (Icons are cache-first too: bump CACHE if one is replaced.)
// - The page is network-first with a short timeout: a slow mobile connection
//   falls back to the cached copy instead of hanging on a blank screen.
const CACHE = "nice-try-shell-v2";
const STATIC = ["/manifest.webmanifest", "/icon.png", "/logo-mark.png"];
const isAsset = url => url.origin === self.location.origin && (url.pathname.startsWith("/assets/") || STATIC.includes(url.pathname));
const assetsIn = html => [...html.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)].map(m => m[1]);

async function store(cache, url, response) {
  if (response.ok && !response.redirected) await cache.put(url, response);
}
// Cache a fresh page and everything it references, then drop bundles no page uses.
async function refreshShell(response) {
  const cache = await caches.open(CACHE);
  const html = await response.clone().text();
  await store(cache, "/", response);
  const wanted = assetsIn(html);
  await Promise.all(wanted.map(async path => {
    if (await cache.match(path)) return;
    try { await store(cache, path, await fetch(path)); } catch {}
  }));
  for (const request of await cache.keys()) {
    const path = new URL(request.url).pathname;
    if (path.startsWith("/assets/") && !wanted.includes(path)) await cache.delete(request);
  }
}

self.addEventListener("install", event => event.waitUntil((async () => {
  const cache = await caches.open(CACHE);
  await Promise.all(STATIC.map(async path => { try { await store(cache, path, await fetch(path)); } catch {} }));
  try { await refreshShell(await fetch("/", { cache: "no-cache" })); } catch {}
  await self.skipWaiting();
})()));
self.addEventListener("activate", event => event.waitUntil((async () => {
  for (const key of await caches.keys()) if (key.startsWith("nice-try-shell-") && key !== CACHE) await caches.delete(key);
  await self.clients.claim();
})()));
// Pages still post this after load; anything the install step missed gets cached here.
self.addEventListener("message", event => {
  if (event.data?.type !== "CACHE_SHELL" || !Array.isArray(event.data.urls)) return;
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    await Promise.all(event.data.urls.map(async value => {
      try { const url = new URL(value); if (isAsset(url) && !(await cache.match(url.pathname))) await store(cache, url.pathname, await fetch(url)); } catch {}
    }));
  })());
});

self.addEventListener("fetch", event => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) return;
  if (event.request.mode === "navigate") {
    // Caching runs beside the response, never in front of it.
    let update = Promise.resolve();
    const network = fetch(event.request).then(response => {
      if (response.ok && !response.redirected) update = refreshShell(response.clone()).catch(() => {});
      return response;
    });
    event.waitUntil(network.then(() => update, () => {}));
    event.respondWith((async () => {
      const timeout = new Promise(resolve => setTimeout(resolve, 3000, null));
      const fast = await Promise.race([network.catch(() => null), timeout]);
      if (fast) return fast;
      const cached = await caches.match("/");
      if (cached) return cached;
      try { return await network; }
      catch { return new Response("Open Nice Try once while online to use it offline.", { status: 503, headers: { "Content-Type": "text/plain; charset=utf-8" } }); }
    })());
    return;
  }
  if (!isAsset(url)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const cached = await cache.match(url.pathname);
    if (cached) return cached;
    const response = await fetch(event.request);
    await store(cache, url.pathname, response.clone());
    return response;
  })());
});
