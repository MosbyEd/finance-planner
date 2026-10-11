import { describe, expect, it } from "vitest";
import { run, stateWith, template } from "./test-utils";
import { goalSaved, loanRemaining } from "./progress";
import { plannedOccurrences, templateEnd } from "./recurring";
import type { State } from "./schema";

function base(): State {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  return run(s, { type: "balance.set", id: "b", date: "2026-10-01", actual: 50_000_000 });
}

describe("срок регулярного платежа", () => {
  it("после срока не начисляется", () => {
    const s = base();
    s.templates = [template({ id: "t", kind: "expense", amount: 100_000, dayOfMonth: 10, startDate: "2026-10-01", endDate: "2026-12-31" })];
    expect(plannedOccurrences(s, "2026-10-11", "2027-06-30").map((o) => o.month)).toEqual(["2026-11", "2026-12"]);
    expect(templateEnd(s, s.templates[0], "2026-10-11")).toEqual({ status: "ends", last: "2026-12-10", amount: 100_000 });
    expect(templateEnd(s, s.templates[0], "2027-01-05")).toEqual({ status: "finished", reason: "date" });
  });
});

describe("платёж, пока не закрыт долг", () => {
  it("последний платёж — на остаток, после закрытия долга не повторяется", () => {
    let s = run(base(), {
      type: "loan.add",
      loan: { id: "tb", kind: "credit", name: "Тбанк", amount: 6_000_000, initialPaid: 3_500_000, dueDate: null, note: "", createdAt: "2026-09-01" },
    });
    s = run(s, {
      type: "template.add",
      template: template({ id: "pay", kind: "expense", amount: 1_000_000, dayOfMonth: 15, startDate: "2026-10-01", loanId: "tb", untilDone: true }),
    });
    // Осталось 25 000 ₽: 10 000, 10 000 и 5 000.
    expect(plannedOccurrences(s, "2026-10-11", "2027-06-30").map((o) => [o.month, o.amount])).toEqual([
      ["2026-10", 1_000_000],
      ["2026-11", 1_000_000],
      ["2026-12", 500_000],
    ]);
    expect(templateEnd(s, s.templates[0], "2026-10-11")).toEqual({ status: "ends", last: "2026-12-15", amount: 500_000 });

    s = run(s, { type: "recurring.sync", today: "2027-02-01" });
    expect(loanRemaining(s, s.loans[0])).toBe(0);
    expect(s.transactions.filter((t) => t.templateId === "pay").map((t) => t.amount)).toEqual([1_000_000, 1_000_000, 500_000]);
    expect(templateEnd(s, s.templates[0], "2027-02-01")).toEqual({ status: "finished", reason: "loan" });
  });
});

describe("пополнение цели", () => {
  it("уходит на счёт цели с её отметкой, пока цель не накоплена", () => {
    let s = run(
      base(),
      { type: "account.add", account: { id: "trip-acc", name: "На отпуск", kind: "savings", spending: false } },
      { type: "goal.add", goal: { id: "trip", name: "Отпуск", targetAmount: 3_000_000, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-10-01", accountId: "trip-acc" } },
      {
        type: "template.add",
        template: template({ id: "save", kind: "expense", amount: 1_200_000, dayOfMonth: 20, startDate: "2026-10-01", goalId: "trip", untilDone: true }),
      },
      { type: "recurring.sync", today: "2027-03-01" },
    );
    const txs = s.transactions.filter((t) => t.templateId === "save");
    expect(txs.map((t) => [t.type, t.amount, t.goalId, t.toAccountId])).toEqual([
      ["saving", 1_200_000, "trip", "trip-acc"],
      ["saving", 1_200_000, "trip", "trip-acc"],
      ["saving", 600_000, "trip", "trip-acc"],
    ]);
    expect(goalSaved(s, s.goals[0])).toBe(3_000_000);

    // Цель удалили — пополнения продолжаются на её счёт, без условия.
    s = run(s, { type: "goal.delete", id: "trip" });
    expect(s.templates[0]).toMatchObject({ toAccountId: "trip-acc" });
    expect(s.templates[0].goalId).toBeUndefined();
    expect(s.templates[0].untilDone).toBeUndefined();
  });
});
