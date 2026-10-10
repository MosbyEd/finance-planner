import { applyActions, type Action, type TxInput } from "./actions";
import { emptyState } from "./defaults";
import type { State, Template, Transaction } from "./schema";

let counter = 0;
export function testId(prefix = "id"): string {
  counter += 1;
  return `${prefix}${counter}`;
}

export function stateWith(partial: Partial<State> = {}): State {
  return { ...emptyState(), ...partial };
}

export function tx(partial: Partial<Transaction> & Pick<Transaction, "type" | "amount" | "date">): Transaction {
  return {
    id: testId("tx"),
    category: partial.type === "income" ? "Зарплата" : "Продукты",
    title: "",
    note: "",
    ...(partial.type === "expense" ? { mandatory: false } : {}),
    ...partial,
  };
}

export function template(partial: Partial<Template> & Pick<Template, "kind" | "amount" | "dayOfMonth">): Template {
  return {
    id: testId("tpl"),
    title: partial.kind === "income" ? "Зарплата" : "Аренда",
    category: partial.kind === "income" ? "Зарплата" : "Аренда",
    active: true,
    startDate: "2026-01-01",
    note: "",
    ...partial,
  };
}

export function addTx(input: Partial<TxInput> & Pick<TxInput, "type" | "amount" | "date">): Action {
  return {
    type: "tx.add",
    tx: {
      id: testId("tx"),
      category: input.type === "income" ? "Премия" : "Продукты",
      title: "",
      note: "",
      mandatory: false,
      autoSaving: false,
      ...input,
    },
  };
}

export function run(state: State, ...actions: Action[]): State {
  return applyActions(state, actions);
}
