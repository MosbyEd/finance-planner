"use client";

import { useId, useMemo, useState, type ReactNode } from "react";
import {
  addDays,
  firstDayOfMonth,
  formatDay,
  formatMonth,
  formatRelativeDay,
  isValidIsoDate,
  lastDayOfMonth,
  monthKeyOf,
  type IsoDate,
  type MonthKey,
} from "@/domain/dates";
import { balanceEffect } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { Transaction, TransactionType } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { useUi } from "../app/overlays";
import { TransactionRow } from "../app/TransactionRow";
import { Button, IconButton } from "../ui/Button";
import { Card, EmptyState, Money, Notice, Segmented } from "../ui/controls";
import { DateInput, controlClass } from "../ui/Field";
import { Icon } from "../ui/Icon";
import { MonthSwitcher } from "../ui/MonthSwitcher";
import { plural } from "@/domain/text";

type Mode = "day" | "month" | "period";
type TypeFilter = "all" | TransactionType;

const PAGE_SIZE = 200;

const TYPE_FILTERS: { value: TypeFilter; label: string }[] = [
  { value: "all", label: "Все" },
  { value: "expense", label: "Расходы" },
  { value: "income", label: "Доходы" },
  { value: "saving", label: "Сбережения" },
  { value: "adjustment", label: "Корректировки" },
];


function normalizeText(value: string): string {
  return value.toLocaleLowerCase("ru").replace(/ё/g, "е").trim();
}

interface Totals {
  income: Kopecks;
  expense: Kopecks;
  mandatory: Kopecks;
  savings: Kopecks;
  /** Из отложенного — перенос остатка прошлого месяца (в «Отложено» месяца на главной он не входит). */
  rollover: Kopecks;
  adjustments: Kopecks;
  /** Среди корректировок есть движения по долгам через счёт. */
  loanAdjustments: boolean;
  /** Изменение остатка на счёте: доходы − расходы − отложено + корректировки. */
  net: Kopecks;
}

function totalsOf(list: Transaction[]): Totals {
  const t: Totals = {
    income: 0,
    expense: 0,
    mandatory: 0,
    savings: 0,
    rollover: 0,
    adjustments: 0,
    loanAdjustments: false,
    net: 0,
  };
  for (const tx of list) {
    if (tx.type === "income") t.income += tx.amount;
    else if (tx.type === "expense") {
      t.expense += tx.amount;
      if (tx.mandatory) t.mandatory += tx.amount;
    } else if (tx.type === "saving") {
      t.savings += tx.amount;
      if (tx.rolloverOf) t.rollover += tx.amount;
    } else {
      t.adjustments += tx.amount;
      if (tx.loanId) t.loanAdjustments = true;
    }
    t.net += balanceEffect(tx);
  }
  return t;
}

interface DayGroup {
  date: IsoDate;
  items: Transaction[];
}

/** Группирует уже отсортированный список по дням, сохраняя порядок. */
function groupByDay(list: Transaction[]): DayGroup[] {
  const groups: DayGroup[] = [];
  for (const tx of list) {
    const last = groups[groups.length - 1];
    if (last && last.date === tx.date) last.items.push(tx);
    else groups.push({ date: tx.date, items: [tx] });
  }
  return groups;
}

type Range = { ok: true; from: IsoDate; to: IsoDate; label: string } | { ok: false; error: string };

