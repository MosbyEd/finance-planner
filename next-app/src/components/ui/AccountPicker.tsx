"use client";

import type { Account } from "@/domain/schema";
import { ACCOUNT_KINDS } from "../app/accounts";
import { Icon } from "./Icon";

/** Выбор счёта чипами со значком вида счёта. */
export function AccountPicker({
  label,
  accounts,
  value,
  onChange,
  error,
}: {
  label: string;
  accounts: Account[];
  value: string;
  onChange: (id: string) => void;
  error?: string | null;
}) {
  return (
    <fieldset className="space-y-2">
      <legend className="mb-1.5 text-sm font-medium text-muted">{label}</legend>
      <div className="flex flex-wrap gap-2">
        {accounts.map((a) => (
          <button
            key={a.id}
            type="button"
            aria-pressed={a.id === value}
            onClick={() => onChange(a.id)}
            className={`inline-flex h-10 items-center gap-1.5 rounded-full border px-3.5 text-sm transition ${
              a.id === value ? "sheen border-accent-fill bg-accent-fill text-on-accent" : "glass-control"
            }`}
          >
            <Icon name={ACCOUNT_KINDS[a.kind].icon} size={16} />
            {a.name}
          </button>
        ))}
      </div>
      {error && <p className="text-sm text-negative">{error}</p>}
    </fieldset>
  );
}
