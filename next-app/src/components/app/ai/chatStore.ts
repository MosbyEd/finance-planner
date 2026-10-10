"use client";

import { z } from "zod";
import { isActionRequest, type AiProposal } from "@/domain/ai";
import { isValidIsoDate, todayLocal, type IsoDate } from "@/domain/dates";
import type { State } from "@/domain/schema";
import { ApiError, api, type AiChatMessage } from "@/client/api";
import { AppleAiError, askApple } from "@/client/appleAi";
import { newId } from "@/client/react";

/**
 * Переписка с помощником: чаты (сессии) пользователя с историей. Вопросы и ответы одного разговора
 * собираются в один чат; новый начинается кнопкой «Новый чат» или сам — если помощника не открывали
 * больше SESSION_GAP. Живёт на уровне модуля, а не окна: закрыли окно, пока помощник думает, — ответ
 * всё равно сохранится в своём чате. Хранится на устройстве (localStorage).
 */

export type ProposalStatus = "pending" | "applied" | "dismissed";

/** Кто ответил: DeepSeek (быстрая или с рассуждением) или модель на iPhone. */
export type AiEngine = "fast" | "reasoning" | "apple";

export interface UserMessage {
  id: string;
  role: "user";
  content: string;
  at?: number;
}

export interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  reasoning: string | null;
  proposal: AiProposal | null;
  skipped: number;
  status: ProposalStatus;
  engine?: AiEngine;
  at?: number;
}

export interface ErrorMessage {
  id: string;
  role: "error";
  content: string;
}

export type ChatMessage = UserMessage | AssistantMessage | ErrorMessage;

export interface ChatThread {
  id: string;
  /** Первый вопрос — название чата в истории. */
  title: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface ChatStoreSnapshot {
  /** Новые сверху. */
  threads: ChatThread[];
  /** Открытый чат; null — новый, ещё без сообщений. */
  currentId: string | null;
  /** Вопрос, на который ждём ответа. */
  pending: { threadId: string; since: number } | null;
  /** Чат, чей вопрос ждёт интернета (просьба что-то изменить, а связи нет). */
  waiting: string | null;
}

/** Ограничения API: до 20 сообщений, до 4000 символов в каждом, запрос до 100 КБ. */
const MAX_HISTORY = 20;
export const MAX_CONTENT = 4000;
const MAX_REQUEST_BYTES = 90_000;
const MAX_THREADS = 60;
const MAX_MESSAGES = 200;
/** Рассуждения модели храним только в последних чатах — они самые объёмные. */
const REASONING_THREADS = 3;
/** Помощника не открывали дольше — следующий вопрос начинает новый чат. */
const SESSION_GAP_MS = 6 * 60 * 60 * 1000;

// ---------- хранение ----------

// Предложения, сохранённые до новых видов действий, читаются с пустыми списками.
const proposalSchema = z.object({
  operations: z.array(
    z.object({
      type: z.enum(["income", "expense"]),
      amount: z.number().int(),
      category: z.string(),
      title: z.string(),
      date: z.string().refine(isValidIsoDate),
      mandatory: z.boolean(),
      accountId: z.string().optional(),
    }),
  ),
  templates: z.array(
    z.object({
      type: z.enum(["income", "expense"]),
      amount: z.number().int(),
      category: z.string(),
      title: z.string(),
      dayOfMonth: z.number().int().min(1).max(31),
      accountId: z.string().optional(),
      toAccountId: z.string().optional(),
      loanId: z.string().optional(),
    }),
  ),
  limits: z.array(z.object({ category: z.string(), amount: z.number().int() })),
  transfers: z
    .array(z.object({ from: z.string(), to: z.string(), amount: z.number().int(), date: z.string().refine(isValidIsoDate) }))
    .default([]),
  templateUpdates: z
    .array(
      z.object({
        templateId: z.string(),
        amount: z.number().int().optional(),
        dayOfMonth: z.number().int().min(1).max(31).optional(),
        active: z.boolean().optional(),
        accountId: z.string().optional(),
        toAccountId: z.string().nullable().optional(),
        loanId: z.string().nullable().optional(),
      }),
    )
    .default([]),
  balances: z.array(z.object({ accountId: z.string(), actual: z.number().int() })).default([]),
  goals: z.array(z.object({ goalId: z.string(), amount: z.number().int() })).default([]),
  loanPayments: z
    .array(z.object({ loanId: z.string(), amount: z.number().int(), date: z.string().refine(isValidIsoDate) }))
    .default([]),
});

const storedMessageSchema = z.discriminatedUnion("role", [
  z.object({ id: z.string(), role: z.literal("user"), content: z.string(), at: z.number().optional() }),
  z.object({
    id: z.string(),
    role: z.literal("assistant"),
    content: z.string(),
    reasoning: z.string().nullable(),
    proposal: proposalSchema.nullable(),
    skipped: z.number().int(),
    status: z.enum(["pending", "applied", "dismissed"]),
    engine: z.enum(["fast", "reasoning", "apple"]).optional(),
    at: z.number().optional(),
  }),
  z.object({ id: z.string(), role: z.literal("error"), content: z.string() }),
]);

const storedThreadSchema = z.object({
  id: z.string(),
  title: z.string(),
  createdAt: z.number(),
  updatedAt: z.number(),
  messages: z.array(z.unknown()),
});

const storedSchema = z.object({ threads: z.array(z.unknown()), currentId: z.string().nullable() });

function readMessages(items: unknown[]): ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const item of items) {
    const message = storedMessageSchema.safeParse(item);
    if (message.success) messages.push(message.data);
  }
  return messages;
}

