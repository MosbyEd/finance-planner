"use client";

import { useMemo, useState } from "react";
import { addDays, addMonths, formatDay, isValidIsoDate, monthKeyOf, type IsoDate } from "@/domain/dates";
import { loanOpening } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import { occurrenceDate } from "@/domain/recurring";
import { autoSavingAmount, autoSavingByDefault } from "@/domain/savings";
import { suggestCategory } from "@/domain/sms";
import type { State, Transaction } from "@/domain/schema";
import { newId, useSnapshot, useToday } from "@/client/react";
import { accountCards, activeAccounts, cardLabel, findAccount, MAIN_ACCOUNT_ID, SAVINGS_ACCOUNT_ID, sourceAccountId } from "@/domain/accounts";
import { isEditableTransaction } from "@/domain/actions";
import { AccountPicker } from "../ui/AccountPicker";
import { AmountInput } from "../ui/AmountInput";
import { Button } from "../ui/Button";
import { CategoryPicker } from "../ui/CategoryPicker";
import { Segmented, Switch } from "../ui/controls";
import { useToast } from "../ui/feedback";
import { DateInput, TextInput } from "../ui/Field";
import { Sheet } from "../ui/Sheet";
import { bankResolveActions, hasOwnAccounts, lastAccountId, lastCardOf, payableAccounts } from "./accounts";
import { useDeleteTransaction, useDispatch } from "./hooks";
import { quickPicks } from "./quickPicks";
import { useUi } from "./overlays";

/** Категории расходов одним списком: сначала повседневные, затем обязательные (без повторов). */
function expenseCategories(state: State): string[] {
  return [...new Set([...state.categories.flexible, ...state.categories.mandatory])];
}

/** Обязательная ли категория: из группы «Обязательные» и не повторяется в повседневных. */
function isMandatoryCategory(state: State, category: string): boolean {
  return state.categories.mandatory.includes(category) && !state.categories.flexible.includes(category);
}

function lastCategory(state: State, kind: "income" | "expense", mandatory: boolean): string | null {
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const tx = state.transactions[i];
    if (tx.type === kind && !tx.templateId && !tx.loanId && (kind === "income" || Boolean(tx.mandatory) === mandatory)) {
      return tx.category;
    }
  }
  return null;
}

type Kind = "income" | "expense" | "transfer";

/** Что подставить в новую операцию: из нативного окна («Повтор и другие параметры»), из счёта, из «Скоро». */
export interface TxPreset {
  type?: Kind;
  mandatory?: boolean;
  date?: IsoDate;
  amount?: Kopecks;
  category?: string;
  title?: string;
  accountId?: string;
  card?: string;
  /** Перевод: откуда и куда. */
  from?: string;
  to?: string;
  /** Перевод объясняет расхождение остатка с банком на этом счёте — после него расхождение снимается. */
  resolveBank?: string;
}

/** Откуда и куда шли деньги у перевода или сбережений (у снятия из сбережений — с накопительного на счёт). */
function movementOf(tx: Transaction): { from: string; to: string } {
  if (tx.type === "saving") {
    const savings = tx.toAccountId ?? SAVINGS_ACCOUNT_ID;
    const other = tx.accountId ?? MAIN_ACCOUNT_ID;
    return tx.amount >= 0 ? { from: other, to: savings } : { from: savings, to: other };
  }
  return { from: tx.accountId ?? MAIN_ACCOUNT_ID, to: tx.toAccountId ?? MAIN_ACCOUNT_ID };
}

/**
 * Окно операции: новая или правка — расход, доход или перевод между своими счетами. Тип переключается без
 * потери введённого (сумма, дата, описание, счёт); у сохранённой операции тип тоже можно поменять — например,
 * если СМС записала перевод на свой накопительный как покупку.
 */
