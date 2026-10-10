import {
  addDays,
  addMonths,
  daysInMonth,
  diffDays,
  firstDayOfMonth,
  lastDayOfMonth,
  monthKeyOf,
  parseIsoDate,
  type IsoDate,
  type MonthKey,
} from "./dates";
import { formatMoney, percentOf, type Kopecks } from "./money";
import { getOwn } from "./records";
import { plannedOccurrences } from "./recurring";
import { salarySavingAmount } from "./savings";
import {
  MAIN_ACCOUNT_ID,
  accountBalances,
  creditDebts,
  savingsAccountIds,
  spendingAccountIds,
  spendingEffect,
} from "./accounts";
import type { Goal, Loan, Settings, State, Transaction } from "./schema";

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

export function goalSaved(state: State, goal: Goal): Kopecks {
  let sum = goal.initialAmount;
  for (const tx of state.transactions) if (tx.type === "saving" && tx.goalId === goal.id) sum += tx.amount;
  return sum;
}

/**
 * Сколько из сбережений лежит на целях (накоплено в приложении, без initialAmount): эти деньги
 * снимают с самой цели, а не из общих сбережений — иначе одни и те же деньги сняли бы дважды.
 */
export function goalsReserved(state: State): Kopecks {
  const perGoal = new Map<string, Kopecks>();
  for (const goal of state.goals) perGoal.set(goal.id, 0);
  for (const tx of state.transactions) {
    if (tx.type !== "saving" || tx.goalId === undefined) continue;
    const sum = perGoal.get(tx.goalId);
    if (sum !== undefined) perGoal.set(tx.goalId, sum + tx.amount);
  }
  let reserved = 0;
  for (const sum of perGoal.values()) reserved += Math.max(0, sum);
  return reserved;
}

/** Знак корректировки, с которой долг открыт через счёт: взял в долг — деньги пришли (+), дал — ушли (−). */
export function loanOpeningSign(kind: Loan["kind"]): 1 | -1 {
  return kind === "lend" ? -1 : 1;
}

/**
 * Корректировка остатка, созданная вместе с долгом (деньги прошли через счёт). Отмечена loanOpening.
 * У долгов, созданных до этой отметки, — первая корректировка долга со знаком открытия: платежи
 * по таким долгам тогда записывались доходом или расходом, а корректировки-платежи имеют обратный знак.
 */
export function loanOpening(state: State, loan: Loan): Transaction | undefined {
  const sign = loanOpeningSign(loan.kind);
  let legacy: Transaction | undefined;
  for (const tx of state.transactions) {
    if (tx.type !== "adjustment" || tx.loanId !== loan.id) continue;
    if (tx.loanOpening) return tx;
    if (!legacy && Math.sign(tx.amount) === sign) legacy = tx;
  }
  return legacy;
}

/**
 * Погашено (или возвращено): до приложения + платежи. Платёж — доход/расход по долгу или,
 * если деньги долга прошли через счёт, корректировка (по модулю). Корректировка открытия — не платёж.
 */
export function loanPaid(state: State, loan: Loan): Kopecks {
  const opening = loanOpening(state, loan);
  let sum = loan.initialPaid;
  for (const tx of state.transactions) {
    if (tx.loanId !== loan.id || tx === opening) continue;
    if (tx.type === "income" || tx.type === "expense") sum += tx.amount;
    else if (tx.type === "adjustment") sum += Math.abs(tx.amount);
  }
  return sum;
}

export function loanRemaining(state: State, loan: Loan): Kopecks {
  return Math.max(0, loan.amount - loanPaid(state, loan));
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
  savings: { fact: Kopecks; target: Kopecks };
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

export function monthMetrics(state: State, month: MonthKey, today: IsoDate): MonthMetrics {
  const status = monthStatus(month, today);
  const first = firstDayOfMonth(month);
  const last = lastDayOfMonth(month);
  // Всё, что не позже cutoff, — факт; позже — план.
  const cutoff = status === "past" ? last : status === "future" ? addDays(first, -1) : today;

  let incomeFact = 0;
  let incomeFuture = 0;
  let mandatoryFact = 0;
  let mandatoryFuture = 0;
  let flexibleSpent = 0;
  let flexibleToday = 0;
  let flexibleReserved = 0;
  let savingsFact = 0;

  for (const tx of state.transactions) {
    if (tx.date < first || tx.date > last) continue;
    const isFact = tx.date <= cutoff;
    if (tx.type === "income") {
      if (isFact) incomeFact += tx.amount;
      else incomeFuture += tx.amount;
    } else if (tx.type === "expense" && tx.mandatory) {
      if (isFact) mandatoryFact += tx.amount;
      else mandatoryFuture += tx.amount;
    } else if (tx.type === "expense") {
      if (isFact) {
        flexibleSpent += tx.amount;
        if (tx.date === today) flexibleToday += tx.amount;
      } else {
        flexibleReserved += tx.amount;
      }
    } else if (tx.type === "saving" && isFact && !tx.rolloverOf) {
      // Перенос остатка прошлого месяца — не сбережения этого: он не урезает гибкий бюджет месяца.
      savingsFact += tx.amount;
    }
  }

  for (const occ of plannedOccurrences(state, cutoff, last)) {
    if (occ.kind === "income") incomeFuture += occ.amount;
    else mandatoryFuture += occ.amount;
  }

  const incomePlan = incomeFact + incomeFuture;
  const mandatoryPlan = mandatoryFact + mandatoryFuture;
  const savingsTarget = percentOf(incomePlan, savingsRateFor(state.settings, month));
  const budget = incomePlan - mandatoryPlan - savingsTarget;
  const extraSavings = Math.max(0, savingsFact - savingsTarget);
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
    savings: { fact: savingsFact, target: savingsTarget },
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
    events.push({
      key: `plan:${occ.templateId}.${occ.month}`,
      date: occ.date,
      type: occ.kind,
      title: occ.title,
      category: occ.category,
      effect: onSpending(occ.accountId) ? (occ.kind === "income" ? occ.amount : -occ.amount) : 0,
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
  for (const credit of creditDebts(state, today)) {
    if (!credit.graceEnd) continue;
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
  const metrics = monthMetrics(state, month, today);
  const spentToday = metrics.flexible.spentToday;

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
  const budgetPerDay = metrics.daily.availableToday;
  const usesBudget = metrics.income.plan > 0;

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
