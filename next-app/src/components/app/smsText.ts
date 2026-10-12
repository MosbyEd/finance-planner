import type { Action } from "@/domain/actions";
import type { IsoDate } from "@/domain/dates";
import type { State } from "@/domain/schema";
import { prepareSmsImport } from "@/domain/smsImport";

export interface SmsTextImport {
  /** Что добавить; пусто — нечего (не операция или уже добавлена), причина — в message. */
  actions: Action[];
  message: string;
  /** Сама операция (для «Отменить»). */
  txId?: string;
}

/** Вставили сами — проверять в «Новых операциях» нечего: снимаем отметку «на проверку». */
function reviewed(action: Action): Action {
  if (action.type === "tx.add" && action.tx.review) {
    const tx = { ...action.tx };
    delete tx.review;
    return { ...action, tx };
  }
  if ("review" in action && action.review) {
    const copy = { ...action };
    delete (copy as { review?: unknown }).review;
    return copy;
  }
  return action;
}

/**
 * Текст СМС, вставленный вручную (окно «+», настройки): тот же разбор, что у автоматизации «Команд», — категория
 * по магазину, счёт по цифрам, сверка остатка и защита от повтора той же СМС.
 */
export function smsTextImport(state: State, text: string, today: IsoDate, now = new Date()): SmsTextImport {
  const time = `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
  const prepared = prepareSmsImport(state, text, { day: today, time });
  const actions = prepared.ops.map((o) => reviewed(o.action));
  const main = actions.find((a) => a.type === "tx.add" || a.type === "savings.move" || a.type === "transfer.add");
  const txId = main ? (main.type === "tx.add" ? main.tx.id : main.id) : undefined;
  return { actions, message: prepared.message, ...(txId ? { txId } : {}) };
}
