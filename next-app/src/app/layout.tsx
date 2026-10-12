import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Бюджет — личный финансовый планировщик",
  description: "Сколько можно потратить сегодня, регулярные платежи, цели, долги и прогноз остатка.",
  applicationName: "Бюджет",
  appleWebApp: { capable: true, title: "Бюджет", statusBarStyle: "default" },
  formatDetection: { telephone: false },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  // Поле с мелким шрифтом в фокусе — iOS увеличивает страницу, и она начинает листаться вбок. Увеличение
  // жестом в Safari остаётся (его iOS не отключает).
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f4f4f1" },
    { media: "(prefers-color-scheme: dark)", color: "#111110" },
  ],
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ru">
      <body className="antialiased">{children}</body>
    </html>
  );
}
