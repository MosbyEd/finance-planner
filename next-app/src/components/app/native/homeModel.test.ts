import { describe, expect, it } from "vitest";
import type { State } from "@/domain/schema";
import { stateWith, template, tx } from "@/domain/test-utils";
import type { Snapshot } from "@/client/store";
import { applyActions } from "@/domain/actions";
import { accountBalance } from "@/domain/accounts";
import { bankResolveActions } from "../accounts";
import { commandSchema } from "./commands";
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
