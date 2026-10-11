import { describe, expect, it } from "vitest";
import { DomainError, IMPORT_NOT_EMPTY_MESSAGE, actionSchema, applyAction } from "./actions";
import { monthRange } from "./dates";
import { defaultSettings } from "./defaults";
import { formatMoney } from "./money";
import { balanceAt, goalSaved, loanRemaining, monthMetrics, safeToSpend, savingsTotal } from "./metrics";
import { MAX_BACKFILL_MONTHS, dueOccurrences, isSkipped, plannedOccurrences } from "./recurring";
import { categoryNameSchema, idSchema, stateSchema, transactionSchema, type State } from "./schema";
import { addTx, run, stateWith, template, tx } from "./test-utils";

const salary = () => template({ id: "salary", kind: "income", amount: 10_000_000, dayOfMonth: 10, startDate: "2026-01-01" });
const rent = () =>
  template({ id: "rent", kind: "expense", amount: 4_000_000, dayOfMonth: 5, startDate: "2026-01-01", category: "Аренда" });

function noSavings() {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  return s;
}

describe("шаблоны и начисления", () => {
  it("начисляет с даты начала по сегодня и идемпотентно", () => {
    const s0 = { ...noSavings(), templates: [salary(), rent()] };
    const s1 = run(s0, { type: "recurring.sync", today: "2026-03-07" });
    const dates = s1.transactions.map((t) => `${t.templateId}:${t.date}`).sort();
    expect(dates).toEqual([
      "rent:2026-01-05",
      "rent:2026-02-05",
      "rent:2026-03-05",
      "salary:2026-01-10",
      "salary:2026-02-10",
    ]);
    const s2 = run(s1, { type: "recurring.sync", today: "2026-03-07" });
    expect(s2.transactions).toHaveLength(5);
    expect(stateSchema.safeParse(s2).success).toBe(true);
  });

  it("не начисляет до даты начала", () => {
    const s0 = { ...noSavings(), templates: [template({ kind: "income", amount: 100, dayOfMonth: 10, startDate: "2026-03-11" })] };
    expect(run(s0, { type: "recurring.sync", today: "2026-03-31" }).transactions).toHaveLength(0);
    expect(run(s0, { type: "recurring.sync", today: "2026-04-10" }).transactions).toHaveLength(1);
  });

  it("удалённое начисление не возвращается, а отмена удаления возвращает его", () => {
    const s1 = run({ ...noSavings(), templates: [rent()] }, { type: "recurring.sync", today: "2026-01-31" });
    const occurrence = s1.transactions[0];
    const s2 = run(s1, { type: "tx.delete", id: occurrence.id }, { type: "recurring.sync", today: "2026-01-31" });
    expect(s2.transactions).toHaveLength(0);
    expect(s2.skipped.rent).toEqual(["2026-01"]);
    const s3 = run(s2, {
      type: "tx.restore",
      transactions: [occurrence],
      unskip: { templateId: "rent", month: "2026-01" },
    });
    expect(s3.transactions).toHaveLength(1);
    expect(s3.skipped.rent).toBeUndefined();
  });

  it("смена дня в шаблоне и перенос даты операции не создают дублей", () => {
    const s1 = run({ ...noSavings(), templates: [rent()] }, { type: "recurring.sync", today: "2026-02-20" });
    expect(s1.transactions).toHaveLength(2);
    const s2 = run(
      s1,
      { type: "template.update", id: "rent", patch: { dayOfMonth: 15 } },
      { type: "tx.update", id: s1.transactions[1].id, patch: { date: "2026-03-02" } },
      { type: "recurring.sync", today: "2026-02-20" },
    );
    expect(s2.transactions).toHaveLength(2);
  });

  it("пауза и возобновление не начисляют пропущенные месяцы", () => {
    const s1 = run(
      { ...noSavings(), templates: [rent()] },
      { type: "recurring.sync", today: "2026-01-31" },
      { type: "template.setActive", id: "rent", active: false, today: "2026-01-31" },
      { type: "recurring.sync", today: "2026-04-01" },
      { type: "template.setActive", id: "rent", active: true, today: "2026-04-01" },
      { type: "recurring.sync", today: "2026-05-10" },
    );
    // Февраль и март (пауза) не начислены; апрель — уже после возобновления 1 апреля.
    expect(s1.transactions.map((t) => t.date)).toEqual(["2026-01-05", "2026-04-05", "2026-05-05"]);
  });

  it("удаление шаблона сохраняет историю", () => {
    const s1 = run({ ...noSavings(), templates: [rent()] }, { type: "recurring.sync", today: "2026-02-20" });
    const s2 = run(s1, { type: "template.delete", id: "rent" }, { type: "recurring.sync", today: "2026-06-01" });
    expect(s2.templates).toHaveLength(0);
    expect(s2.transactions).toHaveLength(2);
  });

  it("«повторять ежемесячно» создаёт шаблон, а операция считается начислением этого месяца", () => {
    const s1 = run(
      noSavings(),
      addTx({ type: "expense", amount: 59_900, date: "2026-03-12", category: "Подписки", title: "Музыка", repeat: { templateId: "music", startDate: "2026-03-12" } }),
      { type: "recurring.sync", today: "2026-04-20" },
    );
    expect(s1.templates).toHaveLength(1);
    expect(s1.templates[0]).toMatchObject({ dayOfMonth: 12, startDate: "2026-03-12", kind: "expense" });
    expect(s1.transactions.map((t) => t.date)).toEqual(["2026-03-12", "2026-04-12"]);
    expect(s1.transactions.every((t) => t.mandatory)).toBe(true);
  });

  it("с зарплаты по шаблону откладывается процент", () => {
    const s1 = run(stateWith({ templates: [salary()] }), { type: "recurring.sync", today: "2026-01-10" });
    expect(s1.transactions).toHaveLength(2);
    const saving = s1.transactions.find((t) => t.type === "saving");
    expect(saving).toMatchObject({ amount: 1_500_000, linkedTo: "salary.2026-01", date: "2026-01-10" });
  });
});

