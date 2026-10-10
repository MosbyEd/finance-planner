const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

export type AiMode = "fast" | "reasoning";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class AiProviderError extends Error {
  constructor(
    message: string,
    readonly status: number,
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
): Promise<{ text: string; reasoning: string | null; model: string }> {
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
  } | null;
  const message = data?.choices?.[0]?.message;
  const text = (message?.content ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();
  if (!text) throw new AiProviderError("AI вернул пустой ответ.", 502);
  return { text, reasoning: message?.reasoning_content?.trim() || null, model: data?.model ?? model };
}
