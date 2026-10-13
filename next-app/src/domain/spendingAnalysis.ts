import { z } from "zod";
import { addDays, addMonths, diffDays, firstDayOfMonth, formatDay, isValidIsoDate, isWeekend, lastDayOfMonth, monthKeyOf, weekdayShort, type IsoDate } from "./dates";
import { kopecksToRubles, type Kopecks } from "./money";
import { budgetPeriod, payEventName, payEvents, periodBudget, type PayEvent } from "./metrics";
import type { Profile, State, Transaction } from "./schema";
import { plural } from "./text";

/**
 * Анализ трат от AI. Всё, что можно посчитать, считает этот модуль (суммы по категориям и дням, мелкие траты,
 * магазины, будни против выходных, изменения к прошлому периоду, эффект шагов в рублях); модель только объясняет
 * и советует. В модель уходят агрегаты — без текстов СМС, заметок и остатков на счетах.
 */

// ---------- когда открывается ----------

/** Сколько полных периодов от зарплаты до зарплаты (или месяцев) нужно для разбора. */
export const ANALYSIS_MIN_PERIODS = 2;
/** В скольких разных днях должны быть записаны траты. */
export const ANALYSIS_MIN_DAYS = 20;
/**
 * Учёт начали в первые дни периода (завели приложение в день зарплаты, первые траты — назавтра) — период всё
 * равно считается полным.
 */
const START_GRACE_DAYS = 3;
/** Историю старше не разбираем: для двух последних периодов она не нужна. */
const HISTORY_DAYS = 400;
/**
 * Выплаты ближе друг к другу — одна граница: зарплата пришла СМС накануне, а регулярный платёж записал её
 * в свой день, — иначе получился бы «период» в один день.
 */
const MIN_PERIOD_DAYS = 5;

export interface SpendingPeriod {
  start: IsoDate;
  end: IsoDate;
  /** Выплата, с которой период начался (у календарного месяца — нет). */
  opening: PayEvent | null;
  /** Выплата, которой период закончился: следующий начинается с неё. */
  closing: PayEvent | null;
}

/** Расход, записанный человеком или из СМС, — не созданный регулярным платежом. */
function isRecordedExpense(tx: Transaction): boolean {
  return tx.type === "expense" && !tx.templateId;
}

/**
 * С какого дня ведётся учёт: первый записанный доход или расход либо выставленный остаток счёта. Операции
 * регулярных платежей не в счёт — их приложение создаёт и задним числом, от даты начала шаблона.
 */
export function trackingStart(state: State): IsoDate | null {
  let first: IsoDate | null = null;
  for (const tx of state.transactions) {
    const counts =
      ((tx.type === "income" || tx.type === "expense") && !tx.templateId) || (tx.type === "adjustment" && !tx.loanId);
    if (counts && (first === null || tx.date < first)) first = tx.date;
  }
  return first;
}

/** В скольких разных днях (по сегодня) записаны траты. */
export function spendingDays(state: State, today: IsoDate): number {
  const days = new Set<IsoDate>();
  for (const tx of state.transactions) if (isRecordedExpense(tx) && tx.date <= today) days.add(tx.date);
  return days.size;
}

/** Периоды бюджета подряд — от зарплаты до зарплаты (как на Главной) или календарные месяцы. */
export function spendingPeriods(state: State, today: IsoDate): { kind: "pay" | "month"; periods: SpendingPeriod[] } {
  const start = trackingStart(state) ?? today;
  const from = start < addDays(today, -HISTORY_DAYS) ? addDays(today, -HISTORY_DAYS) : start;
  if (budgetPeriod(state, today).kind === "pay") {
    const events: PayEvent[] = [];
    for (const e of payEvents(state, today, { from: addDays(from, -45), to: addDays(today, 100) })) {
      const prev = events.at(-1);
      if (!prev || diffDays(prev.date, e.date) >= MIN_PERIOD_DAYS) events.push(e);
    }
    const periods: SpendingPeriod[] = [];
    for (let i = 0; i + 1 < events.length; i++) {
      periods.push({ start: events[i].date, end: addDays(events[i + 1].date, -1), opening: events[i], closing: events[i + 1] });
    }
    if (periods.length) return { kind: "pay", periods };
  }
  const periods: SpendingPeriod[] = [];
  for (let month = monthKeyOf(from); month <= addMonths(monthKeyOf(today), 2); month = addMonths(month, 1)) {
    periods.push({ start: firstDayOfMonth(month), end: lastDayOfMonth(month), opening: null, closing: null });
  }
  return { kind: "month", periods };
}

