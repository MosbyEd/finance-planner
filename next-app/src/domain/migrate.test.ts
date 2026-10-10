import { describe, expect, it } from "vitest";
import { applyAction } from "./actions";
import { goalSaved, loanRemaining, pendingRollover } from "./metrics";
import { MigrationError, migrateState } from "./migrate";
import { emptyState } from "./defaults";

const legacy = {
  months: {
    "2026-03": {
      transactions: [
        { id: "a1", type: "income", category: "Зарплата", title: "Аванс", amount: 75000, date: "2026-03-10", presetId: "inc1", note: "" },
        { id: "a2", type: "recurringExpense", category: "Подписки", title: "Музыка", amount: 299.9, date: "2026-03-05", presetId: "exp1" },
        { id: "a3", type: "flexibleExpense", category: "Продукты", title: "", amount: 1540.5, date: "2026-03-06", isTransfer: true },
        { id: "a4", type: "fixedExpense", category: "Техника", title: "Ноутбук", amount: 90000, date: "2026-03-07" },
        { id: "a5", type: "savingTransfer", category: "Сбережения", title: "", amount: 15.440000000000055, date: "2026-03-06" },
        { id: "a6", type: "savingTransfer", category: "Цели", title: "", amount: 5000, date: "2026-03-08", goalId: "g1" },
        { id: "a7", type: "balanceAdjustment", category: "", title: "", amount: -120, date: "2026-03-09" },
        { id: "bad1", type: "flexibleExpense", category: "Кафе", amount: 100, date: "2026-02-30" },
        { id: "bad2", type: "flexibleExpense", category: "Кафе", amount: "abc", date: "2026-03-02" },
        { id: "bad3", type: "mystery", category: "Кафе", amount: 1, date: "2026-03-02" },
      ],
    },
    "2025-11": { transactions: [{ id: "b1", type: "income", category: "Премия", amount: 1000, date: "2025-11-01" }] },
  },
  categories: { income: ["Зарплата", "Аванс", "Зарплата "], fixedExpense: ["Аренда"], flexibleExpense: ["Продукты"] },
  incomePresets: [{ id: "inc1", title: "Аванс", category: "Зарплата", amount: 75000, dayOfMonth: 10, active: true }],
  fixedExpensePresets: [
    { id: "exp1", title: "Музыка", category: "Подписки", amount: 299.9, dayOfMonth: 5, active: true, startMonthKey: "2026-02" },
    { id: "exp2", title: "Пустой", category: "Подписки", amount: 0, dayOfMonth: 5, active: true },
  ],
  loans: [{ id: "l1", kind: "credit", name: "Банк", amount: 50000, balance: 30000, dueDate: "2026-05-08", note: "", createdAt: "2026-03-06T10:35:33.916Z" }],
  goals: [{ id: "g1", name: "Питер", category: "Путешествия", targetAmount: 100000, currentAmount: 7000, dueDate: "2026-06-01", note: "" }],
  ui: {
    skippedRecurring: { "2026-03": { inc1: { "2026-03-25": true } } },
    monthRolloverHandled: { "2026-03": true },
    aiDailyRecommendations: {},
  },
  categoryLimits: { Продукты: 20000 },
  userProfile: { occupation: "Дизайнер", riskLevel: "low", savingsStyle: "weird", notes: "Двое детей" },
  _exportMeta: { exportedAt: "2026-03-10" },
};

