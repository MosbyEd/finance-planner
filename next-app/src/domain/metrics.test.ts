import { describe, expect, it } from "vitest";
import {
  balanceAt,
  categoryBreakdown,
  goalsReserved,
  loanOpening,
  loanPaid,
  monthMetrics,
  pendingRollover,
  safeToSpend,
  upcomingEvents,
} from "./metrics";
import { applyActions } from "./actions";
import { emptyState } from "./defaults";
import { run, stateWith, template, tx } from "./test-utils";

function base() {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  return s;
}

describe("баланс", () => {
  it("доходы и корректировки плюс, расходы и сбережения минус, будущее не считается", () => {
    const s = stateWith({
      transactions: [
        tx({ type: "income", amount: 10_000, date: "2026-03-01" }),
        tx({ type: "expense", amount: 2_000, date: "2026-03-02" }),
        tx({ type: "saving", amount: 1_000, date: "2026-03-03" }),
        tx({ type: "adjustment", amount: -500, date: "2026-03-04" }),
        tx({ type: "expense", amount: 9_999, date: "2026-03-10" }),
      ],
    });
    expect(balanceAt(s, "2026-03-05")).toBe(6_500);
  });
});

describe("метрики месяца", () => {
  it("план включает будущие начисления шаблонов, сбережения не вычитаются дважды", () => {
    const s0 = stateWith({
      templates: [
        template({ kind: "income", amount: 10_000_000, dayOfMonth: 10, startDate: "2026-03-01" }),
        template({ kind: "expense", amount: 3_000_000, dayOfMonth: 20, startDate: "2026-03-01" }),
      ],
    });
    s0.settings.purchaseSaving.enabled = false;
    // Зарплата 10-го начислена, с неё отложено 15%; аренда 20-го ещё впереди.
    const s = run(s0, { type: "recurring.sync", today: "2026-03-15" });
    s.transactions.push(tx({ type: "expense", amount: 1_000_000, date: "2026-03-12" }));

    const m = monthMetrics(s, "2026-03", "2026-03-15");
    expect(m.income).toEqual({ fact: 10_000_000, plan: 10_000_000 });
    expect(m.mandatory).toEqual({ fact: 0, plan: 3_000_000 });
    expect(m.savings).toEqual({ fact: 1_500_000, target: 1_500_000, planned: 0 });
    expect(m.flexible.budget).toBe(5_500_000);
    expect(m.flexible.extraSavings).toBe(0);
    expect(m.flexible.left).toBe(4_500_000);
    // 31 день, сегодня 15-е → 17 дней; (55 000 − 10 000) / 17 = 2647,05 → 2647 ₽
    expect(m.daysLeft).toBe(17);
    expect(m.daily.availableToday).toBe(264_700);
  });

  it("пополнение цели сверх нормы уменьшает гибкий бюджет", () => {
    const s = base();
    s.transactions.push(
      tx({ type: "income", amount: 10_000_000, date: "2026-03-01" }),
      tx({ type: "saving", amount: 2_000_000, date: "2026-03-02", goalId: "trip" }),
    );
    const m = monthMetrics(s, "2026-03", "2026-03-15");
    expect(m.flexible.budget).toBe(8_500_000);
    expect(m.flexible.extraSavings).toBe(500_000);
    expect(m.flexible.left).toBe(8_000_000);
  });

  it("перевод уже имевшихся денег на накопительный — не «отложено» месяца и бюджет не урезает", () => {
    const s = base();
    s.transactions.push(
      tx({ type: "income", amount: 10_000_000, date: "2026-03-01" }),
      tx({ type: "saving", amount: 23_000_000, date: "2026-03-02" }),
      // Отчисление с зарплаты — отложено.
      tx({ type: "saving", amount: 1_500_000, date: "2026-03-01", linkedTo: "salary" }),
    );
    const m = monthMetrics(s, "2026-03", "2026-03-15");
    expect(m.savings.fact).toBe(1_500_000);
    expect(m.flexible.extraSavings).toBe(0);
  });

  it("прошлый месяц — всё факт, будущий — всё план", () => {
    const s = { ...base(), templates: [template({ kind: "income", amount: 500_000, dayOfMonth: 1, startDate: "2026-01-01" })] };
    const future = monthMetrics(s, "2026-05", "2026-03-15");
    expect(future.status).toBe("future");
    expect(future.income).toEqual({ fact: 0, plan: 500_000 });
    const past = monthMetrics(s, "2026-02", "2026-03-15");
    expect(past.status).toBe("past");
    expect(past.income.plan).toBe(0); // начисления не созданы — в прошлом плана нет
  });

  it("предупреждает о превышении лимита категории", () => {
    const s = base();
    s.categoryLimits = { Продукты: 100_000 };
    s.transactions.push(
      tx({ type: "income", amount: 10_000_000, date: "2026-03-01" }),
      tx({ type: "expense", amount: 150_000, date: "2026-03-02", category: "Продукты" }),
    );
    const m = monthMetrics(s, "2026-03", "2026-03-15");
    expect(m.warnings.some((w) => w.includes("Продукты"))).toBe(true);
    expect(categoryBreakdown(s, "2026-03-01", "2026-03-31", "flexible")[0]).toMatchObject({
      category: "Продукты",
      amount: 150_000,
      limit: 100_000,
    });
  });
});

