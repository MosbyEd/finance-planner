import {
  addDays,
  addMonths,
  clampedDayOfMonth,
  daysInMonth,
  monthKeyOf,
  monthRange,
  type IsoDate,
  type MonthKey,
} from "./dates";
import { getOwn } from "./records";
import type { State, Template } from "./schema";

/**
 * Шаблон начисляет не больше одной операции в месяц. Начисление идентифицируется парой
 * (шаблон, месяц), поэтому перенос даты операции или смена дня в шаблоне не создают дублей.
 */
export interface Occurrence {
  templateId: string;
  month: MonthKey;
  date: IsoDate;
  kind: Template["kind"];
  title: string;
  category: string;
  amount: number;
  /** Счёт шаблона (нет — основной). */
  accountId?: string;
  /** Куда идут деньги: свой счёт или кредит (см. Template). */
  toAccountId?: string;
  loanId?: string;
}

/**
 * Насколько глубоко в прошлое (в месяцах до текущего) создаются пропущенные начисления.
 * Более старые месяцы не начисляются никогда: шаблон с датой начала в 1970 году иначе
 * заставил бы перебирать сотни месяцев при каждой синхронизации (и на сервере, и на устройстве).
 * Обычный шаблон синхронизируется хотя бы раз в пару лет, поэтому на практике ничего не теряется.
 */
export const MAX_BACKFILL_MONTHS = 24;

export function occurrenceDate(template: Pick<Template, "dayOfMonth">, month: MonthKey): IsoDate {
  return clampedDayOfMonth(month, template.dayOfMonth);
}

export function occurrenceTxId(templateId: string, month: MonthKey): string {
  return `${templateId}.${month}`;
}

function key(templateId: string, month: MonthKey): string {
  return `${templateId}|${month}`;
}

/** Множество уже начисленных пар (шаблон, месяц). */
export function materializedKeys(state: State): Set<string> {
  const keys = new Set<string>();
  for (const tx of state.transactions) {
    if (tx.templateId && tx.occurrenceMonth) keys.add(key(tx.templateId, tx.occurrenceMonth));
  }
  return keys;
}

/** Пропущенные месяцы шаблона (только собственные ключи записи — id вроде «toString» безопасны). */
export function skippedMonths(state: State, templateId: string): readonly MonthKey[] {
  return getOwn(state.skipped, templateId) ?? [];
}

export function isSkipped(state: State, templateId: string, month: MonthKey): boolean {
  return skippedMonths(state, templateId).includes(month);
}

/**
 * Быстрые проверки «начислено» и «пропущено» для одного прохода по месяцам [from, to].
 * Строится один раз за вызов: операции и пропуски вне окна сразу отбрасываются.
 */
interface OccurrenceIndex {
  isDone(templateId: string, month: MonthKey): boolean;
  isSkipped(templateId: string, month: MonthKey): boolean;
}

function occurrenceIndex(state: State, from: MonthKey, to: MonthKey): OccurrenceIndex {
  const done = new Map<string, Set<MonthKey>>();
  for (const tx of state.transactions) {
    const month = tx.occurrenceMonth;
    if (!tx.templateId || !month || month < from || month > to) continue;
    let months = done.get(tx.templateId);
    if (!months) {
      months = new Set();
      done.set(tx.templateId, months);
    }
    months.add(month);
  }
  const skipped = new Map<string, Set<MonthKey>>();
  return {
    isDone: (templateId, month) => done.get(templateId)?.has(month) ?? false,
    isSkipped: (templateId, month) => {
      let months = skipped.get(templateId);
      if (!months) {
        months = new Set();
        for (const m of skippedMonths(state, templateId)) if (m >= from && m <= to) months.add(m);
        skipped.set(templateId, months);
      }
      return months.has(month);
    },
  };
}

/** Месяц окна с заранее посчитанным префиксом даты и числом дней — чтобы не разбирать строки на каждый шаблон. */
interface MonthSlot {
  month: MonthKey;
  prefix: string;
  days: number;
}

function monthSlots(from: MonthKey, to: MonthKey): MonthSlot[] {
  return monthRange(from, to).map((month) => ({ month, prefix: `${month}-`, days: daysInMonth(month) }));
}

/** То же, что occurrenceDate, но без разбора строки месяца. */
function slotDate(slot: MonthSlot, dayOfMonth: number): IsoDate {
  const day = Math.min(Math.max(1, dayOfMonth), slot.days);
  return `${slot.prefix}${day < 10 ? "0" : ""}${day}`;
}

function toOccurrence(template: Template, month: MonthKey, date: IsoDate): Occurrence {
  return {
    templateId: template.id,
    month,
    date,
    kind: template.kind,
    title: template.title,
    category: template.category,
    amount: template.amount,
    ...(template.accountId ? { accountId: template.accountId } : {}),
    ...(template.toAccountId ? { toAccountId: template.toAccountId } : {}),
    ...(template.loanId ? { loanId: template.loanId } : {}),
  };
}

/**
 * Начисления, которые к дате today уже должны были произойти, но ещё не созданы.
 * Смотрим не дальше MAX_BACKFILL_MONTHS месяцев назад от today.
 */
export function dueOccurrences(state: State, today: IsoDate): Occurrence[] {
  const todayMonth = monthKeyOf(today);
  const earliest = addMonths(todayMonth, -MAX_BACKFILL_MONTHS);
  const slots = monthSlots(earliest, todayMonth);
  const index = occurrenceIndex(state, earliest, todayMonth);
  const result: Occurrence[] = [];
  for (const template of state.templates) {
    if (!template.active || template.startDate > today) continue;
    const startMonth = monthKeyOf(template.startDate);
    for (const slot of slots) {
      if (slot.month < startMonth) continue;
      const date = slotDate(slot, template.dayOfMonth);
      if (date < template.startDate || date > today) continue;
      if (index.isDone(template.id, slot.month) || index.isSkipped(template.id, slot.month)) continue;
      result.push(toOccurrence(template, slot.month, date));
    }
  }
  // Обычное сравнение строк, без localeCompare: порядок создаваемых операций не зависит от локали устройства.
  return result.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

/** Будущие начисления с датой в интервале (after, until]. */
export function plannedOccurrences(state: State, after: IsoDate, until: IsoDate): Occurrence[] {
  if (until <= after) return [];
  const firstDay = addDays(after, 1);
  const firstMonth = monthKeyOf(firstDay);
  const lastMonth = monthKeyOf(until);
  const slots = monthSlots(firstMonth, lastMonth);
  const index = occurrenceIndex(state, firstMonth, lastMonth);
  const result: Occurrence[] = [];
  for (const template of state.templates) {
    if (!template.active) continue;
    const startMonth = monthKeyOf(template.startDate);
    for (const slot of slots) {
      if (slot.month < startMonth) continue;
      const date = slotDate(slot, template.dayOfMonth);
      if (date <= after || date > until || date < template.startDate) continue;
      if (index.isDone(template.id, slot.month) || index.isSkipped(template.id, slot.month)) continue;
      result.push(toOccurrence(template, slot.month, date));
    }
  }
  return result.sort((a, b) => a.date.localeCompare(b.date) || a.title.localeCompare(b.title));
}

/** Ближайшее будущее начисление шаблона (после today), если оно есть в пределах года. */
export function nextOccurrence(state: State, template: Template, today: IsoDate): Occurrence | null {
  if (!template.active) return null;
  const single: State = { ...state, templates: [template] };
  return plannedOccurrences(single, today, addDays(today, 400))[0] ?? null;
}
