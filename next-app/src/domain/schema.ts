import { z } from "zod";
import { isValidIsoDate, isValidMonthKey } from "./dates";
import { MAX_KOPECKS } from "./money";
import { isReservedKey } from "./records";

export const LIMITS = {
  transactions: 50_000,
  templates: 500,
  goals: 200,
  loans: 200,
  categoriesPerGroup: 100,
  title: 80,
  note: 500,
  category: 40,
  profileNotes: 1000,
  /** Пропущенных месяцев на один шаблон. */
  skippedMonths: 1200,
} as const;

/** Служебные имена (__proto__, constructor…) запрещены: id и категории служат ключами записей состояния. */
export const idSchema = z
  .string()
  .regex(/^[A-Za-z0-9_.-]{1,120}$/, "Некорректный идентификатор")
  .refine((v) => !isReservedKey(v), "Некорректный идентификатор");
export const isoDateSchema = z.string().refine(isValidIsoDate, "Некорректная дата");
export const monthKeySchema = z.string().refine(isValidMonthKey, "Некорректный месяц");
export const kopecksSchema = z.number().int().min(-MAX_KOPECKS).max(MAX_KOPECKS);
export const positiveKopecksSchema = z.number().int().min(1, "Сумма должна быть больше нуля").max(MAX_KOPECKS);
export const nonNegativeKopecksSchema = z.number().int().min(0).max(MAX_KOPECKS);
export const categoryNameSchema = z
  .string()
  .trim()
  .min(1, "Пустая категория")
  .max(LIMITS.category)
  .refine((v) => !isReservedKey(v), "Недопустимое название категории");
export const titleSchema = z.string().trim().max(LIMITS.title);
export const noteSchema = z.string().trim().max(LIMITS.note);

export const transactionTypeSchema = z.enum(["income", "expense", "saving", "adjustment"]);
export type TransactionType = z.infer<typeof transactionTypeSchema>;

export const transactionSchema = z
  .object({
    id: idSchema,
    type: transactionTypeSchema,
    /** Для income/expense — положительная сумма; для saving/adjustment — со знаком. */
    amount: kopecksSchema,
    date: isoDateSchema,
    /** Пустая — у корректировок; служебные имена запрещены, как и у категорий в справочнике. */
    category: z
      .string()
      .trim()
      .max(LIMITS.category)
      .refine((v) => !isReservedKey(v), "Недопустимое название категории"),
    title: titleSchema,
    note: noteSchema,
    /** Расход обязательный или крупный (аренда, кредит, подписки, техника) — вычитается из бюджета до гибких трат. */
    mandatory: z.boolean().optional(),
    /** Делать ли автоотчисление в сбережения с этой операции. */
    autoSaving: z.boolean().optional(),
    /** Операция создана из шаблона: шаблон и месяц, за который она начислена. */
    templateId: idSchema.optional(),
    occurrenceMonth: monthKeySchema.optional(),
    /** Автоотчисление, привязанное к исходной операции. */
    linkedTo: idSchema.optional(),
    goalId: idSchema.optional(),
    loanId: idSchema.optional(),
    /**
     * Перенос остатка гибкого бюджета за этот месяц (rollover.resolve «saved»). Такое отчисление уменьшает
     * деньги на счёте и пополняет сбережения, но не считается сбережениями месяца, в котором создано.
     */
    rolloverOf: monthKeySchema.optional(),
    /**
     * Корректировка, созданная вместе с долгом (деньги прошли через счёт, loan.add с cashFlow).
     * Остальные корректировки этого долга — платежи по нему (loan.payment), см. loanPaid.
     */
    loanOpening: z.literal(true).optional(),
    /**
     * Добавлена автоматически (из СМС банка, командой Siri) и ещё не проверена: при запуске приложение
     * показывает такие операции списком, чтобы подтвердить или поправить. Любая правка снимает отметку.
     */
    review: z.literal(true).optional(),
  })
  .superRefine((tx, ctx) => {
    if ((tx.type === "income" || tx.type === "expense") && tx.amount <= 0) {
      ctx.addIssue({ code: "custom", message: "Сумма должна быть больше нуля", path: ["amount"] });
    }
    if ((tx.type === "saving" || tx.type === "adjustment") && tx.amount === 0) {
      ctx.addIssue({ code: "custom", message: "Сумма не может быть нулевой", path: ["amount"] });
    }
    if ((tx.templateId === undefined) !== (tx.occurrenceMonth === undefined)) {
      ctx.addIssue({ code: "custom", message: "Неполная привязка к регулярному платежу", path: ["templateId"] });
    }
    if (tx.loanOpening && (tx.type !== "adjustment" || tx.loanId === undefined)) {
      ctx.addIssue({ code: "custom", message: "Отметка открытия долга — только у корректировки долга", path: ["loanOpening"] });
    }
  });
export type Transaction = z.infer<typeof transactionSchema>;

