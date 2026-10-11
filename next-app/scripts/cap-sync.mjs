// Собирает интерфейс iOS-приложения (Vite → dist-app), прописывает адрес сервера и синхронизирует проект.
//   npm run ios:sync                                         — сервер из .env.deploy (DEPLOY_URL), если он задан,
//                                                              иначе сервер этого компьютера в локальной сети
//   CAP_API_BASE=https://budget.example.ru npm run ios:sync — явно указанный сервер
import { execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";

function lanAddress() {
  const candidates = Object.values(os.networkInterfaces())
    .flat()
    .filter((i) => i && i.family === "IPv4" && !i.internal);
  return candidates.find((i) => /^(192\.168|10\.|172\.(1[6-9]|2\d|3[01]))/.test(i.address))?.address ?? candidates[0]?.address;
}

/** Имя компьютера в локальной сети (Bonjour, *.local) — не меняется, в отличие от IP-адреса. */
function bonjourName() {
  if (process.platform !== "darwin") return null;
  try {
    const name = execSync("scutil --get LocalHostName", { encoding: "utf8" }).trim();
    return name ? `${name.toLowerCase()}.local` : null;
  } catch {
    return null;
  }
}

/** Адрес сервера в облаке из .env.deploy — тот же, куда выкладывает scripts/deploy.sh. */
function deployUrl() {
  try {
    const text = fs.readFileSync(new URL("../.env.deploy", import.meta.url), "utf8");
    return /^DEPLOY_URL=(.+)$/m.exec(text)?.[1].trim().replace(/^["']|["']$/g, "") || null;
  } catch {
    return null;
  }
}

const apiBase = (process.env.CAP_API_BASE ?? deployUrl() ?? `http://${bonjourName() ?? lanAddress()}:3001`).replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(apiBase)) {
  console.error(`Некорректный адрес сервера: ${apiBase}`);
  process.exit(1);
}
console.log(`Приложение будет обращаться к серверу ${apiBase}`);

execSync("npx vite build --config vite.config.mts", { stdio: "inherit" });
// Разбор СМС на телефоне (JavaScriptCore) — отдельный файл рядом с интерфейсом.
execSync("npx vite build --config vite.engine.config.mts", { stdio: "inherit" });
// Картинки «Что нового» из public (сборка приложения public не копирует: там и файлы сервера).
fs.cpSync(new URL("../public/whats-new", import.meta.url), new URL("../dist-app/whats-new", import.meta.url), { recursive: true });
fs.writeFileSync(
  new URL("../dist-app/config.js", import.meta.url),
  `window.__BUDGET_CONFIG__ = ${JSON.stringify({ native: true, apiBase })};\n`,
);
execSync("npx cap sync ios", { stdio: "inherit" });

// Capacitor пишет в свой пакет первую IPHONEOS_DEPLOYMENT_TARGET из проекта — теперь это 26.0 виджета,
// а .v26 не знает swift-tools-version 5.9 этого пакета. Пакету плагинов достаточно прежней iOS 15.
const spmPackage = new URL("../ios/App/CapApp-SPM/Package.swift", import.meta.url);
fs.writeFileSync(spmPackage, fs.readFileSync(spmPackage, "utf8").replace(/\.iOS\(\.v\d+\)/, ".iOS(.v15)"));
