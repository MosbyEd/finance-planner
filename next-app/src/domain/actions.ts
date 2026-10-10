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
import {
  MAIN_ACCOUNT_ID,
  SAVINGS_ACCOUNT_ID,
  accountBalance,
  accountKeys,
  accountsOf,
  findAccount,
  sourceAccountId,
} from "./accounts";
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
  accountSchema,
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
  type Account,
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
  /** Добавлена автоматически — показать пользователю на проверку (см. Transaction.review). */
  review: z.boolean().optional(),
  /** Счёт: откуда списано или куда пришло. Нет — основной. */
  accountId: idSchema.optional(),
  /** Карта, которой платили (четыре цифры). */
  card: z.string().regex(/^\d{4}$/).optional(),
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
    accountId: idSchema,
    /** null — без карты. */
    card: z.string().regex(/^\d{4}$/).nullable(),
  })
  .partial()
  .strict();

const accountPatchSchema = accountSchema
  .omit({ id: true })
  .extend({
    // null — убрать лимит или срок (стал не кредиткой, данных больше нет).
    creditLimit: accountSchema.shape.creditLimit.unwrap().nullable(),
    graceDays: accountSchema.shape.graceDays.unwrap().nullable(),
    number: accountSchema.shape.number.unwrap().nullable(),
    archived: z.boolean(),
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
  z.object({
    type: z.literal("balance.set"),
    id: idSchema,
    date: isoDateSchema,
    actual: kopecksSchema,
    /** Какой счёт сверяем. Нет — основной. */
    accountId: idSchema.optional(),
  }),
  z.object({
    type: z.literal("savings.move"),
    id: idSchema,
    date: isoDateSchema,
    amount: kopecksSchema.refine((v) => v !== 0, "Сумма не может быть нулевой"),
    note: noteSchema,
    goalId: idSchema.optional(),
    review: z.boolean().optional(),
    /** Счёт, с которого откладываем (или на который снимаем). Нет — основной. */
    accountId: idSchema.optional(),
    /** Накопительный счёт. Нет — счёт цели или «Сбережения». */
    toAccountId: idSchema.optional(),
  }),
  /** Перевод между своими счетами: погашение кредитки, пополнение накопительного, снятие наличных. */
  z.object({
    type: z.literal("transfer.add"),
    id: idSchema,
    date: isoDateSchema,
    from: idSchema,
    to: idSchema,
    amount: positiveKopecksSchema,
    title: titleSchema.optional(),
    note: noteSchema,
    review: z.boolean().optional(),
  }),
  z.object({ type: z.literal("account.add"), account: accountSchema }),
  z.object({ type: z.literal("account.update"), id: idSchema, patch: accountPatchSchema }),
  z.object({ type: z.literal("account.delete"), id: idSchema }),
  /** Остаток в банке по СМС и расхождение с приложением; delta 0 — расхождение решено (поправили или оставили). */
  z.object({
    type: z.literal("account.bank"),
    accountId: idSchema,
    amount: kopecksSchema,
    delta: kopecksSchema,
    date: isoDateSchema,
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
  /**
   * Начисление регулярного платежа за месяц произошло на самом деле (например, пришла СМС банка):
   * фактические сумма и дата. Если операции за этот месяц ещё нет — создаётся, иначе исправляется.
   */
  z.object({
    type: z.literal("occurrence.confirm"),
    templateId: idSchema,
    month: monthKeySchema,
    amount: positiveKopecksSchema,
    date: isoDateSchema,
    note: noteSchema,
    review: z.boolean().optional(),
    /** Счёт из СМС (по цифрам карты). Нет — счёт шаблона. */
    accountId: idSchema.optional(),
  }),
  /**
   * Операция ошибочно засчитана как регулярный платёж (например, по СМС): сделать её обычной операцией
   * с id newId, а начисление шаблона вернуть в план (синхронизация создаст его заново, когда наступит срок).
   */
  z.object({ type: z.literal("occurrence.detach"), id: idSchema, newId: idSchema }),
  /** Пользователь проверил автоматически добавленные операции — снять отметку review. */
  z.object({ type: z.literal("tx.reviewed"), ids: z.array(idSchema).min(1).max(500) }),
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

/** Счёт для операции: должен существовать, а для новых записей — быть открытым. */
function assertAccount(state: State, id: string, forNew = true): Account {
  const account = findAccount(state, id);
  if (!account) throw new DomainError("Счёт не найден — возможно, его удалили.");
  if (forNew && account.archived) throw new DomainError(`Счёт «${account.name}» закрыт — выберите другой.`);
  return account;
}

function assertSavingsAccount(state: State, id: string): Account {
  const account = assertAccount(state, id, false);
  if (account.kind !== "savings") throw new DomainError("Деньги цели могут лежать только на накопительном счёте.");
  return account;
}

/** Счета по умолчанию нельзя удалить или закрыть: на них ссылаются все операции, записанные до появления счетов. */
function isBuiltinAccount(id: string): boolean {
  return id === MAIN_ACCOUNT_ID || id === SAVINGS_ACCOUNT_ID;
}

/** Одни и те же цифры карты у двух счетов — СМС не поймёт, куда записать. */
function assertUniqueSmsKeys(accounts: Account[]): void {
  const seen = new Map<string, string>();
  for (const account of accounts) {
    for (const key of new Set(accountKeys(account))) {
      const other = seen.get(key);
      if (other) throw new DomainError(`Цифры ${key} уже указаны у счёта «${other}».`);
      seen.set(key, account.name);
    }
  }
}

/** Откуда автоотчисление: со счёта операции, если это обычный счёт или наличные; иначе (кредитка) — с основного. */
function linkedSavingSource(state: State, tx: Transaction): string {
  const account = findAccount(state, sourceAccountId(tx));
  return account && (account.kind === "debit" || account.kind === "cash") ? account.id : MAIN_ACCOUNT_ID;
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
  return { ...state, transactions: [...others, buildLinkedSaving(source, desired, linkedSavingSource(state, source))] };
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
  const rebuilt = buildLinkedSaving(source, existing.amount, linkedSavingSource(state, source));
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
      ...(occ.accountId ? { accountId: occ.accountId } : {}),
      ...(occ.kind === "expense"
        ? { mandatory: true, autoSaving: false }
        : { autoSaving: salarySavingAmount(occ.amount, occ.category, state.settings) > 0 }),
    };
    created.push(tx);
    const saving = autoSavingAmount(tx, state.settings);
    const savingId = linkedSavingId(id);
    if (saving > 0 && !existing.has(savingId)) {
      existing.add(savingId);
      created.push(buildLinkedSaving(tx, saving, linkedSavingSource(state, tx)));
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
      if (input.accountId) assertAccount(state, input.accountId);
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
        ...(input.review ? { review: true as const } : {}),
        ...(input.accountId ? { accountId: input.accountId } : {}),
        ...(input.card ? { card: input.card } : {}),
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
          ...(input.accountId ? { accountId: input.accountId } : {}),
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
        throw new DomainError("Сбережения, переводы и корректировки нельзя редактировать — удалите и создайте заново.");
      }
      if (action.patch.accountId !== undefined && action.patch.accountId !== current.accountId) {
        assertAccount(state, action.patch.accountId);
      }
      const type = action.patch.type ?? current.type;
      const patch =
        action.patch.category === undefined
          ? action.patch
          : { ...action.patch, category: canonicalCategory(state, action.patch.category) };
      const { card, ...rest } = patch;
      const updated: Transaction = { ...current, ...rest, type };
      if (card !== undefined) {
        if (card === null) delete updated.card;
        else updated.card = card;
      }
      // Пользователь поправил операцию — значит, проверил её.
      delete updated.review;
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
        sourceAccountId(updated) !== sourceAccountId(current) ||
        Boolean(updated.autoSaving) !== Boolean(current.autoSaving);
      return savingInputsChanged ? syncLinkedSaving(next, updated) : moveLinkedSaving(next, updated);
    }

    case "occurrence.detach": {
      const tx = findTx(state, action.id);
      if (!tx.templateId || !tx.occurrenceMonth) throw new DomainError("Это не регулярный платёж.");
      assertNewId(state, action.newId);
      const savingId = linkedSavingId(tx.id);
      const plain: Transaction = { ...tx, id: action.newId };
      delete plain.templateId;
      delete plain.occurrenceMonth;
      // Пользователь сам разобрался с операцией — она проверена.
      delete plain.review;
      const rest = state.transactions.filter((t) => t.id !== tx.id && !(t.id === savingId && t.linkedTo === tx.id));
      return syncLinkedSaving({ ...state, transactions: [...rest, plain] }, plain);
    }

    case "tx.reviewed": {
      const ids = new Set(action.ids);
      if (!state.transactions.some((t) => t.review && ids.has(t.id))) return state;
      return {
        ...state,
        transactions: state.transactions.map((t) => {
          if (!t.review || !ids.has(t.id)) return t;
          const reviewed = { ...t };
          delete reviewed.review;
          return reviewed;
        }),
      };
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
      const accountId = action.accountId ?? MAIN_ACCOUNT_ID;
      const account = assertAccount(state, accountId, false);
      const delta = action.actual - accountBalance(state, accountId, action.date);
      if (delta === 0) return state;
      const multiple = accountsOf(state).length > 2 || accountId !== MAIN_ACCOUNT_ID;
      const tx: Transaction = {
        id: action.id,
        type: "adjustment",
        amount: delta,
        date: action.date,
        category: ADJUSTMENT_CATEGORY,
        title: clipTitle(multiple ? `Корректировка остатка: ${account.name}` : "Корректировка остатка"),
        note: "",
        ...(action.accountId ? { accountId: action.accountId } : {}),
      };
      return { ...state, transactions: [...state.transactions, tx] };
    }

    case "transfer.add": {
      assertNewId(state, action.id);
      assertTxCapacity(state, 1);
      if (action.from === action.to) throw new DomainError("Выберите два разных счёта.");
      const from = assertAccount(state, action.from);
      const to = assertAccount(state, action.to);
      if (from.kind === "savings") {
        const available = accountBalance(state, from.id);
        if (available < action.amount) {
          throw new DomainError(`На счёте «${from.name}» только ${formatMoney(Math.max(0, available))}.`);
        }
      }
      const title = action.title?.trim() || (to.kind === "credit" ? `Погашение: ${to.name}` : `Перевод: ${from.name} → ${to.name}`);
      const tx: Transaction = {
        id: action.id,
        type: "transfer",
        amount: action.amount,
        date: action.date,
        category: "",
        title: clipTitle(title),
        note: action.note,
        accountId: from.id,
        toAccountId: to.id,
        ...(action.review ? { review: true as const } : {}),
      };
      return { ...state, transactions: [...state.transactions, tx] };
    }

    case "account.add": {
      const accounts = accountsOf(state);
      if (accounts.some((a) => a.id === action.account.id)) throw new DomainError("Такой счёт уже есть.");
      if (accounts.length >= LIMITS.accounts) throw new DomainError("Слишком много счетов.");
      const account: Account = { ...action.account, spending: action.account.kind === "credit" ? false : action.account.spending };
      const next = [...accounts, account];
      assertUniqueSmsKeys(next);
      return { ...state, accounts: next };
    }

    case "account.update": {
      const accounts = accountsOf(state);
      const current = accounts.find((a) => a.id === action.id);
      if (!current) throw new DomainError("Счёт не найден.");
      const { creditLimit, graceDays, archived, number, ...rest } = action.patch;
      const updated: Account = { ...current, ...rest };
      if (number !== undefined) {
        if (number === null) delete updated.number;
        else updated.number = number;
      }
      if (updated.smsKeys && !updated.smsKeys.length) delete updated.smsKeys;
      if (creditLimit !== undefined) {
        if (creditLimit === null) delete updated.creditLimit;
        else updated.creditLimit = creditLimit;
      }
      if (graceDays !== undefined) {
        if (graceDays === null) delete updated.graceDays;
        else updated.graceDays = graceDays;
      }
      if (archived !== undefined) {
        if (archived && isBuiltinAccount(current.id)) throw new DomainError("Этот счёт нельзя закрыть — его можно переименовать.");
        if (archived) updated.archived = true;
        else delete updated.archived;
      }
      if (updated.kind === "credit") updated.spending = false;
      if (isBuiltinAccount(current.id) && updated.kind !== current.kind && (updated.kind === "credit") !== (current.kind === "credit")) {
        throw new DomainError("Основной счёт и «Сбережения» не могут стать кредитной картой.");
      }
      const next = accounts.map((a) => (a.id === current.id ? updated : a));
      assertUniqueSmsKeys(next);
      return { ...state, accounts: next };
    }

    case "account.bank": {
      const accounts = accountsOf(state);
      const current = accounts.find((a) => a.id === action.accountId);
      if (!current) throw new DomainError("Счёт не найден.");
      const updated: Account = { ...current, bank: { amount: action.amount, delta: action.delta, date: action.date } };
      return { ...state, accounts: accounts.map((a) => (a.id === current.id ? updated : a)) };
    }

    case "account.delete": {
      const accounts = accountsOf(state);
      const current = accounts.find((a) => a.id === action.id);
      if (!current) throw new DomainError("Счёт не найден.");
      if (isBuiltinAccount(current.id)) throw new DomainError("Этот счёт нельзя удалить — его можно переименовать.");
      const used =
        state.transactions.some((t) => t.accountId === current.id || t.toAccountId === current.id) ||
        state.templates.some((t) => t.accountId === current.id) ||
        state.goals.some((g) => g.accountId === current.id);
      if (used) throw new DomainError("По счёту есть операции — закройте его, тогда он останется в истории.");
      return { ...state, accounts: accounts.filter((a) => a.id !== current.id) };
    }

    case "savings.move": {
      assertNewId(state, action.id);
      assertTxCapacity(state, 1);
      const goal = action.goalId ? state.goals.find((g) => g.id === action.goalId) : undefined;
      if (action.goalId && !goal) throw new DomainError("Цель не найдена.");
      const fromId = action.accountId ?? MAIN_ACCOUNT_ID;
      const toId = action.toAccountId ?? goal?.accountId ?? SAVINGS_ACCOUNT_ID;
      assertAccount(state, fromId);
      const target = assertAccount(state, toId);
      if (target.kind !== "savings") throw new DomainError("Откладывать можно только на накопительный счёт.");
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
        // Сбережения разложены по счетам — снять можно только то, что лежит на выбранном.
        const onAccount = accountBalance(state, toId);
        if (onAccount + action.amount < 0) {
          throw new DomainError(`На счёте «${target.name}» только ${formatMoney(Math.max(0, onAccount))}.`);
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
        ...(action.review ? { review: true as const } : {}),
        ...(fromId !== MAIN_ACCOUNT_ID ? { accountId: fromId } : {}),
        ...(toId !== SAVINGS_ACCOUNT_ID ? { toAccountId: toId } : {}),
      };
      return { ...state, transactions: [...state.transactions, tx] };
    }

    case "template.add": {
      if (state.templates.some((t) => t.id === action.template.id)) {
        throw new DomainError("Шаблон с таким id уже существует.");
      }
      if (state.templates.length >= LIMITS.templates) throw new DomainError("Слишком много регулярных платежей.");
      if (action.template.accountId) assertAccount(state, action.template.accountId);
      const t = { ...action.template, category: canonicalCategory(state, action.template.category) };
      const next = ensureCategory(state, t.kind === "income" ? "income" : "mandatory", t.category);
      return { ...next, templates: [...next.templates, t] };
    }

    case "template.update": {
      const current = findTemplate(state, action.id);
      if (action.patch.accountId && action.patch.accountId !== current.accountId) assertAccount(state, action.patch.accountId);
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

    case "occurrence.confirm": {
      const template = findTemplate(state, action.templateId);
      if (action.accountId) assertAccount(state, action.accountId);
      const current = state.transactions.find((t) => t.templateId === template.id && t.occurrenceMonth === action.month);
      if (current) {
        const updated: Transaction = {
          ...current,
          amount: action.amount,
          date: action.date,
          note: action.note,
          ...(action.review ? { review: true as const } : {}),
          ...(action.accountId ? { accountId: action.accountId } : {}),
        };
        const next = { ...state, transactions: state.transactions.map((t) => (t.id === current.id ? updated : t)) };
        return updated.amount !== current.amount ? syncLinkedSaving(next, updated) : moveLinkedSaving(next, updated);
      }
      const id = occurrenceTxId(template.id, action.month);
      assertNewId(state, id);
      assertTxCapacity(state, 2);
      const tx: Transaction = {
        id,
        type: template.kind,
        amount: action.amount,
        date: action.date,
        category: template.category,
        title: template.title,
        note: action.note,
        templateId: template.id,
        occurrenceMonth: action.month,
        ...(action.review ? { review: true as const } : {}),
        ...(action.accountId || template.accountId ? { accountId: action.accountId ?? template.accountId } : {}),
        // Как у начислений из recurring.sync: расход по шаблону обязательный и без «копилки с покупок».
        ...(template.kind === "expense"
          ? { mandatory: true, autoSaving: false }
          : { autoSaving: salarySavingAmount(action.amount, template.category, state.settings) > 0 }),
      };
      // Платёж всё-таки был — месяц больше не считается пропущенным.
      const next = removeSkip({ ...state, transactions: [...state.transactions, tx] }, template.id, action.month);
      return syncLinkedSaving(next, tx);
    }

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
      if (action.goal.accountId) assertSavingsAccount(state, action.goal.accountId);
      return { ...state, goals: [...state.goals, action.goal] };
    }

    case "goal.update": {
      if (!state.goals.some((g) => g.id === action.id)) throw new DomainError("Цель не найдена.");
      if (action.patch.accountId) assertSavingsAccount(state, action.patch.accountId);
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