export function threadTitle(text: string): string {
  const line = text.trim().split("\n")[0].replace(/\s+/g, " ");
  return line.length > 60 ? `${line.slice(0, 57).trimEnd()}…` : line || "Без названия";
}

function storageKey(login: string): string {
  return `fp:ai-chats:${login}`;
}

/** Переписка прежнего формата (один чат на вкладку, в sessionStorage) — становится чатом в истории. */
function legacyThread(login: string): ChatThread | null {
  try {
    const raw = globalThis.sessionStorage?.getItem(`fp:ai-chat:${login}`);
    if (!raw) return null;
    globalThis.sessionStorage?.removeItem(`fp:ai-chat:${login}`);
    const parsed = z.object({ messages: z.array(z.unknown()) }).safeParse(JSON.parse(raw));
    const messages = parsed.success ? readMessages(parsed.data.messages) : [];
    const first = messages.find((m) => m.role === "user");
    if (!first) return null;
    const now = Date.now();
    return { id: newId(), title: threadTitle(first.content), createdAt: now, updatedAt: now, messages };
  } catch {
    return null;
  }
}

function load(login: string): Pick<ChatStoreSnapshot, "threads" | "currentId"> {
  let threads: ChatThread[] = [];
  let currentId: string | null = null;
  try {
    const raw = globalThis.localStorage?.getItem(storageKey(login));
    const parsed = raw ? storedSchema.safeParse(JSON.parse(raw)) : null;
    if (parsed?.success) {
      for (const item of parsed.data.threads) {
        const thread = storedThreadSchema.safeParse(item);
        if (!thread.success) continue;
        const messages = readMessages(thread.data.messages);
        // Приложение закрыли, пока ждали ответа, — предлагаем отправить вопрос снова.
        if (messages.at(-1)?.role === "user") {
          messages.push({ id: newId(), role: "error", content: "Ответ не пришёл: приложение было закрыто." });
        }
        threads.push({ ...thread.data, messages });
      }
      currentId = parsed.data.currentId;
    }
  } catch {
    threads = [];
  }
  const legacy = legacyThread(login);
  if (legacy) {
    threads = [legacy, ...threads];
    currentId = legacy.id;
  }
  if (currentId && !threads.some((t) => t.id === currentId)) currentId = null;
  return { threads, currentId };
}

function save(login: string, snapshot: ChatStoreSnapshot): void {
  const storage = (() => {
    try {
      return globalThis.localStorage ?? null;
    } catch {
      return null;
    }
  })();
  if (!storage) return;
  const key = storageKey(login);
  const write = (threads: ChatThread[]) => storage.setItem(key, JSON.stringify({ threads, currentId: snapshot.currentId }));
  const lean = (keepReasoning: number) =>
    snapshot.threads.map((t, i) =>
      i < keepReasoning ? t : { ...t, messages: t.messages.map((m) => (m.role === "assistant" && m.reasoning ? { ...m, reasoning: null } : m)) },
    );
  try {
    write(lean(REASONING_THREADS));
  } catch {
    // Не хватило места: без рассуждений, затем без самых старых чатов.
    let threads = lean(0);
    while (threads.length) {
      try {
        write(threads);
        return;
      } catch {
        threads = threads.slice(0, Math.max(0, threads.length - 5));
      }
    }
  }
}

/** История для API: последние сообщения пользователя и помощника, в пределах лимитов запроса. */
function buildHistory(messages: ChatMessage[]): AiChatMessage[] {
  const history = messages
    .filter((m): m is UserMessage | AssistantMessage => m.role === "user" || m.role === "assistant")
    .slice(-MAX_HISTORY)
    .map(({ role, content }) => ({ role, content: content.slice(0, MAX_CONTENT) }));
  const encoder = new TextEncoder();
  while (history.length > 1 && encoder.encode(JSON.stringify(history)).length > MAX_REQUEST_BYTES) history.shift();
  return history;
}

