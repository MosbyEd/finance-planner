"use client";

import { payPeriodStatus } from "@/domain/metrics";
import { useSnapshot, useToday } from "@/client/react";
import { useDispatch } from "../../app/hooks";
import { Notice } from "../../ui/controls";
import { ChoiceChips } from "./common";
import { SectionCard } from "./SettingsList";

/**
 * Период бюджета: от зарплаты до зарплаты (по регулярным доходам «Зарплата» и «Аванс») или календарный месяц.
 * Меняется сразу, без «Сохранить»; ниже — какой период сейчас или почему его не удалось определить.
 */
export function BudgetPeriodSection() {
  const { state } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const period = state.settings.budgetPeriod ?? "pay";
  const status = payPeriodStatus(state, today);

  const choose = (next: string) => {
    const settings = { ...state.settings };
    if (next === "month") settings.budgetPeriod = "month";
    else delete settings.budgetPeriod;
    dispatch({ type: "settings.update", settings });
  };

  return (
    <SectionCard title="Период бюджета">
      <div className="space-y-4">
        <ChoiceChips
          label="Считать гибкий бюджет и лимит на день"
          value={period}
          options={[
            { value: "pay", label: "От зарплаты до зарплаты" },
            { value: "month", label: "Календарный месяц" },
          ]}
          onChange={choose}
        />
        <p className="text-sm text-muted">
          {period === "pay"
            ? "Период — от поступления зарплаты или аванса до следующего. Доходы и обязательные платежи этого периода минус норма сбережений — гибкий бюджет; на Главной видно, сколько будет в день после следующего поступления. Зарплата и аванс — регулярные доходы на вкладке «Регулярные»."
            : "Гибкий бюджет и лимит на день — на календарный месяц, с 1-го по последнее число."}
        </p>
        <Notice tone={status.ok ? "positive" : "warning"}>{status.text}</Notice>
      </div>
    </SectionCard>
  );
}
