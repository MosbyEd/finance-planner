import { describe, expect, it } from "vitest";
import { applyActions } from "./actions";
import { savingsTotal } from "./metrics";
import { parseSberSms, planSmsImport, smsDate } from "./sms";
import { stateWith, template, tx } from "./test-utils";

const NBSP = " ";

describe("разбор СМС Сбербанка", () => {
  it.each([
    [
      "Счёт карты MIR-7759 18:42 Покупка 300р IP KRAVCHENKO B.A Баланс: 5260.14р",
      { kind: "expense", via: "purchase", amount: 30_000, time: "18:42", counterparty: "IP KRAVCHENKO B.A" },
    ],
    [
      "Счёт карты MIR-7759 19:29 Покупка 162.38р Перекрёсток Баланс: 5097.76р",
      { kind: "expense", via: "purchase", amount: 16_238, time: "19:29", counterparty: "Перекрёсток" },
    ],
    [
      "Счёт карты MIR-7759 12:15 Покупка 127р MIR OBOEV. STACHKI Баланс: 3998.04р",
      { kind: "expense", via: "purchase", amount: 12_700, counterparty: "MIR OBOEV. STACHKI" },
    ],
    [
      "Счёт карты MIR-1750 01:49 Покупка 199р PODPISKA PAKET Баланс: 4125.04р",
      { kind: "expense", via: "purchase", amount: 19_900, time: "01:49", counterparty: "PODPISKA PAKET" },
    ],
    [
      "СЧЁТ5804 19:31 Перевод 800р от Валерия В. Баланс: 5897.76р",
      { kind: "income", via: "transfer", amount: 80_000, time: "19:31", counterparty: "Валерия В." },
    ],
    [
      `СЧЁТ5804 16:14 Зачисление зарплаты 61${NBSP}848.91р Баланс: 62${NBSP}381.16р`,
      { kind: "income", via: "salary", amount: 6_184_891, time: "16:14", counterparty: "" },
    ],
    [
      "СЧЁТ5804 16:14 перевод 8000р Баланс: 54 381.16р",
      { kind: "expense", via: "transfer", amount: 800_000, counterparty: "" },
    ],
    [
      "СЧЁТ5804 16:23 перевод 3000р OZON Баланс: 5560.14р",
      { kind: "expense", via: "transfer", amount: 300_000, counterparty: "OZON" },
    ],
    [
      "СЧЁТ5804 16:16 Оплата 4000р Альфа-банк Баланс: 5560.14р",
      { kind: "expense", via: "payment", amount: 400_000, counterparty: "Альфа-банк" },
    ],
    [
      "СЧЁТ5804 Зачисление средств 45 045р на счёт Накопительный счет *7272. Баланс *5804: 9336.16р. Баланс счёта *7272: 45 068.27р.",
      { kind: "toSavings", amount: 4_504_500, time: null },
    ],
    [
      "Накопительный счет *3150 16:16 Перевод 9501.32р на СЧЁТ5804. Баланс счёта *3150: 0р, баланс *5804: 9560.14р",
      { kind: "fromSavings", amount: 950_132, time: "16:16" },
    ],
    [
      "Накопительный счет *0536 Выплатили проценты 358,90р. Баланс: 358,90р.",
      { kind: "savingsInterest", amount: 35_890, time: null },
    ],
    [
      "Перевод из Т-Банк +5000р от ИВАН И. Баланс: 10000р",
      { kind: "income", via: "transfer", amount: 500_000, counterparty: "ИВАН И." },
    ],
    [
      "СЧЁТ5804 15:31 Перевод по СБП из Альфа-Банк +10р от ЭДУАРД К. Баланс: 4045.04р «Перевод денежных средств»",
      { kind: "income", via: "transfer", amount: 1_000, time: "15:31", counterparty: "ЭДУАРД К." },
    ],
    [
      "Счёт карты MIR-7759 15:27 Перевод по СБП из Альфа-Банк +57р от ЭДУАРД К. Баланс: 4045.04р «Перевод денежных средств»",
      { kind: "income", via: "transfer", amount: 5_700, time: "15:27", counterparty: "ЭДУАРД К." },
    ],
    [
      "Счёт карты MIR-7759 15:20 Пополнение 1000р Баланс: 2000р",
      { kind: "income", via: "deposit", amount: 100_000, time: "15:20", counterparty: "" },
    ],
    [
      "СЧЁТ5804 15:20 Вам перевели 2500р от ЭДУАРД К. Баланс: 3000р",
      { kind: "income", via: "transfer", amount: 250_000, counterparty: "ЭДУАРД К." },
    ],
    [
      "MIR-7759 15:20 Перевод с карты *1234 +1000р Баланс: 2000р",
      { kind: "income", via: "transfer", amount: 100_000 },
    ],
    [
      "MIR-1234 10:00 Выдача 5000р ATM 123456 Баланс: 1000р",
      { kind: "expense", via: "cash", amount: 500_000, counterparty: "" },
    ],
    [
      "MIR-1234 10:00 Возврат покупки 450р PYATEROCHKA Баланс: 1450р",
      { kind: "income", via: "refund", amount: 45_000, counterparty: "PYATEROCHKA" },
    ],
  ])("%s", (sms, expected) => {
    expect(parseSberSms(sms)).toMatchObject(expected);
  });

  it.each([
    "Уважаемый клиент! К карте MIR-7759 подключены привилегии Mir Supreme. Пожалуйста, ознакомьтесь с новыми привилегиями по ссылке s.sber.ru/250KnZ",
    "Код: 123456. Никому не сообщайте его. Вход в СберБанк Онлайн",
    "MIR-7759 10:00 Отказ Покупка 500р PYATEROCHKA. Недостаточно средств",
    "СЧЁТ5804 10:00 Перевод 1000р на СЧЁТ1234 Баланс: 100р",
    "Покупка 10.00 USD AMAZON Баланс: 100р",
    "",
  ])("не операция: %s", (sms) => {
    expect(parseSberSms(sms)).toBeNull();
  });
});