// ---------- кто отвечает ----------

/** Что доступно сейчас: интернет, DeepSeek на сервере, модель Apple на телефоне, данные бюджета для неё. */
export interface AiAvailability {
  online: boolean;
  deepseek: boolean;
  apple: boolean;
  state: State;
}

/**
 * Модель выбирает приложение: с интернетом — DeepSeek (сервер сам решает, быстрая или с рассуждением);
 * без интернета вопросы отвечает модель на iPhone, а просьбы что-то изменить ждут связи — маленькая
 * модель их собирает ненадёжно (проверено на одинаковых данных).
 */
export type Route = "deepseek" | "apple" | "wait" | "unavailable";

export function routeQuestion(question: string, a: Pick<AiAvailability, "online" | "deepseek" | "apple">): Route {
  if (a.online && a.deepseek) return "deepseek";
  if (a.apple && (!isActionRequest(question) || !a.deepseek)) return "apple";
  if (a.deepseek) return "wait";
  return "unavailable";
}

// ---------- хранилище ----------

type ReplyListener = (threadId: string, message: AssistantMessage | ErrorMessage) => void;

export class ChatStore {
  private snapshot: ChatStoreSnapshot;
  private listeners = new Set<() => void>();
  private replyListeners = new Set<ReplyListener>();
  private epoch = 0;
  private availability: AiAvailability | null = null;
  /** Сколько окон чата открыто сейчас: ответ в открытый чат не требует уведомления. */
  private visible = 0;

