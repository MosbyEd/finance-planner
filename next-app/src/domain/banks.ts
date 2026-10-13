import { MAIN_ACCOUNT_ID, accountKeys, accountsOf } from "./accounts";
import type { Account, Bank, State } from "./schema";
import { SMS_NOTE_PREFIX, SMS_PARSERS, normalizeSms, parseKnownSms, smsAccountKeys, type SmsFormat } from "./sms";

/**
 * Банки: от каких отправителей приходят их СМС и какие счета к ним относятся (у счёта — bankId). По банку
 * выбирается разбор СМС (формат у каждого банка свой) и счёт по цифрам карты: у карт разных банков цифры
 * могут совпасть. Пока пользователь не правил банки, список — по умолчанию: Сбербанк (900), если операции
 * из СМС уже приходили (до банков СМС принимались только от него).
 */

export interface KnownBank {
  format: SmsFormat;
  name: string;
  /** Отправители СМС этого банка — подставляются при добавлении. */
  senders: string[];
  /** Банк по названию записи («Сбер», «Альфа») или в тексте СМС. */
  match: RegExp;
}

export const KNOWN_BANKS: KnownBank[] = [
  { format: "sber", name: "Сбербанк", senders: ["900"], match: /сбер|sber/iu },
  { format: "tbank", name: "Т-Банк", senders: ["Tinkoff", "T-Bank"], match: /т-?банк|тинькофф|tinkoff|t-?bank/iu },
  { format: "alfa", name: "Альфа-Банк", senders: ["Alfa-Bank"], match: /альфа|alfa/iu },
  { format: "vtb", name: "ВТБ", senders: ["VTB"], match: /втб|vtb/iu },
];

/** id Сбербанка из списка по умолчанию. */
export const DEFAULT_BANK_ID = "sber";

/** Отправитель для сравнения: регистр, пробелы, дефисы и точки не важны («Alfa-Bank» = «ALFABANK»). */
export function senderKey(sender: string): string {
  return sender
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, "");
}

function hasSmsHistory(state: Pick<State, "transactions">): boolean {
  return state.transactions.some((t) => t.note.startsWith(SMS_NOTE_PREFIX));
}

/** Банки по умолчанию: Сбербанк (900) у тех, кому уже приходили операции из СМС. */
export function defaultBanks(state: Pick<State, "transactions">): Bank[] {
  return hasSmsHistory(state) ? [{ id: DEFAULT_BANK_ID, name: "Сбербанк", senders: ["900"] }] : [];
}

export function banksOf(state: Pick<State, "banks" | "transactions">): Bank[] {
  return state.banks ?? defaultBanks(state);
}

/**
 * Счета, по которым уже приходили СМС (до банков — только от Сбербанка): их цифры были в СМС как цифры
 * счёта операции или на них записан доход или расход из СМС. Начисления регулярных не считаем: у них счёт шаблона.
 */
function smsAccountIds(state: State): Set<string> {
  const keys = new Set<string>();
  const ids = new Set<string>();
  for (const t of state.transactions) {
    if (!t.note.startsWith(SMS_NOTE_PREFIX)) continue;
    const source = smsAccountKeys(t.note.slice(SMS_NOTE_PREFIX.length)).source;
    if (source) keys.add(source);
    if ((t.type === "income" || t.type === "expense") && !t.templateId) ids.add(t.accountId ?? MAIN_ACCOUNT_ID);
  }
  for (const account of accountsOf(state)) if (accountKeys(account).some((k) => keys.has(k))) ids.add(account.id);
  return ids;
}

/** Банк счёта. Пока банки по умолчанию не сохранены — Сбербанк у счетов, по которым приходили СМС. */
export function accountBankId(state: State, account: Account): string | undefined {
  if (state.banks) return account.bankId && state.banks.some((b) => b.id === account.bankId) ? account.bankId : undefined;
  return defaultBanks(state).length && smsAccountIds(state).has(account.id) ? DEFAULT_BANK_ID : undefined;
}

export function bankAccounts(state: State, bankId: string): Account[] {
  return accountsOf(state).filter((a) => accountBankId(state, a) === bankId);
}

/**
 * Банки по умолчанию становятся записями — перед первой правкой банков или банка у счёта; счета, по которым
 * приходили СМС, остаются в Сбербанке. Одинаково на сервере и в приложении: зависит только от данных.
 */
