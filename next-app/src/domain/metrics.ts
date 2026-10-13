import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  firstDayOfMonth,
  formatDay,
  lastDayOfMonth,
  monthKeyOf,
  parseIsoDate,
  type IsoDate,
  type MonthKey,
} from "./dates";
import { formatMoney, percentOf, type Kopecks } from "./money";
import { getOwn } from "./records";
import { isSkipped, occurrenceDate, plannedOccurrences } from "./recurring";
import { salarySavingAmount } from "./savings";
import {
  MAIN_ACCOUNT_ID,
  SAVINGS_ACCOUNT_ID,
  accountBalances,
  creditDebts,
  paymentReserveAccounts,
  savingsAccountIds,
  savingsTarget,
  sourceAccountId,
  spendingAccountIds,
  targetAccountId,
  spendingEffect,
  summarizeParts,
  type CreditSummary,
} from "./accounts";
import { creditParts, hasTerms, resolveTerms, type CreditMove } from "./interest";
import {
  dedicatedGoalAccount,
  goalAvailable,
  goalSaved,
  loanOpening,
  loanOpeningSign,
  loanPaid,
  loanRemaining,
} from "./progress";
import type { Loan, Settings, State, Transaction } from "./schema";

export { dedicatedGoalAccount, goalAvailable, goalSaved, loanOpening, loanOpeningSign, loanPaid, loanRemaining };

/**
 * Сумма операции со знаком для показа: доходы и корректировки — как есть, расходы и отчисления в сбережения —
 * минусом. Перевод между своими счетами деньги не меняет — 0 (его сумму показывают отдельно).
 */
export function balanceEffect(tx: Pick<Transaction, "type" | "amount">): Kopecks {
  switch (tx.type) {
    case "income":
    case "adjustment":
      return tx.amount;
    case "expense":
    case "saving":
      return -tx.amount;
    case "transfer":
      return 0;
  }
}

/** Деньги на счетах, которые учитываются в тратах, на конец дня date (все операции с датой ≤ date). */
export function balanceAt(state: State, date: IsoDate): Kopecks {
  const spending = spendingAccountIds(state);
  let sum = 0;
  for (const tx of state.transactions) if (tx.date <= date) sum += spendingEffect(spending, tx);
  return sum;
}

/** Всего в сбережениях к дате (включительно): остатки накопительных счетов, которые не учитываются в тратах. */
export function savingsTotal(state: State, date?: IsoDate): Kopecks {
  const balances = accountBalances(state, date);
  let sum = 0;
  for (const id of savingsAccountIds(state)) sum += balances.get(id) ?? 0;
  return sum;
}

/**
 * Сколько из сбережений лежит на целях (накоплено в приложении, без initialAmount): эти деньги
 * снимают с самой цели, а не из общих сбережений — иначе одни и те же деньги сняли бы дважды.
 */
/**
 * Деньги целей без своего счёта, лежащие на этом накопительном счёте (пополнения с отметкой цели): их снимают
 * через цель. Учитывается ли счёт в сбережениях — не важно.
 */
export function goalsReservedOn(state: State, accountId: string): Kopecks {
  const perGoal = new Map<string, Kopecks>();
  for (const goal of state.goals) if (!dedicatedGoalAccount(state, goal)) perGoal.set(goal.id, 0);
  for (const tx of state.transactions) {
    if (tx.type !== "saving" || tx.goalId === undefined || targetAccountId(tx) !== accountId) continue;
    const sum = perGoal.get(tx.goalId);
    if (sum !== undefined) perGoal.set(tx.goalId, sum + tx.amount);
  }
  let reserved = 0;
  for (const sum of perGoal.values()) reserved += Math.max(0, sum);
  return reserved;
}

export function goalsReserved(state: State): Kopecks {
  const perGoal = new Map<string, Kopecks>();
  const inSavings = savingsAccountIds(state);
  let dedicated = 0;
  for (const goal of state.goals) {
    // Цель со своим счётом: на ней всё, что лежит на счёте (из сбережений — если счёт в них учитывается).
    const account = dedicatedGoalAccount(state, goal);
    if (account) dedicated += inSavings.has(account) ? goalSaved(state, goal) : 0;
    else perGoal.set(goal.id, 0);
  }
  for (const tx of state.transactions) {
    if (tx.type !== "saving" || tx.goalId === undefined) continue;
    const sum = perGoal.get(tx.goalId);
    if (sum !== undefined) perGoal.set(tx.goalId, sum + tx.amount);
  }
  let reserved = dedicated;
  for (const sum of perGoal.values()) reserved += Math.max(0, sum);
  return reserved;
}

/** День, с которого идёт долг: указанный или день записи. */
export function loanStart(loan: Loan): IsoDate {
  return loan.takenAt ?? loan.createdAt;
}

/**
 * Проценты по моему долгу или кредиту с условиями (см. interest.ts): долг возник в loanStart — покупки
 * и снятие наличных (cashAmount), дальше его гасят «уже погашено» и платежи. null — условий нет или мне должны.
 */