export interface AnalysisAvailability {
  open: boolean;
  periodKind: "pay" | "month";
  /** Полные периоды, которые уже закончились (старые — первыми). */
  completed: SpendingPeriod[];
  spendingDays: number;
  /** Пока полных периодов меньше двух — тот, с концом которого их станет два. */
  unlockPeriod: SpendingPeriod | null;
}

/** Открыт ли анализ: два полных периода позади и траты записаны хотя бы в 20 разных днях. */
export function analysisAvailability(state: State, today: IsoDate): AnalysisAvailability {
  const start = trackingStart(state) ?? today;
  const { kind, periods } = spendingPeriods(state, today);
  const full = periods.filter((p) => p.start >= addDays(start, -START_GRACE_DAYS));
  const completed = full.filter((p) => p.end < today);
  const days = spendingDays(state, today);
  return {
    open: completed.length >= ANALYSIS_MIN_PERIODS && days >= ANALYSIS_MIN_DAYS,
    periodKind: kind,
    completed,
    spendingDays: days,
    unlockPeriod: completed.length >= ANALYSIS_MIN_PERIODS ? null : (full[ANALYSIS_MIN_PERIODS - 1] ?? null),
  };
}

/** «Откроется после зарплаты 10 ноября · записано 6 дней с тратами из 20». */
export function availabilityText(a: AnalysisAvailability, today: IsoDate): string {
  const n = a.spendingDays;
  const recorded = `${plural(n, ["записан", "записано", "записано"])} ${n} ${plural(n, ["день", "дня", "дней"])} с тратами из ${ANALYSIS_MIN_DAYS}`;
  if (a.completed.length < ANALYSIS_MIN_PERIODS) {
    const p = a.unlockPeriod;
    const when = p?.closing
      ? `Откроется после ${payEventName(p.closing)} ${formatDay(p.closing.date, today)}`
      : p
        ? `Откроется ${formatDay(addDays(p.end, 1), today)}`
        : "Откроется после двух полных периодов от зарплаты до зарплаты";
    return n >= ANALYSIS_MIN_DAYS ? `${when} · дней с тратами уже ${n}` : `${when} · ${recorded}`;
  }
  return `Откроется, когда траты будут записаны в ${ANALYSIS_MIN_DAYS} разных днях · сейчас ${recorded}`;
}

// ---------- что разбираем ----------

export type AnalysisKind = "analysis" | "period";

export interface AnalysisPlan {
  kind: AnalysisKind;
  previous: SpendingPeriod;
  last: SpendingPeriod;
  /** Что разбираем: у разбора — оба последних полных периода, у итогов — последний. */
  from: IsoDate;
  to: IsoDate;
}

export function analysisPlan(a: AnalysisAvailability, kind: AnalysisKind): AnalysisPlan | null {
  const last = a.completed.at(-1);
  const previous = a.completed.at(-2);
  if (!a.open || !last || !previous) return null;
  return { kind, previous, last, from: kind === "analysis" ? previous.start : last.start, to: last.end };
}

// ---------- агрегаты ----------

/** Мелкая трата — до 500 ₽. */
export const SMALL_PURCHASE: Kopecks = 50_000;
const TOP_CATEGORIES = 12;
const TOP_MERCHANTS = 10;
const TOP_CHANGES = 8;

export interface CategoryStat {
  name: string;
  amount: Kopecks;
  count: number;
  /** В среднем за день разбираемого отрезка. */
  perDay: Kopecks;
  /** Доля в повседневных (у обязательных — в обязательных) тратах. */
  share: number;
}

