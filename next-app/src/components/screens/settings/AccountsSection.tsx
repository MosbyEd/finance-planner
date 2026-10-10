"use client";

import { useSnapshot, useToday } from "@/client/react";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { ACCOUNT_KINDS, accountRows } from "../../app/accounts";
import { useUi } from "../../app/overlays";
import { SectionCard } from "./SettingsList";

/**
 * Счета: остатки, долг и беспроцентный период кредиток. Нажатие открывает счёт (сверить, перевести, изменить).
 * В «Сколько можно потратить» входят счета с отметкой «учитывается в лимите».
 */
export function AccountsSection() {
  const { state } = useSnapshot();
  const today = useToday();
  const { open } = useUi();
  const rows = accountRows(state, today);
  return (
    <SectionCard title="Счета">
      <ul className="divide-y divide-separator">
        {rows.map((row) => (
          <li key={row.account.id}>
            <button
              type="button"
              onClick={() => open({ kind: "account", accountId: row.account.id })}
              className="-mx-2 flex min-h-14 w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-2 text-left hover:bg-fill"
            >
              <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent" aria-hidden>
                <Icon name={ACCOUNT_KINDS[row.account.kind].icon} size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[15px] font-medium">{row.account.name}</span>
                <span className={`block truncate text-sm ${row.overdue ? "text-negative" : "text-muted"}`}>{row.detail}</span>
              </span>
              <span className={`shrink-0 text-[15px] font-semibold tabular-nums ${row.negative ? "text-negative" : ""}`}>{row.amount}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button size="sm" icon="plus" onClick={() => open({ kind: "account" })}>
          Добавить счёт
        </Button>
        <Button size="sm" variant="secondary" icon="card" onClick={() => open({ kind: "account", preset: { kind: "credit" } })}>
          Кредитная карта
        </Button>
        {rows.length > 1 && (
          <Button size="sm" variant="secondary" icon="swap" onClick={() => open({ kind: "transfer" })}>
            Перевод
          </Button>
        )}
      </div>
      <p className="mt-3 text-sm text-muted">
        Укажите у счёта последние цифры карты из СМС банка — операции из СМС будут попадать на нужный счёт.
      </p>
    </SectionCard>
  );
}
