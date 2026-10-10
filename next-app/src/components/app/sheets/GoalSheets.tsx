"use client";

import { useState } from "react";
import { diffDays, formatDay, isValidIsoDate, parseIsoDate, type IsoDate } from "@/domain/dates";
import { activeAccounts } from "@/domain/accounts";
import { dedicatedGoalAccount, goalAvailable, goalSaved } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import { LIMITS, type Goal, type State } from "@/domain/schema";
import { plural } from "@/domain/text";
import { newId, useSnapshot, useToday } from "@/client/react";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { Money, Progress, Segmented } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { DateInput, TextArea, TextInput } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";

// ---------- темп накопления (общий для экрана целей и форм) ----------

export interface GoalPace {
  saved: Kopecks;
  remaining: Kopecks;
  /** Процент накопленного, округлённый вниз: 99,6% — ещё не 100%. */
  percent: number;
  status: "reached" | "no-date" | "overdue" | "on-track";
  /** Дней до срока (для overdue — отрицательное). */
  daysLeft: number;
  /** Сколько откладывать в месяц, чтобы успеть к сроку (вверх до целых рублей). */
  perMonth: Kopecks;
}

/** Календарных месяцев до срока с округлением вверх: с 9 октября до 31 декабря — 3. */
function monthsUntil(today: IsoDate, due: IsoDate): number {
  const a = parseIsoDate(today);
  const b = parseIsoDate(due);
  return Math.max(1, (b.year - a.year) * 12 + (b.month - a.month) + (b.day > a.day ? 1 : 0));
}

export function goalPace(target: Kopecks, saved: Kopecks, dueDate: IsoDate | null, today: IsoDate): GoalPace {
  const remaining = Math.max(0, target - saved);
  const percent = target > 0 ? Math.floor((Math.max(0, saved) * 100) / target) : 0;
  const base = { saved, remaining, percent, daysLeft: 0, perMonth: 0 };
  if (remaining === 0) return { ...base, status: "reached" };
  if (!dueDate) return { ...base, status: "no-date" };
  const daysLeft = diffDays(today, dueDate);
  if (daysLeft < 0) return { ...base, status: "overdue", daysLeft };
  const perMonth = Math.ceil(remaining / monthsUntil(today, dueDate) / 100) * 100;
  return { ...base, status: "on-track", daysLeft, perMonth };
}

const DAY_FORMS = ["день", "дня", "дней"] as const;
const MONTH_FORMS = ["месяц", "месяца", "месяцев"] as const;

/** «остался 1 день», «осталось 2 дня», «осталось 5 месяцев». */
function leftText(n: number, forms: readonly [string, string, string]): string {
  return `${plural(n, ["остался", "осталось", "осталось"])} ${n} ${plural(n, forms)}`;
}

/** «осталось 3 дня» — для сроков в днях. */
export function daysLeftText(days: number): string {
  return leftText(days, DAY_FORMS);
}

/** «До 31 декабря · осталось 3 месяца» */
export function goalDueText(dueDate: IsoDate | null, today: IsoDate): string {
  if (!dueDate) return "Без срока";
  const days = diffDays(today, dueDate);
  const day = formatDay(dueDate, today);
  if (days < 0) return `Срок был ${day}`;
  if (days === 0) return "Срок — сегодня";
  if (days <= 31) return `До ${day} · ${daysLeftText(days)}`;
  return `До ${day} · ${leftText(monthsUntil(today, dueDate), MONTH_FORMS)}`;
}

/**
 * Сколько можно снять с цели: только то, что откладывали в приложении (накопленное до приложения
 * не лежит в сбережениях, поэтому его не снять), а у цели со своим счётом — остаток счёта.
 */
export function goalWithdrawable(state: State, goal: Goal): Kopecks {
  return Math.max(0, goalAvailable(state, goal));
}

