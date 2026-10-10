/** Простой ограничитель частоты в памяти процесса (фиксированное окно). */
const buckets = new Map<string, { count: number; resetAt: number }>();
let lastCleanup = 0;

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds: number;
}

export interface RateLimitOptions {
  /** «Вес» запроса: сколько единиц предела он расходует (например, число изменений в пачке). По умолчанию 1. */
  cost?: number;
  now?: number;
}

/**
 * Учитывает запрос с весом cost и сообщает, укладываемся ли в limit единиц за окно windowMs.
 * Отклонённые запросы тоже расходуют предел (окно от этого не продлевается).
 */
export function rateLimit(key: string, limit: number, windowMs: number, { cost = 1, now = Date.now() }: RateLimitOptions = {}): RateLimitResult {
  if (now - lastCleanup > 60_000) {
    for (const [k, b] of buckets) if (b.resetAt <= now) buckets.delete(k);
    lastCleanup = now;
  }
  let bucket = buckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    bucket = { count: 0, resetAt: now + windowMs };
    buckets.set(key, bucket);
  }
  bucket.count += cost;
  return {
    ok: bucket.count <= limit,
    retryAfterSeconds: Math.max(1, Math.ceil((bucket.resetAt - now) / 1000)),
  };
}

/** Сбрасывает счётчик (например, после успешного входа). */
export function resetRateLimit(key: string): void {
  buckets.delete(key);
}

export function clearRateLimits(): void {
  buckets.clear();
}