describe("дата операции из СМС", () => {
  it("время СМС заметно позже текущего — операция вчерашняя", () => {
    expect(smsDate("2026-10-10", "00:05", "23:58")).toBe("2026-10-09");
    expect(smsDate("2026-10-10", "12:00", "12:30")).toBe("2026-10-10"); // расхождение часов
    expect(smsDate("2026-10-10", "12:00", "09:00")).toBe("2026-10-10");
    expect(smsDate("2026-10-10", "12:00", null)).toBe("2026-10-10");
  });
});

describe("операции из СМС", () => {
  const ctx = (sms: string) => ({ idBase: "sms-test", date: "2026-10-10", sms });
  const plan = (state: ReturnType<typeof stateWith>, sms: string) => planSmsImport(state, parseSberSms(sms)!, ctx(sms));

  it("покупка: категория по названию магазина, текст СМС — в заметке", () => {
    const sms = "Счёт карты MIR-7759 19:29 Покупка 162.38р Перекрёсток Баланс: 5097.76р";
    const result = plan(stateWith(), sms);
    expect(result.actions).toEqual([
      {
        type: "tx.add",
        tx: expect.objectContaining({
          id: "sms-test",
          type: "expense",
          amount: 16_238,
          category: "Продукты",
          title: "Перекрёсток",
          mandatory: false,
          note: `СМС: ${sms}`,
        }),
      },
    ]);
    expect(result.summary.replace(/\s/g, " ")).toBe("Расход 162,38 ₽ · Перекрёсток → Продукты");
  });

  it("категорию, которую пользователь поставил магазину раньше, берёт из истории", () => {
    const s = stateWith({
      transactions: [tx({ type: "expense", amount: 100, date: "2026-10-01", title: "CHESTNYJ LOSOS", category: "Кафе и рестораны" })],
    });
    const result = plan(s, "Счёт карты MIR-7759 19:35 Покупка 1440р CHESTNYJ LOSOS Баланс: 4457.76р");
    expect(result.actions[0]).toMatchObject({ tx: { category: "Кафе и рестораны" } });
  });

  it("подписка — обязательный расход, если такая категория у пользователя обязательная", () => {
    const result = plan(stateWith(), "Счёт карты MIR-1750 01:49 Покупка 199р PODPISKA PAKET Баланс: 4125.04р");
    expect(result.actions[0]).toMatchObject({ tx: { category: "Подписки", mandatory: true } });
  });

  it("незнакомый магазин — «Другое»; перевод и платёж — без отчисления с покупки", () => {
    expect(plan(stateWith(), "Счёт карты MIR-7759 12:15 Покупка 127р MIR OBOEV. STACHKI Баланс: 3998.04р").actions[0]).toMatchObject({
      tx: { category: "Другое", autoSaving: true },
    });
    expect(plan(stateWith(), "СЧЁТ5804 16:23 перевод 3000р OZON Баланс: 5560.14р").actions[0]).toMatchObject({
      tx: { category: "Переводы", title: "Перевод OZON", autoSaving: false },
    });
    expect(plan(stateWith(), "СЧЁТ5804 16:16 Оплата 4000р Альфа-банк Баланс: 5560.14р").actions[0]).toMatchObject({
      tx: { title: "Альфа-банк", autoSaving: false },
    });
  });

  it("зарплата — с автоотчислением, как при ручном вводе", () => {
    const sms = "СЧЁТ5804 16:14 Зачисление зарплаты 61 848.91р Баланс: 62 381.16р";
    const state = applyActions(stateWith(), plan(stateWith(), sms).actions);
    expect(state.transactions.map((t) => [t.type, t.category, t.amount])).toEqual([
      ["income", "Зарплата", 6_184_891],
      ["saving", "Сбережения", 927_700], // 15%, с округлением до рубля
    ]);
  });

  it("накопительный счёт: пополнение, снятие и проценты меняют сбережения", () => {
    let s = stateWith({ transactions: [tx({ type: "adjustment", amount: 10_000_000, date: "2026-10-01", category: "" })] });
    const sms = [
      "СЧЁТ5804 Зачисление средств 45 045р на счёт Накопительный счет *7272. Баланс *5804: 9336.16р.",
      "Накопительный счет *3150 16:16 Перевод 9501.32р на СЧЁТ5804. Баланс счёта *3150: 0р",
      "Накопительный счет *0536 Выплатили проценты 358,90р. Баланс: 358,90р.",
    ];
    sms.forEach((text, i) => {
      s = applyActions(s, planSmsImport(s, parseSberSms(text)!, { idBase: `sms-${i}`, date: "2026-10-10", sms: text }).actions);
    });
    expect(savingsTotal(s)).toBe(4_504_500 - 950_132 + 35_890);
    expect(s.transactions.find((t) => t.id === "sms-2")).toMatchObject({ type: "income", amount: 35_890 });
  });

  it("снятие с накопительного больше, чем есть в приложении, — ошибка редьюсера", () => {
    const text = "Накопительный счет *3150 16:16 Перевод 9501.32р на СЧЁТ5804. Баланс счёта *3150: 0р";
    const actions = plan(stateWith(), text).actions;
    expect(() => applyActions(stateWith(), actions)).toThrow(/Нельзя снять больше/);
  });
});

