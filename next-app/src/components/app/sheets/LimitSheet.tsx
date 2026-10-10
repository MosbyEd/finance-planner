"use client";

import { useMemo, useState } from "react";
import { firstDayOfMonth, formatMonthIn, monthKeyOf } from "@/domain/dates";
import { categoryBreakdown } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import type { State } from "@/domain/schema";
import { useSnapshot, useToday } from "@/client/react";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { Money, Notice, Progress } from "../../ui/controls";
import { useToast } from "../../ui/feedback";
import { Select } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";

function normalize(name: string): string {
  return name.trim().toLocaleLowerCase("ru");
}

/** Лимит категории; имена сравниваем без учёта регистра — так же, как при сохранении. */
function findLimit(state: State, name: string): Kopecks | null {
  const key = Object.keys(state.categoryLimits).find((k) => normalize(k) === normalize(name));
  return key === undefined ? null : state.categoryLimits[key];
}

/** Лимит трат по категории на месяц: задать, изменить или убрать. */
export function LimitSheet({ category }: { category?: string }) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();

  const options = useMemo(() => {
    const seen = new Set<string>();
    const list: string[] = [];
    for (const name of [...state.categories.flexible, ...state.categories.mandatory]) {
      const key = normalize(name);
      if (seen.has(key)) continue;
      seen.add(key);
      list.push(name);
    }
    return list;
  }, [state.categories]);

  const [selected, setSelected] = useState(
    () => category ?? options.find((name) => findLimit(state, name) === null) ?? options[0] ?? "",
  );
  const [amount, setAmount] = useState<Kopecks | null>(() => (selected ? findLimit(state, selected) : null));
  const [error, setError] = useState<string | null>(null);

  const month = monthKeyOf(today);
  const name = selected.trim();
  const limit = name ? findLimit(state, name) : null;
  const spent = useMemo(() => {
    if (!name) return 0;
    const rows = categoryBreakdown(state, firstDayOfMonth(month), today, "expense");
    return rows.find((r) => normalize(r.category) === normalize(name))?.amount ?? 0;
  }, [state, month, today, name]);

  const pick = (next: string) => {
    setSelected(next);
    setAmount(findLimit(state, next));
    setError(null);
  };

  const save = () => {
    if (!name) {
      setError("Сначала выберите категорию");
      return;
    }
    if (amount === null || amount <= 0) {
      setError("Введите сумму больше нуля");
      return;
    }
    if (dispatch({ type: "category.setLimit", name, amount })) {
      toast(`Лимит для «${name}»: ${formatMoney(amount)} в месяц`);
      close();
    }
  };

  const remove = () => {
    if (limit === null) return;
    const previous = limit;
    if (dispatch({ type: "category.setLimit", name, amount: null })) {
      close();
      toast(`Лимит для «${name}» убран`, {
        action: {
          label: "Вернуть",
          onClick: () => dispatch({ type: "category.setLimit", name, amount: previous }),
        },
      });
    }
  };

  const ratio = limit ? spent / limit : 0;
  // Сумму поменяли, но не сохранили.
  const dirty = name !== "" && amount !== limit;

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title="Лимит на месяц"
      footer={
        <div className="flex gap-2">
          {limit !== null && (
            <Button variant="secondary" icon="trash" onClick={remove}>
              Убрать лимит
            </Button>
          )}
          <Button className="flex-1" onClick={save} disabled={!name}>
            Сохранить
          </Button>
        </div>
      }
    >
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        {category !== undefined ? (
          <h3 className="text-xl font-semibold break-words">{category}</h3>
        ) : options.length > 0 ? (
          <Select label="Категория" value={selected} onChange={(e) => pick(e.target.value)}>
            {options.map((c) => {
              const existing = findLimit(state, c);
              return (
                <option key={c} value={c}>
                  {existing === null ? c : `${c} — лимит ${formatMoney(existing)}`}
                </option>
              );
            })}
          </Select>
        ) : (
          <Notice tone="warning">
            Категорий расходов пока нет. Добавьте их в настройках или вместе с первой операцией.
          </Notice>
        )}

        {name && (
          <div className="space-y-2 rounded-2xl bg-surface-2 px-4 py-3">
            <p className="text-sm text-muted">Потрачено {formatMonthIn(month)}</p>
            <p className="text-2xl font-semibold">
              <Money value={spent} tone={limit !== null && spent > limit ? "negative" : "default"} />
              {limit !== null && (
                <span className="text-base font-normal text-muted"> из {formatMoney(limit)}</span>
              )}
            </p>
            {limit !== null ? (
              <>
                <Progress
                  value={spent}
                  max={limit}
                  tone={ratio > 1 ? "negative" : ratio > 0.85 ? "warning" : "positive"}
                  label="Использовано лимита"
                />
                <p className="text-sm text-muted">
                  {spent > limit
                    ? `Лимит превышен на ${formatMoney(spent - limit)}`
                    : `Осталось ${formatMoney(limit - spent)}`}
                </p>
              </>
            ) : (
              <p className="text-sm text-muted">Лимита пока нет.</p>
            )}
          </div>
        )}

        <AmountInput
          label="Лимит в месяц"
          value={amount}
          onChange={(v) => {
            setAmount(v);
            setError(null);
          }}
          autoFocus={category !== undefined}
          error={error}
        />

        <p className="text-sm text-muted">
          Лимиты учитываются в предупреждениях на главном экране и в советах AI-помощника. Превышать их можно — приложение
          просто подскажет.
        </p>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}
