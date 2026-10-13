"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  addMonths,
  firstDayOfMonth,
  formatDay,
  formatMonth,
  lastDayOfMonth,
  monthKeyOf,
  monthRange,
  type IsoDate,
  type MonthKey,
} from "@/domain/dates";
import {
  categoryBreakdown,
  monthMetrics,
  periodTotals,
  type BreakdownKind,
  type CategoryRow,
  type MonthMetrics,
} from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { State } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { useUi } from "../app/overlays";
import { Button } from "../ui/Button";
import { Card, EmptyState, Money, Progress, Segmented } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { MonthSwitcher } from "../ui/MonthSwitcher";
import { plural } from "@/domain/text";
import { AiAnalysisCard } from "./analytics/AiAnalysisCard";

type ExpenseKind = Exclude<BreakdownKind, "income">;

const SHORT_MONTHS = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];

/** На этом экране все суммы — итоги и сводки, поэтому без копеек (дизайн-код: «деньги в итогах — без копеек»). */
function rubles(kopecks: Kopecks): string {
  return formatMoney(kopecks, { whole: true });
}

function percent(share: number): string {
  if (share > 0 && share < 0.01) return "<1%";
  return `${Math.round(share * 100)}%`;
}

function normalize(name: string): string {
  return name.trim().toLocaleLowerCase("ru");
}

function limitTone(ratio: number): "positive" | "warning" | "negative" {
  return ratio > 1 ? "negative" : ratio > 0.85 ? "warning" : "positive";
}

/** В месяце нет ни доходов, ни расходов, ни сбережений — ни по факту, ни по плану. */
function isEmptyMonth(m: MonthMetrics): boolean {
  return (
    m.income.fact === 0 &&
    m.income.plan === 0 &&
    m.mandatory.fact === 0 &&
    m.mandatory.plan === 0 &&
    m.flexible.spent === 0 &&
    m.flexible.reserved === 0 &&
    m.savings.fact === 0
  );
}

/** Период, за который смотрим фактические траты месяца: прошлый — целиком, текущий — по сегодня, будущий — пусто. */
function factRange(month: MonthKey, today: IsoDate): { from: IsoDate; to: IsoDate } | null {
  const from = firstDayOfMonth(month);
  if (from > today) return null;
  const last = lastDayOfMonth(month);
  return { from, to: last < today ? last : today };
}

export function Analytics() {
  const { state } = useSnapshot();
  const today = useToday();
  const current = monthKeyOf(today);
  const [month, setMonth] = useState<MonthKey>(current);

  const metrics = useMemo(() => monthMetrics(state, month, today), [state, month, today]);
  const range = useMemo(() => factRange(month, today), [month, today]);
  const empty = isEmptyMonth(metrics);

  return (
    <div className="space-y-4">
      <AiAnalysisCard />
      <div className="flex flex-col items-center gap-2">
        <MonthSwitcher value={month} onChange={setMonth} max={addMonths(current, 12)} />
        <div className="flex flex-wrap items-center justify-center gap-2">
          <StatusBadge metrics={metrics} />
          {month !== current && (
            <Button variant="ghost" size="sm" onClick={() => setMonth(current)}>
              К текущему месяцу
            </Button>
          )}
        </div>
      </div>

      {empty ? (
        <EmptyMonth future={metrics.status === "future"} />
      ) : (
        // В широком окне приложения для Mac — итоги слева, расходы и доходы справа.
        <div className="space-y-4 desktop-app:lg:grid desktop-app:lg:grid-cols-2 desktop-app:lg:items-start desktop-app:lg:gap-4 desktop-app:lg:space-y-0">
          <SummaryCard metrics={metrics} />
          <div className="space-y-4">
            <ExpensesCard month={month} range={range} today={today} />
            <IncomeCard range={range} today={today} />
          </div>
        </div>
      )}
      <TrendCard month={month} today={today} hideWhenEmpty={empty} />
    </div>
  );
}

function StatusBadge({ metrics }: { metrics: MonthMetrics }) {
  let text: string;
  let tone: string;
  if (metrics.status === "past") {
    text = "Прошедший месяц — всё по факту";
    tone = "bg-surface-2 text-muted";
  } else if (metrics.status === "current") {
    const n = metrics.daysLeft;
    const word = plural(n, ["день", "дня", "дней"]);
    text = `Текущий месяц · ${word === "день" ? "остался" : "осталось"} ${n} ${word}`;
    tone = "bg-accent-soft text-accent";
  } else {
    text = "Будущий месяц — только план";
    tone = "bg-warning-soft text-warning";
  }
  return <p className={`rounded-full px-3 py-1 text-sm font-medium ${tone}`}>{text}</p>;
}

