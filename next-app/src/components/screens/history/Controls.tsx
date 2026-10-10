"use client";

import { useId, type ReactNode } from "react";
import { addDays, addMonths, formatMonth, isValidIsoDate, type IsoDate, type MonthKey } from "@/domain/dates";
import { IconButton } from "../../ui/Button";
import { Segmented } from "../../ui/controls";
import { controlClass } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { TYPE_FILTERS, type TypeFilter } from "./operations";

export type Mode = "day" | "month" | "period";

/**
 * Компактное поле даты без подписи над ним: подпись — рядом или в aria-label.
 * Поля по бокам уже обычных: в два поля «С» и «По» на 375 pt должна влезть дата вместе со значком календаря.
 */
const DATE_INPUT = `${controlClass.replace("px-3.5", "px-2")} h-11 min-w-0 appearance-none text-center [&::-webkit-date-and-time-value]:text-center`;

export function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        Поиск по названию и категории
      </label>
      <Icon
        name="search"
        size={18}
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        id={id}
        type="search"
        value={value}
        placeholder="Поиск по названию и категории"
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        className={`${controlClass} h-11 pl-10 ${value ? "pr-11" : ""} [&::-webkit-search-cancel-button]:hidden`}
      />
      {value && (
        <IconButton
          icon="close"
          label="Очистить поиск"
          size={44}
          className="absolute right-0 top-1/2 -translate-y-1/2 text-muted"
          onClick={() => onChange("")}
        />
      )}
    </div>
  );
}

/** Режим периода (день, месяц, свой период) и выбор самого дня, месяца или дат — две строки по 44–48 pt. */
export function PeriodPicker({
  mode,
  onModeChange,
  day,
  onDayChange,
  month,
  onMonthChange,
  from,
  onFromChange,
  to,
  onToChange,
  today,
  invalid,
}: {
  mode: Mode;
  onModeChange: (mode: Mode) => void;
  day: string;
  onDayChange: (value: string) => void;
  month: MonthKey;
  onMonthChange: (value: MonthKey) => void;
  from: string;
  onFromChange: (value: string) => void;
  to: string;
  onToChange: (value: string) => void;
  today: IsoDate;
  /** Даты заданы неверно — поля подсвечиваются, текст ошибки выводится под фильтрами. */
  invalid?: boolean;
}) {
  return (
    <div className="space-y-2">
      <Segmented
        label="Период"
        size="sm"
        value={mode}
        onChange={onModeChange}
        options={[
          { value: "day", label: "День" },
          { value: "month", label: "Месяц" },
          { value: "period", label: "Период" },
        ]}
      />
      {mode === "month" && (
        <Stepper
          prevLabel="Предыдущий месяц"
          nextLabel="Следующий месяц"
          onPrev={() => onMonthChange(addMonths(month, -1))}
          onNext={() => onMonthChange(addMonths(month, 1))}
        >
          <span className="block text-center text-[15px] font-semibold" aria-live="polite">
            {formatMonth(month)}
          </span>
        </Stepper>
      )}
      {mode === "day" && (
        <Stepper
          prevLabel="Предыдущий день"
          nextLabel="Следующий день"
          onPrev={() => onDayChange(addDays(isValidIsoDate(day) ? day : today, -1))}
          onNext={() => onDayChange(addDays(isValidIsoDate(day) ? day : today, 1))}
        >
          <input
            type="date"
            aria-label="Дата"
            value={day}
            aria-invalid={invalid || undefined}
            onChange={(e) => onDayChange(e.target.value)}
            className={DATE_INPUT}
          />
        </Stepper>
      )}
      {mode === "period" && (
        <div className="flex gap-2">
          <RangeInput label="С" value={from} onChange={onFromChange} invalid={invalid} />
          <RangeInput label="По" value={to} onChange={onToChange} invalid={invalid} />
        </div>
      )}
    </div>
  );
}

/** «‹ значение ›»: кнопки 44 × 44 по краям, значение по центру. */
function Stepper({
  prevLabel,
  nextLabel,
  onPrev,
  onNext,
  children,
}: {
  prevLabel: string;
  nextLabel: string;
  onPrev: () => void;
  onNext: () => void;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm items-center gap-1">
      <IconButton icon="chevronLeft" label={prevLabel} size={44} onClick={onPrev} />
      <div className="min-w-0 flex-1">{children}</div>
      <IconButton icon="chevronRight" label={nextLabel} size={44} onClick={onNext} />
    </div>
  );
}

function RangeInput({
  label,
  value,
  onChange,
  invalid,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  invalid?: boolean;
}) {
  return (
    <label className="flex min-w-0 flex-1 items-center gap-2">
      <span className="shrink-0 text-sm text-muted">{label}</span>
      <input
        type="date"
        value={value}
        aria-invalid={invalid || undefined}
        onChange={(e) => onChange(e.target.value)}
        className={DATE_INPUT}
      />
    </label>
  );
}

/**
 * Фильтр по типу — одна строка чипов с горизонтальной прокруткой (без переноса на вторую строку).
 * Касание — вся высота строки (44 pt), сам чип ниже (36 pt); рамка фокуса — вокруг чипа.
 */
export function TypeChips({ value, onChange }: { value: TypeFilter; onChange: (value: TypeFilter) => void }) {
  return (
    <div
      role="group"
      aria-label="Тип операций"
      className="-mx-4 flex scroll-px-4 gap-2 overflow-x-auto px-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TYPE_FILTERS.map((f) => {
        const selected = value === f.value;
        return (
          <button
            key={f.value}
            type="button"
            aria-pressed={selected}
            onClick={(e) => {
              onChange(f.value);
              // Чип у края — докручиваем, чтобы выбранный был виден целиком.
              const smooth = !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
              e.currentTarget.scrollIntoView({ block: "nearest", inline: "nearest", behavior: smooth ? "smooth" : "auto" });
            }}
            className="group flex h-11 shrink-0 items-center focus-visible:outline-none"
          >
            <span
              className={`inline-flex h-9 items-center whitespace-nowrap rounded-full border px-4 text-sm font-medium transition group-focus-visible:outline-2 group-focus-visible:outline-offset-2 group-focus-visible:outline-accent ${
                selected ? "sheen border-accent-fill bg-accent-fill text-on-accent" : "glass-control text-text"
              }`}
            >
              {f.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}