export interface MerchantStat {
  name: string;
  amount: Kopecks;
  count: number;
  category: string;
}

export interface SmallStat {
  category: string;
  amount: Kopecks;
  count: number;
}

export interface PeriodStat {
  start: IsoDate;
  end: IsoDate;
  days: number;
  /** Повседневные траты. */
  flexible: Kopecks;
  mandatory: Kopecks;
  /** Повседневные в среднем за день. */
  perDay: Kopecks;
  /** Гибкий бюджет периода и что от него осталось; null — бюджета не было (доход не записан). */
  budget: Kopecks | null;
  left: Kopecks | null;
}

export interface ChangeStat {
  category: string;
  /** В среднем за день в прошлом и в последнем периоде. */
  before: Kopecks;
  after: Kopecks;
}

export interface AnalysisData {
  version: 1;
  kind: AnalysisKind;
  periodKind: "pay" | "month";
  from: IsoDate;
  to: IsoDate;
  days: number;
  previous: PeriodStat;
  last: PeriodStat;
  /** Повседневные и обязательные траты за отрезок. */
  flexible: Kopecks;
  mandatory: Kopecks;
  perDay: Kopecks;
  categories: CategoryStat[];
  mandatoryCategories: CategoryStat[];
  small: { threshold: Kopecks; amount: Kopecks; count: number; categories: SmallStat[] };
  merchants: MerchantStat[];
  week: {
    weekdays: number;
    weekendDays: number;
    weekdayPerDay: Kopecks;
    weekendPerDay: Kopecks;
    /** Категории, где в выходные тратят больше всего (в среднем за выходной день). */
    weekendCategories: { category: string; perDay: Kopecks }[];
  };
  /** Повседневные траты по дням отрезка. */
  daily: { date: IsoDate; amount: Kopecks }[];
  /** Дней без повседневных трат. */
  quietDays: number;
  /** Повседневные по категориям: прошлый период против последнего, в среднем за день (периоды разной длины). */
  changes: ChangeStat[];
  /** Сколько можно тратить в день сейчас (по бюджету периода) и сколько в нём дней — для эффекта шагов. */
  limitPerDay: Kopecks;
  periodDays: number;
}

function key(name: string): string {
  return name.trim().toLocaleLowerCase("ru");
}

function perDay(amount: Kopecks, days: number): Kopecks {
  return days > 0 ? Math.round(amount / days) : 0;
}

function inRange(tx: Transaction, from: IsoDate, to: IsoDate): boolean {
  return tx.date >= from && tx.date <= to;
}

function categoryName(tx: Transaction): string {
  return tx.category || "Без категории";
}

function periodStat(state: State, p: SpendingPeriod, today: IsoDate): PeriodStat {
  const days = diffDays(p.start, p.end) + 1;
  let flexible = 0;
  let mandatory = 0;
  for (const tx of state.transactions) {
    if (tx.type !== "expense" || !inRange(tx, p.start, p.end)) continue;
    if (tx.mandatory) mandatory += tx.amount;
    else flexible += tx.amount;
  }
  // Выплаты, с которой начался период, в приложении нет — сколько было на период, неизвестно: бюджет не придумываем.
  const b = periodBudget(state, p.start, p.end, today);
  const budget = b.flexible.budget > 0 && !(p.opening && !p.opening.received) ? b.flexible.budget : null;
  return {
    start: p.start,
    end: p.end,
    days,
    flexible,
    mandatory,
    perDay: perDay(flexible, days),
    budget,
    left: budget === null ? null : b.flexible.left,
  };
}

function categoryStats(txs: Transaction[], days: number): CategoryStat[] {
  const sums = new Map<string, { name: string; amount: number; count: number }>();
  let total = 0;
  for (const tx of txs) {
    const name = categoryName(tx);
    const row = sums.get(key(name)) ?? { name, amount: 0, count: 0 };
    row.amount += tx.amount;
    row.count += 1;
    sums.set(key(name), row);
    total += tx.amount;
  }
  return [...sums.values()]
    .map((r) => ({ name: r.name, amount: r.amount, count: r.count, perDay: perDay(r.amount, days), share: total > 0 ? r.amount / total : 0 }))
    .sort((a, b) => b.amount - a.amount);
}