describe("автоотчисления с покупок", () => {
  it("5% с потолком 1000 ₽ плюс округление до 50 ₽, пересчёт при правке и удаление вместе с покупкой", () => {
    const s1 = run(stateWith(), addTx({ id: "p", type: "expense", amount: 30_888, date: "2026-03-01", autoSaving: true }));
    const linked = () => s1.transactions.find((t) => t.linkedTo === "p");
    // 308,88 ₽: 5% = 15 ₽, округление до 350 ₽ = 41,12 ₽
    expect(linked()?.amount).toBe(1_500 + 4_112);

    const s2 = run(s1, { type: "tx.update", id: "p", patch: { amount: 5_000_000 } });
    expect(s2.transactions.find((t) => t.linkedTo === "p")?.amount).toBe(100_000);

    const s3 = run(s2, { type: "tx.update", id: "p", patch: { category: "Коммуналка", mandatory: true } });
    expect(s3.transactions.find((t) => t.linkedTo === "p")).toBeUndefined();

    const s4 = run(s1, { type: "tx.delete", id: "p" });
    expect(s4.transactions).toHaveLength(0);
  });

  it("удаление самого отчисления отключает его у покупки", () => {
    const s1 = run(stateWith(), addTx({ id: "p", type: "expense", amount: 100_000, date: "2026-03-01", autoSaving: true }));
    const s2 = run(s1, { type: "tx.delete", id: "p.s" }, { type: "tx.update", id: "p", patch: { amount: 200_000 } });
    expect(s2.transactions).toHaveLength(1);
    expect(s2.transactions[0].autoSaving).toBe(false);
  });

  it("без флага отчисления нет", () => {
    const s1 = run(stateWith(), addTx({ type: "expense", amount: 100_000, date: "2026-03-01", autoSaving: false }));
    expect(s1.transactions).toHaveLength(1);
  });
});

describe("операции, баланс, сбережения", () => {
  it("новая категория добавляется автоматически", () => {
    const s1 = run(stateWith(), addTx({ type: "expense", amount: 100, date: "2026-03-01", category: "Хобби" }));
    expect(s1.categories.flexible).toContain("Хобби");
  });

  it("корректировка баланса выставляет точный остаток", () => {
    const s0 = stateWith({ transactions: [tx({ type: "income", amount: 1_000_000, date: "2026-03-01" })] });
    const s1 = run(s0, { type: "balance.set", id: "adj", date: "2026-03-05", actual: 950_050 });
    expect(balanceAt(s1, "2026-03-05")).toBe(950_050);
    expect(s1.transactions.find((t) => t.id === "adj")?.amount).toBe(-49_950);
    expect(run(s1, { type: "balance.set", id: "adj2", date: "2026-03-05", actual: 950_050 }).transactions).toHaveLength(2);
  });

  it("нельзя снять из сбережений больше, чем накоплено", () => {
    const s1 = run(stateWith(), { type: "savings.move", id: "d", date: "2026-03-01", amount: 500_000, note: "" });
    expect(savingsTotal(s1)).toBe(500_000);
    expect(() => run(s1, { type: "savings.move", id: "w", date: "2026-03-02", amount: -600_000, note: "" })).toThrow(
      DomainError,
    );
    expect(savingsTotal(run(s1, { type: "savings.move", id: "w", date: "2026-03-02", amount: -500_000, note: "" }))).toBe(0);
  });

  it("цели: прогресс считается по операциям, удаление цели оставляет деньги в сбережениях", () => {
    const goal = { id: "g", name: "Отпуск", targetAmount: 10_000_000, initialAmount: 100_000, dueDate: null, note: "", createdAt: "2026-03-01" };
    const s1 = run(
      stateWith(),
      { type: "goal.add", goal },
      { type: "savings.move", id: "c1", date: "2026-03-02", amount: 300_000, note: "", goalId: "g" },
    );
    expect(goalSaved(s1, s1.goals[0])).toBe(400_000);
    expect(() =>
      run(s1, { type: "savings.move", id: "w", date: "2026-03-03", amount: -500_000, note: "", goalId: "g" }),
    ).toThrow(DomainError);
    const s2 = run(s1, { type: "goal.delete", id: "g" });
    expect(s2.goals).toHaveLength(0);
    expect(savingsTotal(s2)).toBe(300_000);
    expect(s2.transactions[0].goalId).toBeUndefined();
  });

  it("долги: платёж уменьшает остаток, переплатить нельзя, удаление платежа возвращает остаток", () => {
    const loan = { id: "l", kind: "credit" as const, name: "Банк", amount: 5_000_000, initialPaid: 1_000_000, dueDate: null, note: "", createdAt: "2026-03-01" };
    const s1 = run(stateWith(), { type: "loan.add", loan }, { type: "loan.payment", id: "p1", loanId: "l", amount: 1_500_000, date: "2026-03-05", note: "" });
    expect(loanRemaining(s1, s1.loans[0])).toBe(2_500_000);
    expect(s1.transactions[0]).toMatchObject({ type: "expense", mandatory: true, loanId: "l" });
    expect(() => run(s1, { type: "loan.payment", id: "p2", loanId: "l", amount: 2_500_001, date: "2026-03-06", note: "" })).toThrow(DomainError);
    expect(loanRemaining(run(s1, { type: "tx.delete", id: "p1" }), s1.loans[0])).toBe(4_000_000);

    const lend = { ...loan, id: "lend", kind: "lend" as const, initialPaid: 0 };
    const s2 = run(stateWith(), { type: "loan.add", loan: lend }, { type: "loan.payment", id: "r", loanId: "lend", amount: 100, date: "2026-03-05", note: "" });
    expect(s2.transactions[0].type).toBe("income");
  });

  it("дубликат категории — ошибка, удаление категории не трогает операции", () => {
    const s1 = stateWith();
    expect(() => applyAction(s1, { type: "category.add", group: "flexible", name: "продукты" })).toThrow(DomainError);
    const s2 = run(s1, addTx({ type: "expense", amount: 100, date: "2026-03-01", category: "Продукты" }), {
      type: "category.remove",
      group: "flexible",
      name: "Продукты",
    });
    expect(s2.categories.flexible).not.toContain("Продукты");
    expect(s2.transactions).toHaveLength(1);
  });

  it("лимиты по категориям: установка и снятие", () => {
    const s1 = run(stateWith(), { type: "category.setLimit", name: "Продукты", amount: 2_000_000 });
    expect(s1.categoryLimits).toEqual({ Продукты: 2_000_000 });
    expect(run(s1, { type: "category.setLimit", name: "продукты", amount: null }).categoryLimits).toEqual({});
  });

  it("сбережения и корректировки нельзя редактировать", () => {
    const s1 = run(stateWith(), { type: "savings.move", id: "d", date: "2026-03-01", amount: 500, note: "" });
    expect(() => applyAction(s1, { type: "tx.update", id: "d", patch: { amount: 100 } })).toThrow(DomainError);
  });

  it("повторный id операции отклоняется", () => {
    const s1 = run(stateWith(), addTx({ id: "x", type: "income", amount: 100, date: "2026-03-01" }));
    expect(() => applyAction(s1, addTx({ id: "x", type: "income", amount: 100, date: "2026-03-01" }))).toThrow(DomainError);
  });
});

