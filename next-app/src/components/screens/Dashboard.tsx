"use client";

import { useMemo, useState, type ReactNode } from "react";
import { addDays, formatDay, formatMonth, formatMonthIn, formatRelativeDay, monthKeyOf } from "@/domain/dates";
import {
  balanceAt,
  monthMetrics,
  pendingRollover,
  safeToSpend,
  savingsTotal,
  upcomingEvents,
  type SafeToSpend,
  type UpcomingEvent,
} from "@/domain/metrics";
import { formatMoney } from "@/domain/money";
import { plural } from "@/domain/text";
import { newId, useSnapshot, useStore, useToday } from "@/client/react";
import { storage } from "@/client/storage";
import { useDispatch } from "../app/hooks";
import { useUi } from "../app/overlays";
import { BALANCE_CONFIRMED_KEY } from "../app/sheets/MoneySheets";
import { TransactionRow, transactionCategoryLabel } from "../app/TransactionRow";
import { Button } from "../ui/Button";
import { Card, Money, Notice, Progress } from "../ui/controls";
import { useToast } from "../ui/feedback";
import { Icon } from "../ui/Icon";

const STATUS_TEXT: Record<SafeToSpend["status"], { text: string; tone: string }> = {
  ok: { text: "Всё по плану", tone: "bg-positive-soft text-positive" },
  tight: { text: "До дохода впритык", tone: "bg-warning-soft text-warning" },
  over: { text: "Сегодня перерасход", tone: "bg-negative-soft text-negative" },
  gap: { text: "Кассовый разрыв", tone: "bg-negative-soft text-negative" },
  "no-income": { text: "Нет доходов в плане", tone: "bg-surface-2 text-muted" },
};

/** Текст статуса с уточнениями: «перерасход» без трат сегодня — это исчерпанный бюджет месяца. */
function statusBadge(sts: SafeToSpend): { text: string; tone: string } {
  const base = STATUS_TEXT[sts.status];
  if (sts.status === "over" && sts.leftToday >= 0) return { ...base, text: "Бюджет месяца исчерпан" };
  if (sts.status === "tight" && sts.horizon.reason === "month-end") return { ...base, text: "До конца месяца впритык" };
  return base;
}

const SKIP_MANDATORY_KEY = "fp:onboarding-skip-mandatory";

