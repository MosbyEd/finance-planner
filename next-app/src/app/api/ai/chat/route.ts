import { z } from "zod";
import { buildAiSystemPrompt, parseAiReply, pickAiMode } from "@/domain/ai";
import { addDays, todayLocal, type IsoDate } from "@/domain/dates";
import { isoDateSchema, type State } from "@/domain/schema";
import {
  ANALYSIS_QUESTION,
  analysisAvailability,
  analysisData,
  analysisMessages,
  analysisPlan,
  availabilityText,
  parseAnalysisReply,
  reportHeadline,
  type AnalysisKind,
} from "@/domain/spendingAnalysis";
import { findReport, saveReport } from "@/server/aiReports";
import { AiProviderError, deepseekChat, type AiMode, type ChatMessage } from "@/server/deepseek";
import { env } from "@/server/env";
import { jsonError, jsonOk, readBody, tooManyRequests, withUser, corsPreflight } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { StoredStateError, loadState } from "@/server/stateStore";

const modeSchema = z.enum(["auto", "fast", "reasoning"]);

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
  mode: modeSchema,
  today: isoDateSchema,
});

/**
 * Анализ трат: агрегаты сервер считает сам по сохранённым данным, модели уходят только они.
 * auto — итоги периода, о которых приложение просит само после зарплаты или аванса: если их пока не нужно
 * (анализ не открыт или итоги уже есть), ответ «silent» — без уведомления.
 */
const analysisSchema = z.object({
  analysis: z.object({ kind: z.enum(["analysis", "period"]), auto: z.boolean().optional() }),
  mode: modeSchema.default("auto"),
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

  const body = await readBody(
    req,
    (raw) => (raw && typeof raw === "object" && "analysis" in raw ? analysisSchema : bodySchema),
    100_000,
  );
  if (!body.ok) return body.response;
  const serverToday = todayLocal();
  const today = body.data.today;
  if (today < addDays(serverToday, -1) || today > addDays(serverToday, 1)) {
    return jsonError(400, "Дата на устройстве отличается от текущей. Проверьте часы.");
  }

  let state: State;
  try {
    state = loadState(user.id).state;
  } catch (error) {
    if (error instanceof StoredStateError) return jsonError(423, error.message, { code: "state-corrupted" });
    throw error;
  }
  try {
    if ("analysis" in body.data) {
      const { kind, auto = false } = body.data.analysis;
      return await analysisReply(user.id, state, today, kind, auto, body.data.mode);
    }
    const question = body.data.messages[body.data.messages.length - 1].content;
    const mode = body.data.mode === "auto" ? pickAiMode(question) : body.data.mode;
    const messages = [{ role: "system" as const, content: buildAiSystemPrompt(state, today) }, ...body.data.messages];
    const reply = await ask(mode, body.data.mode === "auto", messages);
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

async function ask(mode: AiMode, auto: boolean, messages: ChatMessage[]) {
  try {
    return await deepseekChat(env.deepseekApiKey, mode, messages);
  } catch (error) {
    // Модель с рассуждением не ответила вовремя — при автоматическом выборе спрашиваем быструю.
    if (!(error instanceof AiProviderError) || error.status !== 504 || mode !== "reasoning" || !auto) throw error;
    return deepseekChat(env.deepseekApiKey, "fast", messages);
  }
}

async function analysisReply(
  userId: number,
  state: State,
  today: IsoDate,
  kind: AnalysisKind,
  auto: boolean,
  requested: z.infer<typeof modeSchema>,
) {
  const silent = { text: "", report: null, silent: true, reasoning: null, model: "" };
  const availability = analysisAvailability(state, today);
  const plan = analysisPlan(availability, kind);
  if (!plan) return auto ? jsonOk(silent) : jsonError(409, availabilityText(availability, today));
  // Итоги периода — один раз: второе устройство или повторный запрос получают уже готовые.
  if (kind === "period") {
    const existing = findReport(userId, "period", plan.from);
    if (existing) return jsonOk({ text: reportHeadline(existing), report: existing, cached: true, silent: auto, reasoning: null, model: existing.model });
  }
  const data = analysisData(state, plan, today);
  const mode = requested === "auto" ? pickAiMode(ANALYSIS_QUESTION[kind]) : requested;
  const reply = await ask(mode, requested === "auto", analysisMessages(data));
  const report = parseAnalysisReply(reply.text, data, { model: reply.model, createdAt: Date.now(), thinking: Boolean(reply.reasoning) });
  saveReport(userId, report);
  return jsonOk({ text: reportHeadline(report), report, reasoning: reply.reasoning, model: reply.model });
}
