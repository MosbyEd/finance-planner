import { z } from "zod";
import type { Action } from "./actions";
import { addDays, addMonths, firstDayOfMonth, isValidIsoDate, lastDayOfMonth, monthKeyOf, parseIsoDate, type IsoDate } from "./dates";
import { MAX_KOPECKS, kopecksToRubles, rublesToKopecks, type Kopecks } from "./money";
import {
  balanceAt,
  categoryBreakdown,
  goalSaved,
  loanInterest,
  loanRemaining,
  monthMetrics,
  periodTotals,
  safeToSpend,
  savingsTotal,
  upcomingEvents,
} from "./metrics";
import { isReservedKey } from "./records";
import { nextOccurrence } from "./recurring";
import { autoSavingByDefault } from "./savings";
import { suggestCategory } from "./sms";
import { LIMITS, type Account, type CreditTerms, type State } from "./schema";
import {
  accountBalance,
  activeAccounts,
  creditStatus,
  findAccount,
  isSpendingAccount,
  MAIN_ACCOUNT_ID,
  type CreditSummary,
} from "./accounts";

// ---------- снимок данных для модели ----------

const rub = (k: Kopecks) => kopecksToRubles(k);

/**
 * Насколько подробный снимок передавать модели. full — для DeepSeek и больших моделей; compact и minimal —
 * для модели Apple на телефоне с маленьким контекстом (если данные не влезли, запрос повторяется с более сжатым).
 */
export type AiDetail = "full" | "compact" | "minimal";

const DETAIL: Record<AiDetail, { recent: number; upcoming: number; previousMonths: number; templates: boolean; categories: number }> = {
  full: { recent: 150, upcoming: 100, previousMonths: 3, templates: true, categories: 100 },
  compact: { recent: 25, upcoming: 15, previousMonths: 2, templates: true, categories: 15 },
  minimal: { recent: 0, upcoming: 6, previousMonths: 0, templates: false, categories: 8 },
};

