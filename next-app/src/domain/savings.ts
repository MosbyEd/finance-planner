import { MAIN_ACCOUNT_ID, SAVINGS_ACCOUNT_ID } from "./accounts";
import { SAVINGS_CATEGORY } from "./defaults";
import { percentOf, type Kopecks } from "./money";
import { LIMITS, type Settings, type Transaction } from "./schema";

/** Счёт и карта операции — для «с каких карт откладывать». */
type Source = Partial<Pick<Transaction, "accountId" | "card">>;
type TxLike = Pick<Transaction, "type" | "amount" | "category"> & Source;

/** Покупка со счёта или карты, с которых автоотчисления выключены. Нет счёта — основной. */
export function purchaseSourceExcluded(settings: Settings, source: Source = {}): boolean {
  const ps = settings.purchaseSaving;
  return (
    Boolean(ps.excludedAccounts?.includes(source.accountId ?? MAIN_ACCOUNT_ID)) ||
    Boolean(source.card && ps.excludedCards?.includes(source.card))
  );
}

/** Отчисление с покупки: процент (с потолком) плюс округление суммы покупки вверх. */
export function purchaseSavingAmount(amount: Kopecks, category: string, settings: Settings, source: Source = {}): Kopecks {
  const ps = settings.purchaseSaving;
  if (!ps.enabled || amount <= 0 || ps.excludedCategories.includes(category) || purchaseSourceExcluded(settings, source)) return 0;
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
  if (tx.type === "expense") return purchaseSavingAmount(tx.amount || 1, tx.category, settings, tx) > 0;
  if (tx.type === "income") return salarySavingAmount(tx.amount || 100, tx.category, settings) > 0;
  return false;
}

export function autoSavingAmount(tx: TxLike & Pick<Transaction, "autoSaving">, settings: Settings): Kopecks {
  if (!tx.autoSaving) return 0;
  if (tx.type === "expense") return purchaseSavingAmount(tx.amount, tx.category, settings, tx);
  if (tx.type === "income") return salarySavingAmount(tx.amount, tx.category, settings);
  return 0;
}

/** С какой суммы переводить накопленные автоотчисления этого вида: с доходов или с покупок. 0 — сразу. */
export function savingThreshold(settings: Settings, type: Transaction["type"]): Kopecks {
  return (type === "income" ? settings.salarySaving.minTransfer : settings.purchaseSaving.minTransfer) ?? 0;
}

/** Накоплено и ещё не переведено: сумма отложенных отчислений этого вида и порог перевода. */
export function pendingSavings(
  state: { transactions: Transaction[]; settings: Settings },
  type: "income" | "expense",
): { total: Kopecks; threshold: Kopecks; count: number } {
  let total = 0;
  let count = 0;
  for (const t of state.transactions) {
    if (!t.savingPending || t.type !== type) continue;
    const amount = autoSavingAmount(t, state.settings);
    if (amount <= 0) continue;
    total += amount;
    count += 1;
  }
  return { total, threshold: savingThreshold(state.settings, type), count };
}

export function linkedSavingId(txId: string): string {
  return `${txId}.s`;
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

/**
 * Автоотчисление с операции. fromAccountId — откуда уходят деньги (у покупки по кредитке — основной счёт:
 * откладывать в долг не нужно); нет — основной счёт.
 */
export function buildLinkedSaving(source: Transaction, amount: Kopecks, fromAccountId?: string, toAccountId?: string): Transaction {
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
    ...(fromAccountId && fromAccountId !== MAIN_ACCOUNT_ID ? { accountId: fromAccountId } : {}),
    ...(toAccountId && toAccountId !== SAVINGS_ACCOUNT_ID ? { toAccountId } : {}),
  };
}