export const templateSchema = z.object({
  id: idSchema,
  kind: z.enum(["income", "expense"]),
  title: titleSchema.min(1, "Укажите название"),
  category: categoryNameSchema,
  amount: positiveKopecksSchema,
  dayOfMonth: z.number().int().min(1).max(31),
  active: z.boolean(),
  /** С какой даты шаблон начинает начислять операции. */
  startDate: isoDateSchema,
  note: noteSchema,
});
export type Template = z.infer<typeof templateSchema>;

export const goalSchema = z.object({
  id: idSchema,
  name: titleSchema.min(1, "Укажите название"),
  targetAmount: positiveKopecksSchema,
  /** Сколько было накоплено до начала учёта в приложении. */
  initialAmount: nonNegativeKopecksSchema,
  dueDate: isoDateSchema.nullable(),
  note: noteSchema,
  createdAt: isoDateSchema,
});
export type Goal = z.infer<typeof goalSchema>;

export const loanKindSchema = z.enum(["borrow", "lend", "credit"]);
export type LoanKind = z.infer<typeof loanKindSchema>;

export const loanSchema = z.object({
  id: idSchema,
  /** borrow — я занял, credit — кредит банка (оба — мой долг); lend — я одолжил (должны мне). */
  kind: loanKindSchema,
  name: titleSchema.min(1, "Укажите название"),
  amount: positiveKopecksSchema,
  /** Сколько было погашено до начала учёта в приложении. */
  initialPaid: nonNegativeKopecksSchema,
  dueDate: isoDateSchema.nullable(),
  note: noteSchema,
  createdAt: isoDateSchema,
});
export type Loan = z.infer<typeof loanSchema>;

const categoryListSchema = z.array(categoryNameSchema).max(LIMITS.categoriesPerGroup);

export const categoriesSchema = z.object({
  income: categoryListSchema,
  mandatory: categoryListSchema,
  flexible: categoryListSchema,
});
export type Categories = z.infer<typeof categoriesSchema>;
export type CategoryGroup = keyof Categories;

export const settingsSchema = z.object({
  /** Какую долю доходов месяца планируем откладывать (текущая норма). */
  savingsRatePercent: z.number().int().min(0).max(90),
  /**
   * С какого месяца какая норма действовала: смена нормы не переписывает прошлые месяцы.
   * Ведёт только редьюсер (settings.update); нет записи — для всех месяцев действует savingsRatePercent.
   */
  savingsRateHistory: z
    .array(z.object({ from: monthKeySchema, percent: z.number().int().min(0).max(90) }))
    .max(240)
    .optional(),
  salarySaving: z.object({
    enabled: z.boolean(),
    percent: z.number().int().min(1).max(90),
    categories: z.array(categoryNameSchema).max(20),
  }),
  purchaseSaving: z.object({
    enabled: z.boolean(),
    percent: z.number().int().min(0).max(50),
    cap: nonNegativeKopecksSchema,
    /** Округление покупки вверх до кратного (0 — без округления). */
    roundTo: nonNegativeKopecksSchema.max(1_000_000),
    excludedCategories: z.array(categoryNameSchema).max(50),
  }),
});
export type Settings = z.infer<typeof settingsSchema>;

export const profileSchema = z.object({
  occupation: z.string().trim().max(100),
  riskLevel: z.enum(["low", "medium", "high"]).nullable(),
  savingsStyle: z.enum(["aggressive", "balanced", "relaxed"]).nullable(),
  notes: z.string().trim().max(LIMITS.profileNotes),
});
export type Profile = z.infer<typeof profileSchema>;

/** Сообщает о повторяющихся id в списке (id — ключ для ссылок, правок и удаления). */
function checkUniqueIds(list: readonly { id: string }[], path: string, ctx: z.RefinementCtx): void {
  const seen = new Set<string>();
  list.forEach((item, index) => {
    if (seen.has(item.id)) {
      ctx.addIssue({ code: "custom", message: `Повторяющийся id: ${item.id}`, path: [path, index, "id"] });
    }
    seen.add(item.id);
  });
}

export const stateSchema = z
  .object({
    schemaVersion: z.literal(3),
    transactions: z.array(transactionSchema).max(LIMITS.transactions),
    templates: z.array(templateSchema).max(LIMITS.templates),
    goals: z.array(goalSchema).max(LIMITS.goals),
    loans: z.array(loanSchema).max(LIMITS.loans),
    categories: categoriesSchema,
    categoryLimits: z.record(categoryNameSchema, positiveKopecksSchema),
    /** Пропущенные начисления шаблонов: templateId → месяцы. */
    skipped: z.record(idSchema, z.array(monthKeySchema).max(LIMITS.skippedMonths)),
    /** Как решён перенос остатка гибкого бюджета за месяц. */
    rollover: z.record(monthKeySchema, z.enum(["saved", "dismissed"])),
    settings: settingsSchema,
    profile: profileSchema,
  })
  .superRefine((state, ctx) => {
    checkUniqueIds(state.transactions, "transactions", ctx);
    checkUniqueIds(state.templates, "templates", ctx);
    checkUniqueIds(state.goals, "goals", ctx);
    checkUniqueIds(state.loans, "loans", ctx);
  });
export type State = z.infer<typeof stateSchema>;
