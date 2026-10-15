"use client";

import { useMemo, useState, type ReactNode } from "react";
import { autoSavingByDefault } from "@/domain/savings";
import { legacySavingsFixes } from "@/domain/sms";
import { addDays, formatDay, formatMonth, formatMonthIn, formatRelativeDay, monthKeyOf, type MonthKey } from "@/domain/dates";
import {
  afterPayReason,
  balanceAt,
  monthMetrics,
  payEventName,
  periodLeftView,
  pendingRollover,
  safeToSpend,
  savingsTotal,
  upcomingEvents,
  type BudgetPeriod,
  type SafeToSpend,
  type UpcomingEvent,
} from "@/domain/metrics";
import { formatMoney } from "@/domain/money";
import { plural } from "@/domain/text";
import { newId, useSnapshot, useStore, useToday } from "@/client/react";
import { storage } from "@/client/storage";
import { useDispatch } from "../app/hooks";
import { SKIP_MANDATORY_KEY } from "../app/native/homeModel";
import { useUi } from "../app/overlays";
import { BALANCE_CONFIRMED_KEY } from "../app/sheets/MoneySheets";
import { quickPicks, type QuickPick } from "../app/quickPicks";
import {
  ACCOUNT_KINDS,
  accountRows,
  bankMismatches,
  bankResolveActions,
  bankTransferOverlay,
  hasOwnAccounts,
  previewAccountRows,
  savingsTileHint,
} from "../app/accounts";
import { useBalancesPrivacy } from "@/client/privacy";
import { BalancesEye } from "../app/BalancesEye";
import { TransactionRow, transactionCategoryLabel } from "../app/TransactionRow";
import { Button, IconButton } from "../ui/Button";
import { Card, Money, Progress } from "../ui/controls";
import { useToast } from "../ui/feedback";
import { Icon, type IconName } from "../ui/Icon";

/**
 * Статус на карточке лимита — в стиле карточки: светлая полупрозрачная капсула и белый текст,
 * смысл передаёт значок (светлый тон, читаемый на индиго), а не цветная подложка.
 */
const STATUS_TEXT: Record<SafeToSpend["status"], { text: string; icon: IconName; tone: string }> = {
  ok: { text: "Всё по плану", icon: "check", tone: "text-[#7cf0b8]" },
  tight: { text: "До дохода впритык", icon: "alert", tone: "text-[#ffd27a]" },
  over: { text: "Сегодня перерасход", icon: "alert", tone: "text-[#ff9aa8]" },
  gap: { text: "Кассовый разрыв", icon: "alert", tone: "text-[#ff9aa8]" },
  "no-income": { text: "Нет доходов в плане", icon: "info", tone: "text-on-accent/80" },
};

/** Текст статуса с уточнениями: «перерасход» без трат сегодня — это исчерпанный бюджет месяца. */
function statusBadge(sts: SafeToSpend): { text: string; icon: IconName; tone: string } {
  const base = STATUS_TEXT[sts.status];
  if (sts.status === "over" && sts.leftToday >= 0) return { ...base, text: "Бюджет месяца исчерпан" };
  if (sts.status === "tight" && sts.horizon.reason === "month-end") return { ...base, text: "До конца месяца впритык" };
  // Выплаты, с которой начался период, в приложении нет — плана нет, лимит по деньгам на счетах.
  if (sts.status === "ok" && sts.period.current.basis === "cash") return { ...base, text: "По деньгам на счетах" };
  return base;
}

