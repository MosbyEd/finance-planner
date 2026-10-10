import { z } from "zod";
import { monthKeyOf, parseIsoDate, type IsoDate, type MonthKey } from "./dates";
import {
  ADJUSTMENT_CATEGORY,
  defaultProfile,
  defaultSettings,
  LOAN_PAYMENT_CATEGORY,
  LOAN_RETURN_CATEGORY,
  SAVINGS_CATEGORY,
} from "./defaults";
import { formatMoney } from "./money";
import {
  balanceAt,
  goalSaved,
  goalsReserved,
  loanOpening,
  loanOpeningSign,
  loanRemaining,
  monthMetrics,
  savingsTotal,
} from "./metrics";
import { getOwn, withKey, withoutKey } from "./records";
import { dueOccurrences, occurrenceTxId, skippedMonths } from "./recurring";
import { autoSavingAmount, buildLinkedSaving, linkedSavingId, salarySavingAmount } from "./savings";
import {
  LIMITS,
  categoryNameSchema,
  goalSchema,
  idSchema,
  isoDateSchema,
  kopecksSchema,
  loanSchema,
  monthKeySchema,
  noteSchema,
  positiveKopecksSchema,
  profileSchema,
  settingsSchema,
  stateSchema,
  templateSchema,
  titleSchema,
  transactionSchema,
  type CategoryGroup,
  type Settings,
  type State,
  type Template,
  type Transaction,
} from "./schema";

/** Ошибка, которую можно показать пользователю как есть. */
export class DomainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DomainError";
  }
}

const categoryGroupSchema = z.enum(["income", "mandatory", "flexible"]);

const txInputSchema = z.object({
  id: idSchema,
  type: z.enum(["income", "expense"]),
  amount: positiveKopecksSchema,
  date: isoDateSchema,
  category: categoryNameSchema,
  title: titleSchema,
  note: noteSchema,
  mandatory: z.boolean(),
  autoSaving: z.boolean(),
  /**
   * Повторять ежемесячно: создать регулярный платёж с этим id, а операцию считать его начислением за свой месяц.
   * startDate — с какой даты начислять следующие (обычно сегодня), чтобы не создать платежи задним числом.
   */
  repeat: z.object({ templateId: idSchema, startDate: isoDateSchema }).optional(),
});
export type TxInput = z.infer<typeof txInputSchema>;

