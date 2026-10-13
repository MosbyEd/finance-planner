"use client";

import { useMemo, useState } from "react";
import { formatDay, formatMonthIn, monthKeyOf, type IsoDate, type MonthKey } from "@/domain/dates";
import { formatMoney, percentOf, type Kopecks } from "@/domain/money";
import { isSkipped, nextOccurrence, occurrenceDate, templateEnd, type TemplateEnd } from "@/domain/recurring";
import { findAccount, MAIN_ACCOUNT_ID, paymentReserveAccounts } from "@/domain/accounts";
import type { State, Template } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { templateRoute } from "../app/accounts";
import { useDispatch } from "../app/hooks";
import { useUi } from "../app/overlays";
import { Button } from "../ui/Button";
import { Card, EmptyState, Money } from "../ui/controls";
import { Icon } from "../ui/Icon";
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

/** Шаблон ещё действует: не на паузе и не закончился (срок, закрытый долг, накопленная цель). */
function isLive(state: State, t: Template, today: IsoDate): boolean {
  return t.active && templateEnd(state, t, today).status !== "finished";
}

/** Строка расшифровки итога: регулярный платёж или доход, из которых сложилась сумма. */
interface Part {
  id: string;
  title: string;
  detail: string;
  amount: Kopecks;
  /** Показан для ясности, но в сумму не входит (платёж со счёта под платежи — его уже покрыли переводы). */
  excluded?: boolean;
}

/** Из чего складывается итог месяца: доходы, обязательные, переводы на накопительные и в цели, прочие переводы. */
interface Breakdown {
  income: Part[];
  mandatory: Part[];
  savings: Part[];
  other: Part[];
  /** Среди прочих переводов есть не только кредитки — строка называется «Переводы на свои счета». */
  otherNotCredit: boolean;
}

const sumParts = (parts: Part[]): Kopecks => parts.reduce((sum, p) => (p.excluded ? sum : sum + p.amount), 0);

/**
 * Действующие шаблоны по строкам итога. Счёт под платежи («Ипотека»): платёж — это переводы на него с зарплаты
 * и аванса; сам платёж с него показан в расшифровке, но второй раз не считается.
 */
