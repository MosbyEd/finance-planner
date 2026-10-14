import type { IsoDate } from "./dates";
import type { Kopecks } from "./money";
import { creditParts, resolveTerms, type CreditMove, type CreditOperation, type CreditPart, type ResolvedTerms } from "./interest";
import type { Account, Card, State, Transaction } from "./schema";

/**
 * Счета. Пока пользователь не завёл свои, у него два счёта по умолчанию: «Основной счёт» (все операции,
 * записанные до появления счетов) и «Сбережения» (куда уходили отчисления). Поэтому прежние данные
 * без счёта у операций остаются верными: нет accountId — основной, нет toAccountId у сбережений — «Сбережения».
 */

export const MAIN_ACCOUNT_ID = "main";
export const SAVINGS_ACCOUNT_ID = "savings";

export function defaultAccounts(): Account[] {
  return [
    { id: MAIN_ACCOUNT_ID, name: "Основной счёт", kind: "debit", spending: true },
    { id: SAVINGS_ACCOUNT_ID, name: "Сбережения", kind: "savings", spending: false },
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

/** Карты счёта (с картами прежнего формата — цифрами из smsKeys без названия). */
export function accountCards(account: Account): Card[] {
  if (account.cards) return account.cards;
  return (account.smsKeys ?? []).map((digits) => ({ digits, name: "" }));
}

/** Цифры, по которым СМС узнаёт счёт: номер счёта и цифры его карт. */
export function accountKeys(account: Account): string[] {
  return [...(account.number ? [account.number] : []), ...accountCards(account).map((c) => c.digits)];
}

/** «Мир •7759» или «•7759». */
export function cardLabel(account: Account | undefined, digits: string): string {
  const name = account ? accountCards(account).find((c) => c.digits === digits)?.name : undefined;
  return name ? `${name} •${digits}` : `•${digits}`;
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

/**
 * Расхождение с банком сейчас: остаток из последней СМС минус остаток счёта в приложении на конец её дня —
 * по текущим операциям. Записали пропущенную операцию — расхождение уменьшилось, а не поправляется второй раз.
 * null — СМС с остатком не было или расхождение решено (совпало, поправили или оставили).
 */
export function bankDelta(state: State, account: Account): Kopecks | null {
  const bank = account.bank;
  if (!bank || bank.delta === 0) return null;
  return bank.amount - accountBalance(state, account.id, bank.date);
}

/** Остаток из СМС a — раньше b: по дню, а в один день — по времени СМС (если оно известно у обоих). */
export function bankSnapshotOlder(a: { date: IsoDate; time?: string }, b: { date: IsoDate; time?: string }): boolean {
  if (a.date !== b.date) return a.date < b.date;
  return a.time !== undefined && b.time !== undefined && a.time < b.time;
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
  return new Set(
    accountsOf(state)
      .filter((a) => a.kind === "savings" && !isSpendingAccount(a) && a.inSavings !== false)
      .map((a) => a.id),
  );
}

/**
 * Счета под платежи: на них приходят регулярные переводы (с зарплаты и аванса), а с них идут регулярные платежи —
 * например, «Ипотека»: откладываем частями в дни поступлений, платим целиком в дату платежа. В бюджете
 * обязательным считается перевод на такой счёт (в свой период), а платёж с него второй раз не вычитается.
 * Кредитки и счета целей — не такие: у них свой учёт.
 */
export function paymentReserveAccounts(state: Pick<State, "accounts" | "templates" | "goals">): Set<string> {
  const funded = new Set<string>();
  const paying = new Set<string>();
  for (const t of state.templates) {
    if (!t.active || t.kind !== "expense" || t.goalId) continue;
    if (t.toAccountId) funded.add(t.toAccountId);
    else paying.add(t.accountId ?? MAIN_ACCOUNT_ID);
  }
  const goalAccounts = new Set(state.goals.map((g) => g.accountId).filter(Boolean));
  return new Set(
    accountsOf(state)
      .filter((a) => funded.has(a.id) && paying.has(a.id) && a.kind !== "credit" && a.id !== MAIN_ACCOUNT_ID && !goalAccounts.has(a.id))
      .map((a) => a.id),
  );
}

/** Накопительный счёт, куда можно откладывать: существует, открыт и накопительный; иначе — «Сбережения». */
export function savingsTarget(state: Pick<State, "accounts">, id: string | undefined): string {
  const account = id ? findAccount(state, id) : undefined;
  return account && account.kind === "savings" && !account.archived ? account.id : SAVINGS_ACCOUNT_ID;
}

// ---------- кредитная карта ----------

export interface CreditStatus extends CreditSummary {
  account: Account;
  limit: Kopecks | null;
  /** Сколько ещё можно потратить по лимиту карты. */
  available: Kopecks | null;
}

const CASH_TITLE = /наличн|банкомат|\bATM\b/iu;

/** Вид операции по кредитке: переводы с неё и снятие в банкомате — «снятие наличных», остальное — покупки. */
export function creditOperation(tx: Pick<Transaction, "type" | "title" | "category">): CreditOperation {
  if (tx.type === "transfer" || tx.type === "saving") return "cash";
  if (tx.type === "expense" && (CASH_TITLE.test(tx.title) || CASH_TITLE.test(tx.category))) return "cash";
  return "purchase";
}

export function accountTerms(account: Account): ResolvedTerms {
  return resolveTerms(account.terms, account.graceDays);
}

/** Долг по видам операций и сводка: ближайший конец беспроцентного периода и проценты. */
export interface CreditSummary {
  debt: Kopecks;
  graceStart: IsoDate | null;
  graceEnd: IsoDate | null;
  overdue: boolean;
  accrued: Kopecks;
  ifMissed: Kopecks;
  perDay: Kopecks;
  parts: CreditPart[];
}

export function summarizeParts(parts: CreditPart[]): CreditSummary {
  const withGrace = parts.filter((p) => p.debt > 0 && p.graceEnd !== null);
  const first = withGrace.reduce<CreditPart | null>((min, p) => (!min || p.graceEnd! < min.graceEnd! ? p : min), null);
  return {
    debt: parts.reduce((sum, p) => sum + p.debt, 0),
    graceStart: first?.since ?? null,
    graceEnd: first?.graceEnd ?? null,
    overdue: parts.some((p) => p.overdue),
    accrued: parts.reduce((sum, p) => sum + p.accrued, 0),
    ifMissed: parts.reduce((sum, p) => sum + p.ifMissed, 0),
    perDay: parts.reduce((sum, p) => sum + p.perDay, 0),
    parts,
  };
}

/**
 * Долг, беспроцентный период и проценты кредитной карты на сегодня — по видам операций (см. interest.ts).
 * Период начинается с первой операции, когда долга этого вида не было; полностью погасили — сбрасывается.
 */
export function creditStatus(state: State, account: Account, today: IsoDate): CreditStatus {
  const moves: (CreditMove & { order: number })[] = [];
  state.transactions.forEach((tx, order) => {
    if (tx.date > today) return;
    for (const [id, delta] of accountDeltas(tx)) {
      if (id !== account.id || delta === 0) continue;
      moves.push({ date: tx.date, kind: delta > 0 ? "payment" : creditOperation(tx), amount: Math.abs(delta), order });
    }
  });
  // По дате; внутри дня — в порядке записи.
  moves.sort((a, b) => a.date.localeCompare(b.date) || a.order - b.order);

  const summary = summarizeParts(creditParts(moves, accountTerms(account), today));
  const limit = account.creditLimit ?? null;
  return { account, ...summary, limit, available: limit === null ? null : Math.max(0, limit - summary.debt) };
}

/** Кредитные карты с долгом — для «Скоро», долгов и прогноза остатка. */
export function creditDebts(state: State, today: IsoDate): CreditStatus[] {
  return accountsOf(state)
    .filter((a) => a.kind === "credit" && !a.archived)
    .map((a) => creditStatus(state, a, today))
    .filter((c) => c.debt > 0);
}