const txPatchSchema = z
  .object({
    type: z.enum(["income", "expense"]),
    amount: positiveKopecksSchema,
    date: isoDateSchema,
    category: categoryNameSchema,
    title: titleSchema,
    note: noteSchema,
    mandatory: z.boolean(),
    autoSaving: z.boolean(),
  })
  .partial()
  .strict();

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tx.add"), tx: txInputSchema }),
  z.object({ type: z.literal("tx.update"), id: idSchema, patch: txPatchSchema }),
  z.object({ type: z.literal("tx.delete"), id: idSchema }),
  z.object({
    type: z.literal("tx.restore"),
    transactions: z.array(transactionSchema).min(1).max(10),
    unskip: z.object({ templateId: idSchema, month: monthKeySchema }).optional(),
  }),
  z.object({ type: z.literal("balance.set"), id: idSchema, date: isoDateSchema, actual: kopecksSchema }),
  z.object({
    type: z.literal("savings.move"),
    id: idSchema,
    date: isoDateSchema,
    amount: kopecksSchema.refine((v) => v !== 0, "Сумма не может быть нулевой"),
    note: noteSchema,
    goalId: idSchema.optional(),
  }),
  z.object({ type: z.literal("template.add"), template: templateSchema }),
  z.object({
    type: z.literal("template.update"),
    id: idSchema,
    patch: templateSchema.omit({ id: true, active: true }).partial().strict(),
  }),
  z.object({ type: z.literal("template.delete"), id: idSchema }),
  z.object({ type: z.literal("template.setActive"), id: idSchema, active: z.boolean(), today: isoDateSchema }),
  z.object({ type: z.literal("occurrence.skip"), templateId: idSchema, month: monthKeySchema }),
  z.object({ type: z.literal("occurrence.unskip"), templateId: idSchema, month: monthKeySchema }),
  z.object({ type: z.literal("recurring.sync"), today: isoDateSchema }),
  z.object({ type: z.literal("category.add"), group: categoryGroupSchema, name: categoryNameSchema }),
  z.object({ type: z.literal("category.remove"), group: categoryGroupSchema, name: categoryNameSchema }),
  z.object({ type: z.literal("category.setLimit"), name: categoryNameSchema, amount: positiveKopecksSchema.nullable() }),
  z.object({ type: z.literal("goal.add"), goal: goalSchema }),
  z.object({
    type: z.literal("goal.update"),
    id: idSchema,
    patch: goalSchema.omit({ id: true, createdAt: true }).partial().strict(),
  }),
  z.object({ type: z.literal("goal.delete"), id: idSchema }),
  z.object({
    type: z.literal("loan.add"),
    loan: loanSchema,
    /** Деньги прошли через счёт: создать корректировку остатка (не доход и не расход бюджета). */
    cashFlow: z.object({ id: idSchema, date: isoDateSchema }).optional(),
  }),
  z.object({
    type: z.literal("loan.update"),
    id: idSchema,
    patch: loanSchema.omit({ id: true, createdAt: true }).partial().strict(),
  }),
  z.object({ type: z.literal("loan.delete"), id: idSchema }),
  z.object({
    type: z.literal("loan.payment"),
    id: idSchema,
    loanId: idSchema,
    amount: positiveKopecksSchema,
    date: isoDateSchema,
    note: noteSchema,
  }),
  z.object({
    type: z.literal("settings.update"),
    settings: settingsSchema,
    /** С какого месяца действует новая норма сбережений (обычно текущий). */
    effectiveFrom: monthKeySchema.optional(),
  }),
  z.object({ type: z.literal("profile.update"), profile: profileSchema }),
  z.object({
    type: z.literal("rollover.resolve"),
    month: monthKeySchema,
    decision: z.enum(["saved", "dismissed"]),
    id: idSchema,
    date: isoDateSchema,
  }),
  z.object({
    type: z.literal("state.import"),
    state: stateSchema,
    /** Только в пустой аккаунт (перенос гостевых данных): если данные уже есть — ошибка, ничего не заменяется. */
    ifEmpty: z.boolean().optional(),
  }),
]);

export type Action = z.infer<typeof actionSchema>;
export type ActionType = Action["type"];

export const IMPORT_NOT_EMPTY_MESSAGE =
  "В аккаунте уже есть данные — перенос гостевых данных отменён, чтобы ничего не потерять.";

/** Есть ли в состоянии записи пользователя (операции, шаблоны, цели, долги). */
export function hasUserData(state: State): boolean {
  return state.transactions.length > 0 || state.templates.length > 0 || state.goals.length > 0 || state.loans.length > 0;
}

/** Действия, в которых клиент сообщает «сегодня»: сервер сверяет его со своими часами. */
export function actionToday(action: Action): IsoDate | null {
  if (action.type === "recurring.sync" || action.type === "template.setActive") return action.today;
  return null;
}

// ---------- helpers ----------

function findTx(state: State, id: string): Transaction {
  const tx = state.transactions.find((t) => t.id === id);
  if (!tx) throw new DomainError("Операция не найдена — возможно, она уже удалена.");
  return tx;
}

function findTemplate(state: State, id: string): Template {
  const template = state.templates.find((t) => t.id === id);
  if (!template) throw new DomainError("Шаблон не найден — возможно, он уже удалён.");
  return template;
}

function assertNewId(state: State, id: string): void {
  if (state.transactions.some((t) => t.id === id)) throw new DomainError("Операция с таким id уже существует.");
}

function assertTxCapacity(state: State, adding: number): void {
  if (state.transactions.length + adding > LIMITS.transactions) {
    throw new DomainError(`Слишком много операций (максимум ${LIMITS.transactions}). Удалите старые записи.`);
  }
}

function sameName(a: string, b: string): boolean {
  return a.trim().toLocaleLowerCase("ru") === b.trim().toLocaleLowerCase("ru");
}

/**
 * Существующее написание категории («кафе» → «Кафе»), чтобы операции, шаблоны и лимиты
 * с разным регистром не расползались по разным строкам аналитики.
 */