export function loanInterest(state: State, loan: Loan, today: IsoDate): CreditSummary | null {
  if (loan.kind === "lend" || !hasTerms(loan.terms)) return null;
  const start = loanStart(loan);
  const cash = Math.min(loan.cashAmount ?? 0, loan.amount);
  const moves: CreditMove[] = [];
  if (loan.amount - cash > 0) moves.push({ date: start, kind: "purchase", amount: loan.amount - cash });
  if (cash > 0) moves.push({ date: start, kind: "cash", amount: cash });
  if (loan.initialPaid > 0) moves.push({ date: start, kind: "payment", amount: loan.initialPaid });
  const opening = loanOpening(state, loan);
  const payments: CreditMove[] = [];
  for (const tx of state.transactions) {
    if (tx.loanId !== loan.id || tx === opening) continue;
    const amount = tx.type === "income" || tx.type === "expense" ? tx.amount : tx.type === "adjustment" ? Math.abs(tx.amount) : 0;
    // Платёж раньше начала долга считаем в день начала.
    if (amount > 0) payments.push({ date: tx.date > start ? tx.date : start, kind: "payment", amount });
  }
  payments.sort((a, b) => a.date.localeCompare(b.date));
  return summarizeParts(creditParts([...moves, ...payments], resolveTerms(loan.terms, undefined), today));
}

function floorToRubles(kopecks: Kopecks): Kopecks {
  return Math.floor(kopecks / 100) * 100;
}

/** Норма сбережений, действовавшая в указанном месяце. */
export function savingsRateFor(settings: Settings, month: MonthKey): number {
  const history = settings.savingsRateHistory;
  if (!history?.length) return settings.savingsRatePercent;
  let rate = history[0].percent;
  for (const entry of history) {
    if (entry.from > month) break;
    rate = entry.percent;
  }
  return rate;
}

export type MonthStatus = "past" | "current" | "future";

export interface MonthMetrics {
  month: MonthKey;
  status: MonthStatus;
  daysInMonth: number;
  /** Дней до конца месяца, включая сегодня (только для текущего месяца). */
  daysLeft: number;
  income: { fact: Kopecks; plan: Kopecks };
  mandatory: { fact: Kopecks; plan: Kopecks };
  /** planned — регулярные переводы на накопительные, которые ещё впереди в этом месяце. */
  savings: { fact: Kopecks; target: Kopecks; planned: Kopecks };
  flexible: {
    /** Гибкий бюджет: доходы − обязательные − цель по сбережениям. */
    budget: Kopecks;
    spent: Kopecks;
    spentToday: Kopecks;
    /** Запланированные гибкие траты с будущей датой в этом месяце. */
    reserved: Kopecks;
    /** Отложено сверх цели по сбережениям — уменьшает гибкий бюджет. */
    extraSavings: Kopecks;
    /** Остаток гибкого бюджета (сальдо месяца). */
    left: Kopecks;
  };
  daily: {
    /** Плановый лимит: бюджет / дней в месяце. */
    planned: Kopecks;
    /** Сколько можно тратить в день с учётом уже потраченного (текущий месяц). */
    availableToday: Kopecks;
    leftToday: Kopecks;
  };
  warnings: string[];
}

export function monthStatus(month: MonthKey, today: IsoDate): MonthStatus {
  const current = monthKeyOf(today);
  if (month < current) return "past";
  if (month > current) return "future";
  return "current";
}

/** Собственные счета целей: всё, что на них, — деньги цели. */
function goalAccountIds(state: State): Set<string> {
  const ids = new Set<string>();
  for (const goal of state.goals) {
    const account = dedicatedGoalAccount(state, goal);
    if (account) ids.add(account);
  }
  return ids;
}

/**
 * Что засчитывается в «Отложено» месяца: пополнения целей (и их собственных счетов) и автоотчисления с доходов
 * и покупок. Обычный перевод на накопительный счёт — перекладывание уже имевшихся денег, а не сбережения
 * из доходов месяца: он не урезает гибкий бюджет. Перенос остатка прошлого месяца — тоже не сбережения этого.
 */
export function countsAsMonthSaving(tx: Transaction, goalAccounts: Set<string>): boolean {
  if (tx.type !== "saving" || tx.rolloverOf) return false;
  if (tx.goalId || tx.linkedTo) return true;
  return goalAccounts.has(tx.toAccountId ?? SAVINGS_ACCOUNT_ID);
}

/** Суммы за отрезок дат: что не позже cutoff — факт, позже — план (операции с будущей датой и регулярные). */
interface WindowTotals {
  incomeFact: Kopecks;
  incomeFuture: Kopecks;
  mandatoryFact: Kopecks;
  mandatoryFuture: Kopecks;
  flexibleSpent: Kopecks;
  flexibleToday: Kopecks;
  flexibleReserved: Kopecks;
  savingsFact: Kopecks;
  /** Регулярные пополнения целей, которые ещё впереди, — тоже сбережения отрезка. */
  savingsPlanned: Kopecks;
}