/** Компактный снимок финансов (суммы в рублях), который передаётся модели. */
export function buildAiSnapshot(state: State, today: IsoDate, detail: AiDetail = "full") {
  const d = DETAIL[detail];
  const month = monthKeyOf(today);
  const m = monthMetrics(state, month, today);
  const sts = safeToSpend(state, today);
  const previous = [1, 2, 3].slice(0, d.previousMonths).map((i) => {
    const key = addMonths(month, -i);
    const t = periodTotals(state, firstDayOfMonth(key), lastDayOfMonth(key));
    return {
      month: key,
      income: rub(t.income),
      mandatory: rub(t.mandatory),
      flexible: rub(t.flexible),
      savings: rub(t.savings),
    };
  });
  const recent = [...state.transactions]
    .filter((t) => t.date <= today)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, d.recent)
    .map((t) => ({
      date: t.date,
      type: t.type === "expense" ? (t.mandatory ? "mandatory_expense" : "expense") : t.type,
      amount: rub(t.amount),
      category: t.category,
      title: t.title,
    }));

  return {
    today,
    balanceOnAccount: rub(balanceAt(state, today)),
    savingsTotal: rub(savingsTotal(state, today)),
    safeToSpendToday: {
      recommended: rub(sts.recommended),
      spentToday: rub(sts.spentToday),
      leftToday: rub(sts.leftToday),
      budgetPerDay: rub(sts.budgetPerDay),
      cashPerDay: rub(sts.cashPerDay),
      horizon: sts.horizon,
      daysUntilHorizon: sts.daysUntil,
      mandatoryAndSavingsUntilHorizon: rub(sts.plannedOut),
      status: sts.status,
      cashGapDate: sts.gapDate,
    },
    currentMonth: {
      month,
      incomePlan: rub(m.income.plan),
      incomeFact: rub(m.income.fact),
      mandatoryPlan: rub(m.mandatory.plan),
      mandatoryFact: rub(m.mandatory.fact),
      savingsTarget: rub(m.savings.target),
      savingsFact: rub(m.savings.fact),
      flexibleBudget: rub(m.flexible.budget),
      flexibleSpent: rub(m.flexible.spent),
      flexibleLeft: rub(m.flexible.left),
      dailyPlanned: rub(m.daily.planned),
      daysLeft: m.daysLeft,
      warnings: m.warnings,
    },
    expensesByCategoryThisMonth: categoryBreakdown(state, firstDayOfMonth(month), today, "expense").slice(0, d.categories).map((r) => ({
      category: r.category,
      spent: rub(r.amount),
      limit: r.limit === null ? null : rub(r.limit),
    })),
    previousMonths: previous,
    upcoming30Days: upcomingEvents(state, today, addDays(today, 30)).slice(0, d.upcoming).map((e) => ({
      date: e.date,
      title: e.title,
      amount: rub(e.effect),
      kind: e.type,
      balanceAfter: rub(e.balanceAfter),
    })),
    accounts: activeAccounts(state).map((a) => {
      const credit = a.kind === "credit" ? creditStatus(state, a, today) : null;
      return {
        name: a.name,
        kind: a.kind,
        ...(credit
          ? {
              debt: rub(credit.debt),
              creditLimit: a.creditLimit ? rub(a.creditLimit) : null,
              interestFreeUntil: credit.graceEnd,
              ...aiInterest(credit, a.terms),
            }
          : { balance: rub(accountBalance(state, a.id, today)) }),
        countsInSafeToSpend: isSpendingAccount(a),
      };
    }),
    templates: (d.templates ? state.templates : []).map((t) => ({
      kind: t.kind,
      title: t.title,
      category: t.category,
      amount: rub(t.amount),
      dayOfMonth: t.dayOfMonth,
      active: t.active,
      next: nextOccurrence(state, t, today)?.date ?? null,
      account: findAccount(state, t.accountId ?? MAIN_ACCOUNT_ID)?.name ?? null,
      to: t.toAccountId ? (findAccount(state, t.toAccountId)?.name ?? null) : t.loanId ? (state.loans.find((l) => l.id === t.loanId)?.name ?? null) : null,
    })),
    goals: state.goals.map((g) => ({
      name: g.name,
      target: rub(g.targetAmount),
      saved: rub(goalSaved(state, g)),
      dueDate: g.dueDate,
    })),
    loans: state.loans.map((l) => {
      const interest = loanInterest(state, l, today);
      return {
        kind: l.kind,
        direction: l.kind === "lend" ? "мне должны" : "я должен",
        name: l.name,
        amount: rub(l.amount),
        remaining: rub(loanRemaining(state, l)),
        dueDate: l.dueDate,
        ...(interest ? { interestFreeUntil: interest.graceEnd, ...aiInterest(interest, l.terms) } : {}),
      };
    }),
    categoryLimits: Object.fromEntries(Object.entries(state.categoryLimits).map(([k, v]) => [k, rub(v)])),
    categories: state.categories,
    settings: {
      savingsRatePercent: state.settings.savingsRatePercent,
      salarySavingPercent: state.settings.salarySaving.enabled ? state.settings.salarySaving.percent : 0,
      purchaseSavingPercent: state.settings.purchaseSaving.enabled ? state.settings.purchaseSaving.percent : 0,
    },
    profile: state.profile,
    recentTransactions: recent,
  };
}

/** Условия и оценка процентов кредитки или долга — для модели. */
function aiInterest(summary: CreditSummary, terms: CreditTerms | undefined) {
  if (!terms && summary.accrued === 0 && summary.ifMissed === 0) return {};
  return {
    terms: terms
      ? {
          purchases: { ratePercent: terms.purchase.rate ?? null, interestFreeDays: terms.purchase.graceDays ?? null },
          cashAndTransfers: { ratePercent: terms.cash.rate ?? null, interestFreeDays: terms.cash.graceDays ?? null },
        }
      : null,
    interestAccruedEstimate: rub(summary.accrued),
    interestIfGraceMissedEstimate: rub(summary.ifMissed),
    interestPerDayEstimate: rub(summary.perDay),
  };
}

