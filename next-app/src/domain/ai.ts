import { z } from "zod";
import type { Action } from "./actions";
import { addDays, addMonths, firstDayOfMonth, isValidIsoDate, lastDayOfMonth, monthKeyOf, parseIsoDate, type IsoDate } from "./dates";
import { MAX_KOPECKS, kopecksToRubles, rublesToKopecks, type Kopecks } from "./money";
import {
  balanceAt,
  categoryBreakdown,
  goalSaved,
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
import { LIMITS, type State } from "./schema";

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
    templates: (d.templates ? state.templates : []).map((t) => ({
      kind: t.kind,
      title: t.title,
      category: t.category,
      amount: rub(t.amount),
      dayOfMonth: t.dayOfMonth,
      active: t.active,
      next: nextOccurrence(state, t, today)?.date ?? null,
    })),
    goals: state.goals.map((g) => ({
      name: g.name,
      target: rub(g.targetAmount),
      saved: rub(goalSaved(state, g)),
      dueDate: g.dueDate,
    })),
    loans: state.loans.map((l) => ({
      kind: l.kind,
      direction: l.kind === "lend" ? "мне должны" : "я должен",
      name: l.name,
      amount: rub(l.amount),
      remaining: rub(loanRemaining(state, l)),
      dueDate: l.dueDate,
    })),
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
    "Если пользователь просит добавить операции, регулярные платежи или лимиты, в самом конце ответа добавь",
    "одну строку (пользователь подтвердит её перед применением):",
    'AI_CMDS: {"operations":[...],"templates":[...],"categoryLimits":{...}}',
    '- operations: {"type":"income"|"expense","amount":число,"category":строка,"title":строка,"date":"YYYY-MM-DD","mandatory":true|false}',
    '- templates (ежемесячные): {"type":"income"|"expense","amount":число,"category":строка,"title":строка,"dayOfMonth":1-31}',
    '- categoryLimits: {"Категория": лимит в рублях на месяц}',
    `Используй существующие категории. Дата по умолчанию — сегодня (${today}).`,
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
}

export interface AiTemplate {
  type: "income" | "expense";
  amount: Kopecks;
  category: string;
  title: string;
  dayOfMonth: number;
}

export interface AiProposal {
  operations: AiOperation[];
  templates: AiTemplate[];
  limits: { category: string; amount: Kopecks }[];
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
});
const rawTemplate = z.object({
  type: rawType,
  amount: rawAmount,
  category: rawCategory,
  title: rawText(LIMITS.title),
  dayOfMonth: z.coerce.number().int().min(1).max(31),
});

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

  const proposal: AiProposal = { operations: [], templates: [], limits: [] };
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
    proposal.operations.push({ type, amount: op.amount, category, title: op.title, date, mandatory });
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
    proposal.templates.push({ type, amount: t.amount, category, title: t.title || category, dayOfMonth: t.dayOfMonth });
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

  const empty = !proposal.operations.length && !proposal.templates.length && !proposal.limits.length;
  return { text, proposal: empty ? null : proposal, skipped };
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
      },
    });
  }
  for (const limit of proposal.limits) {
    actions.push({ type: "category.setLimit", name: limit.category, amount: limit.amount });
  }
  return actions;
}

// ---------- модель на телефоне ----------

/** Просьба что-то добавить или изменить: только тогда принимаем предложения модели на телефоне. */
const CHANGE_REQUEST =
  /(добав|запиш|запис|внес|внеси|занес|потратил|купил|заплатил|оплатил|получил|пришл|перевел|перевёл|отлож|лимит|регулярн|каждый месяц|ежемесячн|постав)/i;

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
