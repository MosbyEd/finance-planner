"use client";

import { useMemo, useState } from "react";
import { monthKeyOf } from "@/domain/dates";
import { monthMetrics, PAY_CATEGORIES } from "@/domain/metrics";
import { formatMoney, percentOf, type Kopecks } from "@/domain/money";
import { accountCards, activeAccounts, cardLabel, SAVINGS_ACCOUNT_ID, savingsTarget } from "@/domain/accounts";
import { pendingSavings, purchaseSavingAmount } from "@/domain/savings";
import type { Account, Settings } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { useDispatch } from "../../app/hooks";
import { useLeaveGuard } from "../../app/overlays";
import { AccountPicker } from "../../ui/AccountPicker";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { Switch } from "../../ui/controls";
import { useToast } from "../../ui/feedback";
import { TextInput } from "../../ui/Field";
import { ChipGroup, ChoiceChips, ToggleChip, UnsavedHint, parseIntInRange } from "./common";
import { SectionCard, UNSAVED_SUMMARY, useRowSummary } from "./SettingsList";

const ROUNDING = [
  { value: 0, label: "Без округления" },
  { value: 1_000, label: "10 ₽" },
  { value: 5_000, label: "50 ₽" },
  { value: 10_000, label: "100 ₽" },
];

/** «Переводить, когда накопится» — как правило автонакоплений в банке. */
const MIN_TRANSFER = [
  { value: 0, label: "Сразу" },
  { value: 5_000, label: "50 ₽" },
  { value: 10_000, label: "100 ₽" },
  { value: 50_000, label: "500 ₽" },
  { value: 100_000, label: "1 000 ₽" },
];

function minTransferOptions(current: number): { value: string; label: string }[] {
  const list = MIN_TRANSFER.some((o) => o.value === current) ? MIN_TRANSFER : [...MIN_TRANSFER, { value: current, label: formatMoney(current) }];
  return list.map((o) => ({ value: String(o.value), label: o.label }));
}

const MAX_SALARY_CATEGORIES = 20;
const MAX_EXCLUDED = 50;
const EXAMPLE_PURCHASE: Kopecks = 123_400;
const EXAMPLE_SALARY: Kopecks = 8_000_000;
const EXAMPLE_INCOME: Kopecks = 10_000_000;

interface Form {
  rate: string;
  salaryEnabled: boolean;
  salaryPercent: string;
  salaryCategories: string[];
  purchaseEnabled: boolean;
  purchasePercent: string;
  cap: Kopecks | null;
  roundTo: number;
  excluded: string[];
  /** На какие накопительные счета откладывать: с доходов, с покупок и остаток месяца. */
  salaryTarget: string;
  purchaseTarget: string;
  rolloverTarget: string;
  /** Переводить, когда накопится (копейки; 0 — сразу): у доходов и покупок — свой порог. */
  salaryMin: number;
  purchaseMin: number;
  /** С покупок по этим счетам и картам не откладывать. */
  excludedAccounts: string[];
  excludedCards: string[];
  /** Период бюджета: от зарплаты до зарплаты или календарный месяц. */
  period: "pay" | "month";
}

type ErrorKey = "rate" | "salaryPercent" | "salaryCategories" | "purchasePercent" | "cap" | "excluded";
type Errors = Partial<Record<ErrorKey, string>>;

/** Какие ошибки снимать, когда меняется поле. */
const ERRORS_BY_FIELD: Record<keyof Form, ErrorKey[]> = {
  rate: ["rate"],
  salaryEnabled: ["salaryPercent", "salaryCategories"],
  salaryPercent: ["salaryPercent"],
  salaryCategories: ["salaryCategories"],
  purchaseEnabled: ["purchasePercent", "cap"],
  purchasePercent: ["purchasePercent"],
  cap: ["cap"],
  roundTo: [],
  excluded: ["excluded"],
  salaryTarget: [],
  purchaseTarget: [],
  rolloverTarget: [],
  salaryMin: [],
  purchaseMin: [],
  excludedAccounts: [],
  excludedCards: [],
  period: [],
};