function windowTotals(state: State, first: IsoDate, last: IsoDate, cutoff: IsoDate, today: IsoDate): WindowTotals {
  const totals: WindowTotals = {
    incomeFact: 0,
    incomeFuture: 0,
    mandatoryFact: 0,
    mandatoryFuture: 0,
    flexibleSpent: 0,
    flexibleToday: 0,
    flexibleReserved: 0,
    savingsFact: 0,
    savingsPlanned: 0,
  };
  const goalAccounts = goalAccountIds(state);
  // Счета под платежи («Ипотека»): обязательное — перевод на них, а не платёж с них (иначе дважды).
  const reserve = paymentReserveAccounts(state);
  for (const tx of state.transactions) {
    if (tx.date < first || tx.date > last) continue;
    const isFact = tx.date <= cutoff;
    const target = targetAccountId(tx);
    if (tx.type === "income") {
      if (isFact) totals.incomeFact += tx.amount;
      else totals.incomeFuture += tx.amount;
    } else if (tx.type === "expense" && tx.mandatory) {
      if (reserve.has(sourceAccountId(tx))) continue;
      if (isFact) totals.mandatoryFact += tx.amount;
      else totals.mandatoryFuture += tx.amount;
    } else if (
      (tx.type === "transfer" || (tx.type === "saving" && tx.amount > 0)) &&
      target &&
      reserve.has(target) &&
      !reserve.has(sourceAccountId(tx))
    ) {
      if (isFact) totals.mandatoryFact += Math.abs(tx.amount);
      else totals.mandatoryFuture += Math.abs(tx.amount);
    } else if (tx.type === "expense") {
      if (isFact) {
        totals.flexibleSpent += tx.amount;
        if (tx.date === today) totals.flexibleToday += tx.amount;
      } else {
        totals.flexibleReserved += tx.amount;
      }
    } else if (tx.type === "saving" && isFact && countsAsMonthSaving(tx, goalAccounts)) {
      totals.savingsFact += tx.amount;
    }
  }
  // Регулярные — только внутри отрезка: у отрезка в будущем — с его первого дня.
  const after = cutoff < first ? addDays(first, -1) : cutoff;
  for (const occ of plannedOccurrences(state, after, last)) {
    if (occ.kind === "income") totals.incomeFuture += occ.amount;
    else if (occ.toAccountId && reserve.has(occ.toAccountId) && !reserve.has(occ.accountId ?? MAIN_ACCOUNT_ID)) {
      totals.mandatoryFuture += occ.amount;
    } else if (occurrenceIsExpense(state, occ)) {
      if (!reserve.has(occ.accountId ?? MAIN_ACCOUNT_ID)) totals.mandatoryFuture += occ.amount;
    } else if (occ.goalId || (occ.toAccountId && goalAccounts.has(occ.toAccountId))) totals.savingsPlanned += occ.amount;
  }
  return totals;
}

export function monthMetrics(state: State, month: MonthKey, today: IsoDate): MonthMetrics {
  const status = monthStatus(month, today);
  const first = firstDayOfMonth(month);
  const last = lastDayOfMonth(month);
  // Всё, что не позже cutoff, — факт; позже — план.
  const cutoff = status === "past" ? last : status === "future" ? addDays(first, -1) : today;

  const {
    incomeFact,
    incomeFuture,
    mandatoryFact,
    mandatoryFuture,
    flexibleSpent,
    flexibleToday,
    flexibleReserved,
    savingsFact,
    savingsPlanned,
  } = windowTotals(state, first, last, cutoff, today);

  const incomePlan = incomeFact + incomeFuture;
  const mandatoryPlan = mandatoryFact + mandatoryFuture;
  const savingsTarget = percentOf(incomePlan, savingsRateFor(state.settings, month));
  const budget = incomePlan - mandatoryPlan - savingsTarget;
  // Отложено сверх нормы урезает гибкий бюджет. Запланированные переводы на накопительные учитываем заранее:
  // иначе лимит на день проседал бы в день перевода.
  const extraSavings = Math.max(0, savingsFact + savingsPlanned - savingsTarget);
  const left = budget - flexibleSpent - flexibleReserved - extraSavings;

  const totalDays = daysInMonth(month);
  const daysLeft = status === "current" ? totalDays - parseIsoDate(today).day + 1 : 0;
  const planned = floorToRubles(budget / totalDays);
  let availableToday = 0;
  if (status === "current") {
    const spentBeforeToday = flexibleSpent - flexibleToday;
    availableToday = floorToRubles((budget - spentBeforeToday - flexibleReserved - extraSavings) / daysLeft);
  }

  const warnings: string[] = [];
  if (incomePlan === 0 && status !== "past") {
    warnings.push("В этом месяце нет доходов. Добавьте доход или регулярный доход на вкладке «Регулярные» — без них бюджет не посчитать.");
  } else if (budget < 0) {
    warnings.push(
      `Обязательные расходы и сбережения больше доходов на ${formatMoney(-budget)}. Пересмотрите план.`,
    );
  } else if (left < 0) {
    warnings.push(`Гибкий бюджет превышен на ${formatMoney(-left)}.`);
  }
  for (const row of categoryBreakdown(state, first, cutoff < last ? cutoff : last, "expense")) {
    if (row.limit && row.amount > row.limit) {
      warnings.push(`«${row.category}»: потрачено ${formatMoney(row.amount)} при лимите ${formatMoney(row.limit)}.`);
    }
  }

  return {
    month,
    status,
    daysInMonth: totalDays,
    daysLeft,
    income: { fact: incomeFact, plan: incomePlan },
    mandatory: { fact: mandatoryFact, plan: mandatoryPlan },
    savings: { fact: savingsFact, target: savingsTarget, planned: savingsPlanned },
    flexible: {
      budget,
      spent: flexibleSpent,
      spentToday: flexibleToday,
      reserved: flexibleReserved,
      extraSavings,
      left,
    },
    daily: { planned, availableToday, leftToday: availableToday - flexibleToday },
    warnings,
  };
}

