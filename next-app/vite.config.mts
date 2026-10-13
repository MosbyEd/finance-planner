import { execSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

/** Коммит сборки — в «О приложении», чтобы сверить телефон с сервером. Не git-папка — пусто. */
function gitCommit(): string {
  try {
    return execSync("git rev-parse --short HEAD", { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

/**
 * Сборка интерфейса для iOS-приложения (Capacitor): статические файлы в dist-app,
 * которые приложение открывает из своего пакета — без сети тоже.
 */
export default defineConfig(({ mode }) => ({
  root: fileURLToPath(new URL("./native", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  define: {
    "process.env.NODE_ENV": JSON.stringify(mode === "development" ? "development" : "production"),
    "process.env.NEXT_PUBLIC_APP_VERSION": JSON.stringify(process.env.APP_VERSION ?? Date.now().toString(36)),
    "process.env.NEXT_PUBLIC_APP_COMMIT": JSON.stringify(gitCommit()),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist-app", import.meta.url)),
    emptyOutDir: true,
    target: "safari15",
    chunkSizeWarningLimit: 1000,
    rollupOptions: {
      onwarn(warning, warn) {
        // Директива "use client" нужна Next.js, сборщику приложения она не мешает.
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") return;
        warn(warning);
      },
    },
  },
}));