/** Переводы людям — не магазины, и имя человека модели не отдаём. */
const PERSON_TRANSFER = /^перевод/i;

function merchantStats(txs: Transaction[]): MerchantStat[] {
  const groups = new Map<string, { names: Map<string, number>; categories: Map<string, number>; amount: number; count: number }>();
  for (const tx of txs) {
    const title = tx.title.trim();
    if (!title || PERSON_TRANSFER.test(title)) continue;
    const g = groups.get(key(title)) ?? { names: new Map(), categories: new Map(), amount: 0, count: 0 };
    g.names.set(title, (g.names.get(title) ?? 0) + 1);
    g.categories.set(categoryName(tx), (g.categories.get(categoryName(tx)) ?? 0) + 1);
    g.amount += tx.amount;
    g.count += 1;
    groups.set(key(title), g);
  }
  const mostCommon = (counts: Map<string, number>) => [...counts.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const all = [...groups.values()].map((g) => ({
    name: mostCommon(g.names),
    amount: g.amount,
    count: g.count,
    category: mostCommon(g.categories),
  }));
  // Крупные по сумме и частые (кофейня по 200 ₽ двадцать раз — тоже «куда уходят деньги»).
  const byAmount = [...all].sort((a, b) => b.amount - a.amount).slice(0, TOP_MERCHANTS);
  const frequent = all.filter((m) => m.count >= 5 && !byAmount.includes(m)).sort((a, b) => b.count - a.count);
  return [...byAmount, ...frequent].slice(0, TOP_MERCHANTS + 3);
}

/** Агрегаты для разбора: считаются здесь, модель их только объясняет. */
export function analysisData(state: State, plan: AnalysisPlan, today: IsoDate): AnalysisData {
  const { from, to } = plan;
  const days = diffDays(from, to) + 1;
  const expenses = state.transactions.filter((tx) => tx.type === "expense" && inRange(tx, from, to));
  const flexibleTx = expenses.filter((tx) => !tx.mandatory);
  const mandatoryTx = expenses.filter((tx) => tx.mandatory);
  const flexible = flexibleTx.reduce((sum, tx) => sum + tx.amount, 0);
  const mandatory = mandatoryTx.reduce((sum, tx) => sum + tx.amount, 0);

  // По дням и будни против выходных.
  const byDay = new Map<IsoDate, Kopecks>();
  for (const tx of flexibleTx) byDay.set(tx.date, (byDay.get(tx.date) ?? 0) + tx.amount);
  const daily: AnalysisData["daily"] = [];
  let weekdays = 0;
  let weekendDays = 0;
  let weekdaySum = 0;
  let weekendSum = 0;
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const amount = byDay.get(date) ?? 0;
    daily.push({ date, amount });
    if (isWeekend(date)) {
      weekendDays += 1;
      weekendSum += amount;
    } else {
      weekdays += 1;
      weekdaySum += amount;
    }
  }
  const weekendCategories = categoryStats(
    flexibleTx.filter((tx) => isWeekend(tx.date)),
    weekendDays,
  )
    .slice(0, 3)
    .map((c) => ({ category: c.name, perDay: c.perDay }));

  // Мелкие траты — по категориям, частые сверху.
  const smallTx = flexibleTx.filter((tx) => tx.amount <= SMALL_PURCHASE);
  const small = categoryStats(smallTx, days)
    .sort((a, b) => b.count - a.count || b.amount - a.amount)
    .slice(0, 5)
    .map((c) => ({ category: c.name, amount: c.amount, count: c.count }));

  // Изменения: повседневные по категориям, прошлый период против последнего, в среднем за день.
  const previous = periodStat(state, plan.previous, today);
  const last = periodStat(state, plan.last, today);
  const before = categoryStats(
    state.transactions.filter((tx) => tx.type === "expense" && !tx.mandatory && inRange(tx, previous.start, previous.end)),
    previous.days,
  );
  const after = categoryStats(
    state.transactions.filter((tx) => tx.type === "expense" && !tx.mandatory && inRange(tx, last.start, last.end)),
    last.days,
  );
  const changes = new Map<string, ChangeStat>();
  for (const c of before) changes.set(key(c.name), { category: c.name, before: c.perDay, after: 0 });
  for (const c of after) {
    const row = changes.get(key(c.name)) ?? { category: c.name, before: 0, after: 0 };
    changes.set(key(c.name), { ...row, category: c.name, after: c.perDay });
  }

  const current = budgetPeriod(state, today).current;
  return {
    version: 1,
    kind: plan.kind,
    periodKind: plan.previous.opening ? "pay" : "month",
    from,
    to,
    days,
    previous,
    last,
    flexible,
    mandatory,
    perDay: perDay(flexible, days),
    categories: categoryStats(flexibleTx, days).slice(0, TOP_CATEGORIES),
    mandatoryCategories: categoryStats(mandatoryTx, days).slice(0, 6),
    small: {
      threshold: SMALL_PURCHASE,
      amount: smallTx.reduce((sum, tx) => sum + tx.amount, 0),
      count: smallTx.length,
      categories: small,
    },
    // Магазины — среди повседневных: погашение кредита или аренда — не «где тратите».
    merchants: merchantStats(flexibleTx.filter((tx) => !tx.templateId)),
    week: {
      weekdays,
      weekendDays,
      weekdayPerDay: perDay(weekdaySum, weekdays),
      weekendPerDay: perDay(weekendSum, weekendDays),
      weekendCategories,
    },
    daily,
    quietDays: daily.filter((d) => d.amount === 0).length,
    changes: [...changes.values()]
      .filter((c) => c.before !== c.after)
      .sort((a, b) => Math.abs(b.after - b.before) - Math.abs(a.after - a.before))
      .slice(0, TOP_CHANGES),
    limitPerDay: current.perDay,
    periodDays: current.days,
  };
}

