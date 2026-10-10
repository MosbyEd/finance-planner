"use client";

import { CREDIT_OPERATIONS, type CreditOperation } from "@/domain/interest";
import type { CreditTerms } from "@/domain/schema";
import { TextInput } from "../../ui/Field";

/** Поля условий как их ввёл человек: ставка («39,9») и беспроцентный период в днях по видам операций. */
export type TermsDraft = Record<CreditOperation, { rate: string; grace: string }>;

const ROWS: Record<CreditOperation, { title: string; gracePlaceholder: string; ratePlaceholder: string }> = {
  purchase: { title: "Покупки и оплата", gracePlaceholder: "120", ratePlaceholder: "39,9" },
  cash: { title: "Снятие наличных и переводы", gracePlaceholder: "Нет", ratePlaceholder: "49,9" },
};

function rateText(rate: number | undefined): string {
  return rate === undefined ? "" : String(rate).replace(".", ",");
}

/** Черновик из сохранённых условий. Без условий у кредитки беспроцентный период покупок — прежний graceDays. */
export function termsDraft(terms: CreditTerms | undefined, purchaseGrace?: number): TermsDraft {
  return {
    purchase: {
      rate: rateText(terms?.purchase.rate),
      grace: String(terms ? (terms.purchase.graceDays ?? "") : (purchaseGrace ?? "")),
    },
    cash: { rate: rateText(terms?.cash.rate), grace: String(terms?.cash.graceDays ?? "") },
  };
}

export function sameDraft(a: TermsDraft, b: TermsDraft): boolean {
  return CREDIT_OPERATIONS.every((op) => a[op].rate === b[op].rate && a[op].grace === b[op].grace);
}

/** Условия из черновика; error — что заполнено неверно; terms: null — ничего не указано. */
export function parseTerms(draft: TermsDraft): { terms: CreditTerms | null; error?: string } {
  const terms: CreditTerms = { purchase: {}, cash: {} };
  for (const op of CREDIT_OPERATIONS) {
    const rate = draft[op].rate.trim().replace(",", ".");
    if (rate) {
      const value = Number(rate);
      if (!Number.isFinite(value) || value < 0 || value > 1000) return { terms: null, error: "Ставка — от 0 до 1000% годовых" };
      terms[op].rate = Math.round(value * 100) / 100;
    }
    const grace = draft[op].grace.trim();
    if (grace) {
      const value = Number(grace);
      if (!Number.isInteger(value) || value < 1 || value > 3650) return { terms: null, error: "Беспроцентный период — от 1 дня" };
      terms[op].graceDays = value;
    }
  }
  const empty = CREDIT_OPERATIONS.every((op) => terms[op].rate === undefined && terms[op].graceDays === undefined);
  return { terms: empty ? null : terms };
}

/** Ставка и беспроцентный период для покупок и для снятия наличных. */
export function CreditTermsFields({
  value,
  onChange,
  error,
  hint,
}: {
  value: TermsDraft;
  onChange: (next: TermsDraft) => void;
  error?: string;
  hint: string;
}) {
  const set = (op: CreditOperation, patch: Partial<TermsDraft[CreditOperation]>) =>
    onChange({ ...value, [op]: { ...value[op], ...patch } });
  return (
    <fieldset className="space-y-3">
      <legend className="mb-1.5 text-sm font-medium text-muted">Проценты и беспроцентный период</legend>
      {(["purchase", "cash"] as const).map((op) => (
        <div key={op} className="space-y-1.5">
          <p className="text-sm font-medium">{ROWS[op].title}</p>
          <div className="grid grid-cols-2 gap-3">
            <TextInput
              label="Дней без процентов"
              inputMode="numeric"
              placeholder={ROWS[op].gracePlaceholder}
              value={value[op].grace}
              onChange={(e) => set(op, { grace: e.target.value.replace(/\D/g, "").slice(0, 4) })}
            />
            <TextInput
              label="Ставка, % годовых"
              inputMode="decimal"
              placeholder={ROWS[op].ratePlaceholder}
              value={value[op].rate}
              onChange={(e) => set(op, { rate: e.target.value.replace(/[^\d.,]/g, "").slice(0, 6) })}
            />
          </div>
        </div>
      ))}
      {error ? <p className="text-sm text-negative">{error}</p> : <p className="text-sm text-muted">{hint}</p>}
    </fieldset>
  );
}