describe("перенос остатка месяца", () => {
  it("откладывает остаток гибкого бюджета прошлого месяца", () => {
    const s0 = noSavings();
    s0.settings.savingsRatePercent = 10;
    const s1 = run(
      s0,
      addTx({ type: "income", amount: 10_000_000, date: "2026-02-01" }),
      addTx({ type: "expense", amount: 2_000_000, date: "2026-02-10" }),
      { type: "rollover.resolve", month: "2026-02", decision: "saved", id: "r", date: "2026-03-01" },
    );
    // 100 000 − 10% − 20 000 = 70 000
    expect(s1.transactions.find((t) => t.id === "r")?.amount).toBe(7_000_000);
    expect(s1.rollover["2026-02"]).toBe("saved");
    expect(() =>
      applyAction(s1, { type: "rollover.resolve", month: "2026-03", decision: "saved", id: "r2", date: "2026-03-05" }),
    ).toThrow(DomainError);
  });
});

describe("валидация действий", () => {
  it("отклоняет некорректные даты, суммы и лишние поля", () => {
    expect(actionSchema.safeParse(addTx({ type: "expense", amount: 100, date: "2026-02-30" })).success).toBe(false);
    expect(actionSchema.safeParse(addTx({ type: "expense", amount: -100, date: "2026-02-03" })).success).toBe(false);
    expect(actionSchema.safeParse(addTx({ type: "expense", amount: 1.5, date: "2026-02-03" })).success).toBe(false);
    expect(actionSchema.safeParse({ type: "tx.update", id: "a", patch: { linkedTo: "x" } }).success).toBe(false);
    expect(actionSchema.safeParse({ type: "unknown" }).success).toBe(false);
  });
});

describe("написание категорий", () => {
  it("новая операция, шаблон и лимит используют существующее написание категории", () => {
    const s1 = run(
      stateWith(),
      addTx({ type: "expense", amount: 100, date: "2026-03-01", category: "продукты " }),
      { type: "category.setLimit", name: "ПРОДУКТЫ", amount: 5_000 },
      { type: "template.add", template: template({ kind: "expense", amount: 100, dayOfMonth: 1, category: "аренда" }) },
    );
    expect(s1.transactions[0].category).toBe("Продукты");
    expect(s1.categoryLimits).toEqual({ Продукты: 5_000 });
    expect(s1.templates[0].category).toBe("Аренда");
    expect(s1.categories.flexible.filter((c) => c.toLowerCase() === "продукты")).toHaveLength(1);
  });
});