/** Куда уходят деньги регулярного пополнения цели: её накопительный счёт или «Сбережения». */
function goalTargetAccount(state: State, goalId: string): string {
  return savingsTarget(state, state.goals.find((g) => g.id === goalId)?.accountId);
}

/**
 * Будущее начисление шаблона — расход бюджета? Перевод на свой счёт (погашение кредитки, пополнение
 * накопительного) — нет; платёж по долгу, деньги которого прошли через счёт, — тоже нет (корректировка).
 */
function occurrenceIsExpense(state: State, occ: { toAccountId?: string; loanId?: string; goalId?: string }): boolean {
  if (occ.toAccountId || occ.goalId) return false;
  if (occ.loanId) {
    const loan = state.loans.find((l) => l.id === occ.loanId);
    return !loan || !loanOpening(state, loan);
  }
  return true;
}

export interface UpcomingEvent {
  key: string;
  date: IsoDate;
  type: Transaction["type"];
  title: string;
  category: string;
  /** Влияние на деньги на счетах, которые учитываются в тратах (со знаком). Покупка по кредитке — 0. */
  effect: Kopecks;
  /** Сумма для показа со знаком: расход по кредитке тоже −, хотя деньги на счетах он не меняет. */
  amount: Kopecks;
  mandatory: boolean;
  source: "transaction" | "template" | "auto-saving" | "credit";
  txId?: string;
  /** Кредитная карта, долг которой нужно погасить (source = credit). */
  accountId?: string;
  templateId?: string;
  month?: MonthKey;
  balanceAfter: Kopecks;
}

const TYPE_ORDER: Record<Transaction["type"], number> = { income: 0, adjustment: 1, saving: 2, transfer: 3, expense: 4 };

/**
 * Будущие события в (today, until] с прогнозом остатка на счетах, которые учитываются в тратах.
 * Долг кредитной карты — событие «погасить» в последний день беспроцентного периода (просрочен — завтра).
 */
export function upcomingEvents(state: State, today: IsoDate, until: IsoDate): UpcomingEvent[] {
  const spending = spendingAccountIds(state);
  const onSpending = (accountId: string | undefined) => spending.has(accountId ?? MAIN_ACCOUNT_ID);
  const events: Omit<UpcomingEvent, "balanceAfter">[] = [];
  for (const tx of state.transactions) {
    if (tx.date <= today || tx.date > until) continue;
    events.push({
      key: `tx:${tx.id}`,
      date: tx.date,
      type: tx.type,
      title: tx.title || tx.category,
      category: tx.category,
      effect: spendingEffect(spending, tx),
      amount: tx.type === "transfer" ? -tx.amount : balanceEffect(tx),
      mandatory: tx.type === "expense" && Boolean(tx.mandatory),
      source: tx.linkedTo ? "auto-saving" : "transaction",
      txId: tx.id,
      templateId: tx.templateId,
      month: tx.occurrenceMonth,
    });
  }
  for (const occ of plannedOccurrences(state, today, until)) {
    // Платёж на свой счёт (и пополнение цели — на её счёт) двигает деньги между счетами: на счетах для трат
    // меняется только то, что ушло с них.
    const ownTarget = occ.kind !== "expense" ? undefined : occ.goalId ? goalTargetAccount(state, occ.goalId) : occ.toAccountId;
    const toOwn = Boolean(ownTarget);
    const type: Transaction["type"] = toOwn ? "transfer" : occ.kind;
    const effect = toOwn
      ? spendingEffect(spending, { type: "transfer", amount: occ.amount, accountId: occ.accountId, toAccountId: ownTarget })
      : onSpending(occ.accountId)
        ? occ.kind === "income"
          ? occ.amount
          : -occ.amount
        : 0;
    events.push({
      key: `plan:${occ.templateId}.${occ.month}`,
      date: occ.date,
      type,
      title: occ.title,
      category: occ.category,
      effect,
      amount: occ.kind === "income" ? occ.amount : -occ.amount,
      mandatory: occ.kind === "expense",
      source: "template",
      templateId: occ.templateId,
      month: occ.month,
    });
    if (occ.kind === "income") {
      const saving = salarySavingAmount(occ.amount, occ.category, state.settings);
      if (saving > 0) {
        events.push({
          key: `plan-saving:${occ.templateId}.${occ.month}`,
          date: occ.date,
          type: "saving",
          title: `Отложить с «${occ.title}»`,
          category: "Сбережения",
          effect: onSpending(occ.accountId) ? -saving : 0,
          amount: -saving,
          mandatory: false,
          source: "auto-saving",
          templateId: occ.templateId,
          month: occ.month,
        });
      }
    }
  }
  // Кредитки, которые гасит регулярный платёж, — не дублируем напоминанием о конце льготного периода.
  const repaidByTemplate = new Set(state.templates.filter((t) => t.active && t.toAccountId).map((t) => t.toAccountId));
  for (const credit of creditDebts(state, today)) {
    if (!credit.graceEnd || repaidByTemplate.has(credit.account.id)) continue;
    const date = credit.graceEnd > today ? credit.graceEnd : addDays(today, 1);
    if (date > until) continue;
    events.push({
      key: `credit:${credit.account.id}`,
      date,
      type: "transfer",
      title: credit.overdue ? `Погасить «${credit.account.name}» — льготный период прошёл` : `Погасить «${credit.account.name}»`,
      category: "",
      effect: -credit.debt,
      amount: -credit.debt,
      mandatory: true,
      source: "credit",
      accountId: credit.account.id,
    });
  }
  events.sort((a, b) => a.date.localeCompare(b.date) || TYPE_ORDER[a.type] - TYPE_ORDER[b.type]);

  let balance = balanceAt(state, today);
  return events.map((e) => {
    balance += e.effect;
    return { ...e, balanceAfter: balance };
  });
}

