import {
  accountBalances,
  accountCards,
  activeAccounts,
  bankDelta,
  cardLabel,
  creditStatus,
  findAccount,
  type CreditSummary,
  isSpendingAccount,
  MAIN_ACCOUNT_ID,
  savingsTarget,
  sourceAccountId,
} from "@/domain/accounts";
import type { Action } from "@/domain/actions";
import { CREDIT_OPERATION_LABEL } from "@/domain/interest";
import { expectedSavings, expectedSavingsLabel, purchaseSourceExcluded } from "@/domain/savings";
import { formatDay, formatRelativeDay, type IsoDate } from "@/domain/dates";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { Account, AccountKind, State, Transaction } from "@/domain/schema";
import type { IconName } from "../ui/Icon";

/** Подписи и значки видов счетов. */
export const ACCOUNT_KINDS: Record<AccountKind, { label: string; icon: IconName; symbol: string }> = {
  debit: { label: "Обычный счёт", icon: "card", symbol: "creditcard" },
  cash: { label: "Наличные", icon: "wallet", symbol: "banknote" },
  savings: { label: "Накопительный", icon: "piggy", symbol: "building.columns" },
  credit: { label: "Кредитная карта", icon: "card", symbol: "creditcard.and.123" },
};

/** Завёл ли пользователь свои счета — иначе интерфейс не показывает выбор счёта (у всех операций основной). */
export function hasOwnAccounts(state: State): boolean {
  return activeAccounts(state).length > 2 || activeAccounts(state).some((a) => a.kind === "credit" || a.kind === "cash");
}

/**
 * Перевод между своими счетами одним действием: в накопительный и из него — движение сбережений (засчитывается
 * как «отложено» / «снято»), остальное — перевод. null — счета не найдены или совпадают.
 */
export function transferAction(
  state: State,
  t: { id: string; date: IsoDate; from: string; to: string; amount: Kopecks; title?: string; note?: string },
): Action | null {
  const fromAccount = findAccount(state, t.from);
  const toAccount = findAccount(state, t.to);
  if (!fromAccount || !toAccount || t.from === t.to) return null;
  const note = t.note ?? "";
  const title = t.title?.trim();
  if (toAccount.kind === "savings" && fromAccount.kind !== "savings") {
    return { type: "savings.move", id: t.id, date: t.date, amount: t.amount, note, accountId: t.from, toAccountId: t.to };
  }
  if (fromAccount.kind === "savings" && toAccount.kind !== "savings") {
    return { type: "savings.move", id: t.id, date: t.date, amount: -t.amount, note, accountId: t.to, toAccountId: t.from };
  }
  return { type: "transfer.add", id: t.id, date: t.date, from: t.from, to: t.to, amount: t.amount, note, ...(title ? { title } : {}) };
}

/** «Переведено 5 000 ₽: Сбербанк → Накопительный»; на кредитку — «Погашено». */
export function transferMessage(state: State, from: string, to: string, amount: Kopecks): string {
  const fromAccount = findAccount(state, from);
  const toAccount = findAccount(state, to);
  return `${toAccount?.kind === "credit" ? "Погашено" : "Переведено"} ${formatMoney(amount)}: ${fromAccount?.name ?? ""} → ${toAccount?.name ?? ""}`;
}

