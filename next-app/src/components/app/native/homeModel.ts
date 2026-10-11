import { addDays, formatDay, formatMonth, formatMonthIn, formatRelativeDay, monthKeyOf, type IsoDate } from "@/domain/dates";
import {
  balanceAt,
  balanceEffect,
  monthMetrics,
  pendingRollover,
  safeToSpend,
  savingsTotal,
  upcomingEvents,
  type SafeToSpend,
} from "@/domain/metrics";
import { formatMoney } from "@/domain/money";
import type { State, Transaction } from "@/domain/schema";
import { plural } from "@/domain/text";
import { accountBalances, accountCards, cardLabel } from "@/domain/accounts";
import type { Snapshot } from "@/client/store";
import { frequentCategories } from "../frequent";
import { quickPicks, type QuickPick } from "../quickPicks";
import {
  ACCOUNT_KINDS,
  accountRows,
  bankMismatches,
  bankTransferOverlay,
  hasOwnAccounts,
  previewAccountRows,
  lastAccountId,
  lastCardOf,
  payableAccounts,
  transactionAccountLabel,
} from "../accounts";
import type { NativeCommand } from "./commands";

/**
 * Модель нативной Главной (ios/App/App/Home): всё уже посчитано и отформатировано здесь, тем же кодом,
 * что и веб-экран, — Swift только рисует. Порядок блоков — по дизайн-коду (docs/design-code.md, §4).
 */

/** Шаг «обязательные платежи» в первых шагах пропущен (общий ключ с веб-Главной). */
export const SKIP_MANDATORY_KEY = "fp:onboarding-skip-mandatory";

export type Tone = "accent" | "positive" | "warning" | "negative" | "muted";

export interface ActionModel {
  label: string;
  primary: boolean;
  command: NativeCommand;
}

export type TodayModel =
  | {
      kind: "limit";
      label: string;
      amount: string;
      status: { text: string; tone: Tone };
      detail: string;
      gap: string | null;
      over: boolean;
    }
  | { kind: "balance"; text: string };

export interface AttentionModel {
  id: string;
  /** SF Symbol. */
  symbol: string;
  tone: Tone;
  title: string;
  text: string | null;
  /** Вся строка — кнопка. */
  command: NativeCommand | null;
  actions: ActionModel[];
}

export interface OnboardingModel {
  done: number;
  intro: string | null;
  steps: { title: string; done: boolean; doneText: string; actions: ActionModel[] }[];
  importHint: boolean;
}

export interface MonthModel {
  title: string;
  label: string;
  amount: string;
  negative: boolean;
  of: string;
  /** Доля использованного гибкого бюджета (может быть больше 1). */
  progress: number;
  tone: Tone;
  daysLeft: string | null;
}

export interface UpcomingModel {
  key: string;
  title: string;
  when: string;
  after: string;
  afterNegative: boolean;
  amount: string;
  positive: boolean;
  command: NativeCommand | null;
}

export interface RecentModel {
  id: string;
  title: string;
  subtitle: string;
  amount: string;
  amountTone: "default" | "positive" | "negative";
  symbol: string;
  tint: Tone;
  /** Автоотчисление в сбережения с этой операции («+51 ₽»). */
  autoSaving: string | null;
  command: NativeCommand;
}

export interface QuickModel {
  key: string;
  title: string;
  amount: string;
}

export interface AccountModel {
  id: string;
  name: string;
  /** SF Symbol вида счёта. */
  symbol: string;
  amount: string;
  negative: boolean;
  detail: string;
  overdue: boolean;
  command: NativeCommand;
}

export interface AddModel {
  expense: string[];
  income: string[];
  /** Частые категории — чипами сразу. */
  expenseTop: string[];
  incomeTop: string[];
  lastExpense: string | null;
  lastIncome: string | null;
  /** Счета для выбора (пусто — выбор не показывается, всё на основном). */
  accounts: {
    id: string;
    name: string;
    symbol: string;
    cards: { digits: string; label: string }[];
    lastCard: string | null;
    /** Остаток в копейках (у кредитки — минус долг); null — суммы спрятаны глазком. */
    balance: number | null;
    /** Кредитный лимит кредитки; null — не кредитка или лимит не задан. */
    limit: number | null;
    credit: boolean;
  }[];
  lastExpenseAccount: string;
  lastIncomeAccount: string;
  /** Частые траты: заполняют форму одним касанием (сумма в копейках). */
  picks: { title: string; category: string; amount: number; amountText: string }[];
}

