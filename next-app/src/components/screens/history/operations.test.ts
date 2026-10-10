import { describe, expect, it } from "vitest";
import type { Transaction } from "@/domain/schema";
import { historyData, type HistoryFilter } from "./operations";

function tx(partial: Partial<Transaction> & Pick<Transaction, "id" | "type" | "amount" | "date">): Transaction {
  return { category: "Продукты", title: "", note: "", ...partial };
}

const today = "2026-10-10";
const month: HistoryFilter = { from: "2026-10-01", to: "2026-10-31", type: "all", query: "", today };

// Покупка с автоотчислением (оно добавляется следом за покупкой), доход и запланированный платёж с отчислением.
const transactions: Transaction[] = [
  tx({ id: "salary", type: "income", amount: 10_000_000, date: "2026-10-05", category: "Зарплата", title: "Зарплата" }),
  tx({ id: "salary.s", type: "saving", amount: 1_500_000, date: "2026-10-05", category: "Сбережения", title: "Отложено с дохода «Зарплата»", linkedTo: "salary" }),
  tx({ id: "coffee", type: "expense", amount: 42_000, date: today, category: "Развлечения", title: "KOFEMANIYA" }),
  tx({ id: "coffee.s", type: "saving", amount: 5_100, date: today, category: "Сбережения", title: "Отложено с покупки «KOFEMANIYA»", linkedTo: "coffee" }),
  tx({ id: "milk", type: "expense", amount: 34_900, date: today, title: "VKUSVILL", mandatory: true }),
  tx({ id: "gift", type: "expense", amount: 1_200_000, date: "2026-10-14", category: "Крупные покупки", title: "Подарок" }),
  tx({ id: "gift.s", type: "saving", amount: 10_000, date: "2026-10-14", category: "Сбережения", title: "Отложено с покупки «Подарок»", linkedTo: "gift" }),
];

const ids = (list: Transaction[]) => list.map((t) => t.id);

describe("historyData", () => {
  it("сворачивает автоотчисление в подпись исходной операции, но учитывает его в итогах", () => {
    const data = historyData(transactions, month);
    expect(ids(data.past)).toEqual(["milk", "coffee", "salary"]);
    expect(ids(data.planned)).toEqual(["gift"]);
    expect(data.totals).toMatchObject({
      income: 10_000_000,
      expense: 76_900,
      mandatory: 34_900,
      savings: 1_505_100,
      net: 10_000_000 - 76_900 - 1_505_100,
    });
    expect(data.plannedNet).toBe(-1_210_000);
  });

  it("не меняет расходы дня", () => {
    const data = historyData(transactions, month);
    expect(data.daySpent.get(today)).toBe(76_900);
    expect(data.daySpent.get("2026-10-14")).toBe(1_200_000);
    expect(data.daySpent.has("2026-10-05")).toBe(false);
  });

  it("с фильтром «Сбережения» показывает автоотчисления строками", () => {
    const data = historyData(transactions, { ...month, type: "saving" });
    expect(ids(data.past)).toEqual(["coffee.s", "salary.s"]);
    expect(ids(data.planned)).toEqual(["gift.s"]);
    expect(data.totals.savings).toBe(1_505_100);
  });

  it("оставляет отчисление строкой, если поиск нашёл его без исходной операции", () => {
    expect(ids(historyData(transactions, { ...month, query: "отложено" }).past)).toEqual(["coffee.s", "salary.s"]);
    // Нашлись обе — отчисление снова в подписи.
    expect(ids(historyData(transactions, { ...month, query: "kofemaniya" }).past)).toEqual(["coffee"]);
  });

  it("оставляет строкой отчисление без исходной операции", () => {
    const orphan = tx({ id: "x.s", type: "saving", amount: 700, date: today, category: "Сбережения", linkedTo: "x" });
    expect(ids(historyData([...transactions, orphan], month).past)).toEqual(["x.s", "milk", "coffee", "salary"]);
  });

  it("с фильтром по типу оставляет в итогах только этот тип", () => {
    const data = historyData(transactions, { ...month, type: "expense" });
    expect(ids(data.past)).toEqual(["milk", "coffee"]);
    expect(data.totals).toMatchObject({ expense: 76_900, savings: 0, net: -76_900 });
  });
});