describe("исправления после ревью", () => {
  it("«повторять» для операции задним числом не создаёт платежи за прошедшие месяцы", () => {
    const s0 = stateWith();
    s0.settings.salarySaving.enabled = false;
    const s1 = run(
      s0,
      addTx({ type: "expense", amount: 100, date: "2026-05-15", category: "Аренда", mandatory: true, repeat: { templateId: "r", startDate: "2026-10-09" } }),
      { type: "recurring.sync", today: "2026-10-20" },
    );
    expect(s1.transactions.map((t) => t.date)).toEqual(["2026-05-15", "2026-10-15"]);
  });

  it("долг с движением денег меняет остаток, но не бюджет", () => {
    const loan = { id: "l", kind: "borrow" as const, name: "Саша", amount: 500_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-03-01" };
    const s1 = run(stateWith(), { type: "loan.add", loan, cashFlow: { id: "cf", date: "2026-03-01" } });
    expect(balanceAt(s1, "2026-03-01")).toBe(500_000);
    expect(loanRemaining(s1, s1.loans[0])).toBe(500_000);
    expect(s1.transactions[0].type).toBe("adjustment");
  });

  it("с цели нельзя снять накопленное до приложения", () => {
    const goal = { id: "g", name: "Отпуск", targetAmount: 10_000_000, initialAmount: 300_000, dueDate: null, note: "", createdAt: "2026-03-01" };
    const s1 = run(stateWith(), { type: "goal.add", goal }, { type: "savings.move", id: "d", date: "2026-03-02", amount: 100_000, note: "", goalId: "g" });
    expect(() => applyAction(s1, { type: "savings.move", id: "w", date: "2026-03-03", amount: -150_000, note: "", goalId: "g" })).toThrow(DomainError);
    expect(savingsTotal(run(s1, { type: "savings.move", id: "w", date: "2026-03-03", amount: -100_000, note: "", goalId: "g" }))).toBe(0);
  });
});

describe("ревью домена: начисления (H1)", () => {
  it("не начисляет месяцы старше MAX_BACKFILL_MONTHS от сегодня", () => {
    const s0 = { ...noSavings(), templates: [rent()].map((t) => ({ ...t, startDate: "2020-01-01" })) };
    const s1 = run(s0, { type: "recurring.sync", today: "2026-10-09" });
    const months = s1.transactions.map((t) => t.occurrenceMonth);
    expect(MAX_BACKFILL_MONTHS).toBe(24);
    expect(months).toHaveLength(25);
    expect(months[0]).toBe("2024-10");
    expect(months.at(-1)).toBe("2026-10");
    // Повторная синхронизация ничего не меняет и возвращает тот же объект.
    expect(run(s1, { type: "recurring.sync", today: "2026-10-09" })).toBe(s1);
  });

  it("500 шаблонов с 1970 года и полностью пропущенными месяцами синхронизируются быстро", () => {
    const s: State = noSavings();
    const allMonths = monthRange("1970-01", "2026-10");
    for (let i = 0; i < 500; i++) {
      s.templates.push(template({ id: `t${i}`, kind: "expense", amount: 100, dayOfMonth: 1, startDate: "1970-01-01" }));
      s.skipped[`t${i}`] = allMonths.slice(-1200);
    }
    const started = performance.now();
    for (let d = 1; d <= 20; d++) {
      const today = `2026-10-${String(d).padStart(2, "0")}`;
      expect(applyAction(s, { type: "recurring.sync", today })).toBe(s);
      expect(plannedOccurrences(s, today, "2026-12-31")).toHaveLength(1_000); // ноябрь и декабрь
    }
    // До исправления одна синхронизация занимала ~400 мс (20 — около 8 с).
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it("учитывает пропуски и уже начисленное в окне", () => {
    const s0 = { ...noSavings(), templates: [rent()], skipped: { rent: ["2026-02"] } };
    expect(dueOccurrences(s0, "2026-03-31").map((o) => o.month)).toEqual(["2026-01", "2026-03"]);
    const s1 = run(s0, { type: "recurring.sync", today: "2026-03-31" });
    expect(dueOccurrences(s1, "2026-03-31")).toEqual([]);
    expect(plannedOccurrences(s1, "2026-03-31", "2026-05-31").map((o) => o.month)).toEqual(["2026-04", "2026-05"]);
  });
});

describe("ревью домена: перенос остатка (H3)", () => {
  it("отложенный остаток прошлого месяца не урезает гибкий бюджет текущего", () => {
    const s = run(
      noSavings(),
      addTx({ type: "income", amount: 10_000_000, date: "2026-09-05", category: "Зарплата" }),
      addTx({ type: "expense", amount: 5_000_000, date: "2026-09-10" }),
      addTx({ type: "income", amount: 10_000_000, date: "2026-10-05", category: "Зарплата" }),
    );
    const today = "2026-10-09";
    const before = monthMetrics(s, "2026-10", today);
    const s2 = run(s, { type: "rollover.resolve", month: "2026-09", decision: "saved", id: "roll", date: today });
    const after = monthMetrics(s2, "2026-10", today);
    const saving = s2.transactions.find((t) => t.id === "roll");
    expect(saving).toMatchObject({ type: "saving", rolloverOf: "2026-09", amount: 3_500_000 });
    expect(after.flexible.left).toBe(before.flexible.left);
    expect(after.flexible.extraSavings).toBe(0);
    expect(after.savings.fact).toBe(before.savings.fact);
    expect(safeToSpend(s2, today).budgetPerDay).toBe(safeToSpend(s, today).budgetPerDay);
    // Деньги при этом ушли со счёта в сбережения.
    expect(savingsTotal(s2)).toBe(savingsTotal(s) + 3_500_000);
    expect(balanceAt(s2, today)).toBe(balanceAt(s, today) - 3_500_000);
    expect(stateSchema.safeParse(s2).success).toBe(true);
  });
});

describe("ревью домена: правка операции и автоотчисление (M5)", () => {
  function withPurchase() {
    const s1 = run(stateWith(), addTx({ id: "p", type: "expense", amount: 123_400, date: "2026-03-10", autoSaving: true }));
    const off = { ...defaultSettings(), purchaseSaving: { ...defaultSettings().purchaseSaving, enabled: false } };
    return run(s1, { type: "settings.update", settings: off });
  }
  const linked = (s: State) => s.transactions.find((t) => t.linkedTo === "p");

  it("правка заметки и названия не пересчитывает старое отчисление по новым настройкам", () => {
    const s0 = withPurchase();
    const amount = linked(s0)?.amount;
    expect(amount).toBeGreaterThan(0);
    const s1 = run(s0, { type: "tx.update", id: "p", patch: { note: "чек потерял", title: "Ашан" } });
    expect(linked(s1)).toMatchObject({ amount, title: "Отложено с покупки «Ашан»" });
  });

  it("перенос даты переносит отчисление и сохраняет его сумму", () => {
    const s0 = withPurchase();
    const amount = linked(s0)?.amount;
    const s1 = run(s0, { type: "tx.update", id: "p", patch: { date: "2026-03-15" } });
    expect(linked(s1)).toMatchObject({ amount, date: "2026-03-15" });
  });

  it("смена суммы, категории или флага пересчитывает отчисление", () => {
    const s0 = withPurchase();
    expect(linked(run(s0, { type: "tx.update", id: "p", patch: { amount: 200_000 } }))).toBeUndefined();
    const s1 = run(stateWith(), addTx({ id: "p", type: "expense", amount: 100_000, date: "2026-03-10", autoSaving: true }));
    expect(linked(run(s1, { type: "tx.update", id: "p", patch: { autoSaving: false } }))).toBeUndefined();
    expect(linked(run(s1, { type: "tx.update", id: "p", patch: { category: "Аренда" } }))).toBeUndefined();
  });

  it("посторонняя операция с id отчисления не удаляется", () => {
    const s0 = run(stateWith(), { type: "savings.move", id: "p.s", date: "2026-03-01", amount: 500, note: "" });
    expect(() => applyAction(s0, addTx({ id: "p", type: "expense", amount: 100_000, date: "2026-03-10", autoSaving: true }))).toThrow(
      DomainError,
    );
    const s1 = run(s0, addTx({ id: "p", type: "expense", amount: 100_000, date: "2026-03-10", autoSaving: false }));
    expect(run(s1, { type: "tx.update", id: "p", patch: { note: "x" } }).transactions.map((t) => t.id)).toEqual(["p.s", "p"]);
    expect(run(s1, { type: "tx.delete", id: "p" }).transactions.map((t) => t.id)).toEqual(["p.s"]);
  });

  it("удаление начисления не упирается в лимит пропусков", () => {
    const s0 = { ...noSavings(), templates: [rent()] };
    s0.skipped = { rent: [...monthRange("1970-01", "2025-12"), ...monthRange("2026-02", "2070-01")] };
    expect(s0.skipped.rent).toHaveLength(1200);
    const s1 = run(s0, { type: "recurring.sync", today: "2026-01-31" });
    const s2 = run(s1, { type: "tx.delete", id: "rent.2026-01" });
    expect(s2.skipped.rent).toHaveLength(1200);
    expect(s2.skipped.rent).toContain("2026-01");
    expect(s2.skipped.rent[0]).toBe("1970-02"); // самый старый пропуск забыт
    expect(stateSchema.safeParse(s2).success).toBe(true);
  });
});

describe("ревью домена: служебные ключи (L4)", () => {
  it("схемы отклоняют __proto__, constructor и prototype как id и категории", () => {
    for (const name of ["__proto__", "constructor", "prototype"]) {
      expect(idSchema.safeParse(name).success).toBe(false);
      expect(categoryNameSchema.safeParse(name).success).toBe(false);
      expect(categoryNameSchema.safeParse(` ${name} `).success).toBe(false);
    }
    expect(actionSchema.safeParse({ type: "occurrence.unskip", templateId: "__proto__", month: "2026-10" }).success).toBe(false);
    expect(idSchema.safeParse("proto").success).toBe(true);
  });

  it("редьюсер и метрики не падают и не меняют прототипы на служебных ключах", () => {
    const s0 = noSavings();
    s0.templates = [template({ id: "constructor", kind: "expense", amount: 100, dayOfMonth: 1, startDate: "2026-10-01" })];
    expect(() => safeToSpend(s0, "2026-10-09")).not.toThrow();
    expect(isSkipped(s0, "toString", "2026-10")).toBe(false);
    const s1 = run(s0, { type: "occurrence.unskip", templateId: "__proto__", month: "2026-10" });
    expect(s1).toBe(s0);
    const s2 = run(s0, { type: "occurrence.skip", templateId: "constructor", month: "2026-10" });
    expect(Object.keys(s2.skipped)).toEqual(["constructor"]);
    expect(run(s2, { type: "recurring.sync", today: "2026-10-09" }).transactions).toHaveLength(0);
    const s3 = run(s0, { type: "category.setLimit", name: "__proto__", amount: 100 });
    expect(Object.getPrototypeOf(s3.categoryLimits)).toBe(Object.prototype);
    expect(Object.hasOwn(s3.categoryLimits, "__proto__")).toBe(true);
    const s4 = run(s3, { type: "category.setLimit", name: "__proto__", amount: null });
    expect(s4.categoryLimits).toEqual({});
  });
});

describe("ревью домена: уникальность id (L5, L6)", () => {
  it("схема состояния отклоняет повторяющиеся id", () => {
    const t = tx({ type: "income", amount: 100, date: "2026-03-01" });
    expect(stateSchema.safeParse(stateWith({ transactions: [t, { ...t }] })).success).toBe(false);
    const tpl = template({ kind: "income", amount: 100, dayOfMonth: 1 });
    expect(stateSchema.safeParse(stateWith({ templates: [tpl, { ...tpl, title: "Другой" }] })).success).toBe(false);
    expect(stateSchema.safeParse(stateWith({ transactions: [t], templates: [tpl] })).success).toBe(true);
  });

  it("начисление по шаблонам с одинаковым id не создаёт операции с одинаковым id", () => {
    const s0 = noSavings();
    s0.templates = [
      template({ id: "dup", kind: "income", amount: 100_000, dayOfMonth: 1, startDate: "2026-10-01" }),
      template({ id: "dup", kind: "expense", amount: 50_000, dayOfMonth: 2, startDate: "2026-10-01" }),
    ];
    const ids = run(s0, { type: "recurring.sync", today: "2026-10-09" }).transactions.map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("нельзя восстановить начисление, если за тот же месяц уже есть другое (L6)", () => {
    let s = run(
      noSavings(),
      addTx({ id: "x1", type: "expense", amount: 3_000_000, date: "2026-10-05", category: "Аренда", mandatory: true, repeat: { templateId: "T2", startDate: "2026-10-09" } }),
    );
    const deleted = s.transactions.find((t) => t.id === "x1");
    if (!deleted) throw new Error("нет операции");
    s = run(
      s,
      { type: "tx.delete", id: "x1" },
      { type: "occurrence.unskip", templateId: "T2", month: "2026-10" },
      { type: "template.update", id: "T2", patch: { startDate: "2026-10-01" } },
      { type: "recurring.sync", today: "2026-10-09" },
    );
    expect(s.transactions.map((t) => t.id)).toEqual(["T2.2026-10"]);
    expect(() =>
      applyAction(s, { type: "tx.restore", transactions: [deleted], unskip: { templateId: "T2", month: "2026-10" } }),
    ).toThrow(DomainError);
  });

  it("повтор внутри tx.restore и повторная отмена не создают дублей", () => {
    const t = tx({ id: "r", type: "expense", amount: 100, date: "2026-03-01" });
    const s1 = run(stateWith(), { type: "tx.restore", transactions: [t, { ...t }] });
    expect(s1.transactions).toHaveLength(1);
    expect(run(s1, { type: "tx.restore", transactions: [t] }).transactions).toHaveLength(1);
  });
});

describe("ревью домена: названия, собранные редьюсером (L8)", () => {
  it("обрезанное название не заканчивается пробелом и совпадает с тем, что пропускает схема", () => {
    // «Погашение: » — 11 символов, 69-й символ имени попадает на 80-ю позицию.
    const name = `${"А".repeat(68)} ${"Б".repeat(10)}`;
    const loan = { id: "l", kind: "credit" as const, name, amount: 5_000_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-03-01" };
    const goal = { id: "g", name, targetAmount: 100, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-03-01" };
    const s = run(
      stateWith(),
      { type: "loan.add", loan, cashFlow: { id: "cf", date: "2026-03-01" } },
      { type: "loan.payment", id: "p1", loanId: "l", amount: 100, date: "2026-03-05", note: "" },
      { type: "goal.add", goal },
      { type: "savings.move", id: "m", date: "2026-03-06", amount: 100, note: "", goalId: "g" },
    );
    for (const t of s.transactions) expect(t.title).toBe(t.title.trim());
    const parsed = stateSchema.parse(s);
    expect(parsed.transactions).toEqual(s.transactions);
  });
});

describe("долг с движением денег: правка", () => {
  it("корректировка остатка следует за суммой и направлением", () => {
    const loan = { id: "l", kind: "borrow" as const, name: "Саша", amount: 500_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-03-01" };
    const s1 = run(
      stateWith(),
      { type: "loan.add", loan, cashFlow: { id: "cf", date: "2026-03-01" } },
      { type: "loan.update", id: "l", patch: { kind: "lend", amount: 300_000 } },
    );
    expect(s1.transactions[0]).toMatchObject({ type: "adjustment", amount: -300_000 });
    expect(balanceAt(s1, "2026-03-01")).toBe(-300_000);
  });
});

describe("ревью 2: снятие сбережений с целей (M4)", () => {
  const goal = { id: "g", name: "Отпуск", targetAmount: 10_000_000, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-03-01" };
  const move = (id: string, amount: number, goalId?: string) =>
    ({ type: "savings.move", id, date: "2026-03-05", amount, note: "", ...(goalId ? { goalId } : {}) }) as const;

  it("деньги цели нельзя снять дважды: сначала из общих сбережений, потом с цели", () => {
    const s1 = run(stateWith(), { type: "goal.add", goal }, move("in", 300_000, "g"));
    expect(() => applyAction(s1, move("w1", -300_000))).toThrow(
      `Нельзя снять больше, чем свободно на счёте «Сбережения» (${formatMoney(0)}): остальное отложено на цели — их деньги снимайте на вкладке «Цели».`,
    );
    const s2 = run(s1, move("w2", -300_000, "g"));
    expect(savingsTotal(s2)).toBe(0);
    expect(goalSaved(s2, s2.goals[0])).toBe(0);
  });

  it("с цели — не больше, чем всего в сбережениях", () => {
    // Старые данные: общие сбережения уже сняты, а на цели деньги числятся.
    const s1 = stateWith({
      goals: [goal],
      transactions: [
        tx({ id: "in", type: "saving", amount: 300_000, date: "2026-03-01", goalId: "g", category: "Сбережения" }),
        tx({ id: "out", type: "saving", amount: -200_000, date: "2026-03-02", category: "Сбережения" }),
      ],
    });
    expect(() => applyAction(s1, move("w", -300_000, "g"))).toThrow(DomainError);
    expect(savingsTotal(run(s1, move("w", -100_000, "g")))).toBe(0);
  });

  it("свободные сбережения снимаются, отложенное на цели — нет; накопленное до приложения не мешает", () => {
    const withInitial = { ...goal, initialAmount: 1_000_000 };
    const s1 = run(stateWith(), { type: "goal.add", goal: withInitial }, move("free", 500_000), move("in", 200_000, "g"));
    expect(savingsTotal(run(s1, move("w", -500_000)))).toBe(200_000);
    expect(() => applyAction(s1, move("w", -500_001))).toThrow(DomainError);
    // После удаления цели её деньги снова свободные.
    expect(savingsTotal(run(s1, { type: "goal.delete", id: "g" }, move("w", -700_000)))).toBe(0);
  });
});

describe("ревью 2: долг через счёт (M5)", () => {
  const loan = (kind: "borrow" | "lend" | "credit") =>
    ({ id: "l", kind, name: "Саша", amount: 500_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-03-01" }) as const;
  const pay = (id: string, amount: number) =>
    ({ type: "loan.payment", id, loanId: "l", amount, date: "2026-03-10", note: "" }) as const;

  it("занял через счёт и вернул — ни доход, ни расход бюджета; остаток долга уменьшается", () => {
    const s0 = noSavings();
    const s1 = run(s0, { type: "loan.add", loan: loan("borrow"), cashFlow: { id: "cf", date: "2026-03-01" } }, pay("p1", 200_000));
    expect(s1.transactions[0]).toMatchObject({ id: "cf", type: "adjustment", amount: 500_000, loanOpening: true });
    expect(s1.transactions[1]).toMatchObject({ id: "p1", type: "adjustment", amount: -200_000, title: "Погашение: Саша", loanId: "l" });
    expect(s1.transactions[1].loanOpening).toBeUndefined();
    expect(loanRemaining(s1, s1.loans[0])).toBe(300_000);
    expect(balanceAt(s1, "2026-03-31")).toBe(300_000);
    const m = monthMetrics(s1, "2026-03", "2026-03-31");
    expect(m.income.fact).toBe(0);
    expect(m.mandatory.fact).toBe(0);
    expect(stateSchema.safeParse(s1).success).toBe(true);
    // Переплатить нельзя и здесь.
    expect(() => applyAction(s1, pay("p2", 300_001))).toThrow(DomainError);
  });

  it("дал в долг через счёт — возврат корректировкой со знаком плюс", () => {
    const s1 = run(stateWith(), { type: "loan.add", loan: loan("lend"), cashFlow: { id: "cf", date: "2026-03-01" } }, pay("r", 100_000));
    expect(s1.transactions[1]).toMatchObject({ type: "adjustment", amount: 100_000, title: "Возврат: Саша" });
    expect(loanRemaining(s1, s1.loans[0])).toBe(400_000);
    expect(balanceAt(s1, "2026-03-31")).toBe(-400_000);
  });

  it("правка долга меняет только корректировку открытия, не платежи", () => {
    const s1 = run(
      stateWith(),
      { type: "loan.add", loan: loan("credit"), cashFlow: { id: "cf", date: "2026-03-01" } },
      pay("p1", 100_000),
      { type: "loan.update", id: "l", patch: { amount: 800_000, name: "Банк" } },
    );
    expect(s1.transactions.find((t) => t.id === "cf")).toMatchObject({ amount: 800_000, title: "Получено в долг: Банк" });
    expect(s1.transactions.find((t) => t.id === "p1")).toMatchObject({ amount: -100_000, title: "Погашение: Саша" });
    expect(loanRemaining(s1, s1.loans[0])).toBe(700_000);
  });

  it("долг без движения денег — платёж по-прежнему расход или доход", () => {
    const s1 = run(stateWith(), { type: "loan.add", loan: loan("credit") }, pay("p1", 100_000));
    expect(s1.transactions[0]).toMatchObject({ type: "expense", mandatory: true, loanId: "l" });
  });

  it("долг, созданный до отметки loanOpening: корректировка открытия узнаётся, отмечается и не считается платежом", () => {
    const legacy = stateWith({
      loans: [loan("borrow")],
      transactions: [tx({ id: "cf", type: "adjustment", amount: 500_000, date: "2026-03-01", category: "Корректировка", loanId: "l" })],
    });
    expect(loanRemaining(legacy, legacy.loans[0])).toBe(500_000);
    const s1 = run(legacy, pay("p1", 200_000));
    expect(s1.transactions[0]).toMatchObject({ id: "cf", loanOpening: true });
    expect(s1.transactions[1]).toMatchObject({ type: "adjustment", amount: -200_000 });
    expect(loanRemaining(s1, s1.loans[0])).toBe(300_000);
    // Правка старого долга тоже отмечает и синхронизирует только открытие.
    const s2 = run(legacy, { type: "loan.update", id: "l", patch: { amount: 600_000 } });
    expect(s2.transactions[0]).toMatchObject({ amount: 600_000, loanOpening: true });
  });

  it("удаление долга снимает и привязку, и отметку открытия", () => {
    const s1 = run(stateWith(), { type: "loan.add", loan: loan("borrow"), cashFlow: { id: "cf", date: "2026-03-01" } }, { type: "loan.delete", id: "l" });
    expect(s1.transactions[0].loanId).toBeUndefined();
    expect(s1.transactions[0].loanOpening).toBeUndefined();
    expect(stateSchema.safeParse(s1).success).toBe(true);
  });

  it("схема: отметка открытия — только у корректировки с долгом", () => {
    const base = { id: "x", amount: 100, date: "2026-03-01", category: "", title: "", note: "", loanOpening: true };
    expect(transactionSchema.safeParse({ ...base, type: "adjustment", loanId: "l" }).success).toBe(true);
    expect(transactionSchema.safeParse({ ...base, type: "adjustment" }).success).toBe(false);
    expect(transactionSchema.safeParse({ ...base, type: "income", loanId: "l" }).success).toBe(false);
  });
});

describe("ревью 2: импорт только в пустой аккаунт", () => {
  const imported = () => run(stateWith(), addTx({ id: "guest", type: "income", amount: 100, date: "2026-03-01" }));

  it("ifEmpty заменяет пустое состояние и отклоняет непустое", () => {
    expect(run(stateWith(), { type: "state.import", state: imported(), ifEmpty: true })).toEqual(imported());
    // Настройки и профиль данными не считаются, но и не затираются: переносятся только данные гостя.
    const profile = { occupation: "Дизайнер", riskLevel: null, savingsStyle: null, notes: "" };
    const configured = stateWith({ profile, categoryLimits: { Продукты: 5_000 } });
    configured.settings.savingsRatePercent = 40;
    configured.categories.flexible = [...configured.categories.flexible, "Хобби"];
    const merged = run(configured, { type: "state.import", state: imported(), ifEmpty: true });
    expect(merged.transactions).toEqual(imported().transactions);
    expect(merged.profile).toEqual(profile);
    expect(merged.settings.savingsRatePercent).toBe(40);
    expect(merged.categoryLimits).toMatchObject({ Продукты: 5_000 });
    expect(merged.categories.flexible).toContain("Хобби");
    for (const partial of [
      { transactions: [tx({ type: "income", amount: 100, date: "2026-03-01" })] },
      { templates: [template({ kind: "income", amount: 100, dayOfMonth: 1 })] },
      { goals: [{ id: "g", name: "Цель", targetAmount: 100, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-03-01" }] },
      { loans: [{ id: "l", kind: "borrow" as const, name: "Долг", amount: 100, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-03-01" }] },
    ]) {
      expect(() => applyAction(stateWith(partial), { type: "state.import", state: imported(), ifEmpty: true })).toThrow(IMPORT_NOT_EMPTY_MESSAGE);
    }
    // Без флага — замена, как раньше.
    expect(run(stateWith(partialTx()), { type: "state.import", state: imported() })).toEqual(imported());
  });
});

function partialTx(): Partial<State> {
  return { transactions: [tx({ type: "income", amount: 100, date: "2026-03-01" })] };
}

describe("ревью 2: служебные имена в категории операции (L1)", () => {
  it("схема операции отклоняет служебные имена, пустая категория допустима", () => {
    const base = { id: "x", type: "adjustment", amount: 100, date: "2026-03-01", title: "", note: "" };
    for (const category of ["constructor", " __proto__ ", "toString"]) {
      expect(transactionSchema.safeParse({ ...base, category }).success).toBe(false);
    }
    expect(transactionSchema.safeParse({ ...base, category: "" }).success).toBe(true);
    expect(transactionSchema.safeParse({ ...base, category: "Продукты" }).success).toBe(true);
    expect(
      actionSchema.safeParse({ type: "tx.restore", transactions: [{ ...base, category: "constructor" }] }).success,
    ).toBe(false);
  });
});

describe("история нормы сбережений", () => {
  it("смена нормы действует с указанного месяца и не пересчитывает прошлые", () => {
    const s0 = stateWith();
    s0.settings.salarySaving.enabled = false;
    s0.settings.purchaseSaving.enabled = false;
    const s1 = run(
      s0,
      addTx({ type: "income", amount: 10_000_000, date: "2026-09-05" }),
      addTx({ type: "income", amount: 10_000_000, date: "2026-10-05" }),
      { type: "settings.update", settings: { ...s0.settings, savingsRatePercent: 20 }, effectiveFrom: "2026-10" },
    );
    expect(monthMetrics(s1, "2026-09", "2026-10-10").savings.target).toBe(1_500_000);
    expect(monthMetrics(s1, "2026-10", "2026-10-10").savings.target).toBe(2_000_000);
    expect(s1.settings.savingsRateHistory).toEqual([
      { from: "1970-01", percent: 15 },
      { from: "2026-10", percent: 20 },
    ]);
    // Повторная смена в том же месяце заменяет запись, а не копит их.
    const s2 = run(s1, { type: "settings.update", settings: { ...s1.settings, savingsRatePercent: 10 }, effectiveFrom: "2026-10" });
    expect(s2.settings.savingsRateHistory).toEqual([
      { from: "1970-01", percent: 15 },
      { from: "2026-10", percent: 10 },
    ]);
    expect(monthMetrics(s2, "2026-09", "2026-10-10").savings.target).toBe(1_500_000);
  });

  it("история, присланная клиентом, игнорируется", () => {
    const s0 = stateWith();
    const s1 = run(s0, {
      type: "settings.update",
      settings: { ...s0.settings, savingsRateHistory: [{ from: "2000-01", percent: 90 }] },
      effectiveFrom: "2026-10",
    });
    expect(s1.settings.savingsRateHistory).toBeUndefined();
  });
});
