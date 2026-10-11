import { describe, expect, it } from "vitest";
import { accountBalance, accountsOf, creditStatus, findAccount } from "./accounts";
import { applyActions, type Action } from "./actions";
import { balanceAt, goalSaved, loanRemaining, monthMetrics, safeToSpend, savingsTotal, upcomingEvents } from "./metrics";
import type { Account, State } from "./schema";
import { addTx, run, stateWith, template } from "./test-utils";

const credit: Account = {
  id: "cc",
  name: "Кредитка",
  kind: "credit",
  spending: false,
  smsKeys: ["1234"],
  creditLimit: 10_000_000,
  graceDays: 120,
};

function base(): State {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  return s;
}

/** Основной счёт с остатком 50 000 ₽ и кредитка. */
function withCredit(): State {
  return run(
    base(),
    { type: "balance.set", id: "b", date: "2026-10-01", actual: 5_000_000 },
    { type: "account.add", account: credit },
  );
}

describe("счета по умолчанию", () => {
  it("прежние данные без счетов: всё на основном, отчисления — в «Сбережениях»", () => {
    const s = run(
      base(),
      addTx({ type: "income", amount: 100_000, date: "2026-10-01" }),
      { type: "savings.move", id: "sv", date: "2026-10-02", amount: 30_000, note: "" },
    );
    expect(accountsOf(s).map((a) => a.id)).toEqual(["main", "savings"]);
    expect(s.accounts).toBeUndefined();
    expect(accountBalance(s, "main")).toBe(70_000);
    expect(accountBalance(s, "savings")).toBe(30_000);
    expect(balanceAt(s, "2026-10-10")).toBe(70_000);
    expect(savingsTotal(s)).toBe(30_000);
  });
});

describe("кредитная карта", () => {
  it("покупка по кредитке — расход бюджета, но не деньги на счетах; долг и беспроцентный период", () => {
    const s = run(withCredit(), addTx({ type: "expense", amount: 300_000, date: "2026-10-05", accountId: "cc" }));
    expect(balanceAt(s, "2026-10-10")).toBe(5_000_000);
    expect(monthMetrics(s, "2026-10", "2026-10-10").flexible.spent).toBe(300_000);
    const status = creditStatus(s, findAccount(s, "cc")!, "2026-10-10");
    expect(status).toMatchObject({ debt: 300_000, available: 9_700_000, graceStart: "2026-10-05", graceEnd: "2027-02-01", overdue: false });
  });

  it("погашение переводом обнуляет долг и период; новая покупка начинает новый период", () => {
    const s = run(
      withCredit(),
      addTx({ type: "expense", amount: 300_000, date: "2026-10-05", accountId: "cc" }),
      { type: "transfer.add", id: "pay", date: "2026-10-08", from: "main", to: "cc", amount: 300_000, note: "" },
      addTx({ type: "expense", amount: 50_000, date: "2026-10-09", accountId: "cc" }),
    );
    expect(s.transactions.find((t) => t.id === "pay")).toMatchObject({ type: "transfer", title: "Погашение: Кредитка" });
    expect(balanceAt(s, "2026-10-10")).toBe(4_700_000);
    // Погашение — не расход: бюджет уже учёл покупки.
    expect(monthMetrics(s, "2026-10", "2026-10-10").flexible.spent).toBe(350_000);
    expect(creditStatus(s, findAccount(s, "cc")!, "2026-10-10")).toMatchObject({ debt: 50_000, graceStart: "2026-10-09" });
  });

  it("частичное погашение не сбрасывает период; просроченный долг — «погасить» завтра", () => {
    const s = run(
      withCredit(),
      { type: "account.update", id: "cc", patch: { graceDays: 30 } },
      addTx({ type: "expense", amount: 300_000, date: "2026-09-01", accountId: "cc" }),
      { type: "transfer.add", id: "pay", date: "2026-09-10", from: "main", to: "cc", amount: 100_000, note: "" },
    );
    const status = creditStatus(s, findAccount(s, "cc")!, "2026-10-10");
    expect(status).toMatchObject({ debt: 200_000, graceStart: "2026-09-01", graceEnd: "2026-09-30", overdue: true });
    const event = upcomingEvents(s, "2026-10-10", "2026-11-10").find((e) => e.source === "credit");
    expect(event).toMatchObject({ date: "2026-10-11", effect: -200_000, mandatory: true });
  });

  it("лимит на день: покупка по кредитке уменьшает его, долг к концу периода до дохода — обязательный платёж", () => {
    const salary = template({ kind: "income", amount: 10_000_000, dayOfMonth: 25, startDate: "2026-01-01" });
    const plain = run({ ...withCredit(), templates: [salary] });
    const spent = run(plain, addTx({ type: "expense", amount: 100_000, date: "2026-10-10", accountId: "cc" }));
    const before = safeToSpend(plain, "2026-10-10");
    const after = safeToSpend(spent, "2026-10-10");
    expect(after.spentToday).toBe(100_000);
    expect(after.leftToday).toBe(after.recommended - 100_000);
    // Сегодняшняя покупка по кредитке денег на счёте не тратила: «деньги до сегодняшних трат» те же.
    expect(after.cashNow).toBe(before.cashNow);

    // Короткий период: долг надо погасить 20-го, до зарплаты 25-го — он уменьшает деньги на день.
    const due = run(
      spent,
      { type: "account.update", id: "cc", patch: { graceDays: 11 } },
    );
    const withDebt = safeToSpend(due, "2026-10-10");
    expect(withDebt.plannedOut).toBe(before.plannedOut + 100_000);
    expect(withDebt.cashPerDay).toBeLessThan(after.cashPerDay);
  });

  it("автоотчисление с покупки по кредитке уходит с основного счёта, а не в долг", () => {
    const s = withCredit();
    s.settings.purchaseSaving = { enabled: true, percent: 10, cap: 100_000, roundTo: 0, excludedCategories: [] };
    const next = run(s, addTx({ id: "buy", type: "expense", amount: 100_000, date: "2026-10-05", accountId: "cc", autoSaving: true }));
    const saving = next.transactions.find((t) => t.linkedTo === "buy");
    expect(saving).toMatchObject({ type: "saving", amount: 10_000 });
    expect(saving?.accountId).toBeUndefined(); // основной
    expect(accountBalance(next, "cc")).toBe(-100_000);
  });
});

