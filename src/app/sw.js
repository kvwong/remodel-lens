// Whim's service worker. Deliberately small: pages and data always come from the server first,
// so a restart with new code shows up on the next open. It adds two things:
//  1. a copy of the app shell to fall back on when the Mac mini is slow to answer or unreachable;
//  2. a short-lived stash of report pages requested on touch (smooth.js), served once on open.
const SHELL = "whim-shell-v1";
const SLOW_MS = 2500;
const STASH_MS = 15000;
const stash = new Map(); // url -> { at, response: Promise<Response> }

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    for (const name of await caches.keys()) if (name !== SHELL) await caches.delete(name);
    await self.clients.claim();
  })());
});

self.addEventListener("message", (event) => {
  const data = event.data;
  if (data?.type !== "prefetch" || typeof data.url !== "string") return;
  const url = new URL(data.url);
  if (url.origin !== self.location.origin || !url.pathname.endsWith("/report.html")) return;
  const fresh = stash.get(url.href);
  if (fresh && Date.now() - fresh.at < STASH_MS) return;
  const response = fetch(url.href, { credentials: "same-origin" }).then((r) => (r.ok ? r : Promise.reject(r)));
  response.catch(() => stash.delete(url.href));
  stash.set(url.href, { at: Date.now(), response });
});

const isShell = (url) => url.pathname === "/";

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET" || request.mode !== "navigate") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  const stashed = stash.get(url.href);
  if (stashed) {
    stash.delete(url.href);
    if (Date.now() - stashed.at < STASH_MS) {
      event.respondWith(stashed.response.then((r) => r.clone(), () => fetch(request)));
      return;
    }
  }

  if (!isShell(url)) return;
  event.respondWith((async () => {
    const network = fetch(request).then(async (response) => {
      if (response.ok) {
        const cache = await caches.open(SHELL);
        await cache.put("/", response.clone());
      }
      return response;
    });
    network.catch(() => {});
    const fallback = async () => (await caches.open(SHELL)).match("/");
    // Wait for the server first; only a slow or failed answer gets the saved copy.
    const slow = new Promise((resolve) => setTimeout(resolve, SLOW_MS, "slow"));
    try {
      const first = await Promise.race([network, slow]);
      if (first !== "slow") return first;
      return (await fallback()) ?? (await network);
    } catch {
      const saved = await fallback();
      if (saved) return saved;
      throw new Error("offline");
    }
  })());
});
