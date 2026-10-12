import { describe, expect, it } from "vitest";
import { budgetPeriod, safeToSpend } from "./metrics";
import type { State } from "./schema";
import { run, stateWith, template } from "./test-utils";

/** Зарплата 10-го, аванс 25-го, аренда 1-го, связь 20-го; норма сбережений 10%. */
function withPay(): State {
  const s = stateWith();
  s.settings.savingsRatePercent = 10;
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  s.templates = [
    template({ id: "salary", kind: "income", amount: 10_000_000, dayOfMonth: 10, startDate: "2026-09-01" }),
    template({ id: "advance", kind: "income", title: "Аванс", category: "Аванс", amount: 5_000_000, dayOfMonth: 25, startDate: "2026-09-01" }),
    template({ id: "rent", kind: "expense", amount: 3_000_000, dayOfMonth: 1, startDate: "2026-09-01" }),
    template({ id: "phone", kind: "expense", title: "Связь", category: "Связь и интернет", amount: 100_000, dayOfMonth: 20, startDate: "2026-09-01" }),
  ];
  return run(s, { type: "balance.set", id: "start", date: "2026-10-01", actual: 20_000_000 }, { type: "recurring.sync", today: "2026-10-12" });
}

describe("бюджет от зарплаты до зарплаты", () => {
  it("период — с зарплаты 10-го по день перед авансом; в нём только его доходы и платежи", () => {
    const p = budgetPeriod(withPay(), "2026-10-12");
    expect(p.kind).toBe("pay");
    expect(p.current).toMatchObject({ start: "2026-10-10", end: "2026-10-24", days: 15, daysLeft: 13 });
    // 100 000 − связь 1 000 − норма 10 000 = 89 000 ₽ на 13 дней.
    expect(p.current.flexible.budget).toBe(8_900_000);
    expect(p.current.perDay).toBe(684_600);
    expect(p.next).toMatchObject({ date: "2026-10-25", category: "Аванс" });
  });

  it("после аванса — по плану: аванс 50 000 − аренда 1 ноября 30 000 − норма 5 000, на 16 дней", () => {
    const p = budgetPeriod(withPay(), "2026-10-12");
    expect(p.after).toMatchObject({ start: "2026-10-25", end: "2026-11-09", days: 16 });
    expect(p.after?.flexible.budget).toBe(1_500_000);
    expect(p.after?.perDay).toBe(93_700);
  });

  it("лимит на день — по периоду; «календарный месяц» — как раньше", () => {
    const s = withPay();
    expect(safeToSpend(s, "2026-10-12").budgetPerDay).toBe(684_600);
    s.settings.budgetPeriod = "month";
    const p = budgetPeriod(s, "2026-10-12");
    expect(p).toMatchObject({ kind: "month", next: null, after: null });
    expect(p.current).toMatchObject({ start: "2026-10-01", end: "2026-10-31" });
  });

  it("зарплата пришла раньше срока — период начинается в день поступления", () => {
    let s = withPay();
    s = run(s, { type: "recurring.sync", today: "2026-10-12" });
    const early = budgetPeriod(s, "2026-11-08");
    // 10 ноября ещё впереди: период — с аванса 25 октября.
    expect(early.current.start).toBe("2026-10-25");
    const paid = run(s, { type: "occurrence.confirm", templateId: "salary", month: "2026-11", amount: 10_000_000, date: "2026-11-08", note: "" });
    expect(budgetPeriod(paid, "2026-11-08").current).toMatchObject({ start: "2026-11-08", end: "2026-11-24" });
  });
});

describe("зарплата и аванс по названию", () => {
  it("регулярный доход «Аванс» с категорией «Переводы» тоже делит период", () => {
    const s = withPay();
    s.templates = s.templates.map((t) => (t.id === "advance" ? { ...t, category: "Переводы" } : t));
    const p = budgetPeriod(s, "2026-10-12");
    expect(p.kind).toBe("pay");
    expect(p.next).toMatchObject({ date: "2026-10-25", title: "Аванс" });
  });
});