describe("сопоставление с запланированными платежами", () => {
  const salary = template({ id: "salary", kind: "income", title: "Зарплата", category: "Зарплата", amount: 9_000_000, dayOfMonth: 25, startDate: "2026-10-01" });
  const phone = template({ id: "phone", kind: "expense", title: "Связь", category: "Связь и интернет", amount: 90_000, dayOfMonth: 20, startDate: "2026-10-01" });
  const rent = template({ id: "rent", kind: "expense", title: "Аренда", category: "Аренда", amount: 4_500_000, dayOfMonth: 20, startDate: "2026-10-01" });

  function importSms(state: ReturnType<typeof stateWith>, sms: string, date: string, idBase = "sms-x") {
    const plan = planSmsImport(state, parseSberSms(sms)!, { idBase, date, sms });
    return { plan, state: applyActions(state, plan.actions) };
  }

  it("зарплата раньше срока: начисление месяца создаётся с фактической суммой, синхронизация его не задваивает", () => {
    const s = stateWith({ templates: [salary] });
    const { plan, state } = importSms(s, "СЧЁТ5804 16:14 Зачисление зарплаты 61 848.91р Баланс: 62 381.16р", "2026-10-24");
    expect(plan.actions[0]).toMatchObject({ type: "occurrence.confirm", templateId: "salary", month: "2026-10", amount: 6_184_891 });
    expect(plan.summary.replace(/\s/g, " ")).toBe("Доход 61 848,91 ₽ · Зарплата — регулярный (по плану 90 000 ₽)");

    const after = applyActions(state, [{ type: "recurring.sync", today: "2026-10-26" }]);
    const occurrences = after.transactions.filter((t) => t.templateId === "salary");
    expect(occurrences).toEqual([
      expect.objectContaining({ id: "salary.2026-10", amount: 6_184_891, date: "2026-10-24", occurrenceMonth: "2026-10", review: true }),
    ]);
    // Автоотчисление с зарплаты — от фактической суммы.
    expect(after.transactions.find((t) => t.linkedTo === "salary.2026-10")?.amount).toBe(927_700);
  });

  it("уже начисленный платёж исправляется на сумму из СМС, второй операции нет", () => {
    const s = applyActions(stateWith({ templates: [phone] }), [{ type: "recurring.sync", today: "2026-10-20" }]);
    expect(s.transactions.find((t) => t.id === "phone.2026-10")?.amount).toBe(90_000);
    const { state } = importSms(s, "СЧЁТ5804 18:00 Оплата 950р Билайн Баланс: 1000р", "2026-10-21");
    const phoneTx = state.transactions.filter((t) => t.templateId === "phone");
    expect(phoneTx).toEqual([expect.objectContaining({ amount: 95_000, date: "2026-10-21", review: true })]);
    expect(state.transactions.filter((t) => t.type === "expense")).toHaveLength(1);
  });

  it("в следующем месяце узнаёт тот же магазин (после проверки), даже если сумма заметно другая", () => {
    let s = stateWith({ templates: [phone] });
    s = importSms(s, "СЧЁТ5804 18:00 Оплата 950р Билайн Баланс: 1000р", "2026-10-20").state;
    const sms = "СЧЁТ5804 18:00 Оплата 1700р Билайн Баланс: 1000р";
    // Пока первое сопоставление не проверено, на нём не учимся: сумма почти вдвое больше плана — отдельная операция.
    expect(importSms(s, sms, "2026-11-19", "sms-y").plan.actions[0]).toMatchObject({ type: "tx.add" });
    s = applyActions(s, [{ type: "tx.reviewed", ids: ["phone.2026-10"] }]);
    const next = importSms(s, sms, "2026-11-19", "sms-y");
    expect(next.plan.actions[0]).toMatchObject({ type: "occurrence.confirm", templateId: "phone", month: "2026-11", amount: 170_000 });
  });

  it("не перезаписывает уже подтверждённое или исправленное начисление", () => {
    let s = applyActions(stateWith({ templates: [phone] }), [{ type: "recurring.sync", today: "2026-10-20" }]);
    s = applyActions(s, [{ type: "tx.update", id: "phone.2026-10", patch: { amount: 95_000 } }]);
    expect(importSms(s, "СЧЁТ5804 18:00 Оплата 900р МТС Баланс: 1000р", "2026-10-22").plan.actions[0]).toMatchObject({ type: "tx.add" });
  });

  it("точная сумма не делает покупку в магазине регулярным платежом", () => {
    const internet = template({ id: "inet", kind: "expense", title: "Интернет", category: "Связь и интернет", amount: 100_000, dayOfMonth: 12, startDate: "2026-10-01" });
    const s = stateWith({ templates: [internet] });
    expect(importSms(s, "Счёт карты MIR-7759 10:00 Покупка 1000р Перекрёсток Баланс: 1р", "2026-10-10").plan.actions[0]).toMatchObject({
      type: "tx.add",
    });
  });

  it("из двух шаблонов зарплаты выбирает ближайший по сроку, прошлый месяц не трогает", () => {
    const advance = template({ id: "adv", kind: "income", title: "Аванс", category: "Зарплата", amount: 4_000_000, dayOfMonth: 10, startDate: "2026-09-01" });
    const pay = template({ id: "pay", kind: "income", title: "Зарплата", category: "Зарплата", amount: 5_000_000, dayOfMonth: 25, startDate: "2026-09-01" });
    const s = applyActions(stateWith({ templates: [advance, pay] }), [{ type: "recurring.sync", today: "2026-10-02" }]);
    const plan = importSms(s, "СЧЁТ5804 12:00 Зачисление зарплаты 45 000р Баланс: 1р", "2026-10-03").plan;
    expect(plan.actions[0]).toMatchObject({ type: "occurrence.confirm", templateId: "adv", month: "2026-10" });
  });

  it("перевод на ту же сумму в день аренды — оплата аренды; покупка без плана — отдельная операция", () => {
    const s = stateWith({ templates: [rent, phone] });
    expect(importSms(s, "СЧЁТ5804 10:00 перевод 45000р Баланс: 100р", "2026-10-20").plan.actions[0]).toMatchObject({
      type: "occurrence.confirm",
      templateId: "rent",
    });
    expect(importSms(s, "Счёт карты MIR-7759 19:29 Покупка 162.38р Перекрёсток Баланс: 5097.76р", "2026-10-20").plan.actions[0]).toMatchObject({
      type: "tx.add",
    });
  });

  it("подтверждённое СМС начисление второй СМС не перезаписывается; далёкая дата не сопоставляется", () => {
    let s = stateWith({ templates: [salary] });
    s = importSms(s, "СЧЁТ5804 16:14 Зачисление зарплаты 61 848.91р Баланс: 1р", "2026-10-24").state;
    expect(importSms(s, "СЧЁТ5804 17:00 Зачисление зарплаты 1000р Баланс: 2р", "2026-10-25", "sms-z").plan.actions[0]).toMatchObject({
      type: "tx.add",
    });
    expect(importSms(stateWith({ templates: [salary] }), "СЧЁТ5804 16:14 Зачисление зарплаты 5000р Баланс: 1р", "2026-10-05").plan.actions[0]).toMatchObject({
      type: "tx.add",
    });
  });

  it("проверка: правка снимает отметку, tx.reviewed снимает её у списка", () => {
    const { state } = importSms(stateWith(), "Счёт карты MIR-7759 19:29 Покупка 162.38р Перекрёсток Баланс: 5097.76р", "2026-10-20");
    expect(state.transactions.find((t) => t.id === "sms-x")?.review).toBe(true);
    const edited = applyActions(state, [{ type: "tx.update", id: "sms-x", patch: { category: "Кафе и рестораны" } }]);
    expect(edited.transactions.find((t) => t.id === "sms-x")?.review).toBeUndefined();
    const confirmed = applyActions(state, [{ type: "tx.reviewed", ids: ["sms-x"] }]);
    expect(confirmed.transactions.find((t) => t.id === "sms-x")).not.toHaveProperty("review");
  });
});

