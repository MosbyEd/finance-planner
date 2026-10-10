"use client";

import { useState, type ReactNode } from "react";
import { formatDay, isValidIsoDate, type IsoDate } from "@/domain/dates";
import { loanInterest, loanOpening, loanRemaining } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import { LIMITS, type LoanKind } from "@/domain/schema";
import { newId, useSnapshot, useToday } from "@/client/react";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { Money, Progress, Segmented, Switch } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { DateInput, TextArea, TextInput } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { useDispatch } from "../hooks";
import { InterestNotes } from "../InterestNotes";
import { useUi } from "../overlays";
import { CreditTermsFields, parseTerms, sameDraft, termsDraft, type TermsDraft } from "./CreditTermsFields";

/** Три варианта на 360 px едва помещаются: не даём подписи переноситься внутри кнопки. */
function oneLine(text: string): ReactNode {
  return <span className="-mx-2 whitespace-nowrap">{text}</span>;
}

const KIND_OPTIONS: { value: LoanKind; label: ReactNode }[] = [
  { value: "borrow", label: oneLine("Мой долг") },
  { value: "credit", label: oneLine("Кредит") },
  { value: "lend", label: oneLine("Мне должны") },
];

const COPY: Record<LoanKind, { name: string; placeholder: string; paid: string; due: string }> = {
  borrow: { name: "У кого заняли", placeholder: "Например, Аня", paid: "Уже погашено", due: "Вернуть до" },
  credit: { name: "Название", placeholder: "Например, кредит на машину", paid: "Уже погашено", due: "Погасить до" },
  lend: { name: "Кому одолжили", placeholder: "Например, Саша", paid: "Уже вернули", due: "Вернуть до" },
};

type LoanErrors = { name?: string; amount?: string; paid?: string; dueDate?: string; terms?: string; cash?: string; takenAt?: string };

