// Service worker: приложение открывается без сети.
// Страницы — сначала сеть, при ошибке — сохранённая копия «/». Статика Next с хэшами в именах — сначала кэш.
// API никогда не кэшируется: данные синхронизирует само приложение.
// Версия сборки приходит в адресе регистрации (/sw.js?v=...): у каждой сборки свой кэш, старые удаляются.
const VERSION = new URL(self.location.href).searchParams.get("v") || "dev";
const CACHE = `budget-${VERSION}`;
const PRECACHE = ["/", "/manifest.webmanifest", "/icon.svg"];

function cacheable(response) {
  return response && response.ok && response.type === "basic" && !response.redirected;
}

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(PRECACHE))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const current = await caches.open(CACHE);
      const old = (await caches.keys()).filter((k) => k.startsWith("budget-") && k !== CACHE);
      // Статику новой сборки могла успеть закэшировать прежняя версия воркера — переносим её, а не теряем.
      for (const name of old) {
        const cache = await caches.open(name);
        for (const request of await cache.keys()) {
          if (new URL(request.url).pathname.startsWith("/_next/static/") && !(await current.match(request))) {
            const response = await cache.match(request);
            if (response) await current.put(request, response);
          }
        }
        await caches.delete(name);
      }
      await self.clients.claim();
    })(),
  );
});

// Страница сообщает, какие файлы сборки она уже загрузила (до того, как воркер начал её обслуживать).
self.addEventListener("message", (event) => {
  const data = event.data;
  if (!data || data.type !== "cache-urls" || !Array.isArray(data.urls)) return;
  event.waitUntil(
    caches.open(CACHE).then((cache) =>
      Promise.all(
        data.urls
          .filter((u) => typeof u === "string")
          .map((u) => new URL(u, self.location.origin))
          .filter((u) => u.origin === self.location.origin && u.pathname.startsWith("/_next/static/"))
          .slice(0, 300)
          .map((u) =>
            cache.match(u.href).then((hit) =>
              hit ? undefined : fetch(u.href).then((r) => (cacheable(r) ? cache.put(u.href, r) : undefined)).catch(() => {}),
            ),
          ),
      ),
    ),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin || url.pathname.startsWith("/api/")) return;

  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          // Сохраняем только нормальную страницу приложения, а не 404/502 или редирект.
          if (url.pathname === "/" && cacheable(response)) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put("/", copy));
          }
          return response;
        })
        .catch(() => caches.match("/", { cacheName: CACHE }).then((cached) => cached || Response.error())),
    );
    return;
  }

  // Неизменяемая статика сборки и иконки — из кэша этой версии.
  const immutable = url.pathname.startsWith("/_next/static/");
  const asset = url.pathname === "/manifest.webmanifest" || /^\/(icon|apple-icon)[^/]*\.(png|svg)$/.test(url.pathname);
  if (!immutable && !asset) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((response) => {
            if (cacheable(response)) cache.put(request, response.clone());
            return response;
          }),
      ),
    ),
  );
});
