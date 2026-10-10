"use client";

import { creditStatus } from "@/domain/accounts";
import { formatMoney } from "@/domain/money";
import { useSnapshot, useToday } from "@/client/react";
import { Button } from "../../ui/Button";
import { Icon } from "../../ui/Icon";
import { ACCOUNT_GROUPS, ACCOUNT_KINDS, accountGroup, accountRows, type AccountRow } from "../../app/accounts";
import { useUi } from "../../app/overlays";
import { SectionCard } from "./SettingsList";

/**
 * Счета по группам: для трат, накопления, кредитки — с итогом группы. Нажатие открывает счёт (сверить,
 * перевести, изменить). В «Сколько можно потратить» входят счета группы «Для трат».
 */
export function AccountsSection() {
  const { state } = useSnapshot();
  const today = useToday();
  const { open } = useUi();
  const rows = accountRows(state, today);
  return (
    <SectionCard title="Счета">
      <div className="mb-4 flex flex-wrap gap-2">
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
      <div className="space-y-5">
        {ACCOUNT_GROUPS.map((group) => {
          const items = rows.filter((row) => accountGroup(row.account) === group.id);
          if (!items.length) return null;
          const total =
            group.id === "credit"
              ? items.reduce((sum, row) => sum + creditStatus(state, row.account, today).debt, 0)
              : items.reduce((sum, row) => sum + row.balance, 0);
          return (
            <section key={group.id} aria-label={group.title}>
              <div className="mb-1 flex items-baseline justify-between gap-3 px-1">
                <h3 className="text-sm font-medium text-muted">{group.title}</h3>
                <span className="text-sm text-muted tabular-nums">
                  {group.id === "credit"
                    ? total > 0
                      ? `долг ${formatMoney(total, { whole: true })}`
                      : "долга нет"
                    : formatMoney(total, { whole: true })}
                </span>
              </div>
              <ul className="divide-y divide-separator">
                {items.map((row) => (
                  <AccountItem key={row.account.id} row={row} onOpen={() => open({ kind: "account", accountId: row.account.id })} />
                ))}
              </ul>
            </section>
          );
        })}
      </div>
      <p className="mt-4 text-sm text-muted">
        Укажите у счёта номер и карты из СМС банка — операции из СМС будут попадать на нужный счёт.
      </p>
    </SectionCard>
  );
}

function AccountItem({ row, onOpen }: { row: AccountRow; onOpen: () => void }) {
  return (
    <li>
      <button
        type="button"
        onClick={onOpen}
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
        <Icon name="chevronRight" size={16} className="shrink-0 text-muted" aria-hidden />
      </button>
    </li>
  );
}