export function buildAiSystemPrompt(state: State, today: IsoDate, detail: AiDetail = "full"): string {
  const snapshot = buildAiSnapshot(state, today, detail);
  return [
    "Ты — финансовый помощник в приложении личного бюджета. Отвечай по-русски, коротко и по делу, простым языком.",
    "Пиши обычным текстом. Можно короткие списки через «- », без таблиц, заголовков и Markdown-разметки.",
    "Все числа бери только из данных ниже, ничего не выдумывай. Суммы указаны в рублях.",
    "Не называй служебные поля и значения из JSON (status, ok, gap, budgetPerDay и т. п.) — пересказывай их смысл по-русски:",
    "ok — «всё по плану», tight — «до дохода впритык», over — «перерасход», gap — «кассовый разрыв», no-income — «нет доходов в плане».",
    "",
    "Как устроен бюджет:",
    "- balanceOnAccount — деньги на счёте сейчас. savingsTotal — отложено в сбережения (не входит в баланс).",
    "- Гибкий бюджет месяца = доходы − обязательные расходы − цель по сбережениям (savingsTarget).",
    "- safeToSpendToday — сколько можно потратить сегодня; это уже посчитано приложением, не пересчитывай,",
    "  а объясняй: recommended = меньшее из budgetPerDay (по бюджету месяца) и cashPerDay (деньги на счёте",
    "  минус обязательные платежи до ближайшего дохода, делённые на дни до него). status gap — кассовый разрыв.",
    "- Долги: kind borrow или credit — это мой долг; kind lend — мне должны (актив, а не обязательство).",
    "- Профиль пользователя (profile) учитывай в советах, если он заполнен.",
    "",
    "- accounts — счета пользователя: balance — остаток, у кредитки debt — долг и interestFreeUntil — до какого дня без процентов.",
    "",
    "Если пользователь просит что-то добавить или изменить, в самом конце ответа добавь одну строку",
    "(пользователь подтвердит её перед применением):",
    'AI_CMDS: {"operations":[...],"templates":[...],"categoryLimits":{...},"transfers":[...],"templateUpdates":[...],"balances":[...],"goals":[...],"loanPayments":[...]}',
    '- operations: {"type":"income"|"expense","amount":число,"category":строка,"title":строка,"date":"YYYY-MM-DD","mandatory":true|false,"account":"название счёта"}',
    '- templates (новые ежемесячные): {"type":"income"|"expense","amount":число,"category":строка,"title":строка,"dayOfMonth":1-31,"account":"с какого счёта","to":"куда: свой счёт или кредит из loans"}',
    '- categoryLimits: {"Категория": лимит в рублях на месяц}',
    '- transfers (между своими счетами, погашение кредитки, пополнение накопительного): {"from":"счёт","to":"счёт","amount":число,"date":"YYYY-MM-DD"}',
    '- templateUpdates (изменить существующий регулярный): {"title":"название из templates","amount":число,"dayOfMonth":1-31,"active":true|false,"account":"счёт","to":"счёт, кредит или null"} — только меняемые поля',
    '- balances (сверить остаток): {"account":"счёт","amount":число} — сколько сейчас на счёте, у кредитки — долг',
    '- goals (пополнить цель, минус — снять): {"goal":"название цели","amount":число}',
    '- loanPayments (платёж по долгу или кредиту): {"loan":"название из loans","amount":число,"date":"YYYY-MM-DD"}',
    `Используй существующие категории и точные названия счетов, регулярных платежей, целей и долгов из данных. Дата по умолчанию — сегодня (${today}). Поле account необязательно.`,
    "В AI_CMDS — только то, о чём просил пользователь: просил операцию — только operations, без лимитов и регулярных платежей.",
    "Только когда пишешь AI_CMDS: одной фразой скажи, что предлагаешь добавить; поля и JSON в тексте не повторяй.",
    "Если ничего добавлять не нужно — не пиши AI_CMDS. Не пиши AI_CMDS, если пользователь об этом не просил.",
    "",
    `Данные пользователя на ${today} (JSON):`,
    JSON.stringify(snapshot),
  ].join("\n");
}

// ---------- разбор команд модели ----------

export interface AiOperation {
  type: "income" | "expense";
  amount: Kopecks;
  category: string;
  title: string;
  date: IsoDate;
  mandatory: boolean;
  /** Счёт (найден по названию из ответа модели); нет — как в окне операции, основной. */
  accountId?: string;
}

