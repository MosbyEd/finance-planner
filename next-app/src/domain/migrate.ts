import { addMonths, firstDayOfMonth, isValidIsoDate, isValidMonthKey, monthKeyOf, type IsoDate } from "./dates";
import { OTHER_CATEGORY, defaultCategories, defaultProfile, defaultSettings, emptyState } from "./defaults";
import { MAX_KOPECKS, rublesToKopecks } from "./money";
import { isReservedKey } from "./records";
import {
  LIMITS,
  stateSchema,
  type Categories,
  type Goal,
  type Loan,
  type Profile,
  type State,
  type Template,
  type Transaction,
} from "./schema";

/**
 * Перенос данных из старых версий планировщика:
 *  - корневое приложение (localStorage financePlannerData_v1/v2, экспорт JSON с _exportMeta);
 *  - Next-прототип (то же плюс categoryLimits и userProfile);
 *  - текущий формат (schemaVersion: 3) — просто проверяется.
 * Суммы в старых версиях — рубли (float), здесь — копейки.
 */

export interface MigrationReport {
  source: "v3" | "legacy";
  transactions: number;
  templates: number;
  goals: number;
  loans: number;
  dropped: string[];
}

export class MigrationError extends Error {}

type Raw = Record<string, unknown>;

function isObject(value: unknown): value is Raw {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : "";
}

function money(value: unknown): number | null {
  const n = typeof value === "number" ? value : typeof value === "string" ? Number(value.replace(",", ".")) : NaN;
  if (!Number.isFinite(n)) return null;
  const k = rublesToKopecks(n);
  return Math.abs(k) <= MAX_KOPECKS ? k : null;
}

const ID_RE = /^[A-Za-z0-9_.-]{1,120}$/;

/** Годится ли значение как id (и как ключ записи: «__proto__», «constructor» и т. п. — нет). */
function isValidId(value: unknown): value is string {
  return typeof value === "string" && ID_RE.test(value) && !isReservedKey(value);
}

let fallbackCounter = 0;
function id(value: unknown, prefix: string): string {
  if (isValidId(value)) return value;
  fallbackCounter += 1;
  return `${prefix}-${Date.now().toString(36)}-${fallbackCounter}`;
}

/** Название категории из файла; служебные имена («constructor» и т. п.) не годятся — ключи записей. */
function categoryName(value: unknown): string {
  const name = str(value, LIMITS.category);
  return isReservedKey(name) ? "" : name;
}

/** Категория операции: служебное имя заменяется на «Другое» (операцию при этом не теряем). */
function txCategory(value: unknown): string {
  const name = str(value, LIMITS.category);
  return isReservedKey(name) ? OTHER_CATEGORY : name;
}

function categoryList(value: unknown, fallback: string[]): string[] {
  if (!Array.isArray(value)) return fallback;
  const seen = new Set<string>();
  const list: string[] = [];
  for (const item of value) {
    const name = categoryName(item);
    const k = name.toLocaleLowerCase("ru");
    if (!name || seen.has(k)) continue;
    seen.add(k);
    list.push(name);
  }
  return list.slice(0, LIMITS.categoriesPerGroup);
}

export function isCurrentFormat(raw: unknown): boolean {
  return isObject(raw) && raw.schemaVersion === 3;
}

/** Преобразует любые поддерживаемые данные в текущий формат. Бросает MigrationError, если формат не распознан. */
export function migrateState(raw: unknown, today: IsoDate): { state: State; report: MigrationReport } {
  if (isCurrentFormat(raw)) {
    const dropped: string[] = [];
    const deduped = dedupeCurrent(fixReservedNames(raw as Raw, dropped), dropped);
    const parsed = stateSchema.safeParse(deduped);
    if (!parsed.success) {
      throw new MigrationError(`Файл повреждён: ${parsed.error.issues[0]?.message ?? "неверный формат"}`);
    }
    const s = parsed.data;
    return {
      state: s,
      report: {
        source: "v3",
        transactions: s.transactions.length,
        templates: s.templates.length,
        goals: s.goals.length,
        loans: s.loans.length,
        dropped,
      },
    };
  }
  if (isObject(raw) && isObject(raw.months)) return migrateLegacy(raw, today);
  throw new MigrationError("Не удалось распознать формат данных.");
}

