import type { DatabaseSync } from "node:sqlite";
import type { AnalysisKind } from "@/domain/spendingAnalysis";
import { getDb } from "./db";
import type { AiUsage } from "./deepseek";

/** Вид запроса к AI: вопрос в чате, разбор трат или «Итоги периода». */
export type AiRequestKind = "chat" | AnalysisKind;

/** Записывает расход токенов на ответ. Ошибка записи не мешает ответить пользователю. */
export function recordAiUsage(userId: number, kind: AiRequestKind, usage: AiUsage | null, now = Date.now()): void {
  if (!usage) {
    console.warn(`[ai-usage] в ответе AI нет usage (${kind}) — расход не записан`);
    return;
  }
  try {
    getDb()
      .prepare(
        `INSERT INTO ai_usage (user_id, created_at, kind, mode, model, prompt_tokens, cache_hit_tokens, cache_miss_tokens,
           completion_tokens, reasoning_tokens) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        userId,
        now,
        kind,
        usage.mode,
        usage.model,
        usage.promptTokens,
        usage.cacheHitTokens,
        usage.cacheMissTokens,
        usage.completionTokens,
        usage.reasoningTokens,
      );
  } catch (error) {
    console.error("[ai-usage] не удалось записать расход", error);
  }
}

/** Строка ai_usage для отчёта (вместе с логином; у удалённых аккаунтов userId и login — null). */
export interface AiUsageRow {
  createdAt: number;
  userId: number | null;
  login: string | null;
  kind: string;
  mode: string;
  model: string;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number | null;
}

/** Строки за [from, to) в мс. Тот же запрос scripts/ai-usage.ts выполняет на сервере. */
export const AI_USAGE_ROWS_SQL = `
  SELECT a.created_at AS createdAt, a.user_id AS userId, u.login AS login, a.kind AS kind, a.mode AS mode,
    a.model AS model, a.prompt_tokens AS promptTokens, a.cache_hit_tokens AS cacheHitTokens,
    a.cache_miss_tokens AS cacheMissTokens, a.completion_tokens AS completionTokens, a.reasoning_tokens AS reasoningTokens
  FROM ai_usage a LEFT JOIN users u ON u.id = a.user_id
  WHERE a.created_at >= ? AND a.created_at < ?
  ORDER BY a.created_at`;

export function readAiUsageRows(db: DatabaseSync, from: number, to: number): AiUsageRow[] {
  return db.prepare(AI_USAGE_ROWS_SQL).all(from, to) as unknown as AiUsageRow[];
}

/** Цены deepseek-flash, $ за 1 млн токенов. Выход — вместе с токенами рассуждения. */
export const DEEPSEEK_PRICES = {
  peak: { cacheHit: 0.006, cacheMiss: 0.3, output: 1.2 },
  offPeak: { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
} as const;

/** Часы пик DeepSeek: по будням 01:00–04:00 и 06:00–10:00 UTC. */
export function isPeakHour(at: number): boolean {
  const date = new Date(at);
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const hour = date.getUTCHours();
  return (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
}

export function usageCostUsd(row: Pick<AiUsageRow, "createdAt" | "cacheHitTokens" | "cacheMissTokens" | "completionTokens">): number {
  const price = isPeakHour(row.createdAt) ? DEEPSEEK_PRICES.peak : DEEPSEEK_PRICES.offPeak;
  return (row.cacheHitTokens * price.cacheHit + row.cacheMissTokens * price.cacheMiss + row.completionTokens * price.output) / 1_000_000;
}

export interface AiUsageTotals {
  requests: number;
  peakRequests: number;
  promptTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  completionTokens: number;
  reasoningTokens: number;
  usd: number;
}

/** Суммы по группам (ключ — keyOf) в порядке первого появления. */
export function summarizeAiUsage(rows: AiUsageRow[], keyOf: (row: AiUsageRow) => string): Map<string, AiUsageTotals> {
  const groups = new Map<string, AiUsageTotals>();
  for (const row of rows) {
    const key = keyOf(row);
    let totals = groups.get(key);
    if (!totals) {
      totals = { requests: 0, peakRequests: 0, promptTokens: 0, cacheHitTokens: 0, cacheMissTokens: 0, completionTokens: 0, reasoningTokens: 0, usd: 0 };
      groups.set(key, totals);
    }
    totals.requests += 1;
    if (isPeakHour(row.createdAt)) totals.peakRequests += 1;
    totals.promptTokens += row.promptTokens;
    totals.cacheHitTokens += row.cacheHitTokens;
    totals.cacheMissTokens += row.cacheMissTokens;
    totals.completionTokens += row.completionTokens;
    totals.reasoningTokens += row.reasoningTokens ?? 0;
    totals.usd += usageCostUsd(row);
  }
  return groups;
}
