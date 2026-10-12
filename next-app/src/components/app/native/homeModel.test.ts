import { describe, expect, it } from "vitest";
import type { State } from "@/domain/schema";
import { addTx, stateWith, template, tx } from "@/domain/test-utils";
import type { Snapshot } from "@/client/store";
import { applyActions } from "@/domain/actions";
import { accountBalance } from "@/domain/accounts";
import { bankResolveActions, transferAction, transferMessage } from "../accounts";
import { commandSchema } from "./commands";
import { smsTextImport } from "../smsText";
import { buildHomeModel, type HomeModel } from "./homeModel";

const today = "2026-10-10";

function snapshot(state: State, patch: Partial<Snapshot> = {}): Snapshot {
  return {
    phase: "ready",
    mode: "account",
    user: { login: "ed", name: null },
    sessionExpired: false,
    aiEnabled: false,
    registrationOpen: false,
    state,
    version: 1,
    sync: { status: "synced", pending: 0, message: null },
    guestImportOffer: false,
    legacyImportOffer: false,
    ...patch,
  };
}

/** Деньги форматируются с неразрывными пробелами — в ожиданиях пишем обычные. */
function model(state: State, patch: Partial<Snapshot> = {}): HomeModel {
  const built = buildHomeModel({ snapshot: snapshot(state, patch), today, balanceConfirmed: false, mandatorySkipped: false, assistant: true });
  return JSON.parse(JSON.stringify(built).replace(/[\u00a0\u202f]/g, " ")) as HomeModel;
}

function base() {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  return s;
}

describe("модель нативной Главной", () => {
  it("без данных — только первые шаги", () => {
    const m = model(base());
    expect(m.hasData).toBe(false);
    expect(m.today).toBeNull();
    expect(m.onboarding?.done).toBe(0);
    expect(m.onboarding?.importHint).toBe(true);
    expect(m.recent).toEqual([]);
  });

  it("лимит на сегодня, плитки, месяц и последние операции — без копеек в итогах", () => {
    const s = base();
    s.templates = [template({ kind: "income", amount: 10_000_000, dayOfMonth: 25, startDate: "2026-03-01" })];
    s.transactions = [
      tx({ id: "in", type: "income", amount: 5_000_050, date: "2026-10-01", category: "Зарплата", title: "Аванс" }),
      tx({ id: "cof", type: "expense", amount: 32_050, date: today, category: "Кафе", title: "Кофе" }),
      tx({ id: "cof2", type: "expense", amount: 32_050, date: "2026-10-09", category: "Кафе", title: "Кофе" }),
    ];
    const m = model(s);
    expect(m.today).toMatchObject({ kind: "limit", label: "Сегодня можно потратить", over: false });
    if (m.today?.kind !== "limit") throw new Error("нет лимита");
    expect(m.today.amount).not.toMatch(/,/);
    expect(m.today.detail).toMatch(/^Лимит на день .* · потрачено 321 ₽$/);
    expect(m.tiles?.balance).toBe("49 360 ₽");
    expect(m.month?.title).toBe("Октябрь 2026");
    expect(m.recent.map((r) => r.id)).toEqual(["cof", "cof2", "in"]);
    expect(m.recent[0]).toMatchObject({ title: "Кофе", subtitle: "Сегодня · Кафе", amount: "−320,50 ₽", amountTone: "default" });
    expect(m.recent[2]).toMatchObject({ amountTone: "positive", command: { type: "open", overlay: { kind: "tx", txId: "in" } } });
    // Повторилась дважды — попадает в быстрые траты; ключ находит её снова.
    expect(m.quick).toEqual([{ key: "Кафе|Кофе|32050", title: "Кофе", amount: "320,50 ₽" }]);
    expect(m.add.picks[0]).toMatchObject({ category: "Кафе", amount: 32_050 });
    expect(m.add.lastExpense).toBe("Кафе");
    expect(m.upcoming[0]).toMatchObject({ title: expect.any(String), positive: true });
    expect(m.upcoming[0].command).toMatchObject({ type: "open", overlay: { kind: "planned" } });
  });

  it("без остатка просит его указать, новые операции из СМС — в «Требует внимания»", () => {
    const s = base();
    s.transactions = [tx({ id: "sms", type: "expense", amount: 10_000, date: today, review: true })];
    const m = model(s, { sync: { status: "offline", pending: 2, message: null } });
    expect(m.today).toEqual({ kind: "balance", text: expect.stringContaining("Укажите") });
    expect(m.attention[0]).toMatchObject({ id: "review", title: "1 новая операция", command: { type: "open", overlay: { kind: "review" } } });
    expect(m.sync).toEqual({ text: "Офлайн · не отправлено: 2", tone: "warning", symbol: "icloud.slash" });
  });

  it("команды из модели проходят проверку, чужие — нет", () => {
    const s = base();
    s.transactions = [tx({ id: "sms", type: "expense", amount: 10_000, date: today, review: true })];
    for (const row of model(s).attention) {
      if (row.command) expect(commandSchema.safeParse(row.command).success).toBe(true);
    }
    expect(commandSchema.safeParse({ type: "add", draft: { kind: "expense", amount: 100, category: "Кафе", title: "", date: today } }).success).toBe(true);
    expect(commandSchema.safeParse({ type: "add", draft: { kind: "expense", amount: -5, category: "Кафе", title: "", date: today } }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "open", overlay: { kind: "nope" } }).success).toBe(false);
    expect(commandSchema.safeParse({ type: "eval" }).success).toBe(false);
  });
});