const LIST_LABELS = {
  transactions: "операции",
  templates: "регулярного платежа",
  goals: "цели",
  loans: "долга",
} as const;

/** Оставляет первый элемент с каждым id, остальные — в отчёт (id должны быть уникальны). */
function dedupeById<T>(list: T[], label: string, dropped: string[]): T[] {
  const seen = new Set<string>();
  return list.filter((item) => {
    const itemId = isObject(item) && typeof item.id === "string" ? item.id : null;
    if (itemId === null) return true; // некорректный элемент отклонит схема
    if (seen.has(itemId)) {
      dropped.push(`дубликат ${label} ${itemId}`);
      return false;
    }
    seen.add(itemId);
    return true;
  });
}

/** Файл текущего формата с повторяющимися id: дубликаты отбрасываются (с отчётом), а не ломают импорт. */
function dedupeCurrent(raw: Raw, dropped: string[]): Raw {
  const result: Raw = { ...raw };
  for (const [field, label] of Object.entries(LIST_LABELS)) {
    const list = raw[field];
    if (Array.isArray(list)) result[field] = dedupeById(list, label, dropped);
  }
  return result;
}

/** Не занятый id вида prefix-N: детерминированно, чтобы повторное исправление тех же данных дало те же id. */
function freshId(prefix: string, taken: Set<string>): string {
  let n = 1;
  while (taken.has(`${prefix}-${n}`)) n += 1;
  const fresh = `${prefix}-${n}`;
  taken.add(fresh);
  return fresh;
}

const isReservedName = (value: unknown): boolean => typeof value === "string" && isReservedKey(value.trim());

/** Список названий без служебных имён (та же ссылка, если менять нечего). */
function withoutReserved(list: unknown): unknown {
  return Array.isArray(list) && list.some(isReservedName) ? list.filter((v) => !isReservedName(v)) : list;
}

/** Запись без служебных ключей; ключи переименованных шаблонов — под новыми id. */
function recordWithoutReserved(record: unknown, renamed: Map<string, string> = new Map()): unknown {
  if (!isObject(record)) return record;
  const entries = Object.entries(record);
  if (!entries.some(([k]) => isReservedName(k))) return record;
  return Object.fromEntries(
    entries.flatMap(([k, v]): [string, unknown][] => {
      if (!isReservedName(k)) return [[k, v]];
      const to = renamed.get(k);
      return to ? [[to, v]] : [];
    }),
  );
}

/**
 * Данные текущего формата, сохранённые до запрета служебных имён (__proto__, constructor…) в id и категориях:
 * такие категории операций и шаблонов становятся «Другое», из справочников, лимитов и настроек они убираются,
 * записи со служебным id получают новый id (ссылки на него переносятся). Остальное отклонит схема.
 */
function fixReservedNames(raw: Raw, dropped: string[]): Raw {
  const result: Raw = { ...raw };
  const lists = ["transactions", "templates", "goals", "loans"] as const;
  const taken = new Set<string>();
  for (const field of lists) {
    const list = raw[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) if (isObject(item) && typeof item.id === "string") taken.add(item.id);
  }
  const renamed = { transactions: new Map<string, string>(), templates: new Map<string, string>(), goals: new Map<string, string>(), loans: new Map<string, string>() };
  const prefixes = { transactions: "tx", templates: "tpl", goals: "goal", loans: "loan" } as const;

  for (const field of lists) {
    const list = raw[field];
    if (!Array.isArray(list)) continue;
    result[field] = list.map((item: unknown) => {
      if (!isObject(item)) return item;
      let next = item;
      if (isReservedName(item.id)) {
        const to = renamed[field].get(item.id as string) ?? freshId(prefixes[field], taken);
        renamed[field].set(item.id as string, to);
        dropped.push(`служебный id ${LIST_LABELS[field]} ${String(item.id)} заменён на ${to}`);
        next = { ...next, id: to };
      }
      if ((field === "transactions" || field === "templates") && isReservedName(item.category)) {
        dropped.push(`служебная категория «${String(item.category).trim()}» заменена на «${OTHER_CATEGORY}»`);
        next = { ...next, category: OTHER_CATEGORY };
      }
      return next;
    });
  }

  // Ссылки операций на переименованные записи; ссылку на служебный id без такой записи убираем.
  if (Array.isArray(result.transactions)) {
    const refs = [
      ["templateId", renamed.templates],
      ["goalId", renamed.goals],
      ["loanId", renamed.loans],
      ["linkedTo", renamed.transactions],
    ] as const;
    result.transactions = result.transactions.map((item: unknown) => {
      if (!isObject(item) || !refs.some(([key]) => isReservedName(item[key]))) return item;
      const copy: Raw = { ...item };
      for (const [key, map] of refs) {
        if (!isReservedName(copy[key])) continue;
        const to = map.get(copy[key] as string);
        if (to) copy[key] = to;
        else {
          delete copy[key];
          if (key === "templateId") delete copy.occurrenceMonth;
          if (key === "loanId") delete copy.loanOpening;
        }
      }
      return copy;
    });
  }

  if (isObject(raw.categories)) {
    const cats = raw.categories;
    result.categories = { ...cats, income: withoutReserved(cats.income), mandatory: withoutReserved(cats.mandatory), flexible: withoutReserved(cats.flexible) };
  }
  result.categoryLimits = recordWithoutReserved(raw.categoryLimits);
  result.skipped = recordWithoutReserved(raw.skipped, renamed.templates);
  if (isObject(raw.settings)) {
    const settings = raw.settings;
    const salary = isObject(settings.salarySaving) ? settings.salarySaving : null;
    const purchase = isObject(settings.purchaseSaving) ? settings.purchaseSaving : null;
    result.settings = {
      ...settings,
      ...(salary ? { salarySaving: { ...salary, categories: withoutReserved(salary.categories) } } : {}),
      ...(purchase ? { purchaseSaving: { ...purchase, excludedCategories: withoutReserved(purchase.excludedCategories) } } : {}),
    };
  }
  return result;
}

