"use client";

import { useState } from "react";
import {
  accountBalance,
  accountCards,
  creditStatus,
  findAccount,
  MAIN_ACCOUNT_ID,
  SAVINGS_ACCOUNT_ID,
} from "@/domain/accounts";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { AccountKind } from "@/domain/schema";
import { newId, useSnapshot, useToday } from "@/client/react";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { Segmented, Switch } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { TextInput, controlClass, controlLookClass } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { ACCOUNT_KINDS } from "../accounts";
import { InterestNotes } from "../InterestNotes";
import { CreditTermsFields, parseTerms, termsDraft, type TermsDraft } from "./CreditTermsFields";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";

const KIND_OPTIONS: { value: AccountKind; label: string }[] = [
  { value: "debit", label: "Карта" },
  { value: "cash", label: "Наличные" },
  { value: "savings", label: "Накопит." },
  { value: "credit", label: "Кредитка" },
];

/** Только цифры, не больше четырёх (поле — с цифровой клавиатурой). */
function fourDigits(text: string): string {
  return text.replace(/\D/g, "").slice(0, 4);
}

interface CardDraft {
  key: number;
  digits: string;
  name: string;
}

/** Новый счёт или правка: название, вид, учитывать ли в лимите, цифры карты из СМС, лимит и льготный срок кредитки. */
export function AccountSheet({ accountId, preset }: { accountId?: string; preset?: { kind?: AccountKind } }) {
  const { state } = useSnapshot();
  const { close, open } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const existing = accountId ? findAccount(state, accountId) : undefined;
  const builtin = existing?.id === MAIN_ACCOUNT_ID || existing?.id === SAVINGS_ACCOUNT_ID;

  const [name, setName] = useState(existing?.name ?? "");
  const [kind, setKind] = useState<AccountKind>(existing?.kind ?? preset?.kind ?? "debit");
  const [spending, setSpending] = useState(existing?.spending ?? (preset?.kind !== "savings" && preset?.kind !== "credit"));
  const [spendingTouched, setSpendingTouched] = useState(Boolean(existing));
  const [inSavings, setInSavings] = useState(existing?.inSavings !== false);
  const [number, setNumber] = useState(existing?.number ?? "");
  // Карты прежнего формата (цифры одним списком) показываются как карты без названия.
  const [cards, setCards] = useState<CardDraft[]>(() =>
    (existing ? accountCards(existing) : []).map((c, i) => ({ key: i, digits: c.digits, name: c.name })),
  );
  const [nextCardKey, setNextCardKey] = useState(cards.length);
  const [limit, setLimit] = useState<Kopecks | null>(existing?.creditLimit ?? null);
  const [terms, setTerms] = useState<TermsDraft>(() => termsDraft(existing?.terms, existing?.graceDays));
  const [errors, setErrors] = useState<{ name?: string; number?: string; cards?: string; terms?: string }>({});

  const updateCard = (key: number, patch: Partial<CardDraft>) => {
    setCards((list) => list.map((c) => (c.key === key ? { ...c, ...patch } : c)));
    setErrors((v) => ({ ...v, cards: undefined }));
  };
  const addCard = () => {
    setCards((list) => [...list, { key: nextCardKey, digits: "", name: "" }]);
    setNextCardKey((k) => k + 1);
  };

  const balance = existing ? accountBalance(state, existing.id, today) : 0;
  const credit = existing?.kind === "credit" ? creditStatus(state, existing, today) : null;

  const changeKind = (next: AccountKind) => {
    setKind(next);
    // Пока человек сам не трогал переключатель: накопительный и кредитка — не в лимите, остальные — в лимите.
    if (!spendingTouched) setSpending(next === "debit" || next === "cash");
  };

  const save = () => {
    const parsed = parseTerms(terms);
    // Беспроцентный период покупок дублируется в graceDays — по нему считают прежние версии приложения.
    const graceDays = parsed.terms?.purchase.graceDays ?? null;
    const filled = cards.filter((c) => c.digits || c.name.trim());
    const next: typeof errors = {};
    if (!name.trim()) next.name = "Введите название";
    if (number && !/^\d{4}$/.test(number)) next.number = "Нужны последние четыре цифры";
    if (filled.some((c) => !/^\d{4}$/.test(c.digits))) next.cards = "У каждой карты — последние четыре цифры";
    else if (new Set(filled.map((c) => c.digits)).size !== filled.length) next.cards = "Одна и та же карта указана дважды";
    if (kind === "credit" && parsed.error) next.terms = parsed.error;
    else if (kind === "credit" && graceDays !== null && graceDays > 365) next.terms = "Беспроцентный период покупок — до 365 дней";
    setErrors(next);
    if (Object.keys(next).length) return;

    const fields = {
      name: name.trim(),
      kind,
      spending: kind === "credit" ? false : spending,
      cards: filled.map((c) => ({ digits: c.digits, name: c.name.trim() })),
      // «Учитывать в сбережениях» — только у накопительного; по умолчанию да (поле не пишем).
      ...(kind === "savings" && !inSavings ? { inSavings: false } : { inSavings: true }),
    };
    const ok = existing
      ? dispatch({
          type: "account.update",
          id: existing.id,
          patch: {
            ...fields,
            number: number || null,
            // Прежний список цифр перенесён в карты.
            smsKeys: [],
            creditLimit: kind === "credit" ? limit : null,
            graceDays: kind === "credit" ? graceDays : null,
            terms: kind === "credit" ? parsed.terms : null,
          },
        })
      : dispatch({
          type: "account.add",
          account: {
            id: newId(),
            ...fields,
            ...(number ? { number } : {}),
            ...(kind === "credit" && limit ? { creditLimit: limit } : {}),
            ...(kind === "credit" && graceDays ? { graceDays } : {}),
            ...(kind === "credit" && parsed.terms ? { terms: parsed.terms } : {}),
          },
        });
    if (!ok) return;
    toast(existing ? "Счёт сохранён" : `Счёт «${fields.name}» добавлен`);
    close();
  };

  const remove = async () => {
    if (!existing) return;
    const used = state.transactions.some((t) => t.accountId === existing.id || t.toAccountId === existing.id);
    if (used) {
      const ok = await confirm({
        title: `Закрыть «${existing.name}»?`,
        message: "Счёт пропадёт из выбора, операции по нему останутся в истории.",
        confirmLabel: "Закрыть",
      });
      if (ok && dispatch({ type: "account.update", id: existing.id, patch: { archived: true } })) {
        toast("Счёт закрыт");
        close();
      }
      return;
    }
    const ok = await confirm({ title: `Удалить «${existing.name}»?`, confirmLabel: "Удалить", danger: true });
    if (ok && dispatch({ type: "account.delete", id: existing.id })) {
      toast("Счёт удалён");
      close();
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      title={existing ? existing.name : "Новый счёт"}
      footer={
        <div className="flex gap-2">
          {existing && !builtin && (
            <Button variant="secondary" onClick={() => void remove()}>
              {state.transactions.some((t) => t.accountId === existing.id || t.toAccountId === existing.id) ? "Закрыть" : "Удалить"}
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
        {existing && (
          <div className="rounded-2xl bg-surface-2 px-4 py-3">
            <p className="text-sm text-muted">{existing.kind === "credit" ? "Долг по карте" : "Остаток"}</p>
            <p className="text-2xl font-semibold tabular-nums">
              {formatMoney(existing.kind === "credit" ? (credit?.debt ?? 0) : balance, { whole: true })}
            </p>
            {credit && <InterestNotes summary={credit} />}
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => open({ kind: "balance", accountId: existing.id })}>
                {existing.kind === "credit" ? "Сверить долг" : "Сверить остаток"}
              </Button>
              {existing.kind === "credit" && credit && credit.debt > 0 ? (
                <Button size="sm" onClick={() => open({ kind: "transfer", to: existing.id, amount: credit.debt })}>
                  Погасить
                </Button>
              ) : (
                <Button size="sm" variant="secondary" onClick={() => open({ kind: "transfer", from: existing.id })}>
                  Перевести
                </Button>
              )}
            </div>
          </div>
        )}

        <TextInput
          label="Название"
          value={name}
          maxLength={80}
          placeholder={kind === "credit" ? "Кредитка Сбер" : kind === "savings" ? "Накопительный" : "Карта Сбер"}
          onChange={(e) => {
            setName(e.target.value);
            setErrors((v) => ({ ...v, name: undefined }));
          }}
          error={errors.name}
          autoFocus={!existing}
        />

        <Segmented
          label="Вид счёта"
          value={kind}
          onChange={changeKind}
          options={KIND_OPTIONS}
          disabled={builtin && (kind === "credit" || existing?.kind !== "credit")}
        />
        <p className="-mt-3 text-sm text-muted">
          {kind === "credit"
            ? "Покупки по кредитке — расходы месяца. Долг — к погашению до конца беспроцентного периода; кредитный лимит не считается вашими деньгами."
            : kind === "savings"
              ? "Здесь лежат сбережения и деньги целей."
              : ACCOUNT_KINDS[kind].label}
        </p>

        {kind !== "credit" && (
          <Switch
            checked={spending}
            onChange={(v) => {
              setSpending(v);
              setSpendingTouched(true);
            }}
            label="Учитывать в «Сколько можно потратить»"
            description="Деньги этого счёта входят в лимит на день и в «На счетах»."
          />
        )}

        {kind === "savings" && !spending && (
          <Switch
            checked={inSavings}
            onChange={setInSavings}
            label="Учитывать в сбережениях"
            description="Деньги счёта входят в «Сбережения» на Главной и в цели. Выключите для вклада под отдельную цель или чужих денег."
          />
        )}

        {kind === "credit" && (
          <>
            <AmountInput label="Кредитный лимит" value={limit} onChange={setLimit} />
            <CreditTermsFields
              value={terms}
              onChange={(next) => {
                setTerms(next);
                setErrors((v) => ({ ...v, terms: undefined }));
              }}
              error={errors.terms}
              hint="Беспроцентный период — с первой операции, когда долга не было. Не погасили к его концу — проценты за все дни с первой операции (оценка). Пусто — периода нет, проценты с первого дня."
            />
          </>
        )}

        <TextInput
          label="Номер счёта — последние 4 цифры"
          inputMode="numeric"
          value={number}
          placeholder={kind === "savings" ? "3150" : "5804"}
          hint="Как в СМС банка: «СЧЁТ5804», «Накопительный счет *3150». Есть у любого счёта — с картой или без"
          onChange={(e) => {
            setNumber(fourDigits(e.target.value));
            setErrors((v) => ({ ...v, number: undefined }));
          }}
          error={errors.number}
        />

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-muted">Карты счёта</legend>
          {cards.map((card) => (
            <div key={card.key} className="flex items-start gap-2">
              <input
                inputMode="numeric"
                aria-label="Последние 4 цифры карты"
                placeholder="7759"
                value={card.digits}
                onChange={(e) => updateCard(card.key, { digits: fourDigits(e.target.value) })}
                className={`${controlLookClass} h-12 w-24 shrink-0 tabular-nums`}
              />
              <input
                aria-label="Название карты"
                placeholder="Например, Мир"
                maxLength={40}
                value={card.name}
                onChange={(e) => updateCard(card.key, { name: e.target.value })}
                className={`${controlClass} h-12 min-w-0 flex-1`}
              />
              <button
                type="button"
                aria-label={`Убрать карту ${card.digits || ""}`.trim()}
                onClick={() => setCards((list) => list.filter((c) => c.key !== card.key))}
                className="flex h-12 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-fill hover:text-text"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          ))}
          {errors.cards && <p className="text-sm text-negative">{errors.cards}</p>}
          <Button size="sm" variant="secondary" icon="plus" onClick={addCard}>
            Добавить карту
          </Button>
          <p className="text-sm text-muted">
            Последние четыре цифры, как в СМС («MIR-7759»). Операции из СМС по картам и номеру счёта попадут на этот счёт, а у
            операции будет видно, какой картой платили.
          </p>
        </fieldset>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
