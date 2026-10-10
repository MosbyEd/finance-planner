// Точка входа интерфейса для iOS-приложения: тот же App, что и на сайте, но без Next.js —
// интерфейс лежит в пакете приложения и открывается без сети.
import { createRoot } from "react-dom/client";
import { App } from "@/components/app/App";
import "@/app/globals.css";

createRoot(document.getElementById("root")!).render(<App />);