function migrateLegacy(raw: Raw, today: IsoDate): { state: State; report: MigrationReport } {
  const dropped: string[] = [];
  const state = emptyState();

  // Категории
  const defaults = defaultCategories();
  const cats = isObject(raw.categories) ? raw.categories : {};
  const categories: Categories = {
    income: categoryList(cats.income, defaults.income),
    mandatory: categoryList(cats.fixedExpense ?? cats.mandatory, defaults.mandatory),
    flexible: categoryList(cats.flexibleExpense ?? cats.flexible, defaults.flexible),
  };
  state.categories = categories;

  // Операции
  const seenIds = new Set<string>();
  const months = raw.months as Raw;
  for (const [bucket, monthValue] of Object.entries(months)) {
    if (!isObject(monthValue) || !Array.isArray(monthValue.transactions)) continue;
    for (const item of monthValue.transactions) {
      if (!isObject(item)) continue;
      const tx = migrateTransaction(item, bucket, dropped);
      if (!tx) continue;
      if (seenIds.has(tx.id)) {
        dropped.push(`дубликат операции ${tx.id}`);
        continue;
      }
      seenIds.add(tx.id);
      state.transactions.push(tx);
    }
  }
  state.transactions.sort((a, b) => a.date.localeCompare(b.date));
  if (state.transactions.length > LIMITS.transactions) {
    dropped.push(`операций больше ${LIMITS.transactions}, самые старые не перенесены`);
    state.transactions = state.transactions.slice(-LIMITS.transactions);
  }

  // Шаблоны. Начинают действовать с текущего месяца: прошлые начисления уже есть в истории,
  // а месяцы, когда приложение не открывали, задним числом не заполняем.
  const currentMonthStart = firstDayOfMonth(monthKeyOf(today));
  const templateSources: [unknown, Template["kind"]][] = [
    [raw.incomePresets, "income"],
    [raw.fixedExpensePresets, "expense"],
  ];
  for (const [list, kind] of templateSources) {
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      if (!isObject(item)) continue;
      const amount = money(item.amount);
      const day = Math.trunc(Number(item.dayOfMonth));
      const title = str(item.title, LIMITS.title) || str(item.category, LIMITS.title);
      if (!amount || amount <= 0 || !title) {
        dropped.push(`регулярный платёж «${title || "без названия"}» без суммы`);
        continue;
      }
      const legacyStart =
        typeof item.startMonthKey === "string" && isValidMonthKey(item.startMonthKey)
          ? firstDayOfMonth(item.startMonthKey)
          : null;
      state.templates.push({
        id: id(item.id, "tpl"),
        kind,
        title,
        category: categoryName(item.category) || (kind === "income" ? "Доход" : "Обязательные"),
        amount,
        dayOfMonth: Number.isFinite(day) ? Math.min(31, Math.max(1, day)) : 1,
        active: item.active !== false,
        startDate: legacyStart && legacyStart > currentMonthStart ? legacyStart : currentMonthStart,
        note: "",
      });
    }
  }
  state.templates = dedupeById(state.templates, LIST_LABELS.templates, dropped).slice(0, LIMITS.templates);

  // Пропуски начислений: ui.skippedRecurring[month][presetId][date] = true.
  // Ключи — из файла, поэтому собираем в Map и превращаем в запись через Object.fromEntries.
  const ui = isObject(raw.ui) ? raw.ui : {};
  if (isObject(ui.skippedRecurring)) {
    const skipped = new Map<string, Set<string>>();
    for (const [month, perPreset] of Object.entries(ui.skippedRecurring)) {
      if (!isValidMonthKey(month) || !isObject(perPreset)) continue;
      for (const presetId of Object.keys(perPreset)) {
        if (!isValidId(presetId)) continue;
        const months = skipped.get(presetId) ?? new Set<string>();
        months.add(month);
        skipped.set(presetId, months);
      }
    }
    state.skipped = Object.fromEntries(
      [...skipped].map(([presetId, months]) => [presetId, [...months].sort().slice(-LIMITS.skippedMonths)]),
    );
  }
  // Старое приложение ставит флаг на ТЕКУЩИЙ месяц, когда решает судьбу остатка ПРОШЛОГО:
  // monthRolloverHandled["2026-10"] = true означает, что остаток сентября уже обработан.
  if (isObject(ui.monthRolloverHandled)) {
    const rollover: [string, "dismissed"][] = [];
    for (const [month, handled] of Object.entries(ui.monthRolloverHandled)) {
      if (handled && isValidMonthKey(month)) rollover.push([addMonths(month, -1), "dismissed"]);
    }
    state.rollover = Object.fromEntries(rollover.filter(([prev]) => isValidMonthKey(prev)));
  }

  // Цели: в старых версиях накопленная сумма хранилась в самой цели.
  if (Array.isArray(raw.goals)) {
    for (const item of raw.goals) {
      if (!isObject(item)) continue;
      const target = money(item.targetAmount);
      const name = str(item.name, LIMITS.title);
      if (!target || target <= 0 || !name) {
        dropped.push(`цель «${name || "без названия"}» без суммы`);
        continue;
      }
      const goalId = id(item.id, "goal");
      if (state.goals.some((g) => g.id === goalId)) {
        dropped.push(`дубликат цели «${name}» (${goalId})`);
        continue;
      }
      const linked = state.transactions
        .filter((t) => t.type === "saving" && t.goalId === goalId)
        .reduce((s, t) => s + t.amount, 0);
      const current = Math.max(0, money(item.currentAmount) ?? 0);
      const goal: Goal = {
        id: goalId,
        name,
        targetAmount: target,
        initialAmount: Math.max(0, current - linked),
        dueDate: isValidIsoDate(item.dueDate) ? item.dueDate : null,
        note: str(item.note, LIMITS.note),
        createdAt: legacyDate(item.createdAt) ?? today,
      };
      state.goals.push(goal);
    }
  }

  // Долги: в старых версиях остаток хранился в самом долге.
  if (Array.isArray(raw.loans)) {
    for (const item of raw.loans) {
      if (!isObject(item)) continue;
      const amount = money(item.amount);
      const name = str(item.name, LIMITS.title);
      const kind = item.kind === "lend" || item.kind === "credit" ? item.kind : "borrow";
      if (!amount || amount <= 0 || !name) {
        dropped.push(`долг «${name || "без названия"}» без суммы`);
        continue;
      }
      const loanId = id(item.id, "loan");
      if (state.loans.some((l) => l.id === loanId)) {
        dropped.push(`дубликат долга «${name}» (${loanId})`);
        continue;
      }
      const balance = money(item.balance);
      const loan: Loan = {
        id: loanId,
        kind,
        name,
        amount,
        initialPaid: balance === null ? 0 : Math.min(amount, Math.max(0, amount - balance)),
        dueDate: isValidIsoDate(item.dueDate) ? item.dueDate : null,
        note: str(item.note, LIMITS.note),
        createdAt: legacyDate(item.createdAt) ?? today,
      };
      state.loans.push(loan);
    }
  }
  // Ссылки операций на несуществующие цели и долги убираем.
  const goalIds = new Set(state.goals.map((g) => g.id));
  const loanIds = new Set(state.loans.map((l) => l.id));
  state.transactions = state.transactions.map((t) => {
    const copy = { ...t };
    if (copy.goalId && !goalIds.has(copy.goalId)) delete copy.goalId;
    if (copy.loanId && !loanIds.has(copy.loanId)) delete copy.loanId;
    return copy;
  });

  // Лимиты по категориям и профиль из Next-прототипа
  if (isObject(raw.categoryLimits)) {
    const limits = new Map<string, number>();
    for (const [name, value] of Object.entries(raw.categoryLimits)) {
      const k = money(value);
      const category = categoryName(name);
      if (category && k && k > 0) limits.set(category, k);
    }
    state.categoryLimits = Object.fromEntries(limits);
  }
  state.profile = migrateProfile(raw.userProfile);
  state.settings = defaultSettings();

  const parsed = stateSchema.safeParse(state);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new MigrationError(`Не удалось перенести данные: ${issue?.path.join(".")} — ${issue?.message}`);
  }
  return {
    state: parsed.data,
    report: {
      source: "legacy",
      transactions: parsed.data.transactions.length,
      templates: parsed.data.templates.length,
      goals: parsed.data.goals.length,
      loans: parsed.data.loans.length,
      dropped,
    },
  };
}