function breakdown(state: State, today: IsoDate): Breakdown {
  const reserve = paymentReserveAccounts(state);
  const result: Breakdown = { income: [], mandatory: [], savings: [], other: [], otherNotCredit: false };
  const name = (id: string | undefined) => findAccount(state, id ?? MAIN_ACCOUNT_ID)?.name ?? "";
  for (const t of [...state.templates].sort(byActiveAndDay)) {
    if (!isLive(state, t, today)) continue;
    const day = `${t.dayOfMonth}-го`;
    const part = (detail: string, excluded?: boolean): Part => ({
      id: t.id,
      title: t.title,
      detail,
      amount: t.amount,
      ...(excluded ? { excluded } : {}),
    });
    if (t.kind === "income") {
      result.income.push(part(`${day} · ${t.category}`));
    } else if (t.toAccountId && reserve.has(t.toAccountId)) {
      result.mandatory.push(part(`${day} · перевод на «${name(t.toAccountId)}» под платежи`));
    } else if (t.goalId) {
      const goal = state.goals.find((g) => g.id === t.goalId);
      result.savings.push(part(`${day} · в цель «${goal?.name ?? ""}»`));
    } else if (t.toAccountId) {
      const target = findAccount(state, t.toAccountId);
      if (target?.kind === "savings") result.savings.push(part(`${day} · на «${target.name}»`));
      else {
        result.other.push(part(`${day} · на «${target?.name ?? ""}»`));
        if (target?.kind !== "credit") result.otherNotCredit = true;
      }
    } else if (reserve.has(t.accountId ?? MAIN_ACCOUNT_ID)) {
      result.mandatory.push(part(`${day} · со счёта «${name(t.accountId)}» — уже отложено переводами, не считается`, true));
    } else {
      result.mandatory.push(part(`${day} · ${t.category}`));
    }
  }
  return result;
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
    const parts = breakdown(state, today);
    const income = sumParts(parts.income);
    const expense = sumParts(parts.mandatory);
    const savingsTarget = percentOf(income, state.settings.savingsRatePercent);
    const transfers = { savings: sumParts(parts.savings), other: sumParts(parts.other) };
    // Регулярные переводы на накопительные покрывают норму сбережений; больше нормы — откладывается больше.
    const saving = Math.max(savingsTarget, transfers.savings);
    const skipped: SkippedRow[] = state.templates
      .filter((t) => isSkipped(state, t.id, month))
      .map((t) => ({ template: t, date: occurrenceDate(t, month) }))
      .sort((a, b) => a.date.localeCompare(b.date));
    return {
      month,
      parts,
      incomes: rows("income"),
      expenses: rows("expense"),
      income,
      expense,
      transfers,
      savingsTarget,
      saving,
      // Погашение кредиток — деньги уходят со счёта каждый месяц, поэтому вычитаем и его.
      free: income - expense - saving - transfers.other,
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
            parts={data.parts}
            income={data.income}
            expense={data.expense}
            transfers={data.transfers}
            savingsTarget={data.savingsTarget}
            saving={data.saving}
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
  parts,
  income,
  expense,
  transfers,
  savingsTarget,
  saving,
  rate,
  free,
}: {
  parts: Breakdown;
  income: Kopecks;
  expense: Kopecks;
  transfers: { savings: Kopecks; other: Kopecks };
  savingsTarget: Kopecks;
  saving: Kopecks;
  rate: number;
  free: Kopecks;
}) {
  return (
    <Card title="Итого в месяц">
      <dl className="space-y-1.5 text-[15px]">
        <SummaryRow label="Доходы" value={income} tone="positive" parts={parts.income} />
        <SummaryRow label="Обязательные платежи" value={-expense} parts={parts.mandatory} />
        <SummaryRow
          label="Сбережения"
          value={-saving}
          parts={parts.savings}
          note={
            transfers.savings === 0
              ? `Норма ${rate}% от доходов`
              : transfers.savings < savingsTarget
                ? `Норма ${rate}%, из них ${formatMoney(transfers.savings)} — регулярными переводами на накопительные`
                : `Регулярные переводы на накопительные${transfers.savings > savingsTarget ? ` — больше нормы ${rate}% (${formatMoney(savingsTarget)})` : ` — это и есть норма ${rate}%`}`
          }
        />
        {transfers.other > 0 && (
          // Погашение кредитки — перевод между своими счетами: покупки по ней уже учтены, когда их делали.
          <SummaryRow
            label={parts.otherNotCredit ? "Переводы на свои счета" : "Погашение кредиток"}
            value={-transfers.other}
            parts={parts.other}
            note={
              parts.otherNotCredit
                ? "Уходит со счёта каждый месяц"
                : "Уходит со счёта каждый месяц. В лимите на день покупки по кредитке считаются, когда вы их делаете"
            }
          />
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

function SummaryRow({
  label,
  value,
  tone = "default",
  note,
  neutral = false,
  parts,
}: {
  label: string;
  value: Kopecks;
  tone?: "default" | "positive";
  /** Пояснение под строкой. */
  note?: string;
  /** Справочная сумма: без знака, в «Свободно» не входит. */
  neutral?: boolean;
  /** Из чего сложилась сумма — раскрывается по нажатию на строку. */
  parts?: Part[];
}) {
  const [open, setOpen] = useState(false);
  const expandable = Boolean(parts?.length);
  return (
    <div>
      <div className="flex items-baseline justify-between gap-3">
        <dt className="min-w-0 text-muted">
          {expandable ? (
            <button
              type="button"
              aria-expanded={open}
              onClick={() => setOpen((v) => !v)}
              className="inline-flex items-center gap-1 text-left hover:text-text"
            >
              {label}
              <Icon name="chevronDown" size={14} className={`shrink-0 transition-transform ${open ? "rotate-180" : ""}`} />
            </button>
          ) : (
            label
          )}
        </dt>
        <dd>
          <Money
            value={value}
            sign={!neutral && value > 0}
            tone={!neutral && value > 0 ? tone : "default"}
            className={neutral ? "font-medium text-muted" : "font-medium"}
          />
        </dd>
      </div>
      {note && <p className="text-xs text-muted">{note}</p>}
      {open && parts && (
        <ul className="mt-1.5 mb-2 space-y-1.5 rounded-2xl bg-surface-2 px-3 py-2">
          {parts.map((p) => (
            <li key={p.id} className={`flex items-baseline justify-between gap-3 text-sm ${p.excluded ? "text-muted" : ""}`}>
              <span className="min-w-0">
                <span className="block truncate">{p.title}</span>
                <span className="block text-xs text-muted">{p.detail}</span>
              </span>
              <Money value={p.amount} whole={p.amount % 100 === 0} className={`shrink-0 ${p.excluded ? "line-through" : ""}`} />
            </li>
          ))}
        </ul>
      )}
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

/** Строка состояния: следующий платёж и когда закончится (или почему уже закончился). */
function statusLine(end: TemplateEnd, next: IsoDate | null, today: IsoDate): string {
  if (end.status === "finished") {
    return end.reason === "loan" ? "Закончился — долг закрыт" : end.reason === "goal" ? "Закончился — цель накоплена" : "Закончился — срок прошёл";
  }
  const first = next ? `Следующий — ${formatDay(next, today)}` : "Начнётся позже";
  if (end.status !== "ends" || (next && end.last === next)) {
    return end.status === "ends" ? `${first}, последний` : first;
  }
  return `${first} · последний — ${formatDay(end.last, today)}`;
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
  const end = templateEnd(state, t, today);

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
        <span className={`block text-xs ${t.active && end.status !== "finished" ? "text-muted" : "font-medium text-warning"}`}>
          {!t.active ? "На паузе" : statusLine(end, next, today)}
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
