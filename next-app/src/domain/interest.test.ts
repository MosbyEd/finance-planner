import { describe, expect, it } from "vitest";
import { creditStatus, findAccount } from "./accounts";
import { applyActions } from "./actions";
import { loanInterest } from "./metrics";
import type { Account, Loan, State } from "./schema";
import { addTx, run, stateWith } from "./test-utils";

// 36,5% годовых — 0,1% в день: с долга 10 000 ₽ — 10 ₽ в день. 73% — 0,2% в день.
const card: Account = {
  id: "cc",
  name: "Кредитка",
  kind: "credit",
  spending: false,
  graceDays: 10,
  terms: { purchase: { rate: 36.5, graceDays: 10 }, cash: { rate: 73 } },
};

function withCard(account: Account = card): State {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  return run(s, { type: "balance.set", id: "b", date: "2026-10-01", actual: 5_000_000 }, { type: "account.add", account });
}

const buy = (date: string, amount: number, title = "Покупка") =>
  addTx({ type: "expense", amount, date, accountId: "cc", title, category: "Продукты" });
const pay = (id: string, date: string, amount: number) =>
  ({ type: "transfer.add", id, date, from: "main", to: "cc", amount, note: "" }) as const;

describe("проценты по кредитке", () => {
  it("покупки: пока идёт беспроцентный период — сколько начислят, если не погасить; не погасили — с первого дня", () => {
    const s = run(withCard(), buy("2026-10-01", 1_000_000));
    const during = creditStatus(s, findAccount(s, "cc")!, "2026-10-05");
    const purchase = during.parts.find((p) => p.operation === "purchase")!;
    expect(purchase).toMatchObject({ debt: 1_000_000, since: "2026-10-01", graceEnd: "2026-10-10", overdue: false, accrued: 0 });
    // 10 дней по 10 ₽.
    expect(purchase.ifMissed).toBe(10_000);
    expect(purchase.perDay).toBe(1_000);
    expect(during).toMatchObject({ graceEnd: "2026-10-10", ifMissed: 10_000, accrued: 0 });

    const after = creditStatus(s, findAccount(s, "cc")!, "2026-10-12");
    // Период не выполнен — проценты за все 12 дней с покупки.
    expect(after).toMatchObject({ overdue: true, accrued: 12_000, ifMissed: 0 });
  });

  it("погасили в беспроцентный период — процентов нет, следующая покупка начинает новый период", () => {
    const s = run(withCard(), buy("2026-10-01", 1_000_000), pay("p", "2026-10-08", 1_000_000), buy("2026-10-20", 200_000));
    const status = creditStatus(s, findAccount(s, "cc")!, "2026-10-21");
    expect(status).toMatchObject({ debt: 200_000, graceStart: "2026-10-20", graceEnd: "2026-10-29", accrued: 0 });
  });

  it("снятие наличных и переводы — свои ставка и период; платёж гасит сначала наличные", () => {
    let s = run(
      withCard(),
      buy("2026-10-01", 1_000_000),
      { type: "transfer.add", id: "t", date: "2026-10-03", from: "cc", to: "main", amount: 100_000, note: "" },
      buy("2026-10-03", 50_000, "Снятие наличных"),
    );
    let status = creditStatus(s, findAccount(s, "cc")!, "2026-10-05");
    const cash = status.parts.find((p) => p.operation === "cash")!;
    // Беспроцентного периода у наличных нет: 1 500 ₽ × 0,2% × 3 дня.
    expect(cash).toMatchObject({ debt: 150_000, graceEnd: null, accrued: 900, perDay: 300 });
    expect(status.graceEnd).toBe("2026-10-10");

    s = run(s, pay("p", "2026-10-05", 200_000));
    status = creditStatus(s, findAccount(s, "cc")!, "2026-10-05");
    expect(status.parts.find((p) => p.operation === "cash")).toMatchObject({ debt: 0, accrued: 0 });
    expect(status.parts.find((p) => p.operation === "purchase")).toMatchObject({ debt: 950_000 });
  });

  it("свои деньги на карте тратятся раньше кредитных", () => {
    const s = run(withCard(), pay("p", "2026-10-01", 300_000), buy("2026-10-02", 500_000));
    expect(creditStatus(s, findAccount(s, "cc")!, "2026-10-03")).toMatchObject({ debt: 200_000, graceStart: "2026-10-02" });
  });

  it("без условий по видам — все операции идут по беспроцентному периоду карты, проценты не считаются", () => {
    const legacy: Account = { ...card, graceDays: 30, terms: undefined };
    const s = run(
      withCard(legacy),
      { type: "transfer.add", id: "t", date: "2026-10-03", from: "cc", to: "main", amount: 100_000, note: "" },
    );
    const status = creditStatus(s, findAccount(s, "cc")!, "2026-10-05");
    expect(status).toMatchObject({ debt: 100_000, graceEnd: "2026-11-01", accrued: 0, ifMissed: 0 });
  });

  it("условия сохраняются и снимаются правкой счёта", () => {
    const s = run(withCard(), { type: "account.update", id: "cc", patch: { terms: null } });
    expect(findAccount(s, "cc")!.terms).toBeUndefined();
  });
});

describe("проценты по долгу", () => {
  const loan: Loan = {
    id: "tb",
    kind: "credit",
    name: "Тбанк",
    amount: 6_000_000,
    initialPaid: 0,
    dueDate: null,
    note: "",
    createdAt: "2026-10-10",
    takenAt: "2026-09-01",
    cashAmount: 1_000_000,
    terms: { purchase: { rate: 36.5, graceDays: 55 }, cash: { rate: 73, graceDays: 30 } },
  };

  it("долг делится на покупки и наличные, период идёт с даты долга, платежи гасят сначала наличные", () => {
    let s = run(withCard(), { type: "loan.add", loan });
    let interest = loanInterest(s, s.loans[0], "2026-10-05")!;
    // Наличные: 30 дней прошли 30 сентября — проценты за 35 дней: 10 000 ₽ × 0,2% × 35.
    expect(interest.parts.find((p) => p.operation === "cash")).toMatchObject({ overdue: true, accrued: 70_000 });
    // Покупки: до 25 октября без процентов.
    expect(interest.parts.find((p) => p.operation === "purchase")).toMatchObject({ graceEnd: "2026-10-25", accrued: 0 });

    s = run(s, { type: "loan.payment", id: "lp", loanId: "tb", amount: 1_000_000, date: "2026-10-06", note: "" });
    interest = loanInterest(s, s.loans[0], "2026-10-06")!;
    expect(interest.parts.find((p) => p.operation === "cash")).toMatchObject({ debt: 0, accrued: 0 });
    expect(interest.debt).toBe(5_000_000);
  });

  it("мне должны и долг без условий — без процентов; наличных не больше суммы долга", () => {
    const s = run(withCard(), { type: "loan.add", loan: { ...loan, terms: undefined } });
    expect(loanInterest(s, s.loans[0], "2026-10-05")).toBeNull();
    expect(() => applyActions(s, [{ type: "loan.update", id: "tb", patch: { cashAmount: 9_000_000 } }])).toThrow(/не может быть больше/);
    const cleared = run(s, { type: "loan.update", id: "tb", patch: { cashAmount: null, takenAt: null } });
    expect(cleared.loans[0].cashAmount).toBeUndefined();
    expect(cleared.loans[0].takenAt).toBeUndefined();
  });
});
