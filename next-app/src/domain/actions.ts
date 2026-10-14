import { z } from "zod";
import { monthKeyOf, parseIsoDate, type IsoDate, type MonthKey } from "./dates";
import {
  ADJUSTMENT_CATEGORY,
  defaultProfile,
  defaultSettings,
  LOAN_PAYMENT_CATEGORY,
  LOAN_RETURN_CATEGORY,
  OTHER_CATEGORY,
  SAVINGS_CATEGORY,
} from "./defaults";
import {
  MAIN_ACCOUNT_ID,
  SAVINGS_ACCOUNT_ID,
  accountBalance,
  accountKeys,
  accountsOf,
  bankDelta,
  bankSnapshotOlder,
  savingsTarget,
  findAccount,
  sourceAccountId,
  targetAccountId,
} from "./accounts";
import { banksOf, senderKey, withSavedBanks } from "./banks";
import { formatMoney, type Kopecks } from "./money";
import {
  balanceAt,
  dedicatedGoalAccount,
  goalAvailable,
  goalsReservedOn,
  loanOpening,
  loanOpeningSign,
  loanRemaining,
  monthMetrics,
} from "./metrics";
import { getOwn, withKey, withoutKey } from "./records";
import { dueOccurrences, occurrenceTxId, skippedMonths, type Occurrence } from "./recurring";
import { autoSavingAmount, buildLinkedSaving, linkedSavingId, salarySavingAmount, savingThreshold } from "./savings";
import {
  LIMITS,
  accountSchema,
  bankSchema,
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
  type Bank,
  type CategoryGroup,
  type Loan,
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
    terms: accountSchema.shape.terms.unwrap().nullable(),
    number: accountSchema.shape.number.unwrap().nullable(),
    archived: z.boolean(),
    // null — счёт без банка.
    bankId: idSchema.nullable(),
  })
  .partial()
  .strict();

/** Счета банка: перечисленные — в этом банке, остальные его счета — без банка. */
const bankAccountIdsSchema = z.array(idSchema).max(LIMITS.accounts);