describe("расхождение остатка с банком", () => {
  it("строка в «Требует внимания», «Поправить» — корректировка на разницу и снятие расхождения", () => {
    let s = applyActions(base(), [
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 500_000 },
      { type: "account.bank", accountId: "main", amount: 490_000, delta: -10_000, date: today },
    ]);
    const row = model(s).attention.find((r) => r.id === "bank:main");
    expect(row).toMatchObject({ title: "«Основной счёт»: в банке 4 900 ₽, в приложении 5 000 ₽", tone: "warning" });
    expect(row?.actions.map((a) => a.command)).toEqual([
      { type: "bank", accountId: "main", fix: true },
      // В банке меньше на 100 ₽ — деньги ушли с основного: перевод с него, сумма подставлена.
      { type: "open", overlay: { kind: "transfer", from: "main", amount: 10_000, resolveBank: "main" } },
      { type: "bank", accountId: "main", fix: false },
    ]);
    s = applyActions(s, bankResolveActions(s, "main", true, today, "fix"));
    expect(accountBalance(s, "main", today)).toBe(490_000);
    expect(model(s).attention.some((r) => r.id === "bank:main")).toBe(false);
  });
});

describe("счета на Главной", () => {
  it("три самых важных: просроченная кредитка, затем крупные счета для трат; всего — отдельно", () => {
    const s = applyActions(base(), [
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 100_000 },
      { type: "account.add", account: { id: "cash", name: "Наличные", kind: "cash", spending: true } },
      { type: "balance.set", id: "c", date: "2026-10-01", actual: 900_000, accountId: "cash" },
      { type: "account.add", account: { id: "dep", name: "Вклад", kind: "savings", spending: false } },
      { type: "account.add", account: { id: "cc", name: "Кредитка", kind: "credit", spending: false, graceDays: 5 } },
      { type: "tx.add", tx: { id: "buy", type: "expense", amount: 50_000, date: "2026-09-01", category: "Продукты", title: "", note: "", mandatory: false, autoSaving: false, accountId: "cc" } },
    ]);
    const m = model(s);
    expect(m.accountsTotal).toBe(5); // с «Основным счётом» и «Сбережениями» по умолчанию
    expect(m.accounts.map((a) => a.id)).toEqual(["cc", "cash", "main"]);
  });
});