function canonicalCategory(state: State, name: string): string {
  const trimmed = name.trim();
  for (const list of [state.categories.income, state.categories.mandatory, state.categories.flexible]) {
    const found = list.find((c) => sameName(c, trimmed));
    if (found) return found;
  }
  return Object.keys(state.categoryLimits).find((c) => sameName(c, trimmed)) ?? trimmed;
}

/** Добавляет категорию в группу, если её там ещё нет (без ошибки при переполнении). */
function ensureCategory(state: State, group: CategoryGroup, name: string): State {
  const list = state.categories[group];
  if (!name || list.some((c) => sameName(c, name)) || list.length >= LIMITS.categoriesPerGroup) return state;
  return { ...state, categories: { ...state.categories, [group]: [...list, name.trim()] } };
}

/**
 * Название, собранное редьюсером: обрезано до лимита и без пробелов по краям — ровно в том виде,
 * в каком его пропускает схема (иначе клиент и сервер хранили бы разные строки).
 */
function clipTitle(text: string): string {
  return text.slice(0, LIMITS.title).trim();
}

function groupFor(type: "income" | "expense", mandatory: boolean): CategoryGroup {
  if (type === "income") return "income";
  return mandatory ? "mandatory" : "flexible";
}

// Записи skipped читаются и пишутся только через getOwn/withKey/withoutKey: ключи — id от пользователя.
function addSkip(state: State, templateId: string, month: MonthKey): State {
  const months = skippedMonths(state, templateId);
  if (months.includes(month)) return state;
  // Сверх лимита забываем самые старые пропуски: такие месяцы давно вне окна начислений,
  // а удаление операции не должно упираться в лимит.
  const next = [...months, month].sort().slice(-LIMITS.skippedMonths);
  return { ...state, skipped: withKey(state.skipped, templateId, next) };
}

function removeSkip(state: State, templateId: string, month: MonthKey): State {
  const months = skippedMonths(state, templateId);
  if (!months.includes(month)) return state;
  const rest = months.filter((m) => m !== month);
  const skipped = rest.length ? withKey(state.skipped, templateId, rest) : withoutKey(state.skipped, templateId);
  return { ...state, skipped };
}

/**
 * Автоотчисление операции. null — его id занят посторонней операцией: её не трогаем и не удаляем.
 */
function findLinkedSaving(state: State, source: Transaction): Transaction | undefined | null {
  const id = linkedSavingId(source.id);
  const found = state.transactions.find((t) => t.id === id);
  return found && found.linkedTo !== source.id ? null : found;
}

/** Приводит автоотчисление, привязанное к операции, в соответствие с ней (по текущим настройкам). */
function syncLinkedSaving(state: State, source: Transaction): State {
  const existing = findLinkedSaving(state, source);
  const desired = autoSavingAmount(source, state.settings);
  if (desired <= 0) {
    return existing ? { ...state, transactions: state.transactions.filter((t) => t !== existing) } : state;
  }
  if (existing === null) throw new DomainError("Не удалось создать автоотчисление: такой id уже занят.");
  const others = existing ? state.transactions.filter((t) => t !== existing) : state.transactions;
  return { ...state, transactions: [...others, buildLinkedSaving(source, desired)] };
}

/**
 * Правка операции, которая не меняет сумму отчисления (дата, название, заметка, «обязательный»):
 * отчисление сохраняет свою сумму, а дата и название следуют за исходной операцией.
 * Пересчёт по сегодняшним настройкам переписал бы историю (например, удалил бы старую копилку,
 * если процент с покупок с тех пор отключили).
 */
function moveLinkedSaving(state: State, source: Transaction): State {
  const existing = findLinkedSaving(state, source);
  if (!existing) return state;
  const rebuilt = buildLinkedSaving(source, existing.amount);
  if (existing.date === rebuilt.date && existing.title === rebuilt.title) return state;
  const moved: Transaction = { ...existing, date: rebuilt.date, title: rebuilt.title };
  return { ...state, transactions: state.transactions.map((t) => (t === existing ? moved : t)) };
}