describe("накопительные счета и переводы", () => {
  const deposit: Account = { id: "dep", name: "Вклад", kind: "savings", spending: false, smsKeys: [] };

  it("отчисление на выбранный накопительный счёт; снять можно только то, что на нём лежит", () => {
    const s = run(
      base(),
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 1_000_000 },
      { type: "account.add", account: deposit },
      { type: "savings.move", id: "s1", date: "2026-10-02", amount: 200_000, note: "", toAccountId: "dep" },
    );
    expect(accountBalance(s, "dep")).toBe(200_000);
    expect(savingsTotal(s)).toBe(200_000);
    expect(monthMetrics(s, "2026-10", "2026-10-10").savings.fact).toBe(200_000);
    expect(() =>
      applyActions(s, [{ type: "savings.move", id: "s2", date: "2026-10-03", amount: -100_000, note: "" }]),
    ).toThrow(/Нельзя снять больше, чем есть на счёте «Сбережения» \(0/);
  });

  it("счёт, отмеченный «учитывать в тратах», входит в деньги на счетах, а не в сбережения", () => {
    const s = run(
      base(),
      { type: "account.add", account: { ...deposit, spending: true } },
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 500_000, accountId: "dep" },
    );
    expect(balanceAt(s, "2026-10-10")).toBe(500_000);
    expect(savingsTotal(s)).toBe(0);
    expect(s.transactions[0]).toMatchObject({ accountId: "dep", title: "Корректировка остатка: Вклад" });
  });

  it("основной счёт можно не учитывать в тратах", () => {
    const s = run(
      base(),
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 500_000 },
      { type: "account.update", id: "main", patch: { spending: false } },
    );
    expect(balanceAt(s, "2026-10-10")).toBe(0);
  });
});