describe("сколько можно потратить сегодня", () => {
  it("ограничивает лимит деньгами на счёте до ближайшего дохода", () => {
    const s = base();
    s.templates = [
      template({ kind: "income", amount: 10_000_000, dayOfMonth: 25, startDate: "2026-03-01" }),
      template({ kind: "expense", amount: 3_000_000, dayOfMonth: 20, startDate: "2026-03-01" }),
    ];
    // На счёте 40 000, до зарплаты 25-го — 10 дней, до неё аренда 30 000.
    s.transactions.push(tx({ type: "adjustment", amount: 4_000_000, date: "2026-03-01" }));
    const r = safeToSpend(s, "2026-03-15");
    expect(r.horizon).toMatchObject({ date: "2026-03-25", reason: "income" });
    expect(r.daysUntil).toBe(10);
    expect(r.plannedOut).toBe(3_000_000);
    expect(r.cashPerDay).toBe(100_000);
    expect(r.recommended).toBe(100_000);
    expect(r.status).toBe("tight");
  });

  it("находит кассовый разрыв", () => {
    const s = base();
    s.templates = [
      template({ kind: "income", amount: 10_000_000, dayOfMonth: 25, startDate: "2026-03-01" }),
      template({ kind: "expense", amount: 3_000_000, dayOfMonth: 20, startDate: "2026-03-01" }),
    ];
    s.transactions.push(tx({ type: "adjustment", amount: 1_000_000, date: "2026-03-01" }));
    const r = safeToSpend(s, "2026-03-15");
    expect(r.status).toBe("gap");
    expect(r.gapDate).toBe("2026-03-20");
    expect(r.recommended).toBe(0);
  });

  it("сегодняшние траты не уменьшают сегодняшнюю рекомендацию", () => {
    const s = base();
    s.transactions.push(
      tx({ type: "income", amount: 3_100_000, date: "2026-03-01" }),
      tx({ type: "expense", amount: 50_000, date: "2026-03-15" }),
    );
    s.settings.savingsRatePercent = 0;
    const r = safeToSpend(s, "2026-03-15");
    // 31 000 на 17 дней = 1823 ₽ по бюджету; по деньгам — до конца месяца те же 31 000 / 17
    expect(r.recommended).toBe(182_300);
    expect(r.spentToday).toBe(50_000);
    expect(r.leftToday).toBe(132_300);
    expect(r.status).toBe("ok");
  });
});

describe("ближайшие события", () => {
  it("прогноз остатка учитывает начисления и отчисления с зарплаты", () => {
    const s = stateWith({
      templates: [template({ kind: "income", amount: 10_000_000, dayOfMonth: 25, startDate: "2026-03-01" })],
      transactions: [tx({ type: "adjustment", amount: 100_000, date: "2026-03-01" })],
    });
    const events = upcomingEvents(s, "2026-03-15", "2026-03-31");
    expect(events.map((e) => [e.type, e.effect, e.balanceAfter])).toEqual([
      ["income", 10_000_000, 10_100_000],
      ["saving", -1_500_000, 8_600_000],
    ]);
  });
});

