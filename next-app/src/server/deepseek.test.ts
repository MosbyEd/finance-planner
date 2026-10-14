import { afterEach, describe, expect, it, vi } from "vitest";
import { AiProviderError, deepseekChat, parseUsage } from "./deepseek";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Ответ DeepSeek: fetch подменён, в сеть не ходим. */
function stubResponse(body: unknown) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })));
}

describe("parseUsage", () => {
  it("берёт токены входа (из кэша и без), выхода и рассуждения", () => {
    const usage = parseUsage(
      {
        prompt_tokens: 9000,
        prompt_cache_hit_tokens: 6400,
        prompt_cache_miss_tokens: 2600,
        completion_tokens: 1500,
        completion_tokens_details: { reasoning_tokens: 1100 },
        total_tokens: 10500,
      },
      "deepseek-flash",
      true,
    );
    expect(usage).toEqual({
      model: "deepseek-flash",
      mode: "reasoning",
      promptTokens: 9000,
      cacheHitTokens: 6400,
      cacheMissTokens: 2600,
      completionTokens: 1500,
      reasoningTokens: 1100,
    });
  });

  it("без полей кэша весь вход — без кэша; без деталей — токенов рассуждения нет", () => {
    expect(parseUsage({ prompt_tokens: 700, completion_tokens: 80 }, "deepseek-flash", false)).toEqual({
      model: "deepseek-flash",
      mode: "fast",
      promptTokens: 700,
      cacheHitTokens: 0,
      cacheMissTokens: 700,
      completionTokens: 80,
      reasoningTokens: null,
    });
    expect(parseUsage({ prompt_tokens: 700, prompt_cache_hit_tokens: 512, completion_tokens: 80 }, "m", false)).toMatchObject({
      cacheHitTokens: 512,
      cacheMissTokens: 188,
    });
  });

  it("режим — по рассуждению в ответе: имя модели одно и то же", () => {
    const raw = { prompt_tokens: 10, completion_tokens: 5 };
    expect(parseUsage(raw, "deepseek-flash", false)?.mode).toBe("fast");
    expect(parseUsage(raw, "deepseek-flash", true)?.mode).toBe("reasoning");
    // Рассуждение не пришло текстом, но токены на него потрачены.
    expect(parseUsage({ ...raw, completion_tokens_details: { reasoning_tokens: 3 } }, "deepseek-flash", false)?.mode).toBe("reasoning");
    expect(parseUsage({ ...raw, completion_tokens_details: { reasoning_tokens: 0 } }, "deepseek-flash", false)?.mode).toBe("fast");
  });

  it("нет usage или в нём не числа — null", () => {
    expect(parseUsage(undefined, "m", false)).toBeNull();
    expect(parseUsage(null, "m", false)).toBeNull();
    expect(parseUsage({ prompt_tokens: "10", completion_tokens: 5 }, "m", false)).toBeNull();
    expect(parseUsage({ prompt_tokens: 10 }, "m", false)).toBeNull();
    expect(parseUsage({ prompt_tokens: -1, completion_tokens: 5 }, "m", false)).toBeNull();
  });
});

describe("deepseekChat возвращает расход вместе с текстом", () => {
  it("ответ с рассуждением: модель — из ответа, режим — reasoning", async () => {
    stubResponse({
      model: "deepseek-flash",
      choices: [{ message: { content: "Ответ", reasoning_content: "Думаю…" } }],
      usage: { prompt_tokens: 100, prompt_cache_hit_tokens: 64, prompt_cache_miss_tokens: 36, completion_tokens: 40, completion_tokens_details: { reasoning_tokens: 30 } },
    });
    const reply = await deepseekChat("key", "reasoning", [{ role: "user", content: "Вопрос" }]);
    expect(reply).toMatchObject({ text: "Ответ", reasoning: "Думаю…", model: "deepseek-flash" });
    expect(reply.usage).toEqual({
      model: "deepseek-flash",
      mode: "reasoning",
      promptTokens: 100,
      cacheHitTokens: 64,
      cacheMissTokens: 36,
      completionTokens: 40,
      reasoningTokens: 30,
    });
  });

  it("без usage в ответе — usage: null, ответ не теряется", async () => {
    stubResponse({ choices: [{ message: { content: "Ответ" } }] });
    const reply = await deepseekChat("key", "fast", [{ role: "user", content: "Вопрос" }]);
    expect(reply).toEqual({ text: "Ответ", reasoning: null, model: "deepseek-chat", usage: null });
  });

  it("пустой ответ — ошибка, но с потраченными токенами", async () => {
    stubResponse({ model: "deepseek-flash", choices: [{ message: { content: "  " } }], usage: { prompt_tokens: 50, completion_tokens: 0 } });
    const error = await deepseekChat("key", "fast", [{ role: "user", content: "Вопрос" }]).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(AiProviderError);
    expect((error as AiProviderError).usage).toMatchObject({ promptTokens: 50, completionTokens: 0, mode: "fast" });
  });
});
