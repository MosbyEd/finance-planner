"use client";

import { useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { formatMoney, type Kopecks } from "@/domain/money";

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  label,
  size = "md",
  disabled,
}: {
  value: T;
  onChange: (value: T) => void;
  options: { value: T; label: ReactNode }[];
  label: string;
  size?: "sm" | "md";
  disabled?: boolean;
}) {
  const groupRef = useRef<HTMLDivElement>(null);
  const selectedIndex = options.findIndex((o) => o.value === value);

  // Как у радиокнопок: стрелки двигают выбор, Tab попадает только на выбранный вариант.
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (disabled || !options.length) return;
    const current = selectedIndex < 0 ? 0 : selectedIndex;
    let next: number | null = null;
    if (e.key === "ArrowRight" || e.key === "ArrowDown") next = (current + 1) % options.length;
    else if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
    else if (e.key === "Home") next = 0;
    else if (e.key === "End") next = options.length - 1;
    if (next === null) return;
    e.preventDefault();
    onChange(options[next].value);
    groupRef.current?.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next]?.focus();
  };

  return (
    <div
      ref={groupRef}
      role="radiogroup"
      aria-label={label}
      aria-disabled={disabled || undefined}
      onKeyDown={onKeyDown}
      className={`relative isolate flex rounded-full bg-fill p-1 ${disabled ? "opacity-70" : ""}`}
    >
      {/* «Линза» под выбранным вариантом: варианты одной ширины, поэтому она просто сдвигается на свою долю. */}
      {selectedIndex >= 0 && (
        <span
          aria-hidden
          className="glass-lens pointer-events-none absolute inset-y-1 left-1 -z-10 rounded-full transition-transform duration-300 ease-[cubic-bezier(0.3,1.25,0.5,1)] motion-reduce:transition-none"
          style={{
            width: `calc((100% - 0.5rem) / ${options.length})`,
            transform: `translateX(${selectedIndex * 100}%)`,
          }}
        />
      )}
      {options.map((o, i) => {
        const checked = value === o.value;
        const focusable = checked || (selectedIndex < 0 && i === 0);
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={focusable ? 0 : -1}
            disabled={disabled && !checked}
            onClick={() => {
              if (!disabled) onChange(o.value);
            }}
            className={`min-w-0 flex-1 rounded-full px-2 font-medium leading-tight transition-colors ${size === "sm" ? "min-h-10 py-1 text-sm" : "min-h-10 py-1.5 text-[15px]"} ${
              checked ? "text-text" : "text-muted enabled:hover:text-text"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

export function Switch({
  checked,
  onChange,
  label,
  description,
  disabled,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label: ReactNode;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  const labelId = `${id}-label`;
  const descriptionId = `${id}-description`;
  // Вся строка (название и пояснение) — продолжение переключателя: нажатие в любом месте переключает.
  return (
    <label
      htmlFor={id}
      className={`-mx-2 flex items-start gap-3 rounded-2xl px-2 py-1.5 ${disabled ? "" : "cursor-pointer hover:bg-surface-2"}`}
    >
      <span className="min-w-0 flex-1">
        <span id={labelId} className="block text-[15px] font-medium">
          {label}
        </span>
        {description && (
          <span id={descriptionId} className="mt-0.5 block text-sm text-muted">
            {description}
          </span>
        )}
      </span>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-labelledby={labelId}
        aria-describedby={description ? descriptionId : undefined}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={`relative mt-0.5 h-7 w-12 shrink-0 rounded-full transition disabled:opacity-50 ${checked ? "bg-accent" : "bg-border-strong"}`}
      >
        <span
          className={`absolute top-0.5 h-6 w-6 rounded-full bg-white shadow-[0_1px_3px_rgb(0_0_0/0.2),0_3px_8px_-2px_rgb(0_0_0/0.2)] transition-all ${checked ? "left-[22px]" : "left-0.5"}`}
        />
      </button>
    </label>
  );
}

type Tone = "default" | "positive" | "negative" | "muted" | "auto";

/** Сумма. tone="auto" — зелёная для плюса, красная для минуса. */
export function Money({
  value,
  sign,
  tone = "default",
  className = "",
}: {
  value: Kopecks;
  sign?: boolean;
  tone?: Tone;
  className?: string;
}) {
  const color =
    tone === "positive"
      ? "text-positive"
      : tone === "negative"
        ? "text-negative"
        : tone === "muted"
          ? "text-muted"
          : tone === "auto"
            ? value > 0
              ? "text-positive"
              : value < 0
                ? "text-negative"
                : ""
            : "";
  return <span className={`whitespace-nowrap tabular-nums ${color} ${className}`}>{formatMoney(value, { sign })}</span>;
}

export function Progress({
  value,
  max,
  tone = "accent",
  label,
}: {
  value: number;
  max: number;
  tone?: "accent" | "positive" | "warning" | "negative";
  label?: string;
}) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0;
  const colors = { accent: "bg-accent", positive: "bg-positive", warning: "bg-warning", negative: "bg-negative" };
  return (
    <div
      className="h-2 w-full overflow-hidden rounded-full bg-surface-3"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(ratio * 100)}
    >
      <div className={`h-full rounded-full transition-all ${colors[tone]}`} style={{ width: `${ratio * 100}%` }} />
    </div>
  );
}

export function Card({
  title,
  action,
  children,
  className = "",
}: {
  title?: ReactNode;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={`surface-card rounded-[28px] p-4 sm:p-5 ${className}`}>
      {(title || action) && (
        <div className="mb-3 flex items-center gap-2">
          {title && <h2 className="min-w-0 flex-1 text-[15px] font-semibold">{title}</h2>}
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function EmptyState({ title, text, action }: { title: string; text?: ReactNode; action?: ReactNode }) {
  return (
    <div className="rounded-[28px] border border-dashed border-border-strong/50 bg-card/50 px-6 py-10 text-center">
      <p className="font-medium">{title}</p>
      {text && <p className="mx-auto mt-1 max-w-sm text-sm text-muted">{text}</p>}
      {action && <div className="mt-4 flex justify-center">{action}</div>}
    </div>
  );
}

export function Notice({
  tone = "info",
  children,
  action,
}: {
  tone?: "info" | "warning" | "negative" | "positive";
  children: ReactNode;
  action?: ReactNode;
}) {
  const styles = {
    info: "bg-accent-soft text-text",
    warning: "bg-warning-soft text-text",
    negative: "bg-negative-soft text-text",
    positive: "bg-positive-soft text-text",
  };
  return (
    <div className={`flex flex-col gap-3 rounded-[20px] px-4 py-3 text-sm sm:flex-row sm:items-center ${styles[tone]}`}>
      <div className="flex-1">{children}</div>
      {action && <div className="flex shrink-0 gap-2">{action}</div>}
    </div>
  );
}
