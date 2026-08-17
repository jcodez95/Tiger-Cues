// service-worker.js — caches the app shell so the interface (not user audio
// files) is available offline and the app can be installed to the home screen.
//
// Strategy: cache-first for shell assets, with a network-fallback for
// anything not precached. Bump CACHE_NAME whenever shell files change so
// clients pick up the new version instead of serving stale cached files.

const CACHE_NAME = "cuesheet-shell-v11";

const SHELL_ASSETS = [
  "./",
  "./index.html",
  "./manifest.json",
  "./base.css",
  "./library.css",
  "./timeline.css",
  "./timestamps.css",
  "./player.css",
  "./app.js",
  "./db.js",
  "./fingerprint.js",
  "./audio-engine.js",
  "./timeline.js",
  "./scrub-rate.js",
  "./timestamp-list.js",
  "./timestamp-editor.js",
  "./metronome.js",
  "./onset-detect.js",
  "./tempo-detect.js",
  "./cuesheet-io.js",
  "./utils.js",
  "./library-view.js",
  "./player-view.js",
  "./icon-192.png",
  "./icon-512.png",
  "./icon-maskable-192.png",
  "./icon-maskable-512.png",
  "./apple-touch-icon.png",
  "./favicon.png",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS))
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  // Only handle GET requests for our own origin — never intercept audio
  // file blobs (object URLs) or cross-origin requests.
  if (event.request.method !== "GET") return;

  const url = new URL(event.request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request)
        .then((response) => {
          // Opportunistically cache new same-origin shell assets as they're fetched.
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => {
          // Offline and not cached: fall back to the shell for navigations
          // so the app still opens (library screen) rather than erroring.
          if (event.request.mode === "navigate") {
            return caches.match("./index.html");
          }
          return Response.error();
        });
    })
  );
});
