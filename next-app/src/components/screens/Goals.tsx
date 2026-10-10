"use client";

import { useMemo, useState } from "react";
import { diffDays, formatDay, type IsoDate } from "@/domain/dates";
import { creditDebts, type CreditStatus } from "@/domain/accounts";
import { goalSaved, goalsReserved, loanRemaining, savingsTotal } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { Goal, Loan, LoanKind } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { useUi } from "../app/overlays";
import {
  GOAL_REACHED_TEXT,
  daysLeftText,
  goalAdvice,
  goalDueText,
  goalPace,
  goalWithdrawable,
  type GoalPace,
} from "../app/sheets/GoalSheets";
import { Button } from "../ui/Button";
import { Card, EmptyState, Money, Progress, Segmented } from "../ui/controls";
import { Icon } from "../ui/Icon";

type View = "goals" | "debts";

const LOAN_KIND_LABEL: Record<LoanKind, string> = {
  borrow: "Мой долг",
  credit: "Кредит",
  lend: "Мне должны",
};

/** Сначала незакрытые, среди них — с ближайшим сроком; без срока — в конце. */
function byOpenAndDue(a: { done: boolean; due: IsoDate | null; name: string }, b: typeof a): number {
  if (a.done !== b.done) return a.done ? 1 : -1;
  if (a.due !== b.due) {
    if (a.due === null) return 1;
    if (b.due === null) return -1;
    return a.due.localeCompare(b.due);
  }
  return a.name.localeCompare(b.name, "ru");
}

export function Goals() {
  const [view, setView] = useState<View>("goals");
  return (
    <div className="space-y-4">
      <Segmented
        label="Раздел"
        value={view}
        onChange={setView}
        options={[
          { value: "goals", label: "Цели" },
          { value: "debts", label: "Долги" },
        ]}
      />
      {view === "goals" ? <GoalsView /> : <DebtsView />}
    </div>
  );
}

// ---------- цели ----------

interface GoalItem {
  goal: Goal;
  pace: GoalPace;
}

