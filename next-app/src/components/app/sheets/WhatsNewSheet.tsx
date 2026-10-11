"use client";

import { useEffect, useState } from "react";
import { formatDay } from "@/domain/dates";
import { useToday } from "@/client/react";
import { storage } from "@/client/storage";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { useUi } from "../overlays";
import { LATEST_RELEASE, RELEASES, type Release, type ReleaseItem } from "../whatsNew/releases";

const SEEN_KEY = "fp:whats-new-seen";

/** После обновления — один раз показать «Что нового». */
export function useWhatsNewPrompt(ready: boolean): void {
  const { open, overlay } = useUi();
  const free = overlay === null;
  useEffect(() => {
    // Ждём данных и закрытых окон: другое окно (например, проверка операций из СМС) не перебиваем.
    if (!ready || !free) return;
    if (storage.get(SEEN_KEY) === LATEST_RELEASE.id) return;
    open({ kind: "whatsNew" });
  }, [ready, free, open]);
}

export function WhatsNewSheet() {
  const { close } = useUi();
  const [shown, setShown] = useState(1);
  // Просмотрено — когда закрыли сами; перекрыло другое окно — покажем снова, когда оно закроется.
  const done = () => {
    storage.set(SEEN_KEY, LATEST_RELEASE.id);
    close();
  };

  return (
    <Sheet
      open
      onClose={done}
      title="Что нового"
      size="lg"
      footer={
        <Button className="w-full" onClick={done}>
          Понятно
        </Button>
      }
    >
      <div className="space-y-8">
        {RELEASES.slice(0, shown).map((release, i) => (
          <ReleaseView key={release.id} release={release} latest={i === 0} />
        ))}
        {shown < RELEASES.length && (
          <Button variant="secondary" className="w-full" onClick={() => setShown((n) => n + 1)}>
            Предыдущее обновление
          </Button>
        )}
      </div>
    </Sheet>
  );
}

function ReleaseView({ release, latest }: { release: Release; latest: boolean }) {
  const today = useToday();
  return (
    <section className="space-y-4" aria-label={`Обновление ${formatDay(release.date, today)}`}>
      <p className="text-sm text-muted">{latest ? `Обновление от ${formatDay(release.date, today)}` : formatDay(release.date, today)}</p>
      {release.items.map((item, index) => (
        <ItemCard key={item.title} item={item} index={index} />
      ))}
      {release.fixes && release.fixes.length > 0 && (
        <div className="whats-new-rise rounded-3xl bg-surface-2 p-4" style={{ ["--wn-delay" as string]: `${release.items.length * 90}ms` }}>
          <p className="font-medium">Исправления</p>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted">
            {release.fixes.map((fix) => (
              <li key={fix}>{fix}</li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function ItemCard({ item, index }: { item: ReleaseItem; index: number }) {
  return (
    <article
      className="whats-new-rise overflow-hidden rounded-3xl bg-surface-2"
      style={{ ["--wn-delay" as string]: `${index * 90}ms` }}
    >
      {item.demo === "dynamicIsland" && <DynamicIslandDemo />}
      {item.image && (
        <div className="whats-new-shot relative mx-4 mt-4 h-72 overflow-hidden rounded-2xl border border-border bg-bg">
          {/* eslint-disable-next-line @next/next/no-img-element -- снимки лежат в public и встроены в приложение */}
          <img src={item.image} alt={`Экран: ${item.title}`} loading="lazy" className="w-full" />
        </div>
      )}
      <div className="flex gap-3 p-4">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
          <Icon name={item.icon} size={18} />
        </span>
        <div className="min-w-0">
          <h3 className="font-semibold">{item.title}</h3>
          <p className="mt-1 text-[15px] text-muted">{item.text}</p>
        </div>
      </div>
    </article>
  );
}

/** Живая демонстрация Dynamic Island: помощник думает (таймер и полоса), потом — «Готово». */
function DynamicIslandDemo() {
  const [still] = useState(() => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [tick, setTick] = useState(still ? 4 : 0);
  useEffect(() => {
    if (still) return;
    const timer = setInterval(() => setTick((t) => (t + 1) % 10), 1000);
    return () => clearInterval(timer);
  }, [still]);
  // 0–6 с — думает, 7–9 — ответ готов.
  const ready = tick >= 7;
  const seconds = Math.min(tick, 6);
  return (
    <div className="flex h-44 items-start justify-center bg-gradient-to-b from-[#1b1d3a] to-[#2a2457] px-4 pt-4" aria-hidden="true">
      <div
        className={`flex w-full max-w-80 flex-col gap-2 rounded-[28px] bg-black px-4 text-white shadow-lg transition-all duration-500 ${
          ready ? "py-3" : "py-3.5"
        }`}
      >
        <div className="flex items-center gap-2 text-sm font-semibold">
          {ready ? (
            <span className="text-[#7cf0b8]">✓</span>
          ) : (
            <span className="whats-new-pulse text-[#9e99ff]">
              <Icon name="sparkles" size={16} />
            </span>
          )}
          <span className={ready ? "text-white" : "text-[#9e99ff]"}>Помощник</span>
          <span className={`ml-auto tabular-nums ${ready ? "text-[#7cf0b8]" : "text-[#9e99ff]"}`}>
            {ready ? "Готово" : `0:0${seconds}`}
          </span>
        </div>
        <p className="truncate text-sm text-white/80">
          {ready ? "Сегодня можно потратить 3 583 ₽ — всё по плану." : "«Сколько можно тратить до зарплаты?»"}
        </p>
        {ready ? (
          <p className="text-xs text-[#7cf0b8]">Нажмите, чтобы открыть ответ</p>
        ) : (
          <div className="h-1.5 overflow-hidden rounded-full bg-white/15">
            <div className="h-full rounded-full bg-[#9e99ff] transition-all duration-1000 ease-linear" style={{ width: `${(seconds / 6) * 100}%` }} />
          </div>
        )}
      </div>
    </div>
  );
}
