"use client";

import { useId, type ReactNode } from "react";
import { Icon } from "../../ui/Icon";

/**
 * Пометка у кнопки «Сохранить» в формах настроек. Живая область есть всегда, меняется только текст —
 * так экранный диктор объявит появление пометки, а вёрстка выше не сдвигается.
 */
export function UnsavedHint({ dirty }: { dirty: boolean }) {
  return (
    <span role="status" className="text-sm text-muted">
      {dirty ? "Есть несохранённые изменения" : ""}
    </span>
  );
}

/** Целое число в диапазоне или null. */
export function parseIntInRange(text: string, min: number, max: number): number | null {
  const t = text.trim();
  if (!/^\d{1,3}$/.test(t)) return null;
  const n = Number(t);
  return n >= min && n <= max ? n : null;
}

/** Чип-переключатель (для выбора нескольких категорий). */
export function ToggleChip({ label, pressed, onToggle }: { label: string; pressed: boolean; onToggle: () => void }) {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onToggle}
      className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm transition ${
        pressed ? "border-accent bg-accent-soft text-accent" : "border-border bg-surface text-text hover:bg-surface-2"
      }`}
    >
      {pressed && <Icon name="check" size={14} />}
      {label}
    </button>
  );
}

/** Группа чипов-переключателей с подписью. */
export function ChipGroup({
  label,
  hint,
  error,
  children,
}: {
  label: string;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">{children}</div>
      {error ? (
        <p className="text-sm text-negative" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p className="text-xs text-muted">{hint}</p>
      ) : null}
    </fieldset>
  );
}

/**
 * Выбор одного варианта чипами. В отличие от Segmented переносится на новую строку,
 * поэтому длинные подписи помещаются и на узком экране.
 */
export function ChoiceChips<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (value: T) => void;
}) {
  const id = useId();
  return (
    <div className="space-y-1.5">
      <p id={id} className="text-sm font-medium text-muted">
        {label}
      </p>
      <div role="radiogroup" aria-labelledby={id} className="flex flex-wrap gap-2">
        {options.map((o) => (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={value === o.value}
            onClick={() => onChange(o.value)}
            className={`h-10 rounded-full border px-3.5 text-sm transition ${
              value === o.value
                ? "border-accent bg-accent text-accent-text"
                : "border-border bg-surface text-text hover:bg-surface-2"
            }`}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** Раскрывающийся блок внутри карточки. */
export function Disclosure({
  label,
  open,
  onToggle,
  danger,
  children,
}: {
  label: string;
  open: boolean;
  onToggle: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="rounded-2xl border border-border">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={onToggle}
        className={`flex min-h-12 w-full items-center gap-2 rounded-2xl px-4 text-left text-[15px] font-medium hover:bg-surface-2 ${
          danger ? "text-negative" : ""
        }`}
      >
        <span className="flex-1">{label}</span>
        <Icon name="chevronDown" size={18} className={`shrink-0 transition ${open ? "rotate-180" : ""}`} />
      </button>
      {open && (
        <div id={id} className="border-t border-border px-4 py-4">
          {children}
        </div>
      )}
    </div>
  );
}
