import { describe, expect, it } from "vitest";
import { pickAiMode } from "./ai";
import type { IsoDate } from "./dates";
import type { State, Transaction } from "./schema";
import {
  ANALYSIS_QUESTION,
  analysisAvailability,
  analysisData,
  analysisMessages,
  analysisPlan,
  availabilityText,
  parseAnalysisReply,
  periodSummaryDue,
  reportHeadline,
  stepEffect,
  tidyText,
  trackingStart,
} from "./spendingAnalysis";
import { stateWith, template, tx } from "./test-utils";

/**
 * Как у пользователя: учёт с 10 октября (выставлен остаток), зарплата 10-го (в «Регулярных» — с 10 ноября,
 * октябрьскую приложение не видело), аванс 25-го, аренда 1-го регулярным платежом.
 */
function setup(extra: Transaction[] = [], options: { start?: IsoDate | null } = {}): State {
  const s = stateWith();
  s.settings.savingsRatePercent = 10;
  s.settings.salarySaving.enabled = false;
  s.settings.purchaseSaving.enabled = false;
  s.templates = [
    template({ id: "salary", kind: "income", amount: 10_000_000, dayOfMonth: 10, startDate: "2026-11-10" }),
    template({ id: "advance", kind: "income", title: "Аванс", category: "Аванс", amount: 5_000_000, dayOfMonth: 25, startDate: "2026-10-25" }),
    template({ id: "rent", kind: "expense", amount: 3_000_000, dayOfMonth: 1, startDate: "2026-09-01" }),
  ];
  const start = options.start === undefined ? "2026-10-10" : options.start;
  s.transactions = [
    ...(start ? [tx({ type: "adjustment", amount: 7_777_700, date: start, category: "" })] : []),
    // Аренда, созданная регулярным платежом задним числом: ни начало учёта, ни «день с тратами».
    tx({ type: "expense", amount: 3_000_000, date: "2026-09-01", category: "Аренда", mandatory: true, templateId: "rent", occurrenceMonth: "2026-09" }),
    tx({ type: "expense", amount: 3_000_000, date: "2026-10-01", category: "Аренда", mandatory: true, templateId: "rent", occurrenceMonth: "2026-10" }),
    ...extra,
  ];
  return s;
}

const groceries = (date: IsoDate) => tx({ type: "expense", amount: 200_000, date, category: "Продукты", title: "Пятёрочка" });

