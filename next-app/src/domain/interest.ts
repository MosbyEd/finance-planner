import { addDays, diffDays, type IsoDate } from "./dates";
import type { Kopecks } from "./money";
import type { CreditTerms } from "./schema";

/**
 * Проценты по кредитке или кредиту — оценка по условиям из приложения. Долг ведётся отдельно по видам
 * операций: у покупок и у снятия наличных свои ставка и беспроцентный период. Период вида начинается
 * с первой операции этого вида, когда его долга не было, и длится graceDays дней (включая день операции).
 * Не погасили долг вида к концу периода — проценты считаются за все дни с его начала (так делают банки);
 * беспроцентного периода нет — с первого дня. Проценты начисляются на остаток долга на конец каждого дня.
 * Платёж гасит сначала снятие наличных (обычно оно дороже), затем покупки; лишнее — свои деньги на карте,
 * которые следующие операции тратят раньше кредитных.
 */

export type CreditOperation = "purchase" | "cash";
export const CREDIT_OPERATIONS: readonly CreditOperation[] = ["cash", "purchase"];

export const CREDIT_OPERATION_LABEL: Record<CreditOperation, string> = {
  purchase: "Покупки",
  cash: "Снятие наличных",
};

/** Движение по долгу: покупка или снятие увеличивают долг своего вида, платёж гасит. amount > 0. */
export interface CreditMove {
  date: IsoDate;
  kind: CreditOperation | "payment";
  amount: Kopecks;
}

export interface ResolvedTerm {
  /** % годовых; null — ставка не указана, проценты не считаем. */
  rate: number | null;
  /** null — беспроцентного периода нет. */
  graceDays: number | null;
}
export type ResolvedTerms = Record<CreditOperation, ResolvedTerm>;

export interface CreditPart {
  operation: CreditOperation;
  debt: Kopecks;
  rate: number | null;
  /** С какого дня идёт нынешний долг этого вида. */
  since: IsoDate | null;
  /** Последний день без процентов; null — беспроцентного периода нет. */
  graceEnd: IsoDate | null;
  /** Беспроцентный период закончился, а долг остался. */
  overdue: boolean;
  /** Сколько процентов уже набежало (периода нет или он не выполнен). */
  accrued: Kopecks;
  /** Пока идёт беспроцентный период: сколько начислят, если не погасить долг до graceEnd. */
  ifMissed: Kopecks;
  /** Сколько процентов прибавляется за день при нынешнем долге. */
  perDay: Kopecks;
}

export function resolveTerms(terms: CreditTerms | undefined, fallbackGrace: number | undefined): ResolvedTerms {
  // Без условий по видам — все операции идут по одному беспроцентному периоду (как было до условий).
  if (!terms) {
    const term = { rate: null, graceDays: fallbackGrace ?? null };
    return { purchase: term, cash: term };
  }
  const resolve = (t: CreditTerms["purchase"]): ResolvedTerm => ({ rate: t.rate ?? null, graceDays: t.graceDays ?? null });
  return { purchase: resolve(terms.purchase), cash: resolve(terms.cash) };
}

/** Условия указаны хоть в чём-то — ставка или беспроцентный период. */
export function hasTerms(terms: CreditTerms | undefined): boolean {
  return Boolean(terms && CREDIT_OPERATIONS.some((op) => terms[op].rate !== undefined || terms[op].graceDays !== undefined));
}

interface PartState {
  debt: Kopecks;
  since: IsoDate | null;
  /** Сумма долга по дням с since до курсора (рубле-дни в копейках). */
  debtDays: number;
}

/** Долг по видам и проценты на сегодня. moves — по порядку (по дате, внутри дня — как записаны). */
export function creditParts(moves: readonly CreditMove[], terms: ResolvedTerms, today: IsoDate): CreditPart[] {
  const parts: Record<CreditOperation, PartState> = {
    purchase: { debt: 0, since: null, debtDays: 0 },
    cash: { debt: 0, since: null, debtDays: 0 },
  };
  let own = 0;
  let cursor: IsoDate | null = null;
  // Дни от курсора до date (не включая date) — с долгом на конец дня курсора.
  const advance = (date: IsoDate) => {
    if (cursor !== null && date > cursor) {
      const days = diffDays(cursor, date);
      for (const op of CREDIT_OPERATIONS) parts[op].debtDays += parts[op].debt * days;
    }
    if (cursor === null || date > cursor) cursor = date;
  };

  for (const move of moves) {
    if (move.date > today) break;
    advance(move.date);
    if (move.kind === "payment") {
      let left = move.amount;
      for (const op of CREDIT_OPERATIONS) {
        const paid = Math.min(left, parts[op].debt);
        parts[op].debt -= paid;
        left -= paid;
        // Долг вида погашен — его период закончился (проценты за него, если были, банк уже начислил).
        if (parts[op].debt === 0) Object.assign(parts[op], { since: null, debtDays: 0 });
      }
      own += left;
    } else {
      const fromOwn = Math.min(own, move.amount);
      own -= fromOwn;
      const debt = move.amount - fromOwn;
      const part = parts[move.kind];
      if (debt > 0 && part.debt === 0) Object.assign(part, { since: move.date, debtDays: 0 });
      part.debt += debt;
    }
  }
  advance(today);

  return CREDIT_OPERATIONS.map((operation): CreditPart => {
    const { debt, since, debtDays } = parts[operation];
    const { rate, graceDays } = terms[operation];
    const graceEnd = since && graceDays ? addDays(since, graceDays - 1) : null;
    const overdue = debt > 0 && graceEnd !== null && graceEnd < today;
    // За сегодняшний день — тоже (долг на конец дня).
    const untilToday = debtDays + debt;
    const daily = rate === null ? 0 : rate / 100 / 365;
    const charging = debt > 0 && (graceEnd === null || overdue);
    return {
      operation,
      debt,
      rate,
      since: debt > 0 ? since : null,
      graceEnd: debt > 0 ? graceEnd : null,
      overdue,
      accrued: charging ? Math.round(untilToday * daily) : 0,
      ifMissed:
        debt > 0 && graceEnd !== null && !overdue ? Math.round((untilToday + debt * diffDays(today, graceEnd)) * daily) : 0,
      perDay: debt > 0 ? Math.round(debt * daily) : 0,
    };
  });
}
