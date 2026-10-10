import { z } from "zod";
import { isValidIsoDate, type IsoDate } from "@/domain/dates";
import type { Overlay, Tab } from "../overlays";

/**
 * Команды нативного экрана (ios/App/App/Home) веб-слою. Модель Главной приносит готовые команды в строках
 * и кнопках — Swift возвращает их как есть; «add», «quick», «undo», «refresh» и «toastAction» Swift собирает сам.
 */
export type NativeCommand =
  | { type: "open"; overlay: Overlay }
  | { type: "tab"; tab: Tab }
  | { type: "rollover"; month: string; amount: number; decision: "saved" | "dismissed" }
  | { type: "guestImport"; accept: boolean }
  | { type: "legacyImport"; accept: boolean }
  | { type: "skipMandatory" }
  | { type: "quick"; key: string }
  | { type: "add"; draft: AddDraft }
  | { type: "undo"; txId: string }
  | { type: "refresh" }
  | { type: "toastAction"; id: number };

export interface AddDraft {
  kind: "income" | "expense";
  /** Копейки. */
  amount: number;
  category: string;
  title: string;
  date: IsoDate;
  /** Счёт (нет — основной). */
  accountId?: string;
}

/** Ответ на команду: для добавления — id операции (для «Отменить») и текст уведомления. */
export type CommandResult = { ok: true; txId?: string; message?: string } | { ok: false; error: string };

const TABS = ["home", "history", "plans", "goals", "analytics", "settings"] as const satisfies readonly Tab[];

const OVERLAY_KINDS = [
  "tx",
  "template",
  "goal",
  "goalMoney",
  "loan",
  "loanPayment",
  "savings",
  "balance",
  "explain",
  "planned",
  "ai",
  "auth",
  "limit",
  "review",
  "account",
  "transfer",
] as const satisfies readonly Overlay["kind"][];

const isoDate = z.string().refine((v) => isValidIsoDate(v), "Некорректная дата") as unknown as z.ZodType<IsoDate>;

export const commandSchema: z.ZodType<NativeCommand> = z.discriminatedUnion("type", [
  // Окна приходят из модели, которую построил этот же код, — проверяем только вид окна.
  z.object({ type: z.literal("open"), overlay: z.looseObject({ kind: z.enum(OVERLAY_KINDS) }) as unknown as z.ZodType<Overlay> }),
  z.object({ type: z.literal("tab"), tab: z.enum(TABS) }),
  z.object({
    type: z.literal("rollover"),
    month: z.string(),
    amount: z.number().int(),
    decision: z.enum(["saved", "dismissed"]),
  }),
  z.object({ type: z.literal("guestImport"), accept: z.boolean() }),
  z.object({ type: z.literal("legacyImport"), accept: z.boolean() }),
  z.object({ type: z.literal("skipMandatory") }),
  z.object({ type: z.literal("quick"), key: z.string().max(500) }),
  z.object({
    type: z.literal("add"),
    draft: z.object({
      kind: z.enum(["income", "expense"]),
      amount: z.number().int().positive().max(1e13),
      category: z.string().trim().min(1).max(100),
      title: z.string().max(200),
      date: isoDate,
      accountId: z.string().min(1).max(120).optional(),
    }),
  }),
  z.object({ type: z.literal("undo"), txId: z.string().min(1).max(100) }),
  z.object({ type: z.literal("refresh") }),
  z.object({ type: z.literal("toastAction"), id: z.number().int() }),
]);
