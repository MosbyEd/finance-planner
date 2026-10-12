import { describe, expect, it } from "vitest";
import { accountBalance } from "./accounts";
import { monthMetrics, savingsTotal } from "./metrics";
import { pendingSavings, purchaseSourceExcluded } from "./savings";
import type { State } from "./schema";
import { addTx, run, stateWith } from "./test-utils";

/** Копилка с покупок: округление до 100 ₽, переводить, когда накопится 100 ₽. */
function base(minTransfer = 10_000): State {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving = { enabled: true, percent: 0, cap: 0, roundTo: 10_000, excludedCategories: [], minTransfer };
  return run(s, { type: "balance.set", id: "start", date: "2026-10-01", actual: 1_000_000 });
}

const linked = (s: State) => s.transactions.filter((t) => t.linkedTo);

describe("автоотчисления — переводить, когда накопится", () => {
  it("копятся, пока меньше порога: деньги остаются на счёте, сбережения не растут", () => {
    // Покупка 60 ₽ → округление 40 ₽; покупка 30 ₽ → 70 ₽: вместе 110 ₽.
    let s = run(base(), addTx({ id: "a", type: "expense", amount: 6_000, date: "2026-10-02", autoSaving: true }));
    expect(linked(s)).toEqual([]);
    expect(s.transactions.find((t) => t.id === "a")?.savingPending).toBe(true);
    expect(pendingSavings(s, "expense")).toEqual({ total: 4_000, threshold: 10_000, count: 1 });
    expect(savingsTotal(s)).toBe(0);
    expect(accountBalance(s, "main", "2026-10-02")).toBe(1_000_000 - 6_000);

    s = run(s, addTx({ id: "b", type: "expense", amount: 3_000, date: "2026-10-03", autoSaving: true }));
    // Набралось 110 ₽ — переведено разом, у каждой покупки своё отчисление.
    expect(linked(s).map((t) => [t.linkedTo, t.amount])).toEqual([
      ["a", 4_000],
      ["b", 7_000],
    ]);
    expect(s.transactions.some((t) => t.savingPending)).toBe(false);
    expect(savingsTotal(s)).toBe(11_000);
    expect(pendingSavings(s, "expense").total).toBe(0);
  });

  it("удалили покупку — её отчисление больше не копится", () => {
    let s = run(base(), addTx({ id: "a", type: "expense", amount: 6_000, date: "2026-10-02", autoSaving: true }));
    s = run(s, { type: "tx.delete", id: "a" });
    expect(pendingSavings(s, "expense").total).toBe(0);
  });

  it("порог убрали — накопленное переводится сразу; без порога — как раньше, с каждой покупки", () => {
    let s = run(base(), addTx({ id: "a", type: "expense", amount: 6_000, date: "2026-10-02", autoSaving: true }));
    s = run(s, {
      type: "settings.update",
      settings: { ...s.settings, purchaseSaving: { ...s.settings.purchaseSaving, minTransfer: 0 } },
    });
    expect(linked(s).map((t) => t.amount)).toEqual([4_000]);
    s = run(s, addTx({ id: "b", type: "expense", amount: 3_000, date: "2026-10-03", autoSaving: true }));
    expect(linked(s).map((t) => t.amount)).toEqual([4_000, 7_000]);
  });

  it("порог у каждого вида свой: доходы — сразу, покупки — копятся", () => {
    const s = base();
    s.settings.salarySaving = { enabled: true, percent: 10, categories: ["Зарплата"] };
    const next = run(
      s,
      addTx({ id: "pay", type: "income", amount: 1_000_000, date: "2026-10-05", category: "Зарплата", autoSaving: true }),
      addTx({ id: "buy", type: "expense", amount: 6_000, date: "2026-10-05", autoSaving: true }),
    );
    expect(linked(next).map((t) => [t.linkedTo, t.amount])).toEqual([["pay", 100_000]]);
    expect(pendingSavings(next, "expense").total).toBe(4_000);
    expect(pendingSavings(next, "income").total).toBe(0);
  });
});

describe("автоотчисления — с каких карт", () => {
  it("с выключенного счёта и выключенной карты не откладывается, с остальных — как раньше", () => {
    const s = base(0);
    s.settings.purchaseSaving.excludedAccounts = ["cash"];
    s.settings.purchaseSaving.excludedCards = ["1234"];
    const next = run(
      s,
      { type: "account.add", account: { id: "cash", name: "Наличные", kind: "cash", spending: true } },
      addTx({ id: "byCash", type: "expense", amount: 6_000, date: "2026-10-02", accountId: "cash", autoSaving: true }),
      addTx({ id: "byCard", type: "expense", amount: 6_000, date: "2026-10-02", card: "1234", autoSaving: true }),
      addTx({ id: "byOther", type: "expense", amount: 6_000, date: "2026-10-02", card: "7759", autoSaving: true }),
    );
    expect(linked(next).map((t) => t.linkedTo)).toEqual(["byOther"]);
    expect(purchaseSourceExcluded(s.settings, { accountId: "cash" })).toBe(true);
    expect(purchaseSourceExcluded(s.settings, {})).toBe(false);
  });
});

describe("свои деньги, а не доход", () => {
  it("доход становится корректировкой: деньги на счёте остаются, из доходов месяца и отчислений уходит; обратно — доход", () => {
    const s = base(0);
    s.settings.salarySaving = { enabled: true, percent: 10, categories: ["Переводы"] };
    let next = run(s, addTx({ id: "in", type: "income", amount: 23_000_000, date: "2026-10-03", category: "Переводы", autoSaving: true }));
    const balance = accountBalance(next, "main", "2026-10-03");
    expect(linked(next)).toHaveLength(1);
    next = run(next, { type: "tx.ownMoney", id: "in", own: true });
    expect(next.transactions.find((t) => t.id === "in")).toMatchObject({ type: "adjustment", ownMoney: true, amount: 23_000_000 });
    expect(linked(next)).toEqual([]);
    // Отчисление ушло вместе с «доходом» — на счёте ровно то, что пришло.
    expect(accountBalance(next, "main", "2026-10-03")).toBe(balance + 2_300_000);
    expect(monthMetrics(next, "2026-10", "2026-10-10").income.fact).toBe(0);
    const back = run(next, { type: "tx.ownMoney", id: "in", own: false });
    expect(back.transactions.find((t) => t.id === "in")).toMatchObject({ type: "income", category: "Переводы" });
  });
});