function GoalsView() {
  const { state } = useSnapshot();
  const today = useToday();
  const { open } = useUi();

  const data = useMemo(() => {
    const items: GoalItem[] = state.goals
      .map((goal) => ({ goal, pace: goalPace(goal.targetAmount, goalSaved(state, goal), goal.dueDate, today) }))
      .sort((a, b) =>
        byOpenAndDue(
          { done: a.pace.status === "reached", due: a.goal.dueDate, name: a.goal.name },
          { done: b.pace.status === "reached", due: b.goal.dueDate, name: b.goal.name },
        ),
      );
    const total = savingsTotal(state, today);
    // Деньги, отложенные на цели внутри приложения (без накопленного до него), и счета целей.
    const inGoals = goalsReserved(state);
    const hasInitial = state.goals.some((g) => g.initialAmount > 0);
    return { items, total, inGoals, free: total - inGoals, hasInitial };
  }, [state, today]);

  return (
    <>
      <Card
        title="Сбережения"
        action={
          <Button
            variant="soft"
            size="sm"
            icon="piggy"
            className="min-h-10"
            onClick={() => open({ kind: "savings", direction: "in" })}
          >
            Пополнить
          </Button>
        }
      >
        <p className="text-sm text-muted">Всего в сбережениях</p>
        <Money value={data.total} className="text-2xl font-semibold" />
        <dl className="mt-3 grid grid-cols-2 gap-2">
          <div className="rounded-2xl bg-surface-2 px-3 py-2">
            <dt className="text-sm text-muted">Из них на целях</dt>
            <dd>
              <Money value={data.inGoals} className="font-semibold" />
              {data.hasInitial && <span className="block text-xs text-muted">Без накопленного до приложения</span>}
            </dd>
          </div>
          <div className="rounded-2xl bg-surface-2 px-3 py-2">
            <dt className="text-sm text-muted">Свободно</dt>
            <dd>
              <Money value={data.free} tone={data.free < 0 ? "negative" : "default"} className="font-semibold" />
            </dd>
          </div>
        </dl>
      </Card>

      {data.items.length === 0 ? (
        <EmptyState
          title="Целей пока нет"
          text="Отпуск, подушка безопасности, новый телефон — поставьте цель, и приложение подскажет, сколько откладывать в месяц."
          action={
            <Button icon="plus" onClick={() => open({ kind: "goal" })}>
              Новая цель
            </Button>
          }
        />
      ) : (
        <>
          <ListHeader title="Мои цели" addLabel="Новая цель" onAdd={() => open({ kind: "goal" })} />
          <ul className="space-y-3">
            {data.items.map((item) => (
              <li key={item.goal.id}>
                <GoalCard goal={item.goal} pace={item.pace} />
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

function GoalCard({ goal, pace }: { goal: Goal; pace: GoalPace }) {
  const { open } = useUi();
  const today = useToday();
  const reached = pace.status === "reached";
  const advice = goalAdvice(pace);
  const { state } = useSnapshot();
  const withdrawable = goalWithdrawable(state, goal);

  return (
    <Card>
      <div className="flex items-start gap-3">
        <EditTitle label="Изменить цель" onClick={() => open({ kind: "goal", goalId: goal.id })}>
          {goal.name}
        </EditTitle>
        <span
          className={`mt-2 shrink-0 rounded-full px-2.5 py-0.5 text-xs font-medium ${
            reached ? "bg-positive-soft text-positive" : "bg-surface-2 text-muted"
          }`}
        >
          {pace.percent}%
        </span>
      </div>

      <div className="mt-2">
        <Progress
          value={Math.max(0, pace.saved)}
          max={goal.targetAmount}
          tone={reached ? "positive" : pace.status === "overdue" ? "warning" : "accent"}
          label={`Накоплено на «${goal.name}»`}
        />
      </div>
      <p className="mt-2 text-[15px]">
        <Money value={pace.saved} className="font-semibold" />{" "}
        <span className="text-muted">из {formatMoney(goal.targetAmount)}</span>
      </p>

      {reached ? (
        <p className="mt-1 text-sm font-medium text-positive">{GOAL_REACHED_TEXT}</p>
      ) : (
        <>
          <p className="mt-1 text-sm text-muted">{goalDueText(goal.dueDate, today)}</p>
          {advice &&
            (pace.status === "overdue" ? (
              <p className="mt-2 rounded-2xl bg-warning-soft px-3 py-2 text-sm">{advice}</p>
            ) : (
              <p className={`mt-1 text-sm ${pace.status === "on-track" ? "font-medium" : "text-muted"}`}>{advice}</p>
            ))}
        </>
      )}

      <div className="mt-3 grid grid-cols-2 gap-2">
        <Button
          variant="soft"
          icon="piggy"
          aria-label={`Пополнить цель «${goal.name}»`}
          onClick={() => open({ kind: "goalMoney", goalId: goal.id, direction: "in" })}
        >
          Пополнить
        </Button>
        <Button
          variant="secondary"
          icon="wallet"
          aria-label={`Снять с цели «${goal.name}»`}
          disabled={withdrawable === 0}
          onClick={() => open({ kind: "goalMoney", goalId: goal.id, direction: "out" })}
        >
          Снять
        </Button>
      </div>
      {withdrawable === 0 && goal.initialAmount > 0 && pace.saved > 0 && (
        <p className="mt-2 text-xs text-muted">Снять можно только то, что отложено в приложении</p>
      )}
    </Card>
  );
}

// ---------- долги ----------

interface LoanItem {
  loan: Loan;
  remaining: Kopecks;
}

function DebtsView() {
  const { state } = useSnapshot();
  const { open } = useUi();
  const today = useToday();
  // Кредитки с долгом — тоже мои долги: погасить до конца беспроцентного периода.
  const cards = useMemo(() => creditDebts(state, today), [state, today]);

  const data = useMemo(() => {
    const items: LoanItem[] = state.loans
      .map((loan) => ({ loan, remaining: loanRemaining(state, loan) }))
      .sort((a, b) =>
        byOpenAndDue(
          { done: a.remaining === 0, due: a.loan.dueDate, name: a.loan.name },
          { done: b.remaining === 0, due: b.loan.dueDate, name: b.loan.name },
        ),
      );
    const mine = items.filter((i) => i.loan.kind !== "lend");
    const theirs = items.filter((i) => i.loan.kind === "lend");
    const sum = (list: LoanItem[]) => list.reduce((s, i) => s + i.remaining, 0);
    return { mine, theirs, iOwe: sum(mine) + cards.reduce((s, c) => s + c.debt, 0), owedToMe: sum(theirs) };
  }, [state, cards]);

  if (state.loans.length === 0 && cards.length === 0) {
    return (
      <EmptyState
        title="Долгов нет"
        text="Запишите, у кого вы заняли, кредит или кому одолжили — будет видно, сколько осталось вернуть и к какому сроку."
        action={
          <Button icon="plus" onClick={() => open({ kind: "loan" })}>
            Новый долг
          </Button>
        }
      />
    );
  }

  return (
    <>
      <div className="grid grid-cols-2 gap-3">
        <TotalTile label="Мои долги" value={data.iOwe} tone="negative" />
        <TotalTile label="Мне должны" value={data.owedToMe} tone="positive" />
      </div>

      <ListHeader title="Долги" addLabel="Новый долг" onAdd={() => open({ kind: "loan" })} />

      {cards.length > 0 && (
        <section className="space-y-3" aria-label="Кредитные карты">
          <h3 className="px-1 text-sm font-medium text-muted">Кредитные карты</h3>
          <ul className="space-y-3">
            {cards.map((card) => (
              <li key={card.account.id}>
                <CreditCardDebt credit={card} />
              </li>
            ))}
          </ul>
        </section>
      )}
      {data.mine.length > 0 && <LoanGroup title="Мои долги" items={data.mine} />}
      {data.theirs.length > 0 && <LoanGroup title="Мне должны" items={data.theirs} />}
    </>
  );
}

/** Долг по кредитке: сумма, беспроцентный период, использованный лимит и «Погасить». */
function CreditCardDebt({ credit }: { credit: CreditStatus }) {
  const { open } = useUi();
  const today = useToday();
  return (
    <Card>
      <div className="flex items-start gap-3">
        <EditTitle
          label="Открыть счёт"
          subtitle="Кредитная карта"
          onClick={() => open({ kind: "account", accountId: credit.account.id })}
        >
          {credit.account.name}
        </EditTitle>
        <div className="shrink-0 pt-1 text-right">
          <Money value={credit.debt} className="block text-[17px] font-semibold" />
          {credit.limit !== null && <span className="block text-xs text-muted">лимит {formatMoney(credit.limit)}</span>}
        </div>
      </div>
      {credit.limit !== null && (
        <div className="mt-3">
          <Progress value={credit.debt} max={credit.limit} tone="warning" label={`Использовано лимита: «${credit.account.name}»`} />
        </div>
      )}
      {credit.graceEnd && (
        <p className={`mt-2 text-sm ${credit.overdue ? "font-medium text-negative" : "text-muted"}`}>
          {credit.overdue
            ? `Беспроцентный период закончился ${formatDay(credit.graceEnd, today)} — погасите долг`
            : `Без процентов до ${formatDay(credit.graceEnd, today)}`}
        </p>
      )}
      <Button className="mt-3 w-full" variant="soft" onClick={() => open({ kind: "transfer", to: credit.account.id, amount: credit.debt })}>
        Погасить
      </Button>
    </Card>
  );
}

function TotalTile({ label, value, tone }: { label: string; value: Kopecks; tone: "positive" | "negative" }) {
  return (
    <div className="surface-card rounded-[28px] p-4">
      <p className="text-sm text-muted">{label}</p>
      <Money value={value} tone={value > 0 ? tone : "default"} className="mt-1 block text-lg font-semibold" />
    </div>
  );
}

function LoanGroup({ title, items }: { title: string; items: LoanItem[] }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h3 className="px-1 text-sm font-medium text-muted">{title}</h3>
      <ul className="space-y-3">
        {items.map((item) => (
          <li key={item.loan.id}>
            <LoanCard loan={item.loan} remaining={item.remaining} />
          </li>
        ))}
      </ul>
    </section>
  );
}

function LoanCard({ loan, remaining }: { loan: Loan; remaining: Kopecks }) {
  const { open } = useUi();
  const today = useToday();
  const isLend = loan.kind === "lend";
  const closed = remaining === 0;

  return (
    <Card>
      <div className="flex items-start gap-3">
        {/* «Мне должны» и так написано над группой — повторять под названием незачем. */}
        <EditTitle
          label="Изменить долг"
          subtitle={isLend ? undefined : LOAN_KIND_LABEL[loan.kind]}
          onClick={() => open({ kind: "loan", loanId: loan.id })}
        >
          {loan.name}
        </EditTitle>
        <div className="shrink-0 pt-1 text-right">
          <Money value={remaining} tone={closed ? "muted" : "default"} className="block text-[17px] font-semibold" />
          <span className="block text-xs text-muted">осталось из {formatMoney(loan.amount)}</span>
        </div>
      </div>

      <div className="mt-3">
        <Progress
          value={loan.amount - remaining}
          max={loan.amount}
          tone="positive"
          label={isLend ? `Сколько вернули: «${loan.name}»` : `Сколько погашено: «${loan.name}»`}
        />
      </div>
      {!closed && <LoanDue loan={loan} today={today} />}

      <Button
        className="mt-3 w-full"
        variant={closed ? "secondary" : "soft"}
        icon={closed ? "check" : undefined}
        disabled={closed}
        onClick={() => open({ kind: "loanPayment", loanId: loan.id })}
      >
        {closed ? (isLend ? "Возвращён" : "Погашен") : isLend ? "Получить возврат" : "Внести платёж"}
      </Button>
    </Card>
  );
}

function LoanDue({ loan, today }: { loan: Loan; today: IsoDate }) {
  if (!loan.dueDate) return <p className="mt-2 text-sm text-muted">Без срока</p>;
  const days = diffDays(today, loan.dueDate);
  const day = formatDay(loan.dueDate, today);
  if (days < 0) return <p className="mt-2 text-sm font-medium text-negative">Просрочен — срок был {day}</p>;
  const verb = loan.kind === "credit" ? "Погасить до" : "Вернуть до";
  const soon = days <= 7;
  return (
    <p className={`mt-2 text-sm ${soon ? "font-medium text-warning" : "text-muted"}`}>
      {verb} {day}
      {days === 0 ? " — сегодня" : soon ? ` — ${daysLeftText(days)}` : ""}
    </p>
  );
}

// ---------- общее ----------

function ListHeader({ title, addLabel, onAdd }: { title: string; addLabel: string; onAdd: () => void }) {
  return (
    <div className="flex items-center justify-between gap-3 pt-1">
      <h2 className="text-[17px] font-semibold">{title}</h2>
      <Button variant="soft" size="sm" icon="plus" className="min-h-10" onClick={onAdd}>
        {addLabel}
      </Button>
    </div>
  );
}

/** Название карточки — кнопка, открывающая редактирование. */
function EditTitle({
  label,
  subtitle,
  onClick,
  children,
}: {
  label: string;
  subtitle?: string;
  onClick: () => void;
  children: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="-m-1 flex min-h-10 min-w-0 flex-1 flex-col justify-center rounded-xl p-1 text-left hover:bg-surface-2"
    >
      <span className="flex max-w-full items-center gap-1.5">
        <span className="sr-only">{label}: </span>
        <span className="truncate text-[17px] font-semibold">{children}</span>
        <Icon name="edit" size={15} className="shrink-0 text-muted" />
      </span>
      {subtitle && <span className="text-sm text-muted">{subtitle}</span>}
    </button>
  );
}