describe("правила счетов", () => {
  it("цифры карты не повторяются, встроенные счета не удаляются, счёт с операциями — только закрыть", () => {
    const s = withCredit();
    const add = (account: Account): Action => ({ type: "account.add", account });
    expect(() => applyActions(s, [add({ id: "x", name: "Ещё", kind: "debit", spending: true, smsKeys: ["1234"] })])).toThrow(
      /1234 уже указаны у счёта «Кредитка»/,
    );
    expect(() => applyActions(s, [{ type: "account.delete", id: "main" }])).toThrow(/нельзя удалить/);
    expect(() => applyActions(s, [{ type: "account.update", id: "savings", patch: { archived: true } }])).toThrow(/нельзя закрыть/);

    const used = run(s, addTx({ type: "expense", amount: 100, date: "2026-10-05", accountId: "cc" }));
    expect(() => applyActions(used, [{ type: "account.delete", id: "cc" }])).toThrow(/закройте его/);
    const closed = run(used, { type: "account.update", id: "cc", patch: { archived: true } });
    expect(findAccount(closed, "cc")?.archived).toBe(true);
    expect(() => applyActions(closed, [addTx({ type: "expense", amount: 100, date: "2026-10-06", accountId: "cc" })])).toThrow(
      /закрыт/,
    );
    expect(run(s, { type: "account.delete", id: "cc" }).accounts?.map((a) => a.id)).toEqual(["main", "savings"]);
  });

  it("кредитка никогда не учитывается в тратах; перевод — между разными счетами", () => {
    const s = run(base(), { type: "account.add", account: { ...credit, spending: true } });
    expect(findAccount(s, "cc")?.spending).toBe(false);
    expect(() =>
      applyActions(s, [{ type: "transfer.add", id: "t", date: "2026-10-01", from: "main", to: "main", amount: 100, note: "" }]),
    ).toThrow(/два разных счёта/);
  });
});