describe("отвязка от регулярного платежа", () => {
  it("операция становится обычной, а начисление возвращается в план", () => {
    const salary = template({ id: "salary", kind: "income", title: "Зарплата", category: "Зарплата", amount: 9_000_000, dayOfMonth: 25, startDate: "2026-10-01" });
    let s = stateWith({ templates: [salary] });
    const sms = "СЧЁТ5804 16:14 Зачисление зарплаты 61 848.91р Баланс: 1р";
    s = applyActions(s, planSmsImport(s, parseSberSms(sms)!, { idBase: "sms-x", date: "2026-10-24", sms }).actions);
    s = applyActions(s, [{ type: "occurrence.detach", id: "salary.2026-10", newId: "plain1" }]);
    expect(s.transactions.find((t) => t.id === "plain1")).toMatchObject({ amount: 6_184_891, date: "2026-10-24" });
    expect(s.transactions.find((t) => t.id === "plain1")).not.toHaveProperty("templateId");
    expect(s.transactions.some((t) => t.templateId === "salary")).toBe(false);
    // В срок синхронизация создаёт плановое начисление заново.
    s = applyActions(s, [{ type: "recurring.sync", today: "2026-10-25" }]);
    expect(s.transactions.find((t) => t.id === "salary.2026-10")).toMatchObject({ amount: 9_000_000 });
    // Автоотчисление — у обычной операции, у плановой — своё.
    expect(s.transactions.filter((t) => t.type === "saving").map((t) => t.linkedTo).sort()).toEqual(["plain1", "salary.2026-10"]);
  });
});