function toForm(s: Settings, state: Parameters<typeof savingsTarget>[0]): Form {
  return {
    salaryTarget: savingsTarget(state, s.salarySaving.toAccountId),
    purchaseTarget: savingsTarget(state, s.purchaseSaving.toAccountId),
    rolloverTarget: savingsTarget(state, s.rolloverAccountId),
    rate: String(s.savingsRatePercent),
    salaryEnabled: s.salarySaving.enabled,
    salaryPercent: String(s.salarySaving.percent),
    salaryCategories: s.salarySaving.categories,
    purchaseEnabled: s.purchaseSaving.enabled,
    purchasePercent: String(s.purchaseSaving.percent),
    cap: s.purchaseSaving.cap,
    roundTo: s.purchaseSaving.roundTo,
    excluded: s.purchaseSaving.excludedCategories,
    salaryMin: s.salarySaving.minTransfer ?? 0,
    purchaseMin: s.purchaseSaving.minTransfer ?? 0,
    excludedAccounts: s.purchaseSaving.excludedAccounts ?? [],
    excludedCards: s.purchaseSaving.excludedCards ?? [],
    period: s.budgetPeriod ?? "pay",
  };
}

function sameForm(a: Form, b: Form): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Настройки из черновика: что не распознано — берём из сохранённых. Для примеров на лету. */
function previewSettings(form: Form, base: Settings): Settings {
  return {
    savingsRatePercent: parseIntInRange(form.rate, 0, 90) ?? base.savingsRatePercent,
    salarySaving: {
      enabled: form.salaryEnabled,
      percent: parseIntInRange(form.salaryPercent, 1, 90) ?? base.salarySaving.percent,
      categories: form.salaryCategories,
      ...(form.salaryTarget !== SAVINGS_ACCOUNT_ID ? { toAccountId: form.salaryTarget } : {}),
      ...(form.salaryMin > 0 ? { minTransfer: form.salaryMin } : {}),
    },
    purchaseSaving: {
      enabled: form.purchaseEnabled,
      percent: parseIntInRange(form.purchasePercent, 0, 50) ?? base.purchaseSaving.percent,
      cap: form.cap ?? base.purchaseSaving.cap,
      roundTo: form.roundTo,
      excludedCategories: form.excluded,
      ...(form.purchaseTarget !== SAVINGS_ACCOUNT_ID ? { toAccountId: form.purchaseTarget } : {}),
      ...(form.purchaseMin > 0 ? { minTransfer: form.purchaseMin } : {}),
      ...(form.excludedAccounts.length ? { excludedAccounts: form.excludedAccounts } : {}),
      ...(form.excludedCards.length ? { excludedCards: form.excludedCards } : {}),
    },
    ...(form.rolloverTarget !== SAVINGS_ACCOUNT_ID ? { rolloverAccountId: form.rolloverTarget } : {}),
    ...(form.period === "month" ? { budgetPeriod: "month" as const } : {}),
  };
}

function validate(form: Form): Errors {
  const errors: Errors = {};
  if (parseIntInRange(form.rate, 0, 90) === null) errors.rate = "Целое число от 0 до 90";
  if (form.salaryEnabled) {
    if (parseIntInRange(form.salaryPercent, 1, 90) === null) errors.salaryPercent = "Целое число от 1 до 90";
    if (!form.salaryCategories.length) errors.salaryCategories = "Выберите хотя бы одну категорию дохода";
  }
  if (form.salaryCategories.length > MAX_SALARY_CATEGORIES) {
    errors.salaryCategories = `Не больше ${MAX_SALARY_CATEGORIES} категорий`;
  }
  if (form.purchaseEnabled) {
    if (parseIntInRange(form.purchasePercent, 0, 50) === null) errors.purchasePercent = "Целое число от 0 до 50";
    if (form.cap === null) errors.cap = "Укажите сумму";
  }
  if (form.excluded.length > MAX_EXCLUDED) errors.excluded = `Не больше ${MAX_EXCLUDED} категорий`;
  return errors;
}

function toggle(list: string[], name: string): string[] {
  return list.includes(name) ? list.filter((c) => c !== name) : [...list, name];
}

/** Список категорий плюс выбранные, которых в списке уже нет (чтобы их можно было снять). */
function withSelected(options: string[], selected: string[]): string[] {
  const seen = new Set(options);
  return [...options, ...selected.filter((c) => !seen.has(c))];
}