describe("глазок у сумм счетов", () => {
  it("спрятано — вместо остатков «•••• ₽», без сумм в пояснениях; команда глазка проходит проверку", () => {
    const s = applyActions(base(), [
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 5_000_000 },
      { type: "account.add", account: { id: "cc", name: "Кредитка", kind: "credit", spending: false, creditLimit: 10_000_000, graceDays: 60 } },
      addTx({ type: "expense", amount: 300_000, date: "2026-10-05", accountId: "cc" }),
    ]);
    const built = buildHomeModel({
      snapshot: snapshot(s),
      today,
      balanceConfirmed: true,
      mandatorySkipped: true,
      assistant: true,
      privacy: { masked: true, hiding: true },
    });
    expect(built.balancesHidden).toBe(true);
    expect(built.tiles).toMatchObject({ balance: "•••• ₽", savings: "•••• ₽", balanceNegative: false });
    expect(built.accounts.every((a) => a.amount === "•••• ₽" && !/₽/.test(a.detail))).toBe(true);
    expect(commandSchema.safeParse({ type: "balances", visible: true }).success).toBe(true);
  });
});

describe("перевод из окна «+»", () => {
  it("счета для перевода — с накопительными; в накопительный — движение сбережений, на кредитку — перевод", () => {
    const s = applyActions(base(), [
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 500_000 },
      { type: "account.add", account: { id: "dep", name: "Вклад", kind: "savings", spending: false } },
      { type: "account.add", account: { id: "cc", name: "Кредитка", kind: "credit", spending: false, graceDays: 5 } },
    ]);
    const add = model(s).add;
    expect(add.transferAccounts.find((a) => a.id === "dep")).toMatchObject({ savings: true });
    expect(add.accounts.some((a) => a.id === "dep")).toBe(false);

    const draft = { amount: 10_000, from: "main", to: "dep", title: "", date: today };
    expect(commandSchema.safeParse({ type: "transfer", draft }).success).toBe(true);
    expect(transferAction(s, { id: "t1", ...draft })).toMatchObject({ type: "savings.move", amount: 10_000, accountId: "main", toAccountId: "dep" });
    expect(transferAction(s, { id: "t2", ...draft, from: "dep", to: "main" })).toMatchObject({ type: "savings.move", amount: -10_000, accountId: "main", toAccountId: "dep" });
    expect(transferAction(s, { id: "t3", ...draft, to: "cc" })).toMatchObject({ type: "transfer.add", from: "main", to: "cc" });
    expect(transferMessage(s, "main", "cc", 10_000)).toMatch(/^Погашено 100\s₽: Основной счёт → Кредитка$/);
    expect(transferAction(s, { id: "t4", ...draft, to: "main" })).toBeNull();
  });

  it("параметры из окна: правила отчислений и обязательные категории — в модели, повтор — в команде", () => {
    const add = model(base()).add;
    expect(add.saving.purchase).toMatchObject({ enabled: expect.any(Boolean), roundTo: expect.any(Number) });
    expect(add.mandatoryCategories.length).toBeGreaterThan(0);
    const draft = { kind: "expense", amount: 50_000, category: "Аренда", title: "", date: today, mandatory: true, autoSaving: false, repeat: true };
    expect(commandSchema.safeParse({ type: "add", draft }).success).toBe(true);
  });
});

describe("операция из текста СМС (окно «+» → «Из СМС»)", () => {
  it("тот же разбор, что у автоматизации: покупка добавляется, повтор той же СМС — нет", () => {
    const s = applyActions(base(), [{ type: "balance.set", id: "b", date: "2026-10-01", actual: 500_000 }]);
    const text = "СЧЁТ5804 12:00 Покупка 500р LENTA Баланс: 4 500р";
    expect(commandSchema.safeParse({ type: "sms", text }).success).toBe(true);
    const first = smsTextImport(s, text, today, new Date(2026, 9, 10, 12, 30));
    expect(first.txId).toMatch(/^sms-/);
    const next = applyActions(s, first.actions);
    expect(next.transactions.find((t) => t.id === first.txId)).toMatchObject({ type: "expense", amount: 50_000, title: "LENTA" });
    const again = smsTextImport(next, text, today, new Date(2026, 9, 10, 12, 31));
    expect(again.actions).toEqual([]);
    expect(again.message).toBe("Эта операция уже добавлена.");
    expect(smsTextImport(s, "Привет!", today).actions).toEqual([]);
  });
});
