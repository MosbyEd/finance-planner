import { describe, expect, it } from "vitest";
import { applyActions } from "./actions";
import { savingsTotal } from "./metrics";
import { parseSberSms, planSmsImport, smsDate } from "./sms";
import { stateWith, tx } from "./test-utils";

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
