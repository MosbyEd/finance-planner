"use client";

import { useState, type ReactNode } from "react";
import type { Account } from "@/domain/schema";
import { ACCOUNT_KINDS } from "../app/accounts";
import { Icon } from "./Icon";

/**
 * Выбор счёта. Счетов немного — чипами; много — строкой с выбранным счётом (и сколько на нём), по нажатию
 * раскрывается список всех счетов.
 */
export function AccountPicker({
  label,
  accounts,
  value,
  onChange,
  error,
  amounts,
  action,
  compact: compactProp,
}: {
  label: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  error?: string | null;
  /** Сколько на счёте — мелко рядом с названием (нет — суммы спрятаны или не нужны). */
  amounts?: Record<string, string>;
  /** Кнопка справа от подписи (глазок сумм). */
  action?: ReactNode;
  /** Строкой со списком, а не чипами; нет — по числу счетов. */
  compact?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const compact = compactProp ?? accounts.length > 4;
  const selected = accounts.find((a) => a.id === value);

  const legend = (
    <legend className="mb-1.5 flex w-full items-center justify-between gap-2 text-sm font-medium text-muted">
      <span>{label}</span>
      {action}
    </legend>
  );

  if (compact) {
    return (
      <fieldset className="space-y-2">
        {legend}
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
          className="glass-control flex h-12 w-full items-center gap-3 rounded-2xl border px-4 text-left"
        >
          {selected && <Icon name={ACCOUNT_KINDS[selected.kind].icon} size={18} className="shrink-0 text-accent" />}
          <span className="min-w-0 flex-1 truncate text-[15px] font-medium">{selected?.name ?? "Выберите счёт"}</span>
          {selected && amounts?.[selected.id] && <span className="shrink-0 text-sm text-muted tabular-nums">{amounts[selected.id]}</span>}
          <Icon name="chevronDown" size={16} className={`shrink-0 text-muted transition ${open ? "rotate-180" : ""}`} />
        </button>
        {open && (
          <ul className="max-h-80 divide-y divide-separator overflow-y-auto rounded-2xl bg-surface-2" aria-label={label}>
            {accounts.map((a) => (
              <li key={a.id}>
                <button
                  type="button"
                  aria-pressed={a.id === value}
                  onClick={() => {
                    onChange(a.id);
                    setOpen(false);
                  }}
                  className="flex min-h-12 w-full items-center gap-3 px-4 py-2 text-left hover:bg-fill"
                >
                  <Icon name={ACCOUNT_KINDS[a.kind].icon} size={18} className="shrink-0 text-accent" />
                  <span className="min-w-0 flex-1">
                    <span className={`block truncate text-[15px] ${a.id === value ? "font-semibold" : ""}`}>{a.name}</span>
                    <span className="block text-xs text-muted">{ACCOUNT_KINDS[a.kind].label}</span>
                  </span>
                  {amounts?.[a.id] && <span className="shrink-0 text-sm tabular-nums text-muted">{amounts[a.id]}</span>}
                  {a.id === value && <Icon name="check" size={16} className="shrink-0 text-accent" />}
                </button>
              </li>
            ))}
          </ul>
        )}
        {error && <p className="text-sm text-negative">{error}</p>}
      </fieldset>
    );
  }

  return (
    <fieldset className="space-y-2">
      {legend}
      <div className="flex flex-wrap gap-2">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={a.id === value}
            onClick={() => onChange(a.id)}
            className={`inline-flex h-10 max-w-full items-center gap-1.5 rounded-full border px-3.5 text-sm transition ${
              a.id === value ? "sheen border-accent-fill bg-accent-fill text-on-accent" : "glass-control"
            }`}
          >
            <Icon name={ACCOUNT_KINDS[a.kind].icon} size={16} className="shrink-0" />
            {/* Длинное название обрезается многоточием, а не вылезает за край окна. */}
            <span className="min-w-0 truncate">{a.name}</span>
            {amounts?.[a.id] && (
              <span className={`shrink-0 tabular-nums ${a.id === value ? "opacity-80" : "text-muted"}`}>{amounts[a.id]}</span>
            )}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </fieldset>
  );
}