export type SafeToSpendStatus = "ok" | "tight" | "over" | "gap" | "no-income";

export interface SafeToSpend {
  /** Рекомендуемый лимит на сегодня (до сегодняшних трат). */
  recommended: Kopecks;
  spentToday: Kopecks;
  leftToday: Kopecks;
  /** Лимит по бюджету месяца. */
  budgetPerDay: Kopecks;
  /** Лимит по деньгам на счёте до ближайшего дохода. */
  cashPerDay: Kopecks;
  horizon: { date: IsoDate; reason: "income" | "month-end"; title?: string };
  daysUntil: number;
  /** Деньги на счёте до сегодняшних гибких трат. */
  cashNow: Kopecks;
  /** Учитывается ли лимит бюджета месяца (только когда в этом месяце есть доходы в плане). */
  usesBudget: boolean;
  /** Обязательные платежи и отчисления до горизонта. */
  plannedOut: Kopecks;
  status: SafeToSpendStatus;
  /** Первый день, когда прогноз остатка уходит в минус (кассовый разрыв). */
  gapDate: IsoDate | null;
  /** Период бюджета (от зарплаты до зарплаты или месяц) — по нему budgetPerDay. */
  period: BudgetPeriod;
}

// ---------- период бюджета: от зарплаты до зарплаты ----------

/** Доходы, которые делят время на периоды бюджета: регулярные «Зарплата» и «Аванс». */
export const PAY_CATEGORIES = ["Зарплата", "Аванс"];
const PAY_TITLE = /зарплат|аванс|оклад|заработн/i;

/** Зарплата или аванс — по категории или по названию («Аванс» с категорией «Доход» тоже). */
export function isPayIncome(item: { category: string; title: string }): boolean {
  return PAY_CATEGORIES.includes(item.category) || PAY_TITLE.test(item.title);
}

/** Поступление зарплаты или аванса — граница периода. */
export interface PayEvent {
  date: IsoDate;
  title: string;
  category: string;
  amount: Kopecks;
  /** Уже пришло (операция есть), а не только по плану. */
  received: boolean;
}

/**
 * Поступления зарплаты и аванса около сегодняшнего дня (или за range): пришедшие — по факту, будущие — по плану.
 */
export function payEvents(state: State, today: IsoDate, range?: { from: IsoDate; to: IsoDate }): PayEvent[] {
  const templates = state.templates.filter((t) => t.active && t.kind === "income" && isPayIncome(t));
  if (!templates.length) return [];
  const ids = new Set(templates.map((t) => t.id));
  const from = range?.from ?? addDays(today, -62);
  const to = range?.to ?? addDays(today, 100);
  const received: PayEvent[] = [];
  const done = new Set<string>();
  for (const tx of state.transactions) {
    if (tx.type !== "income" || tx.date < from || tx.date > to) continue;
    // Пришла раньше срока — период начинается в день поступления.
    if (tx.templateId ? ids.has(tx.templateId) : isPayIncome(tx)) {
      received.push({ date: tx.date, title: tx.title || tx.category, category: tx.category, amount: tx.amount, received: true });
      if (tx.templateId && tx.occurrenceMonth) done.add(`${tx.templateId}|${tx.occurrenceMonth}`);
    }
  }
  // По расписанию — и впереди, и в прошлом: даже если прошлую выплату приложение не видело (регулярный доход
  // завели позже, зарплату не записали). Иначе у периода не было бы начала и бюджет молча считался бы по месяцу.
  const scheduled: PayEvent[] = [];
  for (const t of templates) {
    for (let month = monthKeyOf(from); month <= monthKeyOf(to); month = addMonths(month, 1)) {
      if (done.has(`${t.id}|${month}`) || isSkipped(state, t.id, month)) continue;
      const date = occurrenceDate(t, month);
      if (date < from || date > to || (t.endDate && date > t.endDate)) continue;
      // Будущие — с даты начала. Прошлые — и до неё: датой начала часто ставят ближайшую выплату
      // («Зарплата с 10 ноября»), а прошлая, 10 октября, была — от неё и идёт текущий период.
      if (date > today && date < t.startDate) continue;
      // Пришедшая рядом выплата — это она и есть (пришла раньше или позже срока).
      if (received.some((r) => Math.abs(diffDays(r.date, date)) <= 7)) continue;
      scheduled.push({ date, title: t.title, category: t.category, amount: t.amount, received: false });
    }
  }
  // Сначала пришедшие: при одинаковой дате граница — по факту.
  return [...received, ...scheduled].sort((a, b) => a.date.localeCompare(b.date));
}

