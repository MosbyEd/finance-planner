"use client";

import { useState } from "react";
import { formatDay, formatMonthIn, type MonthKey } from "@/domain/dates";
import { accountBalance, activeAccounts, findAccount, MAIN_ACCOUNT_ID, SAVINGS_ACCOUNT_ID } from "@/domain/accounts";
import { balanceAt, goalsReservedOn, payEventName, periodLeftView, safeToSpend, savingsTotal } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import { occurrenceDate } from "@/domain/recurring";
import { bankPiggyAccount, expectedToPiggy, pendingSavings } from "@/domain/savings";
import type { State } from "@/domain/schema";
import { plural } from "@/domain/text";
import { newId, useSnapshot, useToday } from "@/client/react";
import { storage } from "@/client/storage";
import { AccountPicker } from "../../ui/AccountPicker";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { Money, Segmented } from "../../ui/controls";
import { useToast } from "../../ui/feedback";
import { TextInput } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { hasOwnAccounts } from "../accounts";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";

/** Человек подтвердил остаток, совпавший с расчётным (корректировка не создаётся). */
export const BALANCE_CONFIRMED_KEY = "fp:onboarding-balance-confirmed";

/**
 * Сверка остатка: человек вводит, сколько реально на счёте, приложение добавляет корректировку.
 * Счетов несколько — сверяется выбранный; у кредитки вводится долг.
 */
