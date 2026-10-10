"use client";

import { useEffect, useId, useState } from "react";
import type { NotificationPrefs } from "@/domain/notifications";
import { useSnapshot } from "@/client/react";
import {
  loadNotificationPrefs,
  notificationAccess,
  requestNotificationAccess,
  saveNotificationPrefs,
  syncNotifications,
  type NotificationAccess,
} from "@/client/notifications";
import { isNativeApp } from "@/client/runtime";
import { Button } from "../../ui/Button";
import { Card, Notice, Switch } from "../../ui/controls";
import { controlClass } from "../../ui/Field";

const KINDS: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  { key: "payments", label: "Обязательные платежи", description: "Накануне: что и сколько нужно заплатить завтра." },
  { key: "income", label: "Доходы", description: "В день, когда ожидается зарплата или другой регулярный доход." },
  { key: "cashGap", label: "Кассовый разрыв", description: "Если в ближайшую неделю денег на счёте не хватит на платежи." },
  { key: "debts", label: "Сроки долгов", description: "Накануне срока возврата вашего долга и в день, когда должны вам." },
];

/** Уведомления — только в iOS-приложении: их планирует сам телефон по данным бюджета. */
export function NotificationsSection() {
  const { state } = useSnapshot();
  const [access, setAccess] = useState<NotificationAccess>("unavailable");
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => loadNotificationPrefs());
  const morningId = useId();
  const eveningId = useId();
  const native = isNativeApp();

  useEffect(() => {
    let cancelled = false;
    void notificationAccess().then((a) => {
      if (!cancelled) setAccess(a);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!native) return null;

  const update = (patch: Partial<NotificationPrefs>) => {
    const next = { ...prefs, ...patch };
    setPrefs(next);
    saveNotificationPrefs(next);
    void syncNotifications(state);
  };

  const enable = async () => {
    const result = await requestNotificationAccess();
    setAccess(result);
    if (result === "granted") void syncNotifications(state);
  };

  return (
    <Card title="Уведомления">
      <div className="space-y-4">
        {access === "prompt" && (
          <Notice action={<Button size="sm" onClick={() => void enable()}>Включить</Button>}>
            Приложение напомнит о платежах, доходах и сроках долгов. Уведомления планируются на телефоне — интернет для
            них не нужен.
          </Notice>
        )}
        {access === "denied" && (
          <Notice tone="warning">
            Уведомления выключены в настройках iPhone. Включите их: Настройки → Уведомления → Бюджет.
          </Notice>
        )}
        {access === "granted" && (
          <>
            {KINDS.map((kind) => (
              <Switch
                key={kind.key}
                checked={Boolean(prefs[kind.key])}
                onChange={(value) => update({ [kind.key]: value })}
                label={kind.label}
                description={kind.description}
              />
            ))}
            <div className="space-y-1.5">
              <label htmlFor={morningId} className="block text-sm font-medium text-muted">
                Время напоминаний о платежах и доходах
              </label>
              <input
                id={morningId}
                type="time"
                value={prefs.morningTime}
                onChange={(e) => e.target.value && update({ morningTime: e.target.value })}
                className={`${controlClass} h-12 w-40`}
              />
            </div>
            <Switch
              checked={prefs.dailyReminder}
              onChange={(value) => update({ dailyReminder: value })}
              label="Вечернее напоминание"
              description="«Внесите сегодняшние траты» — каждый день в выбранное время."
            />
            {prefs.dailyReminder && (
              <div className="space-y-1.5">
                <label htmlFor={eveningId} className="block text-sm font-medium text-muted">
                  Время вечернего напоминания
                </label>
                <input
                  id={eveningId}
                  type="time"
                  value={prefs.reminderTime}
                  onChange={(e) => e.target.value && update({ reminderTime: e.target.value })}
                  className={`${controlClass} h-12 w-40`}
                />
              </div>
            )}
          </>
        )}
      </div>
    </Card>
  );
}
