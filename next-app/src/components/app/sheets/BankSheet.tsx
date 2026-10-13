"use client";

import { useState } from "react";
import { accountsOf } from "@/domain/accounts";
import { KNOWN_BANKS, accountBankId, bankFormat, bankShortcut, banksOf, canParseBank, senderKey } from "@/domain/banks";
import { newId, useSnapshot } from "@/client/react";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { TextInput, controlClass } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { ChipGroup, ToggleChip } from "../../screens/settings/common";
import { SmsAutomationSetup } from "../SmsAutomationSetup";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";

interface SenderDraft {
  key: number;
  value: string;
}

/**
 * Банк: название, отправители СМС и счета. У сохранённого банка — настройка «Команд» для его отправителей:
 * шаги автоматизации и задание для Siri.
 */
export function BankSheet({ bankId }: { bankId?: string }) {
  const { state } = useSnapshot();
  const { close, open } = useUi();
  const dispatch = useDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const banks = banksOf(state);
  const existing = bankId ? banks.find((b) => b.id === bankId) : undefined;

  const [name, setName] = useState(existing?.name ?? "");
  const [senders, setSenders] = useState<SenderDraft[]>(() =>
    (existing?.senders.length ? existing.senders : [""]).map((value, key) => ({ key, value })),
  );
  const [nextKey, setNextKey] = useState(senders.length);
  const [linked, setLinked] = useState<Set<string>>(
    () => new Set(existing ? accountsOf(state).filter((a) => accountBankId(state, a) === existing.id).map((a) => a.id) : []),
  );
  const [errors, setErrors] = useState<{ name?: string; senders?: string }>({});

  const filled = senders.map((s) => s.value.trim()).filter(Boolean);
  const draft = { name: name.trim(), senders: filled };
  const presets = KNOWN_BANKS.filter((k) => !banks.some((b) => b.id !== existing?.id && bankFormat(b) === k.format));
  const accounts = accountsOf(state).filter((a) => !a.archived || linked.has(a.id));
  const bankName = (id: string | undefined) => banks.find((b) => b.id === id)?.name;

  const applyPreset = (preset: (typeof KNOWN_BANKS)[number]) => {
    setName(preset.name);
    setSenders(preset.senders.map((value, i) => ({ key: nextKey + i, value })));
    setNextKey((k) => k + preset.senders.length);
    setErrors({});
  };
  const updateSender = (key: number, value: string) => {
    setSenders((list) => list.map((s) => (s.key === key ? { ...s, value } : s)));
    setErrors((v) => ({ ...v, senders: undefined }));
  };
  const toggleAccount = (id: string) =>
    setLinked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = () => {
    const next: typeof errors = {};
    if (!draft.name) next.name = "Введите название";
    if (!filled.length) next.senders = "Добавьте хотя бы одного отправителя";
    else if (new Set(filled.map(senderKey)).size !== filled.length) next.senders = "Один и тот же отправитель указан дважды";
    setErrors(next);
    if (Object.keys(next).length) return;
    const accountIds = [...linked];
    if (existing) {
      if (!dispatch({ type: "bank.update", id: existing.id, patch: draft, accountIds })) return;
      toast("Банк сохранён");
      close();
      return;
    }
    const id = newId();
    if (!dispatch({ type: "bank.add", bank: { id, ...draft }, accountIds })) return;
    toast(`Банк «${draft.name}» добавлен`);
    // Сразу карточка сохранённого банка — с настройкой «Команд» для его отправителей.
    open({ kind: "bank", bankId: id });
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `Удалить банк «${existing.name}»?`,
      message: "Счета останутся, но без банка. Автоматизацию в «Командах» для его отправителей можно удалить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (ok && dispatch({ type: "bank.delete", id: existing.id })) {
      toast("Банк удалён");
      close();
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      title={existing ? existing.name : "Новый банк"}
      footer={
        <div className="flex gap-2">
          {existing && (
            <Button variant="secondary" onClick={() => void remove()}>
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
        {!existing && presets.length > 0 && (
          <ChipGroup label="Быстро" hint="Подставит название и отправителей — их можно поправить.">
            {presets.map((preset) => (
              <ToggleChip key={preset.format} label={preset.name} pressed={draft.name === preset.name} onToggle={() => applyPreset(preset)} />
            ))}
          </ChipGroup>
        )}

        <TextInput
          label="Название"
          value={name}
          maxLength={40}
          placeholder="Например, Т-Банк"
          onChange={(e) => {
            setName(e.target.value);
            setErrors((v) => ({ ...v, name: undefined }));
          }}
          error={errors.name}
          autoFocus={!existing}
        />

        <fieldset className="space-y-2">
          <legend className="mb-1.5 text-sm font-medium text-muted">Отправители СМС</legend>
          {senders.map((sender) => (
            <div key={sender.key} className="flex items-center gap-2">
              <input
                aria-label="Отправитель"
                placeholder="900 или Tinkoff"
                maxLength={40}
                autoCapitalize="off"
                autoCorrect="off"
                value={sender.value}
                onChange={(e) => updateSender(sender.key, e.target.value)}
                className={`${controlClass} h-12 min-w-0 flex-1`}
              />
              <button
                type="button"
                aria-label={`Убрать отправителя ${sender.value}`.trim()}
                onClick={() => setSenders((list) => list.filter((s) => s.key !== sender.key))}
                className="flex h-12 w-11 shrink-0 items-center justify-center rounded-full text-muted hover:bg-fill hover:text-text"
              >
                <Icon name="close" size={18} />
              </button>
            </div>
          ))}
          {errors.senders && (
            <p className="text-sm text-negative" role="alert">
              {errors.senders}
            </p>
          )}
          <Button
            size="sm"
            variant="secondary"
            icon="plus"
            onClick={() => {
              setSenders((list) => [...list, { key: nextKey, value: "" }]);
              setNextKey((k) => k + 1);
            }}
          >
            Добавить отправителя
          </Button>
          <p className="text-sm text-muted">
            Как отправитель подписан в «Сообщениях»: номер (900) или имя (Tinkoff, Alfa-Bank). Регистр, пробелы и дефисы не
            важны.
          </p>
        </fieldset>

        <ChipGroup
          label="Счета банка"
          hint="Операции из СМС банка попадут на его счёт с теми же цифрами карты. Счёт может быть только в одном банке — отмеченный здесь уйдёт из другого."
        >
          {accounts.map((account) => {
            const other = accountBankId(state, account);
            const otherName = other && other !== existing?.id ? bankName(other) : undefined;
            return (
              <ToggleChip
                key={account.id}
                label={otherName ? `${account.name} · ${otherName}` : account.name}
                pressed={linked.has(account.id)}
                onToggle={() => toggleAccount(account.id)}
              />
            );
          })}
        </ChipGroup>

        {draft.name || filled.length ? (
          canParseBank(draft) ? (
            <Notice tone="positive">СМС этого банка приложение разбирает: покупки, переводы, зарплату и остаток на счёте.</Notice>
          ) : (
            <Notice tone="warning">
              СМС этого банка приложение пока не разбирает: на каждую придёт уведомление «Не разобрали СМС банка «
              {draft.name || "…"}»». Для разбора нужны примеры его СМС.
            </Notice>
          )
        ) : null}

        {existing ? (
          <section aria-labelledby="bank-shortcuts" className="space-y-3 border-t border-separator pt-5">
            <h3 id="bank-shortcuts" className="text-[17px] font-semibold">
              Настройка «Команд»
            </h3>
            <SmsAutomationSetup senders={existing.senders.length ? existing.senders : filled} shortcut={bankShortcut(existing)} />
          </section>
        ) : (
          <p className="text-sm text-muted">После добавления здесь появится настройка «Команд» для отправителей банка.</p>
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