function legacyDate(value: unknown): IsoDate | null {
  if (typeof value !== "string") return null;
  const date = value.slice(0, 10);
  return isValidIsoDate(date) ? date : null;
}

function migrateTransaction(item: Raw, bucket: string, dropped: string[]): Transaction | null {
  const rawType = item.type;
  const date = typeof item.date === "string" ? item.date : "";
  const label = str(item.title, 40) || str(item.category, 40) || "без названия";
  if (!isValidIsoDate(date)) {
    dropped.push(`операция «${label}» с некорректной датой`);
    return null;
  }
  const amount = money(item.amount);
  if (amount === null || amount === 0) {
    if (rawType !== "balanceAdjustment") dropped.push(`операция «${label}» от ${date} без суммы`);
    return null;
  }
  const base = {
    id: id(item.id, "tx"),
    date,
    category: txCategory(item.category),
    title: str(item.title, LIMITS.title),
    note: str(item.note, LIMITS.note),
  };
  const presetId = isValidId(item.presetId) ? item.presetId : null;
  const legacyMonth = typeof item._monthKey === "string" && isValidMonthKey(item._monthKey) ? item._monthKey : null;
  const occurrenceMonth = legacyMonth ?? (isValidMonthKey(bucket) ? bucket : monthKeyOf(date));
  const templateLink = presetId ? { templateId: presetId, occurrenceMonth } : {};
  const goalLink = isValidId(item.goalId) ? { goalId: item.goalId } : {};

  switch (rawType) {
    case "income":
      if (amount < 0) break;
      return { ...base, type: "income", amount, autoSaving: false, ...templateLink };
    case "flexibleExpense":
      if (amount < 0) break;
      return { ...base, type: "expense", amount, mandatory: false, autoSaving: false };
    case "fixedExpense":
    case "recurringExpense":
      if (amount < 0) break;
      return { ...base, type: "expense", amount, mandatory: true, autoSaving: false, ...templateLink };
    case "savingTransfer":
      return { ...base, type: "saving", amount, category: base.category || "Сбережения", ...goalLink };
    case "balanceAdjustment":
      return { ...base, type: "adjustment", amount, category: base.category || "Корректировка" };
  }
  dropped.push(`операция «${label}» от ${date} неизвестного типа`);
  return null;
}

function migrateProfile(value: unknown): Profile {
  const profile = defaultProfile();
  if (!isObject(value)) return profile;
  profile.occupation = str(value.occupation, 100);
  profile.notes = str(value.notes, LIMITS.profileNotes);
  if (value.riskLevel === "low" || value.riskLevel === "medium" || value.riskLevel === "high") {
    profile.riskLevel = value.riskLevel;
  }
  if (value.savingsStyle === "aggressive" || value.savingsStyle === "balanced" || value.savingsStyle === "relaxed") {
    profile.savingsStyle = value.savingsStyle;
  }
  return profile;
}
