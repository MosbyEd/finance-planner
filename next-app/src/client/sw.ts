"use client";

import { isNativeApp } from "./runtime";

/**
 * Регистрирует service worker (только в production) и передаёт ему файлы сборки, которые страница
 * уже загрузила, — чтобы приложение открылось без сети даже после первого визита или обновления.
 */
export function registerServiceWorker(): void {
  if (process.env.NODE_ENV !== "production" || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  // В iOS-приложении интерфейс и так лежит в пакете — офлайн-оболочка не нужна.
  if (isNativeApp()) return;
  const version = process.env.NEXT_PUBLIC_APP_VERSION ?? "dev";
  navigator.serviceWorker
    .register(`/sw.js?v=${encodeURIComponent(version)}`)
    .then(() => navigator.serviceWorker.ready)
    .then((registration) => {
      const urls = performance
        .getEntriesByType("resource")
        .map((entry) => entry.name)
        .filter((name) => name.includes("/_next/static/"));
      registration.active?.postMessage({ type: "cache-urls", urls });
    })
    .catch(() => {});
}
