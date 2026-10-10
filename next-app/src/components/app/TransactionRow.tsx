"use client";

import type { Transaction } from "@/domain/schema";
import { balanceEffect } from "@/domain/metrics";
import { formatMoney, type Kopecks } from "@/domain/money";
import { useSnapshot } from "@/client/react";
import { Money } from "../ui/controls";
import { transactionAccountLabel } from "./accounts";
import { Icon, type IconName } from "../ui/Icon";

const TYPE_META: Record<Transaction["type"], { icon: IconName; label: string; tint: string }> = {
  income: { icon: "arrowDown", label: "Доход", tint: "bg-positive-soft text-positive" },
  expense: { icon: "arrowUp", label: "Расход", tint: "bg-surface-2 text-muted" },
  saving: { icon: "piggy", label: "Сбережения", tint: "bg-accent-soft text-accent" },
  adjustment: { icon: "wallet", label: "Корректировка", tint: "bg-warning-soft text-warning" },
  transfer: { icon: "swap", label: "Перевод между счетами", tint: "bg-accent-soft text-accent" },
};

/** Корректировка по долгу: деньги долга прошли через счёт (взяли или вернули), бюджет месяца не затронут. */
const LOAN_ADJUSTMENT_META: { icon: IconName; tint: string } = { icon: "handshake", tint: "bg-surface-2 text-muted" };

function isLoanAdjustment(tx: Transaction): boolean {
  return tx.type === "adjustment" && tx.loanId !== undefined;
}

export function transactionLabel(tx: Transaction): string {
  return tx.title || tx.category || TYPE_META[tx.type].label;
}

/** Подпись категории в строке: у корректировки по долгу вместо «Корректировка» — «Долг · через счёт». */
export function transactionCategoryLabel(tx: Transaction): string {
  return isLoanAdjustment(tx) ? "Долг · через счёт" : tx.category;
}

// Индекс строится один раз на каждый новый список операций (после правки store отдаёт новый массив).
const autoSavingsCache = new WeakMap<readonly Transaction[], ReadonlyMap<string, Kopecks>>();

/** Суммы автоотчислений в сбережения по id исходной операции (покупки или дохода). */
export function autoSavingsBySource(transactions: readonly Transaction[]): ReadonlyMap<string, Kopecks> {
  let index = autoSavingsCache.get(transactions);
  if (!index) {
    const sums = new Map<string, Kopecks>();
    for (const t of transactions) {
      if (t.linkedTo) sums.set(t.linkedTo, (sums.get(t.linkedTo) ?? 0) + t.amount);
    }
    index = sums;
    autoSavingsCache.set(transactions, index);
  }
  return index;
}

/**
 * Строка операции: иконка типа, название, категория/пометки и сумма со знаком.
 * Сумма — всегда влияние на деньги на счёте: пополнение сбережений показывается как минус («−5 000 ₽ · в сбережения»),
 * снятие — как плюс. Так строки сходятся с остатком на счёте и итогами.
 * Автоотчисление с операции — не отдельной строкой, а подписью у неё (дизайн-код, §7): под суммой значок копилки
 * и «+51 ₽»; слова «в копилку» видны на широком экране, на телефоне — только экранному диктору.
 */
export function TransactionRow({
  tx,
  onClick,
  subtitle,
}: {
  tx: Transaction;
  onClick?: () => void;
  subtitle?: string;
}) {
  const { state } = useSnapshot();
  const autoSaving = tx.linkedTo ? 0 : (autoSavingsBySource(state.transactions).get(tx.id) ?? 0);
  const loanAdjustment = isLoanAdjustment(tx);
  const meta: { icon: IconName; tint: string } = loanAdjustment ? LOAN_ADJUSTMENT_META : TYPE_META[tx.type];
  const effect = balanceEffect(tx);
  const savingNote = tx.type === "saving" ? (tx.amount > 0 ? "в сбережения" : "из сбережений") : null;
  const tags: string[] = [];
  // Счетов несколько — у операции видно, с какого счёта (у перевода — откуда и куда).
  const accountLabel = transactionAccountLabel(state, tx);
  if (savingNote) tags.push(savingNote);
  else if (loanAdjustment) tags.push(transactionCategoryLabel(tx));
  else if (tx.title && tx.category) tags.push(tx.category);
  if (accountLabel) tags.push(accountLabel);
  if (tx.type === "expense" && tx.mandatory) tags.push("обязательный");
  if (tx.templateId) tags.push("регулярный");
  if (tx.linkedTo) tags.push("автоматически");
  const secondary = subtitle ? [subtitle, accountLabel, savingNote].filter(Boolean).join(" · ") : tags.join(" · ");

  const content = (
    <>
      <span className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${meta.tint}`}>
        <Icon name={meta.icon} size={18} />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[15px] font-medium">{transactionLabel(tx)}</span>
        {secondary && <span className="block truncate text-sm text-muted">{secondary}</span>}
      </span>
      <span className="flex shrink-0 flex-col items-end">
        {tx.type === "transfer" ? (
          // Перевод между своими счетами деньги не меняет — сумма без знака.
          <Money value={tx.amount} className="text-[15px] font-semibold" />
        ) : (
          <Money
            value={effect}
            sign
            tone={tx.type === "income" ? "positive" : tx.type === "adjustment" ? "auto" : "default"}
            className="text-[15px] font-semibold"
          />
        )}
        {autoSaving !== 0 && (
          // Как кешбэк в банковских приложениях: под суммой, чтобы не отнимать место у названия и категории.
          <span className="inline-flex items-center gap-1 whitespace-nowrap text-[13px] text-muted">
            <Icon name="piggy" size={14} className="shrink-0" />
            <span className="tabular-nums">{formatMoney(autoSaving, { sign: true })}</span>
            <span className="sr-only sm:not-sr-only">{autoSaving > 0 ? "в копилку" : "из копилки"}</span>
          </span>
        )}
      </span>
    </>
  );

  if (!onClick) return <div className="flex items-center gap-3 py-2.5">{content}</div>;
  return (
    <button
      type="button"
      onClick={onClick}
      className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-2xl px-2 py-2.5 text-left transition hover:bg-surface-2"
    >
      {content}
    </button>
  );
}
