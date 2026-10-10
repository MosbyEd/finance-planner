"use client";

import { useId, useMemo, useState } from "react";
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
import type { Kopecks } from "@/domain/money";
import type { Transaction } from "@/domain/schema";
import { plural } from "@/domain/text";
import { useSnapshot, useToday } from "@/client/react";
import { useUi } from "../app/overlays";
import { TransactionRow } from "../app/TransactionRow";
import { Button } from "../ui/Button";
import { EmptyState, Money, Notice } from "../ui/controls";
import { Icon } from "../ui/Icon";
import { PeriodPicker, SearchBox, TypeChips, type Mode } from "./history/Controls";
import { groupByDay, historyData, type DayGroup, type TypeFilter } from "./history/operations";
import { TotalsSummary } from "./history/TotalsSummary";

const PAGE_SIZE = 200;

const OPERATIONS: readonly [string, string, string] = ["операция", "операции", "операций"];

type Range = { ok: true; from: IsoDate; to: IsoDate; label: string } | { ok: false; error: string };

/**
 * История: сверху поиск, период и тип (компактно, без переносов), итоги — одной строкой с раскрытием,
 * и сразу список операций — чтобы найти и поправить операцию, не прокручивая экран.
 */
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

  const data = useMemo(
    () => (range.ok ? historyData(state.transactions, { from: range.from, to: range.to, type, query, today }) : null),
    [state.transactions, range, type, query, today],
  );

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
  // Считаем строки списка: автоотчисления, свёрнутые в подпись покупки, отдельно не считаются.
  const count = data ? data.past.length + data.planned.length : 0;

  return (
    <div className="space-y-3">
      <section aria-label="Поиск и фильтры" className="space-y-2">
        <SearchBox value={query} onChange={setQuery} />
        <PeriodPicker
          mode={mode}
          onModeChange={setMode}
          day={day}
          onDayChange={setDay}
          month={month}
          onMonthChange={setMonth}
          from={from}
          onFromChange={setFrom}
          to={to}
          onToChange={setTo}
          today={today}
          invalid={!range.ok}
        />
        <TypeChips value={type} onChange={setType} />
      </section>

      {!range.ok ? (
        <Notice tone="negative">
          <span role="alert">{range.error}</span>
        </Notice>
      ) : data ? (
        <>
          {count > 0 && (
            <TotalsSummary
              label={range.label}
              totals={data.totals}
              type={type}
              plannedCount={data.planned.length}
              plannedNet={data.plannedNet}
            />
          )}

          {/* Число найденных видно, пока действует фильтр; без фильтра — только для экранного диктора. */}
          <div className={filtersActive && count > 0 ? "flex min-h-11 items-center justify-between gap-3 px-1" : "sr-only"}>
            <p className="text-sm text-muted" aria-live="polite">
              {filtersActive ? "Найдено: " : ""}
              {count} {plural(count, OPERATIONS)}
            </p>
            {filtersActive && count > 0 && (
              <Button variant="ghost" size="sm" className="-mr-2 min-h-11" onClick={resetFilters}>
                Сбросить фильтры
              </Button>
            )}
          </div>

          {count === 0 ? (
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
                text={
                  mode === "day"
                    ? "Добавьте операцию на этот день или выберите другую дату."
                    : "Выберите другой период или добавьте операцию кнопкой «+»."
                }
                action={
                  mode === "day" ? (
                    <Button variant="soft" icon="plus" onClick={() => open({ kind: "tx", preset: { date: day } })}>
                      Добавить на этот день
                    </Button>
                  ) : undefined
                }
              />
            )
          ) : (
            <OperationList
              key={listKey}
              past={data.past}
              planned={data.planned}
              plannedNet={data.plannedNet}
              plannedOpen={data.past.length === 0 || query.trim() !== ""}
              daySpent={data.daySpent}
              today={today}
              onOpen={(txId) => open({ kind: "tx", txId })}
            />
          )}
        </>
      ) : null}
    </div>
  );
}

function OperationList({
  past,
  planned,
  plannedNet,
  plannedOpen,
  daySpent,
  today,
  onOpen,
}: {
  past: Transaction[];
  planned: Transaction[];
  plannedNet: Kopecks;
  /** Раскрыть запланированные сразу: прошедших нет или идёт поиск. */
  plannedOpen: boolean;
  daySpent: Map<IsoDate, Kopecks>;
  today: IsoDate;
  onOpen: (txId: string) => void;
}) {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const total = planned.length + past.length;
  const visiblePlanned = planned.slice(0, limit);
  const visiblePast = past.slice(0, Math.max(0, limit - visiblePlanned.length));
  const rest = total - visiblePlanned.length - visiblePast.length;

  return (
    <div className="space-y-4">
      {visiblePlanned.length > 0 && (
        <PlannedSection
          groups={groupByDay(visiblePlanned)}
          count={planned.length}
          net={plannedNet}
          defaultOpen={plannedOpen}
          daySpent={daySpent}
          today={today}
          onOpen={onOpen}
        />
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

/**
 * Операции с будущей датой. Свёрнуты в одну строку (сколько и на какую сумму), чтобы не отодвигать
 * сегодняшние операции вниз; раскрываются по нажатию.
 */
function PlannedSection({
  groups,
  count,
  net,
  defaultOpen,
  daySpent,
  today,
  onOpen,
}: {
  groups: DayGroup[];
  count: number;
  net: Kopecks;
  defaultOpen: boolean;
  daySpent: Map<IsoDate, Kopecks>;
  today: IsoDate;
  onOpen: (txId: string) => void;
}) {
  const [expanded, setExpanded] = useState(defaultOpen);
  const headingId = useId();
  const bodyId = useId();
  return (
    <section
      aria-labelledby={headingId}
      className="rounded-[28px] border border-dashed border-border-strong/50 bg-card/40"
    >
      <h2 id={headingId}>
        <button
          type="button"
          aria-expanded={expanded}
          aria-controls={bodyId}
          onClick={() => setExpanded((v) => !v)}
          className="flex min-h-12 w-full items-center gap-2 rounded-[28px] px-4 py-2 text-left transition hover:bg-surface-2/60"
        >
          <Icon name="calendar" size={16} className="shrink-0 text-muted" />
          <span className="min-w-0 flex-1">
            <span className="block text-[15px] font-semibold text-muted">Запланировано</span>
            <span className="block text-sm text-muted">
              {count} {plural(count, OPERATIONS)}
            </span>
          </span>
          <span className="shrink-0 text-[15px] text-muted">
            <span className="sr-only">{plural(count, ["Изменит", "Изменят", "Изменят"])} остаток на </span>
            <Money value={net} sign whole />
          </span>
          <Icon
            name="chevronDown"
            size={20}
            className={`shrink-0 text-muted transition-transform duration-200 ${expanded ? "rotate-180" : ""}`}
          />
        </button>
      </h2>
      <div id={bodyId} hidden={!expanded} className="space-y-3 px-3 pb-3">
        {expanded && (
          <>
            <p className="px-1 text-sm text-muted">Остаток на счёте изменится в день операции.</p>
            <DayGroups groups={groups} daySpent={daySpent} today={today} onOpen={onOpen} muted />
          </>
        )}
      </div>
    </section>
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
                  <Money value={-spent} whole />
                </span>
              )}
            </div>
            <ul className={`surface-card rounded-[28px] px-4 py-1 ${muted ? "bg-card/60" : ""}`}>
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