export interface AiTemplate {
  type: "income" | "expense";
  amount: Kopecks;
  category: string;
  title: string;
  dayOfMonth: number;
  accountId?: string;
  toAccountId?: string;
  loanId?: string;
}

/** Перевод между своими счетами (на накопительный — пополнение сбережений, с него — снятие). */
export interface AiTransfer {
  from: string;
  to: string;
  amount: Kopecks;
  date: IsoDate;
}

/** Правка существующего регулярного платежа: только меняемые поля; null у to — сделать обычным платежом. */
export interface AiTemplateUpdate {
  templateId: string;
  amount?: Kopecks;
  dayOfMonth?: number;
  active?: boolean;
  accountId?: string;
  toAccountId?: string | null;
  loanId?: string | null;
}

export interface AiProposal {
  operations: AiOperation[];
  templates: AiTemplate[];
  limits: { category: string; amount: Kopecks }[];
  transfers: AiTransfer[];
  templateUpdates: AiTemplateUpdate[];
  /** Сверка остатка: actual — остаток счёта (у кредитки — минус долг). */
  balances: { accountId: string; actual: Kopecks }[];
  /** Пополнение цели (минус — снять). */
  goals: { goalId: string; amount: Kopecks }[];
  loanPayments: { loanId: string; amount: Kopecks; date: IsoDate }[];
}

/** Пустое предложение — заготовка для разбора и для предложений, сохранённых до новых видов действий. */
export function emptyProposal(): AiProposal {
  return { operations: [], templates: [], limits: [], transfers: [], templateUpdates: [], balances: [], goals: [], loanPayments: [] };
}

export function proposalSize(p: AiProposal): number {
  return (
    p.operations.length +
    p.templates.length +
    p.limits.length +
    p.transfers.length +
    p.templateUpdates.length +
    p.balances.length +
    p.goals.length +
    p.loanPayments.length
  );
}

/** Для сравнения названий из ответа модели: регистр, «ё», пунктуация и кавычки не важны. */
function nameKey(text: string): string {
  return text.toLocaleLowerCase("ru").replace(/ё/g, "е").replace(/[^a-zа-я0-9]+/g, " ").trim();
}

/** Запись по названию: точное совпадение, иначе единственная, чьё название содержит искомое (или наоборот). */
function byName<T>(items: readonly T[], name: unknown, nameOf: (item: T) => string): T | undefined {
  if (typeof name !== "string" || !name.trim()) return undefined;
  const key = nameKey(name);
  if (!key) return undefined;
  const exact = items.find((item) => nameKey(nameOf(item)) === key);
  if (exact) return exact;
  const partial = items.filter((item) => {
    const k = nameKey(nameOf(item));
    return k.includes(key) || key.includes(k);
  });
  return partial.length === 1 ? partial[0] : undefined;
}

function accountByName(state: State, name: unknown): Account | undefined {
  return byName(activeAccounts(state), name, (a) => a.name);
}

/** Дата из ответа модели: пусто — сегодня; не дата или слишком далеко — null. */
function aiDate(value: unknown, today: IsoDate): IsoDate | null {
  if (value === undefined || value === null || value === "") return today;
  if (!isValidIsoDate(value)) return null;
  return value > addDays(today, 366) || value < addDays(today, -366 * 3) ? null : value;
}

const rawAmount = z.union([z.number(), z.string()]).transform((v, ctx) => {
  const n = typeof v === "number" ? v : Number(v.replace(/\s/g, "").replace(",", "."));
  const k = rublesToKopecks(n);
  if (!Number.isFinite(n) || k <= 0 || k > MAX_KOPECKS) {
    ctx.addIssue({ code: "custom", message: "bad amount" });
    return z.NEVER;
  }
  return k;
});
const rawType = z.preprocess(
  (v) => (typeof v === "string" ? v.toLowerCase() : v),
  z.enum(["income", "expense", "flexibleexpense", "fixedexpense", "recurringexpense"]),
);
/** Обрезанная строка без пробелов по краям (trim после slice — как её сохранит схема). */
function clip(v: unknown, max: number): string {
  return typeof v === "string" ? v.trim().slice(0, max).trim() : "";
}
const rawText = (max: number) => z.preprocess((v) => clip(v, max), z.string());
/** Категория от модели; служебные имена («constructor» и т. п.) считаем пустыми — сработает категория по умолчанию. */
const rawCategory = z.preprocess((v) => {
  const name = clip(v, LIMITS.category);
  return isReservedKey(name) ? "" : name;
}, z.string());

