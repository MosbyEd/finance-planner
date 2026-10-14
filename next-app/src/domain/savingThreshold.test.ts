import { describe, expect, it } from "vitest";
import { DomainError } from "./actions";
import { accountBalance } from "./accounts";
import { monthMetrics, savingsTotal } from "./metrics";
import { expectedSavings, pendingSavings, purchaseSourceExcluded } from "./savings";
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

describe("автоотчисления — ожидается в сбережения", () => {
  it("пока порог не набран — сумма ждёт на счёте-копилке, но ни с карты, ни в копилку не проведена", () => {
    let s = run(base(), { type: "account.add", account: { id: "piggy", name: "Автонакопления", kind: "savings", spending: false } });
    s.settings.purchaseSaving.toAccountId = "piggy";
    s = run(s, addTx({ id: "a", type: "expense", amount: 6_000, date: "2026-10-02", autoSaving: true }));
    expect(expectedSavings(s)).toEqual({ total: 4_000, byAccount: new Map([["piggy", 4_000]]) });
    expect(accountBalance(s, "main", "2026-10-02")).toBe(1_000_000 - 6_000);
    expect(accountBalance(s, "piggy", "2026-10-02")).toBe(0);

    // Набралось 110 ₽ — переведено, ожидать больше нечего.
    s = run(s, addTx({ id: "b", type: "expense", amount: 3_000, date: "2026-10-03", autoSaving: true }));
    expect(expectedSavings(s).total).toBe(0);
    expect(accountBalance(s, "piggy", "2026-10-03")).toBe(11_000);
    expect(accountBalance(s, "main", "2026-10-03")).toBe(1_000_000 - 6_000 - 3_000 - 11_000);
  });
});

describe("сверка с банком — копилка банка", () => {
  const day = "2026-10-02";
  // В приложении с покупки 60 ₽ ожидается 40 ₽; банк по своему правилу уже перевёл в копилку 100 ₽.
  const swept = () => {
    const s = run(base(), { type: "account.add", account: { id: "piggy", name: "Автонакопления", kind: "savings", spending: false } });
    s.settings.purchaseSaving.toAccountId = "piggy";
    return run(s, addTx({ id: "a", type: "expense", amount: 6_000, date: day, autoSaving: true }));
  };
  const sms = (s: State, amount: number, date = day) =>
    run(s, { type: "account.bank", accountId: "main", amount, delta: amount - accountBalance(s, "main", date), date });

  it("по СМС: ожидаемое засчитано переведённым, остаток разницы — переводом в копилку; второй раз не спишется", () => {
    let s = run(sms(swept(), 984_000), { type: "account.bankPiggy", id: "pig", accountId: "main" });
    expect(linked(s).map((t) => [t.linkedTo, t.amount])).toEqual([["a", 4_000]]);
    expect(s.transactions.find((t) => t.id === "pig")).toMatchObject({ type: "saving", amount: 6_000, date: day, title: "Копилка банка", toAccountId: "piggy" });
    expect(accountBalance(s, "main", day)).toBe(984_000);
    expect(accountBalance(s, "piggy", day)).toBe(10_000);
    expect(expectedSavings(s).total).toBe(0);
    expect(s.accounts?.find((a) => a.id === "main")?.bank?.delta).toBe(0);

    // Следующая покупка копится заново — прежние 40 ₽ второй раз не списываются.
    s = run(s, addTx({ id: "b", type: "expense", amount: 3_000, date: "2026-10-03", autoSaving: true }));
    expect(expectedSavings(s).total).toBe(7_000);
    expect(accountBalance(s, "main", "2026-10-03")).toBe(984_000 - 3_000);
  });

  it("банк перевёл меньше, чем ожидалось, — лишнее возвращается из копилки на карту", () => {
    let s = swept();
    s = run(s, {
      type: "settings.update",
      settings: { ...s.settings, purchaseSaving: { ...s.settings.purchaseSaving, minTransfer: 50_000 } },
    });
    s = run(s, addTx({ id: "b", type: "expense", amount: 10_000 - 100, date: day, autoSaving: true }));
    // Ожидается 40 + 1 = 41 ₽, банк перевёл 30 ₽.
    expect(expectedSavings(s).total).toBe(4_100);
    const card = accountBalance(s, "main", day);
    s = run(sms(s, card - 3_000), { type: "account.bankPiggy", id: "pig", accountId: "main" });
    expect(s.transactions.find((t) => t.id === "pig")?.amount).toBe(-1_100);
    expect(accountBalance(s, "main", day)).toBe(card - 3_000);
    expect(accountBalance(s, "piggy", day)).toBe(3_000);
  });

  it("ручная сверка «Копилка банка» — так же; операции после дня сверки копятся дальше", () => {
    // Покупка 90 ₽ 5-го: ожидается ещё 10 ₽ (вместе 50 ₽ — порог не набран).
    let s = run(swept(), addTx({ id: "later", type: "expense", amount: 9_000, date: "2026-10-05", autoSaving: true }));
    s = run(s, { type: "balance.set", id: "pig", date: day, actual: 984_000, piggy: true });
    expect(linked(s).map((t) => t.linkedTo)).toEqual(["a"]);
    expect(accountBalance(s, "main", day)).toBe(984_000);
    expect(accountBalance(s, "piggy", day)).toBe(10_000);
    expect(s.transactions.find((t) => t.id === "later")?.savingPending).toBe(true);
  });

  it("у счёта нет копилки (автоотчисления с покупок выключены) — «Копилка банка» не применяется", () => {
    const s = swept();
    s.settings.purchaseSaving.enabled = false;
    expect(() => run(s, { type: "balance.set", id: "pig", date: day, actual: 984_000, piggy: true })).toThrow(DomainError);
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
