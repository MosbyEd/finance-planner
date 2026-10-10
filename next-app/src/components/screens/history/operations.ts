import type { IsoDate } from "@/domain/dates";
import { balanceEffect } from "@/domain/metrics";
import type { Kopecks } from "@/domain/money";
import type { Transaction, TransactionType } from "@/domain/schema";

export type TypeFilter = "all" | TransactionType;

export const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "expense", label: "Расходы" },
  { value: "income", label: "Доходы" },
  { value: "saving", label: "Сбережения" },
  { value: "adjustment", label: "Корректировки" },
  { value: "transfer", label: "Переводы" },
];

export function normalizeText(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
}

export interface Totals {
  income: Kopecks;
  expense: Kopecks;
  mandatory: Kopecks;
  savings: Kopecks;
  /** Из отложенного — перенос остатка прошлого месяца (в «Отложено» месяца на главной он не входит). */
  rollover: Kopecks;
  adjustments: Kopecks;
  /** Переводы между своими счетами (на остаток в целом не влияют). */
  transfers: Kopecks;
  /** Среди корректировок есть движения по долгам через счёт. */
  loanAdjustments: boolean;
  /** Изменение остатка на счёте: доходы − расходы − отложено + корректировки. */
  net: Kopecks;
}

export function totalsOf(list: readonly Transaction[]): Totals {
  const t: Totals = {
    income: 0,
    expense: 0,
    mandatory: 0,
    savings: 0,
    rollover: 0,
    adjustments: 0,
    transfers: 0,
    loanAdjustments: false,
    net: 0,
  };
  for (const tx of list) {
    if (tx.type === "income") t.income += tx.amount;
    else if (tx.type === "expense") {
      t.expense += tx.amount;
      if (tx.mandatory) t.mandatory += tx.amount;
    } else if (tx.type === "saving") {
      t.savings += tx.amount;
      if (tx.rolloverOf) t.rollover += tx.amount;
    } else if (tx.type === "transfer") {
      t.transfers += tx.amount;
    } else {
      t.adjustments += tx.amount;
      if (tx.loanId) t.loanAdjustments = true;
    }
    t.net += balanceEffect(tx);
  }
  return t;
}

export interface DayGroup {
  date: IsoDate;
  items: Transaction[];
}

/** Группирует уже отсортированный список по дням, сохраняя порядок. */
export function groupByDay(list: readonly Transaction[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const tx of list) {
    const last = groups[groups.length - 1];
    if (last && last.date === tx.date) last.items.push(tx);
    else groups.push({ date: tx.date, items: [tx] });
  }
  return groups;
}

export interface HistoryFilter {
  from: IsoDate;
  to: IsoDate;
  type: TypeFilter;
  query: string;
  today: IsoDate;
}

export interface HistoryData {
  /** Строки списка до сегодняшнего дня включительно: от новых к старым, внутри дня сверху добавленные позже. */
  past: Transaction[];
  /** Строки с будущей датой: от ближайших к дальним. */
  planned: Transaction[];
  /** Итоги по всем подходящим прошедшим операциям — вместе с автоотчислениями, свёрнутыми в подпись. */
  totals: Totals;
  /** Как изменят остаток запланированные операции (тоже вместе с автоотчислениями). */
  plannedNet: Kopecks;
  /** Расходы по дням среди подходящих операций — для подписи у заголовка дня. */
  daySpent: Map<IsoDate, Kopecks>;
}

/**
 * Операции для экрана «История»: фильтр по периоду, типу и строке поиска, сортировка и итоги.
 *
 * Автоотчисление («Отложено с покупки «…»») не занимает отдельную строку, если в списке есть его исходная
 * операция: сумма показывается подписью у неё. Если исходной в списке нет (фильтр «Сбережения», поиск
 * нашёл только отчисление, исходную удалили) — отчисление остаётся строкой, чтобы ничего не терялось.
 * На итоги и расходы дня сворачивание не влияет: они считаются по всем подходящим операциям.
 */
export function historyData(transactions: readonly Transaction[], filter: HistoryFilter): HistoryData {
  const { from, to, type, query, today } = filter;
  const needle = normalizeText(query);
  const filtered: { tx: Transaction; index: number }[] = [];
  transactions.forEach((tx, index) => {
    if (tx.date < from || tx.date > to) return;
    if (type !== "all" && tx.type !== type) return;
    if (needle && !normalizeText(`${tx.title}\n${tx.category}`).includes(needle)) return;
    filtered.push({ tx, index });
  });

  const daySpent = new Map<IsoDate, Kopecks>();
  for (const { tx } of filtered) {
    if (tx.type === "expense") daySpent.set(tx.date, (daySpent.get(tx.date) ?? 0) + tx.amount);
  }

  const matchedIds = new Set(filtered.map((e) => e.tx.id));
  const folded = (tx: Transaction) => tx.linkedTo !== undefined && matchedIds.has(tx.linkedTo);

  // Прошедшие — от новых к старым; запланированные — от ближайших к дальним.
  // Внутри дня сверху то, что добавили позже.
  const pastAll = filtered
    .filter((e) => e.tx.date <= today)
    .sort((a, b) => b.tx.date.localeCompare(a.tx.date) || b.index - a.index)
    .map((e) => e.tx);
  const plannedAll = filtered
    .filter((e) => e.tx.date > today)
    .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || b.index - a.index)
    .map((e) => e.tx);

  return {
    past: pastAll.filter((tx) => !folded(tx)),
    planned: plannedAll.filter((tx) => !folded(tx)),
    totals: totalsOf(pastAll),
    plannedNet: totalsOf(plannedAll).net,
    daySpent,
  };
}