/** Бюджет за отрезок дат — как у месяца: доходы − обязательные − норма сбережений, минус уже потраченное. */
export interface PeriodBudget {
  start: IsoDate;
  end: IsoDate;
  days: number;
  /** Дней до конца отрезка, включая сегодня (у будущего — все). */
  daysLeft: number;
  income: { fact: Kopecks; plan: Kopecks };
  mandatory: { fact: Kopecks; plan: Kopecks };
  savings: { fact: Kopecks; target: Kopecks; planned: Kopecks };
  flexible: { budget: Kopecks; spent: Kopecks; spentToday: Kopecks; reserved: Kopecks; extraSavings: Kopecks; left: Kopecks };
  /** Сколько можно тратить в день: (бюджет − потрачено до сегодня − запланировано − отложено сверх нормы) / дней. */
  perDay: Kopecks;
  /**
   * plan — по плану доходов и платежей; cash — по деньгам на счетах для трат (выплаты, с которой начался период,
   * в приложении нет): остаток — cash.left, бюджет — остаток плюс уже потраченное и отложенное.
   */
  basis: "plan" | "cash";
  /** Деньги на счетах для трат на остаток отрезка — у отрезка, в который входит сегодня. */
  cash: PeriodCash | null;
}

/** Деньги на счетах для трат на остаток отрезка: сколько сейчас и что по плану придёт и уйдёт до его конца. */
export interface PeriodCash {
  /** На счетах для трат на конец сегодняшнего дня. */
  now: Kopecks;
  /** Поступления на счета для трат — после сегодня и до конца отрезка. */
  incoming: Kopecks;
  /** Платежи, переводы и запланированные траты со счетов для трат — после сегодня и до конца отрезка. */
  outgoing: Kopecks;
  /** now + incoming − outgoing. */
  left: Kopecks;
}

function periodCash(state: State, today: IsoDate, end: IsoDate): PeriodCash {
  let incoming = 0;
  let outgoing = 0;
  for (const e of upcomingEvents(state, today, end)) {
    if (e.effect > 0) incoming += e.effect;
    else outgoing -= e.effect;
  }
  const now = balanceAt(state, today);
  return { now, incoming, outgoing, left: now + incoming - outgoing };
}

/** byCash — бюджет текущего отрезка по деньгам на счетах (см. PeriodBudget.basis). */
export function periodBudget(state: State, start: IsoDate, end: IsoDate, today: IsoDate, byCash = false): PeriodBudget {
  const cutoff = today < start ? addDays(start, -1) : today > end ? end : today;
  const w = windowTotals(state, start, end, cutoff, today);
  const incomePlan = w.incomeFact + w.incomeFuture;
  const mandatoryPlan = w.mandatoryFact + w.mandatoryFuture;
  const target = percentOf(incomePlan, savingsRateFor(state.settings, monthKeyOf(start)));
  const extraSavings = Math.max(0, w.savingsFact + w.savingsPlanned - target);
  const used = w.flexibleSpent + w.flexibleReserved + extraSavings;
  const cash = today >= start && today <= end ? periodCash(state, today, end) : null;
  const basis = byCash && cash ? "cash" : "plan";
  const budget = basis === "cash" && cash ? cash.left + used : incomePlan - mandatoryPlan - target;
  const days = diffDays(start, end) + 1;
  const daysLeft = today < start ? days : today > end ? 0 : diffDays(today, end) + 1;
  const spentBeforeToday = w.flexibleSpent - w.flexibleToday;
  return {
    start,
    end,
    days,
    daysLeft,
    income: { fact: w.incomeFact, plan: incomePlan },
    mandatory: { fact: w.mandatoryFact, plan: mandatoryPlan },
    savings: { fact: w.savingsFact, target, planned: w.savingsPlanned },
    flexible: {
      budget,
      spent: w.flexibleSpent,
      spentToday: w.flexibleToday,
      reserved: w.flexibleReserved,
      extraSavings,
      left: budget - used,
    },
    perDay: daysLeft > 0 ? floorToRubles((budget - spentBeforeToday - w.flexibleReserved - extraSavings) / daysLeft) : 0,
    basis,
    cash,
  };
}

export interface BudgetPeriod {
  /** pay — от зарплаты до зарплаты; month — календарный месяц (выбран или нет регулярной зарплаты). */
  kind: "pay" | "month";
  current: PeriodBudget;
  /** Поступление, которым текущий период закончится («до аванса 25 окт.»). */
  next: PayEvent | null;
  /** Следующий период — с этого поступления до следующего: сколько будет в день после него. */
  after: PeriodBudget | null;
  /**
   * Выплата, с которой начался период, — по расписанию, в приложении её нет (учёт начали позже или она не пришла).
   * Сколько от неё осталось, приложение не знает: текущий период — по деньгам на счетах, а не по плановой сумме.
   */
  missedPay: PayEvent | null;
}

/** Текущий период бюджета: от последней зарплаты или аванса до дня перед следующим (или календарный месяц). */
export function budgetPeriod(state: State, today: IsoDate): BudgetPeriod {
  const month = monthKeyOf(today);
  const asMonth: BudgetPeriod = {
    kind: "month",
    current: periodBudget(state, firstDayOfMonth(month), lastDayOfMonth(month), today),
    next: null,
    after: null,
    missedPay: null,
  };
  if (state.settings.budgetPeriod === "month") return asMonth;
  // Одно поступление в день — граница.
  const events = payEvents(state, today).filter((e, i, list) => i === 0 || list[i - 1].date !== e.date);
  const start = events.filter((e) => e.date <= today).at(-1);
  const next = events.find((e) => e.date > today);
  if (!start || !next || diffDays(start.date, today) > 45) return asMonth;
  const following = events.find((e) => e.date > next.date);
  return {
    kind: "pay",
    current: periodBudget(state, start.date, addDays(next.date, -1), today, !start.received),
    next,
    after: following ? periodBudget(state, next.date, addDays(following.date, -1), today) : null,
    missedPay: start.received ? null : start,
  };
}