describe("счета регулярных платежей", () => {
  const card: Account = { ...credit, graceDays: 30 };
  const deposit: Account = { id: "dep", name: "Вклад", kind: "savings", spending: false };

  function withTemplates(): State {
    return run(
      base(),
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 5_000_000 },
      { type: "account.add", account: card },
      { type: "account.add", account: deposit },
      {
        type: "loan.add",
        loan: { id: "mortgage", kind: "credit", name: "Ипотека", amount: 100_000_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-01-01" },
      },
    );
  }

  it("погашение кредитки по шаблону — перевод: не расход бюджета, напоминание о льготном периоде не дублируется", () => {
    let s = run(withTemplates(), addTx({ type: "expense", amount: 300_000, date: "2026-10-02", accountId: "cc" }));
    s = run(s, {
      type: "template.add",
      template: { ...template({ kind: "expense", amount: 300_000, dayOfMonth: 15, startDate: "2026-10-01" }), id: "repay", title: "Кредитка", toAccountId: "cc" },
    });
    expect(monthMetrics(s, "2026-10", "2026-10-10").mandatory.plan).toBe(0);
    const events = upcomingEvents(s, "2026-10-10", "2026-11-10");
    expect(events.find((e) => e.templateId === "repay")).toMatchObject({ type: "transfer", effect: -300_000, amount: -300_000 });
    expect(events.some((e) => e.source === "credit")).toBe(false);

    const synced = run(s, { type: "recurring.sync", today: "2026-10-15" });
    expect(synced.transactions.find((t) => t.templateId === "repay")).toMatchObject({ type: "transfer", toAccountId: "cc", amount: 300_000 });
    expect(creditStatus(synced, findAccount(synced, "cc")!, "2026-10-15").debt).toBe(0);
  });

  it("пополнение накопительного по шаблону — отложено; платёж по ипотеке — расход в счёт долга", () => {
    const s = run(
      withTemplates(),
      {
        type: "template.add",
        template: { ...template({ kind: "expense", amount: 500_000, dayOfMonth: 5, startDate: "2026-10-01" }), id: "save", title: "Копим", toAccountId: "dep" },
      },
      {
        type: "template.add",
        template: { ...template({ kind: "expense", amount: 4_504_400, dayOfMonth: 21, startDate: "2026-10-01" }), id: "ipo", title: "Ипотека", category: "Ипотека/кредит", loanId: "mortgage" },
      },
      { type: "recurring.sync", today: "2026-10-25" },
    );
    expect(s.transactions.find((t) => t.templateId === "save")).toMatchObject({ type: "saving", toAccountId: "dep", amount: 500_000 });
    expect(accountBalance(s, "dep")).toBe(500_000);
    expect(monthMetrics(s, "2026-10", "2026-10-25").savings.fact).toBe(500_000);
    expect(s.transactions.find((t) => t.templateId === "ipo")).toMatchObject({ type: "expense", mandatory: true, loanId: "mortgage" });
    expect(loanRemaining(s, s.loans[0])).toBe(100_000_000 - 4_504_400);
  });

  it("проверки: не на тот же счёт, не по чужому долгу; удалённый долг — платёж становится обычным", () => {
    const s = withTemplates();
    const t = template({ kind: "expense", amount: 100, dayOfMonth: 1 });
    expect(() => applyActions(s, [{ type: "template.add", template: { ...t, toAccountId: "main" } }])).toThrow(/тот же счёт/);
    const lend = run(s, {
      type: "loan.add",
      loan: { id: "lera", kind: "lend", name: "Лера", amount: 300_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-01-01" },
    });
    expect(() => applyActions(lend, [{ type: "template.add", template: { ...t, loanId: "lera" } }])).toThrow(/своему долгу/);
    const linked = run(s, { type: "template.add", template: { ...t, id: "ipo", loanId: "mortgage" } }, { type: "loan.delete", id: "mortgage" });
    expect(linked.templates[0].loanId).toBeUndefined();
  });
});

describe("куда копятся сбережения", () => {
  const goalDeposit: Account = { id: "goal", name: "На машину", kind: "savings", spending: false, inSavings: false };
  const deposit: Account = { id: "dep", name: "Накопительный", kind: "savings", spending: false };

  it("«Учитывать в сбережениях» выключено — счёт не входит в сбережения", () => {
    const s = run(
      base(),
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 1_000_000 },
      { type: "account.add", account: goalDeposit },
      { type: "savings.move", id: "m", date: "2026-10-02", amount: 300_000, note: "", toAccountId: "goal" },
    );
    expect(accountBalance(s, "goal")).toBe(300_000);
    expect(savingsTotal(s)).toBe(0);
  });

  it("с доходов и с покупок — на счета из настроек, остаток месяца — тоже", () => {
    let s = run(base(), { type: "account.add", account: deposit }, { type: "account.add", account: goalDeposit });
    s = run(s, {
      type: "settings.update",
      settings: {
        ...s.settings,
        salarySaving: { enabled: true, percent: 10, categories: ["Зарплата"], toAccountId: "dep" },
        purchaseSaving: { enabled: true, percent: 10, cap: 100_000, roundTo: 0, excludedCategories: [], toAccountId: "goal" },
        rolloverAccountId: "dep",
      },
    });
    s = run(
      s,
      addTx({ id: "pay", type: "income", amount: 1_000_000, date: "2026-09-05", category: "Зарплата", autoSaving: true }),
      addTx({ id: "buy", type: "expense", amount: 100_000, date: "2026-09-06", autoSaving: true }),
    );
    expect(s.transactions.find((t) => t.linkedTo === "pay")).toMatchObject({ amount: 100_000, toAccountId: "dep" });
    expect(s.transactions.find((t) => t.linkedTo === "buy")).toMatchObject({ amount: 10_000, toAccountId: "goal" });
    const rolled = run(s, { type: "rollover.resolve", month: "2026-09", decision: "saved", id: "roll", date: "2026-10-01" });
    expect(rolled.transactions.find((t) => t.id === "roll")).toMatchObject({ type: "saving", toAccountId: "dep" });
    expect(() =>
      applyActions(s, [{ type: "settings.update", settings: { ...s.settings, rolloverAccountId: "main" } }]),
    ).toThrow(/накопительном/);
  });
});

