"use client";

import { useId, useState } from "react";
import { formatRelativeDay } from "@/domain/dates";
import type { State, Transaction } from "@/domain/schema";
import { plural } from "@/domain/text";
import { newId, useSnapshot, useToday } from "@/client/react";
import { Button, IconButton } from "../../ui/Button";
import { EmptyState, Money } from "../../ui/controls";
import { useConfirm } from "../../ui/feedback";
import { controlClass } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { isEditableTransaction } from "@/domain/actions";
import { transactionAccountLabel } from "../accounts";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";

/** Открыли операцию из списка на правку — после неё вернуться к списку (см. useReviewPrompt). */
export const reviewReturn = { pending: false };

/** Операции, добавленные автоматически (СМС банка, Siri) и ещё не проверенные. */
export function reviewQueue(state: State): Transaction[] {
  return state.transactions.filter((t) => t.review).sort((a, b) => b.date.localeCompare(a.date) || a.id.localeCompare(b.id));
}

/**
 * Новые операции из СМС и Siri: подтвердить списком, поправить категорию прямо здесь, открыть на правку или удалить.
 * Список фиксируется при открытии — строка с поправленной категорией не исчезает, а отмечается проверенной.
 */
export function ReviewSheet() {
  const { state } = useSnapshot();
  const { close, open } = useUi();
  const dispatch = useDispatch();
  const confirm = useConfirm();
  const today = useToday();
  const [ids, setIds] = useState(() => reviewQueue(state).map((t) => t.id));
  const rows = ids.map((id) => state.transactions.find((t) => t.id === id)).filter((t): t is Transaction => Boolean(t));
  const pending = rows.filter((t) => t.review);

  const confirmAll = () => {
    // Действие принимает до 500 id — длинный список отправляем частями, но одним изменением.
    const all = pending.map((t) => t.id);
    const chunks = Array.from({ length: Math.ceil(all.length / 500) }, (_, i) => all.slice(i * 500, i * 500 + 500));
    if (chunks.length) dispatch(chunks.map((chunk) => ({ type: "tx.reviewed" as const, ids: chunk })));
    close();
  };

  /** Операция ошибочно засчитана как регулярный платёж: сделать обычной, а плановое начисление вернуть. */
  const detach = (tx: Transaction) => {
    const id = newId();
    if (dispatch({ type: "occurrence.detach", id: tx.id, newId: id })) {
      setIds((list) => list.map((x) => (x === tx.id ? id : x)));
    }
  };

  const remove = async (tx: Transaction) => {
    const ok = await confirm({
      title: "Удалить операцию?",
      message: `«${tx.title || tx.category}» удалится вместе с автоотчислением в сбережения.`,
      confirmLabel: "Удалить",
      danger: true,
    });
    if (ok) dispatch({ type: "tx.delete", id: tx.id });
  };

  return (
    <Sheet
      open
      onClose={close}
      title="Новые операции"
      description="Добавлены из СМС банка и через Siri. Проверьте категории — приложение запомнит их для этих магазинов."
      size="lg"
      footer={
        <div className="flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={close}>
            Позже
          </Button>
          <Button icon="check" className="flex-1" onClick={confirmAll} disabled={!rows.length}>
            {pending.length ? "Всё верно" : "Готово"}
          </Button>
        </div>
      }
    >
      {rows.length === 0 ? (
        <EmptyState title="Всё проверено" text="Новых операций из СМС пока нет." />
      ) : (
        <ul className="divide-y divide-border" aria-label="Новые операции">
          {rows.map((tx) => (
            <ReviewRow
              key={tx.id}
              tx={tx}
              state={state}
              today={today}
              onCategory={(category) => dispatch({ type: "tx.update", id: tx.id, patch: { category } })}
              onEdit={() => {
                reviewReturn.pending = true;
                open({ kind: "tx", txId: tx.id });
              }}
              onDelete={() => void remove(tx)}
              onDetach={tx.templateId ? () => detach(tx) : undefined}
            />
          ))}
        </ul>
      )}
      {pending.length > 0 && pending.length < rows.length && (
        <p className="mt-3 text-sm text-muted">
          Осталось проверить {pending.length} {plural(pending.length, ["операцию", "операции", "операций"])}.
        </p>
      )}
    </Sheet>
  );
}

function categoryOptions(state: State, tx: Transaction): string[] {
  const list =
    tx.type === "income"
      ? state.categories.income
      : [...new Set([...state.categories.flexible, ...state.categories.mandatory])];
  return list.includes(tx.category) ? list : [tx.category, ...list];
}

function ReviewRow({
  tx,
  state,
  today,
  onCategory,
  onEdit,
  onDelete,
  onDetach,
}: {
  tx: Transaction;
  state: State;
  today: string;
  onCategory: (category: string) => void;
  onEdit: () => void;
  onDelete: () => void;
  /** Только у начислений регулярного платежа. */
  onDetach?: () => void;
}) {
  const selectId = useId();
  const signed = tx.type === "income" ? tx.amount : -Math.abs(tx.amount);
  const kind =
    tx.type === "saving"
      ? tx.amount > 0
        ? "в сбережения"
        : "из сбережений"
      : tx.templateId
        ? "регулярный, сумма по факту"
        : tx.type === "transfer"
          ? "перевод между счетами"
          : tx.type === "income"
            ? "доход"
            : "расход";
  return (
    <li className="flex flex-col gap-2 py-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <p className="truncate text-[15px] font-medium">{tx.title || tx.category}</p>
          <p className="text-xs text-muted">
            {formatRelativeDay(tx.date, today)} · {kind}
            {!tx.review && " · проверено ✓"}
          </p>
        </div>
        <Money value={signed} sign tone={signed > 0 ? "positive" : "default"} className="shrink-0 font-semibold" />
      </div>
      <div className="flex items-center gap-2">
        {tx.type === "income" || tx.type === "expense" ? (
          <>
            <label htmlFor={selectId} className="sr-only">
              Категория операции «{tx.title || tx.category}»
            </label>
            <select
              id={selectId}
              value={tx.category}
              onChange={(e) => onCategory(e.target.value)}
              className={`${controlClass} h-10 min-w-0 flex-1 py-0 text-sm`}
            >
              {categoryOptions(state, tx).map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </>
        ) : (
          <span className="min-w-0 flex-1 truncate text-sm text-muted">{transactionAccountLabel(state, tx) ?? ""}</span>
        )}
        {/* Править можно и перевод, и сбережения: сумму, дату, счета — и тип (покупка ↔ перевод). */}
        {isEditableTransaction(tx) && <IconButton icon="edit" label="Изменить операцию" onClick={onEdit} />}
        <IconButton icon="trash" label="Удалить операцию" onClick={onDelete} />
      </div>
      {onDetach && (
        <button type="button" onClick={onDetach} className="self-start text-sm font-medium text-accent">
          Это не регулярный платёж
        </button>
      )}
    </li>
  );
}
