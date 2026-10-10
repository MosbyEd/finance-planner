import type { CapacitorConfig } from "@capacitor/cli";

/**
 * iOS-приложение: интерфейс лежит в пакете (dist-app, сборка Vite) и открывается без сети,
 * данные ходят на сервер по адресу из dist-app/config.js (его пишет npm run ios:sync).
 *
 * Для отладки можно открыть интерфейс прямо с сервера разработки:
 *   CAP_SERVER_URL=http://macbook-air-15.local:3001 npx cap sync ios
 */
const devServerUrl = process.env.CAP_SERVER_URL?.toLowerCase();

const config: CapacitorConfig = {
  appId: "ru.ekinosian.budget",
  appName: "Бюджет",
  webDir: "dist-app",
  server: devServerUrl
    ? {
        url: devServerUrl,
        cleartext: devServerUrl.startsWith("http://"),
        allowNavigation: [new URL(devServerUrl).host, new URL(devServerUrl).hostname],
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
