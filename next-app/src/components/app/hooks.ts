"use client";

import { useCallback } from "react";
import type { Action } from "@/domain/actions";
import { formatMonthIn, type IsoDate } from "@/domain/dates";
import { linkedSavingId } from "@/domain/savings";
import type { Transaction } from "@/domain/schema";
import { useSnapshot, useStore, useToday } from "@/client/react";
import { useToast } from "../ui/feedback";

/** dispatch, который показывает ошибку уведомлением и возвращает true при успехе. */
export function useDispatch(): (actions: Action | Action[]) => boolean {
  const store = useStore();
  const toast = useToast();
  return useCallback(
    (actions) => {
      const result = store.dispatch(actions);
      if (!result.ok) toast(result.error, { kind: "error" });
      return result.ok;
    },
    [store, toast],
  );
}

/** Удаление операции с возможностью отменить в течение нескольких секунд. */
export function useDeleteTransaction(): (id: string) => void {
  const { state } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  return useCallback(
    (id) => {
      const tx = state.transactions.find((t) => t.id === id);
      if (!tx) return;
      const linked = state.transactions.find((t) => t.id === linkedSavingId(id));
      if (!dispatch({ type: "tx.delete", id })) return;
      const restored = linked ? [tx, linked] : [tx];
      toast(deletedMessage(tx, today), {
        action: {
          label: "Отменить",
          onClick: () =>
            dispatch({
              type: "tx.restore",
              transactions: restored,
              ...(tx.templateId && tx.occurrenceMonth
                ? { unskip: { templateId: tx.templateId, month: tx.occurrenceMonth } }
                : {}),
            }),
        },
      });
    },
    [state, today, dispatch, toast],
  );
}

/** Удалённое начисление регулярного платежа в том же месяце заново не появится — говорим об этом прямо. */
function deletedMessage(tx: Transaction, today: IsoDate): string {
  if (!tx.templateId || !tx.occurrenceMonth) return "Операция удалена";
  const when = formatMonthIn(tx.occurrenceMonth, today).replace(/^в/, "В");
  const what = tx.type === "income" ? "регулярный доход" : "регулярный платёж";
  return `Операция удалена. ${when} ${what} больше не добавится`;
}