export interface HomeModel {
  date: IsoDate;
  sync: { text: string; tone: Tone; symbol: string };
  assistant: boolean;
  hasData: boolean;
  today: TodayModel | null;
  attention: AttentionModel[];
  onboarding: OnboardingModel | null;
  quick: QuickModel[];
  tiles: { balanceLabel: string; balance: string; balanceNegative: boolean; balanceHint: string; savings: string } | null;
  /** Самые важные счета (до трёх) — когда пользователь завёл свои (иначе пусто); все — на экране «Счета». */
  accounts: AccountModel[];
  /** Сколько счетов всего. */
  accountsTotal: number;
  /** Суммы счетов спрятаны глазком («•••• ₽»): показать — по Face ID. */
  balancesHidden: boolean;
  month: MonthModel | null;
  upcoming: UpcomingModel[];
  recent: RecentModel[];
  add: AddModel;
}

export interface HomeInput {
  snapshot: Snapshot;
  today: IsoDate;
  /** Остаток подтверждён в окне сверки (флаг в хранилище). */
  balanceConfirmed: boolean;
  /** Шаг «обязательные платежи» пропущен. */
  mandatorySkipped: boolean;
  /** Доступен ли помощник (DeepSeek на сервере или модель Apple на телефоне). */
  assistant: boolean;
  /** Глазок у сумм счетов: masked — суммы спрятаны, hiding — скрытие включено. Нет — показаны. */
  privacy?: { masked: boolean; hiding: boolean };
}

const STATUS: Record<SafeToSpend["status"], { text: string; tone: Tone }> = {
  ok: { text: "Всё по плану", tone: "positive" },
  tight: { text: "До дохода впритык", tone: "warning" },
  over: { text: "Сегодня перерасход", tone: "negative" },
  gap: { text: "Кассовый разрыв", tone: "negative" },
  "no-income": { text: "Нет доходов в плане", tone: "muted" },
};

function statusBadge(sts: SafeToSpend): { text: string; tone: Tone } {
  const base = STATUS[sts.status];
  if (sts.status === "over" && sts.leftToday >= 0) return { ...base, text: "Бюджет месяца исчерпан" };
  if (sts.status === "tight" && sts.horizon.reason === "month-end") return { ...base, text: "До конца месяца впритык" };
  return base;
}

function syncModel(snapshot: Snapshot): HomeModel["sync"] {
  if (snapshot.mode === "guest") return { text: "Данные только на этом устройстве", tone: "muted", symbol: "iphone" };
  const { sync } = snapshot;
  switch (sync.status) {
    case "synced":
      return { text: "Сохранено", tone: "muted", symbol: "checkmark.icloud" };
    case "saving":
      return { text: "Сохраняем…", tone: "muted", symbol: "icloud" };
    case "offline":
      return {
        text: `Офлайн${sync.pending ? ` · не отправлено: ${sync.pending}` : ""}`,
        tone: "warning",
        symbol: "icloud.slash",
      };
    case "error":
      return { text: sync.message ?? "Ошибка синхронизации", tone: "negative", symbol: "exclamationmark.icloud" };
  }
}

/** Ключ частой траты: по нему веб находит ту же трату, даже если список успел измениться. */
export function quickKey(p: QuickPick): string {
  return `${p.category}|${p.title}|${p.amount}`;
}

function expenseCategories(state: State): string[] {
  return [...new Set([...state.categories.flexible, ...state.categories.mandatory])];
}

function lastCategory(state: State, kind: "income" | "expense"): string | null {
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const tx = state.transactions[i];
    if (tx.type === kind && !tx.templateId && !tx.loanId && (kind === "income" || !tx.mandatory)) return tx.category;
  }
  return null;
}