describe("цель со своим счётом", () => {
  const carAccount: Account = { id: "car-acc", name: "На машину", kind: "savings", spending: false };
  const goal = { id: "car", name: "Машина", targetAmount: 100_000_000, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-01-01" };

  it("пополнили счёт — пополнилась цель (в обе стороны); счёт двух целей — по отметкам цели", () => {
    let s = run(
      base(),
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 5_000_000 },
      { type: "account.add", account: carAccount },
      { type: "goal.add", goal: { ...goal, accountId: "car-acc" } },
      // Пополнение счёта без отметки цели (например, из СМС).
      { type: "savings.move", id: "m1", date: "2026-10-02", amount: 300_000, note: "", toAccountId: "car-acc" },
      // Пополнение через цель — уходит на её счёт.
      { type: "savings.move", id: "m2", date: "2026-10-03", amount: 200_000, note: "", goalId: "car" },
    );
    expect(accountBalance(s, "car-acc")).toBe(500_000);
    expect(goalSaved(s, s.goals[0])).toBe(500_000);
    s = run(s, { type: "savings.move", id: "m3", date: "2026-10-04", amount: -100_000, note: "", toAccountId: "car-acc" });
    expect(goalSaved(s, s.goals[0])).toBe(400_000);
    expect(() =>
      applyActions(s, [{ type: "savings.move", id: "m4", date: "2026-10-05", amount: -500_000, note: "", goalId: "car" }]),
    ).toThrow(/Нельзя снять больше/);

    const shared = run(s, { type: "goal.add", goal: { ...goal, id: "trip", name: "Отпуск", accountId: "car-acc" } });
    // Счёт у двух целей: у «Машины» — только пополнение с её отметкой.
    expect(goalSaved(shared, shared.goals[0])).toBe(200_000);
    const detached = run(s, { type: "goal.update", id: "car", patch: { accountId: null } });
    expect(detached.goals[0].accountId).toBeUndefined();
  });
});

describe("регулярный перевод на накопительный", () => {
  it("это сбережения: покрывает норму заранее, сверх нормы — урезает гибкий бюджет сразу, а не в день перевода", () => {
    const savingsAcc: Account = { id: "alfa", name: "Накопительный", kind: "savings", spending: false };
    const s0 = run(base(), { type: "account.add", account: savingsAcc });
    s0.settings.savingsRatePercent = 10;
    s0.templates = [
      template({ kind: "income", amount: 10_000_000, dayOfMonth: 5, startDate: "2026-10-01" }),
      template({ kind: "expense", amount: 2_500_000, dayOfMonth: 25, startDate: "2026-10-01", toAccountId: "alfa" }),
    ];
    const s = run(s0, { type: "recurring.sync", today: "2026-10-11" });
    const m = monthMetrics(s, "2026-10", "2026-10-11");
    // Норма 10% — 10 000 ₽, перевод 25 000 ₽ ещё впереди: сверх нормы 15 000 ₽ уже учтены.
    expect(m.savings).toMatchObject({ target: 1_000_000, planned: 2_500_000 });
    expect(m.mandatory.plan).toBe(0);
    expect(m.flexible.extraSavings).toBe(1_500_000);
  });
});

describe("перевод со счёта, который не учитывается в сбережениях", () => {
  it("с «Ремонта» на карту — сколько на нём лежит, даже если в сбережениях ничего нет", () => {
    const repair: Account = { id: "repair", name: "Ремонт", kind: "savings", spending: false, inSavings: false };
    const sber: Account = { id: "sber", name: "Сбербанк", kind: "debit", spending: true };
    let s = run(
      withCredit(),
      { type: "account.add", account: repair },
      { type: "account.add", account: sber },
      { type: "savings.move", id: "in", date: "2026-10-02", amount: 3_000_000, note: "", toAccountId: "repair" },
    );
    expect(savingsTotal(s)).toBe(0);
    // Как окно перевода: с накопительного на карту — снятие из сбережений на эту карту.
    s = run(s, { type: "savings.move", id: "out", date: "2026-10-03", amount: -2_000_000, note: "", accountId: "sber", toAccountId: "repair" });
    expect(accountBalance(s, "repair")).toBe(1_000_000);
    expect(accountBalance(s, "sber")).toBe(2_000_000);
    expect(() =>
      applyActions(s, [{ type: "savings.move", id: "over", date: "2026-10-04", amount: -2_000_000, note: "", accountId: "sber", toAccountId: "repair" }]),
    ).toThrow(/Нельзя снять больше, чем есть на счёте «Ремонт»/);
  });
});
