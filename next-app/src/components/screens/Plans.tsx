"use client";

import { useMemo } from "react";
import { formatDay, formatMonthIn, monthKeyOf, type IsoDate, type MonthKey } from "@/domain/dates";
import { formatMoney, percentOf, type Kopecks } from "@/domain/money";
import { isSkipped, nextOccurrence, occurrenceDate } from "@/domain/recurring";
import type { Template } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { templateRoute } from "../app/accounts";
import { useDispatch } from "../app/hooks";
import { useUi } from "../app/overlays";
import { Button } from "../ui/Button";
import { Card, EmptyState, Money } from "../ui/controls";
import { useToast } from "../ui/feedback";

type Kind = Template["kind"];

interface Row {
  template: Template;
  next: IsoDate | null;
}

interface SkippedRow {
  template: Template;
  date: IsoDate;
}

/** Сначала активные, затем по дню месяца. */
function byActiveAndDay(a: Template, b: Template): number {
  return Number(b.active) - Number(a.active) || a.dayOfMonth - b.dayOfMonth || a.title.localeCompare(b.title, "ru");
}

/** Сумма действующих шаблонов. Платежи на свои счета (погашение кредитки, пополнение накопительного) — не расходы. */
function sumActive(templates: Template[], kind: Kind): Kopecks {
  return templates.reduce((sum, t) => (t.active && t.kind === kind && !(kind === "expense" && t.toAccountId) ? sum + t.amount : sum), 0);
}

function sumTransfers(templates: Template[]): Kopecks {
  return templates.reduce((sum, t) => (t.active && t.kind === "expense" && t.toAccountId ? sum + t.amount : sum), 0);
}