describe("остаток прошлого месяца", () => {
  it("предлагается один раз и не больше денег на счёте", () => {
    const s = base();
    s.settings.savingsRatePercent = 0;
    s.transactions.push(
      tx({ type: "income", amount: 1_000_000, date: "2026-02-01" }),
      tx({ type: "expense", amount: 200_000, date: "2026-02-02" }),
      tx({ type: "expense", amount: 500_000, date: "2026-03-01", mandatory: true }),
    );
    expect(pendingRollover(s, "2026-03-02")).toEqual({ month: "2026-02", amount: 300_000 });
    s.rollover["2026-02"] = "dismissed";
    expect(pendingRollover(s, "2026-03-02")).toBeNull();
  });
});

describe("ревью домена: лимит на день без доходов в этом месяце (M1)", () => {
  it("первая зарплата в следующем месяце — лимит по деньгам на счёте, статус no-income", () => {
    const s = applyActions(emptyState(), [
      { type: "balance.set", id: "b1", date: "2026-10-09", actual: 8_000_000 },
      {
        type: "template.add",
        template: { id: "sal", kind: "income", title: "Зарплата", category: "Зарплата", amount: 15_000_000, dayOfMonth: 5, active: true, startDate: "2026-10-09", note: "" },
      },
      {
        type: "template.add",
        template: { id: "rent", kind: "expense", title: "Аренда", category: "Аренда", amount: 4_000_000, dayOfMonth: 20, active: true, startDate: "2026-10-09", note: "" },
      },
    ]);
    const r = safeToSpend(s, "2026-10-09");
    expect(r.horizon).toMatchObject({ date: "2026-11-05", reason: "income" });
    expect(r.usesBudget).toBe(false);
    expect(r.cashPerDay).toBeGreaterThan(0);
    expect(r.recommended).toBe(r.cashPerDay);
    expect(r.status).toBe("no-income");
  });

  it("бюджет месяца исчерпан — рекомендация 0 и статус over, а не ok", () => {
    const s = base();
    s.transactions.push(
      tx({ type: "adjustment", amount: 5_000_000, date: "2026-03-01" }),
      tx({ type: "income", amount: 10_000_000, date: "2026-03-01" }),
      tx({ type: "expense", amount: 10_000_000, date: "2026-03-02", mandatory: true }),
    );
    const r = safeToSpend(s, "2026-03-15");
    expect(r.usesBudget).toBe(true);
    expect(r.budgetPerDay).toBeLessThanOrEqual(0);
    expect(r.cashPerDay).toBeGreaterThan(0);
    expect(r.recommended).toBe(0);
    expect(r.status).toBe("over");
  });
});

describe("ревью 2: долги и цели (M4, M5)", () => {
  const loan = { id: "l", kind: "borrow" as const, name: "Саша", amount: 500_000, initialPaid: 50_000, dueDate: null, note: "", createdAt: "2026-03-01" };
  const adj = (id: string, amount: number, extra: object = {}) =>
    tx({ id, type: "adjustment", amount, date: "2026-03-01", category: "Корректировка", loanId: "l", ...extra });

  it("loanPaid считает платежи-корректировки по модулю, но не корректировку открытия", () => {
    const s = stateWith({ loans: [loan], transactions: [adj("cf", 500_000, { loanOpening: true }), adj("p1", -100_000), adj("p2", -20_000)] });
    expect(loanOpening(s, loan)?.id).toBe("cf");
    expect(loanPaid(s, loan)).toBe(50_000 + 120_000);
  });

  it("без отметки открытием считается корректировка со знаком получения денег (старые данные)", () => {
    const s = stateWith({ loans: [loan], transactions: [adj("cf", 500_000)] });
    expect(loanOpening(s, loan)?.id).toBe("cf");
    expect(loanPaid(s, loan)).toBe(50_000);
  });

  it("goalsReserved — сумма отложенного в приложении по существующим целям", () => {
    const goal = (id: string) => ({ id, name: id, targetAmount: 100, initialAmount: 999, dueDate: null, note: "", createdAt: "2026-03-01" });
    const saving = (amount: number, goalId?: string) =>
      tx({ type: "saving", amount, date: "2026-03-01", category: "Сбережения", ...(goalId ? { goalId } : {}) });
    const s = stateWith({
      goals: [goal("a"), goal("b")],
      transactions: [saving(300, "a"), saving(-100, "a"), saving(-50, "b"), saving(1000), saving(70, "deleted")],
    });
    expect(goalsReserved(s)).toBe(200);
  });
});