export function Dashboard() {
  const snapshot = useSnapshot();
  const { state } = snapshot;
  const today = useToday();
  const { open, setTab } = useUi();

  const data = useMemo(() => {
    const month = monthKeyOf(today);
    return {
      month,
      sts: safeToSpend(state, today),
      metrics: monthMetrics(state, month, today),
      balance: balanceAt(state, today),
      savings: savingsTotal(state, today),
      upcoming: upcomingEvents(state, today, addDays(today, 30)),
      rollover: pendingRollover(state, today),
      // Сначала разворачиваем: при стабильной сортировке по дате внутри дня сверху окажутся добавленные позже (как в истории).
      recent: [...state.transactions]
        .reverse()
        .filter((t) => t.date <= today && !t.linkedTo)
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 5),
    };
  }, [state, today]);

  // Флаг читаем на каждом рендере, а не в useMemo: после «Остаток совпадает» state не меняется,
  // а шаг должен отметиться сразу, как только окно сверки закроется (закрытие перерисовывает экран).
  const balanceConfirmed = storage.get(BALANCE_CONFIRMED_KEY) === "1";
  const steps = useMemo(() => {
    const month = monthKeyOf(today);
    return {
      // Остаток известен, если его указали (корректировка) или уже пришёл доход. Один расход остатка не задаёт:
      // иначе первая же трата отметит шаг и покажет кассовый разрыв.
      balance: state.transactions.some((t) => t.type === "adjustment" || (t.type === "income" && t.date <= today)),
      income:
        state.templates.some((t) => t.kind === "income" && t.active) ||
        state.transactions.some((t) => t.type === "income" && monthKeyOf(t.date) === month),
      mandatory: state.templates.some((t) => t.kind === "expense"),
    };
  }, [state, today]);
  const [mandatorySkipped, setMandatorySkipped] = useState(() => storage.get(SKIP_MANDATORY_KEY) === "1");
  const skipMandatory = () => {
    storage.set(SKIP_MANDATORY_KEY, "1");
    setMandatorySkipped(true);
  };
  const progress = { ...steps, balance: steps.balance || balanceConfirmed, mandatory: steps.mandatory || mandatorySkipped };
  const onboardingDone = progress.balance && progress.income && progress.mandatory;
  const hasData = state.transactions.length > 0 || state.templates.length > 0;

  const onboarding = onboardingDone ? null : (
    <Onboarding progress={progress} mandatorySkipped={mandatorySkipped} onSkipMandatory={skipMandatory} showImport={!hasData} />
  );

  return (
    <div className="space-y-4">
      <Banners />
      {data.rollover && <RolloverNotice month={data.rollover.month} amount={data.rollover.amount} />}

      {!hasData ? (
        onboarding
      ) : (
        <>
          {progress.balance ? <TodayCard sts={data.sts} /> : <BalancePrompt />}
          {onboarding}

          <div className="grid grid-cols-2 gap-3">
            <button
              type="button"
              onClick={() => open({ kind: "balance" })}
              className="flex min-w-0 flex-col items-start rounded-3xl border border-border bg-surface p-4 text-left transition hover:bg-surface-2"
            >
              <span className="flex items-center gap-1.5 text-sm text-muted">
                <Icon name="wallet" size={16} /> На счёте
              </span>
              <span className="mt-1 block max-w-full truncate text-lg font-semibold sm:text-xl" title={formatMoney(data.balance)}>
                <Money value={data.balance} tone={data.balance < 0 ? "negative" : "default"} />
              </span>
              <span className="mt-1 block text-xs text-muted">
                {progress.balance ? "Сверить остаток" : "Указать остаток"}
              </span>
            </button>
            <button
              type="button"
              onClick={() => open({ kind: "savings", direction: "in" })}
              className="flex min-w-0 flex-col items-start rounded-3xl border border-border bg-surface p-4 text-left transition hover:bg-surface-2"
            >
              <span className="flex items-center gap-1.5 text-sm text-muted">
                <Icon name="piggy" size={16} /> Сбережения
              </span>
              <span className="mt-1 block max-w-full truncate text-lg font-semibold sm:text-xl" title={formatMoney(data.savings)}>
                <Money value={data.savings} />
              </span>
              <span className="mt-1 block text-xs text-muted">Пополнить или снять</span>
            </button>
          </div>

          <MonthCard metrics={data.metrics} />
          <UpcomingCard events={data.upcoming} />

          <Card
            title="Последние операции"
            action={
              <Button variant="ghost" size="sm" onClick={() => setTab("history")}>
                Вся история
              </Button>
            }
          >
            {data.recent.length ? (
              <div className="space-y-0.5">
                {data.recent.map((tx) => (
                  <TransactionRow
                    key={tx.id}
                    tx={tx}
                    subtitle={`${formatRelativeDay(tx.date, today)}${tx.title && tx.category ? ` · ${transactionCategoryLabel(tx)}` : ""}`}
                    onClick={() => open({ kind: "tx", txId: tx.id })}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-muted">Пока нет операций.</p>
            )}
          </Card>
        </>
      )}
    </div>
  );
}

/** Пока остаток не указан, дневной лимит посчитать не из чего — вместо него просим ввести остаток. */
function BalancePrompt() {
  const { open } = useUi();
  return (
    <section className="rounded-3xl bg-accent-soft p-5">
      <p className="text-[15px] font-medium">
        Укажите, сколько сейчас денег на счёте, — и приложение посчитает лимит на день
      </p>
      <Button className="mt-3" icon="wallet" onClick={() => open({ kind: "balance" })}>
        Указать остаток
      </Button>
    </section>
  );
}

function TodayCard({ sts }: { sts: SafeToSpend }) {
  const { open } = useUi();
  const status = statusBadge(sts);
  const over = sts.leftToday < 0;
  return (
    <section className="rounded-3xl bg-accent p-5 text-accent-text shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm opacity-90">
          {over ? "Сегодня потрачено сверх лимита" : "Сегодня можно потратить"}
        </p>
        <span className={`shrink-0 whitespace-nowrap rounded-full px-2.5 py-1 text-xs font-medium ${status.tone}`}>
          {status.text}
        </span>
      </div>
      <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
        {formatMoney(Math.abs(sts.leftToday))}
      </p>
      <p className="mt-1 text-sm opacity-90">
        Лимит на день {formatMoney(sts.recommended)} · потрачено {formatMoney(sts.spentToday)}
      </p>
      {sts.status === "gap" && (
        <p className="mt-3 rounded-2xl bg-black/15 px-3 py-2 text-sm">
          {sts.gapDate
            ? `По прогнозу ${formatDay(sts.gapDate)} деньги на счёте закончатся.`
            : "Денег на счёте не хватает на обязательные платежи до следующего дохода."}{" "}
          Перенесите платёж, найдите доход или сократите траты.
        </p>
      )}
      <div className="mt-4 flex gap-2">
        <Button
          variant="secondary"
          size="sm"
          icon="plus"
          className="!border-transparent !bg-accent-text/15 !font-semibold !text-accent-text hover:!bg-accent-text/25"
          onClick={() => open({ kind: "tx", preset: { type: "expense" } })}
        >
          Расход
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="info"
          className="!border-transparent !bg-accent-text/15 !font-semibold !text-accent-text hover:!bg-accent-text/25"
          onClick={() => open({ kind: "explain" })}
        >
          Как посчитано
        </Button>
      </div>
    </section>
  );
}

function MonthCard({ metrics }: { metrics: ReturnType<typeof monthMetrics> }) {
  const { setTab } = useUi();
  const f = metrics.flexible;
  const used = f.spent + f.reserved + f.extraSavings;
  const ratio = f.budget > 0 ? used / f.budget : 1;
  return (
    <Card
      title={formatMonth(metrics.month)}
      action={
        <Button variant="ghost" size="sm" onClick={() => setTab("analytics")}>
          Подробнее
        </Button>
      }
    >
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">Осталось в гибком бюджете</p>
          <Money value={f.left} tone={f.left < 0 ? "negative" : "default"} className="text-2xl font-semibold" />
        </div>
        <p className="text-right text-sm text-muted">из {formatMoney(Math.max(0, f.budget))}</p>
      </div>
      <div className="mt-3">
        <Progress
          value={used}
          max={Math.max(f.budget, 1)}
          tone={ratio > 1 ? "negative" : ratio > 0.85 ? "warning" : "accent"}
          label="Использовано гибкого бюджета"
        />
        {metrics.daysLeft > 0 && (
          <p className="mt-1.5 text-xs text-muted">
            До конца месяца {metrics.daysLeft} {plural(metrics.daysLeft, ["день", "дня", "дней"])}
          </p>
        )}
      </div>

      <dl className="mt-4 grid grid-cols-1 gap-2 text-[15px] sm:grid-cols-3">
        <Stat label="Доходы" fact={metrics.income.fact} plan={metrics.income.plan} />
        <Stat label="Обязательные" fact={metrics.mandatory.fact} plan={metrics.mandatory.plan} />
        <Stat label="Отложено" fact={metrics.savings.fact} plan={metrics.savings.target} />
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

function Stat({ label, fact, plan }: { label: string; fact: number; plan: number }) {
  return (
    <div className="flex items-baseline justify-between gap-2 rounded-2xl bg-surface-2 px-3 py-2 sm:block">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="text-right sm:text-left">
        <span className="block font-semibold tabular-nums">{formatMoney(fact)}</span>
        <span className="block text-xs text-muted tabular-nums">план {formatMoney(plan)}</span>
      </dd>
    </div>
  );
}

function UpcomingCard({ events }: { events: UpcomingEvent[] }) {
  const { open } = useUi();
  const today = useToday();
  const visible = events.slice(0, 12);
  return (
    <Card title="Ближайшие 30 дней">
      {visible.length === 0 ? (
        <p className="text-sm text-muted">
          Запланированных платежей нет. Добавьте регулярные доходы и расходы на вкладке «Регулярные» — и здесь появится
          прогноз остатка.
        </p>
      ) : (
        <ul className="space-y-0.5">
          {visible.map((e) => {
            const content = (
              <>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px]">{e.title}</span>
                  <span className="block truncate whitespace-nowrap text-xs text-muted">
                    {formatRelativeDay(e.date, today).replace(/, .*/, "")} ·{" "}
                    <span className={e.balanceAfter < 0 ? "font-medium text-negative" : ""}>
                      останется {formatMoney(e.balanceAfter)}
                    </span>
                  </span>
                </span>
                <Money value={e.effect} sign tone={e.effect > 0 ? "positive" : "default"} className="shrink-0 font-semibold" />
              </>
            );
            // Будущая операция открывается на редактирование, начисление регулярного платежа — в окне «пропустить/изменить».
            // Отчисление в сбережения с ожидаемого дохода — расчётная строка, открывать нечего.
            const { txId, templateId, month } = e;
            const onClick = txId
              ? () => open({ kind: "tx", txId })
              : e.source === "template" && templateId && month
                ? () => open({ kind: "planned", templateId, month })
                : null;
            return (
              <li key={e.key}>
                {onClick ? (
                  <button
                    type="button"
                    onClick={onClick}
                    className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-surface-2"
                  >
                    {content}
                  </button>
                ) : (
                  <div className="flex items-center gap-3 py-2">{content}</div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </Card>
  );
}

interface OnboardingProgress {
  balance: boolean;
  income: boolean;
  mandatory: boolean;
}

/** Чек-лист первых шагов. Остаётся на главной, пока все шаги не выполнены или не пропущены. */
function Onboarding({
  progress,
  mandatorySkipped,
  onSkipMandatory,
  showImport,
}: {
  progress: OnboardingProgress;
  mandatorySkipped: boolean;
  onSkipMandatory: () => void;
  showImport: boolean;
}) {
  const { open, setTab } = useUi();
  const done = [progress.balance, progress.income, progress.mandatory].filter(Boolean).length;
  return (
    <section className="rounded-3xl border border-border bg-surface p-5 sm:p-6" aria-labelledby="onboarding-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="onboarding-title" className="text-xl font-semibold">
          Начнём планировать
        </h2>
        <span className="shrink-0 text-sm text-muted">Готово {done} из 3</span>
      </div>
      {done === 0 && (
        <p className="mt-2 text-[15px] text-muted">
          Приложение считает, сколько можно тратить каждый день, чтобы хватило на обязательные платежи и сбережения.
          Для этого нужны три вещи:
        </p>
      )}
      <ol className="mt-4 space-y-4">
        <OnboardingStep n={1} done={progress.balance} title="Сколько денег сейчас на счёте">
          <Button variant="soft" size="sm" onClick={() => open({ kind: "balance" })}>
            Указать остаток
          </Button>
        </OnboardingStep>
        <OnboardingStep n={2} done={progress.income} title="Регулярные доходы — зарплата, аванс">
          <Button variant="soft" size="sm" onClick={() => open({ kind: "template", preset: { kind: "income" } })}>
            Добавить доход
          </Button>
        </OnboardingStep>
        <OnboardingStep
          n={3}
          done={progress.mandatory}
          doneText={mandatorySkipped ? "Пропущено — можно добавить позже на вкладке «Регулярные»" : undefined}
          title="Обязательные платежи — аренда, кредиты, связь"
        >
          <Button variant="soft" size="sm" onClick={() => open({ kind: "template", preset: { kind: "expense" } })}>
            Добавить платёж
          </Button>
          <Button variant="ghost" size="sm" onClick={onSkipMandatory}>
            Пропустить
          </Button>
        </OnboardingStep>
      </ol>
      {showImport && (
        <p className="mt-5 text-sm text-muted">
          Есть данные из старой версии? Импортируйте файл в разделе{" "}
          <button
            type="button"
            onClick={() => setTab("settings")}
            className="font-medium text-accent underline underline-offset-2"
          >
            Настройки → Данные
          </button>
          .
        </p>
      )}
    </section>
  );
}

function OnboardingStep({
  n,
  done,
  doneText = "Готово",
  title,
  children,
}: {
  n: number;
  done: boolean;
  doneText?: string;
  title: string;
  children: ReactNode;
}) {
  return (
    <li className="flex gap-3">
      <span
        className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-sm font-semibold ${
          done ? "bg-positive-soft text-positive" : "bg-accent-soft text-accent"
        }`}
        aria-hidden
      >
        {done ? <Icon name="check" size={16} /> : n}
      </span>
      <div className="min-w-0 flex-1">
        <p className={`font-medium ${done ? "text-muted line-through decoration-1" : ""}`}>
          <span className="sr-only">{done ? "Выполнено: " : `Шаг ${n}: `}</span>
          {title}
        </p>
        {done ? (
          <p className="mt-0.5 text-sm text-muted">{doneText}</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">{children}</div>
        )}
      </div>
    </li>
  );
}

function RolloverNotice({ month, amount }: { month: string; amount: number }) {
  const dispatch = useDispatch();
  const toast = useToast();
  const today = useToday();
  const resolve = (decision: "saved" | "dismissed") => {
    if (dispatch({ type: "rollover.resolve", month, decision, id: newId(), date: today }) && decision === "saved") {
      toast(`${formatMoney(amount)} отложено в сбережения`);
    }
  };
  return (
    <Notice
      tone="positive"
      action={
        <>
          <Button size="sm" variant="secondary" onClick={() => resolve("dismissed")}>
            Оставить на счёте
          </Button>
          <Button size="sm" onClick={() => resolve("saved")}>
            Отложить
          </Button>
        </>
      }
    >
      {formatMonthIn(month, today).replace(/^в/, "В")} не потрачено {formatMoney(amount)} гибкого бюджета. Отложить эту
      сумму в сбережения?
    </Notice>
  );
}

/** Предложения перенести данные и предупреждения о синхронизации. */
function Banners() {
  const snapshot = useSnapshot();
  const store = useStore();
  const toast = useToast();
  const { open } = useUi();

  return (
    <>
      {snapshot.sessionExpired && (
        <Notice tone="negative" action={<Button size="sm" onClick={() => open({ kind: "auth", mode: "login" })}>Войти</Button>}>
          Сессия истекла. Изменения сохранены на устройстве — войдите, чтобы отправить их.
        </Notice>
      )}
      {snapshot.guestImportOffer && (
        <Notice
          action={
            <>
              <Button size="sm" variant="secondary" onClick={() => store.dismissGuestImport()}>
                Не нужно
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const r = store.acceptGuestImport();
                  toast(r.ok ? "Данные перенесены в аккаунт" : r.error, { kind: r.ok ? "info" : "error" });
                }}
              >
                Перенести
              </Button>
            </>
          }
        >
          В этом браузере есть данные, которые вы вели без входа. Перенести их в аккаунт?
        </Notice>
      )}
      {snapshot.legacyImportOffer && (
        <Notice
          action={
            <>
              <Button size="sm" variant="secondary" onClick={() => store.dismissLegacyImport()}>
                Не нужно
              </Button>
              <Button
                size="sm"
                onClick={() => {
                  const r = store.acceptLegacyImport();
                  toast(r.ok ? "Данные старой версии перенесены" : r.error, { kind: r.ok ? "info" : "error" });
                }}
              >
                Перенести
              </Button>
            </>
          }
        >
          Найдены данные старой версии планировщика. Перенести их? Текущие данные будут заменены.
        </Notice>
      )}
    </>
  );
}
