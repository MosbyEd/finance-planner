/**
 * Даты храним строками «YYYY-MM-DD» (локальная календарная дата без времени и часового пояса),
 * месяцы — «YYYY-MM». Никогда не разбираем такие строки через new Date(str): это UTC и сдвиг на день.
 */
export type IsoDate = string;
export type MonthKey = string;

const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const MONTH_KEY_RE = /^(\d{4})-(\d{2})$/;

export function isValidIsoDate(value: unknown): value is IsoDate {
  if (typeof value !== "string") return false;
  const m = ISO_DATE_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  if (y < 1970 || y > 2200 || mo < 1 || mo > 12 || d < 1) return false;
  return d <= daysInMonthOf(y, mo);
}

export function isValidMonthKey(value: unknown): value is MonthKey {
  if (typeof value !== "string") return false;
  const m = MONTH_KEY_RE.exec(value);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  return y >= 1970 && y <= 2200 && mo >= 1 && mo <= 12;
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

export function toIsoDate(year: number, month: number, day: number): IsoDate {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseIsoDate(date: IsoDate): { year: number; month: number; day: number } {
  const m = ISO_DATE_RE.exec(date);
  if (!m) throw new Error(`Некорректная дата: ${date}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function parseMonthKey(key: MonthKey): { year: number; month: number } {
  const m = MONTH_KEY_RE.exec(key);
  if (!m) throw new Error(`Некорректный месяц: ${key}`);
  return { year: Number(m[1]), month: Number(m[2]) };
}

/** Сегодняшняя дата в часовом поясе устройства. */
export function todayLocal(now: Date = new Date()): IsoDate {
  return toIsoDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}

function daysInMonthOf(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function daysInMonth(key: MonthKey): number {
  const { year, month } = parseMonthKey(key);
  return daysInMonthOf(year, month);
}

export function monthKeyOf(date: IsoDate): MonthKey {
  return date.slice(0, 7);
}

export function firstDayOfMonth(key: MonthKey): IsoDate {
  return `${key}-01`;
}

export function lastDayOfMonth(key: MonthKey): IsoDate {
  return `${key}-${pad2(daysInMonth(key))}`;
}

/** Дата в месяце с днём, урезанным до длины месяца (31-е в феврале → 28/29-е). */
export function clampedDayOfMonth(key: MonthKey, day: number): IsoDate {
  const { year, month } = parseMonthKey(key);
  return toIsoDate(year, month, Math.min(Math.max(1, day), daysInMonthOf(year, month)));
}

function toUtcMs(date: IsoDate): number {
  const { year, month, day } = parseIsoDate(date);
  return Date.UTC(year, month - 1, day);
}

function fromUtcMs(ms: number): IsoDate {
  const d = new Date(ms);
  return toIsoDate(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate());
}

const DAY_MS = 86_400_000;

export function addDays(date: IsoDate, days: number): IsoDate {
  return fromUtcMs(toUtcMs(date) + days * DAY_MS);
}

/** Сколько дней от a до b (b − a). */
export function diffDays(a: IsoDate, b: IsoDate): number {
  return Math.round((toUtcMs(b) - toUtcMs(a)) / DAY_MS);
}

export function addMonths(key: MonthKey, months: number): MonthKey {
  const { year, month } = parseMonthKey(key);
  const index = year * 12 + (month - 1) + months;
  return `${Math.floor(index / 12)}-${pad2((index % 12) + 1)}`;
}

/** Все месяцы от from до to включительно. */
export function monthRange(from: MonthKey, to: MonthKey): MonthKey[] {
  const result: MonthKey[] = [];
  for (let key = from; key <= to; key = addMonths(key, 1)) {
    result.push(key);
    if (result.length > 1200) break;
  }
  return result;
}

const MONTHS_NOMINATIVE = [
  "Январь", "Февраль", "Март", "Апрель", "Май", "Июнь",
  "Июль", "Август", "Сентябрь", "Октябрь", "Ноябрь", "Декабрь",
];
const MONTHS_GENITIVE = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const MONTHS_PREPOSITIONAL = [
  "январе", "феврале", "марте", "апреле", "мае", "июне",
  "июле", "августе", "сентябре", "октябре", "ноябре", "декабре",
];
const WEEKDAYS_SHORT = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];

export function formatMonth(key: MonthKey): string {
  const { year, month } = parseMonthKey(key);
  return `${MONTHS_NOMINATIVE[month - 1]} ${year}`;
}

/** «в сентябре» (год добавляется, если отличается от года reference). */
export function formatMonthIn(key: MonthKey, reference?: IsoDate): string {
  const { year, month } = parseMonthKey(key);
  const base = `в ${MONTHS_PREPOSITIONAL[month - 1]}`;
  return reference && parseIsoDate(reference).year !== year ? `${base} ${year}` : base;
}

/** «9 октября» (год добавляется, если отличается от года reference). */
export function formatDay(date: IsoDate, reference?: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  const base = `${day} ${MONTHS_GENITIVE[month - 1]}`;
  if (reference && parseIsoDate(reference).year !== year) return `${base} ${year}`;
  return base;
}

export function weekdayShort(date: IsoDate): string {
  return WEEKDAYS_SHORT[new Date(toUtcMs(date)).getUTCDay()];
}

/** Суббота или воскресенье. */
export function isWeekend(date: IsoDate): boolean {
  const day = new Date(toUtcMs(date)).getUTCDay();
  return day === 0 || day === 6;
}

/** «Сегодня», «Вчера», «Завтра» или «9 октября, чт». */
export function formatRelativeDay(date: IsoDate, today: IsoDate): string {
  const diff = diffDays(today, date);
  if (diff === 0) return "Сегодня";
  if (diff === -1) return "Вчера";
  if (diff === 1) return "Завтра";
  return `${formatDay(date, today)}, ${weekdayShort(date)}`;
}