describe("перенос старых данных", () => {
  const { state, report } = migrateState(legacy, "2026-03-20");

  it("переводит рубли в копейки и типы операций", () => {
    const byId = Object.fromEntries(state.transactions.map((t) => [t.id, t]));
    expect(byId.a1).toMatchObject({ type: "income", amount: 7_500_000, templateId: "inc1", occurrenceMonth: "2026-03" });
    expect(byId.a2).toMatchObject({ type: "expense", mandatory: true, amount: 29_990, templateId: "exp1" });
    expect(byId.a3).toMatchObject({ type: "expense", mandatory: false, amount: 154_050, autoSaving: false });
    expect(byId.a4).toMatchObject({ type: "expense", mandatory: true });
    expect(byId.a5).toMatchObject({ type: "saving", amount: 1_544 });
    expect(byId.a7).toMatchObject({ type: "adjustment", amount: -12_000 });
    expect(report.transactions).toBe(8);
    expect(report.dropped).toHaveLength(4); // 3 операции и шаблон без суммы
  });

  it("шаблоны начинают действовать с текущего месяца и не дублируют уже начисленное", () => {
    expect(state.templates.map((t) => [t.id, t.startDate])).toEqual([
      ["inc1", "2026-03-01"],
      ["exp1", "2026-03-01"],
    ]);
    const synced = applyAction(state, { type: "recurring.sync", today: "2026-03-20" });
    expect(synced.transactions).toHaveLength(state.transactions.length);
  });

  it("переносит пропуски, цели, долги, лимиты и профиль", () => {
    expect(state.skipped).toEqual({ inc1: ["2026-03"] });
    // Флаг стоит на марте (месяц, когда решали), а относится к остатку февраля.
    expect(state.rollover).toEqual({ "2026-02": "dismissed" });
    expect(goalSaved(state, state.goals[0])).toBe(700_000);
    expect(state.goals[0].initialAmount).toBe(200_000);
    expect(loanRemaining(state, state.loans[0])).toBe(3_000_000);
    expect(state.loans[0].createdAt).toBe("2026-03-06");
    expect(state.categoryLimits).toEqual({ Продукты: 2_000_000 });
    expect(state.profile).toEqual({ occupation: "Дизайнер", riskLevel: "low", savingsStyle: null, notes: "Двое детей" });
    expect(state.categories.income).toEqual(["Зарплата", "Аванс"]);
  });

  it("текущий формат проверяется и возвращается как есть", () => {
    const again = migrateState(state, "2026-03-20");
    expect(again.state).toEqual(state);
    expect(again.report.source).toBe("v3");
  });

  it("отклоняет мусор", () => {
    expect(() => migrateState({ foo: 1 }, "2026-03-20")).toThrow(MigrationError);
    expect(() => migrateState({ ...emptyState(), transactions: [{ id: "x" }] }, "2026-03-20")).toThrow(MigrationError);
    expect(() => migrateState(null, "2026-03-20")).toThrow(MigrationError);
  });
});

