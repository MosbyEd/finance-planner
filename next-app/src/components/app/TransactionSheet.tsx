"use client";

import { useMemo, useState } from "react";
import { addDays, addMonths, formatDay, isValidIsoDate, monthKeyOf, type IsoDate } from "@/domain/dates";
import { loanOpening } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import { occurrenceDate } from "@/domain/recurring";
import { autoSavingAmount, autoSavingByDefault } from "@/domain/savings";
import type { State, Transaction } from "@/domain/schema";
import { newId, useSnapshot, useToday } from "@/client/react";
import { AmountInput } from "../ui/AmountInput";
import { Button } from "../ui/Button";
import { CategoryPicker } from "../ui/CategoryPicker";
import { Segmented, Switch } from "../ui/controls";
import { useToast } from "../ui/feedback";
import { DateInput, TextInput } from "../ui/Field";
import { Sheet } from "../ui/Sheet";
import { useDeleteTransaction, useDispatch } from "./hooks";
import { useUi } from "./overlays";

type Kind = "income" | "expense";

interface QuickPick {
  category: string;
  title: string;
  amount: Kopecks;
  mandatory: boolean;
}

/** Частые недавние траты — одним нажатием заполняют форму. */
function quickPicks(state: State, today: IsoDate): QuickPick[] {
  const from = addDays(today, -60);
  const counts = new Map<string, { pick: QuickPick; count: number; last: string }>();
  for (const tx of state.transactions) {
    if (tx.type !== "expense" || tx.templateId || tx.loanId || tx.date < from || tx.date > today) continue;
    const key = `${tx.category}|${tx.title}|${tx.amount}`;
    const entry = counts.get(key) ?? {
      pick: { category: tx.category, title: tx.title, amount: tx.amount, mandatory: Boolean(tx.mandatory) },
      count: 0,
      last: tx.date,
    };
    entry.count += 1;
    if (tx.date > entry.last) entry.last = tx.date;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, 6)
    .map((e) => e.pick);
}

function lastCategory(state: State, kind: Kind, mandatory: boolean): string | null {
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const tx = state.transactions[i];
    if (tx.type === kind && !tx.templateId && !tx.loanId && (kind === "income" || Boolean(tx.mandatory) === mandatory)) {
      return tx.category;
    }
  }
  return null;
}