export function SavingsSection() {
  const { state } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const saved = state.settings;

  const [base, setBase] = useState(saved);
  const [form, setForm] = useState(() => toForm(saved, state));
  // Куда откладывать — выбор, когда накопительных счетов больше одного.
  const savingsAccounts = activeAccounts(state).filter((a) => a.kind === "savings");
  const chooseTarget = savingsAccounts.length > 1;
  const [errors, setErrors] = useState<Errors>({});

  // Настройки изменились снаружи (другое устройство, импорт). Если черновик не трогали — подхватываем.
  if (saved !== base) {
    setBase(saved);
    if (sameForm(form, toForm(base, state))) setForm(toForm(saved, state));
  }

  const dirty = !sameForm(form, toForm(saved, state));
  useLeaveGuard(dirty);
  useRowSummary(dirty ? UNSAVED_SUMMARY : null);
  const preview = previewSettings(form, saved);

  const hasPayTemplates = state.templates.some((t) => t.active && t.kind === "income" && PAY_CATEGORIES.includes(t.category));
  const monthIncome = useMemo(() => monthMetrics(state, monthKeyOf(today), today).income.plan, [state, today]);

  const incomeOptions = withSelected(state.categories.income, form.salaryCategories);
  const expenseOptions = useMemo(
    () => withSelected([...new Set([...state.categories.mandatory, ...state.categories.flexible])], form.excluded),
    [state.categories.mandatory, state.categories.flexible, form.excluded],
  );

  const patch = (next: Partial<Form>) => {
    setForm((f) => ({ ...f, ...next }));
    setErrors((e) => {
      const copy = { ...e };
      for (const key of Object.keys(next) as (keyof Form)[]) {
        for (const errorKey of ERRORS_BY_FIELD[key]) delete copy[errorKey];
      }
      return copy;
    });
  };

  const save = () => {
    const nextErrors = validate(form);
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;
    const settings = previewSettings(form, saved);
    if (dispatch({ type: "settings.update", settings })) {
      setForm(toForm(settings, state));
      toast("Настройки сбережений сохранены");
    }
  };

  const reset = () => {
    setForm(toForm(saved, state));
    setErrors({});
  };

  // Примеры считаются по черновику.
  const incomeExample = monthIncome > 0 ? monthIncome : EXAMPLE_INCOME;
  const purchaseExample = purchaseSavingAmount(EXAMPLE_PURCHASE, "", {
    ...preview,
    purchaseSaving: { ...preview.purchaseSaving, enabled: true, excludedCategories: [] },
  });
  const roundingOptions = ROUNDING.some((r) => r.value === form.roundTo)
    ? ROUNDING
    : [...ROUNDING, { value: form.roundTo, label: formatMoney(form.roundTo) }];

  return (
    <SectionCard title="Сбережения">
      <form
        className="space-y-6"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-2">
          <ChoiceChips
            label="Период бюджета"
            value={form.period}
            options={[
              { value: "pay", label: "От зарплаты до зарплаты" },
              { value: "month", label: "Календарный месяц" },
            ]}
            onChange={(v) => patch({ period: v === "month" ? "month" : "pay" })}
          />
          <p className="text-sm text-muted">
            {form.period === "month"
              ? "Гибкий бюджет и лимит на день — на календарный месяц, с 1-го по последнее число."
              : hasPayTemplates
                ? "Гибкий бюджет и лимит на день — от поступления зарплаты или аванса до следующего. Сколько будет в день после следующего поступления — на Главной."
                : "Нужен регулярный доход с категорией «Зарплата» или «Аванс» (вкладка «Регулярные»). Пока его нет, считаем по календарному месяцу."}
          </p>
        </div>

        <div className="space-y-2 border-t border-border pt-5">
          <div className="max-w-56">
            <TextInput
              label="Норма сбережений, % от доходов"
              inputMode="numeric"
              maxLength={3}
              value={form.rate}
              error={errors.rate}
              onChange={(e) => patch({ rate: e.target.value })}
            />
          </div>
          <p className="text-sm text-muted">
            Эта доля доходов месяца сразу откладывается в плане. Из остального вычитаются обязательные расходы, а что
            останется — гибкий бюджет на повседневные траты. Отчисления с доходов и покупок (ниже) засчитываются в эту
            норму, а не добавляются к ней.{" "}
            {monthIncome > 0 ? "Доходы этого месяца по плану" : "Например, при доходах"} {formatMoney(incomeExample, { whole: true })} →
            отложить {formatMoney(percentOf(incomeExample, preview.savingsRatePercent), { whole: true })}.
          </p>
        </div>

        <div className="space-y-4 border-t border-border pt-5">
          <Switch
            checked={form.salaryEnabled}
            onChange={(v) => patch({ salaryEnabled: v })}
            label="Откладывать с доходов"
            description={
              <>
                Когда приходит доход из выбранных категорий, часть сразу уходит в сбережения: доход{" "}
                {formatMoney(EXAMPLE_SALARY)} → в сбережения {formatMoney(percentOf(EXAMPLE_SALARY, preview.salarySaving.percent))}.
              </>
            }
          />
          {form.salaryEnabled && (
            <>
              <div className="max-w-56">
                <TextInput
                  label="Процент с дохода"
                  inputMode="numeric"
                  maxLength={2}
                  value={form.salaryPercent}
                  error={errors.salaryPercent}
                  hint="От 1 до 90"
                  onChange={(e) => patch({ salaryPercent: e.target.value })}
                />
              </div>
              {chooseTarget && (
                <AccountPicker
                  label="Куда откладывать с доходов"
                  accounts={savingsAccounts}
                  value={form.salaryTarget}
                  onChange={(id) => patch({ salaryTarget: id })}
                />
              )}
              <MinTransfer
                value={form.salaryMin}
                onChange={(v) => patch({ salaryMin: v })}
                pending={pendingSavings(state, "income")}
              />
              <ChipGroup label="С каких доходов откладывать" error={errors.salaryCategories}>
                {incomeOptions.map((c) => (
                  <ToggleChip
                    key={c}
                    label={c}
                    pressed={form.salaryCategories.includes(c)}
                    onToggle={() => patch({ salaryCategories: toggle(form.salaryCategories, c) })}
                  />
                ))}
              </ChipGroup>
            </>
          )}
        </div>

        <div className="space-y-4 border-t border-border pt-5">
          <Switch
            checked={form.purchaseEnabled}
            onChange={(v) => patch({ purchaseEnabled: v })}
            label="Откладывать с покупок"
            description={
              <>
                С каждой покупки небольшая сумма уходит в сбережения: процент от покупки плюс округление вверх. Например,
                покупка {formatMoney(EXAMPLE_PURCHASE)} → в сбережения {formatMoney(purchaseExample)}.
              </>
            }
          />
          {form.purchaseEnabled && (
            <>
              <div className="grid gap-4 sm:grid-cols-2">
                <TextInput
                  label="Процент с покупки"
                  inputMode="numeric"
                  maxLength={2}
                  value={form.purchasePercent}
                  error={errors.purchasePercent}
                  hint="От 0 до 50"
                  onChange={(e) => patch({ purchasePercent: e.target.value })}
                />
                <AmountInput
                  label="Не больше"
                  value={form.cap}
                  onChange={(v) => patch({ cap: v })}
                  error={errors.cap}
                  hint="Потолок для процента с одной покупки"
                />
              </div>
              {chooseTarget && (
                <AccountPicker
                  label="Куда откладывать с покупок"
                  accounts={savingsAccounts}
                  value={form.purchaseTarget}
                  onChange={(id) => patch({ purchaseTarget: id })}
                />
              )}
              <ChoiceChips
                label="Округлять покупку вверх до"
                value={String(form.roundTo)}
                options={roundingOptions.map((r) => ({ value: String(r.value), label: r.label }))}
                onChange={(v) => patch({ roundTo: Number(v) })}
              />
              <p className="-mt-2 text-xs text-muted">
                {form.roundTo > 0
                  ? `Разница до ближайших ${formatMoney(form.roundTo)} тоже уходит в сбережения.`
                  : "Откладывается только процент."}
              </p>
              <MinTransfer
                value={form.purchaseMin}
                onChange={(v) => patch({ purchaseMin: v })}
                pending={pendingSavings(state, "expense")}
              />
              <PurchaseSources
                accounts={activeAccounts(state).filter((a) => a.kind !== "savings")}
                excludedAccounts={form.excludedAccounts}
                excludedCards={form.excludedCards}
                onChange={(next) => patch(next)}
              />
              <ChipGroup
                label="Не откладывать с покупок в категориях"
                hint="Обычно это крупные обязательные платежи: аренда, кредит, коммуналка."
                error={errors.excluded}
              >
                {expenseOptions.map((c) => (
                  <ToggleChip
                    key={c}
                    label={c}
                    pressed={form.excluded.includes(c)}
                    onToggle={() => patch({ excluded: toggle(form.excluded, c) })}
                  />
                ))}
              </ChipGroup>
            </>
          )}
        </div>

        {chooseTarget && (
          <div className="space-y-2 border-t border-border pt-5">
            <AccountPicker
              label="Куда откладывать остаток месяца"
              accounts={savingsAccounts}
              value={form.rolloverTarget}
              onChange={(id) => patch({ rolloverTarget: id })}
            />
            <p className="text-sm text-muted">
              Когда месяц закончился с остатком гибкого бюджета, приложение предлагает отложить его — сюда.
            </p>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-4">
          <Button type="submit" disabled={!dirty}>
            Сохранить
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={reset}>
              Отменить
            </Button>
          )}
          <UnsavedHint dirty={dirty} />
        </div>
      </form>
    </SectionCard>
  );
}

