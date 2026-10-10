// Собирает интерфейс iOS-приложения (Vite → dist-app), прописывает адрес сервера и синхронизирует проект.
//   npm run ios:sync                                         — сервер этого компьютера в локальной сети
//   CAP_API_BASE=https://budget.example.ru npm run ios:sync — сервер в интернете
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

const apiBase = (process.env.CAP_API_BASE ?? `http://${bonjourName() ?? lanAddress()}:3001`).replace(/\/+$/, "");
if (!/^https?:\/\/[^/]+$/.test(apiBase)) {
  console.error(`Некорректный адрес сервера: ${apiBase}`);
  process.exit(1);
}
console.log(`Приложение будет обращаться к серверу ${apiBase}`);

execSync("npx vite build --config vite.config.mts", { stdio: "inherit" });
fs.writeFileSync(
  new URL("../dist-app/config.js", import.meta.url),
  `window.__BUDGET_CONFIG__ = ${JSON.stringify({ native: true, apiBase })};\n`,
);
execSync("npx cap sync ios", { stdio: "inherit" });
