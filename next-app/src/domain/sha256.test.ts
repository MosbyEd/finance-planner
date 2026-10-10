import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { sha256Hex } from "./sha256";

describe("sha256Hex", () => {
  it.each([
    "",
    "abc",
    "2026-10-10|Счёт карты MIR-7759 18:42 Покупка 300р IP KRAVCHENKO B.A Баланс: 5260.14р",
    "Эмодзи 😀 и длинная строка ".repeat(40),
  ])("совпадает с crypto.createHash: %s", (text) => {
    expect(sha256Hex(text)).toBe(createHash("sha256").update(text).digest("hex"));
  });
});
