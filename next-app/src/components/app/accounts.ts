import {
  accountBalance,
  accountBalances,
  accountCards,
  activeAccounts,
  cardLabel,
  creditStatus,
  findAccount,
  isSpendingAccount,
  MAIN_ACCOUNT_ID,
  sourceAccountId,
} from "@/domain/accounts";
import type { Action } from "@/domain/actions";
import { formatDay, formatRelativeDay, type IsoDate } from "@/domain/dates";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { Account, AccountKind, State, Transaction } from "@/domain/schema";
import type { IconName } from "../ui/Icon";

/** Подписи и значки видов счетов. */
export const ACCOUNT_KINDS: Record<AccountKind, { label: string; icon: IconName; symbol: string }> = {
  debit: { label: "Обычный счёт", icon: "card", symbol: "creditcard" },
  cash: { label: "Наличные", icon: "wallet", symbol: "banknote" },
  savings: { label: "Накопительный", icon: "piggy", symbol: "building.columns" },
  credit: { label: "Кредитная карта", icon: "card", symbol: "creditcard.trianglebadge.exclamationmark" },
};

/** Завёл ли пользователь свои счета — иначе интерфейс не показывает выбор счёта (у всех операций основной). */
export function hasOwnAccounts(state: State): boolean {
  return activeAccounts(state).length > 2 || activeAccounts(state).some((a) => a.kind === "credit" || a.kind === "cash");
}

/** Счета, с которых можно платить и на которые приходят деньги: всё, кроме накопительных. */
export function payableAccounts(state: State): Account[] {
  return activeAccounts(state).filter((a) => a.kind !== "savings");
}

/** Счёт последней операции этого вида — его и предлагаем по умолчанию. */
export function lastAccountId(state: State, type: "income" | "expense"): string {
  const open = new Set(payableAccounts(state).map((a) => a.id));
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const tx = state.transactions[i];
    if (tx.type === type && !tx.templateId && !tx.linkedTo && open.has(sourceAccountId(tx))) return sourceAccountId(tx);
  }
  return open.has(MAIN_ACCOUNT_ID) ? MAIN_ACCOUNT_ID : [...open][0] ?? MAIN_ACCOUNT_ID;
}

export interface AccountRow {
  account: Account;
  balance: Kopecks;
  /** «50 000 ₽» или «Долг 3 000 ₽». */
  amount: string;
  negative: boolean;
  /** Пояснение: «до 1 февраля без процентов · лимит 100 000 ₽», «учитывается в лимите». */
  detail: string;
  overdue: boolean;
}

/** Строки счетов: остаток, у кредитки — долг и беспроцентный период. */
export function accountRows(state: State, today: IsoDate): AccountRow[] {
  const balances = accountBalances(state, today);
  return activeAccounts(state).map((account) => {
    const balance = balances.get(account.id) ?? 0;
    if (account.kind === "credit") {
      const credit = creditStatus(state, account, today);
      const parts: string[] = [];
      if (credit.debt > 0 && credit.graceEnd) {
        parts.push(credit.overdue ? `льготный период закончился ${formatDay(credit.graceEnd, today)}` : `без процентов до ${formatDay(credit.graceEnd, today)}`);
      }
      if (credit.available !== null) parts.push(`доступно ${formatMoney(credit.available, { whole: true })}`);
      return {
        account,
        balance,
        amount: credit.debt > 0 ? `Долг ${formatMoney(credit.debt, { whole: true })}` : "Долга нет",
        negative: credit.debt > 0,
        detail: parts.join(" · "),
        overdue: credit.overdue,
      };
    }
    return {
      account,
      balance,
      amount: formatMoney(balance, { whole: true }),
      negative: balance < 0,
      detail: isSpendingAccount(account) ? "Учитывается в лимите на день" : ACCOUNT_KINDS[account.kind].label,
      overdue: false,
    };
  });
}

/**
 * Подпись счёта у операции: «Кредитка», с картой — «Кредитка · Мир •7759» (карта видна и при одном счёте),
 * у перевода — «Основной → Кредитка».
 */
