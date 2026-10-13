import { execSync } from "node:child_process";
import os from "node:os";
import type { NextConfig } from "next";

/** Адреса компьютера в локальной сети: с них dev-сервер открывают телефон и iOS-оболочка. */
function lanHosts(): string[] {
  const addresses = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal)
    .map((i) => i!.address);
  // Имя компьютера в локальной сети (Bonjour): iOS-оболочка открывает сервер по нему.
  const host = os.hostname().replace(/\.local$/i, "");
  return [...addresses, `${host}.local`, `${host.toLowerCase()}.local`];
}

const securityHeaders = [
  { key: "X-Content-Type-Options", value: "nosniff" },
  { key: "Referrer-Policy", value: "same-origin" },
  { key: "X-Frame-Options", value: "DENY" },
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
];

/** Версия сборки: по ней service worker отделяет кэш новой сборки от старой. */
const appVersion = process.env.APP_VERSION ?? Date.now().toString(36);

/** Коммит сборки — в «О приложении», чтобы сверить телефон с сервером. Не git-папка — пусто. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Сборка для сервера в облаке (scripts/deploy.sh): самодостаточный пакет в отдельной папке,
 * чтобы не трогать .next, из которого работает локальный сервер.
 */
const deployBuild = process.env.DEPLOY_BUILD === "1";

const nextConfig: NextConfig = {
  poweredByHeader: false,
  ...(deployBuild ? { output: "standalone" as const, distDir: ".next-deploy" } : {}),
  // База переносится отдельно (с остановкой сервера), а не внутри сборки; sharp не нужен — картинки не оптимизируются.
  outputFileTracingExcludes: { "*": ["data/**", "node_modules/sharp/**", "node_modules/@img/**"] },
  env: { NEXT_PUBLIC_APP_VERSION: appVersion, NEXT_PUBLIC_APP_COMMIT: gitCommit() },
  // Значок dev-инструментов перекрывает нижнее меню на телефоне.
  devIndicators: false,
  allowedDevOrigins: lanHosts(),
  // Оптимизатор картинок не нужен (иконки — статика) и в 16.3.x содержит известные уязвимости.
  images: { unoptimized: true },
  turbopack: {
    root: __dirname,
  },
  async headers() {
    return [
      { source: "/:path*", headers: securityHeaders },
      { source: "/sw.js", headers: [{ key: "Cache-Control", value: "no-cache" }] },
    ];
  },
};

export default nextConfig;
