import { addDays, type IsoDate } from "@/domain/dates";
import type { Kopecks } from "@/domain/money";
import type { State } from "@/domain/schema";

export interface QuickPick {
  category: string;
  title: string;
  amount: Kopecks;
  mandatory: boolean;
}

/**
 * Частые недавние траты (за 60 дней, не меньше двух раз): на главной добавляются одним касанием,
 * в окне операции — заполняют форму.
 */
export function quickPicks(state: State, today: IsoDate, limit = 6): QuickPick[] {
  const from = addDays(today, -60);
  const counts = new Map<string, { pick: QuickPick; count: number; last: string }>();
  for (const tx of state.transactions) {
    if (tx.type !== "expense" || tx.templateId || tx.loanId || tx.date < from || tx.date > today) continue;
    const key = `${tx.category}|${tx.title}|${tx.amount}`;
    const entry = counts.get(key) ?? {
      pick: { category: tx.category, title: tx.title, amount: tx.amount, mandatory: Boolean(tx.mandatory) },
      count: 0,
      last: tx.date,
    };
    entry.count += 1;
    if (tx.date > entry.last) entry.last = tx.date;
    counts.set(key, entry);
  }
  return [...counts.values()]
    .filter((e) => e.count >= 2)
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, limit)
    .map((e) => e.pick);
}
