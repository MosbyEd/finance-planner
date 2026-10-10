import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Бюджет — финансовый планировщик",
    short_name: "Бюджет",
    description: "Сколько можно потратить сегодня, регулярные платежи, цели и прогноз остатка.",
    start_url: "/",
    display: "standalone",
    background_color: "#f4f4f1",
    theme_color: "#f4f4f1",
    lang: "ru",
    icons: [
      { src: "/icon.svg", sizes: "any", type: "image/svg+xml" },
      { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
      { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
