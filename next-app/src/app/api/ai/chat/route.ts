import { z } from "zod";
import { buildAiSystemPrompt, parseAiReply, pickAiMode } from "@/domain/ai";
import { addDays, todayLocal } from "@/domain/dates";
import { isoDateSchema } from "@/domain/schema";
import { AiProviderError, deepseekChat } from "@/server/deepseek";
import { env } from "@/server/env";
import { jsonError, jsonOk, readBody, tooManyRequests, withUser, corsPreflight } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { StoredStateError, loadState, type StoredState } from "@/server/stateStore";

const bodySchema = z.object({
  messages: z
    .array(
      z.object({
        role: z.enum(["user", "assistant"]),
        content: z.string().trim().min(1).max(4000, "Сообщение слишком длинное"),
      }),
    )
    .min(1)
    .max(20)
    .refine((list) => list[list.length - 1].role === "user", "Последнее сообщение должно быть от пользователя"),
  /** auto — сервер сам выбирает модель по вопросу (pickAiMode). */
  mode: z.enum(["auto", "fast", "reasoning"]),
  today: isoDateSchema,
});

export const maxDuration = 200;

/** Запросов к AI в час от всех пользователей вместе — предел расходов на API. */
const AI_REQUESTS_PER_HOUR = 200;

export const OPTIONS = corsPreflight;

export const POST = withUser(async (req, { user }) => {
  if (!env.deepseekApiKey) return jsonError(503, "AI-помощник не настроен на сервере (нет DEEPSEEK_API_KEY).");
  const limit = rateLimit(`ai:${user.id}`, 30, 10 * 60 * 1000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const global = rateLimit("ai:all", AI_REQUESTS_PER_HOUR, 60 * 60 * 1000);
  if (!global.ok) return tooManyRequests(global.retryAfterSeconds);

  const body = await readBody(req, bodySchema, 100_000);
  if (!body.ok) return body.response;
  const serverToday = todayLocal();
  const today = body.data.today;
  if (today < addDays(serverToday, -1) || today > addDays(serverToday, 1)) {
    return jsonError(400, "Дата на устройстве отличается от текущей. Проверьте часы.");
  }

  let state: StoredState["state"];
  try {
    state = loadState(user.id).state;
  } catch (error) {
    if (error instanceof StoredStateError) return jsonError(423, error.message, { code: "state-corrupted" });
    throw error;
  }
  const question = body.data.messages[body.data.messages.length - 1].content;
  const mode = body.data.mode === "auto" ? pickAiMode(question) : body.data.mode;
  const messages = [{ role: "system" as const, content: buildAiSystemPrompt(state, today) }, ...body.data.messages];
  try {
    let reply;
    try {
      reply = await deepseekChat(env.deepseekApiKey, mode, messages);
    } catch (error) {
      // Модель с рассуждением не ответила вовремя — при автоматическом выборе спрашиваем быструю.
      if (!(error instanceof AiProviderError) || error.status !== 504 || mode !== "reasoning" || body.data.mode !== "auto") throw error;
      reply = await deepseekChat(env.deepseekApiKey, "fast", messages);
    }
    const parsed = parseAiReply(reply.text, state, today);
    return jsonOk({
      text: parsed.text || "Готово.",
      proposal: parsed.proposal,
      skipped: parsed.skipped,
      skippedReasons: parsed.skippedReasons,
      reasoning: reply.reasoning,
      model: reply.model,
    });
  } catch (error) {
    if (error instanceof AiProviderError) return jsonError(error.status, error.message);
    throw error;
  }
});