function attention(input: HomeInput, warnings: string[]): AttentionModel[] {
  const { snapshot, today } = input;
  const { state } = snapshot;
  const rows: AttentionModel[] = [];
  if (snapshot.sessionExpired) {
    rows.push({
      id: "session",
      symbol: "person.crop.circle.badge.exclamationmark",
      tone: "negative",
      title: "Войдите снова",
      text: "Сессия истекла. Изменения сохранены на телефоне и отправятся после входа.",
      command: { type: "open", overlay: { kind: "auth", mode: "login" } },
      actions: [],
    });
  }
  const reviewCount = state.transactions.filter((t) => t.review).length;
  if (reviewCount > 0) {
    rows.push({
      id: "review",
      symbol: "checkmark.circle",
      tone: "accent",
      title: `${reviewCount} ${plural(reviewCount, ["новая операция", "новые операции", "новых операций"])}`,
      text: "Из СМС и Siri — проверьте категории",
      command: { type: "open", overlay: { kind: "review" } },
      actions: [],
    });
  }
  const rollover = pendingRollover(state, today);
  if (rollover) {
    const amount = formatMoney(rollover.amount, { whole: true });
    rows.push({
      id: "rollover",
      symbol: "banknote",
      tone: "positive",
      title: `${formatMonthIn(rollover.month, today).replace(/^в/, "В")} осталось ${amount}`,
      text: "Отложить остаток гибкого бюджета в сбережения?",
      command: null,
      actions: [
        { label: "Отложить", primary: true, command: { type: "rollover", month: rollover.month, amount: rollover.amount, decision: "saved" } },
        { label: "Оставить", primary: false, command: { type: "rollover", month: rollover.month, amount: rollover.amount, decision: "dismissed" } },
      ],
    });
  }
  for (const m of bankMismatches(state, today)) {
    rows.push({
      id: `bank:${m.account.id}`,
      symbol: "building.columns",
      tone: "warning",
      title: m.title,
      text: m.text,
      command: null,
      actions: [
        { label: "Поправить", primary: true, command: { type: "bank", accountId: m.account.id, fix: true } },
        { label: "Перевод", primary: false, command: { type: "open", overlay: bankTransferOverlay(m) } },
        { label: "Оставить", primary: false, command: { type: "bank", accountId: m.account.id, fix: false } },
      ],
    });
  }
  for (const w of warnings) {
    rows.push({ id: `w:${w}`, symbol: "exclamationmark.triangle", tone: "warning", title: w, text: null, command: null, actions: [] });
  }
  if (snapshot.guestImportOffer) {
    rows.push({
      id: "guest",
      symbol: "square.and.arrow.up",
      tone: "accent",
      title: "Перенести данные без входа?",
      text: "На этом устройстве есть операции, которые вы вели без аккаунта.",
      command: null,
      actions: [
        { label: "Перенести", primary: true, command: { type: "guestImport", accept: true } },
        { label: "Не нужно", primary: false, command: { type: "guestImport", accept: false } },
      ],
    });
  }
  if (snapshot.legacyImportOffer) {
    rows.push({
      id: "legacy",
      symbol: "square.and.arrow.up",
      tone: "accent",
      title: "Найдены данные старой версии",
      text: "Перенести их? Текущие данные будут заменены.",
      command: null,
      actions: [
        { label: "Перенести", primary: true, command: { type: "legacyImport", accept: true } },
        { label: "Не нужно", primary: false, command: { type: "legacyImport", accept: false } },
      ],
    });
  }
  return rows;
}

function onboarding(input: HomeInput, hasData: boolean, progress: { balance: boolean; income: boolean; mandatory: boolean }): OnboardingModel | null {
  if (progress.balance && progress.income && progress.mandatory) return null;
  const done = [progress.balance, progress.income, progress.mandatory].filter(Boolean).length;
  return {
    done,
    intro:
      done === 0
        ? "Приложение считает, сколько можно тратить каждый день, чтобы хватило на обязательные платежи и сбережения. Для этого нужны три вещи:"
        : null,
    steps: [
      {
        title: "Сколько денег сейчас на счёте",
        done: progress.balance,
        doneText: "Готово",
        actions: [{ label: "Указать остаток", primary: true, command: { type: "open", overlay: { kind: "balance" } } }],
      },
      {
        title: "Регулярные доходы — зарплата, аванс",
        done: progress.income,
        doneText: "Готово",
        actions: [
          { label: "Добавить доход", primary: true, command: { type: "open", overlay: { kind: "template", preset: { kind: "income" } } } },
        ],
      },
      {
        title: "Обязательные платежи — аренда, кредиты, связь",
        done: progress.mandatory,
        doneText: input.mandatorySkipped ? "Пропущено — можно добавить позже на вкладке «Регулярные»" : "Готово",
        actions: [
          { label: "Добавить платёж", primary: true, command: { type: "open", overlay: { kind: "template", preset: { kind: "expense" } } } },
          { label: "Пропустить", primary: false, command: { type: "skipMandatory" } },
        ],
      },
    ],
    importHint: !hasData,
  };
}

const TX_META: Record<Transaction["type"], { symbol: string; tint: Tone }> = {
  income: { symbol: "arrow.down", tint: "positive" },
  expense: { symbol: "arrow.up", tint: "muted" },
  saving: { symbol: "banknote", tint: "accent" },
  adjustment: { symbol: "wallet.bifold", tint: "warning" },
  transfer: { symbol: "arrow.left.arrow.right", tint: "accent" },
};

