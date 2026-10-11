import { describe, expect, it } from "vitest";
import { accountBalance } from "./accounts";
import { applyActions, isEditableTransaction } from "./actions";
import type { Account, State } from "./schema";
import { addTx, run, stateWith } from "./test-utils";

const sav: Account = { id: "sav", name: "Накопительный", kind: "savings", spending: false };
const card: Account = { id: "sber", name: "Сбербанк", kind: "debit", spending: true };

function base(): State {
  const s = stateWith();
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = true;
  s.settings.purchaseSaving.percent = 10;
  return run(
    s,
    { type: "balance.set", id: "b", date: "2026-10-01", actual: 10_000_000 },
    { type: "account.add", account: sav },
    { type: "account.add", account: card },
  );
}

describe("правка операции: тип можно поменять", () => {
  it("покупка из СМС на самом деле — пополнение накопительного: тот же id, без автоотчисления и отметки «проверить»", () => {
    let s = run(base(), addTx({ type: "expense", amount: 500_000, date: "2026-10-05", title: "Перевод Иван И.", autoSaving: true }));
    const tx = s.transactions.find((t) => t.type === "expense")!;
    s.transactions = s.transactions.map((t) => (t.id === tx.id ? { ...t, review: true as const } : t));
    expect(s.transactions.some((t) => t.linkedTo === tx.id)).toBe(true);

    s = run(s, { type: "tx.move", id: tx.id, date: "2026-10-05", from: "main", to: "sav", amount: 500_000 });
    const moved = s.transactions.find((t) => t.id === tx.id)!;
    expect(moved).toMatchObject({ type: "saving", amount: 500_000, toAccountId: "sav" });
    expect(moved.review).toBeUndefined();
    expect(s.transactions.some((t) => t.linkedTo === tx.id)).toBe(false);
    expect(accountBalance(s, "sav")).toBe(500_000);
  });

  it("перевод — на самом деле покупка; сумму перевода можно поправить", () => {
    let s = run(base(), { type: "transfer.add", id: "t", date: "2026-10-05", from: "main", to: "sber", amount: 300_000, note: "" });
    expect(isEditableTransaction(s.transactions.find((t) => t.id === "t")!)).toBe(true);
    s = run(s, { type: "tx.move", id: "t", date: "2026-10-06", from: "main", to: "sber", amount: 350_000 });
    expect(s.transactions.find((t) => t.id === "t")).toMatchObject({ type: "transfer", amount: 350_000, date: "2026-10-06" });

    s = run(s, { type: "tx.update", id: "t", patch: { type: "expense", category: "Продукты", accountId: "sber", amount: 350_000 } });
    const expense = s.transactions.find((t) => t.id === "t")!;
    expect(expense).toMatchObject({ type: "expense", category: "Продукты", accountId: "sber", amount: 350_000 });
    expect(expense.toAccountId).toBeUndefined();
  });

  it("снятие с накопительного больше, чем там лежит, — ошибка, прежняя операция не меняется", () => {
    const s = run(base(), { type: "savings.move", id: "in", date: "2026-10-02", amount: 200_000, note: "", toAccountId: "sav" });
    const tx = run(s, addTx({ type: "expense", amount: 900_000, date: "2026-10-05" }));
    const id = tx.transactions.at(-1)!.id;
    expect(() => applyActions(tx, [{ type: "tx.move", id, date: "2026-10-05", from: "sav", to: "main", amount: 900_000 }])).toThrow(
      /Нельзя снять больше/,
    );
  });
});