function materialize(state: State, today: IsoDate): State {
  const due = dueOccurrences(state, today);
  if (!due.length) return state;
  const existing = new Set(state.transactions.map((t) => t.id));
  const notes = new Map<string, string>();
  for (const t of state.templates) if (!notes.has(t.id)) notes.set(t.id, t.note);
  const created: Transaction[] = [];
  for (const occ of due) {
    const id = occurrenceTxId(occ.templateId, occ.month);
    if (existing.has(id)) continue;
    existing.add(id);
    const tx: Transaction = {
      id,
      type: occ.kind,
      amount: occ.amount,
      date: occ.date,
      category: occ.category,
      title: occ.title,
      note: notes.get(occ.templateId) ?? "",
      templateId: occ.templateId,
      occurrenceMonth: occ.month,
      ...(occ.kind === "expense"
        ? { mandatory: true, autoSaving: false }
        : { autoSaving: salarySavingAmount(occ.amount, occ.category, state.settings) > 0 }),
    };
    created.push(tx);
    const saving = autoSavingAmount(tx, state.settings);
    const savingId = linkedSavingId(id);
    if (saving > 0 && !existing.has(savingId)) {
      existing.add(savingId);
      created.push(buildLinkedSaving(tx, saving));
    }
  }
  // Все начисления упёрлись в занятые id — состояние не меняется (повторная синхронизация — тот же объект).
  if (!created.length) return state;
  assertTxCapacity(state, created.length);
  return { ...state, transactions: [...state.transactions, ...created] };
}