export const actionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tx.add"), tx: txInputSchema }),
  z.object({ type: z.literal("tx.update"), id: idSchema, patch: txPatchSchema }),
  z.object({ type: z.literal("tx.delete"), id: idSchema }),
  /**
   * Зачисление — свои деньги, а не доход (own: true): доход становится корректировкой остатка — деньги на счёте
   * остаются, в доходы и бюджет месяца не входят. own: false — обратно в доход с категорией category.
   */
  z.object({ type: z.literal("tx.ownMoney"), id: idSchema, own: z.boolean(), category: categoryNameSchema.optional() }),
  /**
   * Операция — движение между своими счетами (исправление операции из СМС или правка перевода): на её место
   * с тем же id — перевод, пополнение или снятие сбережений, как в окне перевода.
   */
  z.object({
    type: z.literal("tx.move"),
    id: idSchema,
    date: isoDateSchema,
    from: idSchema,
    to: idSchema,
    amount: positiveKopecksSchema,
    title: titleSchema.optional(),
    note: noteSchema.optional(),
  }),
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
  /** Банк: название, отправители СМС и (если переданы) его счета. */
  z.object({ type: z.literal("bank.add"), bank: bankSchema, accountIds: bankAccountIdsSchema.optional() }),
  z.object({
    type: z.literal("bank.update"),
    id: idSchema,
    patch: bankSchema.omit({ id: true }).partial().strict(),
    accountIds: bankAccountIdsSchema.optional(),
  }),
  /** Удалить банк: его счета остаются, но уже без банка. */
  z.object({ type: z.literal("bank.delete"), id: idSchema }),
  /**
   * Остаток в банке по СМС и расхождение с приложением; delta 0 — расхождение решено (оставили). Остаток из более
   * ранней СМС (её обработали позже) свежий не заменяет.
   */
  z.object({
    type: z.literal("account.bank"),
    accountId: idSchema,
    amount: kopecksSchema,
    delta: kopecksSchema,
    date: isoDateSchema,
    time: z.string().regex(/^\d{2}:\d{2}$/).optional(),
  }),
  /**
   * «Поправить» расхождение с банком: корректировка на разницу, посчитанную при применении (по тем операциям,
   * что есть в этот момент), — на сервере и на телефоне одна и та же. Расхождение уже решено — ничего не делает.
   */
  z.object({ type: z.literal("account.bankFix"), id: idSchema, accountId: idSchema }),
  z.object({ type: z.literal("template.add"), template: templateSchema }),
  z.object({
    type: z.literal("template.update"),
    id: idSchema,
    // null — убрать счёт, свой счёт назначения, кредит или цель (платёж стал обычным), срок; untilDone: false — без условия.
    patch: templateSchema
      .omit({ id: true, active: true })
      .extend({
        accountId: idSchema.nullable(),
        toAccountId: idSchema.nullable(),
        loanId: idSchema.nullable(),
        goalId: idSchema.nullable(),
        endDate: isoDateSchema.nullable(),
        untilDone: z.boolean(),
      })
      .partial()
      .strict(),
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
    // accountId: null — открепить счёт.
    patch: goalSchema.omit({ id: true, createdAt: true }).extend({ accountId: idSchema.nullable() }).partial().strict(),
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
    patch: loanSchema
      .omit({ id: true, createdAt: true })
      .extend({
        // null — убрать условия, долю наличных или дату.
        terms: loanSchema.shape.terms.unwrap().nullable(),
        cashAmount: loanSchema.shape.cashAmount.unwrap().nullable(),
        takenAt: loanSchema.shape.takenAt.unwrap().nullable(),
      })
      .partial()
      .strict(),
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

/**
 * Операцию можно править в окне операции: доход, расход, перевод или сбережения — кроме служебных
 * (автоотчисление с покупки, перенос остатка месяца, движения по долгу, корректировки).
 */
export function isEditableTransaction(tx: Transaction): boolean {
  if (tx.linkedTo || tx.rolloverOf || tx.loanId || tx.loanOpening) return false;
  return tx.type === "income" || tx.type === "expense" || tx.type === "transfer" || tx.type === "saving";
}

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

/** Корректировка остатка счёта на amount; без accountId — основной счёт. */
function balanceAdjustment(
  state: State,
  account: Account,
  t: { id: string; amount: Kopecks; date: IsoDate; accountId?: string },
): Transaction {
  const multiple = accountsOf(state).length > 2 || account.id !== MAIN_ACCOUNT_ID;
  return {
    id: t.id,
    type: "adjustment",
    amount: t.amount,
    date: t.date,
    category: ADJUSTMENT_CATEGORY,
    title: clipTitle(multiple ? `Корректировка остатка: ${account.name}` : "Корректировка остатка"),
    note: "",
    ...(t.accountId ? { accountId: t.accountId } : {}),
  };
}

/**
 * Счета регулярного платежа: откуда (любой открытый счёт) и куда — свой счёт (не тот же) или кредит из «Долгов»
 * (мой долг: заём или кредит). Куда — только у платежа, не у дохода. current — прежняя версия: уже выбранный
 * и с тех пор закрытый счёт не мешает сохранить другие правки.
 */
function assertTemplateTargets(state: State, t: Template, current?: Template): void {
  if (t.accountId && t.accountId !== current?.accountId) assertAccount(state, t.accountId);
  if ([t.toAccountId, t.loanId, t.goalId].filter(Boolean).length > 1) throw new DomainError("Выберите что-то одно: счёт, кредит или цель.");
  if ((t.toAccountId || t.loanId || t.goalId) && t.kind !== "expense") {
    throw new DomainError("Счёт, кредит или цель выбирают только у платежа.");
  }
  if (t.goalId && !state.goals.some((g) => g.id === t.goalId)) throw new DomainError("Цель не найдена.");
  if (t.untilDone && !t.loanId && !t.goalId) throw new DomainError("«Пока не закрыт» — только у платежа по долгу или в цель.");
  if (t.endDate && t.endDate < t.startDate) throw new DomainError("Срок окончания раньше даты начала.");
  if (t.toAccountId) {
    if (t.toAccountId !== current?.toAccountId) assertAccount(state, t.toAccountId);
    if (t.toAccountId === (t.accountId ?? MAIN_ACCOUNT_ID)) throw new DomainError("Платёж не может идти на тот же счёт.");
  }
  if (t.loanId) {
    const loan = state.loans.find((l) => l.id === t.loanId);
    if (!loan) throw new DomainError("Долг не найден.");
    if (loan.kind === "lend") throw new DomainError("Платить можно только по своему долгу или кредиту.");
  }
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

/**
 * Одни и те же цифры карты у двух счетов одного банка — СМС не поймёт, куда записать. У карт разных банков
 * цифры могут совпасть: счёт ищется среди счетов банка, приславшего СМС.
 */
function assertUniqueSmsKeys(accounts: Account[]): void {
  const seen = new Map<string, string>();
  for (const account of accounts) {
    for (const key of new Set(accountKeys(account))) {
      const scoped = `${account.bankId ?? ""}|${key}`;
      const other = seen.get(scoped);
      if (other) throw new DomainError(`Цифры ${key} уже указаны у счёта «${other}»${account.bankId ? " этого банка" : ""}.`);
      seen.set(scoped, account.name);
    }
  }
}

/** Банк: без пустых и повторяющихся отправителей. */
function cleanBank(bank: Bank): Bank {
  const seen = new Set<string>();
  const senders = bank.senders
    .map((s) => s.trim())
    .filter((s) => {
      const key = senderKey(s);
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  return { ...bank, name: bank.name.trim(), senders };
}

/** Названия банков не повторяются; отправитель — только у одного банка, иначе СМС не поймёт, чья она. */
function assertBanks(banks: Bank[]): void {
  const names = new Set<string>();
  const senders = new Map<string, string>();
  for (const bank of banks) {
    const name = senderKey(bank.name);
    if (names.has(name)) throw new DomainError(`Банк «${bank.name}» уже есть.`);
    names.add(name);
    for (const sender of bank.senders) {
      const other = senders.get(senderKey(sender));
      if (other) throw new DomainError(`Отправитель «${sender}» уже указан у банка «${other}».`);
      senders.set(senderKey(sender), bank.name);
    }
  }
}

/** Счета банка (accountIds): перечисленные переходят в этот банк, остальные его счета остаются без банка. */
function linkBankAccounts(state: State, bankId: string, accountIds: string[] | undefined): State {
  if (!accountIds) return state;
  const ids = new Set(accountIds);
  const accounts = accountsOf(state);
  for (const id of ids) if (!accounts.some((a) => a.id === id)) throw new DomainError("Счёт не найден — возможно, его удалили.");
  const next = accounts.map((a) => {
    if (ids.has(a.id)) return a.bankId === bankId ? a : { ...a, bankId };
    if (a.bankId !== bankId) return a;
    const copy = { ...a };
    delete copy.bankId;
    return copy;
  });
  assertUniqueSmsKeys(next);
  return { ...state, accounts: next };
}

/** Куда автоотчисление: с дохода — на счёт из настроек «Откладывать с доходов», с покупки — «с покупок». */
function linkedSavingTarget(state: State, tx: Transaction): string {
  const id = tx.type === "income" ? state.settings.salarySaving.toAccountId : state.settings.purchaseSaving.toAccountId;
  return savingsTarget(state, id);
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

/** Ставит или снимает у операции отметку «отчисление ещё копится». */
function markSavingPending(state: State, id: string, pending: boolean): State {
  return {
    ...state,
    transactions: state.transactions.map((t) => {
      if (t.id !== id || Boolean(t.savingPending) === pending) return t;
      const next = { ...t };
      if (pending) next.savingPending = true;
      else delete next.savingPending;
      return next;
    }),
  };
}

/** Приводит автоотчисление, привязанное к операции, в соответствие с ней (по текущим настройкам). */
function syncLinkedSaving(state: State, source: Transaction): State {
  const existing = findLinkedSaving(state, source);
  const desired = autoSavingAmount(source, state.settings);
  if (desired <= 0) {
    const next = existing ? { ...state, transactions: state.transactions.filter((t) => t !== existing) } : state;
    return markSavingPending(next, source.id, false);
  }
  if (existing === null) throw new DomainError("Не удалось создать автоотчисление: такой id уже занят.");
  // Отчисление ещё не переведено и задан порог «переводить от N ₽» — копится вместе с остальными этого вида.
  if (!existing && savingThreshold(state.settings, source.type) > 0) {
    return settleAutoSavings(markSavingPending(state, source.id, true), source.type);
  }
  const others = existing ? state.transactions.filter((t) => t !== existing) : state.transactions;
  return markSavingPending(
    {
      ...state,
      transactions: [...others, buildLinkedSaving(source, desired, linkedSavingSource(state, source), linkedSavingTarget(state, source))],
    },
    source.id,
    false,
  );
}

/**
 * Накопленные автоотчисления одного вида (с покупок или с доходов) переводятся разом, когда их сумма дошла
 * до порога из настроек — как в банке «переводить, когда накопится 100 ₽». До этого деньги остаются на счёте
 * операции и в сбережения не засчитываются. Каждое отчисление по-прежнему привязано к своей операции.
 */
function settleAutoSavings(state: State, type: Transaction["type"]): State {
  if (type !== "income" && type !== "expense") return state;
  const pending = state.transactions.filter((t) => t.savingPending && t.type === type);
  if (!pending.length) return state;
  const amounts = pending.map((t) => autoSavingAmount(t, state.settings));
  // Отчисления, которых по нынешним настройкам нет (выключили, категория-исключение), больше не копятся.
  const stale = new Set(pending.filter((_, i) => amounts[i] <= 0).map((t) => t.id));
  const total = amounts.reduce((sum, a) => sum + Math.max(0, a), 0);
  const settle = total > 0 && total >= savingThreshold(state.settings, type);
  if (!settle && !stale.size) return state;
  const done = settle ? new Set(pending.map((t) => t.id)) : stale;
  const created = settle
    ? pending.flatMap((t, i) =>
        amounts[i] > 0 && findLinkedSaving(state, t) === undefined
          ? [buildLinkedSaving(t, amounts[i], linkedSavingSource(state, t), linkedSavingTarget(state, t))]
          : [],
      )
    : [];
  if (created.length) assertTxCapacity(state, created.length);
  return {
    ...state,
    transactions: [
      ...state.transactions.map((t) => {
        if (!done.has(t.id)) return t;
        const next = { ...t };
        delete next.savingPending;
        return next;
      }),
      ...created,
    ],
  };
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

/** Начисление регулярного платежа или дохода за месяц — из шаблона. */
function templateOccurrence(template: Template, month: MonthKey): Omit<Occurrence, "date" | "amount"> {
  return {
    templateId: template.id,
    month,
    kind: template.kind,
    title: template.title,
    category: template.category,
    ...(template.accountId ? { accountId: template.accountId } : {}),
    ...(template.toAccountId ? { toAccountId: template.toAccountId } : {}),
    ...(template.loanId ? { loanId: template.loanId } : {}),
    ...(template.goalId ? { goalId: template.goalId } : {}),
  };
}

/**
 * Операция-начисление регулярного платежа (синхронизация шаблонов и подтверждение по СМС — одинаково).
 * Платёж на свой счёт — перевод (на накопительный — отложено в месяце), платёж по кредиту — расход в счёт
 * долга (или корректировка, если деньги долга прошли через счёт), остальное — обязательный расход или доход.
 */
function occurrenceTransaction(
  state: State,
  occ: Omit<Occurrence, "date" | "amount">,
  fields: { id: string; amount: Kopecks; date: IsoDate; note: string; review?: boolean; accountId?: string },
): Transaction {
  const accountId = fields.accountId ?? occ.accountId;
  const base = {
    id: fields.id,
    date: fields.date,
    title: occ.title,
    note: fields.note,
    templateId: occ.templateId,
    occurrenceMonth: occ.month,
    ...(fields.review ? { review: true as const } : {}),
    ...(accountId ? { accountId } : {}),
  };
  if (occ.kind === "expense" && occ.goalId) {
    // Пополнение цели — отложено в месяце, на счёт цели (или в «Сбережения»), с отметкой цели.
    const goal = state.goals.find((g) => g.id === occ.goalId);
    const to = savingsTarget(state, goal?.accountId);
    return {
      ...base,
      type: "saving",
      amount: fields.amount,
      category: SAVINGS_CATEGORY,
      ...(goal ? { goalId: goal.id } : {}),
      ...(to !== SAVINGS_ACCOUNT_ID ? { toAccountId: to } : {}),
    };
  }
  if (occ.kind === "expense" && occ.toAccountId) {
    if (findAccount(state, occ.toAccountId)?.kind === "savings") {
      return {
        ...base,
        type: "saving",
        amount: fields.amount,
        category: SAVINGS_CATEGORY,
        ...(occ.toAccountId !== SAVINGS_ACCOUNT_ID ? { toAccountId: occ.toAccountId } : {}),
      };
    }
    return { ...base, type: "transfer", amount: fields.amount, category: "", toAccountId: occ.toAccountId };
  }
  if (occ.kind === "expense" && occ.loanId) {
    const loan = state.loans.find((l) => l.id === occ.loanId);
    if (loan && loanOpening(state, loan)) {
      return {
        ...base,
        type: "adjustment",
        amount: -loanOpeningSign(loan.kind) * fields.amount,
        category: ADJUSTMENT_CATEGORY,
        loanId: loan.id,
      };
    }
    return {
      ...base,
      type: "expense",
      amount: fields.amount,
      category: occ.category,
      mandatory: true,
      autoSaving: false,
      ...(loan ? { loanId: loan.id } : {}),
    };
  }
  return {
    ...base,
    type: occ.kind,
    amount: fields.amount,
    category: occ.category,
    // Расход по шаблону обязательный и без «копилки с покупок»; с дохода — отчисление по настройкам.
    ...(occ.kind === "expense"
      ? { mandatory: true, autoSaving: false }
      : { autoSaving: salarySavingAmount(fields.amount, occ.category, state.settings) > 0 }),
  };
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
    const tx = occurrenceTransaction(state, occ, { id, amount: occ.amount, date: occ.date, note: notes.get(occ.templateId) ?? "" });
    created.push(tx);
    const saving = autoSavingAmount(tx, state.settings);
    const savingId = linkedSavingId(id);
    if (saving > 0 && savingThreshold(state.settings, tx.type) > 0) {
      // Порог «переводить от N ₽» — отчисление копится (см. settleAutoSavings).
      tx.savingPending = true;
    } else if (saving > 0 && !existing.has(savingId)) {
      existing.add(savingId);
      created.push(buildLinkedSaving(tx, saving, linkedSavingSource(state, tx), linkedSavingTarget(state, tx)));
    }
  }
  // Все начисления упёрлись в занятые id — состояние не меняется (повторная синхронизация — тот же объект).
  if (!created.length) return state;
  assertTxCapacity(state, created.length);
  const next = { ...state, transactions: [...state.transactions, ...created] };
  return created.some((t) => t.savingPending) ? settleAutoSavings(settleAutoSavings(next, "income"), "expense") : next;
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
      let current = findTx(state, action.id);
      if (current.type !== "income" && current.type !== "expense") {
        // Перевод или сбережения стали расходом или доходом (операция из СМС определилась неверно).
        if (!isEditableTransaction(current) || !action.patch.type || action.patch.category === undefined) {
          throw new DomainError("Эту операцию нельзя изменить — удалите её и создайте заново.");
        }
        const plain: Transaction = {
          id: current.id,
          type: action.patch.type,
          amount: Math.abs(current.amount),
          date: current.date,
          category: action.patch.category,
          title: current.title,
          note: current.note,
          ...(current.accountId ? { accountId: current.accountId } : {}),
          ...(current.templateId && current.occurrenceMonth
            ? { templateId: current.templateId, occurrenceMonth: current.occurrenceMonth }
            : {}),
        };
        state = { ...state, transactions: state.transactions.map((t) => (t === current ? plain : t)) };
        current = plain;
      }
      if (action.patch.accountId !== undefined && action.patch.accountId !== current.accountId) {
        assertAccount(state, action.patch.accountId);
      }
      // Здесь операция — уже доход или расход (перевод и сбережения выше превращены в них).
      const type = (action.patch.type ?? current.type) as "income" | "expense";
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

    case "tx.move": {
      const current = findTx(state, action.id);
      if (!isEditableTransaction(current)) throw new DomainError("Эту операцию нельзя сделать переводом.");
      const from = assertAccount(state, action.from);
      const to = assertAccount(state, action.to);
      if (from.id === to.id) throw new DomainError("Выберите два разных счёта.");
      // Прежняя операция и её автоотчисление уходят; перевод встаёт на её место с тем же id (проверки — как
      // у нового перевода, без учёта прежней операции).
      const linked = findLinkedSaving(state, current);
      const without: State = { ...state, transactions: state.transactions.filter((t) => t !== current && t !== linked) };
      const note = action.note ?? current.note;
      const savingsSide = to.kind === "savings" && from.kind !== "savings" ? to.id : from.kind === "savings" && to.kind !== "savings" ? from.id : null;
      // Пополнение цели остаётся пополнением цели, если деньги идут на тот же накопительный счёт.
      const goalId =
        current.type === "saving" && current.goalId && savingsSide === targetAccountId(current) ? current.goalId : undefined;
      const move: Action =
        savingsSide === to.id
          ? { type: "savings.move", id: current.id, date: action.date, amount: action.amount, note, accountId: from.id, toAccountId: to.id, ...(goalId ? { goalId } : {}) }
          : savingsSide === from.id
            ? { type: "savings.move", id: current.id, date: action.date, amount: -action.amount, note, accountId: to.id, toAccountId: from.id, ...(goalId ? { goalId } : {}) }
            : { type: "transfer.add", id: current.id, date: action.date, from: from.id, to: to.id, amount: action.amount, note, ...(action.title ? { title: action.title } : {}) };
      const next = applyAction(without, move);
      const title = action.title?.trim();
      return {
        ...next,
        transactions: next.transactions.map((t) =>
          t.id !== current.id
            ? t
            : {
                ...t,
                ...(title ? { title: clipTitle(title) } : {}),
                ...(current.templateId && current.occurrenceMonth
                  ? { templateId: current.templateId, occurrenceMonth: current.occurrenceMonth }
                  : {}),
              },
        ),
      };
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

    case "tx.ownMoney": {
      const current = findTx(state, action.id);
      if (action.own) {
        if (current.type !== "income") throw new DomainError("Отметить «не доход» можно только доход.");
        if (current.templateId) throw new DomainError("Это регулярный доход — измените или удалите его в «Регулярных».");
        const linked = findLinkedSaving(state, current);
        const own: Transaction = {
          id: current.id,
          type: "adjustment",
          amount: current.amount,
          date: current.date,
          category: ADJUSTMENT_CATEGORY,
          title: clipTitle(current.title || current.category || "Свои деньги"),
          note: current.note,
          ownMoney: true,
          ...(current.accountId ? { accountId: current.accountId } : {}),
        };
        return {
          ...state,
          // Отчисление с «дохода» тоже уходит: откладывать было не с чего.
          transactions: state.transactions.filter((t) => t !== linked).map((t) => (t === current ? own : t)),
        };
      }
      if (current.type !== "adjustment" || !current.ownMoney) throw new DomainError("Это не зачисление своих денег.");
      const category = action.category ?? (state.categories.income.includes("Переводы") ? "Переводы" : (state.categories.income[0] ?? OTHER_CATEGORY));
      const income: Transaction = {
        id: current.id,
        type: "income",
        amount: current.amount,
        date: current.date,
        category,
        title: current.title,
        note: current.note,
        autoSaving: false,
        ...(current.accountId ? { accountId: current.accountId } : {}),
      };
      const next = ensureCategory(state, "income", category);
      return { ...next, transactions: next.transactions.map((t) => (t.id === current.id ? income : t)) };
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
      const tx = balanceAdjustment(state, account, { id: action.id, amount: delta, date: action.date, accountId: action.accountId });
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
      // Счёт сразу в банке — банки по умолчанию сохраняются, чтобы ссылка была на запись.
      const base = action.account.bankId ? withSavedBanks(state) : state;
      if (action.account.bankId && !base.banks?.some((b) => b.id === action.account.bankId)) throw new DomainError("Банк не найден.");
      const accounts = accountsOf(base);
      if (accounts.some((a) => a.id === action.account.id)) throw new DomainError("Такой счёт уже есть.");
      if (accounts.length >= LIMITS.accounts) throw new DomainError("Слишком много счетов.");
      const account: Account = { ...action.account, spending: action.account.kind === "credit" ? false : action.account.spending };
      const next = [...accounts, account];
      assertUniqueSmsKeys(next);
      return { ...base, accounts: next };
    }

    case "account.update": {
      const { creditLimit, graceDays, terms, archived, number, bankId, ...rest } = action.patch;
      // Меняется банк счёта — банки по умолчанию сохраняются (см. withSavedBanks).
      const base = bankId !== undefined ? withSavedBanks(state) : state;
      if (bankId && !base.banks?.some((b) => b.id === bankId)) throw new DomainError("Банк не найден.");
      const accounts = accountsOf(base);
      const current = accounts.find((a) => a.id === action.id);
      if (!current) throw new DomainError("Счёт не найден.");
      const updated: Account = { ...current, ...rest };
      if (bankId !== undefined) {
        if (bankId === null) delete updated.bankId;
        else updated.bankId = bankId;
      }
      if (terms !== undefined) {
        if (terms === null) delete updated.terms;
        else updated.terms = terms;
      }
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
      return { ...base, accounts: next };
    }

    case "bank.add": {
      const base = withSavedBanks(state);
      const banks = base.banks ?? [];
      if (banks.some((b) => b.id === action.bank.id)) throw new DomainError("Такой банк уже есть.");
      if (banks.length >= LIMITS.banks) throw new DomainError("Слишком много банков.");
      const next = [...banks, cleanBank(action.bank)];
      assertBanks(next);
      return linkBankAccounts({ ...base, banks: next }, action.bank.id, action.accountIds);
    }

    case "bank.update": {
      const base = withSavedBanks(state);
      const banks = base.banks ?? [];
      const current = banks.find((b) => b.id === action.id);
      if (!current) throw new DomainError("Банк не найден.");
      const next = banks.map((b) => (b.id === current.id ? cleanBank({ ...current, ...action.patch }) : b));
      assertBanks(next);
      return linkBankAccounts({ ...base, banks: next }, current.id, action.accountIds);
    }

    case "bank.delete": {
      const base = withSavedBanks(state);
      if (!banksOf(base).some((b) => b.id === action.id)) throw new DomainError("Банк не найден.");
      const banks = (base.banks ?? []).filter((b) => b.id !== action.id);
      return linkBankAccounts({ ...base, banks }, action.id, []);
    }

    case "account.bank": {
      const accounts = accountsOf(state);
      const current = accounts.find((a) => a.id === action.accountId);
      if (!current) throw new DomainError("Счёт не найден.");
      // СМС обработали не по порядку (19:54 раньше 19:52): остаток из более ранней не заменяет свежий —
      // её операция уже записана, и расхождение по свежему остатку считается с ней.
      if (current.bank && bankSnapshotOlder(action, current.bank)) return state;
      const bank = { amount: action.amount, delta: action.delta, date: action.date, ...(action.time ? { time: action.time } : {}) };
      return { ...state, accounts: accounts.map((a) => (a.id === current.id ? { ...current, bank } : a)) };
    }

    case "account.bankFix": {
      const accounts = accountsOf(state);
      const current = accounts.find((a) => a.id === action.accountId);
      if (!current) throw new DomainError("Счёт не найден.");
      const delta = bankDelta(state, current);
      // Уже решено — например, поправили на другом устройстве.
      if (delta === null || !current.bank) return state;
      const resolved = { ...current, bank: { ...current.bank, delta: 0 } };
      const next = { ...state, accounts: accounts.map((a) => (a.id === current.id ? resolved : a)) };
      if (delta === 0) return next;
      assertNewId(state, action.id);
      assertTxCapacity(state, 1);
      // Корректировка — днём СМС: остаток приложения на тот день становится как в банке.
      const tx = balanceAdjustment(state, current, { id: action.id, amount: delta, date: current.bank.date, accountId: current.id });
      return { ...next, transactions: [...next.transactions, tx] };
    }

    case "account.delete": {
      const accounts = accountsOf(state);
      const current = accounts.find((a) => a.id === action.id);
      if (!current) throw new DomainError("Счёт не найден.");
      if (isBuiltinAccount(current.id)) throw new DomainError("Этот счёт нельзя удалить — его можно переименовать.");
      const used =
        state.transactions.some((t) => t.accountId === current.id || t.toAccountId === current.id) ||
        state.templates.some((t) => t.accountId === current.id || t.toAccountId === current.id) ||
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
        // Снимают с конкретного накопительного счёта — его и проверяем (учитывается ли он в сбережениях,
        // не важно: со счёта «не в сбережениях» тоже можно перевести на карту).
        // Счёт, закреплённый за целью: всё, что на нём, — деньги цели, и снимать их можно и без отметки цели.
        const ownGoal = goal ?? state.goals.find((g) => dedicatedGoalAccount(state, g) === toId);
        if (ownGoal && dedicatedGoalAccount(state, ownGoal) === toId) {
          const available = goalAvailable(state, ownGoal);
          if (available + action.amount < 0) {
            throw new DomainError(`Нельзя снять больше, чем накоплено (${formatMoney(Math.max(0, available))}).`);
          }
        } else if (goal) {
          // С цели можно снять только то, что откладывали в приложении (накопленное до него не на счёте).
          const available = goalAvailable(state, goal);
          if (available + action.amount < 0) {
            throw new DomainError(`Нельзя снять больше, чем накоплено (${formatMoney(Math.max(0, available))}).`);
          }
        } else {
          // Деньги целей на этом счёте снимают через цель: иначе их сняли бы второй раз с цели.
          const reserved = goalsReservedOn(state, toId);
          const free = accountBalance(state, toId) - reserved;
          if (reserved > 0 && free + action.amount < 0) {
            throw new DomainError(
              `Нельзя снять больше, чем свободно на счёте «${target.name}» (${formatMoney(Math.max(0, free))}): остальное отложено на цели — их деньги снимайте на вкладке «Цели».`,
            );
          }
        }
        // Сбережения разложены по счетам — снять можно только то, что лежит на выбранном.
        const onAccount = accountBalance(state, toId);
        if (onAccount + action.amount < 0) {
          throw new DomainError(`Нельзя снять больше, чем есть на счёте «${target.name}» (${formatMoney(Math.max(0, onAccount))}).`);
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
      assertTemplateTargets(state, action.template);
      const t = { ...action.template, category: canonicalCategory(state, action.template.category) };
      const next = ensureCategory(state, t.kind === "income" ? "income" : "mandatory", t.category);
      return { ...next, templates: [...next.templates, t] };
    }

    case "template.update": {
      const current = findTemplate(state, action.id);
      const { accountId, toAccountId, loanId, goalId, endDate, untilDone, ...fields } = action.patch;
      const patched: Template = { ...current, ...fields };
      for (const [key, value] of [
        ["accountId", accountId],
        ["toAccountId", toAccountId],
        ["loanId", loanId],
        ["goalId", goalId],
        ["endDate", endDate],
      ] as const) {
        if (value === null) delete patched[key];
        else if (value !== undefined) patched[key] = value;
      }
      if (untilDone === false) delete patched.untilDone;
      else if (untilDone) patched.untilDone = true;
      assertTemplateTargets(state, patched, current);
      const updated: Template =
        fields.category === undefined ? patched : { ...patched, category: canonicalCategory(state, fields.category) };
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
      const occurrence = templateOccurrence(template, action.month);
      if (current) {
        // Сумма со знаком, как у начисления этого вида (у корректировки по долгу — минус).
        const amount = occurrenceTransaction(state, occurrence, { id: current.id, amount: action.amount, date: action.date, note: "" }).amount;
        const updated: Transaction = {
          ...current,
          amount,
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
      const tx = occurrenceTransaction(state, occurrence, {
        id,
        amount: action.amount,
        date: action.date,
        note: action.note,
        review: action.review,
        accountId: action.accountId,
      });
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
      const { accountId, ...fields } = action.patch;
      if (accountId) assertSavingsAccount(state, accountId);
      return {
        ...state,
        goals: state.goals.map((g) => {
          if (g.id !== action.id) return g;
          const updated = { ...g, ...fields };
          if (accountId === null) delete updated.accountId;
          else if (accountId !== undefined) updated.accountId = accountId;
          return updated;
        }),
      };
    }

    case "goal.delete": {
      const deleted = state.goals.find((g) => g.id === action.id);
      if (!deleted) throw new DomainError("Цель не найдена.");
      // Накопленные деньги остаются в общих сбережениях; регулярные пополнения цели — пополнения её счёта.
      return {
        ...state,
        goals: state.goals.filter((g) => g.id !== action.id),
        templates: state.templates.map((t) => {
          if (t.goalId !== action.id) return t;
          const rest = { ...t };
          delete rest.goalId;
          delete rest.untilDone;
          const to = savingsTarget(state, deleted.accountId);
          return { ...rest, toAccountId: to };
        }),
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
      if (action.loan.cashAmount !== undefined && action.loan.cashAmount > action.loan.amount) {
        throw new DomainError("Снятие наличных не может быть больше суммы долга.");
      }
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
      const { terms, cashAmount, takenAt, ...rest } = action.patch;
      const updated: Loan = { ...current, ...rest };
      if (terms !== undefined) {
        if (terms === null) delete updated.terms;
        else updated.terms = terms;
      }
      if (cashAmount !== undefined) {
        if (cashAmount === null) delete updated.cashAmount;
        else updated.cashAmount = cashAmount;
      }
      if (takenAt !== undefined) {
        if (takenAt === null) delete updated.takenAt;
        else updated.takenAt = takenAt;
      }
      if (updated.cashAmount !== undefined && updated.cashAmount > updated.amount) {
        throw new DomainError("Снятие наличных не может быть больше суммы долга.");
      }
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
        // Регулярные платежи по этому долгу становятся обычными обязательными платежами.
        templates: state.templates.map((t) => {
          if (t.loanId !== action.id) return t;
          const rest = { ...t };
          delete rest.loanId;
          delete rest.untilDone;
          return rest;
        }),
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
      for (const id of [
        action.settings.salarySaving.toAccountId,
        action.settings.purchaseSaving.toAccountId,
        action.settings.rolloverAccountId,
      ]) {
        if (id && id !== previous.salarySaving.toAccountId && id !== previous.purchaseSaving.toAccountId && id !== previous.rolloverAccountId) {
          assertSavingsAccount(state, id);
        }
      }
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
      const updated = { ...state, settings: history ? { ...next, savingsRateHistory: history } : next };
      // Порог перевода снизили или убрали — накопленное может уже набраться.
      return settleAutoSavings(settleAutoSavings(updated, "income"), "expense");
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
          const target = savingsTarget(state, state.settings.rolloverAccountId);
          const tx: Transaction = {
            id: action.id,
            type: "saving",
            amount,
            date: action.date,
            category: SAVINGS_CATEGORY,
            title: "Остаток бюджета прошлого месяца",
            note: "",
            ...(target !== SAVINGS_ACCOUNT_ID ? { toAccountId: target } : {}),
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