const rawOperation = z.object({
  type: rawType,
  amount: rawAmount,
  category: rawCategory,
  title: rawText(LIMITS.title),
  date: z.unknown().optional(),
  mandatory: z.boolean().optional(),
  account: z.unknown().optional(),
});
const rawTemplate = z.object({
  type: rawType,
  amount: rawAmount,
  category: rawCategory,
  title: rawText(LIMITS.title),
  dayOfMonth: z.coerce.number().int().min(1).max(31),
  account: z.unknown().optional(),
  to: z.unknown().optional(),
});
const rawTransfer = z.object({ from: z.unknown(), to: z.unknown(), amount: rawAmount, date: z.unknown().optional() });
const rawTemplateUpdate = z.object({
  title: z.unknown(),
  amount: rawAmount.optional(),
  dayOfMonth: z.coerce.number().int().min(1).max(31).optional(),
  active: z.boolean().optional(),
  account: z.unknown().optional(),
  to: z.unknown().optional(),
});
const rawBalance = z.object({
  account: z.unknown(),
  amount: z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === "number" ? v : Number(v.replace(/\s/g, "").replace(",", "."));
    const k = rublesToKopecks(n);
    if (!Number.isFinite(n) || Math.abs(k) > MAX_KOPECKS) {
      ctx.addIssue({ code: "custom", message: "bad amount" });
      return z.NEVER;
    }
    return k;
  }),
});
const rawGoalMove = z.object({
  goal: z.unknown(),
  amount: z.union([z.number(), z.string()]).transform((v, ctx) => {
    const n = typeof v === "number" ? v : Number(v.replace(/\s/g, "").replace(",", "."));
    const k = rublesToKopecks(n);
    if (!Number.isFinite(n) || k === 0 || Math.abs(k) > MAX_KOPECKS) {
      ctx.addIssue({ code: "custom", message: "bad amount" });
      return z.NEVER;
    }
    return k;
  }),
});
const rawLoanPayment = z.object({ loan: z.unknown(), amount: rawAmount, date: z.unknown().optional() });

/** «to» регулярного платежа: свой счёт или кредит (мой долг) по названию; null/"" — обычный платёж. */
function templateTarget(state: State, value: unknown): { toAccountId?: string; loanId?: string } | null | "none" {
  if (value === null || value === "" || (typeof value === "string" && /^(null|нет|обычный)/i.test(value.trim()))) return "none";
  if (value === undefined) return null;
  const account = accountByName(state, value);
  if (account) return { toAccountId: account.id };
  const loan = byName(state.loans.filter((l) => l.kind !== "lend"), value, (l) => l.name);
  return loan ? { loanId: loan.id } : null;
}

const CMD_MARKER = /AI_CMDS\s*:\s*/;

/** Извлекает JSON-объект после маркера, учитывая вложенные скобки и строки. */
function extractJsonObject(text: string, start: number): { json: string; end: number } | null {
  const open = text.indexOf("{", start);
  if (open < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return { json: text.slice(open, i + 1), end: i + 1 };
    }
  }
  return null;
}

/**
 * Отделяет текст ответа от служебной строки AI_CMDS и превращает команды в проверенное предложение.
 * Невалидные элементы отбрасываются (их число возвращается в skipped).
 */