export function TransactionSheet({ txId, preset }: { txId?: string; preset?: TxPreset }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const deleteTx = useDeleteTransaction();
  const toast = useToast();
  const existing = txId ? state.transactions.find((t) => t.id === txId) : undefined;
  const editing = Boolean(existing);
  const template = existing?.templateId ? state.templates.find((t) => t.id === existing.templateId) : undefined;
  const accounts = activeAccounts(state);
  const showAccounts = hasOwnAccounts(state);

  const existingKind: Kind | null = existing
    ? existing.type === "income" || existing.type === "expense"
      ? existing.type
      : "transfer"
    : null;
  const [kind, setKind] = useState<Kind>(existingKind ?? preset?.type ?? "expense");
  const categoryKind: "income" | "expense" = kind === "income" ? "income" : "expense";
  const presetMandatory = preset?.mandatory ?? false;
  const [category, setCategory] = useState(() => {
    if (existing && existingKind !== "transfer") return existing.category;
    if (preset?.category) return preset.category;
    const first = kind === "income" ? "income" : presetMandatory ? "mandatory" : "flexible";
    return lastCategory(state, categoryKind, presetMandatory) ?? state.categories[first][0] ?? "";
  });
  // Обязательность следует из категории (аренда, связь — обязательные), пока человек не переключил её сам.
  const [mandatory, setMandatory] = useState(() =>
    existing && existingKind === "expense" ? Boolean(existing.mandatory) : presetMandatory || isMandatoryCategory(state, category),
  );
  const [mandatoryTouched, setMandatoryTouched] = useState(false);
  const [amount, setAmount] = useState<Kopecks | null>(
    existing ? Math.abs(existing.amount) : (preset?.amount ?? null),
  );
  const [title, setTitle] = useState(existing?.title ?? preset?.title ?? "");
  // Счёт расхода или дохода. У перевода — откуда и куда.
  const movement = existing && existingKind === "transfer" ? movementOf(existing) : null;
  const [accountId, setAccountId] = useState(() =>
    existing && existingKind !== "transfer"
      ? sourceAccountId(existing)
      : (preset?.accountId ?? movement?.from ?? lastAccountId(state, categoryKind)),
  );
  const firstOther = (except: string) =>
    accounts.find((a) => a.id !== except && a.kind === "savings")?.id ?? accounts.find((a) => a.id !== except)?.id ?? "";
  const [from, setFrom] = useState(() => movement?.from ?? preset?.from ?? (preset?.to === MAIN_ACCOUNT_ID ? firstOther(MAIN_ACCOUNT_ID) : accountId));
  const [to, setTo] = useState(() => movement?.to ?? preset?.to ?? firstOther(movement?.from ?? preset?.from ?? accountId));
  // Карта счёта, которой платили: у счёта с картами — выбор чипами (по умолчанию — карта последней операции).
  const selectedAccount = findAccount(state, accountId);
  const cards = selectedAccount && kind !== "transfer" ? accountCards(selectedAccount) : [];
  const [card, setCard] = useState<string | null>(() =>
    existing ? (existing.card ?? null) : (preset?.card ?? lastCardOf(state, accountId)),
  );
  const chooseAccount = (id: string) => {
    setAccountId(id);
    setCard(lastCardOf(state, id));
  };
  const cardValue = card && cards.some((c) => c.digits === card) ? card : null;
  const [date, setDate] = useState<IsoDate>(existing?.date ?? preset?.date ?? today);
  const [autoSavingTouched, setAutoSavingTouched] = useState(false);
  const [autoSavingChoice, setAutoSavingChoice] = useState(existing?.autoSaving ?? false);
  const [repeat, setRepeat] = useState(false);
  /** Какой вид расхода был до включения повтора — вернём его, если повтор выключат. */
  const [mandatoryBeforeRepeat, setMandatoryBeforeRepeat] = useState(mandatory);
  const [errors, setErrors] = useState<{ amount?: string; category?: string; date?: string; accounts?: string }>({});
  // Исходные значения формы — чтобы понять, есть ли несохранённые изменения.
  const [initial] = useState(() => ({ kind, mandatory, category, amount, title, date, accountId, card, from, to }));
  const dirty =
    kind !== initial.kind ||
    amount !== initial.amount ||
    title !== initial.title ||
    date !== initial.date ||
    (kind === "transfer"
      ? from !== initial.from || to !== initial.to
      : accountId !== initial.accountId ||
        card !== initial.card ||
        mandatory !== initial.mandatory ||
        category !== initial.category ||
        autoSavingTouched ||
        repeat);
  // Регулярный расход всегда обязательный (так он попадает в план месяца) — показываем это в форме сразу.
  const mandatoryLocked = repeat && kind === "expense";
  const categories = kind === "income" ? state.categories.income : expenseCategories(state);
  const fromAccount = accounts.find((a) => a.id === from) ?? findAccount(state, from);
  const toAccount = accounts.find((a) => a.id === to) ?? findAccount(state, to);

  const pickCategory = (next: string) => {
    setCategory(next);
    if (kind === "expense" && !mandatoryTouched && !mandatoryLocked) setMandatory(isMandatoryCategory(state, next));
  };

  const picks = useMemo(() => (editing || kind !== "expense" ? [] : quickPicks(state, today)), [editing, kind, state, today]);

  // Пока человек сам не трогал переключатель, он следует настройкам и категории.
  const autoSaving =
    autoSavingTouched || (editing && existingKind !== "transfer")
      ? autoSavingChoice
      : kind === "transfer"
        ? false
        : autoSavingByDefault({ type: kind, amount: amount ?? 0, category }, state.settings);
  const autoSavingPreview =
    kind === "transfer" ? 0 : autoSavingAmount({ type: kind, amount: amount ?? 0, category, autoSaving: true }, state.settings);
  const autoSavingAvailable = kind !== "transfer" && (autoSavingPreview > 0 || (editing && Boolean(existing?.autoSaving)));

  /** Смена типа: сумма, дата, описание и счёт остаются. */
  const switchKind = (next: Kind) => {
    if (next === kind) return;
    if (next === "transfer") {
      // Расход — деньги ушли со счёта, доход — пришли на него.
      if (kind === "income") {
        setTo(accountId);
        setFrom(firstOther(accountId));
      } else {
        setFrom(accountId);
        setTo(firstOther(accountId));
      }
    } else if (kind === "transfer") {
      const own = next === "income" ? to : from;
      if (payableAccounts(state).some((a) => a.id === own)) chooseAccount(own);
    }
    setKind(next);
    if (next === "transfer") return;
    const list = next === "income" ? state.categories.income : expenseCategories(state);
    let nextCategory = list.includes(category) ? category : (lastCategory(state, next, false) ?? list[0] ?? "");
    // Перевод стал покупкой или доходом — категорию подбираем по названию, как для операций из СМС.
    if (kind === "transfer" && title.trim()) nextCategory = suggestCategory(state, next, title, { fallback: nextCategory }).category;
    setCategory(nextCategory);
    // Расход с повтором — сразу обязательный; иначе — по категории.
    if (next === "expense") setMandatory(repeat || (mandatoryTouched ? mandatory : isMandatoryCategory(state, nextCategory)));
  };
  const switchMandatory = (next: boolean) => {
    setMandatoryTouched(true);
    setMandatory(next);
  };
  const switchRepeat = (next: boolean) => {
    setRepeat(next);
    if (kind !== "expense") return;
    if (next) {
      setMandatoryBeforeRepeat(mandatory);
      setMandatory(true);
    } else {
      setMandatory(mandatoryBeforeRepeat);
    }
  };
  const repeatDay = isValidIsoDate(date) ? Number(date.slice(8)) : null;
  // Регулярный платёж начинает работать с сегодняшнего дня: если между датой операции и сегодня
  // были ещё платёжные дни, задним числом они не появятся.
  const repeatSkipsPast =
    repeatDay !== null && occurrenceDate({ dayOfMonth: repeatDay }, addMonths(monthKeyOf(date), 1)) < today;

  const saveTransfer = (value: Kopecks): boolean => {
    if (!fromAccount || !toAccount || from === to) {
      setErrors((e) => ({ ...e, accounts: "Выберите два разных счёта" }));
      return false;
    }
    const note = existing?.note ?? "";
    const cleanTitle = title.trim();
    if (existing) {
      return dispatch({ type: "tx.move", id: existing.id, date, from, to, amount: value, ...(cleanTitle ? { title: cleanTitle } : {}) });
    }
    const ok =
      toAccount.kind === "savings" && fromAccount.kind !== "savings"
        ? dispatch({ type: "savings.move", id: newId(), date, amount: value, note, accountId: from, toAccountId: to })
        : fromAccount.kind === "savings" && toAccount.kind !== "savings"
          ? dispatch({ type: "savings.move", id: newId(), date, amount: -value, note, accountId: to, toAccountId: from })
          : dispatch({ type: "transfer.add", id: newId(), date, from, to, amount: value, note, ...(cleanTitle ? { title: cleanTitle } : {}) });
    if (ok && preset?.resolveBank) dispatch(bankResolveActions(state, preset.resolveBank, false, today, newId()));
    if (ok) toast(`${toAccount.kind === "credit" ? "Погашено" : "Переведено"} ${formatMoney(value)}: ${fromAccount.name} → ${toAccount.name}`);
    return ok;
  };

  const save = () => {
    const nextErrors: typeof errors = {};
    if (!amount || amount <= 0) nextErrors.amount = "Введите сумму";
    if (kind !== "transfer" && !category.trim()) nextErrors.category = "Выберите категорию";
    if (!isValidIsoDate(date)) nextErrors.date = "Укажите дату";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || !amount) return;

    if (kind === "transfer") {
      if (saveTransfer(amount)) close();
      return;
    }
    const ok = existing
      ? dispatch({
          type: "tx.update",
          id: existing.id,
          patch: {
            type: kind,
            amount,
            date,
            category: category.trim(),
            title: title.trim(),
            mandatory: kind === "expense" ? mandatory : false,
            autoSaving: autoSavingAvailable && autoSaving,
            // Перевод стал расходом или доходом — счёт указываем всегда.
            ...(showAccounts && (existingKind === "transfer" || accountId !== sourceAccountId(existing)) ? { accountId } : {}),
            ...(cardValue !== (existing.card ?? null) ? { card: cardValue } : {}),
          },
        })
      : dispatch({
          type: "tx.add",
          tx: {
            id: newId(),
            type: kind,
            amount,
            date,
            category: category.trim(),
            title: title.trim(),
            note: "",
            mandatory: kind === "expense" ? mandatory || repeat : false,
            autoSaving: autoSavingAvailable && autoSaving,
            ...(showAccounts ? { accountId } : {}),
            ...(cardValue ? { card: cardValue } : {}),
            ...(repeat ? { repeat: { templateId: newId(), startDate: date > today ? date : today } } : {}),
          },
        });
    if (!ok) return;
    close();
    if (!existing) toast(kind === "income" ? "Доход добавлен" : "Расход добавлен");
  };

  if (existing && !isEditableTransaction(existing)) return <ReadOnlyTransaction tx={existing} />;

  const repays = kind === "transfer" && toAccount?.kind === "credit";
  const kinds: { value: Kind; label: string }[] = [
    { value: "expense", label: "Расход" },
    { value: "income", label: "Доход" },
    // Перевод между своими счетами: погашение кредитки, пополнение накопительного, снятие наличных.
    ...(showAccounts || existingKind === "transfer" ? [{ value: "transfer" as const, label: "Перевод" }] : []),
  ];

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={
        editing
          ? "Операция"
          : kind === "income"
            ? "Новый доход"
            : kind === "expense"
              ? "Новый расход"
              : repays
                ? "Погасить кредитку"
                : "Перевод между счетами"
      }
      footer={
        <div className="flex gap-2">
          {existing && (
            <Button
              variant="secondary"
              icon="trash"
              onClick={() => {
                close();
                deleteTx(existing.id);
              }}
            >
              Удалить
            </Button>
          )}
          <Button className="flex-1" onClick={save}>
            {editing ? "Сохранить" : kind === "transfer" ? (repays ? "Погасить" : "Перевести") : "Добавить"}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {kinds.length > 1 && <Segmented<Kind> label="Тип операции" value={kind} onChange={switchKind} options={kinds} />}
        {editing && existingKind !== kind && (
          <p className="-mt-3 text-sm text-muted">
            {kind === "transfer"
              ? "Операция станет переводом между вашими счетами — не расходом и не доходом."
              : `Перевод станет ${kind === "income" ? "доходом" : "расходом"} с категорией.`}
          </p>
        )}

        <AmountInput
          label="Сумма"
          value={amount}
          onChange={(v) => {
            setAmount(v);
            setErrors((e) => ({ ...e, amount: undefined }));
          }}
          error={errors.amount}
          autoFocus={!editing && preset?.amount === undefined}
        />

        {kind === "transfer" ? (
          <>
            <AccountPicker
              label="Откуда"
              accounts={accounts}
              value={from}
              onChange={(id) => {
                setFrom(id);
                if (id === to) setTo(firstOther(id));
                setErrors((e) => ({ ...e, accounts: undefined }));
              }}
            />
            <AccountPicker
              label="Куда"
              accounts={accounts.filter((a) => a.id !== from)}
              value={to}
              onChange={(id) => {
                setTo(id);
                setErrors((e) => ({ ...e, accounts: undefined }));
              }}
              error={errors.accounts}
            />
            <p className="-mt-2 text-sm text-muted">
              {toAccount?.kind === "savings" && fromAccount?.kind !== "savings"
                ? "Пополнение сбережений — считается отложенным в этом месяце."
                : fromAccount?.kind === "savings" && toAccount?.kind !== "savings"
                  ? "Снятие из сбережений на счёт."
                  : repays
                    ? "Погашение кредитки — перевод: покупки по ней уже учтены, когда вы их делали."
                    : "Перевод между своими счетами — не доход и не расход."}
            </p>
          </>
        ) : (
          showAccounts && (
            <AccountPicker
              label={kind === "income" ? "На какой счёт" : "С какого счёта"}
              accounts={payableAccounts(state)}
              value={accountId}
              onChange={chooseAccount}
            />
          )
        )}

        {cards.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-muted">Карта</legend>
            <div className="flex flex-wrap gap-2">
              {[null, ...cards.map((c) => c.digits)].map((digits) => (
                <button
                  key={digits ?? "none"}
                  type="button"
                  aria-pressed={cardValue === digits}
                  onClick={() => setCard(digits)}
                  className={`h-10 max-w-full truncate rounded-full border px-3.5 text-sm transition ${
                    cardValue === digits ? "sheen border-accent-fill bg-accent-fill text-on-accent" : "glass-control"
                  }`}
                >
                  {digits ? cardLabel(selectedAccount, digits) : "Без карты"}
                </button>
              ))}
            </div>
          </fieldset>
        )}

        {picks.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted">Часто</p>
            <div className="-mx-5 flex gap-2 overflow-x-auto px-5 pb-1 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              {picks.map((p) => (
                <button
                  key={`${p.category}|${p.title}|${p.amount}`}
                  type="button"
                  onClick={() => {
                    setAmount(p.amount);
                    setCategory(p.category);
                    setTitle(p.title);
                    setMandatory(p.mandatory || mandatoryLocked);
                    setMandatoryTouched(true);
                  }}
                  className="max-w-48 shrink-0 rounded-2xl border border-border bg-surface-2 px-3 py-1.5 text-left text-sm hover:border-accent"
                >
                  <span className="block truncate font-medium">{p.title || p.category}</span>
                  <span className="text-muted">{formatMoney(p.amount)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {kind !== "transfer" && (
          <CategoryPicker
            label="Категория"
            showValue
            categories={categories}
            value={category}
            onChange={pickCategory}
            error={errors.category}
          />
        )}

        <TextInput
          label="Описание"
          placeholder="Необязательно"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="space-y-2">
          <DateInput label="Дата" value={date} onChange={(e) => setDate(e.target.value)} error={errors.date} />
          <div className="flex flex-wrap items-center gap-2">
            {[
              { label: "Сегодня", value: today },
              { label: "Вчера", value: addDays(today, -1) },
            ].map((d) => (
              <button
                key={d.label}
                type="button"
                onClick={() => setDate(d.value)}
                aria-pressed={date === d.value}
                className={`h-10 rounded-full px-3.5 text-sm ${date === d.value ? "bg-accent-soft font-medium text-accent" : "bg-surface-2 text-muted hover:text-text"}`}
              >
                {d.label}
              </button>
            ))}
            {date > today && <span className="text-sm text-muted">Запланировано на {formatDay(date)}</span>}
          </div>
        </div>

        {kind === "expense" && (
          <Switch
            checked={mandatory}
            onChange={switchMandatory}
            disabled={mandatoryLocked}
            label="Обязательный расход"
            description={
              mandatoryLocked
                ? "Регулярные расходы считаются обязательными"
                : mandatory
                  ? "Как аренда и кредиты: заранее вычитается из бюджета месяца"
                  : "Повседневная трата — из гибкого бюджета. Обязательность подставляется по категории"
            }
          />
        )}

        {autoSavingAvailable && (
          <Switch
            checked={autoSaving}
            onChange={(v) => {
              setAutoSavingTouched(true);
              setAutoSavingChoice(v);
            }}
            label="Отложить в сбережения"
            description={
              autoSavingPreview > 0
                ? autoSaving
                  ? `${formatMoney(autoSavingPreview)} уйдёт в сбережения`
                  : `Можно отложить ${formatMoney(autoSavingPreview)}`
                : "По текущим настройкам отчисления нет"
            }
          />
        )}

        {!editing && kind !== "transfer" && (
          <Switch
            checked={repeat}
            onChange={switchRepeat}
            label="Повторять каждый месяц"
            description={
              repeatDay !== null
                ? `Операция будет добавляться каждый месяц ${repeatDay}-го числа.${
                    repeatSkipsPast ? " Прошедшие месяцы не заполнятся — начнём со следующего платежа." : ""
                  }`
                : kind === "income"
                  ? "Создаст регулярный доход"
                  : "Создаст регулярный платёж"
            }
          />
        )}

        {template && (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
            Создано по {template.kind === "income" ? "регулярному доходу" : "регулярному платежу"} «{template.title}».
            Изменения здесь касаются только этой операции.
          </p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function ReadOnlyTransaction({ tx }: { tx: Transaction }) {
  const { close } = useUi();
  const deleteTx = useDeleteTransaction();
  const { state } = useSnapshot();
  const source = tx.linkedTo ? state.transactions.find((t) => t.id === tx.linkedTo) : undefined;
  // Операция по долгу через счёт. Поступление денег в долг (первая корректировка) меняется только вместе с долгом —
  // правка суммы долга обновляет её сама; ошибочный платёж по долгу удалить можно.
  const loan = tx.loanId ? state.loans.find((l) => l.id === tx.loanId) : undefined;
  const isLoan = Boolean(tx.loanId);
  const isLoanOpening = Boolean(loan && loanOpening(state, loan)?.id === tx.id);
  return (
    <Sheet
      open
      onClose={close}
      title={isLoan ? "Долг" : tx.type === "saving" ? "Сбережения" : "Корректировка"}
      footer={
        isLoanOpening ? undefined : (
          <Button
            variant="secondary"
            icon="trash"
            className="w-full"
            onClick={() => {
              close();
              deleteTx(tx.id);
            }}
          >
            Удалить
          </Button>
        )
      }
    >
      <div className="space-y-3 text-[15px]">
        <dl className="space-y-3">
          <div className="flex justify-between gap-4">
            <dt className="text-muted">
              {tx.type === "saving" ? (tx.amount > 0 ? "Со счёта в сбережения" : "Из сбережений на счёт") : "Сумма"}
            </dt>
            <dd className="font-semibold tabular-nums">
              {tx.type === "saving" ? formatMoney(Math.abs(tx.amount)) : formatMoney(tx.amount, { sign: true })}
            </dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Дата</dt>
            <dd>{formatDay(tx.date)}</dd>
          </div>
          <div className="flex justify-between gap-4">
            <dt className="text-muted">Описание</dt>
            <dd className="text-right">{tx.title || tx.category}</dd>
          </div>
        </dl>
        {source && (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
            Отчисление создано автоматически с операции «{source.title || source.category}». Если удалить его, при
            правке операции оно не вернётся.
          </p>
        )}
        {isLoan ? (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
            {isLoanOpening
              ? `Деньги, полученные или отданные в долг «${loan?.name ?? (tx.title || tx.category)}». Сумма меняется вместе с долгом в его карточке на вкладке «Цели» → «Долги».`
              : `Платёж по долгу «${loan?.name ?? (tx.title || tx.category)}». Если он записан по ошибке — удалите его, остаток долга пересчитается.`}
          </p>
        ) : tx.type === "adjustment" && (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
            Корректировка выравнивает расчётный остаток с реальным. Её нельзя изменить — только удалить и задать остаток
            заново.
          </p>
        )}
      </div>
    </Sheet>
  );
}