export function Plans() {
  const { state } = useSnapshot();
  const today = useToday();

  const data = useMemo(() => {
    const month = monthKeyOf(today);
    const rows = (kind: Kind): Row[] =>
      state.templates
        .filter((t) => t.kind === kind)
        .sort(byActiveAndDay)
        .map((t) => ({ template: t, next: nextOccurrence(state, t, today)?.date ?? null }));
    const income = sumActive(state.templates, "income");
    const expense = sumActive(state.templates, "expense");
    const savingsTarget = percentOf(income, state.settings.savingsRatePercent);
    const skipped: SkippedRow[] = state.templates
      .filter((t) => isSkipped(state, t.id, month))
      .map((t) => ({ template: t, date: occurrenceDate(t, month) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      month,
      incomes: rows("income"),
      expenses: rows("expense"),
      income,
      expense,
      transfers: sumTransfers(state.templates),
      savingsTarget,
      free: income - expense - savingsTarget,
      skipped,
    };
  }, [state, today]);

  return (
    <div className="space-y-4">
      <p className="text-[15px] text-muted">
        Регулярные доходы и платежи появляются в истории автоматически в свой день. На их основе считается план месяца
        и прогноз.
      </p>

      {state.templates.length === 0 ? (
        <Empty />
      ) : (
        <>
          <SummaryCard
            income={data.income}
            expense={data.expense}
            transfers={data.transfers}
            savingsTarget={data.savingsTarget}
            rate={state.settings.savingsRatePercent}
            free={data.free}
          />
          <TemplateSection kind="income" rows={data.incomes} />
          <TemplateSection kind="expense" rows={data.expenses} />
          {data.skipped.length > 0 && <SkippedCard month={data.month} rows={data.skipped} />}
        </>
      )}
    </div>
  );
}

function SummaryCard({
  income,
  expense,
  transfers,
  savingsTarget,
  rate,
  free,
}: {
  income: Kopecks;
  expense: Kopecks;
  transfers: Kopecks;
  savingsTarget: Kopecks;
  rate: number;
  free: Kopecks;
}) {
  return (
    <Card title="Итого в месяц">
      <dl className="space-y-1.5 text-[15px]">
        <SummaryRow label="Доходы" value={income} tone="positive" />
        <SummaryRow label="Обязательные платежи" value={-expense} />
        <SummaryRow label={`Норма сбережений, ${rate}%`} value={-savingsTarget} />
        {transfers > 0 && (
          // Погашение кредитки и пополнение накопительного — не расходы бюджета, показываем справочно.
          <SummaryRow label="Переводы на свои счета (не расход)" value={-transfers} />
        )}
        <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-border pt-3">
          <dt className="font-medium">Свободно после регулярных платежей</dt>
          <dd>
            <Money value={free} tone={free < 0 ? "negative" : "default"} className="text-lg font-semibold" />
          </dd>
        </div>
      </dl>
      {income === 0 ? (
        <p className="mt-3 text-sm text-muted">Добавьте регулярный доход — без него план месяца не посчитать.</p>
      ) : free < 0 ? (
        <p className="mt-3 text-sm text-negative">
          Платежи и сбережения больше доходов на {formatMoney(-free)}. Сократите платежи или уменьшите норму
          сбережений в настройках.
        </p>
      ) : (
        <p className="mt-3 text-sm text-muted">
          Считается только по активным регулярным доходам и платежам. На главной гибкий бюджет учитывает все операции
          месяца — в том числе разовые доходы и обязательные расходы.
        </p>
      )}
    </Card>
  );
}

function SummaryRow({ label, value, tone = "default" }: { label: string; value: Kopecks; tone?: "default" | "positive" }) {
  return (
    <div className="flex items-baseline justify-between gap-3">
      <dt className="text-muted">{label}</dt>
      <dd>
        <Money value={value} sign={value > 0} tone={value > 0 ? tone : "default"} className="font-medium" />
      </dd>
    </div>
  );
}

function TemplateSection({ kind, rows }: { kind: Kind; rows: Row[] }) {
  const { open } = useUi();
  const isIncome = kind === "income";
  return (
    <Card
      title={isIncome ? "Доходы" : "Обязательные платежи"}
      action={
        <Button
          variant="soft"
          size="sm"
          icon="plus"
          className="min-h-10"
          aria-label={isIncome ? "Добавить регулярный доход" : "Добавить регулярный платёж"}
          onClick={() => open({ kind: "template", preset: { kind } })}
        >
          Добавить
        </Button>
      }
    >
      {rows.length ? (
        <ul className="space-y-0.5">
          {rows.map((row) => (
            <TemplateRow key={row.template.id} row={row} />
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">
          {isIncome
            ? "Добавьте зарплату, аванс или другой регулярный доход — без него не посчитать бюджет."
            : "Аренда, кредит, связь, подписки — всё, что нужно оплачивать каждый месяц."}
        </p>
      )}
    </Card>
  );
}

function TemplateRow({ row }: { row: Row }) {
  const { template: t, next } = row;
  const { state } = useSnapshot();
  const { open } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();

  const toggle = () => {
    const active = !t.active;
    if (dispatch({ type: "template.setActive", id: t.id, active, today })) {
      const noun = t.kind === "income" ? "Регулярный доход" : "Регулярный платёж";
      toast(
        active
          ? `${noun} «${t.title}» возобновлён`
          : `${noun} «${t.title}» приостановлен — новые операции не появятся`,
      );
    }
  };

  const amount = t.kind === "income" ? t.amount : -t.amount;
  const route = templateRoute(state, t);

  // Строка открывает шаблон: кнопка растянута на всю строку через ::after. Справа — сумма и под ней
  // подписанная кнопка паузы, так на узком экране тексту слева остаётся вся ширина.
  return (
    <li className="relative -mx-2 flex min-h-14 items-center gap-3 rounded-2xl px-2 py-2 transition hover:bg-surface-2">
      <button
        type="button"
        onClick={() => open({ kind: "template", templateId: t.id })}
        className="min-w-0 flex-1 text-left after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:outline-none focus-visible:after:outline-2 focus-visible:after:outline-offset-2 focus-visible:after:outline-accent"
      >
        <span className={`block truncate text-[15px] font-medium ${t.active ? "" : "text-muted"}`}>{t.title}</span>
        {/* День платежа важнее категории: на узком экране сокращается категория, а не число. */}
        <span className="flex min-w-0 text-sm text-muted">
          {t.category !== t.title && <span className="min-w-0 truncate">{t.category}</span>}
          <span className="shrink-0 whitespace-nowrap">
            {t.category !== t.title && "\u00a0·\u00a0"}
            {t.dayOfMonth}-го числа
          </span>
        </span>
        {route && <span className="block truncate text-xs text-muted">{route}</span>}
        <span className={`block text-xs ${t.active ? "text-muted" : "font-medium text-warning"}`}>
          {!t.active ? "На паузе" : next ? `Следующий — ${formatDay(next, today)}` : "Начнётся позже"}
        </span>
        <span className="sr-only">, {formatMoney(amount, { sign: true })}</span>
      </button>
      <span className="flex shrink-0 flex-col items-end gap-1.5">
        <span aria-hidden="true">
          <Money
            value={amount}
            sign
            tone={!t.active ? "muted" : t.kind === "income" ? "positive" : "default"}
            className="font-semibold"
          />
        </span>
        {/* Подписанная кнопка, а не значок «II». Капсула 32 pt, область нажатия — 44 pt (::before).
            Название операции — для диктора. */}
        <button
          type="button"
          onClick={toggle}
          className="glass-control relative inline-flex h-8 items-center rounded-full px-3 text-[13px] font-medium transition before:absolute before:-inset-x-1 before:-inset-y-1.5 before:content-[''] active:scale-[0.97]"
        >
          {t.active ? "Пауза" : "Включить"}
          <span className="sr-only"> «{t.title}»</span>
        </button>
      </span>
    </li>
  );
}

function SkippedCard({ month, rows }: { month: MonthKey; rows: SkippedRow[] }) {
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();

  const unskip = ({ template, date }: SkippedRow) => {
    if (dispatch({ type: "occurrence.unskip", templateId: template.id, month })) {
      toast(
        date <= today
          ? "Операция снова появится в истории"
          : template.kind === "income"
            ? "Доход вернулся в план месяца"
            : "Платёж вернулся в план месяца",
      );
    }
  };

  return (
    <Card title="Пропущено в этом месяце">
      <p className="mb-2 text-sm text-muted">
        Эти операции не появятся в истории {formatMonthIn(month, today)}. Верните, если пропустили по ошибке.
      </p>
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.template.id} className="flex items-center gap-3 py-1.5">
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[15px]">{row.template.title}</span>
              <span className="block text-sm text-muted">
                {formatDay(row.date, today)} · {formatMoney(row.template.amount)}
              </span>
            </span>
            <Button
              variant="secondary"
              size="sm"
              icon="undo"
              className="min-h-10"
              aria-label={`Вернуть «${row.template.title}»`}
              onClick={() => unskip(row)}
            >
              Вернуть
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

function Empty() {
  const { open } = useUi();
  return (
    <EmptyState
      title="Пока нет регулярных доходов и платежей"
      text="Добавьте то, что повторяется каждый месяц: зарплату, аренду, кредит, связь, подписки. Приложение само внесёт их в историю и посчитает, сколько остаётся на жизнь."
      action={
        <div className="flex flex-wrap justify-center gap-2">
          <Button icon="plus" onClick={() => open({ kind: "template", preset: { kind: "income" } })}>
            Добавить доход
          </Button>
          <Button variant="secondary" icon="plus" onClick={() => open({ kind: "template", preset: { kind: "expense" } })}>
            Добавить платёж
          </Button>
        </div>
      }
    />
  );
}