// ---------- запрос к модели ----------

/** Вопрос для выбора модели (pickAiMode): разбор и совет — модель с рассуждением. */
export const ANALYSIS_QUESTION: Record<AnalysisKind, string> = {
  analysis: "Проанализируй мои траты: куда уходят деньги, чем последний период отличается от прошлого и как сэкономить",
  period: "Итоги периода: сравни траты с прошлым периодом и посоветуй",
};

const rub = (k: Kopecks) => Math.round(kopecksToRubles(k));

/** Агрегаты в рублях — то, что видит модель. Ничего, кроме этого, ей не отправляется. */
export function analysisPromptData(d: AnalysisData) {
  const period = (p: PeriodStat) => ({
    from: p.start,
    to: p.end,
    days: p.days,
    everyday: rub(p.flexible),
    everydayPerDay: rub(p.perDay),
    mandatory: rub(p.mandatory),
    ...(p.budget !== null && p.left !== null ? { everydayBudget: rub(p.budget), budgetLeft: rub(p.left) } : {}),
  });
  return {
    periodType: d.periodKind === "pay" ? "от зарплаты до зарплаты (или аванса)" : "календарный месяц",
    analyzed: { from: d.from, to: d.to, days: d.days, everyday: rub(d.flexible), everydayPerDay: rub(d.perDay), mandatory: rub(d.mandatory) },
    previousPeriod: period(d.previous),
    lastPeriod: period(d.last),
    everydayByCategory: d.categories.map((c) => ({ category: c.name, total: rub(c.amount), purchases: c.count, perDay: rub(c.perDay), sharePercent: Math.round(c.share * 100) })),
    mandatoryByCategory: d.mandatoryCategories.map((c) => ({ category: c.name, total: rub(c.amount) })),
    smallPurchases: {
      upTo: rub(d.small.threshold),
      total: rub(d.small.amount),
      count: d.small.count,
      byCategory: d.small.categories.map((c) => ({ category: c.category, count: c.count, total: rub(c.amount) })),
    },
    topMerchants: d.merchants.map((m) => ({ name: m.name.slice(0, 40), total: rub(m.amount), purchases: m.count, category: m.category })),
    weekdaysVsWeekends: {
      weekdayPerDay: rub(d.week.weekdayPerDay),
      weekendPerDay: rub(d.week.weekendPerDay),
      weekdays: d.week.weekdays,
      weekendDays: d.week.weekendDays,
      weekendTopCategories: d.week.weekendCategories.map((c) => ({ category: c.category, perWeekendDay: rub(c.perDay) })),
    },
    everydayByDay: d.daily.map((x) => ({ date: x.date, weekday: weekdayShort(x.date), total: rub(x.amount) })),
    daysWithoutEveryday: d.quietDays,
    changesPerDay: d.changes.map((c) => ({ category: c.category, previousPerDay: rub(c.before), lastPerDay: rub(c.after) })),
    dailyLimitNow: rub(d.limitPerDay),
  };
}

