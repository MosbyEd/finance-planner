"use client";

import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useRef, type ReactNode } from "react";
import { Card } from "../../ui/controls";
import { Icon, type IconName } from "../../ui/Icon";

/** Краткое состояние раздела справа в строке: «Подключено», «15 %». warning — нужно внимание. */
export interface RowSummary {
  text: string;
  tone?: "warning";
}

/** Разделы, открытые строкой списка, сообщают через него своё состояние (то, что знают только они сами). */
const RowContext = createContext<((summary: RowSummary | null) => void) | null>(null);

/**
 * Состояние раздела для его строки в списке настроек — то, что известно только самому разделу
 * (ответ сервера, разрешения iPhone, несохранённый черновик). null — сказать нечего: в строке остаётся
 * состояние, посчитанное списком. Вне строки ничего не делает.
 */
export function useRowSummary(summary: RowSummary | null): void {
  const report = useContext(RowContext);
  const text = summary?.text ?? null;
  const tone = summary?.tone;
  // До отрисовки, чтобы строка не мигала прежним состоянием.
  useLayoutEffect(() => {
    if (!report || text === null) return;
    report({ text, tone });
    return () => report(null);
  }, [report, text, tone]);
}

/** Пометка о несохранённом черновике формы раздела. */
export const UNSAVED_SUMMARY: RowSummary = { text: "Не сохранено", tone: "warning" };

/** Карточка раздела. В строке списка настроек — только содержимое: название уже в строке. */
export function SectionCard({ title, children }: { title: string; children: ReactNode }) {
  const inRow = useContext(RowContext) !== null;
  return inRow ? <>{children}</> : <Card title={title}>{children}</Card>;
}

/** Значки, которых нет в общем наборе (контур 24×24, как у Icon). */
const GLYPHS = {
  message: "M5 4h14a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2h-8l-5 4v-4H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2zM8 9h8M8 12.5h5",
  bell: "M6 16v-5a6 6 0 0 1 12 0v5l1.5 2h-15zM10 21h4",
  tag: "M3 4v7.2a1 1 0 0 0 .3.7l8.8 8.8a1 1 0 0 0 1.4 0l7.2-7.2a1 1 0 0 0 0-1.4L11.9 3.3a1 1 0 0 0-.7-.3H4a1 1 0 0 0-1 1zM8 8h.01",
  idCard: "M4 5h16a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1zM9 12a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM5.5 16.5a3.5 3.5 0 0 1 7 0M15 10h3M15 14h3",
  database:
    "M4 6c0-1.7 3.6-3 8-3s8 1.3 8 3-3.6 3-8 3-8-1.3-8-3zM4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3",
} as const;

export type RowIconName = IconName | keyof typeof GLYPHS;

function RowIcon({ name }: { name: RowIconName }) {
  return (
    <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-[10px] bg-accent-soft text-accent">
      {name in GLYPHS ? (
        <svg
          width={18}
          height={18}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
          focusable="false"
        >
          <path d={GLYPHS[name as keyof typeof GLYPHS]} />
        </svg>
      ) : (
        <Icon name={name as IconName} size={18} />
      )}
    </span>
  );
}

/** Группа строк — одна карточка, как группы в Настройках iOS. */
export function SettingsGroup({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ul aria-label={label} className="surface-card overflow-hidden rounded-[28px]">
      {children}
    </ul>
  );
}

/** Строка раздела: значок, название, краткое состояние и «›»; нажатие открывает раздел отдельной страницей. */
export function SettingsRow({
  icon,
  title,
  summary,
  onOpen,
  divider,
}: {
  icon: RowIconName;
  title: string;
  summary?: RowSummary | null;
  onOpen: () => void;
  /** Разделитель сверху — у всех строк группы, кроме первой. */
  divider: boolean;
}) {
  return (
    <li className="relative">
      {divider && <span aria-hidden="true" className="absolute left-16 right-0 top-0 h-px bg-separator" />}
      <button
        type="button"
        onClick={onOpen}
        className="flex min-h-[3.25rem] w-full items-center gap-3 px-4 py-2 text-left transition-colors hover:bg-surface-2 focus-visible:-outline-offset-2 sm:px-5"
      >
        <RowIcon name={icon} />
        {/* Название не переносится; не помещается — сокращается состояние (например, длинный логин). */}
        <span className="max-w-[70%] shrink-0 text-[15px] font-medium leading-snug">{title}</span>
        <span className="flex min-w-0 flex-1 items-center justify-end gap-1.5">
          {summary && (
            <span className="min-w-0 truncate text-[15px]">
              <span className="sr-only">, </span>
              <span className={summary.tone === "warning" ? "text-warning" : "text-muted"}>{summary.text}</span>
            </span>
          )}
          <Icon name="chevronRight" size={18} className="shrink-0 text-muted" />
        </span>
      </button>
    </li>
  );
}

/**
 * Раздел настроек — отдельная страница: «‹ Настройки» и название сверху. Разделы смонтированы и скрыты,
 * пока закрыты: черновики форм не теряются, а разделы сами сообщают состояние для своей строки (onReport).
 */
export function SettingsSection({
  id,
  title,
  open,
  onBack,
  onReport,
  children,
}: {
  id: string;
  title: string;
  open: boolean;
  onBack: () => void;
  /** Постоянная функция: раздел сообщает через неё состояние для своей строки. */
  onReport: (id: string, summary: RowSummary | null) => void;
  children: ReactNode;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const report = useCallback((summary: RowSummary | null) => onReport(id, summary), [id, onReport]);
  useEffect(() => {
    if (!open) return;
    window.scrollTo({ top: 0 });
    headingRef.current?.focus({ preventScroll: true });
  }, [open]);
  return (
    <section hidden={!open} aria-labelledby={`settings-${id}`} className="space-y-4">
      <div className="space-y-1">
        <button
          type="button"
          onClick={onBack}
          className="-ml-2 inline-flex min-h-11 items-center gap-0.5 rounded-full px-2 text-[15px] font-medium text-accent hover:bg-fill"
        >
          <Icon name="chevronLeft" size={20} />
          Настройки
        </button>
        <h2 ref={headingRef} id={`settings-${id}`} tabIndex={-1} className="px-1 text-[22px] font-bold leading-tight outline-none">
          {title}
        </h2>
      </div>
      <Card>
        <RowContext.Provider value={report}>{children}</RowContext.Provider>
      </Card>
    </section>
  );
}