  constructor(private readonly login: string) {
    this.snapshot = { ...load(login), pending: null, waiting: null };
    if (typeof window !== "undefined") window.addEventListener("online", this.onOnline);
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChatStoreSnapshot => this.snapshot;

  /** Ответ пришёл: для уведомления, если чат сейчас не открыт. */
  onReply(listener: ReplyListener): () => void {
    this.replyListeners.add(listener);
    return () => {
      this.replyListeners.delete(listener);
    };
  }

  isVisible(): boolean {
    return this.visible > 0;
  }

  /** Окно чата открылось (true) или закрылось. Открыли после долгого перерыва — начинаем новый чат. */
  setVisible(open: boolean): void {
    this.visible = Math.max(0, this.visible + (open ? 1 : -1));
    if (!open) return;
    const current = this.current();
    if (current && !this.snapshot.pending && Date.now() - current.updatedAt > SESSION_GAP_MS) this.update({ currentId: null });
  }

  setAvailability(availability: AiAvailability): void {
    this.availability = availability;
  }

  current(): ChatThread | null {
    return this.snapshot.threads.find((t) => t.id === this.snapshot.currentId) ?? null;
  }

  private update(patch: Partial<ChatStoreSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    save(this.login, this.snapshot);
    for (const listener of this.listeners) listener();
  }

  private patchThread(id: string, change: (thread: ChatThread) => ChatThread, bump = true): void {
    const threads = this.snapshot.threads.map((t) => (t.id === id ? change(t) : t));
    const changed = threads.find((t) => t.id === id);
    // Чат, в котором что-то произошло, — наверх истории.
    const ordered = bump && changed ? [changed, ...threads.filter((t) => t.id !== id)] : threads;
    this.update({ threads: ordered });
  }

  newChat(): void {
    if (this.snapshot.pending) return;
    this.update({ currentId: null });
  }

  open(id: string): void {
    if (this.snapshot.threads.some((t) => t.id === id)) this.update({ currentId: id });
  }

  remove(id: string): void {
    if (this.snapshot.pending?.threadId === id) this.epoch += 1;
    this.update({
      threads: this.snapshot.threads.filter((t) => t.id !== id),
      currentId: this.snapshot.currentId === id ? null : this.snapshot.currentId,
      pending: this.snapshot.pending?.threadId === id ? null : this.snapshot.pending,
      waiting: this.snapshot.waiting === id ? null : this.snapshot.waiting,
    });
  }

  clearAll(): void {
    this.epoch += 1;
    this.update({ threads: [], currentId: null, pending: null, waiting: null });
  }

  dispose(): void {
    if (typeof window !== "undefined") window.removeEventListener("online", this.onOnline);
  }

  send(text: string): void {
    const content = text.trim().slice(0, MAX_CONTENT);
    if (!content || this.snapshot.pending) return;
    const message: UserMessage = { id: newId(), role: "user", content, at: Date.now() };
    const current = this.current();
    let threadId: string;
    if (current) {
      threadId = current.id;
      this.patchThread(threadId, (t) => ({
        ...t,
        updatedAt: Date.now(),
        messages: [...t.messages.filter((m) => m.role !== "error"), message].slice(-MAX_MESSAGES),
      }));
    } else {
      const now = Date.now();
      const thread: ChatThread = { id: newId(), title: threadTitle(content), createdAt: now, updatedAt: now, messages: [message] };
      threadId = thread.id;
      this.update({ threads: [thread, ...this.snapshot.threads].slice(0, MAX_THREADS), currentId: thread.id });
    }
    void this.request(threadId);
  }

  canRetry(threadId: string): boolean {
    const thread = this.snapshot.threads.find((t) => t.id === threadId);
    const messages = thread?.messages.filter((m) => m.role !== "error") ?? [];
    return !this.snapshot.pending && this.snapshot.waiting !== threadId && messages.at(-1)?.role === "user";
  }

  retry(threadId: string): void {
    if (!this.canRetry(threadId)) return;
    this.patchThread(threadId, (t) => ({ ...t, messages: t.messages.filter((m) => m.role !== "error") }), false);
    void this.request(threadId);
  }

  setStatus(threadId: string, messageId: string, status: ProposalStatus): void {
    this.patchThread(
      threadId,
      (t) => ({ ...t, messages: t.messages.map((m) => (m.id === messageId && m.role === "assistant" ? { ...m, status } : m)) }),
      false,
    );
  }

  private onOnline = (): void => {
    const waiting = this.snapshot.waiting;
    if (waiting && !this.snapshot.pending) void this.request(waiting);
  };

  private async request(threadId: string): Promise<void> {
    const thread = this.snapshot.threads.find((t) => t.id === threadId);
    if (!thread) return;
    const history = buildHistory(thread.messages);
    const question = history.at(-1)?.content ?? "";
    const availability = this.availability;
    const online = typeof navigator === "undefined" ? true : navigator.onLine;
    const route = routeQuestion(question, {
      online,
      deepseek: availability?.deepseek ?? true,
      apple: availability?.apple ?? false,
    });
    if (route === "wait") {
      this.update({ waiting: threadId });
      return;
    }
    const epoch = this.epoch;
    this.update({ pending: { threadId, since: Date.now() }, waiting: null });
    let reply: AssistantMessage | ErrorMessage;
    try {
      if (route === "unavailable") throw new AppleAiError("Помощник сейчас недоступен.");
      const today = todayLocal();
      if (route === "apple") {
        if (!availability) throw new AppleAiError("Помощник ещё не готов — откройте его окно.");
        const response = await askApple(history, availability.state, today);
        // Изменения от модели на телефоне не принимаем: она собирает их ненадёжно.
        reply = assistant(response.text, null, null, 0, "apple");
      } else {
        const response = await api.aiChat(history, "auto", today);
        const engine: AiEngine = /reason/i.test(response.model) ? "reasoning" : "fast";
        reply = assistant(response.text, response.reasoning?.trim() || null, response.proposal, response.skipped, engine);
      }
    } catch (error) {
      reply = {
        id: newId(),
        role: "error",
        content:
          error instanceof ApiError || error instanceof AppleAiError ? error.message : "Не удалось получить ответ. Попробуйте ещё раз.",
      };
    }
    // Чат удалили (или вышли из аккаунта), пока ждали ответа.
    if (epoch !== this.epoch) return;
    this.snapshot = { ...this.snapshot, pending: null };
    this.patchThread(threadId, (t) => ({ ...t, updatedAt: Date.now(), messages: [...t.messages, reply].slice(-MAX_MESSAGES) }));
    for (const listener of this.replyListeners) listener(threadId, reply);
  }
}

function assistant(
  content: string,
  reasoning: string | null,
  proposal: AiProposal | null,
  skipped: number,
  engine: AiEngine,
): AssistantMessage {
  return { id: newId(), role: "assistant", content, reasoning, proposal, skipped, status: "pending", engine, at: Date.now() };
}

const stores = new Map<string, ChatStore>();

export function getChatStore(login: string): ChatStore {
  let store = stores.get(login);
  if (!store) {
    store = new ChatStore(login);
    stores.set(login, store);
  }
  return store;
}

/** Забыть переписку (при выходе из аккаунта или его удалении). */
export function forgetAiChat(login: string): void {
  stores.get(login)?.clearAll();
  stores.get(login)?.dispose();
  stores.delete(login);
  try {
    globalThis.localStorage?.removeItem(storageKey(login));
    globalThis.sessionStorage?.removeItem(`fp:ai-chat:${login}`);
  } catch {
    /* ignore */
  }
}

export const ENGINE_LABEL: Record<AiEngine, string> = {
  fast: "DeepSeek",
  reasoning: "DeepSeek · с рассуждением",
  apple: "Модель на iPhone · без интернета",
};

export type { IsoDate };