/** Сравнение значений без учёта порядка ключей объектов. */
function sameValue(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => sameValue(x, b[i]));
  const ka = Object.keys(a);
  const kb = Object.keys(b);
  return (
    ka.length === kb.length &&
    ka.every((k) => Object.hasOwn(b, k) && sameValue((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
  );
}

// ---------- reducer ----------

/**
 * Применяет действие к состоянию и возвращает новое состояние (исходное не меняется).
 * Один и тот же код работает на клиенте (оптимистично) и на сервере (авторитетно),
 * поэтому всё, что зависит от случайности или текущего времени, приходит в самом действии.
 */
export function applyAction(state: State, action: Action): State {
  switch (action.type) {
    case "tx.add": {
      const input = { ...action.tx, category: canonicalCategory(state, action.tx.category) };
      assertNewId(state, input.id);
      assertTxCapacity(state, 2);
      const tx: Transaction = {
        id: input.id,
        type: input.type,
        amount: input.amount,
        date: input.date,
        category: input.category,
        title: input.title,
        note: input.note,
        autoSaving: input.autoSaving,
        ...(input.type === "expense" ? { mandatory: input.mandatory } : {}),
      };
      let next = ensureCategory(state, groupFor(input.type, input.mandatory), input.category);
      if (input.repeat) {
        if (state.templates.some((t) => t.id === input.repeat?.templateId)) {
          throw new DomainError("Шаблон с таким id уже существует.");
        }
        if (state.templates.length >= LIMITS.templates) throw new DomainError("Слишком много регулярных платежей.");
        const template: Template = {
          id: input.repeat.templateId,
          kind: input.type,
          title: input.title || input.category,
          category: input.category,
          amount: input.amount,
          dayOfMonth: parseIsoDate(input.date).day,
          active: true,
          startDate: input.repeat.startDate > input.date ? input.repeat.startDate : input.date,
          note: input.note,
        };
        tx.templateId = template.id;
        tx.occurrenceMonth = monthKeyOf(input.date);
        if (input.type === "expense" && !input.mandatory) {
          // Шаблонные расходы всегда обязательные — так они попадают в план месяца.
          tx.mandatory = true;
          next = ensureCategory(next, "mandatory", input.category);
        }
        next = { ...next, templates: [...next.templates, template] };
      }
      next = { ...next, transactions: [...next.transactions, tx] };
      return syncLinkedSaving(next, tx);
    }

    case "tx.update": {
      const current = findTx(state, action.id);
      if (current.type !== "income" && current.type !== "expense") {
        throw new DomainError("Сбережения и корректировки нельзя редактировать — удалите и создайте заново.");
      }
      const type = action.patch.type ?? current.type;
      const patch =
        action.patch.category === undefined
          ? action.patch
          : { ...action.patch, category: canonicalCategory(state, action.patch.category) };
      const updated: Transaction = { ...current, ...patch, type };
      if (type === "income") delete updated.mandatory;
      else updated.mandatory = action.patch.mandatory ?? current.mandatory ?? false;
      let next = ensureCategory(state, groupFor(type, Boolean(updated.mandatory)), updated.category);
      next = { ...next, transactions: next.transactions.map((t) => (t.id === current.id ? updated : t)) };
      // Сумма отчисления зависит только от типа, суммы, категории и флага: при других правках
      // (дата, название, заметка) уже сделанное отчисление не пересчитывается по сегодняшним настройкам.
      const savingInputsChanged =
        updated.type !== current.type ||
        updated.amount !== current.amount ||
        updated.category !== current.category ||
        Boolean(updated.autoSaving) !== Boolean(current.autoSaving);
      return savingInputsChanged ? syncLinkedSaving(next, updated) : moveLinkedSaving(next, updated);
    }

    case "tx.delete": {
      const tx = findTx(state, action.id);
      const savingId = linkedSavingId(tx.id);
      // Вместе с операцией удаляется только её собственное автоотчисление.
      const removed = (t: Transaction) => t.id === tx.id || (t.id === savingId && t.linkedTo === tx.id);
      let next: State = { ...state, transactions: state.transactions.filter((t) => !removed(t)) };
      if (tx.linkedTo) {
        // Удалили автоотчисление — больше не пересоздаём его при правке исходной операции.
        next = {
          ...next,
          transactions: next.transactions.map((t) => (t.id === tx.linkedTo ? { ...t, autoSaving: false } : t)),
        };
      }
      if (tx.templateId && tx.occurrenceMonth) next = addSkip(next, tx.templateId, tx.occurrenceMonth);
      return next;
    }

    case "tx.restore": {
      let next = state;
      const known = new Set(state.transactions.map((t) => t.id));
      let occupied: Set<string> | null = null;
      const toAdd: Transaction[] = [];
      for (const tx of action.transactions) {
        // Уже на месте (повторная отмена) или повтор внутри самого действия.
        if (known.has(tx.id)) continue;
        if (tx.templateId && tx.occurrenceMonth) {
          occupied ??= new Set(
            state.transactions.filter((t) => t.templateId && t.occurrenceMonth).map((t) => `${t.templateId}|${t.occurrenceMonth}`),
          );
          const pair = `${tx.templateId}|${tx.occurrenceMonth}`;
          if (occupied.has(pair)) {
            throw new DomainError("Операция по этому регулярному платежу за этот месяц уже есть — удалённую не восстановить.");
          }
          occupied.add(pair);
        }
        known.add(tx.id);
        toAdd.push(tx);
      }
      assertTxCapacity(state, toAdd.length);
      next = { ...next, transactions: [...next.transactions, ...toAdd] };
      for (const tx of toAdd) {
        if (tx.linkedTo) {
          next = {
            ...next,
            transactions: next.transactions.map((t) => (t.id === tx.linkedTo ? { ...t, autoSaving: true } : t)),
          };
        }
      }
      if (action.unskip) next = removeSkip(next, action.unskip.templateId, action.unskip.month);
      return next;
    }

    case "balance.set": {
      assertNewId(state, action.id);
      assertTxCapacity(state, 1);
      const delta = action.actual - balanceAt(state, action.date);
      if (delta === 0) return state;
      const tx: Transaction = {
        id: action.id,
        type: "adjustment",
        amount: delta,
        date: action.date,
        category: ADJUSTMENT_CATEGORY,
        title: "Корректировка остатка",
        note: "",
      };
      return { ...state, transactions: [...state.transactions, tx] };
    }

    case "savings.move": {
      assertNewId(state, action.id);
      assertTxCapacity(state, 1);
      const goal = action.goalId ? state.goals.find((g) => g.id === action.goalId) : undefined;
      if (action.goalId && !goal) throw new DomainError("Цель не найдена.");
      if (action.amount < 0) {
        const total = savingsTotal(state);
        if (goal) {
          // С цели можно снять только то, что откладывали в приложении (накопленное до него не на счёте),
          // и не больше, чем всего в сбережениях.
          const available = Math.min(goalSaved(state, goal) - goal.initialAmount, total);
          if (available + action.amount < 0) {
            throw new DomainError(`Нельзя снять больше, чем накоплено (${formatMoney(Math.max(0, available))}).`);
          }
        } else {
          // Деньги, отложенные на цели, из общих сбережений не снимаются: иначе их сняли бы второй раз с цели.
          const free = total - goalsReserved(state);
          if (free + action.amount < 0) {
            throw new DomainError(
              `Нельзя снять больше, чем свободно в сбережениях (${formatMoney(Math.max(0, free))}). Деньги на целях снимайте на вкладке «Цели».`,
            );
          }
        }
      }
      const title = goal
        ? `${action.amount > 0 ? "Пополнение" : "Снятие"}: цель «${goal.name}»`
        : action.amount > 0
          ? "Пополнение сбережений"
          : "Снятие из сбережений";
      const tx: Transaction = {
        id: action.id,
        type: "saving",
        amount: action.amount,
        date: action.date,
        category: SAVINGS_CATEGORY,
        title: clipTitle(title),
        note: action.note,
        ...(goal ? { goalId: goal.id } : {}),
      };
      return { ...state, transactions: [...state.transactions, tx] };
    }

    case "template.add": {
      if (state.templates.some((t) => t.id === action.template.id)) {
        throw new DomainError("Шаблон с таким id уже существует.");
      }
      if (state.templates.length >= LIMITS.templates) throw new DomainError("Слишком много регулярных платежей.");
      const t = { ...action.template, category: canonicalCategory(state, action.template.category) };
      const next = ensureCategory(state, t.kind === "income" ? "income" : "mandatory", t.category);
      return { ...next, templates: [...next.templates, t] };
    }

    case "template.update": {
      const current = findTemplate(state, action.id);
      const patch =
        action.patch.category === undefined
          ? action.patch
          : { ...action.patch, category: canonicalCategory(state, action.patch.category) };
      const updated: Template = { ...current, ...patch };
      const next = ensureCategory(state, updated.kind === "income" ? "income" : "mandatory", updated.category);
      return { ...next, templates: next.templates.map((t) => (t.id === current.id ? updated : t)) };
    }

    case "template.delete": {
      findTemplate(state, action.id);
      // Уже начисленные операции остаются в истории.
      return {
        ...state,
        templates: state.templates.filter((t) => t.id !== action.id),
        skipped: withoutKey(state.skipped, action.id),
      };
    }

    case "template.setActive": {
      const current = findTemplate(state, action.id);
      if (current.active === action.active) return state;
      // При возобновлении не начисляем пропущенные за время паузы месяцы.
      const startDate =
        action.active && current.startDate < action.today ? action.today : current.startDate;
      const updated: Template = { ...current, active: action.active, startDate };
      return { ...state, templates: state.templates.map((t) => (t.id === current.id ? updated : t)) };
    }

    case "occurrence.skip":
      findTemplate(state, action.templateId);
      return addSkip(state, action.templateId, action.month);

    case "occurrence.unskip":
      return removeSkip(state, action.templateId, action.month);

    case "recurring.sync":
      return materialize(state, action.today);

    case "category.add": {
      const list = state.categories[action.group];
      if (list.some((c) => sameName(c, action.name))) throw new DomainError("Такая категория уже есть.");
      if (list.length >= LIMITS.categoriesPerGroup) throw new DomainError("Слишком много категорий.");
      return ensureCategory(state, action.group, action.name);
    }

    case "category.remove": {
      const list = state.categories[action.group];
      const categories = { ...state.categories, [action.group]: list.filter((c) => !sameName(c, action.name)) };
      return { ...state, categories };
    }

    case "category.setLimit": {
      const existingKey = Object.keys(state.categoryLimits).find((k) => sameName(k, action.name));
      let categoryLimits = existingKey === undefined ? state.categoryLimits : withoutKey(state.categoryLimits, existingKey);
      if (action.amount !== null) {
        categoryLimits = withKey(categoryLimits, canonicalCategory(state, action.name), action.amount);
      }
      return { ...state, categoryLimits };
    }

    case "goal.add": {
      if (state.goals.some((g) => g.id === action.goal.id)) throw new DomainError("Цель уже существует.");
      if (state.goals.length >= LIMITS.goals) throw new DomainError("Слишком много целей.");
      return { ...state, goals: [...state.goals, action.goal] };
    }

    case "goal.update": {
      if (!state.goals.some((g) => g.id === action.id)) throw new DomainError("Цель не найдена.");
      return { ...state, goals: state.goals.map((g) => (g.id === action.id ? { ...g, ...action.patch } : g)) };
    }

    case "goal.delete": {
      if (!state.goals.some((g) => g.id === action.id)) throw new DomainError("Цель не найдена.");
      // Накопленные деньги остаются в общих сбережениях.
      return {
        ...state,
        goals: state.goals.filter((g) => g.id !== action.id),
        transactions: state.transactions.map((t) => {
          if (t.goalId !== action.id) return t;
          const rest = { ...t };
          delete rest.goalId;
          return rest;
        }),
      };
    }

    case "loan.add": {
      if (state.loans.some((l) => l.id === action.loan.id)) throw new DomainError("Долг уже существует.");
      if (state.loans.length >= LIMITS.loans) throw new DomainError("Слишком много долгов.");
      let transactions = state.transactions;
      if (action.cashFlow) {
        assertNewId(state, action.cashFlow.id);
        assertTxCapacity(state, 1);
        const incoming = action.loan.kind !== "lend";
        const tx: Transaction = {
          id: action.cashFlow.id,
          type: "adjustment",
          amount: loanOpeningSign(action.loan.kind) * action.loan.amount,
          date: action.cashFlow.date,
          category: ADJUSTMENT_CATEGORY,
          title: clipTitle(`${incoming ? "Получено в долг" : "Дал(а) в долг"}: ${action.loan.name}`),
          note: "",
          loanId: action.loan.id,
          loanOpening: true,
        };
        transactions = [...transactions, tx];
      }
      return { ...state, loans: [...state.loans, action.loan], transactions };
    }

    case "loan.update": {
      const current = state.loans.find((l) => l.id === action.id);
      if (!current) throw new DomainError("Долг не найден.");
      const updated = { ...current, ...action.patch };
      // Если при создании деньги прошли через счёт, корректировка открытия следует за суммой и направлением
      // долга. Остальные корректировки долга — платежи по нему, их не трогаем.
      const opening = loanOpening(state, current);
      const changed = updated.kind !== current.kind || updated.amount !== current.amount || updated.name !== current.name;
      const transactions =
        !opening || !changed
          ? state.transactions
          : state.transactions.map((t): Transaction => {
              if (t !== opening) return t;
              const incoming = updated.kind !== "lend";
              return {
                ...t,
                amount: loanOpeningSign(updated.kind) * updated.amount,
                title: clipTitle(`${incoming ? "Получено в долг" : "Дал(а) в долг"}: ${updated.name}`),
                loanOpening: true,
              };
            });
      return { ...state, loans: state.loans.map((l) => (l.id === action.id ? updated : l)), transactions };
    }

    case "loan.delete": {
      if (!state.loans.some((l) => l.id === action.id)) throw new DomainError("Долг не найден.");
      return {
        ...state,
        loans: state.loans.filter((l) => l.id !== action.id),
        transactions: state.transactions.map((t) => {
          if (t.loanId !== action.id) return t;
          const rest = { ...t };
          delete rest.loanId;
          delete rest.loanOpening;
          return rest;
        }),
      };
    }

    case "loan.payment": {
      assertNewId(state, action.id);
      assertTxCapacity(state, 1);
      const loan = state.loans.find((l) => l.id === action.loanId);
      if (!loan) throw new DomainError("Долг не найден.");
      const remaining = loanRemaining(state, loan);
      if (action.amount > remaining) {
        throw new DomainError(`Сумма больше остатка долга (${formatMoney(remaining)}).`);
      }
      const isReturn = loan.kind === "lend";
      const title = clipTitle(`${isReturn ? "Возврат" : "Погашение"}: ${loan.name}`);
      const opening = loanOpening(state, loan);
      if (opening) {
        // Деньги долга прошли через счёт (корректировкой, мимо бюджета) — и платёж идёт так же:
        // корректировка обратного знака. Иначе занять и вернуть было бы для бюджета расходом.
        const payment: Transaction = {
          id: action.id,
          type: "adjustment",
          amount: -loanOpeningSign(loan.kind) * action.amount,
          date: action.date,
          category: ADJUSTMENT_CATEGORY,
          title,
          note: action.note,
          loanId: loan.id,
        };
        // Корректировку старого долга (до отметки loanOpening) отмечаем: дальше её не спутать с платежом.
        const transactions = opening.loanOpening
          ? state.transactions
          : state.transactions.map((t): Transaction => (t === opening ? { ...t, loanOpening: true } : t));
        return { ...state, transactions: [...transactions, payment] };
      }
      const tx: Transaction = {
        id: action.id,
        type: isReturn ? "income" : "expense",
        amount: action.amount,
        date: action.date,
        category: isReturn ? LOAN_RETURN_CATEGORY : LOAN_PAYMENT_CATEGORY,
        title,
        note: action.note,
        loanId: loan.id,
        autoSaving: false,
        ...(isReturn ? {} : { mandatory: true }),
      };
      const next = ensureCategory(state, isReturn ? "income" : "mandatory", tx.category);
      return { ...next, transactions: [...next.transactions, tx] };
    }

    case "settings.update": {
      const previous = state.settings;
      const next: Settings = { ...action.settings };
      // Историю нормы ведёт только редьюсер — присланная клиентом игнорируется.
      delete next.savingsRateHistory;
      let history = previous.savingsRateHistory;
      if (next.savingsRatePercent !== previous.savingsRatePercent) {
        if (action.effectiveFrom) {
          const from = action.effectiveFrom;
          const known = history ?? [{ from: "1970-01", percent: previous.savingsRatePercent }];
          history = [...known.filter((h) => h.from < from), { from, percent: next.savingsRatePercent }].slice(-240);
        } else {
          history = undefined; // без даты новая норма действует для всех месяцев
        }
      }
      return { ...state, settings: history ? { ...next, savingsRateHistory: history } : next };
    }

    case "profile.update":
      return { ...state, profile: action.profile };

    case "rollover.resolve": {
      if (action.month >= monthKeyOf(action.date)) throw new DomainError("Месяц ещё не закончился.");
      if (getOwn(state.rollover, action.month)) return state;
      let next: State = { ...state, rollover: withKey(state.rollover, action.month, action.decision) };
      if (action.decision === "saved") {
        const left = monthMetrics(state, action.month, action.date).flexible.left;
        const amount = Math.min(left, balanceAt(state, action.date));
        if (amount > 0) {
          assertNewId(state, action.id);
          assertTxCapacity(state, 1);
          const tx: Transaction = {
            id: action.id,
            type: "saving",
            amount,
            date: action.date,
            category: SAVINGS_CATEGORY,
            title: "Остаток бюджета прошлого месяца",
            note: "",
            // Не сбережения текущего месяца: иначе перенос урезал бы его гибкий бюджет (см. monthMetrics).
            rolloverOf: action.month,
          };
          next = { ...next, transactions: [...next.transactions, tx] };
        }
      }
      return next;
    }

    case "state.import": {
      if (!action.ifEmpty) return action.state;
      if (hasUserData(state)) throw new DomainError(IMPORT_NOT_EMPTY_MESSAGE);
      // Перенос гостевых данных в пустой аккаунт: настроенное в аккаунте (норма, отчисления, профиль,
      // свои категории и лимиты) не затираем — переносятся операции, регулярные платежи, цели и долги.
      const imported = action.state;
      const mergeList = (own: string[], other: string[]) =>
        [...own, ...other.filter((c) => !own.some((o) => sameName(o, c)))].slice(0, LIMITS.categoriesPerGroup);
      const limits = new Map(Object.entries(imported.categoryLimits));
      for (const [name, value] of Object.entries(state.categoryLimits)) limits.set(name, value);
      return {
        ...imported,
        settings: sameValue(state.settings, defaultSettings()) ? imported.settings : state.settings,
        profile: sameValue(state.profile, defaultProfile()) ? imported.profile : state.profile,
        categoryLimits: Object.fromEntries(limits),
        categories: {
          income: mergeList(state.categories.income, imported.categories.income),
          mandatory: mergeList(state.categories.mandatory, imported.categories.mandatory),
          flexible: mergeList(state.categories.flexible, imported.categories.flexible),
        },
      };
    }
  }
}

export function applyActions(state: State, actions: readonly Action[]): State {
  return actions.reduce(applyAction, state);
}
