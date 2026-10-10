"use client";

import { useEffect, useState } from "react";
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
import { Notice, Switch } from "../../ui/controls";
import { TimeInput } from "../../ui/Field";
import { SectionCard, useRowSummary, type RowSummary } from "./SettingsList";

const KINDS: { key: keyof NotificationPrefs; label: string; description: string }[] = [
  { key: "payments", label: "Обязательные платежи", description: "Накануне: что и сколько нужно заплатить завтра." },
  { key: "income", label: "Доходы", description: "В день, когда ожидается зарплата или другой регулярный доход." },
  { key: "cashGap", label: "Кассовый разрыв", description: "Если в ближайшую неделю денег на счёте не хватит на платежи." },
  { key: "debts", label: "Сроки долгов", description: "Накануне срока возврата вашего долга и в день, когда должны вам." },
];

/** Состояние для строки в списке настроек. */
function accessSummary(access: NotificationAccess, prefs: NotificationPrefs): RowSummary | null {
  if (access === "denied") return { text: "Запрещены в iOS", tone: "warning" };
  if (access === "prompt") return { text: "Не включены" };
  if (access !== "granted") return null;
  const any = KINDS.some((k) => Boolean(prefs[k.key])) || prefs.dailyReminder;
  return { text: any ? "Включены" : "Выключены" };
}

/** Уведомления — только в iOS-приложении: их планирует сам телефон по данным бюджета. */
export function NotificationsSection() {
  const { state } = useSnapshot();
  const [access, setAccess] = useState<NotificationAccess>("unavailable");
  const [prefs, setPrefs] = useState<NotificationPrefs>(() => loadNotificationPrefs());
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

  useRowSummary(accessSummary(access, prefs));

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
    <SectionCard title="Уведомления">
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
            <TimeInput
              label="Время напоминаний о платежах и доходах"
              value={prefs.morningTime}
              onChange={(e) => e.target.value && update({ morningTime: e.target.value })}
            />
            <Switch
              checked={prefs.dailyReminder}
              onChange={(value) => update({ dailyReminder: value })}
              label="Вечернее напоминание"
              description="«Внесите сегодняшние траты» — каждый день в выбранное время."
            />
            {prefs.dailyReminder && (
              <TimeInput
                label="Время вечернего напоминания"
                value={prefs.reminderTime}
                onChange={(e) => e.target.value && update({ reminderTime: e.target.value })}
              />
            )}
          </>
        )}
      </div>
    </SectionCard>
  );
}
