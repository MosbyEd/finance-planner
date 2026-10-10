import { describe, expect, it } from "vitest";
import { DAILY_REMINDER_ID, defaultNotificationPrefs, notificationMoment, planNotifications } from "./notifications";
import { stateWith, template, tx } from "./test-utils";

const norm = (s: string) => s.replace(/[  ]/g, " ");

function base() {
  const s = stateWith({
    templates: [
      template({ id: "rent", kind: "expense", title: "Аренда", amount: 4_500_000, dayOfMonth: 20, startDate: "2026-10-01" }),
      template({ id: "phone", kind: "expense", title: "Связь", category: "Связь", amount: 90_000, dayOfMonth: 20, startDate: "2026-10-01" }),
      template({ id: "salary", kind: "income", title: "Зарплата", amount: 9_000_000, dayOfMonth: 25, startDate: "2026-10-01" }),
    ],
    transactions: [tx({ type: "adjustment", amount: 10_000_000, date: "2026-10-01" })],
  });
  s.settings.salarySaving.enabled = false;
  return s;
}

describe("план уведомлений", () => {
  it("платежи одного дня — одним уведомлением накануне, доход — в свой день", () => {
    const plan = planNotifications(base(), "2026-10-10", "12:00", defaultNotificationPrefs(), 20);
    const payments = plan.scheduled.find((n) => n.key === "payments:2026-10-20");
    expect(payments).toMatchObject({ date: "2026-10-19", time: "10:00", title: "Завтра обязательные платежи" });
    expect(norm(payments!.body)).toBe("Аренда — 45 000 ₽, Связь — 900 ₽.");
    const income = plan.scheduled.find((n) => n.key.startsWith("income:"));
    expect(income).toMatchObject({ date: "2026-10-25", title: "Сегодня ожидается доход" });
    expect(plan.daily).toMatchObject({ id: DAILY_REMINDER_ID, time: "21:00" });
  });

  it("предупреждает, если денег на платёж не хватит, и о кассовом разрыве", () => {
    const s = base();
    s.transactions = [tx({ type: "adjustment", amount: 1_000_000, date: "2026-10-01" })];
    const plan = planNotifications(s, "2026-10-15", "08:00", defaultNotificationPrefs(), 20);
    expect(plan.scheduled.find((n) => n.key === "payments:2026-10-20")?.body).toContain("не хватит");
    const gap = plan.scheduled.find((n) => n.key.startsWith("gap:"));
    expect(gap).toMatchObject({ date: "2026-10-15", time: "10:00", title: "Скоро кассовый разрыв" });
  });

  it("не планирует прошедшее время и уважает выключенные виды", () => {
    const prefs = { ...defaultNotificationPrefs(), income: false, dailyReminder: false };
    const plan = planNotifications(base(), "2026-10-19", "11:00", prefs, 20);
    expect(plan.scheduled.find((n) => n.key === "payments:2026-10-20")).toBeUndefined(); // 10:00 уже прошло
    expect(plan.scheduled.some((n) => n.key.startsWith("income:"))).toBe(false);
    expect(plan.daily).toBeNull();
  });

  it("сроки долгов: свой долг — накануне, долг вам — в день срока; погашенные не напоминаются", () => {
    const s = base();
    s.loans = [
      { id: "bank", kind: "credit", name: "Банк", amount: 5_000_000, initialPaid: 0, dueDate: "2026-10-12", note: "", createdAt: "2026-10-01" },
      { id: "sasha", kind: "lend", name: "Саша", amount: 1_000_000, initialPaid: 0, dueDate: "2026-10-14", note: "", createdAt: "2026-10-01" },
      { id: "done", kind: "borrow", name: "Мама", amount: 100, initialPaid: 100, dueDate: "2026-10-13", note: "", createdAt: "2026-10-01" },
    ];
    const plan = planNotifications(s, "2026-10-10", "09:00", defaultNotificationPrefs(), 20);
    expect(plan.scheduled.find((n) => n.key.startsWith("debt:bank"))).toMatchObject({ date: "2026-10-11" });
    expect(plan.scheduled.find((n) => n.key.startsWith("lend:sasha"))).toMatchObject({ date: "2026-10-14" });
    expect(plan.scheduled.some((n) => n.key.includes("done"))).toBe(false);
  });

  it("номера уведомлений устойчивы и уникальны", () => {
    const a = planNotifications(base(), "2026-10-10", "12:00", defaultNotificationPrefs(), 40);
    const b = planNotifications(base(), "2026-10-10", "12:00", defaultNotificationPrefs(), 40);
    expect(a.scheduled.map((n) => n.id)).toEqual(b.scheduled.map((n) => n.id));
    expect(new Set(a.scheduled.map((n) => n.id)).size).toBe(a.scheduled.length);
    expect(a.scheduled.every((n) => n.id > DAILY_REMINDER_ID)).toBe(true);
  });

  it("момент уведомления — в местном времени", () => {
    const d = notificationMoment("2026-10-19", "10:30");
    expect([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours(), d.getMinutes()]).toEqual([2026, 9, 19, 10, 30]);
  });
});
