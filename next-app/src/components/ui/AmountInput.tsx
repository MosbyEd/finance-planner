"use client";

import { useId, useState } from "react";
import { formatMoney, kopecksToInput, parseAmount, type Kopecks } from "@/domain/money";
import { Field, controlClass, describedBy } from "./Field";

/**
 * Поле суммы. Хранит текст как ввёл человек, наружу отдаёт копейки (или null).
 * Под полем показывает, как сумма распознана, — чтобы «12,500» не стало сюрпризом.
 */
export function AmountInput({
  label,
  value,
  onChange,
  error,
  hint,
  allowNegative,
  autoFocus,
  placeholder = "0",
}: {
  label: string;
  value: Kopecks | null;
  onChange: (value: Kopecks | null) => void;
  error?: string | null;
  hint?: string;
  allowNegative?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const id = useId();
  const [text, setText] = useState(() => (value === null ? "" : kopecksToInput(value)));
  const [lastValue, setLastValue] = useState(value);

  // Значение поменяли снаружи (например, сброс формы) — синхронизируем текст.
  if (value !== lastValue) {
    setLastValue(value);
    if (value !== parseAmount(text, { allowNegative })) setText(value === null ? "" : kopecksToInput(value));
  }

  const parsed = text.trim() ? parseAmount(text, { allowNegative }) : null;
  const invalid = text.trim() !== "" && parsed === null;
  const preview = parsed !== null && kopecksToInput(parsed) !== text.replace(/\s/g, "") ? formatMoney(parsed) : null;
  const shownError = error ?? (invalid ? "Не похоже на сумму" : null);
  const shownHint = preview ? `Будет записано: ${preview}` : hint;

  return (
    <Field label={label} htmlFor={id} error={shownError} hint={shownHint}>
      <div className="relative">
        <input
          id={id}
          inputMode="decimal"
          autoComplete="off"
          enterKeyHint="done"
          placeholder={placeholder}
          value={text}
          data-autofocus={autoFocus || undefined}
          aria-invalid={invalid || Boolean(error) || undefined}
          aria-describedby={describedBy(id, shownHint, shownError)}
          onChange={(e) => {
            const next = e.target.value;
            setText(next);
            const amount = next.trim() ? parseAmount(next, { allowNegative }) : null;
            setLastValue(amount);
            onChange(amount);
          }}
          className={`${controlClass} h-14 pr-10 text-2xl font-semibold`}
        />
        <span className="pointer-events-none absolute right-4 top-1/2 -translate-y-1/2 text-xl text-muted">₽</span>
      </div>
    </Field>
  );
}
