// Service worker — exists so the panel is installable to a phone's home
// screen and so the shell loads instantly on a slow connection.
//
// Deliberately NOT an offline-first cache. It only ever touches same-origin
// GET requests; every cross-origin request (the Firebase SDK on gstatic, and
// above all Firestore's long-polling Listen channel) falls straight through
// to the network untouched. Proxying that channel through a service worker
// is a well-known way to break live snapshots, and caching auth responses
// would be worse.
//
// Strategy for the shell: network-first, cache as fallback. That means a
// republish is picked up on the next load rather than being pinned to a
// stale cached copy — the usual reason a PWA "won't update".

const CACHE = "fm-admin-v1";

const SHELL = [
  "./",
  "./index.html",
  "./style.css",
  "./app.js",
  "./firebase-config.js",
  "./manifest.json",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      // addAll() is all-or-nothing; a single 404 would abort the install and
      // leave the app permanently uninstallable, so each file is added on its
      // own and allowed to fail.
      .then((cache) => Promise.all(SHELL.map((url) => cache.add(url).catch(() => {}))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response && response.ok) {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, copy));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        // A navigation that missed the cache still needs *something* back, or
        // the browser shows its own offline error instead of the app shell.
        if (request.mode === "navigate") {
          const shell = await caches.match("./index.html");
          if (shell) return shell;
        }
        return Response.error();
      })
  );
});
