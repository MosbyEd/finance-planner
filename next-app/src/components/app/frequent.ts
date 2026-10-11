import type { State } from "@/domain/schema";

/**
 * Самые частые категории операций этого вида — по последним операциям (недавние важнее давних, если частота
 * равна). Только из списка категорий; не хватает — дополняется по порядку списка.
 */
export function frequentCategories(state: State, kind: "income" | "expense", list: readonly string[], limit = 8): string[] {
  const known = new Set(list);
  const counts = new Map<string, { count: number; last: number }>();
  let seen = 0;
  for (let i = state.transactions.length - 1; i >= 0 && seen < 400; i--) {
    const tx = state.transactions[i];
    if (tx.type !== kind || tx.linkedTo || !known.has(tx.category)) continue;
    seen++;
    const entry = counts.get(tx.category) ?? { count: 0, last: i };
    entry.count++;
    counts.set(tx.category, entry);
  }
  const top = [...counts.entries()].sort((a, b) => b[1].count - a[1].count || b[1].last - a[1].last).map(([c]) => c);
  for (const c of list) {
    if (top.length >= limit) break;
    if (!top.includes(c)) top.push(c);
  }
  return top.slice(0, limit);
}
