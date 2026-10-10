import { describe, expect, it } from "vitest";
import { formatMoney, kopecksToInput, parseAmount, percentOf } from "./money";

describe("parseAmount", () => {
  it.each([
    ["500", 50_000],
    ["12 500", 1_250_000],
    ["12 500", 1_250_000],
    ["12,5", 1_250],
    ["12,50", 1_250],
    ["12.5", 1_250],
    ["0,99", 99],
    [",5", 50],
    ["12,500", 1_250_000],
    ["1.000.000", 100_000_000],
    ["1,000,000.25", 100_000_025],
    ["1.000,25", 100_025],
    ["1 234,56 ₽", 123_456],
    ["100руб", 10_000],
  ])("%s → %d коп.", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  it.each(["", "abc", "1,2,3", "12,3456", "1.2.3", "-5", "1e5", "..", "12,5,0"])("отклоняет «%s»", (input) => {
    expect(parseAmount(input)).toBeNull();
  });

  it("разрешает минус, если попросили", () => {
    expect(parseAmount("-1 500", { allowNegative: true })).toBe(-150_000);
    expect(parseAmount("−20", { allowNegative: true })).toBe(-2_000);
  });

  it("не пропускает слишком большие суммы", () => {
    expect(parseAmount("100000000000")).toBeNull();
  });
});

describe("formatMoney", () => {
  const norm = (s: string) => s.replace(/[  ]/g, " ");
  it("показывает копейки только когда они есть", () => {
    expect(norm(formatMoney(1_250_000))).toBe("12 500 ₽");
    expect(norm(formatMoney(1_250_050))).toBe("12 500,50 ₽");
  });
  it("знак", () => {
    expect(norm(formatMoney(-5_000))).toBe("−50 ₽");
    expect(norm(formatMoney(5_000, { sign: true }))).toBe("+50 ₽");
    expect(norm(formatMoney(0, { sign: true }))).toBe("0 ₽");
  });
});

describe("percentOf / kopecksToInput", () => {
  it("процент округляется до рублей", () => {
    expect(percentOf(7_500_000, 15)).toBe(1_125_000);
    expect(percentOf(30_888, 5)).toBe(1_500); // 15,44 ₽ → 15 ₽
  });
  it("значение для поля ввода", () => {
    expect(kopecksToInput(1_250_000)).toBe("12500");
    expect(kopecksToInput(1_250_005)).toBe("12500,05");
    expect(parseAmount(kopecksToInput(123_456))).toBe(123_456);
  });
});