/** Что с периодом от зарплаты до зарплаты — для настроек: какой период сейчас или почему не получилось. */
export function payPeriodStatus(state: State, today: IsoDate): { ok: boolean; text: string } {
  if (state.settings.budgetPeriod === "month") return { ok: true, text: "Считаем по календарному месяцу, с 1-го по последнее число." };
  const templates = state.templates.filter((t) => t.active && t.kind === "income" && isPayIncome(t));
  if (!templates.length) {
    return {
      ok: false,
      text: "Нет регулярного дохода «Зарплата» или «Аванс». Добавьте его на вкладке «Регулярные» — пока считаем по календарному месяцу.",
    };
  }
  const period = budgetPeriod(state, today);
  if (period.kind === "pay" && period.next) {
    return { ok: true, text: `Сейчас: с ${formatDay(period.current.start)} до ${payEventName(period.next)} ${formatDay(period.next.date)}.` };
  }
  const reasons = templates.map((t) => {
    const name = `«${t.title}» ${t.dayOfMonth}-го`;
    if (t.endDate && t.endDate < today) return `${name} — закончился ${formatDay(t.endDate)}`;
    if (t.startDate > today) return `${name} — начнётся ${formatDay(t.startDate)}`;
    return `${name} — с ${formatDay(t.startDate)}`;
  });
  return {
    ok: false,
    text: `Не получилось определить период — пока считаем по месяцу. Регулярные доходы: ${reasons.join("; ")}.`,
  };
}

/** «до аванса», «после зарплаты»: родительный падеж поступления. */
export function payEventName(event: Pick<PayEvent, "category" | "title">): string {
  if (event.category === "Аванс" || /аванс/i.test(event.title)) return "аванса";
  if (event.category === "Зарплата" || /зарплат|оклад|заработн/i.test(event.title)) return "зарплаты";
  return `«${event.title}»`;
}

/** Остаток в карточке периода — что показать и как подписать. */
export interface PeriodLeftView {
  left: Kopecks;
  /** Сколько из бюджета уже недоступно: бюджет − остаток (для полоски). */
  used: Kopecks;
  label: string;
  /** Почему остаток — по деньгам на счетах. */
  note: string | null;
}

/** Остаток гибкого бюджета, но не больше денег на счетах для трат до конца периода. */
export function periodLeftView(period: BudgetPeriod): PeriodLeftView {
  const { current, missedPay } = period;
  const f = current.flexible;
  const planLeft = f.left;
  // По деньгам — и когда бюджет по ним посчитан (тогда f.left = cash.left), и когда денег меньше, чем по плану.
  const byCash = current.basis === "cash" || (current.cash !== null && current.cash.left < planLeft);
  const left = byCash && current.cash ? current.cash.left : planLeft;
  let note: string | null = null;
  if (missedPay) {
    const name = payEventName(missedPay);
    note = `${name[0].toUpperCase()}${name.slice(1)} ${formatDay(missedPay.date)} в приложении нет — считаем по деньгам на счетах.`;
  } else if (byCash) {
    const plan = formatMoney(Math.abs(planLeft), { whole: true });
    note = `${planLeft < 0 ? `По плану перерасход ${plan}` : `По плану осталось бы ${plan}`}, но на счетах для трат меньше.`;
  }
  return {
    left,
    used: f.budget - left,
    label: byCash
      ? left < 0
        ? "Не хватает на счетах для трат"
        : "Осталось на счетах для трат"
      : left < 0
        ? "Перерасход гибкого бюджета"
        : "Осталось в гибком бюджете",
    note,
  };
}

/**
 * «Сколько можно потратить сегодня» — детерминированно, без LLM.
 * Берём меньшее из двух: дневной лимит гибкого бюджета месяца и деньги на счёте,
 * поделённые на дни до ближайшего дохода за вычетом обязательных платежей до него.
 * Если в этом месяце доходов в плане нет (например, первая зарплата — в следующем), бюджета месяца
 * не существует: лимит считается только по деньгам на счёте, статус — «no-income».
 */
