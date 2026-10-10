import type { Action } from "./actions";
import type { IsoDate } from "./dates";
import { formatDay } from "./dates";
import { safeToSpend } from "./metrics";
import { formatMoney, type Kopecks } from "./money";
import { autoSavingByDefault } from "./savings";
import { LIMITS, type State } from "./schema";
import { matchPlanned, suggestCategory, type SmsPlan } from "./sms";

/** Команды Siri и «Команд»: добавление операции голосом и ответ «сколько можно потратить сегодня». */

export interface QuickAddInput {
  type: "income" | "expense";
  amount: Kopecks;
  /** Магазин или на что потрачено — по нему подбирается категория. */
  title: string;
  /** Явная категория; без неё — как у прошлой операции с тем же названием или по подсказкам. */
  category?: string;
}

export function planQuickAdd(state: State, input: QuickAddInput, ctx: { id: string; date: IsoDate }): SmsPlan {
  const title = input.title.trim().slice(0, LIMITS.title).trim();
  const money = formatMoney(input.amount);
  const word = input.type === "income" ? "Доход" : "Расход";
  const suggested = suggestCategory(state, input.type, title, {
    fallback: input.type === "income" ? "Прочие доходы" : "Другое",
  });
  const category = input.category?.trim().slice(0, LIMITS.category).trim() || suggested.category;
  const note = "Добавлено через Siri";

  const op =
    input.type === "income"
      ? ({ kind: "income", via: "deposit", amount: input.amount, time: null, counterparty: title } as const)
      : ({ kind: "expense", via: "purchase", amount: input.amount, time: null, counterparty: title } as const);
  const planned = matchPlanned(state, op, ctx.date, category);
  if (planned) {
    const action: Action = {
      type: "occurrence.confirm",
      templateId: planned.templateId,
      month: planned.month,
      amount: input.amount,
      date: ctx.date,
      note,
      review: true,
    };
    return { actions: [action], summary: `${word} ${money} · ${planned.title} — регулярный, отмечен` };
  }

  const mandatory = input.category ? input.type === "expense" && state.categories.mandatory.includes(category) : suggested.mandatory;
  const action: Action = {
    type: "tx.add",
    tx: {
      id: ctx.id,
      type: input.type,
      amount: input.amount,
      date: ctx.date,
      category,
      title,
      note,
      mandatory,
      autoSaving: autoSavingByDefault({ type: input.type, amount: input.amount, category }, state.settings),
      review: true,
    },
  };
  return { actions: [action], summary: `${word} ${money}${title ? ` · ${title}` : ""} → ${category}` };
}

/** Фраза для Siri: сколько можно потратить сегодня. */
export function todayBudgetText(state: State, today: IsoDate): string {
  const s = safeToSpend(state, today);
  const parts: string[] = [];
  if (s.recommended <= 0) {
    parts.push("Сегодня свободных денег нет — только обязательные платежи.");
  } else if (s.leftToday <= 0) {
    parts.push(`Лимит на сегодня исчерпан: потрачено ${formatMoney(s.spentToday)} из ${formatMoney(s.recommended)}.`);
  } else if (s.spentToday > 0) {
    parts.push(`Сегодня можно потратить ещё ${formatMoney(s.leftToday)} из ${formatMoney(s.recommended)}.`);
  } else {
    parts.push(`Сегодня можно потратить ${formatMoney(s.recommended)}.`);
  }
  if (s.status === "gap" && s.gapDate) {
    parts.push(`${formatDay(s.gapDate, today)} по прогнозу не хватит на обязательные платежи.`);
  }
  return parts.join(" ").replace(/ /g, " ");
}