export function parseAiReply(
  reply: string,
  state: State,
  today: IsoDate,
): { text: string; proposal: AiProposal | null; skipped: number } {
  const marker = CMD_MARKER.exec(reply);
  if (!marker) return { text: reply.trim(), proposal: null, skipped: 0 };

  const extracted = extractJsonObject(reply, marker.index + marker[0].length);
  const before = reply.slice(0, marker.index);
  const after = extracted ? reply.slice(extracted.end) : "";
  const text = `${before}${after}`.replace(/```(json)?\s*```/g, "").trim();
  if (!extracted) return { text, proposal: null, skipped: 1 };

  let data: unknown;
  try {
    data = JSON.parse(extracted.json);
  } catch {
    return { text, proposal: null, skipped: 1 };
  }
  if (typeof data !== "object" || data === null) return { text, proposal: null, skipped: 1 };
  const obj = data as Record<string, unknown>;

  const proposal: AiProposal = emptyProposal();
  let skipped = 0;
  const maxDate = addDays(today, 366);
  const minDate = addDays(today, -366 * 3);

  for (const item of Array.isArray(obj.operations) ? obj.operations.slice(0, 50) : []) {
    const parsed = rawOperation.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const op = parsed.data;
    const type = op.type === "income" ? "income" : "expense";
    const dateMissing = op.date === undefined || op.date === null || op.date === "";
    const date = dateMissing ? today : isValidIsoDate(op.date) ? op.date : null;
    if (!date || date > maxDate || date < minDate) {
      skipped++;
      continue;
    }
    const category = op.category || (type === "income" ? "Доход" : "Другое");
    const mandatory =
      type === "expense" &&
      (op.mandatory ?? (op.type === "fixedexpense" || op.type === "recurringexpense" || state.categories.mandatory.includes(category)));
    const account = op.account === undefined ? undefined : accountByName(state, op.account);
    if (op.account !== undefined && op.account !== null && op.account !== "" && !account) {
      skipped++;
      continue;
    }
    proposal.operations.push({ type, amount: op.amount, category, title: op.title, date, mandatory, ...(account ? { accountId: account.id } : {}) });
  }

  const templates = Array.isArray(obj.templates) ? obj.templates : Array.isArray(obj.presets) ? obj.presets : [];
  for (const item of templates.slice(0, 20)) {
    const parsed = rawTemplate.safeParse(item);
    if (!parsed.success) {
      skipped++;
      continue;
    }
    const t = parsed.data;
    const type = t.type === "income" ? "income" : "expense";
    const category = t.category || (type === "income" ? "Доход" : "Обязательные");
    const account = t.account === undefined || t.account === null || t.account === "" ? undefined : accountByName(state, t.account);
    const target = type === "expense" ? templateTarget(state, t.to) : null;
    if ((t.account && !account) || (t.to !== undefined && t.to !== null && t.to !== "" && target === null)) {
      skipped++;
      continue;
    }
    proposal.templates.push({
      type,
      amount: t.amount,
      category,
      title: t.title || category,
      dayOfMonth: t.dayOfMonth,
      ...(account ? { accountId: account.id } : {}),
      ...(target && target !== "none" ? target : {}),
    });
  }

  if (typeof obj.categoryLimits === "object" && obj.categoryLimits !== null && !Array.isArray(obj.categoryLimits)) {
    for (const [name, value] of Object.entries(obj.categoryLimits as Record<string, unknown>).slice(0, 50)) {
      const category = clip(name, LIMITS.category);
      const amount = rawAmount.safeParse(value);
      if (!category || isReservedKey(category) || !amount.success) {
        skipped++;
        continue;
      }
      proposal.limits.push({ category, amount: amount.data });
    }
  }

  for (const item of Array.isArray(obj.transfers) ? obj.transfers.slice(0, 20) : []) {
    const parsed = rawTransfer.safeParse(item);
    const from = parsed.success ? accountByName(state, parsed.data.from) : undefined;
    const to = parsed.success ? accountByName(state, parsed.data.to) : undefined;
    const date = parsed.success ? aiDate(parsed.data.date, today) : null;
    if (!parsed.success || !from || !to || from.id === to.id || !date) {
      skipped++;
      continue;
    }
    proposal.transfers.push({ from: from.id, to: to.id, amount: parsed.data.amount, date });
  }

  for (const item of Array.isArray(obj.templateUpdates) ? obj.templateUpdates.slice(0, 20) : []) {
    const parsed = rawTemplateUpdate.safeParse(item);
    const template = parsed.success ? byName(state.templates, parsed.data.title, (t) => t.title) : undefined;
    if (!parsed.success || !template) {
      skipped++;
      continue;
    }
    const u = parsed.data;
    const account = u.account === undefined ? undefined : accountByName(state, u.account);
    const target = template.kind === "expense" ? templateTarget(state, u.to) : null;
    if ((u.account !== undefined && !account) || (u.to !== undefined && target === null)) {
      skipped++;
      continue;
    }
    const update: AiTemplateUpdate = {
      templateId: template.id,
      ...(u.amount !== undefined ? { amount: u.amount } : {}),
      ...(u.dayOfMonth !== undefined ? { dayOfMonth: u.dayOfMonth } : {}),
      ...(u.active !== undefined ? { active: u.active } : {}),
      ...(account ? { accountId: account.id } : {}),
      ...(target === "none" ? { toAccountId: null, loanId: null } : target ? { toAccountId: target.toAccountId ?? null, loanId: target.loanId ?? null } : {}),
    };
    if (Object.keys(update).length > 1) proposal.templateUpdates.push(update);
    else skipped++;
  }

  for (const item of Array.isArray(obj.balances) ? obj.balances.slice(0, 20) : []) {
    const parsed = rawBalance.safeParse(item);
    const account = parsed.success ? accountByName(state, parsed.data.account) : undefined;
    if (!parsed.success || !account) {
      skipped++;
      continue;
    }
    // У кредитки модель называет долг — остаток счёта со знаком минус.
    const actual = account.kind === "credit" ? -Math.abs(parsed.data.amount) : parsed.data.amount;
    proposal.balances.push({ accountId: account.id, actual });
  }

  for (const item of Array.isArray(obj.goals) ? obj.goals.slice(0, 20) : []) {
    const parsed = rawGoalMove.safeParse(item);
    const goal = parsed.success ? byName(state.goals, parsed.data.goal, (g) => g.name) : undefined;
    if (!parsed.success || !goal) {
      skipped++;
      continue;
    }
    proposal.goals.push({ goalId: goal.id, amount: parsed.data.amount });
  }

  for (const item of Array.isArray(obj.loanPayments) ? obj.loanPayments.slice(0, 20) : []) {
    const parsed = rawLoanPayment.safeParse(item);
    const loan = parsed.success ? byName(state.loans, parsed.data.loan, (l) => l.name) : undefined;
    const date = parsed.success ? aiDate(parsed.data.date, today) : null;
    if (!parsed.success || !loan || !date) {
      skipped++;
      continue;
    }
    proposal.loanPayments.push({ loanId: loan.id, amount: parsed.data.amount, date });
  }

  return { text, proposal: proposalSize(proposal) ? proposal : null, skipped };
}

