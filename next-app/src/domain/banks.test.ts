import { existsSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { findAccount } from "./accounts";
import { applyActions } from "./actions";
import {
  GENERIC_SHORTCUT,
  KNOWN_BANKS,
  accountBankId,
  bankFormat,
  bankShortcut,
  banksOf,
  canParseBank,
  detectSmsBank,
  senderKey,
  withSavedBanks,
} from "./banks";
import type { Account, Bank } from "./schema";
import { SMS_NOTE_PREFIX, looksLikeOperation } from "./sms";
import { prepareSmsImport } from "./smsImport";
import { stateWith, tx } from "./test-utils";

const SBER_SMS = "Счёт карты MIR-7759 19:29 Покупка 162.38р Перекрёсток Баланс: 5097.76р";
// Вид СМС других банков — для определения банка; их разбора пока нет.
const TBANK_SMS = "Покупка, карта *4321. 500 RUB. PYATEROCHKA. Доступно 10000 RUB";
const ALFA_SMS = "Покупка 500,00 RUR, Карта *1111, MAGNIT, Баланс: 9500,00 RUR";
const received = { day: "2026-10-13" as const, time: "19:30" };

const sber: Bank = { id: "sber", name: "Сбербанк", senders: ["900"] };
const tbank: Bank = { id: "tb", name: "Т-Банк", senders: ["Tinkoff", "T-Bank"] };
const accounts: Account[] = [
  { id: "main", name: "Карта Сбер", kind: "debit", spending: true, cards: [{ digits: "7759", name: "" }], bankId: "sber" },
  { id: "savings", name: "Сбережения", kind: "savings", spending: false },
  { id: "tcard", name: "Карта Т", kind: "debit", spending: true, cards: [{ digits: "4321", name: "" }], bankId: "tb" },
];
const withBanks = () => stateWith({ banks: [sber, tbank], accounts });
/** Пришла хотя бы одна операция из СМС — значит, СМС уже настроены. */
const smsTx = (note: string, accountId?: string) =>
  tx({ type: "expense", amount: 100, date: "2026-10-01", note: `${SMS_NOTE_PREFIX}${note}`, ...(accountId ? { accountId } : {}) });

describe("банки по умолчанию", () => {
  it("СМС уже приходили — Сбербанк с 900, а счета, по которым они приходили, — в нём", () => {
    const s = stateWith({
      accounts: [
        { id: "main", name: "Основной", kind: "debit", spending: true },
        { id: "savings", name: "Сбережения", kind: "savings", spending: false },
        { id: "dep", name: "Накопительный", kind: "savings", spending: false, number: "3150" },
        { id: "alfa", name: "Альфа", kind: "credit", spending: false },
      ],
      transactions: [smsTx("Покупка 100р LENTA"), smsTx("Накопительный счет *3150 10:52 Перевод 482.57р на СЧЁТ5804")],
    });
    expect(banksOf(s)).toEqual([{ id: "sber", name: "Сбербанк", senders: ["900"] }]);
    expect(accountBankId(s, findAccount(s, "main")!)).toBe("sber");
    expect(accountBankId(s, findAccount(s, "dep")!)).toBe("sber");
    expect(accountBankId(s, findAccount(s, "alfa")!)).toBeUndefined();

    // Первая правка банков сохраняет их вместе со связями счетов.
    const saved = withSavedBanks(s);
    expect(saved.banks).toEqual([sber]);
    expect(saved.accounts?.filter((a) => a.bankId === "sber").map((a) => a.id)).toEqual(["main", "dep"]);
  });

  it("СМС не приходили — банков нет", () => {
    expect(banksOf(stateWith())).toEqual([]);
  });

  it("удалили все банки — Сбербанк по умолчанию не возвращается", () => {
    const s = applyActions(stateWith({ transactions: [smsTx("Покупка 100р LENTA")] }), [{ type: "bank.delete", id: "sber" }]);
    expect(banksOf(s)).toEqual([]);
  });
});

describe("формат банка", () => {
  it("по отправителю или названию", () => {
    expect(bankFormat({ name: "Мой банк", senders: ["900"] })).toBe("sber");
    expect(bankFormat({ name: "Сбер", senders: [] })).toBe("sber");
    expect(bankFormat({ name: "Тинькофф", senders: ["tinkoff"] })).toBe("tbank");
    expect(bankFormat({ name: "Почта Банк", senders: ["PochtaBank"] })).toBeNull();
    expect(canParseBank(sber)).toBe(true);
    expect(canParseBank(tbank)).toBe(false);
  });

  it("отправители сравниваются без регистра, пробелов и дефисов", () => {
    expect(senderKey("Alfa-Bank")).toBe(senderKey("ALFABANK"));
    expect(senderKey("T-Bank")).toBe(senderKey("t bank"));
  });
});

describe("какой банк прислал СМС", () => {
  it("по отправителю — даже если текст похож на другой банк", () => {
    expect(detectSmsBank(withBanks(), SBER_SMS, "900").bank?.id).toBe("sber");
    expect(detectSmsBank(withBanks(), TBANK_SMS, "TINKOFF").bank?.id).toBe("tb");
    // Контакт «Сбербанк» с номером 900: «Команды» передают имя контакта.
    expect(detectSmsBank(withBanks(), SBER_SMS, "Сбербанк").bank?.id).toBe("sber");
  });

  it("известный отправитель без записи банка — банк по названию", () => {
    expect(detectSmsBank(withBanks(), ALFA_SMS, "Alfa-Bank")).toEqual({ bank: null, format: "alfa", name: "Альфа-Банк" });
  });

  it("без отправителя — по цифрам карты (счёт в банке), по формату, по названию в тексте", () => {
    expect(detectSmsBank(withBanks(), TBANK_SMS).bank?.id).toBe("tb");
    expect(detectSmsBank(withBanks(), "Счёт карты MIR-9999 19:29 Покупка 100р LENTA").bank?.id).toBe("sber");
    expect(detectSmsBank(withBanks(), "Альфа-Банк: покупка на 500 RUR").name).toBe("Альфа-Банк");
    expect(detectSmsBank(withBanks(), "Покупка: 500 RUR, карта *0000")).toEqual({ bank: null, format: null, name: null });
  });

  it("одинаковые цифры у счетов разных банков — по цифрам банк не определить", () => {
    const s = stateWith({
      banks: [sber, tbank],
      accounts: [accounts[0], { ...accounts[2], cards: [{ digits: "7759", name: "" }] }],
    });
    expect(detectSmsBank(s, "Покупка: 500 RUB, карта *7759").bank).toBeNull();
  });
});

describe("СМС других банков: уведомление вместо тишины", () => {
  it("банк без разбора — «не разобрали СМС банка X»", () => {
    const result = prepareSmsImport(withBanks(), TBANK_SMS, received, "Tinkoff");
    expect(result).toMatchObject({ status: "unparsed", ops: [] });
    expect(result.message).toMatch(/Не разобрали СМС банка «Т-Банк»/);
  });

  it("незнакомый вид СМС Сбербанка — «не разобрали СМС банка «Сбербанк»", () => {
    const result = prepareSmsImport(withBanks(), "Сбербанк: с карты MIR-7759 списано 500р", received, "900");
    expect(result.status).toBe("unparsed");
    expect(result.message).toMatch(/Не разобрали СМС банка «Сбербанк»: незнакомый вид/);
  });

  it("незнакомый отправитель — подсказка про Настройки → Банки", () => {
    const result = prepareSmsImport(withBanks(), "Покупка: 500 RUB, карта *0000", received, "PochtaBank");
    expect(result).toMatchObject({ status: "unparsed" });
    expect(result.message).toMatch(/от «PochtaBank».*Настройках → Банки/);
  });

  it("не операция (код, реклама) — по-прежнему просто пропускается", () => {
    expect(prepareSmsImport(withBanks(), "Код для входа: 1234. Никому не сообщайте", received, "Tinkoff").status).toBe("ignored");
    expect(prepareSmsImport(withBanks(), "Привет!", received).status).toBe("ignored");
    expect(looksLikeOperation(TBANK_SMS)).toBe(true);
    expect(looksLikeOperation("Ваш код 4512")).toBe(false);
  });

  it("СМС Сбербанка с отправителем и без — та же операция (те же номера изменений)", () => {
    const withSender = prepareSmsImport(withBanks(), SBER_SMS, received, "900");
    const withoutSender = prepareSmsImport(withBanks(), SBER_SMS, received);
    expect(withSender.status).toBe("added");
    expect(withSender.ops).toEqual(withoutSender.ops);
  });

  it("банков нет — СМС Сбербанка разбирается, как раньше", () => {
    expect(prepareSmsImport(stateWith(), SBER_SMS, received).status).toBe("added");
    expect(prepareSmsImport(stateWith(), SBER_SMS, received, "900").status).toBe("added");
  });
});

describe("счёт операции — по цифрам карты с учётом банка", () => {
  const twoBanks = () =>
    stateWith({
      banks: [sber, { id: "other", name: "Мой банк", senders: ["MYBANK"] }],
      accounts: [
        { id: "main", name: "Основной", kind: "debit", spending: true },
        { id: "savings", name: "Сбережения", kind: "savings", spending: false },
        { id: "s1", name: "Сбер 1234", kind: "debit", spending: true, cards: [{ digits: "1234", name: "" }], bankId: "sber" },
        { id: "o1", name: "Другой 1234", kind: "debit", spending: true, cards: [{ digits: "1234", name: "" }], bankId: "other" },
      ],
    });
  const sms = "Счёт карты MIR-1234 19:29 Покупка 162.38р Перекрёсток";
  const added = (sender: string) => {
    const result = prepareSmsImport(twoBanks(), sms, received, sender);
    const add = result.ops.find((o) => o.action.type === "tx.add")?.action;
    return add?.type === "tx.add" ? add.tx.accountId : undefined;
  };

  it("одни и те же цифры у карт двух банков — счёт банка, приславшего СМС", () => {
    expect(added("900")).toBe("s1");
  });

  it("у счетов одного банка одинаковые цифры нельзя, у разных банков — можно", () => {
    expect(() => twoBanks()).not.toThrow();
    expect(() =>
      applyActions(twoBanks(), [{ type: "account.update", id: "o1", patch: { bankId: "sber" } }]),
    ).toThrow(/1234 уже указаны у счёта «Сбер 1234» этого банка/);
  });

  it("цифры незнакомы, а у банка один счёт — операция на него, а не на основной", () => {
    const s = stateWith({
      banks: [sber, tbank],
      accounts: [
        { id: "main", name: "Основной", kind: "debit", spending: true },
        { id: "savings", name: "Сбережения", kind: "savings", spending: false },
        { id: "sc", name: "Карта Сбер", kind: "debit", spending: true, cards: [{ digits: "7759", name: "" }], bankId: "sber" },
      ],
    });
    const result = prepareSmsImport(s, "Счёт карты MIR-5555 19:29 Покупка 100р LENTA", received, "900");
    const add = result.ops.find((o) => o.action.type === "tx.add")?.action;
    expect(add?.type === "tx.add" && add.tx.accountId).toBe("sc");
  });
});

describe("правка банков", () => {
  it("добавить банк со счетами, поменять отправителей и счета, удалить", () => {
    let s = applyActions(stateWith({ accounts }), [
      { type: "bank.add", bank: { id: "alfa", name: "Альфа-Банк", senders: [" Alfa-Bank ", "ALFABANK", ""] }, accountIds: ["tcard"] },
    ]);
    expect(s.banks).toEqual([{ id: "alfa", name: "Альфа-Банк", senders: ["Alfa-Bank"] }]);
    expect(findAccount(s, "tcard")?.bankId).toBe("alfa");

    s = applyActions(s, [{ type: "bank.update", id: "alfa", patch: { senders: ["Alfa-Bank", "AlfaBank SMS"] }, accountIds: ["main"] }]);
    expect(s.banks?.[0].senders).toEqual(["Alfa-Bank", "AlfaBank SMS"]);
    expect(findAccount(s, "main")?.bankId).toBe("alfa");
    expect(findAccount(s, "tcard")?.bankId).toBeUndefined();

    s = applyActions(s, [{ type: "bank.delete", id: "alfa" }]);
    expect(s.banks).toEqual([]);
    expect(findAccount(s, "main")?.bankId).toBeUndefined();
  });

  it("отправитель — только у одного банка, названия не повторяются", () => {
    const s = stateWith({ banks: [sber], accounts });
    expect(() => applyActions(s, [{ type: "bank.add", bank: { id: "x", name: "Другой", senders: ["900"] } }])).toThrow(
      /Отправитель «900» уже указан у банка «Сбербанк»/,
    );
    expect(() => applyActions(s, [{ type: "bank.add", bank: { id: "x", name: "СБЕРБАНК", senders: [] } }])).toThrow(/уже есть/);
  });

  it("первая правка — банки по умолчанию сохраняются, Сбербанк остаётся", () => {
    const s = stateWith({ transactions: [smsTx("Покупка 100р LENTA")] });
    const next = applyActions(s, [{ type: "bank.add", bank: tbank }]);
    expect(next.banks?.map((b) => b.id)).toEqual(["sber", "tb"]);
    // Счёт, по которому приходили СМС, — по-прежнему в Сбербанке.
    expect(findAccount(next, "main")?.bankId).toBe("sber");
  });

  it("банк счёта: несуществующий нельзя", () => {
    expect(() => applyActions(withBanks(), [{ type: "account.update", id: "main", patch: { bankId: "nope" } }])).toThrow(/Банк не найден/);
  });
});

describe("команда «Команд» для банка", () => {
  it("у известного банка — своя команда с его отправителями, у незнакомого — нет", () => {
    expect(bankShortcut(tbank)).toEqual({ name: "Бюджет СМС Т-Банк", senders: ["Tinkoff", "T-Bank"] });
    expect(bankShortcut({ name: "Мой банк", senders: ["900"] })).toEqual({ name: "Бюджет СМС Сбербанк", senders: ["900"] });
    expect(bankShortcut({ name: "Почта Банк", senders: ["PochtaBank"] })).toBeNull();
  });

  it("подписанные команды есть в пакете приложения — общая и для каждого известного банка", () => {
    const file = (name: string) => `ios/App/App/Shortcuts/${name}.shortcut`;
    expect(existsSync(file(GENERIC_SHORTCUT))).toBe(true);
    for (const bank of KNOWN_BANKS) expect(existsSync(file(bankShortcut(bank)!.name)), bank.name).toBe(true);
  });
});
