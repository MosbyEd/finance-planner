import { App } from "@/components/app/App";

// Страница динамическая: в Next 16.3.x есть уязвимости отравления кэша статических (SSG/ISR) страниц.
export const dynamic = "force-dynamic";

export default function Page() {
  return <App />;
}