/** Подсказка, сколько ещё откладывать; null — цель достигнута. */
export function goalAdvice(pace: GoalPace): string | null {
  switch (pace.status) {
    case "reached":
      return null;
    case "no-date":
      return `Осталось накопить ${formatMoney(pace.remaining)}`;
    case "overdue":
      return `Срок прошёл, не хватает ${formatMoney(pace.remaining)}. Перенесите срок или пополните цель.`;
    case "on-track":
      return pace.daysLeft <= 31
        ? `До срока нужно отложить ещё ${formatMoney(pace.remaining)}`
        : `Откладывайте по ${formatMoney(pace.perMonth)} в месяц`;
  }
}

export const GOAL_REACHED_TEXT = "Цель достигнута 🎉";

// ---------- создание и редактирование цели ----------

type GoalErrors = { name?: string; target?: string; dueDate?: string };

export function GoalSheet({ goalId }: { goalId?: string }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const confirm = useConfirm();
  const toast = useToast();
  const existing = goalId ? state.goals.find((g) => g.id === goalId) : undefined;

  // Значения на момент открытия: с ними сравниваем, есть ли несохранённые изменения.
  const [start] = useState(() => ({
    name: existing?.name ?? "",
    target: existing?.targetAmount ?? null,
    initial: existing && existing.initialAmount > 0 ? existing.initialAmount : null,
    dueDate: existing?.dueDate ?? "",
    note: existing?.note ?? "",
    accountId: existing?.accountId ?? null,
  }));
  const [name, setName] = useState(start.name);
  const [target, setTarget] = useState<Kopecks | null>(start.target);
  const [initial, setInitial] = useState<Kopecks | null>(start.initial);
  const [dueDate, setDueDate] = useState<string>(start.dueDate);
  const [note, setNote] = useState(start.note);
  // Счёт цели: пополнения этого счёта — пополнения цели (и наоборот).
  const [accountId, setAccountId] = useState<string | null>(start.accountId);
  const savingsAccounts = activeAccounts(state).filter((a) => a.kind === "savings");
  const [errors, setErrors] = useState<GoalErrors>({});

  // Цель удалили (например, на другом устройстве) — окно закрывается, а не превращается в форму создания.
  if (goalId && !existing) return null;

  const dirty =
    name !== start.name ||
    target !== start.target ||
    initial !== start.initial ||
    dueDate !== start.dueDate ||
    note !== start.note ||
    accountId !== start.accountId;
  const clearError = (key: keyof GoalErrors) => setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  const draftGoal = existing
    ? { ...existing, initialAmount: initial ?? 0, ...(accountId ? { accountId } : { accountId: undefined }) }
    : null;
  const saved = draftGoal ? goalSaved(state, draftGoal) : (initial ?? 0);
  // Со своим счётом накоплено — остаток счёта: отдельная сумма «до приложения» не нужна.
  const sharedAccount = accountId !== null && state.goals.some((g) => g.id !== existing?.id && g.accountId === accountId);
  const followsAccount = accountId !== null && !sharedAccount;
  const pace = target ? goalPace(target, saved, isValidIsoDate(dueDate) ? dueDate : null, today) : null;

  const save = () => {
    const next: GoalErrors = {};
    if (!name.trim()) next.name = "Введите название";
    if (!target || target <= 0) next.target = "Введите сумму";
    if (dueDate && !isValidIsoDate(dueDate)) next.dueDate = "Укажите дату или выберите «Без срока»";
    setErrors(next);
    if (Object.keys(next).length || !target) return;

    const fields = {
      name: name.trim(),
      targetAmount: target,
      initialAmount: followsAccount ? 0 : (initial ?? 0),
      dueDate: dueDate || null,
      note: note.trim(),
    };
    if (!existing && goalId) return;
    const ok = existing
      ? dispatch({ type: "goal.update", id: existing.id, patch: { ...fields, accountId } })
      : dispatch({ type: "goal.add", goal: { id: newId(), ...fields, createdAt: today, ...(accountId ? { accountId } : {}) } });
    if (ok) close();
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `Удалить цель «${existing.name}»?`,
      message: "Накопленные на цель деньги останутся в общих сбережениях, операции — в истории.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    close();
    if (dispatch({ type: "goal.delete", id: existing.id })) toast("Цель удалена");
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={existing ? existing.name : "Новая цель"}
      footer={
        <div className="flex gap-2">
          {existing && (
            <Button variant="secondary" icon="trash" onClick={remove}>
              Удалить
            </Button>
          )}
          <Button className="flex-1" onClick={save}>
            {existing ? "Сохранить" : "Создать цель"}
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
        <TextInput
          label="Название"
          placeholder="Например, отпуск или подушка безопасности"
          value={name}
          maxLength={LIMITS.title}
          error={errors.name}
          data-autofocus={!existing || undefined}
          onChange={(e) => {
            setName(e.target.value);
            clearError("name");
          }}
        />
        <AmountInput
          label="Сколько нужно"
          value={target}
          error={errors.target}
          onChange={(v) => {
            setTarget(v);
            clearError("target");
          }}
        />
        {savingsAccounts.length > 0 && (
          <fieldset className="space-y-2">
            <legend className="mb-1.5 text-sm font-medium text-muted">Счёт цели</legend>
            <div className="flex flex-wrap gap-2">
              {[null, ...savingsAccounts.map((a) => a.id)].map((id) => {
                const selected = accountId === id;
                return (
                  <button
                    key={id ?? "none"}
                    type="button"
                    aria-pressed={selected}
                    onClick={() => setAccountId(id)}
                    className={`h-10 rounded-full border px-3.5 text-sm transition ${
                      selected ? "sheen border-accent-fill bg-accent-fill text-on-accent" : "glass-control"
                    }`}
                  >
                    {id ? (savingsAccounts.find((a) => a.id === id)?.name ?? "Счёт") : "Без счёта"}
                  </button>
                );
              })}
            </div>
            <p className="text-sm text-muted">
              {accountId === null
                ? "Пополнения цели идут в «Сбережения»."
                : followsAccount
                  ? "Накоплено на цель — остаток этого счёта: пополнили счёт (переводом, из СМС) — пополнилась цель."
                  : "Счёт есть и у другой цели — накопленное делится по пополнениям с отметкой цели."}
            </p>
          </fieldset>
        )}
        {!followsAccount && (
          <AmountInput
            label="Уже накоплено до приложения"
            placeholder="Необязательно"
            value={initial}
            onChange={setInitial}
            hint="Если копили на эту цель раньше. Сумма засчитается в прогресс цели, но не в остаток на счёте и не в сбережения — поэтому снять её через приложение нельзя."
          />
        )}
        <div className="space-y-2">
          <DateInput
            label="Срок"
            value={dueDate}
            error={errors.dueDate}
            hint="Необязательно. Со сроком приложение подскажет, сколько откладывать в месяц."
            onChange={(e) => {
              setDueDate(e.target.value);
              clearError("dueDate");
            }}
          />
          <button
            type="button"
            aria-pressed={!dueDate}
            onClick={() => {
              setDueDate("");
              clearError("dueDate");
            }}
            className={`h-10 rounded-full px-4 text-sm ${!dueDate ? "bg-accent-soft font-medium text-accent" : "bg-surface-2 text-muted hover:text-text"}`}
          >
            Без срока
          </button>
        </div>
        <TextArea
          label="Заметка"
          placeholder="Необязательно"
          value={note}
          maxLength={LIMITS.note}
          onChange={(e) => setNote(e.target.value)}
        />

        {pace && (
          <div className="rounded-2xl bg-surface-2 px-4 py-3 text-sm">
            {existing && (
              <p className="text-muted">
                Накоплено {formatMoney(pace.saved)} из {formatMoney(target ?? 0)} · {pace.percent}%
              </p>
            )}
            <p className={pace.status === "reached" ? "font-medium text-positive" : "font-medium"}>
              {pace.status === "reached" ? GOAL_REACHED_TEXT : goalAdvice(pace)}
            </p>
          </div>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

// ---------- пополнение и снятие ----------

export function GoalMoneySheet({ goalId, direction }: { goalId: string; direction: "in" | "out" }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const goal = state.goals.find((g) => g.id === goalId);
  const [dir, setDir] = useState(direction);
  const [amount, setAmount] = useState<Kopecks | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);

  // Цель удалили (например, на другом устройстве) — окно закрывается.
  if (!goal) return null;

  const saved = goalSaved(state, goal);
  const shown = Math.max(0, saved);
  // Снять можно только отложенное в приложении: накопленное до него не лежит в сбережениях.
  const available = goalWithdrawable(state, goal);
  const notCounted =
    goal.initialAmount > 0 && !dedicatedGoalAccount(state, goal) ? " — накопленное до приложения здесь не учитывается" : "";
  const remaining = Math.max(0, goal.targetAmount - saved);
  const reached = remaining === 0;
  const percent = Math.floor((shown * 100) / goal.targetAmount);
  const nothingToWithdraw = dir === "out" && available === 0;
  // Как в общих сбережениях: про превышение говорим сразу, а не после нажатия «Снять».
  const overLimit = dir === "out" && available > 0 && amount !== null && amount > available;
  const limitError = overLimit ? `Можно снять не больше ${formatMoney(available)}${notCounted}` : null;
  const dirty = amount !== null || note.trim() !== "";
  const quick =
    dir === "in"
      ? remaining > 0 && { label: `До цели — ${formatMoney(remaining)}`, value: remaining }
      : available > 0 && { label: `Всё — ${formatMoney(available)}`, value: available };

  const save = () => {
    if (nothingToWithdraw) {
      setError(`Снимать пока нечего${notCounted}`);
      return;
    }
    if (!amount) {
      setError("Введите сумму");
      return;
    }
    if (overLimit) return;
    const ok = dispatch({
      type: "savings.move",
      id: newId(),
      date: today,
      amount: dir === "in" ? amount : -amount,
      note: note.trim(),
      goalId: goal.id,
    });
    if (ok) {
      toast(
        dir === "in"
          ? `Отложено ${formatMoney(amount)} на «${goal.name}»`
          : `Снято ${formatMoney(amount)} с цели «${goal.name}»`,
      );
      close();
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={goal.name}
      footer={
        <Button className="w-full" disabled={nothingToWithdraw || overLimit} onClick={save}>
          {dir === "in" ? "Пополнить" : "Снять"}
        </Button>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="rounded-2xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-muted">Накоплено</p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <Money value={saved} className="text-2xl font-semibold" />
            <span className="text-sm text-muted">
              из {formatMoney(goal.targetAmount)} · {percent}%
            </span>
          </p>
          <div className="mt-2">
            <Progress value={shown} max={goal.targetAmount} tone={reached ? "positive" : "accent"} label="Накоплено на цель" />
          </div>
          {reached && <p className="mt-2 text-sm font-medium text-positive">{GOAL_REACHED_TEXT}</p>}
        </div>

        <Segmented
          label="Действие"
          value={dir}
          onChange={(v) => {
            setDir(v);
            setError(null);
          }}
          options={[
            { value: "in", label: "Пополнить" },
            { value: "out", label: "Снять" },
          ]}
        />

        <div className="space-y-2">
          <AmountInput
            label="Сумма"
            value={amount}
            autoFocus
            error={error ?? limitError}
            onChange={(v) => {
              setAmount(v);
              setError(null);
            }}
            hint={
              dir === "in"
                ? "Деньги уйдут со счёта в сбережения на эту цель"
                : available === 0
                  ? `Снимать пока нечего${notCounted}`
                  : notCounted
                    ? `Деньги вернутся из сбережений на счёт. Можно снять до ${formatMoney(available)}${notCounted}`
                    : "Деньги вернутся из сбережений на счёт"
            }
          />
          {quick && (
            <button
              type="button"
              aria-pressed={amount === quick.value}
              onClick={() => {
                setAmount(quick.value);
                setError(null);
              }}
              className={`h-10 rounded-full px-4 text-sm ${amount === quick.value ? "bg-accent-soft font-medium text-accent" : "bg-surface-2 text-muted hover:text-text"}`}
            >
              {quick.label}
            </button>
          )}
        </div>

        <TextInput
          label="Комментарий"
          placeholder="Необязательно"
          value={note}
          maxLength={LIMITS.note}
          onChange={(e) => setNote(e.target.value)}
        />
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
