import { addDays, type IsoDate } from "./dates";
import type { Kopecks } from "./money";
import type { Account, State, Transaction } from "./schema";

/**
 * Счета. Пока пользователь не завёл свои, у него два счёта по умолчанию: «Основной счёт» (все операции,
 * записанные до появления счетов) и «Сбережения» (куда уходили отчисления). Поэтому прежние данные
 * без счёта у операций остаются верными: нет accountId — основной, нет toAccountId у сбережений — «Сбережения».
 */

export const MAIN_ACCOUNT_ID = "main";
export const SAVINGS_ACCOUNT_ID = "savings";

export function defaultAccounts(): Account[] {
  return [
    { id: MAIN_ACCOUNT_ID, name: "Основной счёт", kind: "debit", spending: true, smsKeys: [] },
    { id: SAVINGS_ACCOUNT_ID, name: "Сбережения", kind: "savings", spending: false, smsKeys: [] },
  ];
}

export function accountsOf(state: Pick<State, "accounts">): Account[] {
  return state.accounts?.length ? state.accounts : defaultAccounts();
}

/** Открытые счета — для выбора в новых операциях. */
export function activeAccounts(state: Pick<State, "accounts">): Account[] {
  return accountsOf(state).filter((a) => !a.archived);
}

export function findAccount(state: Pick<State, "accounts">, id: string): Account | undefined {
  return accountsOf(state).find((a) => a.id === id);
}

/** Счёт операции; у сбережений и переводов — откуда. */
export function sourceAccountId(tx: Pick<Transaction, "accountId">): string {
  return tx.accountId ?? MAIN_ACCOUNT_ID;
}

/** Куда: у перевода — его счёт назначения, у сбережений — накопительный счёт; у остальных — null. */
export function targetAccountId(tx: Pick<Transaction, "type" | "toAccountId">): string | null {
  if (tx.type === "transfer") return tx.toAccountId ?? null;
  if (tx.type === "saving") return tx.toAccountId ?? SAVINGS_ACCOUNT_ID;
  return null;
}

/** Как операция меняет остатки счетов: [счёт, изменение]. Сбережения и переводы двигают деньги между счетами. */
export function accountDeltas(tx: Pick<Transaction, "type" | "amount" | "accountId" | "toAccountId">): [string, Kopecks][] {
  const source = sourceAccountId(tx);
  switch (tx.type) {
    case "income":
    case "adjustment":
      return [[source, tx.amount]];
    case "expense":
      return [[source, -tx.amount]];
    case "saving":
    case "transfer": {
      const target = targetAccountId(tx);
      return target ? [[source, -tx.amount], [target, tx.amount]] : [[source, -tx.amount]];
    }
  }
}

/** Остатки всех счетов на конец дня date (без даты — все операции). */
export function accountBalances(state: State, date?: IsoDate): Map<string, Kopecks> {
  const balances = new Map<string, Kopecks>();
  for (const account of accountsOf(state)) balances.set(account.id, 0);
  for (const tx of state.transactions) {
    if (date && tx.date > date) continue;
    for (const [id, delta] of accountDeltas(tx)) balances.set(id, (balances.get(id) ?? 0) + delta);
  }
  return balances;
}

export function accountBalance(state: State, accountId: string, date?: IsoDate): Kopecks {
  return accountBalances(state, date).get(accountId) ?? 0;
}

/** Деньги этого счёта считаются в «Сколько можно потратить»: отмечен, открыт и это не кредитная карта. */
export function isSpendingAccount(account: Account): boolean {
  return account.spending && account.kind !== "credit" && !account.archived;
}

export function spendingAccountIds(state: Pick<State, "accounts">): Set<string> {
  return new Set(accountsOf(state).filter(isSpendingAccount).map((a) => a.id));
}

/** Как операция меняет деньги на счетах, которые учитываются в тратах. */
export function spendingEffect(
  spending: ReadonlySet<string>,
  tx: Pick<Transaction, "type" | "amount" | "accountId" | "toAccountId">,
): Kopecks {
  let sum = 0;
  for (const [id, delta] of accountDeltas(tx)) if (spending.has(id)) sum += delta;
  return sum;
}

/** Сбережения в накопительных счетах, которые не учитываются в тратах (иначе одни деньги посчитались бы дважды). */
export function savingsAccountIds(state: Pick<State, "accounts">): Set<string> {
  return new Set(accountsOf(state).filter((a) => a.kind === "savings" && !isSpendingAccount(a)).map((a) => a.id));
}

// ---------- кредитная карта ----------

export interface CreditStatus {
  account: Account;
  /** Долг по карте (≥ 0). */
  debt: Kopecks;
  limit: Kopecks | null;
  /** Сколько ещё можно потратить по лимиту карты. */
  available: Kopecks | null;
  /** Первая покупка, с которой идёт беспроцентный период (когда долга до неё не было). */
  graceStart: IsoDate | null;
  /** Последний день, когда долг можно погасить без процентов. */
  graceEnd: IsoDate | null;
  /** Беспроцентный период закончился, а долг остался. */
  overdue: boolean;
}

/**
 * Долг и беспроцентный период кредитной карты на сегодня. Период начинается с первой покупки, когда долга
 * не было, и длится graceDays дней (включая день покупки); полностью погасили долг — период сбрасывается.
 */
export function creditStatus(state: State, account: Account, today: IsoDate): CreditStatus {
  const moves: { date: IsoDate; delta: Kopecks; order: number }[] = [];
  state.transactions.forEach((tx, order) => {
    if (tx.date > today) return;
    for (const [id, delta] of accountDeltas(tx)) if (id === account.id) moves.push({ date: tx.date, delta, order });
  });
  // По дате; внутри дня — в порядке записи.
  moves.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  let balance = 0;
  let graceStart: IsoDate | null = null;
  for (const move of moves) {
    if (move.delta < 0 && balance >= 0) graceStart = move.date;
    balance += move.delta;
    if (balance >= 0) graceStart = null;
  }

  const debt = Math.max(0, -balance);
  const limit = account.creditLimit ?? null;
  const graceEnd = graceStart && account.graceDays ? addDays(graceStart, account.graceDays - 1) : null;
  return {
    account,
    debt,
    limit,
    available: limit === null ? null : Math.max(0, limit - debt),
    graceStart,
    graceEnd,
    overdue: debt > 0 && graceEnd !== null && graceEnd < today,
  };
}

/** Кредитные карты с долгом — для «Скоро», долгов и прогноза остатка. */
export function creditDebts(state: State, today: IsoDate): CreditStatus[] {
  return accountsOf(state)
    .filter((a) => a.kind === "credit" && !a.archived)
    .map((a) => creditStatus(state, a, today))
    .filter((c) => c.debt > 0);
}