export function History() {
  const { state } = useSnapshot();
  const today = useToday();
  const { open } = useUi();

  const [mode, setMode] = useState<Mode>("month");
  const [day, setDay] = useState<string>(today);
  const [month, setMonth] = useState<MonthKey>(() => monthKeyOf(today));
  const [from, setFrom] = useState<string>(() => addDays(today, -29));
  const [to, setTo] = useState<string>(today);
  const [type, setType] = useState<TypeFilter>("all");
  const [query, setQuery] = useState("");

  const range = useMemo<Range>(() => {
    if (mode === "day") {
      if (!isValidIsoDate(day)) return { ok: false, error: "Укажите дату." };
      return { ok: true, from: day, to: day, label: formatDay(day, today) };
    }
    if (mode === "month") {
      return { ok: true, from: firstDayOfMonth(month), to: lastDayOfMonth(month), label: formatMonth(month) };
    }
    if (!isValidIsoDate(from) || !isValidIsoDate(to)) return { ok: false, error: "Укажите обе даты периода." };
    if (from > to) return { ok: false, error: "Дата «С» позже даты «По». Поменяйте даты местами." };
    return { ok: true, from, to, label: `${formatDay(from, today)} — ${formatDay(to, today)}` };
  }, [mode, day, month, from, to, today]);

  const data = useMemo(() => {
    if (!range.ok) return null;
    const needle = normalizeText(query);
    const filtered: { tx: Transaction; index: number }[] = [];
    state.transactions.forEach((tx, index) => {
      if (tx.date < range.from || tx.date > range.to) return;
      if (type !== "all" && tx.type !== type) return;
      if (needle && !normalizeText(`${tx.title}\n${tx.category}`).includes(needle)) return;
      filtered.push({ tx, index });
    });
    // Прошедшие — от новых к старым; запланированные — от ближайших к дальним.
    // Внутри дня сверху то, что добавили позже.
    const past = filtered
      .filter((e) => e.tx.date <= today)
      .sort((a, b) => b.tx.date.localeCompare(a.tx.date) || b.index - a.index)
      .map((e) => e.tx);
    const planned = filtered
      .filter((e) => e.tx.date > today)
      .sort((a, b) => a.tx.date.localeCompare(b.tx.date) || b.index - a.index)
      .map((e) => e.tx);
    const daySpent = new Map<IsoDate, Kopecks>();
    for (const { tx } of filtered) {
      if (tx.type === "expense") daySpent.set(tx.date, (daySpent.get(tx.date) ?? 0) + tx.amount);
    }
    return { past, planned, totals: totalsOf(past), plannedNet: totalsOf(planned).net, daySpent };
  }, [state.transactions, range, type, query, today]);

  const filtersActive = type !== "all" || query.trim() !== "";
  const resetFilters = () => {
    setType("all");
    setQuery("");
  };

  if (state.transactions.length === 0) {
    return (
      <EmptyState
        title="Пока нет операций"
        text="Здесь появятся все ваши доходы, расходы и движения по сбережениям. Добавьте первую операцию — например, сегодняшнюю покупку."
        action={
          <Button icon="plus" onClick={() => open({ kind: "tx" })}>
            Добавить операцию
          </Button>
        }
      />
    );
  }

  const listKey = range.ok ? `${range.from}|${range.to}|${type}|${query}` : "invalid";
  const count = data ? data.past.length + data.planned.length : 0;

  return (
    <div className="space-y-4">
      <section aria-label="Период и фильтры" className="space-y-3">
        <Segmented
          label="Период"
          value={mode}
          onChange={setMode}
          options={[
            { value: "day", label: "День" },
            { value: "month", label: "Месяц" },
            { value: "period", label: "Период" },
          ]}
        />

        {mode === "day" && <DayPicker value={day} onChange={setDay} today={today} />}
        {mode === "month" && (
          <div className="flex justify-center">
            <MonthSwitcher value={month} onChange={setMonth} />
          </div>
        )}
        {mode === "period" && (
          <div className="grid grid-cols-2 gap-3">
            <DateInput label="С" value={from} onChange={(e) => setFrom(e.target.value)} />
            <DateInput label="По" value={to} onChange={(e) => setTo(e.target.value)} />
          </div>
        )}

        <SearchBox value={query} onChange={setQuery} />

        <div role="group" aria-label="Тип операций" className="flex flex-wrap gap-2">
          {TYPE_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={type === f.value}
              onClick={() => setType(f.value)}
              className={`h-10 rounded-full border px-4 text-sm font-medium transition ${
                type === f.value ? "sheen border-accent bg-accent text-accent-text" : "glass-control text-text"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </section>

      {!range.ok ? (
        <Notice tone="negative">
          <span role="alert">{range.error}</span>
        </Notice>
      ) : data && count === 0 ? (
        filtersActive ? (
          <EmptyState
            title="Ничего не нашлось"
            text="Под выбранный тип и запрос за этот период ничего не подходит. Измените запрос или сбросьте фильтры."
            action={
              <Button variant="secondary" onClick={resetFilters}>
                Сбросить фильтры
              </Button>
            }
          />
        ) : (
          <EmptyState
            title={mode === "day" ? "В этот день операций нет" : "За этот период операций нет"}
            text={mode === "day" ? "Добавьте операцию на этот день или выберите другую дату." : "Выберите другой период или добавьте операцию кнопкой «+»."}
            action={
              mode === "day" ? (
                <Button variant="soft" icon="plus" onClick={() => open({ kind: "tx", preset: { date: day } })}>
                  Добавить на этот день
                </Button>
              ) : undefined
            }
          />
        )
      ) : data ? (
        <>
          <TotalsCard
            label={range.label}
            totals={data.totals}
            type={type}
            plannedCount={data.planned.length}
            plannedNet={data.plannedNet}
          />
          <div className="flex min-h-10 items-center justify-between gap-3 px-1">
            <p className="text-sm text-muted" aria-live="polite">
              {count} {plural(count, ["операция", "операции", "операций"])}
            </p>
            {filtersActive && (
              <Button variant="ghost" size="sm" className="-mr-2" onClick={resetFilters}>
                Сбросить фильтры
              </Button>
            )}
          </div>
          <OperationList
            key={listKey}
            past={data.past}
            planned={data.planned}
            daySpent={data.daySpent}
            today={today}
            onOpen={(txId) => open({ kind: "tx", txId })}
          />
        </>
      ) : null}
    </div>
  );
}

function DayPicker({ value, onChange, today }: { value: string; onChange: (value: string) => void; today: IsoDate }) {
  const valid = isValidIsoDate(value);
  const base = valid ? value : today;
  return (
    <div className="flex items-end gap-2">
      <IconButton
        icon="chevronLeft"
        label="Предыдущий день"
        variant="secondary"
        size={48}
        onClick={() => onChange(addDays(base, -1))}
      />
      <div className="min-w-0 flex-1">
        <DateInput label="Дата" value={value} onChange={(e) => onChange(e.target.value)} />
      </div>
      <IconButton
        icon="chevronRight"
        label="Следующий день"
        variant="secondary"
        size={48}
        onClick={() => onChange(addDays(base, 1))}
      />
    </div>
  );
}

function SearchBox({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="relative">
      <label htmlFor={id} className="sr-only">
        Поиск по названию и категории
      </label>
      <Icon
        name="search"
        size={18}
        className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-muted"
      />
      <input
        id={id}
        type="search"
        value={value}
        placeholder="Поиск по названию и категории"
        autoComplete="off"
        enterKeyHint="search"
        onChange={(e) => onChange(e.target.value)}
        className={`${controlClass} h-12 pl-10 ${value ? "pr-12" : ""} [&::-webkit-search-cancel-button]:hidden`}
      />
      {value && (
        <IconButton
          icon="close"
          label="Очистить поиск"
          size={40}
          className="absolute right-1 top-1/2 -translate-y-1/2 text-muted"
          onClick={() => onChange("")}
        />
      )}
    </div>
  );
}

function TotalsCard({
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
  const show = (t: TransactionType) => type === "all" || type === t;
  const savingsOut = totals.savings < 0;
  return (
    <Card title="Итоги" action={<span className="text-right text-sm text-muted">{label}</span>}>
      <dl className="space-y-2 text-[15px]">
        {show("income") && (
          <TotalRow label="Доходы">
            <Money value={totals.income} sign tone={totals.income > 0 ? "positive" : "default"} className="font-semibold" />
          </TotalRow>
        )}
        {show("expense") && (
          <TotalRow
            label="Расходы"
            hint={totals.mandatory > 0 ? `из них обязательные ${formatMoney(totals.mandatory)}` : undefined}
          >
            <Money value={-totals.expense} className="font-semibold" />
          </TotalRow>
        )}
        {show("saving") && (
          <TotalRow
            label={savingsOut ? "Снято из сбережений" : "Отложено"}
            hint={totals.rollover !== 0 ? `в т.ч. остаток прошлого месяца ${formatMoney(totals.rollover)}` : undefined}
          >
            {/* Как и расходы — со знаком влияния на остаток: отложили — минус, сняли — плюс. */}
            <Money value={-totals.savings} sign className="font-semibold" />
          </TotalRow>
        )}
        {show("adjustment") && (type === "adjustment" || totals.adjustments !== 0) && (
          <TotalRow label={totals.loanAdjustments ? "Корректировки и долги через счёт" : "Корректировки"}>
            <Money value={totals.adjustments} sign tone="auto" className="font-semibold" />
          </TotalRow>
        )}
        <div className="border-t border-border pt-2">
          <TotalRow label="Изменение остатка" hint="Доходы − расходы − отложено ± корректировки" strong>
            <Money value={totals.net} sign tone="auto" className="text-lg font-semibold" />
          </TotalRow>
        </div>
      </dl>
      {plannedCount > 0 && (
        <p className="mt-3 rounded-2xl bg-surface-2 px-3 py-2 text-sm text-muted">
          Ещё {plannedCount} {plural(plannedCount, ["операция запланирована", "операции запланированы", "операций запланировано"])}{" "}
          — {plural(plannedCount, ["изменит", "изменят", "изменят"])} остаток на {formatMoney(plannedNet, { sign: true })}.
          В итоги {plural(plannedCount, ["она", "они", "они"])} пока не {plural(plannedCount, ["входит", "входят", "входят"])}.
        </p>
      )}
    </Card>
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

function OperationList({
  past,
  planned,
  daySpent,
  today,
  onOpen,
}: {
  past: Transaction[];
  planned: Transaction[];
  daySpent: Map<IsoDate, Kopecks>;
  today: IsoDate;
  onOpen: (txId: string) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const plannedId = useId();
  const total = planned.length + past.length;
  const visiblePlanned = planned.slice(0, limit);
  const visiblePast = past.slice(0, Math.max(0, limit - visiblePlanned.length));
  const rest = total - visiblePlanned.length - visiblePast.length;

  return (
    <div className="space-y-5">
      {visiblePlanned.length > 0 && (
        <section
          aria-labelledby={plannedId}
          className="space-y-3 rounded-[32px] border border-dashed border-border-strong/50 bg-card/40 p-3 sm:p-4"
        >
          <div className="px-1">
            <h2 id={plannedId} className="flex items-center gap-1.5 text-[15px] font-semibold text-muted">
              <Icon name="calendar" size={16} /> Запланировано
            </h2>
            <p className="mt-0.5 text-sm text-muted">
              Операции с будущей датой. Остаток на счёте изменится в день операции.
            </p>
          </div>
          <DayGroups groups={groupByDay(visiblePlanned)} daySpent={daySpent} today={today} onOpen={onOpen} muted />
        </section>
      )}

      {visiblePast.length > 0 && (
        <DayGroups groups={groupByDay(visiblePast)} daySpent={daySpent} today={today} onOpen={onOpen} />
      )}

      {rest > 0 && (
        <div className="flex justify-center">
          <Button variant="secondary" onClick={() => setLimit((n) => n + PAGE_SIZE)}>
            Показать ещё {Math.min(rest, PAGE_SIZE)} из {rest}
          </Button>
        </div>
      )}
    </div>
  );
}

function DayGroups({
  groups,
  daySpent,
  today,
  onOpen,
  muted,
}: {
  groups: DayGroup[];
  daySpent: Map<IsoDate, Kopecks>;
  today: IsoDate;
  onOpen: (txId: string) => void;
  muted?: boolean;
}) {
  return (
    <ul className="space-y-4">
      {groups.map((g) => {
        const spent = daySpent.get(g.date) ?? 0;
        return (
          <li key={g.date}>
            <div className="flex items-baseline justify-between gap-3 px-1 pb-1.5">
              <h3 className="text-sm font-semibold text-muted">{formatRelativeDay(g.date, today)}</h3>
              {spent > 0 && (
                <span className="text-sm text-muted">
                  <span className="sr-only">Расходы за день: </span>
                  <Money value={-spent} />
                </span>
              )}
            </div>
            <ul
              className={`surface-card rounded-[28px] px-4 py-1 ${muted ? "bg-card/60" : ""}`}
            >
              {g.items.map((tx) => (
                <li key={tx.id}>
                  <TransactionRow tx={tx} onClick={() => onOpen(tx.id)} />
                </li>
              ))}
            </ul>
          </li>
        );
      })}
    </ul>
  );
}
