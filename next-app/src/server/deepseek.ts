const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export type AiMode = "fast" | "reasoning";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/** Расход токенов на один ответ — из поля usage ответа DeepSeek. */
export interface AiUsage {
  /** Модель из ответа: API называет её «deepseek-flash» и для deepseek-chat, и для deepseek-reasoner. */
  model: string;
  /** Режим по самому ответу: по имени модели его не понять, поэтому — по наличию рассуждения. */
  mode: AiMode;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  /** Вместе с токенами рассуждения. */
  completionTokens: number;
  reasoningTokens: number | null;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Токены, потраченные на ответ, который не подошёл (например, пустой). */
    readonly usage: AiUsage | null = null,
  ) {
    super(message);
  }
}

const MODELS: Record<AiMode, { model: string; timeoutMs: number }> = {
  fast: { model: "deepseek-chat", timeoutMs: 60_000 },
  reasoning: { model: "deepseek-reasoner", timeoutMs: 180_000 },
};

export async function deepseekChat(
  apiKey: string,
  mode: AiMode,
  messages: ChatMessage[],
): Promise<{ text: string; reasoning: string | null; model: string; usage: AiUsage | null }> {
  const { model, timeoutMs } = MODELS[mode];
  let response: Response;
  try {
    response = await fetch(DEEPSEEK_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages, temperature: mode === "fast" ? 0.3 : undefined, stream: false }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    if (error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError")) {
      throw new AiProviderError("AI не ответил вовремя. Попробуйте ещё раз или выберите быстрый режим.", 504);
    }
    throw new AiProviderError("Не удалось связаться с AI-сервисом.", 502);
  }

  if (!response.ok) {
    const messages: Record<number, string> = {
      401: "AI-ключ на сервере недействителен.",
      402: "На счёте AI-сервиса закончились средства.",
      429: "AI-сервис перегружен запросами. Попробуйте через минуту.",
    };
    throw new AiProviderError(messages[response.status] ?? `AI-сервис вернул ошибку ${response.status}.`, 502);
  }

  const data = (await response.json().catch(() => null)) as {
    choices?: { message?: { content?: string; reasoning_content?: string } }[];
    model?: string;
    usage?: unknown;
  } | null;
  const message = data?.choices?.[0]?.message;
  const reasoning = message?.reasoning_content?.trim() || null;
  const answeredBy = data?.model ?? model;
  const usage = parseUsage(data?.usage, answeredBy, reasoning !== null);
  const text = (message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) throw new AiProviderError("AI вернул пустой ответ.", 502, usage);
  return { text, reasoning, model: answeredBy, usage };
}

function tokenCount(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.round(value) : null;
}

/** Разбирает usage ответа. Без prompt_tokens и completion_tokens — null: считать нечего. */
export function parseUsage(raw: unknown, model: string, withReasoning: boolean): AiUsage | null {
  if (!raw || typeof raw !== "object") return null;
  const usage = raw as Record<string, unknown>;
  const promptTokens = tokenCount(usage.prompt_tokens);
  const completionTokens = tokenCount(usage.completion_tokens);
  if (promptTokens === null || completionTokens === null) return null;
  const cacheHitTokens = tokenCount(usage.prompt_cache_hit_tokens) ?? 0;
  const details = usage.completion_tokens_details;
  const reasoningTokens = details && typeof details === "object" ? tokenCount((details as Record<string, unknown>).reasoning_tokens) : null;
  return {
    model,
    mode: withReasoning || (reasoningTokens ?? 0) > 0 ? "reasoning" : "fast",
    promptTokens,
    cacheHitTokens,
    cacheMissTokens: tokenCount(usage.prompt_cache_miss_tokens) ?? Math.max(promptTokens - cacheHitTokens, 0),
    completionTokens,
    reasoningTokens,
  };
}