function recentRow(state: State, tx: Transaction, today: IsoDate, autoSaving: number): RecentModel {
  const loanAdjustment = tx.type === "adjustment" && tx.loanId !== undefined;
  const meta = loanAdjustment ? { symbol: "person.2", tint: "muted" as Tone } : TX_META[tx.type];
  const effect = balanceEffect(tx);
  const categoryLabel = loanAdjustment ? "Долг · через счёт" : tx.category;
  const savingNote = tx.type === "saving" ? (tx.amount > 0 ? "в сбережения" : "из сбережений") : null;
  const subtitle = [
    `${formatRelativeDay(tx.date, today)}${tx.title && tx.category ? ` · ${categoryLabel}` : ""}`,
    transactionAccountLabel(state, tx),
    savingNote,
  ]
    .filter(Boolean)
    .join(" · ");
  const amountTone =
    tx.type === "income" ? "positive" : tx.type === "adjustment" ? (effect > 0 ? "positive" : effect < 0 ? "negative" : "default") : "default";
  return {
    id: tx.id,
    title:
      tx.title ||
      tx.category ||
      { income: "Доход", expense: "Расход", saving: "Сбережения", adjustment: "Корректировка", transfer: "Перевод" }[tx.type],
    subtitle,
    amount: tx.type === "transfer" ? formatMoney(tx.amount) : formatMoney(effect, { sign: true }),
    amountTone,
    symbol: meta.symbol,
    tint: meta.tint,
    autoSaving: autoSaving !== 0 ? formatMoney(autoSaving, { sign: true }) : null,
    command: { type: "open", overlay: { kind: "tx", txId: tx.id } },
  };
}

/** Спрятанная сумма. */
const MASK = "•••• ₽";