export function LoanSheet({ loanId }: { loanId?: string }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const confirm = useConfirm();
  const toast = useToast();
  const existing = loanId ? state.loans.find((l) => l.id === loanId) : undefined;

  // Значения на момент открытия: с ними сравниваем, есть ли несохранённые изменения.
  const [start] = useState(() => ({
    kind: existing?.kind ?? ("borrow" as LoanKind),
    name: existing?.name ?? "",
    amount: existing?.amount ?? null,
    paid: existing && existing.initialPaid > 0 ? existing.initialPaid : null,
    dueDate: existing?.dueDate ?? "",
    note: existing?.note ?? "",
    withTerms: Boolean(existing?.terms),
    terms: termsDraft(existing?.terms),
    cash: existing?.cashAmount ?? null,
    takenAt: existing?.takenAt ?? existing?.createdAt ?? today,
  }));
  const [kind, setKind] = useState<LoanKind>(start.kind);
  const [name, setName] = useState(start.name);
  const [amount, setAmount] = useState<Kopecks | null>(start.amount);
  const [paid, setPaid] = useState<Kopecks | null>(start.paid);
  const [dueDate, setDueDate] = useState<string>(start.dueDate);
  const [note, setNote] = useState(start.note);
  // Проценты и беспроцентный период (мой долг или кредит): условия, доля снятия наличных, когда возник долг.
  const [withTerms, setWithTerms] = useState(start.withTerms);
  const [terms, setTerms] = useState<TermsDraft>(start.terms);
  const [cash, setCash] = useState<Kopecks | null>(start.cash);
  const [takenAt, setTakenAt] = useState<string>(start.takenAt);
  // Только для нового долга: деньги пришли на счёт (или ушли с него) прямо сейчас.
  const [cashFlow, setCashFlow] = useState(false);
  const [errors, setErrors] = useState<LoanErrors>({});

  // Долг удалили (например, на другом устройстве) — окно закрывается, а не превращается в форму создания.
  if (loanId && !existing) return null;

  const dirty =
    kind !== start.kind ||
    name !== start.name ||
    amount !== start.amount ||
    paid !== start.paid ||
    dueDate !== start.dueDate ||
    note !== start.note ||
    withTerms !== start.withTerms ||
    !sameDraft(terms, start.terms) ||
    cash !== start.cash ||
    takenAt !== start.takenAt ||
    cashFlow;
  const copy = COPY[kind];
  const clearError = (key: keyof LoanErrors) => setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));
  const remaining = existing ? loanRemaining(state, existing) : null;
  const interest = existing && remaining ? loanInterest(state, existing, today) : null;

  const save = () => {
    const next: LoanErrors = {};
    if (!name.trim()) next.name = "Введите имя или название";
    if (!amount || amount <= 0) next.amount = "Введите сумму";
    if (amount && paid !== null && paid > amount) next.paid = "Не больше суммы долга";
    if (dueDate && !isValidIsoDate(dueDate)) next.dueDate = "Укажите дату или выберите «Без срока»";
    const charged = kind !== "lend" && withTerms;
    const parsed = parseTerms(terms);
    if (charged) {
      if (parsed.error) next.terms = parsed.error;
      else if (!parsed.terms) next.terms = "Укажите ставку или беспроцентный период";
      if (amount && cash !== null && cash > amount) next.cash = "Не больше суммы долга";
      if (!isValidIsoDate(takenAt)) next.takenAt = "Укажите дату";
    }
    setErrors(next);
    if (Object.keys(next).length || !amount) return;

    const fields = {
      kind,
      name: name.trim(),
      amount,
      initialPaid: paid ?? 0,
      dueDate: dueDate || null,
      note: note.trim(),
    };
    const extra = {
      terms: charged ? parsed.terms : null,
      cashAmount: charged && cash ? cash : null,
      takenAt: charged && takenAt ? takenAt : null,
    };
    if (!existing && loanId) return;
    const ok = existing
      ? dispatch({ type: "loan.update", id: existing.id, patch: { ...fields, ...extra } })
      : dispatch({
          type: "loan.add",
          loan: {
            id: newId(),
            ...fields,
            createdAt: today,
            ...(extra.terms ? { terms: extra.terms } : {}),
            ...(extra.cashAmount ? { cashAmount: extra.cashAmount } : {}),
            ...(extra.takenAt ? { takenAt: extra.takenAt } : {}),
          },
          ...(cashFlow ? { cashFlow: { id: newId(), date: today } } : {}),
        });
    if (ok) close();
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `Удалить долг «${existing.name}»?`,
      message: "Платежи по долгу останутся в истории.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    close();
    if (dispatch({ type: "loan.delete", id: existing.id })) toast("Долг удалён");
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={existing ? existing.name : "Новый долг"}
      footer={
        <div className="flex gap-2">
          {existing && (
            <Button variant="secondary" icon="trash" onClick={remove}>
              Удалить
            </Button>
          )}
          <Button className="flex-1" onClick={save}>
            {existing ? "Сохранить" : "Добавить"}
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
        <Segmented label="Вид долга" value={kind} onChange={setKind} options={KIND_OPTIONS} />

        {existing && remaining !== null && (
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <p className="text-sm">
              Осталось <Money value={remaining} className="font-semibold" /> из {formatMoney(existing.amount)}
            </p>
            {interest && <InterestNotes summary={interest} className="mt-1" />}
          </div>
        )}

        <TextInput
          label={copy.name}
          placeholder={copy.placeholder}
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
          label="Сумма долга"
          value={amount}
          error={errors.amount}
          onChange={(v) => {
            setAmount(v);
            clearError("amount");
            clearError("paid");
          }}
        />
        {!existing && (
          <Switch
            checked={cashFlow}
            onChange={setCashFlow}
            label="Деньги прошли через мой счёт"
            description={
              !cashFlow
                ? "Выключено — запись долга не изменит остаток на счёте"
                : kind === "lend"
                  ? "Остаток на счёте уменьшится на сумму долга, бюджет месяца не изменится"
                  : "Остаток на счёте увеличится на сумму долга, бюджет месяца не изменится"
            }
          />
        )}
        <AmountInput
          label={copy.paid}
          placeholder="Необязательно"
          value={paid}
          error={errors.paid}
          hint="Сколько вернули до начала учёта. В историю и остаток на счёте не попадёт."
          onChange={(v) => {
            setPaid(v);
            clearError("paid");
          }}
        />
        <div className="space-y-2">
          <DateInput
            label={copy.due}
            value={dueDate}
            error={errors.dueDate}
            hint="Необязательно"
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
        {kind !== "lend" && (
          <Switch
            checked={withTerms}
            onChange={setWithTerms}
            label="Есть проценты"
            description="Ставка и беспроцентный период — отдельно для покупок и для снятия наличных. Приложение оценит, сколько начислят, если не погасить вовремя."
          />
        )}
        {kind !== "lend" && withTerms && (
          <>
            <DateInput
              label="Когда возник долг"
              value={takenAt}
              error={errors.takenAt}
              hint="С этого дня идёт беспроцентный период"
              onChange={(e) => {
                setTakenAt(e.target.value);
                clearError("takenAt");
              }}
            />
            <AmountInput
              label="Из них снятие наличных и переводы"
              placeholder="Необязательно"
              value={cash}
              error={errors.cash}
              hint="Остальное — покупки"
              onChange={(v) => {
                setCash(v);
                clearError("cash");
              }}
            />
            <CreditTermsFields
              value={terms}
              onChange={(next) => {
                setTerms(next);
                clearError("terms");
              }}
              error={errors.terms}
              hint="Не погасили к концу беспроцентного периода — проценты за все дни с начала долга (оценка). Пусто — периода нет. Платежи гасят сначала наличные."
            />
          </>
        )}
        <TextArea
          label="Заметка"
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

type PaymentErrors = { amount?: string; date?: string };

export function LoanPaymentSheet({ loanId }: { loanId: string }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const loan = state.loans.find((l) => l.id === loanId);
  const [amount, setAmount] = useState<Kopecks | null>(null);
  const [date, setDate] = useState<IsoDate>(today);
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<PaymentErrors>({});

  // Долг удалили (например, на другом устройстве) — окно закрывается.
  if (!loan) return null;

  const remaining = loanRemaining(state, loan);
  const isReturn = loan.kind === "lend";
  // Деньги долга прошли через счёт (есть корректировка открытия) — платёж тоже пойдёт корректировкой, мимо бюджета.
  const viaAccount = loanOpening(state, loan) !== undefined;
  const amountHint = viaAccount
    ? isReturn
      ? "Деньги вернутся на счёт, бюджет месяца не изменится"
      : "Деньги спишутся со счёта, бюджет месяца не изменится"
    : isReturn
      ? "Возврат запишется как доход"
      : "Платёж запишется как обязательный расход";
  const dirty = amount !== null || date !== today || note.trim() !== "";
  const clearError = (key: keyof PaymentErrors) => setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));

  const save = () => {
    const next: PaymentErrors = {};
    if (!amount || amount <= 0) next.amount = "Введите сумму";
    else if (amount > remaining) next.amount = `Не больше остатка — ${formatMoney(remaining)}`;
    if (!isValidIsoDate(date)) next.date = "Укажите дату";
    setErrors(next);
    if (Object.keys(next).length || !amount) return;

    if (dispatch({ type: "loan.payment", id: newId(), loanId: loan.id, amount, date, note: note.trim() })) {
      toast(
        amount === remaining
          ? isReturn
            ? "Долг вернули полностью"
            : "Долг погашен полностью"
          : `${isReturn ? "Записан возврат" : "Записан платёж"} ${formatMoney(amount)}`,
      );
      close();
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={remaining > 0 && dirty}
      title={isReturn ? "Возврат долга" : "Платёж по долгу"}
      footer={
        remaining > 0 ? (
          <Button className="w-full" onClick={save}>
            {isReturn ? "Записать возврат" : "Внести платёж"}
          </Button>
        ) : (
          <Button variant="secondary" className="w-full" onClick={close}>
            Закрыть
          </Button>
        )
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl bg-surface-2 px-4 py-3">
          <p className="truncate text-sm text-muted">{loan.name}</p>
          <p className="flex flex-wrap items-baseline gap-x-2">
            <Money value={remaining} className="text-2xl font-semibold" />
            <span className="text-sm text-muted">осталось из {formatMoney(loan.amount)}</span>
          </p>
          <div className="mt-2">
            <Progress
              value={loan.amount - remaining}
              max={loan.amount}
              tone="positive"
              label={isReturn ? "Сколько уже вернули" : "Сколько уже погашено"}
            />
          </div>
          {loan.dueDate && remaining > 0 && (
            <p className={`mt-2 text-sm ${loan.dueDate < today ? "font-medium text-negative" : "text-muted"}`}>
              {loan.dueDate < today ? "Просрочен: срок был " : "Срок — "}
              {formatDay(loan.dueDate, today)}
            </p>
          )}
        </div>

        {remaining > 0 ? (
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <div className="space-y-2">
              <AmountInput
                label="Сумма"
                value={amount}
                autoFocus
                error={errors.amount}
                hint={amountHint}
                onChange={(v) => {
                  setAmount(v);
                  clearError("amount");
                }}
              />
              <button
                type="button"
                aria-pressed={amount === remaining}
                onClick={() => {
                  setAmount(remaining);
                  clearError("amount");
                }}
                className={`h-10 rounded-full px-4 text-sm ${amount === remaining ? "bg-accent-soft font-medium text-accent" : "bg-surface-2 text-muted hover:text-text"}`}
              >
                Весь остаток — {formatMoney(remaining)}
              </button>
            </div>
            <DateInput
              label="Дата"
              value={date}
              error={errors.date}
              onChange={(e) => {
                setDate(e.target.value);
                clearError("date");
              }}
            />
            <TextInput
              label="Комментарий"
              placeholder="Необязательно"
              value={note}
              maxLength={LIMITS.note}
              onChange={(e) => setNote(e.target.value)}
            />
            <button type="submit" hidden />
          </form>
        ) : (
          <p className="text-[15px] text-muted">{isReturn ? "Вам уже вернули всю сумму." : "Долг уже погашен полностью."}</p>
        )}
      </div>
    </Sheet>
  );
}