/** Превращает подтверждённое предложение в действия. ids — генератор идентификаторов. */
export function proposalToActions(proposal: AiProposal, state: State, today: IsoDate, newId: () => string): Action[] {
  const actions: Action[] = [];
  for (const op of proposal.operations) {
    const tx = { type: op.type, amount: op.amount, category: op.category };
    actions.push({
      type: "tx.add",
      tx: {
        id: newId(),
        type: op.type,
        amount: op.amount,
        date: op.date,
        category: op.category,
        title: op.title,
        note: "Добавлено AI-помощником",
        mandatory: op.mandatory,
        autoSaving: autoSavingByDefault(tx, state.settings),
        ...(op.accountId ? { accountId: op.accountId } : {}),
      },
    });
  }
  for (const t of proposal.templates) {
    // Начинаем со следующего наступления дня (не сегодня), чтобы не начислить задним числом.
    const startDate =
      parseIsoDate(today).day < t.dayOfMonth ? addDays(today, 1) : firstDayOfMonth(addMonths(monthKeyOf(today), 1));
    actions.push({
      type: "template.add",
      template: {
        id: newId(),
        kind: t.type,
        title: t.title,
        category: t.category,
        amount: t.amount,
        dayOfMonth: t.dayOfMonth,
        active: true,
        startDate,
        note: "",
        ...(t.accountId && t.accountId !== MAIN_ACCOUNT_ID ? { accountId: t.accountId } : {}),
        ...(t.toAccountId ? { toAccountId: t.toAccountId } : {}),
        ...(t.loanId ? { loanId: t.loanId } : {}),
      },
    });
  }
  for (const limit of proposal.limits) {
    actions.push({ type: "category.setLimit", name: limit.category, amount: limit.amount });
  }
  for (const t of proposal.transfers) {
    // Как в окне перевода: на накопительный — пополнение сбережений, с него — снятие, иначе — перевод.
    const from = findAccount(state, t.from);
    const to = findAccount(state, t.to);
    if (!from || !to) continue;
    const note = "Добавлено AI-помощником";
    if (to.kind === "savings" && from.kind !== "savings") {
      actions.push({ type: "savings.move", id: newId(), date: t.date, amount: t.amount, note, accountId: from.id, toAccountId: to.id });
    } else if (from.kind === "savings" && to.kind !== "savings") {
      actions.push({ type: "savings.move", id: newId(), date: t.date, amount: -t.amount, note, accountId: to.id, toAccountId: from.id });
    } else {
      actions.push({ type: "transfer.add", id: newId(), date: t.date, from: from.id, to: to.id, amount: t.amount, note });
    }
  }
  for (const u of proposal.templateUpdates) {
    const template = state.templates.find((t) => t.id === u.templateId);
    if (!template) continue;
    if (u.active !== undefined && u.active !== template.active) {
      actions.push({ type: "template.setActive", id: template.id, active: u.active, today });
    }
    const patch = {
      ...(u.amount !== undefined ? { amount: u.amount } : {}),
      ...(u.dayOfMonth !== undefined ? { dayOfMonth: u.dayOfMonth } : {}),
      ...(u.accountId !== undefined ? { accountId: u.accountId === MAIN_ACCOUNT_ID ? null : u.accountId } : {}),
      ...(u.toAccountId !== undefined ? { toAccountId: u.toAccountId } : {}),
      ...(u.loanId !== undefined ? { loanId: u.loanId } : {}),
    };
    if (Object.keys(patch).length) actions.push({ type: "template.update", id: template.id, patch });
  }
  for (const b of proposal.balances) {
    actions.push({ type: "balance.set", id: newId(), date: today, actual: b.actual, accountId: b.accountId });
  }
  for (const g of proposal.goals) {
    actions.push({ type: "savings.move", id: newId(), date: today, amount: g.amount, note: "Добавлено AI-помощником", goalId: g.goalId });
  }
  for (const p of proposal.loanPayments) {
    actions.push({ type: "loan.payment", id: newId(), loanId: p.loanId, amount: p.amount, date: p.date, note: "Добавлено AI-помощником" });
  }
  return actions;
}