/** Строка «Требует внимания»: значок в цветном круге, короткий текст и одно-два действия. */
function AttentionRow({
  icon,
  tone,
  title,
  text,
  onClick,
  actions,
}: {
  icon: IconName;
  tone: "accent" | "positive" | "warning" | "negative";
  title: string;
  text?: ReactNode;
  /** Вся строка — кнопка (тогда справа шеврон). */
  onClick?: () => void;
  actions?: ReactNode;
}) {
  const circle = {
    accent: "bg-accent-soft text-accent",
    positive: "bg-positive-soft text-positive",
    warning: "bg-warning-soft text-warning",
    negative: "bg-negative-soft text-negative",
  }[tone];
  const body = (
    <>
      <span className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full ${circle}`} aria-hidden>
        <Icon name={icon} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block text-[15px] font-medium">{title}</span>
        {text && <span className="block text-sm text-muted">{text}</span>}
      </span>
      {onClick && <Icon name="chevronRight" size={18} className="shrink-0 text-muted" aria-hidden />}
    </>
  );
  return (
    <li className="py-1">
      {onClick ? (
        <button
          type="button"
          onClick={onClick}
          className="-mx-2 flex min-h-12 w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-1.5 text-left hover:bg-fill"
        >
          {body}
        </button>
      ) : (
        <div className="flex min-h-12 items-center gap-3 py-1.5">{body}</div>
      )}
      {actions && <div className="mt-1 flex flex-wrap gap-2 pl-12">{actions}</div>}
    </li>
  );
}

/**
 * Всё, что ждёт действия, — в одной карточке под лимитом: новые операции из СМС, остаток прошлого месяца,
 * предупреждения месяца, вход и перенос данных. Нет дел — карточки нет.
 */
function AttentionCard({ warnings }: { warnings: string[] }) {
  const snapshot = useSnapshot();
  const store = useStore();
  const toast = useToast();
  const dispatch = useDispatch();
  const today = useToday();
  const { open } = useUi();
  const { state } = snapshot;
  const reviewCount = useMemo(() => state.transactions.filter((t) => t.review).length, [state]);
  const rollover = useMemo(() => pendingRollover(state, today), [state, today]);

  const resolveRollover = (month: string, amount: number, decision: "saved" | "dismissed") => {
    if (dispatch({ type: "rollover.resolve", month, decision, id: newId(), date: today }) && decision === "saved") {
      toast(`${formatMoney(amount, { whole: true })} отложено в сбережения`);
    }
  };

  const rows: ReactNode[] = [];
  if (snapshot.sessionExpired) {
    rows.push(
      <AttentionRow
        key="session"
        icon="user"
        tone="negative"
        title="Войдите снова"
        text="Сессия истекла. Изменения сохранены на телефоне и отправятся после входа."
        onClick={() => open({ kind: "auth", mode: "login" })}
      />,
    );
  }
  if (reviewCount > 0) {
    rows.push(
      <AttentionRow
        key="review"
        icon="check"
        tone="accent"
        title={`${reviewCount} ${plural(reviewCount, ["новая операция", "новые операции", "новых операций"])}`}
        text="Из СМС и Siri — проверьте категории"
        onClick={() => open({ kind: "review" })}
      />,
    );
  }
  if (rollover) {
    rows.push(
      <AttentionRow
        key="rollover"
        icon="piggy"
        tone="positive"
        title={`${formatMonthIn(rollover.month, today).replace(/^в/, "В")} осталось ${formatMoney(rollover.amount, { whole: true })}`}
        text="Отложить остаток гибкого бюджета в сбережения?"
        actions={
          <>
            <Button size="sm" onClick={() => resolveRollover(rollover.month, rollover.amount, "saved")}>
              Отложить
            </Button>
            <Button size="sm" variant="secondary" onClick={() => resolveRollover(rollover.month, rollover.amount, "dismissed")}>
              Оставить
            </Button>
          </>
        }
      />,
    );
  }
  // Записи прежних версий по накопительному: дубль корректировки при снятии, проценты доходом и переводом.
  for (const fix of legacySavingsFixes(state)) {
    rows.push(
      <AttentionRow
        key={`fix:${fix.id}`}
        icon="alert"
        tone="warning"
        title={fix.title}
        text={fix.text}
        actions={
          <Button size="sm" onClick={() => dispatch(fix.actions) && toast(fix.done)}>
            {fix.label}
          </Button>
        }
      />,
    );
  }
  for (const m of bankMismatches(state, today)) {
    const resolve = (fix: boolean) => {
      if (dispatch(bankResolveActions(state, m.account.id, fix, newId())) && fix) toast("Остаток поправлен");
    };
    rows.push(
      <AttentionRow
        key={`bank:${m.account.id}`}
        icon="wallet"
        tone="warning"
        title={m.title}
        text={m.text}
        actions={
          m.piggy ? (
            // Банк, похоже, уже перевёл в копилку: «Перевод» в неё посчитал бы ожидаемые отчисления второй раз.
            <>
              <Button size="sm" onClick={() => dispatch({ type: "account.bankPiggy", id: newId(), accountId: m.account.id }) && toast("Копилка банка учтена")}>
                Копилка банка
              </Button>
              <Button size="sm" variant="secondary" onClick={() => resolve(true)}>
                Поправить
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" onClick={() => resolve(true)}>
                Поправить
              </Button>
              <Button size="sm" variant="secondary" onClick={() => open(bankTransferOverlay(state, m))}>
                Перевод
              </Button>
            </>
          )
        }
      />,
    );
  }
  for (const w of warnings) {
    rows.push(<AttentionRow key={`w:${w}`} icon="alert" tone="warning" title={w} />);
  }
  if (snapshot.guestImportOffer) {
    rows.push(
      <AttentionRow
        key="guest"
        icon="upload"
        tone="accent"
        title="Перенести данные без входа?"
        text="В этом браузере есть операции, которые вы вели без аккаунта."
        actions={
          <>
            <Button
              size="sm"
              onClick={() => {
                const r = store.acceptGuestImport();
                toast(r.ok ? "Данные перенесены в аккаунт" : r.error, { kind: r.ok ? "info" : "error" });
              }}
            >
              Перенести
            </Button>
            <Button size="sm" variant="secondary" onClick={() => store.dismissGuestImport()}>
              Не нужно
            </Button>
          </>
        }
      />,
    );
  }
  if (snapshot.legacyImportOffer) {
    rows.push(
      <AttentionRow
        key="legacy"
        icon="upload"
        tone="accent"
        title="Найдены данные старой версии"
        text="Перенести их? Текущие данные будут заменены."
        actions={
          <>
            <Button
              size="sm"
              onClick={() => {
                const r = store.acceptLegacyImport();
                toast(r.ok ? "Данные старой версии перенесены" : r.error, { kind: r.ok ? "info" : "error" });
              }}
            >
              Перенести
            </Button>
            <Button size="sm" variant="secondary" onClick={() => store.dismissLegacyImport()}>
              Не нужно
            </Button>
          </>
        }
      />,
    );
  }
  if (!rows.length) return null;
  // Крестик в углу карточки, на уровне заголовка: закрыли — значит, расхождения с банком применять не нужно.
  const mismatches = bankMismatches(state, today);
  const dismiss = () =>
    dispatch(mismatches.flatMap((m) => bankResolveActions(state, m.account.id, false, newId())));
  return (
    <Card
      title="Требует внимания"
      action={
        mismatches.length > 0 && (
          <IconButton icon="close" label="Скрыть, ничего не меняя" variant="secondary" size={32} onClick={dismiss} className="-my-1" />
        )
      }
    >
      <ul className="divide-y divide-separator">{rows}</ul>
    </Card>
  );
}

/**
 * Быстрые траты: частые покупки добавляются одним касанием — с возможностью отменить.
 * Показываются, только когда есть что предложить (трата повторялась хотя бы дважды за 60 дней).
 */
function QuickSpend() {
  const { state } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const picks = useMemo(() => quickPicks(state, today, 6), [state, today]);
  if (!picks.length) return null;

  const add = (p: QuickPick) => {
    const id = newId();
    const ok = dispatch({
      type: "tx.add",
      tx: {
        id,
        type: "expense",
        amount: p.amount,
        date: today,
        category: p.category,
        title: p.title,
        note: "",
        mandatory: p.mandatory,
        autoSaving: autoSavingByDefault({ type: "expense", amount: p.amount, category: p.category }, state.settings),
      },
    });
    if (ok) {
      toast(`${p.title || p.category} · ${formatMoney(p.amount)} — добавлено`, {
        action: { label: "Отменить", onClick: () => dispatch({ type: "tx.delete", id }) },
      });
    }
  };

  return (
    <section aria-labelledby="quick-spend-title" className="space-y-2">
      <h2 id="quick-spend-title" className="px-1 text-sm font-medium text-muted">
        Быстрые траты — одним касанием
      </h2>
      <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
        {picks.map((p) => (
          <button
            key={`${p.category}|${p.title}|${p.amount}`}
            type="button"
            onClick={() => add(p)}
            aria-label={`Добавить расход: ${p.title || p.category}, ${formatMoney(p.amount)}`}
            className="glass-control flex min-h-12 shrink-0 flex-col items-start justify-center rounded-2xl px-3.5 py-2 text-left transition active:scale-95"
          >
            <span className="text-sm font-medium">{p.title || p.category}</span>
            <span className="text-xs text-muted tabular-nums">{formatMoney(p.amount)}</span>
          </button>
        ))}
      </div>
    </section>
  );
}

export function Dashboard() {
  const snapshot = useSnapshot();
  const { state } = snapshot;
  const today = useToday();
  const { open, setTab } = useUi();
  const { masked } = useBalancesPrivacy();

  const data = useMemo(() => {
    const month = monthKeyOf(today);
    return {
      month,
      sts: safeToSpend(state, today),
      metrics: monthMetrics(state, month, today),
      balance: balanceAt(state, today),
      savings: savingsTotal(state, today),
      upcoming: upcomingEvents(state, today, addDays(today, 30)),
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

  // Порядок — по дизайн-коду: сначала ответ «сколько можно сегодня», затем то, что ждёт действия,
  // быстрые траты, счёт и сбережения, месяц, ближайшие платежи и последние операции.
  // На широком экране — две колонки: слева «сегодня» и деньги, справа месяц, платежи и операции.
  return (
    <div className={hasData ? "space-y-4 md:grid md:grid-cols-2 md:items-start md:gap-4 md:space-y-0" : "space-y-4"}>
      {!hasData ? (
        <>
          <AttentionCard warnings={[]} />
          {onboarding}
        </>
      ) : (
        <>
          <div className="space-y-4">
            {progress.balance ? <TodayCard sts={data.sts} /> : <BalancePrompt />}
            <AttentionCard warnings={data.metrics.warnings} />
            {onboarding}
            <QuickSpend />

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => open({ kind: "balance" })}
                className="surface-card flex min-w-0 flex-col items-start rounded-[28px] p-4 text-left transition hover:bg-surface-2 active:scale-[0.98]"
              >
                <span className="flex items-center gap-1.5 text-sm text-muted">
                  <Icon name="wallet" size={16} /> {hasOwnAccounts(state) ? "На счетах" : "На счёте"}
                </span>
                <span className="mt-1 block max-w-full truncate text-lg font-semibold sm:text-xl" title={masked ? undefined : formatMoney(data.balance)}>
                  {masked ? "•••• ₽" : <Money value={data.balance} whole tone={data.balance < 0 ? "negative" : "default"} />}
                </span>
                <span className="mt-1 block text-xs text-muted">
                  {progress.balance ? "Сверить остаток" : "Указать остаток"}
                </span>
              </button>
              <button
                type="button"
                onClick={() => open({ kind: "savings", direction: "in" })}
                className="surface-card flex min-w-0 flex-col items-start rounded-[28px] p-4 text-left transition hover:bg-surface-2 active:scale-[0.98]"
              >
                <span className="flex items-center gap-1.5 text-sm text-muted">
                  <Icon name="piggy" size={16} /> Сбережения
                </span>
                <span className="mt-1 block max-w-full truncate text-lg font-semibold sm:text-xl" title={masked ? undefined : formatMoney(data.savings)}>
                  {masked ? "•••• ₽" : <Money value={data.savings} whole />}
                </span>
                <span className="mt-1 block text-xs text-muted">{savingsTileHint(state, masked)}</span>
              </button>
            </div>

            {hasOwnAccounts(state) && <AccountsCard />}
          </div>
          <div className="space-y-4">
            <MonthCard period={data.sts.period} month={data.month} />
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
          </div>
        </>
      )}
    </div>
  );
}

/**
 * Три самых важных счёта (кредитка с прошедшим льготным периодом, долги, крупные счета для трат);
 * все — на экране «Счета» (Настройки → Счета). Нажатие открывает счёт.
 */
function AccountsCard() {
  const { state } = useSnapshot();
  const today = useToday();
  const { open, openSettings } = useUi();
  const all = accountRows(state, today);
  const rows = previewAccountRows(all);
  const { masked } = useBalancesPrivacy();
  return (
    <Card
      title="Счета"
      action={
        <span className="flex items-center gap-1">
          <BalancesEye />
          <Button variant="ghost" size="sm" onClick={() => openSettings("accounts")}>
            {all.length > rows.length ? `Все ${all.length}` : "Все счета"}
          </Button>
        </span>
      }
    >
      <ul className="space-y-0.5">
        {rows.map((row) => (
          <li key={row.account.id}>
            <button
              type="button"
              onClick={() => open({ kind: "account", accountId: row.account.id })}
              className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-surface-2"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
                <Icon name={ACCOUNT_KINDS[row.account.kind].icon} size={17} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px]">{row.account.name}</span>
                <span className={`block truncate text-xs ${row.overdue && !masked ? "font-medium text-negative" : "text-muted"}`}>
                  {masked ? ACCOUNT_KINDS[row.account.kind].label : row.detail}
                </span>
              </span>
              <span className={`shrink-0 font-semibold tabular-nums ${row.negative && !masked ? "text-negative" : ""}`}>
                {masked ? "•••• ₽" : row.amount}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** Пока остаток не указан, дневной лимит посчитать не из чего — вместо него просим ввести остаток. */
function BalancePrompt() {
  const { open } = useUi();
  return (
    <section className="rounded-[28px] bg-accent-soft p-5">
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
    <section className="surface-accent rounded-[28px] p-5 text-on-accent">
      <div className="flex items-start justify-between gap-3">
        <p className="min-w-0 flex-1 text-sm opacity-90">
          {over ? "Сегодня потрачено сверх лимита" : "Сегодня можно потратить"}
        </p>
        <span className="inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full bg-on-accent/15 px-2.5 py-1 text-xs font-semibold ring-1 ring-on-accent/20">
          <Icon name={status.icon} size={13} className={status.tone} />
          {status.text}
        </span>
      </div>
      <p className="mt-1 text-4xl font-bold tracking-tight tabular-nums">
        {formatMoney(Math.abs(sts.leftToday), { whole: true })}
      </p>
      <p className="mt-1 text-sm opacity-90">
        Лимит на день {formatMoney(sts.recommended, { whole: true })} · потрачено {formatMoney(sts.spentToday, { whole: true })}
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
          className="!border-transparent !bg-on-accent/15 !font-semibold !text-on-accent hover:!bg-on-accent/25"
          onClick={() => open({ kind: "tx", preset: { type: "expense" } })}
        >
          Расход
        </Button>
        <Button
          variant="secondary"
          size="sm"
          icon="info"
          className="!border-transparent !bg-on-accent/15 !font-semibold !text-on-accent hover:!bg-on-accent/25"
          onClick={() => open({ kind: "explain" })}
        >
          Как посчитано
        </Button>
      </div>
    </section>
  );
}

/**
 * Гибкий бюджет текущего периода: от зарплаты до зарплаты («До аванса 25 октября») или месяца — и сколько будет
 * в день после следующего поступления.
 */
function MonthCard({ period, month }: { period: BudgetPeriod; month: MonthKey }) {
  const { open, setTab } = useUi();
  const { current, next, after } = period;
  const f = current.flexible;
  // Остаток — не больше денег на счетах для трат до конца периода.
  const view = periodLeftView(period);
  const ratio = f.budget > 0 ? view.used / f.budget : 1;
  const days = `${current.daysLeft} ${plural(current.daysLeft, ["день", "дня", "дней"])}`;
  const reason = afterPayReason(period);
  return (
    <Card
      title={next ? `До ${payEventName(next)} ${formatDay(next.date)}` : formatMonth(month)}
      action={
        // Аналитика считает календарный месяц — у периода от зарплаты до зарплаты подробности в «Как посчитано».
        <Button variant="ghost" size="sm" onClick={() => (period.kind === "pay" ? open({ kind: "explain" }) : setTab("analytics"))}>
          Подробнее
        </Button>
      }
    >
      <div className="flex items-end justify-between gap-3">
        <div>
          <p className="text-sm text-muted">{view.label}</p>
          <Money value={Math.abs(view.left)} whole tone={view.left < 0 ? "negative" : "default"} className="text-2xl font-semibold" />
        </div>
        <p className="text-right text-sm text-muted">из {formatMoney(Math.max(0, f.budget), { whole: true })}</p>
      </div>
      <div className="mt-3">
        <Progress
          value={view.used}
          max={Math.max(f.budget, 1)}
          tone={ratio > 1 ? "negative" : ratio > 0.85 ? "warning" : "accent"}
          label="Использовано гибкого бюджета"
        />
        {current.daysLeft > 0 && (
          <p className="mt-1.5 text-xs text-muted">{next ? `До ${payEventName(next)} ${days}` : `До конца месяца ${days}`}</p>
        )}
        {view.note && <p className="mt-1 text-xs text-muted">{view.note}</p>}
      </div>
      {after && next && (
        <p className="mt-3 rounded-2xl bg-surface-2 px-3 py-2 text-sm">
          После {payEventName(next)}: <span className="font-semibold tabular-nums">≈ {formatMoney(Math.max(0, after.perDay))} в день</span>
          <span className="text-muted">
            {" "}
            на {after.days} {plural(after.days, ["день", "дня", "дней"])}
            {reason && ` — ${reason}`}
          </span>
        </p>
      )}

      {/* Доходы, обязательные и отложенное с планом — в «Аналитике» («Подробнее»), предупреждения — в «Требует внимания». */}
    </Card>
  );
}

/** Сколько ближайших событий видно сразу; остальные — по «Все». */
const UPCOMING_PREVIEW = 3;

function UpcomingCard({ events }: { events: UpcomingEvent[] }) {
  const { open } = useUi();
  const today = useToday();
  const [expanded, setExpanded] = useState(false);
  const all = events.slice(0, 30);
  const visible = expanded ? all : all.slice(0, UPCOMING_PREVIEW);
  return (
    <Card
      title="Скоро"
      action={
        all.length > UPCOMING_PREVIEW ? (
          <Button variant="ghost" size="sm" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
            {expanded ? "Свернуть" : `Все ${all.length}`}
          </Button>
        ) : undefined
      }
    >
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
                      останется {formatMoney(e.balanceAfter, { whole: true })}
                    </span>
                  </span>
                </span>
                <Money value={e.amount} sign whole tone={e.amount > 0 ? "positive" : "default"} className="shrink-0 font-semibold" />
              </>
            );
            // Будущая операция открывается на редактирование, начисление регулярного платежа — в окне «пропустить/изменить».
            // Отчисление в сбережения с ожидаемого дохода — расчётная строка, открывать нечего.
            const { txId, templateId, month, accountId } = e;
            const onClick = txId
              ? () => open({ kind: "tx", txId })
              : e.source === "template" && templateId && month
                ? () => open({ kind: "planned", templateId, month })
                : e.source === "credit" && accountId
                  ? () => open({ kind: "transfer", to: accountId, amount: -e.amount })
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
    <section className="surface-card rounded-[28px] p-5 sm:p-6" aria-labelledby="onboarding-title">
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
