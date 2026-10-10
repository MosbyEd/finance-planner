// Обновляет iOS-оболочку: прописывает адрес этого компьютера в локальной сети.
//   npm run ios:sync            — имя компьютера в сети (*.local) определяется автоматически
//   CAP_SERVER_URL=http://192.168.1.10:3001 npm run ios:sync
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
    // Строчными: адрес страницы WebView приводит к нижнему регистру, а Capacitor сравнивает хост
    // с server.url с учётом регистра — иначе переход считается внешним и открывается Safari.
    return name ? `${name.toLowerCase()}.local` : null;
  } catch {
    return null;
  }
}

const host = process.env.CAP_SERVER_HOST ?? bonjourName() ?? lanAddress();
const url = process.env.CAP_SERVER_URL ?? `http://${host}:3001`;
if (!url || url.includes("undefined")) {
  console.error("Не удалось определить адрес в локальной сети. Задайте CAP_SERVER_URL.");
  process.exit(1);
}
console.log(`iOS-приложение будет открывать ${url}`);
// Экран «нет связи» внутри приложения повторяет подключение по этому адресу.
fs.writeFileSync(new URL("../capacitor-shell/config.js", import.meta.url), `window.SERVER_URL = ${JSON.stringify(url)};\n`);
execSync("npx cap sync ios", { stdio: "inherit", env: { ...process.env, CAP_SERVER_URL: url } });
