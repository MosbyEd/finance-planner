"use client";

import { useId, useState, type ReactNode } from "react";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { TransactionType } from "@/domain/schema";
import { plural } from "@/domain/text";
import { Money } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import type { Totals, TypeFilter } from "./operations";

type Tone = "default" | "positive" | "auto";

interface Stat {
  label: string;
  value: Kopecks;
  tone: Tone;
}

/** Что показать в свёрнутой строке: при «Все» — доходы, расходы и изменение остатка, иначе — итог выбранного типа. */
function collapsedStats(totals: Totals, type: TypeFilter): Stat[] {
  const income: Stat = { label: "Доходы", value: totals.income, tone: totals.income > 0 ? "positive" : "default" };
  const expense: Stat = { label: "Расходы", value: -totals.expense, tone: "default" };
  switch (type) {
    case "all":
      return [income, expense, { label: "Изменение", value: totals.net, tone: "auto" }];
    case "income":
      return [income];
    case "expense":
      return totals.mandatory > 0
        ? [expense, { label: "Обязательные", value: -totals.mandatory, tone: "default" }]
        : [expense];
    case "saving":
      return [{ label: savingsLabel(totals), value: -totals.savings, tone: "default" }];
    case "adjustment":
      return [{ label: adjustmentsLabel(totals), value: totals.adjustments, tone: "auto" }];
    case "transfer":
      return [{ label: "Переведено между счетами", value: totals.transfers, tone: "default" }];
  }
}

function savingsLabel(totals: Totals): string {
  return totals.savings < 0 ? "Снято из сбережений" : "Отложено";
}

function adjustmentsLabel(totals: Totals): string {
  return totals.loanAdjustments ? "Корректировки и долги через счёт" : "Корректировки";
}

/**
 * Итоги за период одной компактной строкой («Доходы · Расходы · Изменение»), чтобы список операций
 * начинался на первом экране. По нажатию раскрывается полная раскладка — с подсказками и запланированными.
 * Суммы — без копеек (дизайн-код: деньги в итогах — целыми рублями).
 */
export function TotalsSummary({
  label,
  totals,
  type,
  plannedCount,
  plannedNet,
}: {
  label: string;
  totals: Totals;
  type: TypeFilter;
  plannedCount: number;
  plannedNet: Kopecks;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const show = (t: TransactionType) => type === "all" || type === t;
  const whole = (value: Kopecks) => formatMoney(value, { whole: true });

  return (
    <section aria-label="Итоги" className="surface-card rounded-[28px]">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={detailsId}
        onClick={() => setOpen((v) => !v)}
        className={`flex min-h-14 w-full items-center gap-3 px-4 py-2.5 text-left transition hover:bg-surface-2/60 ${
          open ? "rounded-t-[28px]" : "rounded-[28px]"
        }`}
      >
        {open ? (
          // Раскрыто: те же цифры есть ниже в раскладке — сверху только заголовок, как у карточки.
          <span className="flex min-w-0 flex-1 items-baseline justify-between gap-3">
            <span className="text-[15px] font-semibold">Итоги</span>
            <span className="truncate text-sm text-muted">{label}</span>
          </span>
        ) : (
          <>
            <span className="sr-only">Итоги: {label}. </span>
            <span className="flex min-w-0 flex-1 flex-wrap gap-x-5 gap-y-1">
              {collapsedStats(totals, type).map((s) => (
                <span key={s.label} className="flex min-w-0 flex-col">
                  <span className="truncate text-xs text-muted">{s.label}</span>
                  <Money value={s.value} sign whole tone={s.tone} className="text-[15px] font-semibold leading-snug" />
                </span>
              ))}
            </span>
          </>
        )}
        <Icon
          name="chevronDown"
          size={20}
          className={`shrink-0 text-muted transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>

      <div id={detailsId} hidden={!open} className="px-4 pb-4 pt-1">
        {open && (
          <>
            <dl className="space-y-2 text-[15px]">
              {show("income") && (
                <TotalRow label="Доходы">
                  <Money
                    value={totals.income}
                    sign
                    whole
                    tone={totals.income > 0 ? "positive" : "default"}
                    className="font-semibold"
                  />
                </TotalRow>
              )}
              {show("expense") && (
                <TotalRow
                  label="Расходы"
                  hint={totals.mandatory > 0 ? `из них обязательные ${whole(totals.mandatory)}` : undefined}
                >
                  <Money value={-totals.expense} whole className="font-semibold" />
                </TotalRow>
              )}
              {show("saving") && (
                <TotalRow
                  label={savingsLabel(totals)}
                  hint={totals.rollover !== 0 ? `в т.ч. остаток прошлого месяца ${whole(totals.rollover)}` : undefined}
                >
                  {/* Как и расходы — со знаком влияния на остаток: отложили — минус, сняли — плюс. */}
                  <Money value={-totals.savings} sign whole className="font-semibold" />
                </TotalRow>
              )}
              {show("adjustment") && (type === "adjustment" || totals.adjustments !== 0) && (
                <TotalRow label={adjustmentsLabel(totals)}>
                  <Money value={totals.adjustments} sign whole tone="auto" className="font-semibold" />
                </TotalRow>
              )}
              <div className="border-t border-separator pt-2">
                <TotalRow label="Изменение остатка" hint="Доходы − расходы − отложено ± корректировки" strong>
                  <Money value={totals.net} sign whole tone="auto" className="text-lg font-semibold" />
                </TotalRow>
              </div>
            </dl>
            {plannedCount > 0 && (
              <p className="mt-3 rounded-2xl bg-surface-2 px-3 py-2 text-sm text-muted">
                Ещё {plannedCount}{" "}
                {plural(plannedCount, ["операция запланирована", "операции запланированы", "операций запланировано"])} —{" "}
                {plural(plannedCount, ["изменит", "изменят", "изменят"])} остаток на{" "}
                {formatMoney(plannedNet, { sign: true, whole: true })}. В итоги{" "}
                {plural(plannedCount, ["она", "они", "они"])} пока не {plural(plannedCount, ["входит", "входят", "входят"])}.
              </p>
            )}
          </>
        )}
      </div>
    </section>
  );
}

function TotalRow({
  label,
  hint,
  strong,
  children,
}: {
  label: string;
  hint?: string;
  strong?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <dt className="min-w-0">
        <span className={strong ? "font-semibold" : "text-muted"}>{label}</span>
        {hint && <span className="block text-xs text-muted">{hint}</span>}
      </dt>
      <dd className="shrink-0 text-right">{children}</dd>
    </div>
  );
}