// ---------- модель на телефоне ----------

/** Просьба что-то добавить или изменить: только тогда принимаем предложения модели на телефоне. */
const CHANGE_REQUEST =
  /(добав|запиш|запис|внес|внеси|занес|потратил|купил|заплатил|оплатил|получил|пришл|перевел|перевёл|перевед|перевод|отлож|лимит|регулярн|каждый месяц|ежемесячн|постав|измени|поменя|пауз|приостанов|возобнов|сверь|остаток|на счет|на счёт|погас|пополн|сним|цел|долг|кредит)/i;

/**
 * Страховка для небольшой модели Apple на телефоне: она бывает непоследовательна — придумывает операции
 * в ответ на обычный вопрос и путает категории. Предложение принимаем, только если пользователь просил
 * что-то добавить; категорию операций подбираем тем же способом, что для СМС (история и подсказки магазинов),
 * а категорию модели оставляем, только если подсказать нечего и такая категория у пользователя есть.
 */
export function refineLocalProposal(proposal: AiProposal | null, question: string, state: State): AiProposal | null {
  if (!proposal || !CHANGE_REQUEST.test(question)) return null;
  const known = (name: string) =>
    [...state.categories.income, ...state.categories.mandatory, ...state.categories.flexible].find(
      (c) => c.toLocaleLowerCase("ru") === name.toLocaleLowerCase("ru"),
    );
  const operations = proposal.operations.map((op) => {
    const fallback = known(op.category) ?? (op.type === "income" ? "Прочие доходы" : "Другое");
    const suggested = suggestCategory(state, op.type, op.title || op.category, { fallback });
    return { ...op, category: suggested.category, mandatory: op.type === "expense" && suggested.mandatory };
  });
  return { ...proposal, operations };
}