function EmptyMonth({ future }: { future: boolean }) {
  const { open } = useUi();
  return (
    <EmptyState
      title="За этот месяц пока нет данных"
      text={
        future
          ? "Добавьте регулярные доходы и платежи — они появятся здесь как план на месяц."
          : "Добавьте доходы и траты — здесь появятся итоги месяца и расходы по категориям."
      }
      action={
        future ? (
          <Button icon="plus" onClick={() => open({ kind: "template" })}>
            Добавить регулярный платёж
          </Button>
        ) : (
          <Button icon="plus" onClick={() => open({ kind: "tx" })}>
            Добавить операцию
          </Button>
        )
      }
    />
  );
}

// ---------- итоги месяца ----------

function SummaryCard({ metrics }: { metrics: MonthMetrics }) {
  const f = metrics.flexible;
  const future = metrics.status === "future";
  const used = f.spent + f.reserved + f.extraSavings;
  const ratio = f.budget > 0 ? used / f.budget : 1;
  const over = f.left < 0;

  return (
    <Card title="Итоги месяца">
      {/* На узком экране подпись справа переносится под сумму, а не наезжает на неё. */}
      <div className="flex flex-wrap items-end justify-between gap-x-3 gap-y-1">
        <div className="min-w-0">
          <p className={`text-sm ${over ? "font-medium text-negative" : "text-muted"}`}>
            {over ? "Перерасход гибкого бюджета" : "Осталось в гибком бюджете"}
          </p>
          <Money whole value={Math.abs(f.left)} tone={over ? "negative" : "default"} className="text-2xl font-semibold" />
        </div>
        <p className="ml-auto text-right text-sm text-muted">
          из {rubles(Math.max(0, f.budget))}
          {f.extraSavings > 0 && (
            <>
              <br />
              отложено сверх нормы {rubles(f.extraSavings)}
            </>
          )}
        </p>
      </div>
      <div className="mt-3">
        <Progress
          value={used}
          max={Math.max(f.budget, 1)}
          tone={ratio > 1 ? "negative" : ratio > 0.85 ? "warning" : "accent"}
          label="Использовано гибкого бюджета"
        />
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2 desktop-app:lg:grid-cols-1">
        <Stat
          label="Доходы"
          value={future ? metrics.income.plan : metrics.income.fact}
          sub={future ? "по плану" : metrics.income.plan !== metrics.income.fact ? `план ${rubles(metrics.income.plan)}` : "факт"}
        />
        <Stat
          label="Обязательные"
          value={future ? metrics.mandatory.plan : metrics.mandatory.fact}
          sub={
            future
              ? "по плану"
              : metrics.mandatory.plan !== metrics.mandatory.fact
                ? `план ${rubles(metrics.mandatory.plan)}`
                : "факт"
          }
        />
        <Stat
          label="Гибкий бюджет"
          value={f.budget}
          tone={f.budget < 0 ? "negative" : "default"}
          sub="план доходов − план обязательных − норма сбережений"
        />
        <Stat
          label="Потрачено"
          value={f.spent}
          sub={f.reserved > 0 ? `ещё запланировано ${rubles(f.reserved)}` : "повседневные траты"}
        />
        <Stat
          label="Отложено"
          value={metrics.savings.fact}
          sub={`план ${rubles(metrics.savings.target)}`}
          wide
        />
      </dl>

      {metrics.warnings.length > 0 && (
        <ul className="mt-4 space-y-2">
          {metrics.warnings.map((w) => (
            <li key={w} className="flex gap-2 rounded-2xl bg-warning-soft px-3 py-2 text-sm">
              <Icon name="alert" size={18} className="mt-0.5 shrink-0 text-warning" />
              <span>{w}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

function Stat({
  label,
  value,
  sub,
  tone = "default",
  wide,
}: {
  label: string;
  value: Kopecks;
  sub?: string;
  tone?: "default" | "positive" | "negative";
  wide?: boolean;
}) {
  return (
    <div className={`flex items-start justify-between gap-3 rounded-2xl bg-surface-2 px-3 py-2.5 ${wide ? "sm:col-span-2 desktop-app:lg:col-span-1" : ""}`}>
      <dt className="shrink-0 text-sm text-muted">{label}</dt>
      <dd className="min-w-0 text-right">
        <Money whole value={value} tone={tone} className="font-semibold whitespace-nowrap" />
        {sub && <span className="block text-xs text-muted">{sub}</span>}
      </dd>
    </div>
  );
}

// ---------- расходы и доходы по категориям ----------

/** Категории с лимитом, по которым в этом виде расходов ещё не было трат. */
function limitedWithoutSpending(state: State, kind: ExpenseKind, rows: CategoryRow[]): CategoryRow[] {
  const present = new Set(rows.map((r) => normalize(r.category)));
  const mandatory = new Set(state.categories.mandatory.map(normalize));
  return Object.entries(state.categoryLimits)
    .filter(([name]) => {
      const key = normalize(name);
      if (present.has(key)) return false;
      if (kind === "mandatory") return mandatory.has(key);
      if (kind === "flexible") return !mandatory.has(key);
      return true;
    })
    .map(([category, limit]) => ({ category, amount: 0, count: 0, share: 0, limit }))
    .sort((a, b) => a.category.localeCompare(b.category, "ru"));
}

function rangeText(range: { from: IsoDate; to: IsoDate }, today: IsoDate): string {
  return range.to === today && range.from !== today
    ? `С ${formatDay(range.from, today)} по сегодня`
    : range.from === range.to
      ? formatDay(range.from, today)
      : `С ${formatDay(range.from, today)} по ${formatDay(range.to, today)}`;
}

function ExpensesCard({
  month,
  range,
  today,
}: {
  month: MonthKey;
  range: { from: IsoDate; to: IsoDate } | null;
  today: IsoDate;
}) {
  const { state } = useSnapshot();
  const { open } = useUi();
  const [kind, setKind] = useState<ExpenseKind>("flexible");

  const rows = useMemo(() => {
    if (!range) return [];
    const spent = categoryBreakdown(state, range.from, range.to, kind);
    return [...spent, ...limitedWithoutSpending(state, kind, spent)];
  }, [state, range, kind]);
  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  return (
    <Card title="Расходы по категориям">
      <Segmented
        label="Вид расходов"
        value={kind}
        onChange={setKind}
        options={[
          { value: "flexible", label: "Повседневные" },
          { value: "mandatory", label: "Обязательные" },
          { value: "expense", label: "Все" },
        ]}
      />

      {!range ? (
        <p className="mt-4 text-sm text-muted">
          {formatMonth(month)} ещё не начался — трат пока нет. Плановые доходы и обязательные платежи видны в итогах
          выше.
        </p>
      ) : rows.length === 0 ? (
        <p className="mt-4 text-sm text-muted">
          {kind === "mandatory"
            ? "Обязательных расходов за этот период нет."
            : kind === "flexible"
              ? "Повседневных трат за этот период нет."
              : "Расходов за этот период нет."}
        </p>
      ) : (
        <>
          <p className="mt-3 flex justify-between gap-3 text-sm text-muted">
            <span>{rangeText(range, today)}</span>
            <span>
              всего <Money whole value={total} className="font-semibold text-text" />
            </span>
          </p>
          <ul className="mt-2 space-y-0.5">
            {rows.map((row) => (
              <ExpenseRow key={row.category} row={row} onClick={() => open({ kind: "limit", category: row.category })} />
            ))}
          </ul>
          <p className="mt-2 text-xs text-muted">Нажмите на категорию, чтобы задать или изменить лимит.</p>
        </>
      )}

      <Button variant="soft" size="sm" icon="plus" className="mt-4" onClick={() => open({ kind: "limit" })}>
        Добавить лимит
      </Button>
    </Card>
  );
}

function ExpenseRow({ row, onClick }: { row: CategoryRow; onClick: () => void }) {
  const ratio = row.limit ? row.amount / row.limit : 0;
  const details: string[] = [];
  if (row.count > 0) details.push(`${percent(row.share)} расходов`);
  if (row.limit) {
    details.push(
      row.amount > row.limit
        ? `сверх лимита ${rubles(row.amount - row.limit)}`
        : `осталось ${rubles(row.limit - row.amount)}`,
    );
  }
  // Кнопка растянута на всю строку через ::after — так внутри можно держать прогресс-бар (div нельзя класть в button).
  return (
    <li className="relative -mx-2 rounded-2xl px-2 py-2.5 transition hover:bg-surface-2">
      <div className="flex items-baseline justify-between gap-3">
        <button
          type="button"
          onClick={onClick}
          className="min-w-0 truncate text-left text-[15px] font-medium after:absolute after:inset-0 after:rounded-2xl after:content-['']"
        >
          {row.category}
          <span className="sr-only">{row.limit !== null ? " — изменить лимит" : " — задать лимит"}</span>
        </button>
        <span className="shrink-0 text-[15px]">
          <Money
            whole
            value={row.amount}
            className="font-semibold"
            tone={row.limit !== null && ratio > 1 ? "negative" : "default"}
          />
          {row.limit !== null && <span className="text-sm text-muted"> из {rubles(row.limit)}</span>}
        </span>
      </div>
      {details.length > 0 && <p className="mt-0.5 text-sm text-muted">{details.join(" · ")}</p>}
      <div className="mt-1.5">
        {row.limit !== null ? (
          <Progress value={row.amount} max={row.limit} tone={limitTone(ratio)} label={`Лимит «${row.category}»`} />
        ) : (
          <ShareBar share={row.share} tone="accent" />
        )}
      </div>
    </li>
  );
}

function ShareBar({ share, tone }: { share: number; tone: "accent" | "positive" }) {
  return (
    <span className="block h-2 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
      <span
        className={`block h-full rounded-full ${tone === "positive" ? "bg-positive" : "bg-accent"}`}
        style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }}
      />
    </span>
  );
}

function IncomeCard({ range, today }: { range: { from: IsoDate; to: IsoDate } | null; today: IsoDate }) {
  const { state } = useSnapshot();
  const rows = useMemo(() => (range ? categoryBreakdown(state, range.from, range.to, "income") : []), [state, range]);
  const total = rows.reduce((sum, r) => sum + r.amount, 0);

  return (
    <Card title="Доходы по категориям">
      {!range ? (
        <p className="text-sm text-muted">Месяц ещё не начался — доходы появятся здесь, когда поступят.</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">Доходов за этот период пока нет.</p>
      ) : (
        <>
          <p className="flex justify-between gap-3 text-sm text-muted">
            <span>{rangeText(range, today)}</span>
            <span>
              всего <Money whole value={total} className="font-semibold text-text" />
            </span>
          </p>
          <ul className="mt-2 space-y-3">
            {rows.map((row) => (
              <li key={row.category}>
                <div className="flex items-baseline justify-between gap-3">
                  <span className="min-w-0 truncate text-[15px] font-medium">{row.category}</span>
                  <span className="shrink-0 text-[15px]">
                    <Money whole value={row.amount} tone="positive" className="font-semibold" />
                    <span className="text-sm text-muted"> · {percent(row.share)}</span>
                  </span>
                </div>
                <span className="mt-1.5 block">
                  <ShareBar share={row.share} tone="positive" />
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}

// ---------- динамика ----------

interface TrendPoint {
  month: MonthKey;
  /** null — месяц ещё не начался. */
  totals: { income: Kopecks; expense: Kopecks; savings: Kopecks } | null;
  partial: boolean;
}

/** Сумма переносов остатка прошлого месяца в сбережения за период. */
function rolloverSavings(state: State, from: IsoDate, to: IsoDate): Kopecks {
  let sum = 0;
  for (const tx of state.transactions) {
    if (tx.type === "saving" && tx.rolloverOf && tx.date >= from && tx.date <= to) sum += tx.amount;
  }
  return sum;
}

const SERIES = [
  { key: "income", label: "Доходы", color: "bg-positive" },
  { key: "expense", label: "Расходы", color: "bg-negative" },
  { key: "savings", label: "Отложено", color: "bg-accent" },
] as const;

function TrendCard({ month, today, hideWhenEmpty }: { month: MonthKey; today: IsoDate; hideWhenEmpty?: boolean }) {
  const { state } = useSnapshot();
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  const points = useMemo<TrendPoint[]>(
    () =>
      monthRange(addMonths(month, -5), month).map((m) => {
        const range = factRange(m, today);
        if (!range) return { month: m, totals: null, partial: false };
        const t = periodTotals(state, range.from, range.to);
        // Перенос остатка прошлого месяца не считаем сбережениями этого — как в итогах месяца.
        const rollover = rolloverSavings(state, range.from, range.to);
        return {
          month: m,
          totals: { income: t.income, expense: t.expense, savings: t.savings - rollover },
          partial: range.to !== lastDayOfMonth(m),
        };
      }),
    [state, month, today],
  );

  const max = Math.max(
    1,
    ...points.flatMap((p) => (p.totals ? [p.totals.income, p.totals.expense, Math.max(0, p.totals.savings)] : [])),
  );
  const hasData = points.some((p) => p.totals && (p.totals.income || p.totals.expense || p.totals.savings));
  const multiYear = new Set(points.map((p) => p.month.slice(0, 4))).size > 1;

  if (!hasData && hideWhenEmpty) return null;

  return (
    <Card title="Динамика за 6 месяцев">
      {!hasData ? (
        <p className="text-sm text-muted">За эти месяцы пока нет операций.</p>
      ) : (
        <>
          <ul className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-sm text-muted" aria-hidden="true">
            {SERIES.map((s) => (
              <li key={s.key} className="flex items-center gap-1.5">
                <span className={`h-2.5 w-2.5 rounded-sm ${s.color}`} />
                {s.label}
              </li>
            ))}
          </ul>

          <div className="flex gap-1" aria-hidden="true">
            {points.map((p, i) => {
              const monthIndex = Number(p.month.slice(5, 7)) - 1;
              const showYear = multiYear && (i === 0 || monthIndex === 0);
              const selected = p.month === month;
              return (
                <div
                  key={p.month}
                  className={`flex min-w-0 flex-1 flex-col items-center rounded-xl pt-2 ${selected ? "bg-surface-2" : ""}`}
                  title={
                    p.totals
                      ? `${formatMonth(p.month)}: доходы ${rubles(p.totals.income)}, расходы ${rubles(p.totals.expense)}, отложено ${rubles(p.totals.savings)}`
                      : `${formatMonth(p.month)}: ещё не наступил`
                  }
                >
                  <div className="flex h-32 w-full items-end justify-center gap-0.5 px-0.5">
                    {p.totals ? (
                      SERIES.map((s) => {
                        const value = s.key === "savings" ? Math.max(0, p.totals?.savings ?? 0) : (p.totals?.[s.key] ?? 0);
                        return (
                          <span
                            key={s.key}
                            className={`block w-full max-w-3 rounded-t-sm ${s.color} ${p.partial ? "opacity-70" : ""}`}
                            style={{ height: value > 0 ? `max(2px, ${(value / max) * 100}%)` : 0 }}
                          />
                        );
                      })
                    ) : (
                      <span className="mb-1 text-xs text-muted">—</span>
                    )}
                  </div>
                  <span
                    className={`mt-1 pb-1.5 text-center text-xs leading-tight ${selected ? "font-semibold text-text" : "text-muted"}`}
                  >
                    {SHORT_MONTHS[monthIndex]}
                    {showYear && <span className="block text-[10px]">{p.month.slice(0, 4)}</span>}
                  </span>
                </div>
              );
            })}
          </div>
          {points.some((p) => p.partial) && (
            <p className="mt-2 text-xs text-muted">Текущий месяц — по сегодняшний день, столбики бледнее.</p>
          )}

          <Button
            variant="ghost"
            size="sm"
            className="mt-3"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((v) => !v)}
          >
            {showTable ? "Скрыть цифры" : "Показать цифрами"}
          </Button>
          <div id={tableId} className={showTable ? "mt-2 overflow-x-auto" : "sr-only"}>
            <TrendTable points={points} />
          </div>
        </>
      )}
    </Card>
  );
}

function TrendTable({ points }: { points: TrendPoint[] }) {
  const cell = (value: Kopecks | undefined): ReactNode =>
    value === undefined ? <span className="text-muted">—</span> : rubles(value);
  return (
    <table className="w-full text-sm tabular-nums">
      <caption className="sr-only">Доходы, расходы и отложенное по месяцам</caption>
      <thead>
        <tr className="text-left text-xs text-muted">
          <th scope="col" className="py-1.5 pr-2 font-medium">
            Месяц
          </th>
          <th scope="col" className="py-1.5 pr-2 text-right font-medium">
            Доходы
          </th>
          <th scope="col" className="py-1.5 pr-2 text-right font-medium">
            Расходы
          </th>
          <th scope="col" className="py-1.5 text-right font-medium">
            Отложено
          </th>
        </tr>
      </thead>
      <tbody>
        {[...points].reverse().map((p) => (
          <tr key={p.month} className="border-t border-border">
            <th scope="row" className="whitespace-nowrap py-1.5 pr-2 text-left font-medium">
              {SHORT_MONTHS[Number(p.month.slice(5, 7)) - 1]} ’{p.month.slice(2, 4)}
              <span className="sr-only">
                {" "}
                ({formatMonth(p.month)}
                {p.partial ? ", по сегодня" : p.totals ? "" : ", ещё не наступил"})
              </span>
            </th>
            <td className="whitespace-nowrap py-1.5 pr-2 text-right">{cell(p.totals?.income)}</td>
            <td className="whitespace-nowrap py-1.5 pr-2 text-right">{cell(p.totals?.expense)}</td>
            <td className="whitespace-nowrap py-1.5 text-right">{cell(p.totals?.savings)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