const COMMON_RULES = `Ты — внимательный финансовый аналитик в приложении личного бюджета «Бюджет». Суммы — в рублях.
Тебе дают агрегаты трат, которые посчитало приложение (JSON). Других данных нет: ни остатков на счетах, ни текстов СМС, ни отдельных покупок.
Правила:
- Цифры бери только из данных, не пересчитывай и не выдумывай. Не перечисляй всё подряд — выбирай главное.
- everyday — повседневные траты, ими человек управляет; mandatory — обязательные (аренда, кредиты, связь): упоминай, только если это важно.
- Периоды бывают разной длины — сравнивай в среднем за день (changesPerDay, everydayPerDay).
- Пиши по-русски, коротко и по делу, на «вы», без морали и без общих советов вроде «ведите бюджет».
- В шагах эффект в рублях не пиши — его посчитает приложение. target — точное название категории или магазина из данных.
- Шаги не должны пересекаться: не советуй одновременно категорию и магазин из неё — эффекты сложились бы дважды.
- Ответ — только JSON-объект, без markdown и пояснений вокруг.`;

const ANALYSIS_FORMAT = `Формат ответа:
{"summary": "2–3 предложения: главное о том, куда уходят деньги",
 "where": ["3–5 наблюдений: крупные категории, частые мелкие траты, магазины, будни против выходных"],
 "changes": ["2–4 главных изменения последнего периода к прошлому"],
 "steps": [{"title": "короткое действие, например «Такси — реже»", "target": "категория или магазин из данных", "cutPercent": 30, "why": "почему это реально — одно предложение"}]}
Шагов — от 3 до 5, cutPercent — целое от 5 до 100 (насколько сократить траты в target).`;

const PERIOD_FORMAT = `Это итоги только что закончившегося периода (lastPeriod) в сравнении с прошлым (previousPeriod).
Формат ответа:
{"summary": "2–3 коротких предложения: сколько ушло на повседневное и как это к бюджету периода, что выросло или снизилось. Первое предложение — до 120 символов: оно уйдёт в уведомление",
 "changes": ["1–3 главных изменения"],
 "steps": [{"title": "один шаг на следующий период", "target": "категория или магазин из данных", "cutPercent": 20, "why": "почему — одно предложение"}]}`;

/** Насколько смелые шаги — по «Как копить» из профиля (в настройках профиля это и написано). */
const PACE_RULES: Record<NonNullable<Profile["savingsStyle"]>, string> = {
  relaxed: "Человек копит спокойно: шаги мягкие, cutPercent 10–25, привычные траты совсем не отменяй.",
  balanced: "Человек копит сбалансированно: cutPercent 15–40, начинай с самых заметных необязательных трат.",
  aggressive: "Человек копит активно: шаги смелее, cutPercent 30–100 — где трату легко убрать, можно предложить отказаться от неё совсем.",
};

