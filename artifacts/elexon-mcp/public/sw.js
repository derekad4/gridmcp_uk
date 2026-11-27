// Grid MCP service worker: makes the app installable and keeps the app shell
// available offline. Live data, Ask and health checks always use the network.
const VERSION = "grid-mcp-v1";
const SHELL = `${VERSION}-shell`;
const STATIC = `${VERSION}-static`;
const scope = new URL(self.registration.scope);
const shellUrl = new URL("./", scope).href;
const offlineUrl = new URL("offline.html", scope).href;
const precache = [shellUrl, offlineUrl, "manifest.webmanifest", "favicon.svg", "icons/icon-192.png", "icons/icon-512.png"]
  .map((path) => new URL(path, scope).href);

self.addEventListener("install", (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL);
    await shell.addAll(precache);
    // Also cache the hashed scripts and styles the current shell references, so
    // the app opens offline even if it was installed on the very first visit.
    const html = await (await shell.match(shellUrl)).text();
    const assets = [...html.matchAll(/(?:src|href)="([^"]*\/assets\/[^"]+)"/g)].map((match) => new URL(match[1], scope).href);
    if (assets.length) await (await caches.open(STATIC)).addAll(assets);
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => !key.startsWith(VERSION)).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

function isLiveRequest(url) {
  // API responses (data, Ask, saved analyses, MCP) must never be served stale.
  return url.pathname.startsWith("/api/") || url.pathname === "/api" || url.pathname.startsWith("/mcp");
}

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== scope.origin || !url.href.startsWith(scope.href) || isLiveRequest(url)) return;

  if (request.mode === "navigate") {
    // Network first so a published update is picked up immediately; the cached
    // shell lets the installed app open without a connection.
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.ok) caches.open(SHELL).then((cache) => cache.put(shellUrl, response.clone()));
          return response;
        })
        .catch(async () => (await caches.match(shellUrl)) || (await caches.match(offlineUrl)) || Response.error()),
    );
    return;
  }

  // Built assets have content hashes in their names, so cached copies never go stale.
  if (url.pathname.includes("/assets/") || url.pathname.includes("/icons/") || /\.(?:svg|png|woff2?)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then((cached) => cached || fetch(request).then((response) => {
        if (response.ok) caches.open(STATIC).then((cache) => cache.put(request, response.clone()));
        return response;
      })),
    );
  }
});
