import { SAVINGS_CATEGORY } from "./defaults";
import { percentOf, type Kopecks } from "./money";
import { LIMITS, type Settings, type Transaction } from "./schema";

type TxLike = Pick<Transaction, "type" | "amount" | "category">;

/** Отчисление с покупки: процент (с потолком) плюс округление суммы покупки вверх. */
export function purchaseSavingAmount(amount: Kopecks, category: string, settings: Settings): Kopecks {
  const ps = settings.purchaseSaving;
  if (!ps.enabled || amount <= 0 || ps.excludedCategories.includes(category)) return 0;
  const percentPart = Math.min(percentOf(amount, ps.percent), ps.cap);
  const roundPart = ps.roundTo > 0 ? Math.ceil(amount / ps.roundTo) * ps.roundTo - amount : 0;
  return percentPart + roundPart;
}

/** Отчисление с дохода (по умолчанию 15% с зарплаты). */
export function salarySavingAmount(amount: Kopecks, category: string, settings: Settings): Kopecks {
  const ss = settings.salarySaving;
  if (!ss.enabled || amount <= 0 || !ss.categories.includes(category)) return 0;
  return percentOf(amount, ss.percent);
}

/** Включать ли автоотчисление по умолчанию для новой операции. */
export function autoSavingByDefault(tx: TxLike, settings: Settings): boolean {
  if (tx.type === "expense") return purchaseSavingAmount(tx.amount || 1, tx.category, settings) > 0;
  if (tx.type === "income") return salarySavingAmount(tx.amount || 100, tx.category, settings) > 0;
  return false;
}

export function autoSavingAmount(tx: TxLike & Pick<Transaction, "autoSaving">, settings: Settings): Kopecks {
  if (!tx.autoSaving) return 0;
  if (tx.type === "expense") return purchaseSavingAmount(tx.amount, tx.category, settings);
  if (tx.type === "income") return salarySavingAmount(tx.amount, tx.category, settings);
  return 0;
}

export function linkedSavingId(txId: string): string {
  return `${txId}.s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

export function buildLinkedSaving(source: Transaction, amount: Kopecks): Transaction {
  const name = source.title || source.category;
  const title = source.type === "income" ? `Отложено с дохода «${name}»` : `Отложено с покупки «${name}»`;
  return {
    id: linkedSavingId(source.id),
    type: "saving",
    amount,
    date: source.date,
    category: SAVINGS_CATEGORY,
    title: truncate(title, LIMITS.title),
    note: "",
    linkedTo: source.id,
  };
}