export function TransactionSheet({
  txId,
  preset,
}: {
  txId?: string;
  preset?: { type?: Kind; mandatory?: boolean; date?: IsoDate };
}) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const deleteTx = useDeleteTransaction();
  const toast = useToast();
  const existing = txId ? state.transactions.find((t) => t.id === txId) : undefined;
  const editing = Boolean(existing);
  const template = existing?.templateId ? state.templates.find((t) => t.id === existing.templateId) : undefined;

  const [kind, setKind] = useState<Kind>(
    existing?.type === "income" || existing?.type === "expense" ? existing.type : (preset?.type ?? "expense"),
  );
  const [mandatory, setMandatory] = useState(existing ? Boolean(existing.mandatory) : (preset?.mandatory ?? false));
  const initialGroup = kind === "income" ? "income" : mandatory ? "mandatory" : "flexible";
  const [category, setCategory] = useState(
    () => existing?.category ?? lastCategory(state, kind, mandatory) ?? state.categories[initialGroup][0] ?? "",
  );
  const [amount, setAmount] = useState<Kopecks | null>(existing?.amount ?? null);
  const [title, setTitle] = useState(existing?.title ?? "");
  const [date, setDate] = useState<IsoDate>(existing?.date ?? preset?.date ?? today);
  const [autoSavingTouched, setAutoSavingTouched] = useState(false);
  const [autoSavingChoice, setAutoSavingChoice] = useState(existing?.autoSaving ?? false);
  const [repeat, setRepeat] = useState(false);
  /** Какой вид расхода был до включения повтора — вернём его, если повтор выключат. */
  const [mandatoryBeforeRepeat, setMandatoryBeforeRepeat] = useState(mandatory);
  const [errors, setErrors] = useState<{ amount?: string; category?: string; date?: string }>({});
  // Исходные значения формы — чтобы понять, есть ли несохранённые изменения.
  const [initial] = useState(() => ({ kind, mandatory, category, amount, title, date }));
  const dirty =
    kind !== initial.kind ||
    mandatory !== initial.mandatory ||
    category !== initial.category ||
    amount !== initial.amount ||
    title !== initial.title ||
    date !== initial.date ||
    autoSavingTouched ||
    repeat;
  // Регулярный расход всегда обязательный (так он попадает в план месяца) — показываем это в форме сразу.
  const mandatoryLocked = repeat && kind === "expense";
  const group = kind === "income" ? "income" : mandatory ? "mandatory" : "flexible";

  const picks = useMemo(() => (editing || kind !== "expense" ? [] : quickPicks(state, today)), [editing, kind, state, today]);

  // Пока человек сам не трогал переключатель, он следует настройкам и категории.
  const autoSaving = autoSavingTouched || editing
    ? autoSavingChoice
    : autoSavingByDefault({ type: kind, amount: amount ?? 0, category }, state.settings);
  const autoSavingPreview = autoSavingAmount(
    { type: kind, amount: amount ?? 0, category, autoSaving: true },
    state.settings,
  );
  const autoSavingAvailable = autoSavingPreview > 0 || (editing && Boolean(existing?.autoSaving));

  const switchKind = (next: Kind) => {
    setKind(next);
    // Расход с повтором — сразу обязательный.
    const nextMandatory = next === "expense" && repeat ? true : mandatory;
    if (nextMandatory !== mandatory) setMandatory(nextMandatory);
    const nextGroup = next === "income" ? "income" : nextMandatory ? "mandatory" : "flexible";
    if (!state.categories[nextGroup].includes(category)) {
      setCategory(lastCategory(state, next, nextMandatory) ?? state.categories[nextGroup][0] ?? "");
    }
  };
  const switchMandatory = (next: boolean) => {
    setMandatory(next);
    const nextGroup = next ? "mandatory" : "flexible";
    if (!state.categories[nextGroup].includes(category)) {
      setCategory(lastCategory(state, "expense", next) ?? state.categories[nextGroup][0] ?? "");
    }
  };
  const switchRepeat = (next: boolean) => {
    setRepeat(next);
    if (kind !== "expense") return;
    if (next) {
      setMandatoryBeforeRepeat(mandatory);
      if (!mandatory) switchMandatory(true);
    } else if (mandatoryBeforeRepeat !== mandatory) {
      switchMandatory(mandatoryBeforeRepeat);
    }
  };
  const repeatDay = isValidIsoDate(date) ? Number(date.slice(8)) : null;
  // Регулярный платёж начинает работать с сегодняшнего дня: если между датой операции и сегодня
  // были ещё платёжные дни, задним числом они не появятся.
  const repeatSkipsPast =
    repeatDay !== null && occurrenceDate({ dayOfMonth: repeatDay }, addMonths(monthKeyOf(date), 1)) < today;

  const save = () => {
    const nextErrors: typeof errors = {};
    if (!amount || amount <= 0) nextErrors.amount = "Введите сумму";
    if (!category.trim()) nextErrors.category = "Выберите категорию";
    if (!isValidIsoDate(date)) nextErrors.date = "Укажите дату";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length || !amount) return;

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
            ...(repeat ? { repeat: { templateId: newId(), startDate: date > today ? date : today } } : {}),
          },
        });
    if (!ok) return;
    close();
    if (!existing) toast(kind === "income" ? "Доход добавлен" : "Расход добавлен");
  };

  const readOnly = existing && existing.type !== "income" && existing.type !== "expense";

  if (readOnly && existing) return <ReadOnlyTransaction tx={existing} />;

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={editing ? "Операция" : kind === "income" ? "Новый доход" : "Новый расход"}
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
            {editing ? "Сохранить" : "Добавить"}
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
        <Segmented
          label="Тип операции"
          value={kind}
          onChange={switchKind}
          options={[
            { value: "expense", label: "Расход" },
            { value: "income", label: "Доход" },
          ]}
        />

        <AmountInput label="Сумма" value={amount} onChange={setAmount} error={errors.amount} autoFocus={!editing} />

        {picks.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-sm font-medium text-muted">Часто</p>
            <div className="flex gap-2 overflow-x-auto pb-1">
              {picks.map((p) => (
                <button
                  key={`${p.category}|${p.title}|${p.amount}`}
                  type="button"
                  onClick={() => {
                    setAmount(p.amount);
                    setCategory(p.category);
                    setTitle(p.title);
                    setMandatory(p.mandatory || mandatoryLocked);
                  }}
                  className="shrink-0 rounded-2xl border border-border bg-surface-2 px-3 py-1.5 text-left text-sm hover:border-accent"
                >
                  <span className="block font-medium">{p.title || p.category}</span>
                  <span className="text-muted">{formatMoney(p.amount)}</span>
                </button>
              ))}
            </div>
          </div>
        )}

        {kind === "expense" && (
          <div className="space-y-1.5">
            <Segmented
              label="Вид расхода"
              size="sm"
              value={mandatory ? "mandatory" : "flexible"}
              onChange={(v) => switchMandatory(v === "mandatory")}
              disabled={mandatoryLocked}
              options={[
                { value: "flexible", label: "Повседневный" },
                { value: "mandatory", label: "Обязательный" },
              ]}
            />
            <p className="text-xs text-muted">
              {mandatoryLocked
                ? "Регулярные расходы считаются обязательными"
                : mandatory
                  ? "Аренда, кредиты, связь, крупные покупки — заранее вычитаются из бюджета месяца"
                  : "Еда, транспорт, кафе — тратится из гибкого бюджета"}
            </p>
          </div>
        )}

        <CategoryPicker
          label="Категория"
          showValue
          categories={state.categories[group]}
          value={category}
          onChange={setCategory}
          error={errors.category}
        />

        <TextInput
          label="Описание"
          placeholder="Необязательно"
          value={title}
          maxLength={80}
          onChange={(e) => setTitle(e.target.value)}
        />

        <div className="space-y-2">
          <DateInput label="Дата" value={date} onChange={(e) => setDate(e.target.value)} error={errors.date} />
          <div className="flex gap-2">
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
            {date > today && <span className="self-center text-sm text-muted">Запланировано на {formatDay(date)}</span>}
          </div>
        </div>

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

        {!editing && (
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
