import type { CapacitorConfig } from "@capacitor/cli";

/**
 * iOS-оболочка для разработки: приложение открывает сервер на компьютере по локальной сети.
 * Адрес задаётся при синхронизации: CAP_SERVER_URL=http://192.168.1.80:3001 npx cap sync ios
 */
const serverUrl = process.env.CAP_SERVER_URL?.toLowerCase();
const serverHost = serverUrl ? new URL(serverUrl).host : undefined;

const config: CapacitorConfig = {
  appId: "ru.ekinosian.budget",
  appName: "Бюджет",
  webDir: "capacitor-shell",
  server: serverUrl
    ? {
        url: serverUrl,
        cleartext: serverUrl.startsWith("http://"),
        errorPath: "index.html",
        // Переходы на сервер (в том числе с экрана «нет связи») остаются внутри приложения.
        allowNavigation: serverHost ? [serverHost, new URL(serverUrl).hostname] : [],
      }
    : undefined,
  ios: {
    contentInset: "never",
  },
  plugins: {
    // Клавиатура сжимает окно — кнопки в нижних окнах остаются видны.
    Keyboard: { resize: "native", resizeOnFullScreen: true },
  },
};

export default config;