export function transactionAccountLabel(state: State, tx: Transaction): string | null {
  const name = (id: string) => findAccount(state, id)?.name ?? "счёт";
  if (tx.type === "transfer") return hasOwnAccounts(state) ? `${name(sourceAccountId(tx))} → ${name(tx.toAccountId ?? "")}` : null;
  const account = findAccount(state, sourceAccountId(tx));
  const card = tx.card ? cardLabel(account, tx.card) : null;
  const parts = [hasOwnAccounts(state) ? name(sourceAccountId(tx)) : null, card].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * Откуда и куда идёт регулярный платёж: «Основной → Кредитка», «Основной → Ипотека», «Кредитка» (только откуда).
 * null — счетов нет и платёж обычный.
 */
export function templateRoute(state: State, t: { accountId?: string; toAccountId?: string; loanId?: string }): string | null {
  const own = hasOwnAccounts(state);
  const from = own ? (findAccount(state, t.accountId ?? MAIN_ACCOUNT_ID)?.name ?? "счёт") : null;
  const to = t.toAccountId
    ? findAccount(state, t.toAccountId)?.name
    : t.loanId
      ? state.loans.find((l) => l.id === t.loanId)?.name
      : undefined;
  if (to) return from ? `${from} → ${to}` : `→ ${to}`;
  return from;
}

/** Карта последней операции по этому счёту — её предлагаем по умолчанию. */
export function lastCardOf(state: State, accountId: string): string | null {
  const account = findAccount(state, accountId);
  const known = new Set(account ? accountCards(account).map((c) => c.digits) : []);
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const tx = state.transactions[i];
    if (sourceAccountId(tx) === accountId && tx.card && known.has(tx.card)) return tx.card;
  }
  return null;
}

/** Расхождение остатка с банком по последней СМС (≥ 1 ₽): что предложить поправить. */
export interface BankMismatch {
  account: Account;
  /** Остаток в банке по СМС. */
  bank: Kopecks;
  /** Остаток в приложении на тот момент. */
  app: Kopecks;
  delta: Kopecks;
  title: string;
  text: string;
}

export function bankMismatches(state: State, today: IsoDate): BankMismatch[] {
  return activeAccounts(state).flatMap((account) => {
    const bank = account.bank;
    if (!bank || Math.abs(bank.delta) < 100) return [];
    const app = bank.amount - bank.delta;
    return [
      {
        account,
        bank: bank.amount,
        app,
        delta: bank.delta,
        title: `«${account.name}»: в банке ${formatMoney(bank.amount, { whole: true })}, в приложении ${formatMoney(app, { whole: true })}`,
        text: `По СМС — ${formatRelativeDay(bank.date, today).replace(/, .*/, "").toLowerCase()}. Поправить остаток на ${formatMoney(bank.delta, { sign: true })}?`,
      },
    ];
  });
}

/**
 * «Перевод» для расхождения: в банке меньше — деньги ушли с этого счёта (выбрать, куда), больше — пришли
 * (выбрать, откуда). После перевода расхождение снимается.
 */
export function bankTransferOverlay(m: Pick<BankMismatch, "account" | "delta">): {
  kind: "transfer";
  from?: string;
  to?: string;
  amount: number;
  resolveBank: string;
} {
  return m.delta < 0
    ? { kind: "transfer", from: m.account.id, amount: -m.delta, resolveBank: m.account.id }
    : { kind: "transfer", to: m.account.id, amount: m.delta, resolveBank: m.account.id };
}

/** «Поправить»: корректировка счёта на разницу с банком и снятие расхождения. «Оставить» — только снятие. */
export function bankResolveActions(state: State, accountId: string, fix: boolean, today: IsoDate, id: string): Action[] {
  const account = activeAccounts(state).find((a) => a.id === accountId);
  const bank = account?.bank;
  if (!account || !bank) return [];
  const resolve: Action = { type: "account.bank", accountId, amount: bank.amount, delta: 0, date: bank.date };
  if (!fix || bank.delta === 0) return [resolve];
  return [
    { type: "balance.set", id, date: today, actual: accountBalance(state, accountId, today) + bank.delta, accountId },
    resolve,
  ];
}
