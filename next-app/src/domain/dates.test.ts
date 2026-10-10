import { describe, expect, it } from "vitest";
import {
  addDays,
  addMonths,
  clampedDayOfMonth,
  daysInMonth,
  diffDays,
  formatRelativeDay,
  isValidIsoDate,
  monthRange,
  todayLocal,
} from "./dates";

describe("dates", () => {
  it("проверяет реальные даты", () => {
    expect(isValidIsoDate("2026-02-28")).toBe(true);
    expect(isValidIsoDate("2026-02-30")).toBe(false);
    expect(isValidIsoDate("2028-02-29")).toBe(true);
    expect(isValidIsoDate("2026-3-5")).toBe(false);
    expect(isValidIsoDate(20260305)).toBe(false);
  });

  it("арифметика не зависит от часового пояса", () => {
    expect(addDays("2026-03-31", 1)).toBe("2026-04-01");
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
    expect(addDays("2026-03-29", 1)).toBe("2026-03-30"); // переход на летнее время в Европе
    expect(diffDays("2026-01-01", "2026-12-31")).toBe(364);
  });

  it("месяцы", () => {
    expect(daysInMonth("2026-02")).toBe(28);
    expect(addMonths("2026-12", 1)).toBe("2027-01");
    expect(addMonths("2026-01", -1)).toBe("2025-12");
    expect(monthRange("2025-11", "2026-02")).toEqual(["2025-11", "2025-12", "2026-01", "2026-02"]);
    expect(clampedDayOfMonth("2026-02", 31)).toBe("2026-02-28");
  });

  it("сегодня — по локальным часам", () => {
    expect(todayLocal(new Date(2026, 9, 9, 1, 30))).toBe("2026-10-09");
  });

  it("относительные подписи", () => {
    expect(formatRelativeDay("2026-10-09", "2026-10-09")).toBe("Сегодня");
    expect(formatRelativeDay("2026-10-08", "2026-10-09")).toBe("Вчера");
    expect(formatRelativeDay("2026-10-12", "2026-10-09")).toBe("12 октября, пн");
    expect(formatRelativeDay("2025-10-12", "2026-10-09")).toBe("12 октября 2025, вс");
  });
});
