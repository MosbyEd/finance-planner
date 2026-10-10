import { addDays, diffDays, formatDay, parseIsoDate, type IsoDate } from "./dates";
import { loanRemaining, safeToSpend, upcomingEvents } from "./metrics";
import { formatMoney } from "./money";
import type { State } from "./schema";

/**
 * Локальные уведомления: какие напоминания запланировать на телефоне по данным бюджета.
 * Чистая функция — планирование (iOS) делает клиент, здесь только «что и когда».
 */

export interface NotificationPrefs {
  /** Накануне обязательного платежа. */
  payments: boolean;
  /** В день ожидаемого дохода. */
  income: boolean;
  /** Если прогноз остатка уходит в минус в ближайшую неделю. */
  cashGap: boolean;
  /** Сроки возврата долгов. */
  debts: boolean;
  /** Каждый вечер: «внесите траты за сегодня». */
  dailyReminder: boolean;
  /** Время ежедневного напоминания, «ЧЧ:ММ». */
  reminderTime: string;
  /** Время утренних уведомлений о платежах, доходах и долгах, «ЧЧ:ММ». */
  morningTime: string;
}

export function defaultNotificationPrefs(): NotificationPrefs {
  return {
    payments: true,
    income: true,
    cashGap: true,
    debts: true,
    dailyReminder: true,
    reminderTime: "21:00",
    morningTime: "10:00",
  };
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export function isValidTime(value: unknown): value is string {
  return typeof value === "string" && TIME_RE.test(value);
}

export function parseTime(value: string): { hour: number; minute: number } {
  const m = TIME_RE.exec(value);
  return m ? { hour: Number(m[1]), minute: Number(m[2]) } : { hour: 10, minute: 0 };
}

export interface PlannedNotification {
  /** Устойчивый номер (одинаковый для одного и того же напоминания при каждом перепланировании). */
  id: number;
  key: string;
  date: IsoDate;
  time: string;
  title: string;
  body: string;
}

export interface NotificationPlan {
  scheduled: PlannedNotification[];
  /** Ежедневное напоминание (повторяется само), если включено. */
  daily: { id: number; time: string; title: string; body: string } | null;
}

/** Номер ежедневного напоминания; остальные получают номера из хэша ключа. */
export const DAILY_REMINDER_ID = 1;
/** iOS хранит не больше 64 запланированных уведомлений на приложение. */
const MAX_SCHEDULED = 60;

function hashId(key: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  const id = (h >>> 0) & 0x7fffffff;
  return id <= DAILY_REMINDER_ID ? id + 2 : id;
}

function joinItems(items: string[]): string {
  return items.length <= 3 ? items.join(", ") : `${items.slice(0, 3).join(", ")} и ещё ${items.length - 3}`;
}

/**
 * План уведомлений на horizonDays вперёд.
 * now — текущее время «ЧЧ:ММ»: напоминания на сегодня, время которых уже прошло, не планируются.
 */
export function planNotifications(
  state: State,
  today: IsoDate,
  now: string,
  prefs: NotificationPrefs,
  horizonDays = 30,
): NotificationPlan {
  const morning = isValidTime(prefs.morningTime) ? prefs.morningTime : "10:00";
  const isFuture = (date: IsoDate, time: string) => date > today || (date === today && time > now);
  const result: PlannedNotification[] = [];
  const add = (key: string, date: IsoDate, time: string, title: string, body: string) => {
    if (isFuture(date, time)) result.push({ id: hashId(key), key, date, time, title, body });
  };

  const events = upcomingEvents(state, today, addDays(today, horizonDays + 1));

  if (prefs.payments) {
    // Обязательные платежи одного дня — одним уведомлением накануне.
    const byDay = new Map<IsoDate, { items: string[]; short: boolean }>();
    for (const e of events) {
      if (e.type !== "expense" || !e.mandatory) continue;
      const day = byDay.get(e.date) ?? { items: [], short: false };
      day.items.push(`${e.title} — ${formatMoney(-e.effect)}`);
      if (e.balanceAfter < 0) day.short = true;
      byDay.set(e.date, day);
    }
    for (const [date, day] of byDay) {
      const title = day.items.length === 1 ? "Завтра обязательный платёж" : "Завтра обязательные платежи";
      const body = `${joinItems(day.items)}.${day.short ? " По прогнозу денег на счёте не хватит." : ""}`;
      add(`payments:${date}`, addDays(date, -1), morning, title, body);
    }
  }

  if (prefs.income) {
    for (const e of events) {
      if (e.type !== "income") continue;
      add(`income:${e.key}`, e.date, morning, "Сегодня ожидается доход", `${e.title} — ${formatMoney(e.effect)}`);
    }
  }

  if (prefs.cashGap) {
    const gap = safeToSpend(state, today).gapDate;
    if (gap && gap > today && diffDays(today, gap) <= 7) {
      const when = isFuture(today, morning) ? today : addDays(today, 1);
      if (when < gap) {
        add(
          `gap:${gap}`,
          when,
          morning,
          "Скоро кассовый разрыв",
          `${formatDay(gap)} по прогнозу денег на счёте не хватит на обязательные платежи. Загляните в приложение.`,
        );
      }
    }
  }

  if (prefs.debts) {
    const until = addDays(today, horizonDays);
    for (const loan of state.loans) {
      if (!loan.dueDate || loan.dueDate < today || loan.dueDate > until) continue;
      const remaining = loanRemaining(state, loan);
      if (remaining <= 0) continue;
      if (loan.kind === "lend") {
        add(`lend:${loan.id}:${loan.dueDate}`, loan.dueDate, morning, "Сегодня срок возврата вам", `«${loan.name}» должен вернуть ${formatMoney(remaining)}.`);
      } else {
        add(
          `debt:${loan.id}:${loan.dueDate}`,
          addDays(loan.dueDate, -1),
          morning,
          "Завтра срок возврата долга",
          `«${loan.name}»: осталось ${formatMoney(remaining)}.`,
        );
      }
    }
  }

  result.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time) || a.id - b.id);
  const unique = result.filter((n, i) => result.findIndex((m) => m.id === n.id) === i);

  return {
    scheduled: unique.slice(0, MAX_SCHEDULED),
    daily:
      prefs.dailyReminder && isValidTime(prefs.reminderTime)
        ? {
            id: DAILY_REMINDER_ID,
            time: prefs.reminderTime,
            title: "Как прошёл день?",
            body: "Внесите сегодняшние траты — так лимит на завтра будет точным.",
          }
        : null,
  };
}

/** Момент уведомления в часовом поясе устройства. */
export function notificationMoment(date: IsoDate, time: string): Date {
  const { year, month, day } = parseIsoDate(date);
  const { hour, minute } = parseTime(time);
  return new Date(year, month - 1, day, hour, minute, 0, 0);
}