export function withSavedBanks(state: State): State {
  if (state.banks) return state;
  const banks = defaultBanks(state);
  const linked = banks.length ? smsAccountIds(state) : new Set<string>();
  if (!linked.size) return { ...state, banks };
  const accounts = accountsOf(state).map((a) => (linked.has(a.id) && !a.bankId ? { ...a, bankId: DEFAULT_BANK_ID } : a));
  return { ...state, banks, accounts };
}

/** Формат СМС банка: по отправителям (900 — Сбербанк), иначе по названию. null — банк приложению незнаком. */
export function bankFormat(bank: Pick<Bank, "name" | "senders">): SmsFormat | null {
  const senders = new Set(bank.senders.map(senderKey));
  const bySender = KNOWN_BANKS.find((k) => k.senders.some((s) => senders.has(senderKey(s))));
  return (bySender ?? KNOWN_BANKS.find((k) => k.match.test(bank.name)))?.format ?? null;
}

/** СМС этого банка приложение разбирает (есть разбор его формата). */
export function canParseBank(bank: Pick<Bank, "name" | "senders">): boolean {
  const format = bankFormat(bank);
  return format !== null && SMS_PARSERS[format] !== null;
}

/** Какой банк прислал СМС. */
export interface SmsBank {
  /** Запись банка; null — такой банк не заведён. */
  bank: Bank | null;
  /** Формат СМС; null — банк не определён или приложению незнаком. */
  format: SmsFormat | null;
  /** Название для уведомления: банка (из записи или известного) — или null. */
  name: string | null;
}

/**
 * Банк СМС: по отправителю (из «Команд»), по цифрам карты (счёт с ними — в каком-то банке), по формату текста
 * (его разбирает разбор одного из банков), по названию банка в тексте. Отправителя может не быть — прежние
 * автоматизации передают только текст.
 */
export function detectSmsBank(state: State, text: string, sender?: string | null): SmsBank {
  const sms = normalizeSms(text);
  const banks = banksOf(state);
  const ofFormat = (format: SmsFormat) => banks.find((b) => bankFormat(b) === format) ?? null;
  const knownName = (format: SmsFormat) => KNOWN_BANKS.find((k) => k.format === format)?.name ?? null;
  const known = (format: SmsFormat): SmsBank => {
    const bank = ofFormat(format);
    return { bank, format, name: bank?.name ?? knownName(format) };
  };

  const key = sender ? senderKey(sender) : "";
  if (key) {
    // Отправитель из списка банка — или само название банка (контакт «Сбербанк» с номером 900).
    const bank = banks.find((b) => b.senders.some((s) => senderKey(s) === key) || senderKey(b.name) === key);
    if (bank) return { bank, format: bankFormat(bank), name: bank.name };
    const preset = KNOWN_BANKS.find((k) => k.senders.some((s) => senderKey(s) === key));
    if (preset) return known(preset.format);
  }

  // Цифры карты или счёта операции: если они у счетов одного банка — это он.
  const digits = smsAccountKeys(sms).source;
  if (digits) {
    const owners = new Set(
      accountsOf(state)
        .filter((a) => !a.archived && accountKeys(a).includes(digits))
        .map((a) => accountBankId(state, a)),
    );
    const [only] = owners;
    const bank = owners.size === 1 && only ? banks.find((b) => b.id === only) : undefined;
    if (bank) return { bank, format: bankFormat(bank), name: bank.name };
  }

  const parsed = parseKnownSms(sms);
  if (parsed) return known(parsed.format);
  // Название банка в тексте — только чтобы назвать банк в уведомлении: разобрать такую СМС всё равно нечем.
  const mentioned = KNOWN_BANKS.find((k) => k.match.test(sms));
  if (mentioned) return known(mentioned.format);
  return { bank: null, format: null, name: null };
}

/** Уведомление, когда СМС похожа на операцию, но разобрать её не вышло. */
export function unparsedMessage(found: SmsBank, sender?: string | null): string {
  if (found.name) {
    const parser = found.format ? SMS_PARSERS[found.format] : null;
    return parser
      ? `Не разобрали СМС банка «${found.name}»: незнакомый вид сообщения. Добавьте операцию вручную.`
      : `Не разобрали СМС банка «${found.name}»: его СМС приложение пока не умеет разбирать. Добавьте операцию вручную.`;
  }
  const who = sender?.trim();
  return who
    ? `Не разобрали СМС от «${who.slice(0, 40)}»: такого отправителя нет в Настройках → Банки.`
    : "Не разобрали СМС: не удалось понять, от какого она банка. Проверьте отправителей в Настройках → Банки.";
}