export function analysisMessages(d: AnalysisData, pace: Profile["savingsStyle"] = null): { role: "system" | "user"; content: string }[] {
  const rules = pace ? `${COMMON_RULES}\n- ${PACE_RULES[pace]}` : COMMON_RULES;
  return [
    { role: "system", content: `${rules}\n\n${d.kind === "analysis" ? ANALYSIS_FORMAT : PERIOD_FORMAT}` },
    { role: "user", content: `${ANALYSIS_QUESTION[d.kind]}.\nДанные:\n${JSON.stringify(analysisPromptData(d))}` },
  ];
}

// ---------- ответ модели ----------

export interface AnalysisStep {
  title: string;
  /** Категория или магазин, к которому относится шаг (как в данных); null — общий совет. */
  target: string | null;
  cutPercent: number | null;
  why: string;
  /** На сколько больше можно тратить в день (на столько же меньше уйдёт в target) — посчитано приложением. */
  effectPerDay: Kopecks | null;
  /** То же за период бюджета. */
  effectPerPeriod: Kopecks | null;
}

export interface AnalysisReport {
  kind: AnalysisKind;
  from: IsoDate;
  to: IsoDate;
  createdAt: number;
  model: string;
  /** Отвечала модель с рассуждением. */
  thinking?: boolean;
  summary: string;
  where: string[];
  changes: string[];
  steps: AnalysisStep[];
  /** Агрегаты, которые видела модель: окно разбора показывает их, а не пересчитанные заново. */
  data: AnalysisData;
}

/** Числа модель пишет с обычными пробелами — «3 560 ₽» рвалось бы на строки: внутри чисел и перед «₽» — неразрывные. */
export function tidyText(value: string): string {
  return value
    .replace(/(\d)[ \u202f](?=\d{3}(?!\d))/g, "$1\u00a0")
    .replace(/(\d)[ \u202f](?=[₽%])/g, "$1\u00a0");
}

const text = (max: number) => z.preprocess((v) => (typeof v === "string" ? tidyText(v.trim()).slice(0, max) : ""), z.string());
const list = (max: number, items: number) =>
  z.preprocess((v) => (Array.isArray(v) ? v : typeof v === "string" ? [v] : []), z.array(text(max))).transform((xs) => xs.filter(Boolean).slice(0, items));

const rawStepSchema = z.object({
  title: text(120),
  target: z.preprocess((v) => (typeof v === "string" && v.trim() ? v.trim().slice(0, 80) : null), z.string().nullable()),
  cutPercent: z.preprocess((v) => {
    const n = typeof v === "string" ? Number.parseFloat(v) : v;
    return typeof n === "number" && Number.isFinite(n) ? Math.round(Math.min(100, Math.max(5, n))) : null;
  }, z.number().nullable()),
  why: text(300),
});

const rawReplySchema = z.object({
  summary: text(700),
  where: list(300, 6),
  changes: list(300, 5),
  steps: z.preprocess((v) => (Array.isArray(v) ? v : []), z.array(z.unknown())),
});

