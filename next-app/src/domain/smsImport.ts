import type { Action } from "./actions";
import { detectSmsBank, unparsedMessage } from "./banks";
import type { IsoDate } from "./dates";
import type { State } from "./schema";
import { sha256Hex } from "./sha256";
import { SMS_PARSERS, looksLikeOperation, normalizeSms, parseKnownSms, planSmsImport, smsDate, smsNote } from "./sms";

/**
 * Операция из СМС — от текста до готовых изменений. Один код для сервера (СМС пришла запросом) и для разбора
 * на телефоне (без сети): номера изменений одинаковые, поэтому сервер не применит одну СМС дважды, откуда бы
 * она ни пришла.
 */

export interface PreparedSms {
  /**
   * added — добавить; duplicate — уже учтено; ignored — не операция; unparsed — похоже на операцию, но формат
   * не разобран (уведомление называет банк); failed — не добавлено.
   */
  status: "added" | "duplicate" | "ignored" | "unparsed" | "failed";
  /** Короткий текст для уведомления. */
  message: string;
  ops: { opId: string; action: Action }[];
}

/**
 * received — день и время (ЧЧ:ММ), когда СМС пришла на телефон, в часовом поясе пользователя. sender — отправитель
 * из «Команд» («900», «Tinkoff»); по нему определяется банк, без него — по тексту.
 */
export function prepareSmsImport(
  state: State,
  text: string,
  received: { day: IsoDate; time: string },
  sender?: string | null,
): PreparedSms {
  const sms = normalizeSms(text);
  // Сначала банк, потом разбор его форматом. Банк не определён — пробуем все известные форматы.
  const bank = detectSmsBank(state, sms, sender);
  const parse = bank.format ? SMS_PARSERS[bank.format] : null;
  const op = bank.format ? (parse?.(sms) ?? null) : (parseKnownSms(sms)?.op ?? null);
  if (!op) {
    if (!looksLikeOperation(sms)) return { status: "ignored", message: "Не похоже на операцию — пропущено.", ops: [] };
    return { status: "unparsed", message: unparsedMessage(bank, sender), ops: [] };
  }

  const date = smsDate(received.day, received.time, op.time);
  // Один и тот же текст в один день — та же операция: повторный запуск автоматизации её не задвоит.
  const hash = sha256Hex(`${date}|${sms}`);
  const idBase = `sms-${hash.slice(0, 24)}`;
  // Та же СМС уже добавлена отдельной операцией или уже подтвердила запланированный платёж.
  const note = smsNote(sms);
  if (state.transactions.some((t) => t.id === idBase || (t.note === note && t.date === date))) {
    return { status: "duplicate", message: "Эта операция уже добавлена.", ops: [] };
  }

  const plan = planSmsImport(state, op, { idBase, date, sms, ...(bank.bank ? { bankId: bank.bank.id } : {}) });
  // Операция уже учтена (или это не операция) — но остаток из СМС всё равно сверяем.
  if (plan.skip && !plan.actions.length) return { ...plan.skip, ops: [] };
  return {
    status: plan.skip?.status ?? "added",
    message: plan.skip?.message ?? plan.summary,
    ops: plan.actions.map((action, i) => ({ opId: `sms-${hash.slice(0, 30)}-${i}`, action })),
  };
}
