"use client";

import { LocalNotifications, type LocalNotificationSchema } from "@capacitor/local-notifications";
import { todayLocal } from "@/domain/dates";
import {
  defaultNotificationPrefs,
  isValidTime,
  notificationMoment,
  parseTime,
  planNotifications,
  type NotificationPrefs,
} from "@/domain/notifications";
import type { State } from "@/domain/schema";
import { isNativeApp } from "./runtime";
import { storage } from "./storage";

/** Настройки уведомлений — свои у каждого устройства, поэтому хранятся на нём, а не на сервере. */
const PREFS_KEY = "fp:notify-prefs";

export function loadNotificationPrefs(): NotificationPrefs {
  const defaults = defaultNotificationPrefs();
  const raw = storage.getJson(PREFS_KEY);
  if (!raw || typeof raw !== "object") return defaults;
  const r = raw as Record<string, unknown>;
  const flag = (key: keyof NotificationPrefs) => (typeof r[key] === "boolean" ? (r[key] as boolean) : (defaults[key] as boolean));
  return {
    payments: flag("payments"),
    income: flag("income"),
    cashGap: flag("cashGap"),
    debts: flag("debts"),
    dailyReminder: flag("dailyReminder"),
    reminderTime: isValidTime(r.reminderTime) ? r.reminderTime : defaults.reminderTime,
    morningTime: isValidTime(r.morningTime) ? r.morningTime : defaults.morningTime,
  };
}

export function saveNotificationPrefs(prefs: NotificationPrefs): void {
  storage.setJson(PREFS_KEY, prefs);
}

export type NotificationAccess = "granted" | "denied" | "prompt" | "unavailable";

/** Есть ли разрешение показывать уведомления (только в iOS-приложении). */
export async function notificationAccess(): Promise<NotificationAccess> {
  if (!isNativeApp()) return "unavailable";
  try {
    const { display } = await LocalNotifications.checkPermissions();
    return display === "granted" ? "granted" : display === "denied" ? "denied" : "prompt";
  } catch {
    return "unavailable";
  }
}

export async function requestNotificationAccess(): Promise<NotificationAccess> {
  if (!isNativeApp()) return "unavailable";
  try {
    const { display } = await LocalNotifications.requestPermissions();
    return display === "granted" ? "granted" : display === "denied" ? "denied" : "prompt";
  } catch {
    return "unavailable";
  }
}

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

let syncing: Promise<void> = Promise.resolve();

/**
 * Перепланирует все уведомления по текущим данным: прежние снимаются, новые ставятся заново.
 * Вызовы выстраиваются в очередь, чтобы два перепланирования не перемешались.
 */
export function syncNotifications(state: State): Promise<void> {
  syncing = syncing.then(() => doSync(state)).catch(() => {});
  return syncing;
}

async function doSync(state: State): Promise<void> {
  if ((await notificationAccess()) !== "granted") return;
  const now = new Date();
  const plan = planNotifications(state, todayLocal(now), `${pad2(now.getHours())}:${pad2(now.getMinutes())}`, loadNotificationPrefs());

  const pending = await LocalNotifications.getPending();
  if (pending.notifications.length) {
    await LocalNotifications.cancel({ notifications: pending.notifications.map((n) => ({ id: n.id })) });
  }

  const list: LocalNotificationSchema[] = plan.scheduled.map((n) => ({
    id: n.id,
    title: n.title,
    body: n.body,
    schedule: { at: notificationMoment(n.date, n.time), allowWhileIdle: true },
  }));
  if (plan.daily) {
    const { hour, minute } = parseTime(plan.daily.time);
    list.push({
      id: plan.daily.id,
      title: plan.daily.title,
      body: plan.daily.body,
      schedule: { on: { hour, minute }, allowWhileIdle: true },
    });
  }
  if (list.length) await LocalNotifications.schedule({ notifications: list });
}