describe("когда открывается анализ", () => {
  it("15 октября, траты в 6 днях: откроется после зарплаты 10 ноября", () => {
    // Две траты в один день — один день; трата с будущей датой и аренда регулярным платежом — не в счёт.
    const days = ["2026-10-10", "2026-10-11", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14", "2026-10-15", "2026-11-01"];
    const s = setup(days.map(groceries));
    expect(trackingStart(s)).toBe("2026-10-10");
    const a = analysisAvailability(s, "2026-10-15");
    expect(a.open).toBe(false);
    expect(a.completed).toEqual([]);
    expect(a.spendingDays).toBe(6);
    expect(a.unlockPeriod).toMatchObject({ start: "2026-10-25", end: "2026-11-09", closing: { date: "2026-11-10", category: "Зарплата" } });
    expect(availabilityText(a, "2026-10-15")).toBe("Откроется после зарплаты 10 ноября · записано 6 дней с тратами из 20");
  });

  it("10 ноября: два полных периода позади и траты в 20 днях — открыт", () => {
    const dates: IsoDate[] = [];
    for (let d = 10; d <= 31; d++) dates.push(`2026-10-${d}`);
    const s = setup(dates.map(groceries));
    expect(analysisAvailability(s, "2026-11-09").open).toBe(false);
    const a = analysisAvailability(s, "2026-11-10");
    expect(a.open).toBe(true);
    expect(a.completed.map((p) => [p.start, p.end])).toEqual([
      ["2026-10-10", "2026-10-24"],
      ["2026-10-25", "2026-11-09"],
    ]);
    expect(a.spendingDays).toBe(22);
  });

  it("периоды позади, а дней с тратами мало — ждём дни", () => {
    const s = setup(["2026-10-12", "2026-10-20", "2026-11-02"].map(groceries));
    const a = analysisAvailability(s, "2026-11-10");
    expect(a.open).toBe(false);
    expect(a.completed).toHaveLength(2);
    expect(availabilityText(a, "2026-11-10")).toBe(
      "Откроется, когда траты будут записаны в 20 разных днях · сейчас записано 3 дня с тратами из 20",
    );
  });

  it("учёт начат в середине периода — первый полный период со следующей выплаты", () => {
    const s = setup([groceries("2026-10-16")], { start: null });
    expect(trackingStart(s)).toBe("2026-10-16");
    const a = analysisAvailability(s, "2026-10-20");
    expect(a.unlockPeriod).toMatchObject({ start: "2026-11-10", end: "2026-11-24", closing: { date: "2026-11-25" } });
    expect(availabilityText(a, "2026-10-20")).toBe("Откроется после аванса 25 ноября · записан 1 день с тратами из 20");
  });

  it("начали через день-два после зарплаты — период всё равно полный", () => {
    const s = setup([groceries("2026-10-12")], { start: null });
    expect(analysisAvailability(s, "2026-10-13").unlockPeriod?.closing?.date).toBe("2026-11-10");
  });

  it("зарплата пришла СМС накануне, а регулярный платёж записал её в свой день — одна граница, не период в день", () => {
    const dates: IsoDate[] = [];
    for (let d = 10; d <= 31; d++) dates.push(`2026-10-${d}`);
    const s = setup([
      ...dates.map(groceries),
      tx({ type: "income", amount: 9_000_000, date: "2026-11-09", category: "Зарплата", title: "Зарплата" }),
      tx({ type: "income", amount: 10_000_000, date: "2026-11-10", category: "Зарплата", title: "Зарплата", templateId: "salary", occurrenceMonth: "2026-11" }),
    ]);
    const a = analysisAvailability(s, "2026-11-12");
    expect(a.completed.map((p) => [p.start, p.end])).toEqual([
      ["2026-10-10", "2026-10-24"],
      ["2026-10-25", "2026-11-08"],
    ]);
  });

  it("бюджет по календарному месяцу — периоды месяцы; октябрь неполный", () => {
    const s = setup([groceries("2026-10-12")]);
    s.settings.budgetPeriod = "month";
    const a = analysisAvailability(s, "2026-10-13");
    expect(a.periodKind).toBe("month");
    expect(a.unlockPeriod).toMatchObject({ start: "2026-12-01", end: "2026-12-31", closing: null });
    expect(availabilityText(a, "2026-10-13")).toBe("Откроется 1 января 2027 · записан 1 день с тратами из 20");
  });
});

/** Траты двух периодов: 10–24 октября (15 дней) и 25 октября – 9 ноября (16 дней). */
function spending(): State {
  const expense = (date: IsoDate, amount: number, category: string, title: string, extra: Partial<Transaction> = {}) =>
    tx({ type: "expense", amount, date, category, title, ...extra });
  const list: Transaction[] = [
    ...["2026-10-12", "2026-10-15", "2026-10-20", "2026-10-26", "2026-10-29", "2026-11-02", "2026-11-06"].map((d) =>
      expense(d, 200_000, "Продукты", "Пятёрочка"),
    ),
    ...["2026-10-13", "2026-10-17"].map((d) => expense(d, 150_000, "Такси", "Яндекс Такси")),
    ...["2026-10-25", "2026-10-27", "2026-10-28", "2026-10-30", "2026-11-01", "2026-11-03", "2026-11-05", "2026-11-08"].map((d) =>
      expense(d, 150_000, "Такси", "ЯНДЕКС ТАКСИ"),
    ),
    ...["2026-10-14", "2026-10-16", "2026-10-21", "2026-10-22", "2026-10-23", "2026-10-31", "2026-11-04", "2026-11-07", "2026-11-09", "2026-11-02"].map(
      (d) => expense(d, 25_000, "Кафе", "Кофейня", { note: "Покупка 250р КОФЕЙНЯ Баланс 12345,67р" }),
    ),
    expense("2026-11-04", 500_000, "Переводы", "Перевод Иван И."),
    expense("2026-10-20", 500_000, "Долги", "Погашение: Кредитная карта", { mandatory: true }),
    tx({ type: "income", amount: 5_000_000, date: "2026-10-25", category: "Аванс", title: "Аванс", templateId: "advance", occurrenceMonth: "2026-10" }),
    tx({ type: "expense", amount: 3_000_000, date: "2026-11-01", category: "Аренда", mandatory: true, templateId: "rent", occurrenceMonth: "2026-11" }),
  ];
  return setup(list);
}

describe("агрегаты для разбора", () => {
  const s = spending();
  const a = analysisAvailability(s, "2026-11-10");
  const plan = analysisPlan(a, "analysis");
  if (!plan) throw new Error("анализ должен быть открыт");
  const d = analysisData(s, plan, "2026-11-10");

  it("разбор — по двум последним полным периодам", () => {
    expect(a.open).toBe(true);
    expect([d.from, d.to, d.days]).toEqual(["2026-10-10", "2026-11-09", 31]);
    expect(d.previous).toMatchObject({ start: "2026-10-10", end: "2026-10-24", days: 15, flexible: 1_025_000 });
    expect(d.last).toMatchObject({ start: "2026-10-25", end: "2026-11-09", days: 16, flexible: 2_625_000, mandatory: 3_000_000 });
    // Октябрьской зарплаты в приложении нет — сколько было на период, неизвестно: бюджет не придумываем.
    expect(d.previous.budget).toBeNull();
    expect(d.last.budget).toBeGreaterThan(0);
  });

  it("категории, мелкие траты, магазины", () => {
    expect(d.flexible).toBe(3_650_000);
    expect(d.categories.map((c) => [c.name, c.amount, c.count])).toEqual([
      ["Такси", 1_500_000, 10],
      ["Продукты", 1_400_000, 7],
      ["Переводы", 500_000, 1],
      ["Кафе", 250_000, 10],
    ]);
    expect(d.categories[0].perDay).toBe(48_387);
    expect(d.mandatoryCategories.map((c) => [c.name, c.amount])).toEqual([
      ["Аренда", 3_000_000],
      ["Долги", 500_000],
    ]);
    expect(d.small).toMatchObject({ amount: 250_000, count: 10, categories: [{ category: "Кафе", count: 10, amount: 250_000 }] });
    // «Яндекс Такси» и «ЯНДЕКС ТАКСИ» — один магазин; перевод человеку, погашение кредита и аренда — не магазины.
    expect(d.merchants.map((m) => [m.name, m.amount, m.count])).toEqual([
      ["ЯНДЕКС ТАКСИ", 1_500_000, 10],
      ["Пятёрочка", 1_400_000, 7],
      ["Кофейня", 250_000, 10],
    ]);
  });

  it("будни против выходных и дни без трат", () => {
    // Выходные: 10, 11, 17, 18, 24, 25, 31 октября, 1, 7, 8 ноября — траты 6 500 ₽ за 10 дней.
    expect(d.week).toMatchObject({ weekendDays: 10, weekdays: 21, weekendPerDay: 65_000, weekdayPerDay: 142_857 });
    expect(d.week.weekendCategories[0]).toEqual({ category: "Такси", perDay: 60_000 });
    expect(d.daily).toHaveLength(31);
    expect(d.quietDays).toBe(5);
  });

  it("изменения — в среднем за день: периоды разной длины", () => {
    expect(d.changes[0]).toEqual({ category: "Такси", before: 20_000, after: 75_000 });
    expect(d.changes.find((c) => c.category === "Переводы")).toEqual({ category: "Переводы", before: 0, after: 31_250 });
  });

  it("в модель — только агрегаты: без текстов СМС, остатков и имён из переводов", () => {
    const prompt = JSON.stringify(analysisMessages(d));
    expect(prompt).toContain("Такси");
    expect(prompt).not.toMatch(/12345|Баланс/);
    expect(prompt).not.toMatch(/77777|7777700/);
    expect(prompt).not.toContain("Иван");
    expect(prompt).not.toContain("Пятёрочка\",\"total\":14000,\"purchases\":7,\"category\":\"Продукты\",\"note");
  });

  it("эффект шага считает приложение: такси −30% → +150 ₽ в день к лимиту", () => {
    // 15 000 ₽ за 31 день ≈ 484 ₽ в день; 30% ≈ 145 ₽ — до десятков рублей.
    expect(stepEffect(d, "такси", 30)).toEqual({ perDay: 15_000, perPeriod: 15_000 * d.periodDays });
    // 2 500 ₽ за 31 день ≈ 81 ₽ в день; половина ≈ 40 ₽ — до рубля.
    expect(stepEffect(d, "Кофейня", 50)).toEqual({ perDay: 4_000, perPeriod: 4_000 * d.periodDays });
    expect(stepEffect(d, "Ресторан", 30)).toBeNull();
    expect(stepEffect(d, null, 30)).toBeNull();
  });

  it("ответ модели: JSON в обёртке, шаги с эффектом, лишнее отброшено", () => {
    const reply = `Вот разбор:\n\`\`\`json\n${JSON.stringify({
      summary: "Больше всего уходит на такси. Продукты — стабильно.",
      where: ["Такси — 41% повседневных", "Кофе 10 раз"],
      changes: ["Такси выросло почти вчетверо"],
      steps: [
        { title: "Такси — реже", target: "Такси", cutPercent: 30, why: "Часть поездок — на метро" },
        { title: "Кофе с собой", target: "Кофейня", cutPercent: "150", why: "" },
        { title: "Готовить дома", target: "Рестораны", cutPercent: 20, why: "Нет в данных" },
        { title: "", target: "Такси", cutPercent: 10, why: "без названия" },
      ],
    })}\n\`\`\``;
    const r = parseAnalysisReply(reply, d, { model: "deepseek-reasoner", createdAt: 1 });
    expect(r.summary).toBe("Больше всего уходит на такси. Продукты — стабильно.");
    expect(r.where).toHaveLength(2);
    expect(r.steps).toEqual([
      expect.objectContaining({ title: "Такси — реже", cutPercent: 30, effectPerDay: 15_000 }),
      // Сократить больше чем на 100% нельзя.
      expect.objectContaining({ title: "Кофе с собой", cutPercent: 100, effectPerDay: 8_100 }),
      expect.objectContaining({ title: "Готовить дома", effectPerDay: null, effectPerPeriod: null }),
    ]);
    expect(reportHeadline(r)).toBe("Больше всего уходит на такси.");
  });

  it("числа в тексте модели не рвутся на строки", () => {
    expect(tidyText("Ушло 35 190 ₽, это 1 234 567 ₽ и 58 % — в 2025 году 3 раза")).toBe(
      "Ушло 35\u00a0190\u00a0₽, это 1\u00a0234\u00a0567\u00a0₽ и 58\u00a0% — в 2025 году 3 раза",
    );
  });

  it("не JSON — весь текст становится итогом", () => {
    const r = parseAnalysisReply("Траты в норме, такси можно сократить.", d, { model: "x", createdAt: 1 });
    expect(r).toMatchObject({ summary: "Траты в норме, такси можно сократить.", where: [], steps: [] });
  });

  it("анализ и итоги периода спрашивают модель с рассуждением", () => {
    expect(pickAiMode(ANALYSIS_QUESTION.analysis)).toBe("reasoning");
    expect(pickAiMode(ANALYSIS_QUESTION.period)).toBe("reasoning");
  });
});

describe("итоги периода после зарплаты или аванса", () => {
  it("нужны один раз на период — и только когда анализ открыт", () => {
    const s = spending();
    expect(periodSummaryDue(analysisAvailability(s, "2026-11-09"), [])).toBeNull();
    const a = analysisAvailability(s, "2026-11-10");
    const due = periodSummaryDue(a, []);
    expect(due).toMatchObject({ kind: "period", from: "2026-10-25", to: "2026-11-09" });
    expect(periodSummaryDue(a, [{ kind: "analysis", from: "2026-10-25" }])).not.toBeNull();
    expect(periodSummaryDue(a, [{ kind: "period", from: "2026-10-25" }])).toBeNull();
  });

  it("итоги — по последнему периоду, изменения — к прошлому", () => {
    const s = spending();
    const plan = periodSummaryDue(analysisAvailability(s, "2026-11-10"), []);
    if (!plan) throw new Error("итоги должны быть нужны");
    const d = analysisData(s, plan, "2026-11-10");
    expect([d.from, d.to, d.days, d.flexible]).toEqual(["2026-10-25", "2026-11-09", 16, 2_625_000]);
    expect(d.changes[0]).toEqual({ category: "Такси", before: 20_000, after: 75_000 });
    const r = parseAnalysisReply(
      JSON.stringify({ summary: "За период ушло 26 250 ₽.", where: ["лишнее"], changes: ["Такси выросло"], steps: [{ title: "a", target: "Такси", cutPercent: 20 }, { title: "b" }, { title: "c" }] }),
      d,
      { model: "m", createdAt: 1 },
    );
    expect(r.where).toEqual([]);
    expect(r.steps).toHaveLength(2);
  });
});
