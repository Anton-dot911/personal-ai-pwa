// Service worker: кешує оболонку застосунку і статичні ресурси.
// Запити до api.anthropic.com не кешуються і йдуть напряму в мережу.
const CACHE = "personal-ai-v1";
const SHELL = [
  "/",
  "/setup",
  "/chat",
  "/manifest.webmanifest",
  "/icon-192.png",
  "/icon-512.png",
  "/apple-touch-icon.png",
];

async function putCopy(request, response) {
  const cache = await caches.open(CACHE);
  cache.put(request, response.clone());
  return response;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  const url = new URL(request.url);

  if (request.method !== "GET" || url.origin !== self.location.origin) return;

  // Сторінки: мережа в першу чергу, без зв'язку — збережена копія.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => putCopy(request, response))
        .catch(() => caches.match(request).then((hit) => hit || caches.match("/chat")))
    );
    return;
  }

  // Статичні ресурси: спершу кеш.
  if (url.pathname.startsWith("/_next/static/") || /\.(png|webmanifest|svg|ico)$/.test(url.pathname)) {
    event.respondWith(
      caches.match(request).then(
        (hit) => hit || fetch(request).then((response) => putCopy(request, response))
      )
    );
  }
});