export function buildHomeModel(input: HomeInput): HomeModel {
  const { snapshot, today } = input;
  const masked = input.privacy?.masked ?? false;
  const { state } = snapshot;
  const month = monthKeyOf(today);
  const hasData = state.transactions.length > 0 || state.templates.length > 0;

  const steps = {
    balance:
      input.balanceConfirmed ||
      state.transactions.some((t) => t.type === "adjustment" || (t.type === "income" && t.date <= today)),
    income:
      state.templates.some((t) => t.kind === "income" && t.active) ||
      state.transactions.some((t) => t.type === "income" && monthKeyOf(t.date) === month),
    mandatory: input.mandatorySkipped || state.templates.some((t) => t.kind === "expense"),
  };

  const metrics = monthMetrics(state, month, today);
  const picks = quickPicks(state, today, 6);
  const ownAccounts = hasOwnAccounts(state);
  const balances = accountBalances(state, today);
  const add: AddModel = {
    expense: expenseCategories(state),
    income: state.categories.income,
    // Частые — видны сразу, остальные — по «Все категории».
    expenseTop: frequentCategories(state, "expense", expenseCategories(state)),
    incomeTop: frequentCategories(state, "income", state.categories.income),
    lastExpense: lastCategory(state, "expense"),
    lastIncome: lastCategory(state, "income"),
    // Счета с картами — даже при одном счёте: чтобы выбрать карту.
    accounts: ownAccounts || payableAccounts(state).some((a) => accountCards(a).length > 0)
      ? payableAccounts(state).map((a) => ({
          id: a.id,
          name: a.name,
          symbol: ACCOUNT_KINDS[a.kind].symbol,
          cards: accountCards(a).map((c) => ({ digits: c.digits, label: cardLabel(a, c.digits) })),
          lastCard: lastCardOf(state, a.id),
          // Сколько на счёте — в окне добавления (если суммы не спрятаны глазком).
          balance: masked ? null : (balances.get(a.id) ?? 0),
          limit: a.kind === "credit" ? (a.creditLimit ?? null) : null,
          credit: a.kind === "credit",
        }))
      : [],
    lastExpenseAccount: lastAccountId(state, "expense"),
    lastIncomeAccount: lastAccountId(state, "income"),
    picks: picks.map((p) => ({ title: p.title || p.category, category: p.category, amount: p.amount, amountText: formatMoney(p.amount) })),
  };
  const base = {
    date: today,
    sync: syncModel(snapshot),
    assistant: input.assistant,
    hasData,
    add,
  };

  if (!hasData) {
    return {
      ...base,
      today: null,
      attention: attention(input, []),
      onboarding: onboarding(input, hasData, steps),
      quick: [],
      tiles: null,
      accounts: [],
      accountsTotal: 0,
      balancesHidden: masked,
      month: null,
      upcoming: [],
      recent: [],
    };
  }

  const sts = safeToSpend(state, today);
  const todayModel: TodayModel = steps.balance
    ? {
        kind: "limit",
        label: sts.leftToday < 0 ? "Сегодня потрачено сверх лимита" : "Сегодня можно потратить",
        amount: formatMoney(Math.abs(sts.leftToday), { whole: true }),
        status: statusBadge(sts),
        detail: `Лимит на день ${formatMoney(sts.recommended, { whole: true })} · потрачено ${formatMoney(sts.spentToday, { whole: true })}`,
        gap:
          sts.status === "gap"
            ? `${
                sts.gapDate
                  ? `По прогнозу ${formatDay(sts.gapDate)} деньги на счёте закончатся.`
                  : "Денег на счёте не хватает на обязательные платежи до следующего дохода."
              } Перенесите платёж, найдите доход или сократите траты.`
            : null,
        over: sts.leftToday < 0,
      }
    : { kind: "balance", text: "Укажите, сколько сейчас денег на счёте, — и приложение посчитает лимит на день" };

  const balance = balanceAt(state, today);
  const f = metrics.flexible;
  const used = f.spent + f.reserved + f.extraSavings;
  const ratio = f.budget > 0 ? used / f.budget : 1;

  const autoSavings = new Map<string, number>();
  for (const t of state.transactions) {
    if (t.linkedTo) autoSavings.set(t.linkedTo, (autoSavings.get(t.linkedTo) ?? 0) + t.amount);
  }
  // Сначала разворачиваем: при стабильной сортировке по дате внутри дня сверху окажутся добавленные позже.
  const recent = [...state.transactions]
    .reverse()
    .filter((t) => t.date <= today && !t.linkedTo)
    .sort((a, b) => b.date.localeCompare(a.date))
    .slice(0, 5);

  return {
    ...base,
    today: todayModel,
    attention: attention(input, metrics.warnings),
    onboarding: onboarding(input, hasData, steps),
    quick: picks.map((p) => ({ key: quickKey(p), title: p.title || p.category, amount: formatMoney(p.amount) })),
    tiles: {
      balanceLabel: ownAccounts ? "На счетах" : "На счёте",
      balance: masked ? MASK : formatMoney(balance, { whole: true }),
      balanceNegative: !masked && balance < 0,
      balanceHint: steps.balance ? "Сверить остаток" : "Указать остаток",
      savings: masked ? MASK : formatMoney(savingsTotal(state, today), { whole: true }),
    },
    accountsTotal: ownAccounts ? accountRows(state, today).length : 0,
    balancesHidden: masked,
    accounts: ownAccounts
      ? previewAccountRows(accountRows(state, today)).map((row) => ({
          id: row.account.id,
          name: row.account.name,
          symbol: ACCOUNT_KINDS[row.account.kind].symbol,
          // Спрятано: ни остатка, ни сумм в пояснении (долг, лимит, проценты).
          amount: masked ? MASK : row.amount,
          negative: !masked && row.negative,
          detail: masked ? ACCOUNT_KINDS[row.account.kind].label : row.detail,
          overdue: row.overdue,
          command: { type: "open", overlay: { kind: "account", accountId: row.account.id } },
        }))
      : [],
    month: {
      title: formatMonth(month),
      label: f.left < 0 ? "Перерасход гибкого бюджета" : "Осталось в гибком бюджете",
      amount: formatMoney(Math.abs(f.left), { whole: true }),
      negative: f.left < 0,
      of: `из ${formatMoney(Math.max(0, f.budget), { whole: true })}`,
      progress: Math.max(0, ratio),
      tone: ratio > 1 ? "negative" : ratio > 0.85 ? "warning" : "accent",
      daysLeft:
        metrics.daysLeft > 0
          ? `До конца месяца ${metrics.daysLeft} ${plural(metrics.daysLeft, ["день", "дня", "дней"])}`
          : null,
    },
    upcoming: upcomingEvents(state, today, addDays(today, 30))
      .slice(0, 30)
      .map((e) => ({
        key: e.key,
        title: e.title,
        when: formatRelativeDay(e.date, today).replace(/, .*/, ""),
        after: `останется ${formatMoney(e.balanceAfter, { whole: true })}`,
        afterNegative: e.balanceAfter < 0,
        amount: formatMoney(e.amount, { sign: true, whole: true }),
        positive: e.amount > 0,
        command: e.txId
          ? { type: "open", overlay: { kind: "tx", txId: e.txId } }
          : e.source === "template" && e.templateId && e.month
            ? { type: "open", overlay: { kind: "planned", templateId: e.templateId, month: e.month } }
            : e.source === "credit" && e.accountId
              ? { type: "open", overlay: { kind: "transfer", to: e.accountId, amount: -e.amount } }
              : null,
      })),
    recent: recent.map((tx) => recentRow(state, tx, today, autoSavings.get(tx.id) ?? 0)),
  };
}