/** Пояснение под переводом: что это значит для бюджета. */
export function transferHint(state: State, from: string, to: string): string {
  const fromAccount = findAccount(state, from);
  const toAccount = findAccount(state, to);
  if (toAccount?.kind === "savings" && fromAccount?.kind !== "savings") return "Пополнение сбережений — считается отложенным в этом месяце.";
  if (fromAccount?.kind === "savings" && toAccount?.kind !== "savings") return "Снятие из сбережений на счёт.";
  if (toAccount?.kind === "credit") return "Погашение кредитки — перевод: покупки по ней уже учтены, когда вы их делали.";
  return "Перевод между своими счетами — не доход и не расход.";
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

/**
 * Строки счетов: остаток, у кредитки — долг и беспроцентный период, у копилки — сколько автоотчислений
 * ещё копится до порога («ожидается +40 ₽»): в остаток они не входят, пока не переведены.
 */
export function accountRows(state: State, today: IsoDate): AccountRow[] {
  const balances = accountBalances(state, today);
  const expected = expectedSavings(state).byAccount;
  return activeAccounts(state).map((account) => {
    const balance = balances.get(account.id) ?? 0;
    if (account.kind === "credit") {
      const credit = creditStatus(state, account, today);
      const parts: string[] = [];
      if (credit.debt > 0 && credit.graceEnd) {
        parts.push(credit.overdue ? `льготный период закончился ${formatDay(credit.graceEnd, today)}` : `без процентов до ${formatDay(credit.graceEnd, today)}`);
      }
      if (credit.accrued > 0) parts.push(`проценты ≈ ${formatMoney(credit.accrued, { whole: true })}`);
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
    const pending = expected.get(account.id);
    return {
      account,
      balance,
      amount: formatMoney(balance, { whole: true }),
      negative: balance < 0,
      detail: [
        isSpendingAccount(account) ? "Учитывается в лимите на день" : ACCOUNT_KINDS[account.kind].label,
        pending ? expectedSavingsLabel(pending) : null,
      ]
        .filter(Boolean)
        .join(" · "),
      overdue: false,
    };
  });
}

/** Подпись под сбережениями на Главной: сколько автоотчислений ещё копится до порога, иначе — что делает плитка. */
export function savingsTileHint(state: State, masked: boolean): string {
  const { total } = expectedSavings(state);
  return total > 0 && !masked ? `Ожидается ${formatMoney(total, { sign: true })}` : "Пополнить или снять";
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
export function templateRoute(
  state: State,
  t: { accountId?: string; toAccountId?: string; loanId?: string; goalId?: string },
): string | null {
  const own = hasOwnAccounts(state);
  const from = own ? (findAccount(state, t.accountId ?? MAIN_ACCOUNT_ID)?.name ?? "счёт") : null;
  const goal = t.goalId ? state.goals.find((g) => g.id === t.goalId)?.name : undefined;
  const to = t.toAccountId
    ? findAccount(state, t.toAccountId)?.name
    : t.loanId
      ? state.loans.find((l) => l.id === t.loanId)?.name
      : goal
        ? `цель «${goal}»`
        : undefined;
  if (to) return from ? `${from} → ${to}` : `→ ${to}`;
  return from;
}

/** Группа счёта на экране «Счета». */
export type AccountGroup = "spending" | "savings" | "credit" | "other";

export const ACCOUNT_GROUPS: { id: AccountGroup; title: string }[] = [
  { id: "spending", title: "Для трат" },
  { id: "savings", title: "Накопления" },
  { id: "credit", title: "Кредитки" },
  { id: "other", title: "Другие" },
];

export function accountGroup(account: Account): AccountGroup {
  if (account.kind === "credit") return "credit";
  if (isSpendingAccount(account)) return "spending";
  if (account.kind === "savings") return "savings";
  return "other";
}

/**
 * Самые важные счета для Главной: кредитка с прошедшим льготным периодом, кредитки с долгом, крупные счета
 * для трат, затем остальные. Остальное — на экране «Счета».
 */
export function previewAccountRows(rows: AccountRow[], limit = 3): AccountRow[] {
  const rank = (row: AccountRow) =>
    row.overdue ? 0 : row.account.kind === "credit" && row.negative ? 1 : accountGroup(row.account) === "spending" ? 2 : 3;
  return [...rows]
    .sort((a, b) => rank(a) - rank(b) || (rank(a) === 2 ? b.balance - a.balance : 0))
    .slice(0, limit);
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

/**
 * Расхождения с банком (≥ 1 ₽) — по текущим операциям: сколько предложено поправить, на столько «Поправить»
 * и поправит. Пропущенную операцию записали вручную — расхождение уменьшается или пропадает.
 */
export function bankMismatches(state: State, today: IsoDate): BankMismatch[] {
  return activeAccounts(state).flatMap((account) => {
    const bank = account.bank;
    const delta = bankDelta(state, account);
    if (!bank || delta === null || Math.abs(delta) < 100) return [];
    const app = bank.amount - delta;
    const piggy = bankPiggyAccount(state, account);
    const hint = piggy
      ? ` Если это копилка банка — «Перевод» ${delta < 0 ? "в" : "из"} «${piggy.name}».`
      : "";
    return [
      {
        account,
        bank: bank.amount,
        app,
        delta,
        title: `«${account.name}»: в банке ${formatMoney(bank.amount, { whole: true })}, в приложении ${formatMoney(app, { whole: true })}`,
        text: `По СМС — ${formatRelativeDay(bank.date, today).replace(/, .*/, "").toLowerCase()}. Поправить остаток на ${formatMoney(delta, { sign: true })}?${hint}`,
      },
    ];
  });
}

/**
 * Накопительный, куда идут автоотчисления с покупок по этому счёту. Банк переводит их в копилку сам, когда
 * наберётся порог, и без СМС, — поэтому расхождение по карте часто означает перевод в копилку (или обратно,
 * если приложение отложило больше банка), а не потерянную операцию.
 */
function bankPiggyAccount(state: State, account: Account): Account | undefined {
  const ps = state.settings.purchaseSaving;
  if (!ps.enabled || account.kind !== "debit" || purchaseSourceExcluded(state.settings, { accountId: account.id })) return undefined;
  return findAccount(state, savingsTarget(state, ps.toAccountId));
}

/**
 * «Перевод» для расхождения: в банке меньше — деньги ушли с этого счёта, больше — пришли. Второй счёт — копилка
 * автонакоплений (если они идут с этого счёта), иначе его выбирают. После перевода расхождение снимается.
 */
export function bankTransferOverlay(
  state: State,
  m: Pick<BankMismatch, "account" | "delta">,
): {
  kind: "transfer";
  from?: string;
  to?: string;
  amount: number;
  resolveBank: string;
} {
  const piggy = bankPiggyAccount(state, m.account)?.id;
  return m.delta < 0
    ? { kind: "transfer", from: m.account.id, ...(piggy ? { to: piggy } : {}), amount: -m.delta, resolveBank: m.account.id }
    : { kind: "transfer", ...(piggy ? { from: piggy } : {}), to: m.account.id, amount: m.delta, resolveBank: m.account.id };
}

/**
 * «Поправить»: корректировка на разницу с банком — её считает само действие по операциям на момент применения,
 * поэтому сервер и телефон поправят одинаково. «Оставить» — только снятие расхождения.
 */
export function bankResolveActions(state: State, accountId: string, fix: boolean, id: string): Action[] {
  const account = activeAccounts(state).find((a) => a.id === accountId);
  const bank = account?.bank;
  if (!account || !bank) return [];
  if (fix) return [{ type: "account.bankFix", id, accountId }];
  return [{ type: "account.bank", accountId, ...bank, delta: 0 }];
}

export interface InterestLine {
  text: string;
  tone: "muted" | "warning" | "negative";
}

/** Сумма процентов: до 100 ₽ — с копейками, дальше — в рублях (это оценка). */
function interestMoney(kopecks: Kopecks): string {
  return formatMoney(kopecks, { whole: kopecks >= 10_000 });
}

/**
 * Беспроцентный период и проценты кредитки или долга — по строке на вид операций с долгом:
 * «Без процентов до 12 нояб. — не погасите, начислят ≈ 1 234 ₽», «Снятие наличных: проценты с 3 окт. — ≈ 300 ₽, +45 ₽ в день».
 */
export function interestLines(summary: CreditSummary, today: IsoDate): InterestLine[] {
  const active = summary.parts.filter((p) => p.debt > 0);
  // Подпись вида нужна, когда видов несколько или долг — снятие наличных.
  const labeled = active.length > 1 || active.some((p) => p.operation === "cash");
  const lines: InterestLine[] = [];
  for (const part of active) {
    const perDay = part.perDay > 0 ? `, +${interestMoney(part.perDay)} в день` : "";
    let text: string;
    let tone: InterestLine["tone"];
    if (part.graceEnd && !part.overdue) {
      const missed = part.ifMissed > 0 ? ` — не погасите, начислят ≈ ${interestMoney(part.ifMissed)}` : "";
      text = `без процентов до ${formatDay(part.graceEnd, today)}${missed}`;
      tone = "muted";
    } else if (part.overdue && part.graceEnd) {
      const accrued = part.rate !== null ? ` — набежало ≈ ${interestMoney(part.accrued)}${perDay}` : " — погасите долг";
      text = `беспроцентный период закончился ${formatDay(part.graceEnd, today)}${accrued}`;
      tone = "negative";
    } else if (part.rate !== null && part.since) {
      text = `проценты с ${formatDay(part.since, today)} — набежало ≈ ${interestMoney(part.accrued)}${perDay}`;
      tone = "warning";
    } else continue;
    lines.push({
      text: labeled ? `${CREDIT_OPERATION_LABEL[part.operation]}: ${text}` : text[0].toUpperCase() + text.slice(1),
      tone,
    });
  }
  return lines;
}

// ---------- сколько на счёте при вводе операции ----------

/** Деньги счёта для подсказки в окне операции: остаток, у кредитки — долг и лимит. */
export interface Funds {
  account: Account;
  /** Остаток (у кредитки — минус долг). */
  balance: Kopecks;
  limit: Kopecks | null;
}

export function fundsOf(balances: ReadonlyMap<string, Kopecks>, account: Account): Funds {
  return { account, balance: balances.get(account.id) ?? 0, limit: account.kind === "credit" ? (account.creditLimit ?? null) : null };
}

/**
 * Что показать о деньгах счёта после изменения delta: у карты и накопительного — остаток, у кредитки — доступный
 * лимит (без лимита — долг). short — для чипа («50 000 ₽»), иначе с подписью («доступно 120 000 ₽»).
 */
export function fundsText(f: Funds, delta = 0, short = false): { text: string; negative: boolean } {
  const balance = f.balance + delta;
  if (f.account.kind === "credit") {
    if (f.limit !== null) {
      const available = f.limit + balance;
      const text = formatMoney(available, { whole: true });
      return { text: short ? text : `доступно ${text}`, negative: available < 0 };
    }
    const debt = Math.max(0, -balance);
    return { text: debt > 0 ? `долг ${formatMoney(debt, { whole: true })}` : "долга нет", negative: false };
  }
  return { text: formatMoney(balance, { whole: true }), negative: balance < 0 };
}
