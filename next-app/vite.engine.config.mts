import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

/**
 * Разбор СМС для iOS-приложения: один файл dist-app/sms-engine.js (IIFE), который приложение выполняет
 * во встроенном JavaScriptCore. Собирается после интерфейса (npm run ios:sync) и попадает в пакет вместе с ним.
 */
export default defineConfig({
  publicDir: false,
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  define: { "process.env.NODE_ENV": JSON.stringify("production") },
  build: {
    outDir: fileURLToPath(new URL("./dist-app", import.meta.url)),
    emptyOutDir: false,
    target: "safari15",
    minify: true,
    lib: {
      entry: fileURLToPath(new URL("./native/engine/sms-engine.ts", import.meta.url)),
      formats: ["iife"],
      name: "BudgetEngineBundle",
      fileName: () => "sms-engine.js",
    },
  },
});
