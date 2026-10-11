"use client";

import { useEffect, useRef, useState } from "react";
import { LIMITS } from "@/domain/schema";
import { Icon } from "./Icon";

/**
 * Выбор категории чипами плюс ввод новой. Новая категория сохраняется вместе с операцией. Когда категорий много,
 * сначала видны только частые (frequent) и выбранная — остальные по «Все категории», с поиском.
 */
export function CategoryPicker({
  label,
  categories,
  value,
  onChange,
  error,
  showValue,
  frequent,
}: {
  label: string;
  categories: string[];
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  /** Показать выбранную категорию в подписи: чип может оказаться ниже края экрана, а выбор подставлен заранее. */
  showValue?: boolean;
  /** Частые категории — их видно сразу; нет — все чипы. */
  frequent?: string[];
}) {
  const [showAll, setShowAll] = useState(false);
  const [query, setQuery] = useState("");
  const [adding, setAdding] = useState(false);
  const [draft, setDraft] = useState("");
  const addButtonRef = useRef<HTMLButtonElement>(null);
  // Esc отменяет ввод: следующий за ним blur не должен сохранять недописанное название.
  const cancelledRef = useRef(false);
  // После Enter или Esc поле исчезает — возвращаем фокус на «Своя», чтобы он не терялся (и Esc снова закрывал окно).
  const restoreFocusRef = useRef(false);
  const all = value && !categories.some((c) => c === value) ? [...categories, value] : categories;
  // Свёрнуто: выбранная и частые. Развёрнуто: все, с поиском, когда их много.
  const compact = Boolean(frequent?.length) && all.length > (frequent?.length ?? 0) + 2 && !showAll;
  const needle = query.trim().toLocaleLowerCase("ru");
  const list = compact
    ? [...new Set([...(value ? [value] : []), ...(frequent ?? [])])].filter((c) => all.includes(c))
    : needle
      ? all.filter((c) => c.toLocaleLowerCase("ru").includes(needle))
      : all;

  useEffect(() => {
    if (adding || !restoreFocusRef.current) return;
    restoreFocusRef.current = false;
    addButtonRef.current?.focus();
  }, [adding]);

  const startAdding = () => {
    cancelledRef.current = false;
    setAdding(true);
  };

  const commit = () => {
    if (cancelledRef.current) return;
    const name = draft.trim().slice(0, LIMITS.category);
    if (name) onChange(name);
    setDraft("");
    setAdding(false);
  };

  const cancel = () => {
    cancelledRef.current = true;
    restoreFocusRef.current = true;
    setDraft("");
    setAdding(false);
  };

  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium text-muted">
        {label}
        {showValue && value && <span className="text-text"> · {value}</span>}
      </legend>
      {showAll && all.length > 12 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Найти категорию"
          aria-label="Найти категорию"
          className="h-10 w-full rounded-full border border-border-strong bg-surface px-4 text-base outline-none focus:border-accent"
        />
      )}
      <div className="flex flex-wrap gap-2">
        {list.map((c) => (
          <button
            key={c}
            type="button"
            aria-pressed={c === value}
            onClick={() => {
              onChange(c);
              // Выбрали из полного списка — сворачиваем: выбранная останется видна среди частых.
              if (showAll && frequent?.length) {
                setShowAll(false);
                setQuery("");
              }
            }}
            className={`h-10 max-w-full truncate rounded-full border px-3.5 text-sm transition ${
              c === value ? "sheen border-accent-fill bg-accent-fill text-on-accent" : "glass-control"
            }`}
          >
            {c}
          </button>
        ))}
        {compact && (
          <button
            type="button"
            onClick={() => setShowAll(true)}
            className="inline-flex h-10 items-center gap-1 rounded-full px-3.5 text-sm font-medium text-accent hover:bg-fill"
          >
            Все категории ({all.length})
          </button>
        )}
        {showAll && frequent?.length ? (
          <button
            type="button"
            onClick={() => {
              setShowAll(false);
              setQuery("");
            }}
            className="inline-flex h-10 items-center rounded-full px-3.5 text-sm font-medium text-accent hover:bg-fill"
          >
            Свернуть
          </button>
        ) : null}
        {adding ? (
          <input
            autoFocus
            value={draft}
            maxLength={LIMITS.category}
            placeholder="Новая категория"
            aria-label="Новая категория"
            enterKeyHint="done"
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                restoreFocusRef.current = true;
                commit();
              }
              if (e.key === "Escape" && !e.nativeEvent.isComposing) {
                // Esc закрывает только поле, а не всё окно.
                e.stopPropagation();
                e.preventDefault();
                cancel();
              }
            }}
            className="h-10 w-44 max-w-full rounded-full border border-accent bg-surface px-3.5 text-base outline-none"
          />
        ) : (
          <button
            ref={addButtonRef}
            type="button"
            onClick={startAdding}
            className="inline-flex h-10 items-center gap-1 rounded-full border border-dashed border-border-strong bg-card/50 px-3.5 text-sm text-muted hover:text-text"
          >
            <Icon name="plus" size={14} /> Своя
          </button>
        )}
      </div>
      {error && (
        <p className="text-sm text-negative" role="alert">
          {error}
        </p>
      )}
    </fieldset>
  );
}
