import { accountBalances } from "./accounts";
import type { Kopecks } from "./money";
import type { Goal, Loan, State, Transaction } from "./schema";

/**
 * Сколько накоплено на цель и сколько осталось по долгу — общий расчёт для метрик и регулярных платежей
 * (платёж «пока не закрыт долг / не накоплена цель» останавливается сам).
 */

/**
 * Счёт цели, если он только её: тогда цель и счёт связаны в обе стороны — накоплено столько, сколько лежит
 * на счёте (пополнили счёт любым способом — пополнилась цель). Счёт нескольких целей — null: деньги делятся
 * по пополнениям с отметкой цели.
 */
export function dedicatedGoalAccount(state: State, goal: Goal): string | null {
  if (!goal.accountId) return null;
  return state.goals.some((g) => g.id !== goal.id && g.accountId === goal.accountId) ? null : goal.accountId;
}

export function goalSaved(state: State, goal: Goal): Kopecks {
  const account = dedicatedGoalAccount(state, goal);
  if (account) return Math.max(0, accountBalances(state).get(account) ?? 0);
  let sum = goal.initialAmount;
  for (const tx of state.transactions) if (tx.type === "saving" && tx.goalId === goal.id) sum += tx.amount;
  return sum;
}

/** Сколько можно снять с цели: остаток её счёта или отложенное на неё в приложении (без накопленного до него). */
export function goalAvailable(state: State, goal: Goal): Kopecks {
  return dedicatedGoalAccount(state, goal) ? goalSaved(state, goal) : goalSaved(state, goal) - goal.initialAmount;
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
