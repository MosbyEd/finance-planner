"use client";

import { useState, type ReactNode } from "react";
import { useSnapshot } from "@/client/react";
import { isNativeApp } from "@/client/runtime";
import { APP_VERSION, AboutSection } from "./settings/AboutSection";
import { AccountSection } from "./settings/AccountSection";
import { AppleAiSection } from "./settings/AppleAiSection";
import { CategoriesSection } from "./settings/CategoriesSection";
import { DataSection } from "./settings/DataSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { ProfileSection } from "./settings/ProfileSection";
import { SavingsSection } from "./settings/SavingsSection";
import { SmsImportSection } from "./settings/SmsImportSection";
import { SettingsGroup, SettingsRow, type RowIconName, type RowSummary } from "./settings/SettingsList";

interface Row {
  id: string;
  icon: RowIconName;
  title: string;
  /** Состояние из данных бюджета; то, что знает только раздел (СМС, уведомления), он сообщает сам. */
  summary?: string | RowSummary;
  content: ReactNode;
}

interface Group {
  label: string;
  /** false — раздел здесь не показывается (нужен вход или iOS-приложение). */
  rows: (Row | false)[];
}

/**
 * Настройки — список разделов-строк, как в iOS: сверху то, что меняют чаще. Строка показывает краткое
 * состояние, нажатие раскрывает раздел на месте (открыт один раздел за раз).
 */
export function Settings() {
  const { mode, user, state, sessionExpired } = useSnapshot();
  const [openId, setOpenId] = useState<string | null>(null);
  const native = isNativeApp();
  // Те же условия, что внутри разделов: где раздел ничего не рисует, строки нет.
  const signedIn = mode !== "guest" && user !== null;

  const { categories, profile, settings } = state;
  const categoryCount = categories.income.length + categories.mandatory.length + categories.flexible.length;
  const profileFilled = Boolean(profile.occupation || profile.notes || profile.riskLevel || profile.savingsStyle);

  const groups: Group[] = [
    {
      label: "Автоматика и напоминания",
      rows: [
        signedIn && { id: "sms", icon: "message", title: "Операции из СМС", content: <SmsImportSection /> },
        native && { id: "notifications", icon: "bell", title: "Уведомления", content: <NotificationsSection /> },
        native && { id: "apple-ai", icon: "sparkles", title: "Apple Intelligence", content: <AppleAiSection /> },
      ],
    },
    {
      label: "Бюджет",
      rows: [
        {
          id: "savings",
          icon: "piggy",
          title: "Сбережения",
          summary: `${settings.savingsRatePercent} %`,
          content: <SavingsSection />,
        },
        { id: "categories", icon: "tag", title: "Категории", summary: String(categoryCount), content: <CategoriesSection /> },
        {
          id: "profile",
          icon: "idCard",
          title: "Профиль для AI",
          summary: profileFilled ? "Заполнен" : "Не заполнен",
          content: <ProfileSection />,
        },
      ],
    },
    {
      label: "Данные и аккаунт",
      rows: [
        {
          id: "data",
          icon: "database",
          title: "Данные",
          summary: mode === "account" ? "На сервере" : "На устройстве",
          content: <DataSection />,
        },
        {
          id: "account",
          icon: "user",
          title: "Аккаунт",
          summary: !signedIn ? "Без входа" : sessionExpired ? { text: "Войдите снова", tone: "warning" } : user.login,
          content: <AccountSection />,
        },
        { id: "about", icon: "info", title: "О приложении", summary: `Версия ${APP_VERSION}`, content: <AboutSection /> },
      ],
    },
  ];

  return (
    <div className="space-y-4">
      {groups.map((group) => {
        const rows = group.rows.filter((r): r is Row => r !== false);
        if (!rows.length) return null;
        return (
          <SettingsGroup key={group.label} label={group.label}>
            {rows.map((row, i) => (
              <SettingsRow
                key={row.id}
                icon={row.icon}
                title={row.title}
                summary={typeof row.summary === "string" ? { text: row.summary } : row.summary}
                open={openId === row.id}
                onToggle={() => setOpenId((current) => (current === row.id ? null : row.id))}
                divider={i > 0}
              >
                {row.content}
              </SettingsRow>
            ))}
          </SettingsGroup>
        );
      })}
    </div>
  );
}