describe("исправления переноса после ревью", () => {
  it("флаг остатка текущего месяца закрывает остаток прошлого (M2)", () => {
    const raw = {
      months: {
        "2026-09": {
          transactions: [
            { id: "a1", type: "income", category: "Зарплата", amount: 100000, date: "2026-09-05" },
            { id: "a2", type: "flexibleExpense", category: "Продукты", amount: 20000, date: "2026-09-06" },
          ],
        },
      },
      ui: { monthRolloverHandled: { "2026-10": true } },
    };
    const { state } = migrateState(raw, "2026-10-09");
    expect(state.rollover).toEqual({ "2026-09": "dismissed" });
    expect(pendingRollover(state, "2026-10-09")).toBeNull();
  });

  it("служебные ключи (__proto__, constructor, toString) отбрасываются и не меняют прототипы (L4)", () => {
    const raw = JSON.parse(`{
      "months": { "2026-03": { "transactions": [
        { "id": "t1", "type": "fixedExpense", "category": "Аренда", "amount": 100, "date": "2026-03-05", "presetId": "__proto__" }
      ] } },
      "categories": { "income": ["Зарплата", "constructor"] },
      "fixedExpensePresets": [
        { "id": "constructor", "title": "Аренда", "category": "toString", "amount": 100, "dayOfMonth": 5 }
      ],
      "ui": { "skippedRecurring": { "2026-03": { "__proto__": { "2026-03-05": true }, "toString": { "2026-03-05": true }, "rent": { "2026-03-05": true } } } },
      "categoryLimits": { "__proto__": 100, "constructor": 200, "Продукты": 300 }
    }`);
    const { state } = migrateState(raw, "2026-03-20");
    expect(Object.getPrototypeOf(state.skipped)).toBe(Object.prototype);
    expect(state.skipped).toEqual({ rent: ["2026-03"] });
    expect(state.categoryLimits).toEqual({ Продукты: 30_000 });
    expect(state.categories.income).toEqual(["Зарплата"]);
    expect(state.templates[0].id).not.toBe("constructor");
    expect(state.templates[0].category).toBe("Обязательные");
    expect(state.transactions[0].templateId).toBeUndefined();
    expect(() => applyAction(state, { type: "recurring.sync", today: "2026-03-20" })).not.toThrow();
  });

  it("повторяющиеся id шаблонов, целей и долгов отбрасываются с отчётом (L5)", () => {
    const raw = {
      months: {},
      incomePresets: [{ id: "p", title: "Зарплата", category: "Зарплата", amount: 100, dayOfMonth: 5 }],
      fixedExpensePresets: [{ id: "p", title: "Аренда", category: "Аренда", amount: 50, dayOfMonth: 6 }],
      goals: [
        { id: "g", name: "Отпуск", targetAmount: 100 },
        { id: "g", name: "Машина", targetAmount: 200 },
      ],
      loans: [
        { id: "l", name: "Банк", amount: 100 },
        { id: "l", name: "Саша", amount: 200 },
      ],
    };
    const { state, report } = migrateState(raw, "2026-03-20");
    expect(state.templates.map((t) => t.title)).toEqual(["Зарплата"]);
    expect(state.goals.map((g) => g.name)).toEqual(["Отпуск"]);
    expect(state.loans.map((l) => l.name)).toEqual(["Банк"]);
    expect(report.dropped).toHaveLength(3);
    expect(report.dropped.every((d) => d.startsWith("дубликат"))).toBe(true);
  });

  it("файл текущего формата с повторяющимися id импортируется без дублей (L5)", () => {
    const s = emptyState();
    const goal = { id: "g", name: "Отпуск", targetAmount: 100, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-03-01" };
    const dup = { ...s, goals: [goal, { ...goal, name: "Другое" }] };
    const { state, report } = migrateState(dup, "2026-03-20");
    expect(state.goals).toHaveLength(1);
    expect(report.dropped).toEqual(["дубликат цели g"]);
  });
});

describe("ревью 2: служебные имена (L1, M2)", () => {
  it("старый формат: операция со служебной категорией переносится в «Другое»", () => {
    const raw = {
      months: {
        "2026-03": {
          transactions: [
            { id: "a1", type: "flexibleExpense", category: "constructor", amount: 100, date: "2026-03-05" },
            { id: "a2", type: "savingTransfer", category: "__proto__", amount: 50, date: "2026-03-06" },
          ],
        },
      },
    };
    const { state } = migrateState(raw, "2026-03-20");
    expect(state.transactions.map((t) => t.category)).toEqual(["Другое", "Другое"]);
  });

  it("текущий формат со служебными именами исправляется, ссылки на переименованные записи сохраняются", () => {
    const s = emptyState();
    const raw = JSON.parse(
      JSON.stringify({
        ...s,
        transactions: [
          { id: "constructor", type: "expense", amount: 100, date: "2026-03-05", category: "toString", title: "", note: "", mandatory: true, templateId: "valueOf", occurrenceMonth: "2026-03" },
          { id: "s", type: "saving", amount: 100, date: "2026-03-05", category: "Сбережения", title: "", note: "", goalId: "__proto__", linkedTo: "constructor" },
          { id: "s2", type: "saving", amount: 100, date: "2026-03-05", category: "Сбережения", title: "", note: "", goalId: "prototype" },
        ],
        templates: [{ id: "valueOf", kind: "expense", title: "Аренда", category: "constructor", amount: 100, dayOfMonth: 5, active: true, startDate: "2026-03-01", note: "" }],
        goals: [{ id: "__proto__", name: "Отпуск", targetAmount: 100, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-03-01" }],
        categories: { ...s.categories, flexible: ["Продукты", "hasOwnProperty"] },
        settings: { ...s.settings, purchaseSaving: { ...s.settings.purchaseSaving, excludedCategories: ["Аренда", "toString"] } },
      }).replace('"skipped":{}', '"skipped":{"valueOf":["2026-02"],"constructor":["2026-01"]}'),
    );
    const { state, report } = migrateState(raw, "2026-03-20");
    const [t, saving, orphan] = state.transactions;
    expect(t).toMatchObject({ id: "tx-1", category: "Другое", templateId: "tpl-1", occurrenceMonth: "2026-03" });
    expect(state.templates[0]).toMatchObject({ id: "tpl-1", category: "Другое" });
    expect(state.goals[0].id).toBe("goal-1");
    expect(saving).toMatchObject({ goalId: "goal-1", linkedTo: "tx-1" });
    expect(orphan.goalId).toBeUndefined();
    expect(state.skipped).toEqual({ "tpl-1": ["2026-02"] });
    expect(state.categories.flexible).toEqual(["Продукты"]);
    expect(state.settings.purchaseSaving.excludedCategories).toEqual(["Аренда"]);
    expect(report.dropped.length).toBeGreaterThan(0);
    // Повторное исправление тех же данных даёт те же id (данные читаются сервером много раз).
    expect(migrateState(raw, "2026-03-20").state).toEqual(state);
  });
});