export function BalanceSheet({ accountId: presetAccount }: { accountId?: string }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const multiple = hasOwnAccounts(state) || Boolean(presetAccount && presetAccount !== MAIN_ACCOUNT_ID);
  const [accountId, setAccountId] = useState(presetAccount ?? MAIN_ACCOUNT_ID);
  const account = findAccount(state, accountId);
  const isCredit = account?.kind === "credit";
  const computed = multiple ? accountBalance(state, accountId, today) : balanceAt(state, today);
  // Операций ещё нет — это не сверка, а стартовый остаток.
  const fresh = state.transactions.length === 0;
  // У кредитки человек вводит долг (положительное число), остаток счёта — минус долг.
  const [entered, setEntered] = useState<Kopecks | null>(null);
  const actual = entered === null ? null : isCredit ? -entered : entered;
  const [error, setError] = useState<string | null>(null);
  const delta = actual === null ? 0 : actual - computed;
  // На карте меньше, а с неё ожидаются отчисления в копилку банка — банк, похоже, уже перевёл: «Копилка банка».
  const piggyAccount = account && !fresh && delta < 0 ? bankPiggyAccount(state, account) : undefined;
  const expected = piggyAccount && account ? expectedToPiggy(state, account, today) : 0;
  const piggyRest = delta + expected;

  const saveAsPiggy = () => {
    if (actual === null) return;
    if (dispatch({ type: "balance.set", id: newId(), date: today, actual, piggy: true, ...(multiple ? { accountId } : {}) })) {
      toast("Копилка банка учтена");
      close();
    }
  };

  const save = () => {
    if (actual === null) {
      setError("Введите сумму");
      return;
    }
    if (delta === 0) {
      // Корректировка не нужна, но шаг «укажите остаток» в онбординге считаем выполненным.
      storage.set(BALANCE_CONFIRMED_KEY, "1");
      toast("Остаток совпадает");
      close();
      return;
    }
    if (dispatch({ type: "balance.set", id: newId(), date: today, actual, ...(multiple ? { accountId } : {}) })) {
      toast(
        isCredit
          ? `Долг по карте: ${formatMoney(-actual)}`
          : fresh
            ? `Стартовый остаток: ${formatMoney(actual)}`
            : `Остаток обновлён: ${formatMoney(actual)}`,
      );
      close();
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={actual !== null}
      title={isCredit ? "Сколько должны по карте?" : fresh ? "Сколько сейчас денег?" : "Сколько на счёте?"}
      footer={
        expected > 0 ? (
          <div className="grid grid-cols-2 gap-2">
            <Button variant="secondary" onClick={save}>
              Корректировка
            </Button>
            <Button onClick={saveAsPiggy}>Копилка банка</Button>
          </div>
        ) : (
          <Button className="w-full" onClick={save}>
            Сохранить
          </Button>
        )
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {multiple && (
          <AccountPicker
            label="Счёт"
            accounts={activeAccounts(state)}
            value={accountId}
            onChange={(id) => {
              setAccountId(id);
              setEntered(null);
            }}
          />
        )}
        {isCredit ? (
          <p className="text-[15px] text-muted">
            По операциям долг по карте сейчас <Money value={Math.max(0, -computed)} className="font-semibold text-text" />. Если в
            банке другая сумма — введите её.
          </p>
        ) : fresh ? (
          <p className="text-[15px] text-muted">
            Сколько сейчас денег на картах и наличными? Это будет стартовый остаток.
          </p>
        ) : (
          <p className="text-[15px] text-muted">
            По операциям в приложении сейчас <Money value={computed} className="font-semibold text-text" />. Если реальный
            остаток на картах и наличными другой — введите его, и приложение добавит корректировку.
          </p>
        )}
        <AmountInput
          key={accountId}
          label={isCredit ? "Долг по карте" : fresh ? "Остаток сейчас" : "Реальный остаток"}
          value={entered}
          onChange={(v) => {
            setEntered(v);
            setError(null);
          }}
          allowNegative={!isCredit}
          autoFocus
          error={error}
        />
        {!fresh && actual !== null && delta !== 0 && (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm">
            Корректировка: <Money value={delta} sign tone="auto" className="font-semibold" />. Она не влияет на бюджет
            месяца — только на остаток.
          </p>
        )}
        {expected > 0 && piggyAccount && (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm">
            С этой карты в «{piggyAccount.name}» ожидается {formatMoney(expected, { sign: true })}. Если банк уже перевёл их
            в копилку — «Копилка банка»: ожидаемое засчитаем переведённым
            {piggyRest < 0
              ? `, ещё ${formatMoney(-piggyRest)} — переводом в «${piggyAccount.name}».`
              : piggyRest > 0
                ? `, а ${formatMoney(piggyRest)} вернём из «${piggyAccount.name}» на карту.`
                : " — остаток сойдётся."}
          </p>
        )}
        {!fresh && actual !== null && delta === 0 && (
          <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm">Остаток совпадает с расчётным — менять нечего.</p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

/**
 * Автоотчисления, которые ещё копятся до порога «переводить, когда накопится»: «Ожидается +40 ₽ — переведём,
 * когда наберётся 100 ₽. Пока эти деньги на счёте». null — копить нечего.
 */
function expectedSavingsNote(state: State): string | null {
  const kinds = (["expense", "income"] as const).map((type) => pendingSavings(state, type)).filter((p) => p.total > 0);
  if (!kinds.length) return null;
  const total = kinds.reduce((sum, p) => sum + p.total, 0);
  const when = kinds.length === 1 ? `, когда наберётся ${formatMoney(kinds[0].threshold, { whole: true })}` : ", когда наберётся порог";
  return `Ожидается ${formatMoney(total, { sign: true })} автоотчислений — переведём${when}. Пока эти деньги на счёте.`;
}

/** Пополнение или снятие общих сбережений. */
export function SavingsSheet({ direction }: { direction: "in" | "out" }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const [dir, setDir] = useState(direction);
  const [amount, setAmount] = useState<Kopecks | null>(null);
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const total = savingsTotal(state, today);
  // Снимается со счёта «Сбережения»: доступно то, что на нём лежит, кроме денег целей (их снимают на вкладке «Цели»).
  const inGoals = goalsReservedOn(state, SAVINGS_ACCOUNT_ID);
  const available = Math.max(0, accountBalance(state, SAVINGS_ACCOUNT_ID, today) - inGoals);
  const expected = expectedSavingsNote(state);
  // Снять больше, чем свободно, нельзя — подсказываем сразу, а не после нажатия.
  const overLimit = dir === "out" && amount !== null && amount > available;
  const touchesGoals = dir === "out" && inGoals > 0;
  const limitError = overLimit
    ? available > 0
      ? `Можно снять не больше ${formatMoney(available)}`
      : inGoals > 0
        ? "Свободных сбережений нет — всё отложено на цели"
        : "В сбережениях пока ничего нет"
    : null;

  const save = () => {
    if (!amount) {
      setError("Введите сумму");
      return;
    }
    if (overLimit) return;
    const signed = dir === "in" ? amount : -amount;
    if (dispatch({ type: "savings.move", id: newId(), date: today, amount: signed, note: note.trim() })) {
      toast(dir === "in" ? `Отложено ${formatMoney(amount)}` : `Снято ${formatMoney(amount)}`);
      close();
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={amount !== null || note.trim() !== ""}
      title="Сбережения"
      footer={
        <Button className="w-full" onClick={save} disabled={overLimit}>
          {dir === "in" ? "Отложить" : "Снять"}
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
          <Money value={total} className="text-2xl font-semibold" />
          {inGoals > 0 && <p className="text-sm text-muted">из них на целях: {formatMoney(inGoals)}</p>}
          {expected && <p className="mt-1 text-sm text-muted">{expected}</p>}
        </div>
        <Segmented
          label="Направление"
          value={dir}
          onChange={(v) => {
            setDir(v);
            setError(null);
          }}
          options={[
            { value: "in", label: "Отложить" },
            { value: "out", label: "Снять" },
          ]}
        />
        <div className="space-y-2">
          <AmountInput
            label="Сумма"
            value={amount}
            onChange={(v) => {
              setAmount(v);
              setError(null);
            }}
            autoFocus
            error={error ?? limitError}
            hint={dir === "in" ? "Деньги уйдут со счёта в сбережения" : "Деньги вернутся из сбережений на счёт"}
          />
          {dir === "out" && available > 0 && amount !== available && (
            <button
              type="button"
              onClick={() => {
                setAmount(available);
                setError(null);
              }}
              className="h-10 rounded-full bg-surface-2 px-3.5 text-sm font-medium text-text hover:bg-surface-3"
            >
              Всё — {formatMoney(available)}
            </button>
          )}
          {touchesGoals && (
            <p className="rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted" role="status">
              Ещё {formatMoney(inGoals)} отложено на цели — их снимают на вкладке «Цели».
            </p>
          )}
        </div>
        <TextInput label="Комментарий" placeholder="Необязательно" value={note} maxLength={500} onChange={(e) => setNote(e.target.value)} />
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

/** Объяснение, откуда взялся дневной лимит. */
export function ExplainSheet() {
  const { state, aiEnabled } = useSnapshot();
  const { close, open } = useUi();
  const today = useToday();
  const sts = safeToSpend(state, today);
  // Бюджет — за период от зарплаты до зарплаты (или за месяц); показываем его же, а не календарный месяц.
  const { kind, current: m, next, after, missedPay } = sts.period;
  const cash = m.basis === "cash" ? m.cash : null;
  const leftView = periodLeftView(sts.period);
  const until = next ? `до ${payEventName(next)} ${formatDay(next.date)}` : "до конца месяца";
  // Без доходов в плане периода лимит считается только по деньгам на счёте (как в safeToSpend).
  const hasIncome = sts.usesBudget;
  const budgetBinding = hasIncome && sts.budgetPerDay <= sts.cashPerDay;
  const raw = hasIncome ? Math.min(sts.budgetPerDay, sts.cashPerDay) : sts.cashPerDay;
  const days = (n: number) => `${n} ${plural(n, ["день", "дня", "дней"])}`;

  return (
    <Sheet
      open
      onClose={close}
      title="Как считается лимит на день"
      footer={
        aiEnabled ? (
          <Button
            variant="soft"
            icon="sparkles"
            className="w-full"
            onClick={() =>
              open({
                kind: "ai",
                prompt: "Объясни мой лимит на сегодня и подскажи, как не выйти за бюджет до конца месяца.",
              })
            }
          >
            Спросить AI-помощника
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-4 text-[15px]">
        <p>
          {hasIncome
            ? `Берём меньшее из двух чисел — так денег хватит и на план ${kind === "pay" ? "периода" : "месяца"}, и на платежи до следующего дохода.`
            : `${kind === "pay" ? "В этом периоде" : "В этом месяце"} доходов в плане нет — считаем только по деньгам на счёте.`}
        </p>
        <p className="rounded-2xl bg-surface-2 px-4 py-3">
          Лимит на сегодня: <span className="font-semibold tabular-nums">{formatMoney(sts.recommended)}</span>
          <span className="mt-1 block text-sm text-muted">
            Потрачено сегодня {formatMoney(sts.spentToday)} —{" "}
            {sts.leftToday < 0 ? (
              <span className="font-medium text-negative">сверх лимита {formatMoney(-sts.leftToday)}</span>
            ) : (
              <>осталось {formatMoney(sts.leftToday)}</>
            )}
          </span>
          {raw < 0 && <span className="mt-1 block text-sm text-muted">Если получилось меньше нуля, лимит — 0 ₽.</span>}
        </p>

        <section className={`rounded-2xl p-4 ${budgetBinding ? "bg-accent-soft" : "bg-surface-2"}`}>
          <h3 className="font-semibold">
            {cash ? "По деньгам на период" : "По бюджету"} {kind === "pay" ? until : "месяца"}: {formatMoney(sts.budgetPerDay)} в день
          </h3>
          {kind === "pay" && (
            <p className="mt-1 text-sm text-muted">
              Период — с {formatDay(m.start)} {until}: от зарплаты до зарплаты.
              {missedPay && leftView.note && ` ${leftView.note}`}
            </p>
          )}
          {cash ? (
            <dl className="mt-2 space-y-1 text-sm">
              <Row label="Сейчас на счетах для трат" value={cash.now} />
              {cash.incoming > 0 && <Row label={`+ Поступления ${until}`} value={cash.incoming} />}
              <Row label={`− Платежи и запланированное ${until}`} value={cash.outgoing} />
              <Row label="= Осталось на период" value={m.flexible.left} strong />
              {m.flexible.spentToday > 0 && <Row label="+ Потрачено сегодня (входит в лимит дня)" value={m.flexible.spentToday} />}
            </dl>
          ) : (
            <dl className="mt-2 space-y-1 text-sm">
              <Row label={kind === "pay" ? "Доходы периода (с плановыми)" : "Доходы за месяц (с плановыми)"} value={m.income.plan} />
              <Row label="− Обязательные расходы" value={m.mandatory.plan} />
              <Row label={`− Норма сбережений (${state.settings.savingsRatePercent}%)`} value={m.savings.target} />
              <Row label="= Гибкий бюджет" value={m.flexible.budget} strong />
              <Row label="− Уже потрачено до сегодня" value={m.flexible.spent - m.flexible.spentToday} />
              {m.flexible.reserved > 0 && <Row label="− Запланированные траты" value={m.flexible.reserved} />}
              {m.flexible.extraSavings > 0 && <Row label="− Отложено сверх нормы" value={m.flexible.extraSavings} />}
            </dl>
          )}
          <p className="pt-1 text-sm text-muted">
            Делим на {days(m.daysLeft)} {until}, включая сегодня.
            {!hasIncome && " Без доходов в плане этот расчёт не учитывается."}
            {!cash &&
              m.flexible.extraSavings > 0 &&
              " «Отложено» — пополнения целей и автоотчисления с доходов и покупок; переводы на накопительные счета без цели сюда не входят."}
          </p>
          {after && next && (
            <p className="mt-2 border-t border-border pt-2 text-sm">
              После {payEventName(next)} {formatDay(next.date)}:{" "}
              <span className="font-semibold tabular-nums">≈ {formatMoney(Math.max(0, after.perDay))} в день</span>
              <span className="block text-muted">
                на {days(after.days)}: доходы {formatMoney(after.income.plan, { whole: true })} − обязательные{" "}
                {formatMoney(after.mandatory.plan, { whole: true })} − норма сбережений{" "}
                {formatMoney(after.savings.target, { whole: true })}
                {after.flexible.extraSavings > 0 ? ` − отложено сверх нормы ${formatMoney(after.flexible.extraSavings, { whole: true })}` : ""}
                {after.flexible.reserved > 0 ? ` − запланированные траты ${formatMoney(after.flexible.reserved, { whole: true })}` : ""}.
              </span>
            </p>
          )}
        </section>

        <section className={`rounded-2xl p-4 ${!budgetBinding ? "bg-accent-soft" : "bg-surface-2"}`}>
          <h3 className="font-semibold">По деньгам на счёте: {formatMoney(sts.cashPerDay)} в день</h3>
          <dl className="mt-2 space-y-1 text-sm">
            <Row label="Сейчас на счёте (до сегодняшних трат)" value={sts.cashNow} />
            <Row
              label={
                sts.horizon.reason === "income"
                  ? `− Платежи до «${sts.horizon.title}» ${formatDay(sts.horizon.date)}`
                  : "− Платежи до конца месяца"
              }
              value={sts.plannedOut}
            />
          </dl>
          <p className="pt-1 text-sm text-muted">
            Делим на {days(sts.daysUntil)} {sts.horizon.reason === "income" ? "до ближайшего дохода" : "до конца месяца"}.
          </p>
        </section>

        <p className="text-sm text-muted">
          Обязательные платежи и доходы берутся из регулярных доходов и платежей и запланированных операций. Если остаток в
          приложении отличается от реального — сверьте его на главном экране.
        </p>
      </div>
    </Sheet>
  );
}

function Row({ label, value, strong }: { label: string; value: Kopecks; strong?: boolean }) {
  return (
    <div className={`flex justify-between gap-3 ${strong ? "font-semibold" : ""}`}>
      <dt className={strong ? "" : "text-muted"}>{label}</dt>
      <dd className="tabular-nums">{formatMoney(value)}</dd>
    </div>
  );
}

/** Запланированное начисление регулярного платежа или дохода: пропустить один раз или изменить сам регулярный платёж. */
export function PlannedSheet({ templateId, month }: { templateId: string; month: MonthKey }) {
  const { state } = useSnapshot();
  const { close, open } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const template = state.templates.find((t) => t.id === templateId);
  if (!template) return null;
  const date = occurrenceDate(template, month);
  const income = template.kind === "income";
  // «в октябре» (с годом, если не текущий) — начисление может быть и в следующем месяце.
  const inMonth = formatMonthIn(month, today);
  const skip = () => {
    if (dispatch({ type: "occurrence.skip", templateId, month })) {
      close();
      toast(income ? "Доход пропущен" : "Платёж пропущен", {
        action: { label: "Отменить", onClick: () => dispatch({ type: "occurrence.unskip", templateId, month }) },
      });
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      title={template.title}
      footer={
        <div className="grid gap-2">
          <Button onClick={skip}>Пропустить {inMonth}</Button>
          <Button variant="ghost" onClick={() => open({ kind: "template", templateId })}>
            {income ? "Изменить регулярный доход" : "Изменить регулярный платёж"}
          </Button>
        </div>
      }
    >
      <div className="space-y-4">
        <div className="rounded-2xl bg-surface-2 px-4 py-3">
          <p className="text-sm text-muted">
            {income ? "Ожидаемый доход" : "Предстоящий платёж"} · {formatDay(date, today)}
          </p>
          <Money value={template.amount} className="text-2xl font-semibold" />
          <p className="text-sm text-muted">{template.category}</p>
        </div>
        <p className="text-sm text-muted">
          {income
            ? `В день поступления операция появится в истории автоматически. Если ${inMonth} дохода не будет — пропустите его.`
            : `В день платежа операция появится в истории автоматически. Если ${inMonth} платежа не будет — пропустите его.`}
        </p>
      </div>
    </Sheet>
  );
}