/**
 * «Переводить, когда накопится»: пока отчисления этого вида не наберут порог, деньги остаются на счёте
 * операции — как в банке «переводить на накопительный, когда накопится хотя бы 100 ₽».
 */
function MinTransfer({
  value,
  onChange,
  pending,
}: {
  value: number;
  onChange: (value: number) => void;
  pending: { total: Kopecks; threshold: Kopecks; count: number };
}) {
  return (
    <div className="space-y-2">
      <ChoiceChips
        label="Переводить в сбережения, когда накопится"
        value={String(value)}
        options={minTransferOptions(value)}
        onChange={(v) => onChange(Number(v))}
      />
      <p className="text-xs text-muted">
        {value > 0
          ? `Отчисления копятся и переводятся разом, когда наберётся ${formatMoney(value, { whole: true })}. До этого деньги остаются на счёте.`
          : "Каждое отчисление переводится сразу."}
        {pending.total > 0 &&
          ` Сейчас накоплено ${formatMoney(pending.total)}${pending.threshold > 0 ? ` из ${formatMoney(pending.threshold, { whole: true })}` : ""}.`}
      </p>
    </div>
  );
}

/**
 * «С каких карт откладывать» — как «копилка» в банке, которая включается для отдельных карт. Счёт с одной картой —
 * одним выбором; у счёта с несколькими картами можно выключить отдельную карту. Новые счета и карты — включены.
 */
