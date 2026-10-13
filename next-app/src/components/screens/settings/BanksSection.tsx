"use client";

import { bankAccounts, banksOf, canParseBank } from "@/domain/banks";
import { useSnapshot } from "@/client/react";
import { Button } from "../../ui/Button";
import { EmptyState } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import { useUi } from "../../app/overlays";
import { SectionCard } from "./SettingsList";

/**
 * Банки, от которых приходят СМС: у каждого — отправители и счета. Нажатие открывает карточку банка (правка,
 * настройка «Команд» для его отправителей). Сбербанк с 900 есть по умолчанию у тех, кому уже приходили СМС.
 */
export function BanksSection() {
  const { state } = useSnapshot();
  const { open } = useUi();
  const banks = banksOf(state);
  return (
    <SectionCard title="Банки">
      <div className="space-y-4">
        <p className="text-[15px] text-muted">
          По отправителю приложение понимает, какой банк прислал СМС, разбирает её форматом этого банка и ищет счёт по
          цифрам карты среди счетов банка.
        </p>
        {banks.length ? (
          <ul className="divide-y divide-separator">
            {banks.map((bank) => {
              const accounts = bankAccounts(state, bank.id).filter((a) => !a.archived);
              const details = [
                bank.senders.length ? bank.senders.join(", ") : "нет отправителей",
                accounts.length ? accounts.map((a) => a.name).join(", ") : "без счетов",
              ];
              return (
                <li key={bank.id}>
                  <button
                    type="button"
                    onClick={() => open({ kind: "bank", bankId: bank.id })}
                    className="-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-fill"
                  >
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
                      <Icon name="wallet" size={18} />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[15px] font-medium">{bank.name}</span>
                      <span className="block truncate text-sm text-muted">{details.join(" · ")}</span>
                      {!canParseBank(bank) && <span className="block text-sm text-warning">СМС пока не разбираются</span>}
                    </span>
                    <Icon name="chevronRight" size={16} className="shrink-0 text-muted" aria-hidden />
                  </button>
                </li>
              );
            })}
          </ul>
        ) : (
          <EmptyState title="Банков пока нет" text="Добавьте банк, от которого приходят СМС, — и его отправителей." />
        )}
        <Button icon="plus" onClick={() => open({ kind: "bank" })}>
          Добавить банк
        </Button>
      </div>
    </SectionCard>
  );
}