/** JSON-объект из ответа: модель иногда оборачивает его в ```json … ``` или пишет текст вокруг. */
function extractObject(reply: string): unknown {
  const start = reply.indexOf("{");
  const end = reply.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(reply.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** Округление эффекта: от 100 ₽ — до десятков рублей, меньше — до рубля. */
function roundEffect(kopecks: Kopecks): Kopecks {
  const step = kopecks >= 10_000 ? 1_000 : 100;
  return Math.round(kopecks / step) * step;
}

/** Эффект шага: сократить траты в target на cutPercent — столько в день останется на остальное. */
export function stepEffect(d: AnalysisData, target: string | null, cutPercent: number | null): { perDay: Kopecks; perPeriod: Kopecks } | null {
  if (!target || !cutPercent) return null;
  const k = key(target);
  const found =
    d.categories.find((c) => key(c.name) === k) ??
    d.mandatoryCategories.find((c) => key(c.name) === k) ??
    d.merchants.find((m) => key(m.name) === k);
  if (!found || d.days <= 0) return null;
  const perDay = roundEffect((found.amount / d.days) * (cutPercent / 100));
  if (perDay <= 0) return null;
  return { perDay, perPeriod: perDay * Math.max(1, d.periodDays) };
}

/** Разбор ответа модели; эффект шагов считается здесь. Не JSON — весь текст становится кратким итогом. */
export function parseAnalysisReply(
  reply: string,
  d: AnalysisData,
  meta: { model: string; createdAt: number; thinking?: boolean },
): AnalysisReport {
  const parsed = rawReplySchema.safeParse(extractObject(reply));
  const base = { kind: d.kind, from: d.from, to: d.to, createdAt: meta.createdAt, model: meta.model, thinking: meta.thinking, data: d };
  if (!parsed.success || !parsed.data.summary) {
    const plain = tidyText(reply.replace(/```(?:json)?/g, "").trim()).slice(0, 1500);
    return { ...base, summary: plain || "AI не прислал разбор.", where: [], changes: [], steps: [] };
  }
  const steps: AnalysisStep[] = [];
  for (const item of parsed.data.steps) {
    const step = rawStepSchema.safeParse(item);
    if (!step.success || !step.data.title) continue;
    const effect = stepEffect(d, step.data.target, step.data.cutPercent);
    steps.push({ ...step.data, effectPerDay: effect?.perDay ?? null, effectPerPeriod: effect?.perPeriod ?? null });
  }
  return {
    ...base,
    summary: parsed.data.summary,
    where: d.kind === "analysis" ? parsed.data.where : [],
    changes: parsed.data.changes,
    steps: steps.slice(0, d.kind === "analysis" ? 5 : 2),
  };
}

/** Первое предложение итога — текст уведомления. */
export function reportHeadline(report: Pick<AnalysisReport, "summary">): string {
  const first = report.summary.match(/^.+?[.!?](?=\s|$)/)?.[0] ?? report.summary;
  return first.length > 180 ? `${first.slice(0, 177).trimEnd()}…` : first;
}

// ---------- хранение и проверка ----------

const isoDate = z.string().refine(isValidIsoDate);

/**
 * Разбор, пришедший с сервера (или из ответа фонового запроса). Агрегаты проверяем по форме верхнего уровня:
 * их посчитал сервер, а версия защищает от разборов старого формата.
 */
export const analysisReportSchema = z.object({
  kind: z.enum(["analysis", "period"]),
  from: isoDate,
  to: isoDate,
  createdAt: z.number(),
  model: z.string(),
  thinking: z.boolean().optional(),
  summary: z.string(),
  where: z.array(z.string()),
  changes: z.array(z.string()),
  steps: z.array(
    z.object({
      title: z.string(),
      target: z.string().nullable(),
      cutPercent: z.number().nullable(),
      why: z.string(),
      effectPerDay: z.number().nullable(),
      effectPerPeriod: z.number().nullable(),
    }),
  ),
  data: z.looseObject({
    version: z.literal(1),
    from: isoDate,
    to: isoDate,
    days: z.number(),
    previous: z.looseObject({ start: isoDate, end: isoDate }),
    last: z.looseObject({ start: isoDate, end: isoDate }),
    categories: z.array(z.looseObject({ name: z.string(), amount: z.number() })),
    merchants: z.array(z.looseObject({ name: z.string(), amount: z.number() })),
    daily: z.array(z.looseObject({ date: isoDate, amount: z.number() })),
  }) as unknown as z.ZodType<AnalysisData>,
}) satisfies z.ZodType<AnalysisReport>;

/** Итоги этого периода уже есть — второй раз не спрашиваем. */
export function periodSummaryDue(a: AnalysisAvailability, reports: readonly Pick<AnalysisReport, "kind" | "from">[]): AnalysisPlan | null {
  const plan = analysisPlan(a, "period");
  if (!plan) return null;
  return reports.some((r) => r.kind === "period" && r.from === plan.from) ? null : plan;
}
