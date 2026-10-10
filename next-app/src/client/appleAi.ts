"use client";

import { buildAiSystemPrompt, parseAiReply, refineLocalProposal, type AiDetail, type AiProposal } from "@/domain/ai";
import type { IsoDate } from "@/domain/dates";
import type { State } from "@/domain/schema";
import type { AiChatMessage } from "./api";
import { appleAiRespond, appleAiStatus, type AppleModel } from "./native";

/**
 * Помощник на модели Apple Intelligence: снимок данных собирается на телефоне, ответ разбирается тем же
 * кодом, что и ответ DeepSeek на сервере. Модель на устройстве работает без интернета.
 */

export class AppleAiError extends Error {}

/**
 * Модель Apple для помощника — та, что на самом телефоне. Русского нет в её официальном списке языков,
 * но отвечает она по-русски; если откажется по языку, пользователь увидит понятную ошибку (language).
 * Private Cloud Compute (iOS 27) не используем: ей нужно управляемое право
 * com.apple.developer.private-cloud-compute, которое Apple выдаёт только платным аккаунтам разработчика.
 */
export async function pickAppleModel(): Promise<{ model: AppleModel; contextSize: number } | null> {
  const status = await appleAiStatus();
  return status.device.available ? { model: "device", contextSize: status.device.contextSize ?? 4096 } : null;
}

const ERRORS: Record<string, string> = {
  refused: "Модель Apple отказалась отвечать на этот вопрос. Переформулируйте его или выберите DeepSeek.",
  language: "Модель Apple на этом iPhone не поддерживает русский язык. Выберите DeepSeek.",
  busy: "Модель Apple сейчас занята — попробуйте через минуту.",
  timeout: "Модель Apple не ответила вовремя. Попробуйте ещё раз.",
  network: "Нет связи с Apple Private Cloud Compute. Проверьте интернет.",
  unavailable: "Модель Apple сейчас недоступна.",
};

/** Последний вопрос и несколько предыдущих реплик — модель на телефоне не помнит переписку сама. */
function buildPrompt(history: AiChatMessage[]): string {
  const last = history.at(-1);
  if (!last) return "";
  const earlier = history.slice(0, -1).slice(-6);
  if (!earlier.length) return last.content;
  const lines = earlier.map((m) => `${m.role === "user" ? "Пользователь" : "Помощник"}: ${m.content.slice(0, 800)}`);
  return `Предыдущий разговор:\n${lines.join("\n")}\n\nНовый вопрос пользователя: ${last.content}`;
}

export async function askApple(
  history: AiChatMessage[],
  state: State,
  today: IsoDate,
): Promise<{ text: string; proposal: AiProposal | null; skipped: number; model: AppleModel }> {
  const picked = await pickAppleModel();
  if (!picked) throw new AppleAiError(ERRORS.unavailable);
  const prompt = buildPrompt(history);
  // Маленький контекст (модель на телефоне) — сразу сжатые данные; не влезли — ещё сжатее.
  const levels: AiDetail[] = picked.contextSize >= 32_000 ? ["full", "compact", "minimal"] : ["compact", "minimal"];
  for (const detail of levels) {
    const reply = await appleAiRespond(picked.model, buildAiSystemPrompt(state, today, detail), prompt);
    if ("text" in reply) {
      const parsed = parseAiReply(reply.text, state, today);
      const proposal = refineLocalProposal(parsed.proposal, history.at(-1)?.content ?? "", state);
      return { text: parsed.text || "Готово.", proposal, skipped: proposal ? parsed.skipped : 0, model: picked.model };
    }
    if (reply.error !== "context") throw new AppleAiError(ERRORS[reply.error] ?? "Модель Apple не смогла ответить. Попробуйте ещё раз.");
  }
  throw new AppleAiError("Вопрос с историей переписки слишком длинный для модели Apple. Очистите чат или выберите DeepSeek.");
}
