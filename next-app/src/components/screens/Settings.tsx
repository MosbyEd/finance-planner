"use client";

import { useCallback, useState, type ReactNode } from "react";
import { activeAccounts } from "@/domain/accounts";
import { banksOf } from "@/domain/banks";
import { useSnapshot } from "@/client/react";
import { isNativeApp } from "@/client/runtime";
import { APP_VERSION, AboutSection } from "./settings/AboutSection";
import { AccountSection } from "./settings/AccountSection";
import { AccountsSection } from "./settings/AccountsSection";
import { AppleAiSection } from "./settings/AppleAiSection";
import { BanksSection } from "./settings/BanksSection";
import { BudgetPeriodSection } from "./settings/BudgetPeriodSection";
import { CategoriesSection } from "./settings/CategoriesSection";
import { DataSection } from "./settings/DataSection";
import { NotificationsSection } from "./settings/NotificationsSection";
import { ProfileSection } from "./settings/ProfileSection";
import { SavingsSection } from "./settings/SavingsSection";
import { SmsImportSection } from "./settings/SmsImportSection";
import { useUi } from "../app/overlays";
import { SettingsGroup, SettingsRow, SettingsSection, type RowIconName, type RowSummary } from "./settings/SettingsList";

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
  const { settingsSection, openSettings } = useUi();
  // Состояние, которое разделы сообщают сами (СМС, уведомления, черновик формы), — для их строк.
  const [reported, setReported] = useState<Record<string, RowSummary | null>>({});
  // Одинаковое состояние (по тексту и тону) не перерисовывает список. Функция постоянная: раздел
  // подписывается на неё в эффекте (см. SettingsSection).
  const report = useCallback((id: string, summary: RowSummary | null) => {
    setReported((current) => {
      const prev = current[id] ?? null;
      if (prev?.text === summary?.text && prev?.tone === summary?.tone) return current;
      return { ...current, [id]: summary };
    });
  }, []);
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
        signedIn && {
          id: "banks",
          icon: "bank",
          title: "Банки",
          summary: banksOf(state).length ? String(banksOf(state).length) : "Нет",
          content: <BanksSection />,
        },
        native && { id: "notifications", icon: "bell", title: "Уведомления", content: <NotificationsSection /> },
        native && { id: "apple-ai", icon: "sparkles", title: "Apple Intelligence", content: <AppleAiSection /> },
      ],
    },
    {
      label: "Бюджет",
      rows: [
        {
          id: "period",
          icon: "calendar",
          title: "Период бюджета",
          summary: settings.budgetPeriod === "month" ? "Месяц" : "От зарплаты до зарплаты",
          content: <BudgetPeriodSection />,
        },
        {
          id: "accounts",
          icon: "card",
          title: "Счета",
          summary: String(activeAccounts(state).length),
          content: <AccountsSection />,
        },
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

  const allRows = groups.flatMap((g) => g.rows.filter((r): r is Row => r !== false));
  const current = allRows.find((r) => r.id === settingsSection) ?? null;

  return (
    <div className="space-y-4">
      {/* Список разделов. Открыт раздел — список скрыт, раздел показан отдельной страницей. */}
      <div hidden={current !== null} className="space-y-4">
        {groups.map((group) => {
          const rows = group.rows.filter((r): r is Row => r !== false);
          if (!rows.length) return null;
          return (
            <SettingsGroup key={group.label} label={group.label}>
              {rows.map((row, i) => {
                const summary = reported[row.id] ?? (typeof row.summary === "string" ? { text: row.summary } : row.summary);
                return (
                  <SettingsRow
                    key={row.id}
                    icon={row.icon}
                    title={row.title}
                    summary={summary}
                    onOpen={() => openSettings(row.id)}
                    divider={i > 0}
                  />
                );
              })}
            </SettingsGroup>
          );
        })}
      </div>
      {allRows.map((row) => (
        <SettingsSection
          key={row.id}
          title={row.title}
          open={current?.id === row.id}
          onBack={() => openSettings(null)}
          id={row.id}
          onReport={report}
        >
          {row.content}
        </SettingsSection>
      ))}
    </div>
  );
}
