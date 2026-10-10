import { beforeEach, describe, expect, it } from "vitest";
import { clearRateLimits, rateLimit } from "./rateLimit";

beforeEach(() => clearRateLimits());

describe("rateLimit: вес запроса (ревью 2: H2)", () => {
  it("cost расходует предел на столько единиц; окно сбрасывается", () => {
    const now = 1_000_000;
    expect(rateLimit("ops:1", 250, 60_000, { cost: 100, now }).ok).toBe(true);
    expect(rateLimit("ops:1", 250, 60_000, { cost: 100, now }).ok).toBe(true);
    const third = rateLimit("ops:1", 250, 60_000, { cost: 100, now: now + 30_000 });
    expect(third).toEqual({ ok: false, retryAfterSeconds: 30 });
    // Другой ключ независим, а в новом окне счёт заново.
    expect(rateLimit("ops:2", 250, 60_000, { cost: 100, now }).ok).toBe(true);
    expect(rateLimit("ops:1", 250, 60_000, { cost: 100, now: now + 60_000 }).ok).toBe(true);
  });

  it("без веса — один запрос = одна единица", () => {
    const now = 5_000;
    for (let i = 0; i < 3; i++) expect(rateLimit("k", 3, 1_000, { now }).ok).toBe(true);
    expect(rateLimit("k", 3, 1_000, { now }).ok).toBe(false);
  });
});
