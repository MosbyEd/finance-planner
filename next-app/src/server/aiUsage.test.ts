import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isPeakHour,
  readAiUsageRows,
  recordAiUsage,
  summarizeAiUsage,
  usageCostUsd,
  type AiUsageRow,
} from "./aiUsage";
import { closeDb, getDb } from "./db";
import type { AiUsage } from "./deepseek";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-ai-usage-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  getDb().exec("DELETE FROM ai_usage; DELETE FROM users;");
  getDb().exec("INSERT INTO users (id, login, login_key, password_hash, created_at) VALUES (1, 'anna', 'anna', 'x', 0), (2, 'boris', 'boris', 'x', 0)");
});

const usage = (over: Partial<AiUsage> = {}): AiUsage => ({
  model: "deepseek-flash",
  mode: "fast",
  promptTokens: 9000,
  cacheHitTokens: 6400,
  cacheMissTokens: 2600,
  completionTokens: 500,
  reasoningTokens: null,
  ...over,
});

// Понедельник, 12 октября 2026.
const mondayUtc = (hour: number, minute = 0) => Date.UTC(2026, 9, 12, hour, minute);
const saturdayUtc = (hour: number) => Date.UTC(2026, 9, 17, hour);

describe("запись расхода в ai_usage", () => {
  it("сохраняет пользователя, время, вид, режим, модель и токены — без текста", () => {
    recordAiUsage(1, "chat", usage(), mondayUtc(12));
    recordAiUsage(2, "period", usage({ mode: "reasoning", completionTokens: 1500, reasoningTokens: 1100 }), mondayUtc(13));

    const columns = (getDb().prepare("PRAGMA table_info(ai_usage)").all() as { name: string }[]).map((c) => c.name);
    expect(columns).toEqual([
      "id",
      "user_id",
      "created_at",
      "kind",
      "mode",
      "model",
      "prompt_tokens",
      "cache_hit_tokens",
      "cache_miss_tokens",
      "completion_tokens",
      "reasoning_tokens",
    ]);
    expect(readAiUsageRows(getDb(), mondayUtc(0), mondayUtc(24))).toEqual([
      {
        createdAt: mondayUtc(12),
        userId: 1,
        login: "anna",
        kind: "chat",
        mode: "fast",
        model: "deepseek-flash",
        promptTokens: 9000,
        cacheHitTokens: 6400,
        cacheMissTokens: 2600,
        completionTokens: 500,
        reasoningTokens: null,
      },
      {
        createdAt: mondayUtc(13),
        userId: 2,
        login: "boris",
        kind: "period",
        mode: "reasoning",
        model: "deepseek-flash",
        promptTokens: 9000,
        cacheHitTokens: 6400,
        cacheMissTokens: 2600,
        completionTokens: 1500,
        reasoningTokens: 1100,
      },
    ]);
    // Конец отрезка не входит.
    expect(readAiUsageRows(getDb(), mondayUtc(0), mondayUtc(12))).toEqual([]);
  });

  it("без usage ничего не пишет; ошибка базы не выбрасывается наружу", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    recordAiUsage(1, "chat", null);
    recordAiUsage(999, "chat", usage()); // нет такого пользователя — нарушен внешний ключ
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM ai_usage").get()).toEqual({ n: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(error).toHaveBeenCalledTimes(1);
    warn.mockRestore();
    error.mockRestore();
  });

  it("после удаления аккаунта расход остаётся — без пользователя", () => {
    recordAiUsage(1, "analysis", usage(), mondayUtc(12));
    getDb().exec("DELETE FROM users WHERE id = 1");
    expect(readAiUsageRows(getDb(), 0, Date.now())).toMatchObject([{ userId: null, login: null, kind: "analysis" }]);
  });
});

describe("стоимость по ценам deepseek-flash", () => {
  it("часы пик — по будням 01:00–04:00 и 06:00–10:00 UTC", () => {
    expect(isPeakHour(mondayUtc(0, 59))).toBe(false);
    expect(isPeakHour(mondayUtc(1))).toBe(true);
    expect(isPeakHour(mondayUtc(3, 59))).toBe(true);
    expect(isPeakHour(mondayUtc(4))).toBe(false);
    expect(isPeakHour(mondayUtc(6))).toBe(true);
    expect(isPeakHour(mondayUtc(9, 59))).toBe(true);
    expect(isPeakHour(mondayUtc(10))).toBe(false);
    expect(isPeakHour(saturdayUtc(7))).toBe(false);
    expect(isPeakHour(Date.UTC(2026, 9, 18, 2))).toBe(false); // воскресенье
  });

  it("вход из кэша, вход без кэша и выход — каждый по своей цене; в пик вдвое дороже", () => {
    const tokens = { cacheHitTokens: 1_000_000, cacheMissTokens: 1_000_000, completionTokens: 1_000_000 };
    expect(usageCostUsd({ ...tokens, createdAt: mondayUtc(2) })).toBeCloseTo(0.006 + 0.3 + 1.2, 10);
    expect(usageCostUsd({ ...tokens, createdAt: mondayUtc(12) })).toBeCloseTo(0.003 + 0.15 + 0.6, 10);
    // Типичный вопрос: 9 тыс. токенов входа (6,4 тыс. из кэша), 500 на выходе, вне пика.
    expect(usageCostUsd({ cacheHitTokens: 6400, cacheMissTokens: 2600, completionTokens: 500, createdAt: mondayUtc(12) })).toBeCloseTo(
      (6400 * 0.003 + 2600 * 0.15 + 500 * 0.6) / 1e6,
      12,
    );
  });

  it("суммы по группам: запросы, запросы в пик, токены, доллары", () => {
    const row = (over: Partial<AiUsageRow>): AiUsageRow => ({
      createdAt: mondayUtc(12),
      userId: 1,
      login: "anna",
      kind: "chat",
      mode: "fast",
      model: "deepseek-flash",
      promptTokens: 1000,
      cacheHitTokens: 0,
      cacheMissTokens: 1000,
      completionTokens: 100,
      reasoningTokens: null,
      ...over,
    });
    const rows = [row({}), row({ createdAt: mondayUtc(7), mode: "reasoning", reasoningTokens: 60 }), row({ userId: 2, login: "boris" })];
    const byUser = summarizeAiUsage(rows, (r) => String(r.userId));
    expect([...byUser.keys()]).toEqual(["1", "2"]);
    expect(byUser.get("1")).toEqual({
      requests: 2,
      peakRequests: 1,
      promptTokens: 2000,
      cacheHitTokens: 0,
      cacheMissTokens: 2000,
      completionTokens: 200,
      reasoningTokens: 60,
      usd: usageCostUsd(rows[0]) + usageCostUsd(rows[1]),
    });
    expect(byUser.get("2")?.requests).toBe(1);
  });
});