export function safeToSpend(state: State, today: IsoDate): SafeToSpend {
  const month = monthKeyOf(today);
  // Бюджет — за период от зарплаты до зарплаты (или за месяц, если так выбрано или регулярной зарплаты нет).
  const period = budgetPeriod(state, today);
  const spentToday = period.current.flexible.spentToday;

  const events = upcomingEvents(state, today, addDays(today, 62));
  const nextIncome = events.find((e) => e.type === "income");
  const horizon: SafeToSpend["horizon"] = nextIncome
    ? { date: nextIncome.date, reason: "income", title: nextIncome.title }
    : { date: lastDayOfMonth(month), reason: "month-end" };

  // До дохода: дни с сегодня по день перед доходом; до конца месяца — включая последний день.
  const daysUntil = Math.max(1, diffDays(today, horizon.date) + (horizon.reason === "month-end" ? 1 : 0));
  let plannedOut = 0;
  for (const e of events) {
    const inWindow = horizon.reason === "income" ? e.date < horizon.date : e.date <= horizon.date;
    if (inWindow && e.effect < 0) plannedOut += -e.effect;
  }

  // Деньги до сегодняшних гибких трат: возвращаем только траты со счетов, которые учитываются (покупка
  // по кредитке денег на счетах не уменьшала).
  const spending = spendingAccountIds(state);
  let spentTodayCash = 0;
  for (const tx of state.transactions) {
    if (tx.date === today && tx.type === "expense" && !tx.mandatory) spentTodayCash -= spendingEffect(spending, tx);
  }
  const cashNow = balanceAt(state, today) + spentTodayCash;
  const cashAvailable = cashNow - plannedOut;
  const cashPerDay = floorToRubles(cashAvailable / daysUntil);
  const budgetPerDay = period.current.perDay;
  // По деньгам на счетах (выплаты, с которой начался период, в приложении нет) — бюджет есть, даже без доходов.
  const usesBudget = period.current.income.plan > 0 || period.current.basis === "cash";

  const recommended = Math.max(0, usesBudget ? Math.min(budgetPerDay, cashPerDay) : cashPerDay);
  const leftToday = recommended - spentToday;

  const negative = events.find((e) => e.balanceAfter < 0);
  const gapDate = balanceAt(state, today) < 0 ? today : negative?.date ?? null;

  let status: SafeToSpendStatus;
  if (cashAvailable < 0 || (gapDate !== null && gapDate <= horizon.date)) status = "gap";
  else if (!usesBudget) status = "no-income";
  // Бюджет месяца исчерпан (рекомендация обрезана до нуля) — это не «ok», даже если ничего не потрачено.
  else if (budgetPerDay <= 0 || leftToday < 0) status = "over";
  else if (cashPerDay < budgetPerDay) status = "tight";
  else status = "ok";

  return {
    recommended,
    spentToday,
    leftToday,
    budgetPerDay,
    cashPerDay,
    horizon,
    daysUntil,
    cashNow,
    usesBudget,
    plannedOut,
    status,
    gapDate,
    period,
  };
}

/** Лимит категории без учёта регистра букв. */
export function findCategoryLimit(state: State, category: string): Kopecks | null {
  const exact = getOwn(state.categoryLimits, category);
  if (exact !== undefined) return exact;
  const key = category.trim().toLocaleLowerCase("ru");
  for (const [name, limit] of Object.entries(state.categoryLimits)) {
    if (name.trim().toLocaleLowerCase("ru") === key) return limit;
  }
  return null;
}

export interface CategoryRow {
  category: string;
  amount: Kopecks;
  count: number;
  share: number;
  limit: Kopecks | null;
}

export type BreakdownKind = "income" | "expense" | "flexible" | "mandatory";

/** Суммы по категориям за период [from, to]. */
export function categoryBreakdown(state: State, from: IsoDate, to: IsoDate, kind: BreakdownKind): CategoryRow[] {
  const sums = new Map<string, { amount: number; count: number }>();
  let total = 0;
  for (const tx of state.transactions) {
    if (tx.date < from || tx.date > to) continue;
    const match =
      kind === "income"
        ? tx.type === "income"
        : tx.type === "expense" &&
          (kind === "expense" || (kind === "mandatory" ? Boolean(tx.mandatory) : !tx.mandatory));
    if (!match) continue;
    const name = tx.category || "Без категории";
    const row = sums.get(name) ?? { amount: 0, count: 0 };
    row.amount += tx.amount;
    row.count += 1;
    sums.set(name, row);
    total += tx.amount;
  }
  const withLimits = kind !== "income" && monthKeyOf(from) === monthKeyOf(to);
  return [...sums.entries()]
    .map(([category, { amount, count }]) => ({
      category,
      amount,
      count,
      share: total > 0 ? amount / total : 0,
      limit: withLimits ? findCategoryLimit(state, category) : null,
    }))
    .sort((a, b) => b.amount - a.amount);
}

export interface PeriodTotals {
  income: Kopecks;
  expense: Kopecks;
  mandatory: Kopecks;
  flexible: Kopecks;
  savings: Kopecks;
  adjustments: Kopecks;
}

export function periodTotals(state: State, from: IsoDate, to: IsoDate): PeriodTotals {
  const totals: PeriodTotals = { income: 0, expense: 0, mandatory: 0, flexible: 0, savings: 0, adjustments: 0 };
  for (const tx of state.transactions) {
    if (tx.date < from || tx.date > to) continue;
    if (tx.type === "income") totals.income += tx.amount;
    else if (tx.type === "expense") {
      totals.expense += tx.amount;
      if (tx.mandatory) totals.mandatory += tx.amount;
      else totals.flexible += tx.amount;
    } else if (tx.type === "saving") totals.savings += tx.amount;
    else if (tx.type === "adjustment") totals.adjustments += tx.amount;
  }
  return totals;
}

/** Остаток гибкого бюджета прошлого месяца, который ещё не решили, куда деть. */
export function pendingRollover(state: State, today: IsoDate): { month: MonthKey; amount: Kopecks } | null {
  const month = addMonths(monthKeyOf(today), -1);
  if (getOwn(state.rollover, month)) return null;
  const first = firstDayOfMonth(month);
  const last = lastDayOfMonth(month);
  if (!state.transactions.some((tx) => tx.date >= first && tx.date <= last)) return null;
  const amount = Math.min(monthMetrics(state, month, today).flexible.left, balanceAt(state, today));
  return amount > 0 ? { month, amount } : null;
}