function PurchaseSources({
  accounts,
  excludedAccounts,
  excludedCards,
  onChange,
}: {
  accounts: Account[];
  excludedAccounts: string[];
  excludedCards: string[];
  onChange: (next: { excludedAccounts: string[]; excludedCards: string[] }) => void;
}) {
  // Выбирать есть из чего: несколько счетов или у счёта несколько карт.
  if (accounts.length < 2 && !accounts.some((a) => accountCards(a).length > 1)) return null;
  const without = (list: string[], items: string[]) => list.filter((x) => !items.includes(x));
  const chips: { key: string; label: string; pressed: boolean; toggle: () => void }[] = [];
  for (const account of accounts) {
    const cards = accountCards(account);
    const accountOn = !excludedAccounts.includes(account.id);
    if (cards.length <= 1) {
      const digits = cards[0]?.digits;
      chips.push({
        key: account.id,
        label: digits ? `${account.name} ${cardLabel(account, digits)}` : account.name,
        pressed: accountOn && !(digits && excludedCards.includes(digits)),
        toggle: () =>
          accountOn && !(digits && excludedCards.includes(digits))
            ? onChange({ excludedAccounts: [...excludedAccounts, account.id], excludedCards })
            : onChange({ excludedAccounts: without(excludedAccounts, [account.id]), excludedCards: without(excludedCards, digits ? [digits] : []) }),
      });
      continue;
    }
    chips.push({
      key: account.id,
      label: account.name,
      pressed: accountOn,
      toggle: () =>
        accountOn
          ? onChange({ excludedAccounts: [...excludedAccounts, account.id], excludedCards })
          : onChange({ excludedAccounts: without(excludedAccounts, [account.id]), excludedCards }),
    });
    // Карты счёта — только когда сам счёт включён.
    if (!accountOn) continue;
    for (const card of cards) {
      const on = !excludedCards.includes(card.digits);
      chips.push({
        key: `${account.id}:${card.digits}`,
        label: `${account.name} ${cardLabel(account, card.digits)}`,
        pressed: on,
        toggle: () =>
          onChange({ excludedAccounts, excludedCards: on ? [...excludedCards, card.digits] : without(excludedCards, [card.digits]) }),
      });
    }
  }
  const noneOn = chips.every((c) => !c.pressed);
  return (
    <ChipGroup
      label="С каких карт откладывать"
      hint={
        noneOn
          ? "Ни одна карта не выбрана — с покупок ничего не откладывается."
          : "Только с покупок по выбранным картам и счетам — как «копилка» в банке. Новые карты и счета включаются сами."
      }
    >
      {chips.map((c) => (
        <ToggleChip key={c.key} label={c.label} pressed={c.pressed} onToggle={c.toggle} />
      ))}
    </ChipGroup>
  );
}
