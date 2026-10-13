import { Share } from "@capacitor/share";
import { banksOf } from "@/domain/banks";
import type { State } from "@/domain/schema";
import { isNativeApp } from "@/client/runtime";

/** Настройка «Команд» для СМС банков: отправители и задания для Siri. */

/** Отправители СМС всех банков; банков нет — 900 (Сбербанк: до банков СМС принимались только от него). */
export function allSmsSenders(state: Pick<State, "banks" | "transactions">): string[] {
  const senders = banksOf(state).flatMap((b) => b.senders);
  return senders.length ? senders : ["900"];
}

/** «900», «Tinkoff и T-Bank», «900, Tinkoff и Alfa-Bank». */
export function sendersText(senders: string[]): string {
  if (senders.length <= 1) return senders[0] ?? "";
  return `${senders.slice(0, -1).join(", ")} и ${senders.at(-1)}`;
}

function whenLine(senders: string[]): string {
  const who = senders.length > 1 ? `любого из отправителей: ${senders.join(", ")}` : `отправителя ${senders[0] ?? "900"}`;
  return `Когда: я получаю сообщение от ${who}. Запускать сразу, без подтверждения.`;
}

/** Задание для Siri с действием самого приложения: без адреса и ключа — оно входит токеном приложения. */
export function appActionPrompt(senders: string[]): string {
  return [
    "Создай в приложении «Команды» личную автоматизацию.",
    whenLine(senders),
    "Действие: «Добавить операцию из СМС» из приложения «Бюджет»: в поле «Текст СМС» — содержимое полученного сообщения, в поле «Отправитель» — отправитель сообщения.",
  ].join("\n");
}

/** Задание для Siri с запросом к серверу по ключу (без приложения на iPhone). */
export function keyPrompt(url: string, key: string, senders: string[]): string {
  return [
    "Создай в приложении «Команды» личную автоматизацию.",
    whenLine(senders),
    "Действия:",
    `1. «Получить содержимое URL»: адрес ${url}, метод POST, заголовок Authorization со значением «Bearer ${key}», тело запроса JSON с полями text (тип «Текст») — содержимое полученного сообщения и sender (тип «Текст») — отправитель сообщения.`,
    "2. «Получить значение из словаря» по ключу message из ответа.",
    "3. «Показать уведомление» с этим значением.",
  ].join("\n");
}

/** Копирует текст; если буфер обмена недоступен, в приложении открывает «Поделиться» (там есть «Скопировать»). */
export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!isNativeApp()) return false;
    try {
      await Share.share({ text });
      return true;
    } catch {
      return false;
    }
  }
}
