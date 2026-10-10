"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { z } from "zod";
import { proposalToActions, type AiOperation, type AiProposal } from "@/domain/ai";
import { formatDay, isValidIsoDate, type IsoDate } from "@/domain/dates";
import { formatMoney } from "@/domain/money";
import type { State } from "@/domain/schema";
import { ApiError, api, type AiChatMessage } from "@/client/api";
import { AppleAiError, askApple, pickAppleModel } from "@/client/appleAi";
import type { AppleModel } from "@/client/native";
import { newId, useSnapshot, useToday } from "@/client/react";
import { Button, IconButton } from "../../ui/Button";
import { EmptyState, Money, Notice, Segmented } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { controlClass } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";
import { plural } from "@/domain/text";

// ---------- модель чата ----------

/** fast и reasoning — DeepSeek на сервере; apple — модель Apple Intelligence (на телефоне или в Private Cloud Compute). */
type ChatMode = "fast" | "reasoning" | "apple";
type ProposalStatus = "pending" | "applied" | "dismissed";

interface UserMessage {
  id: string;
  role: "user";
  content: string;
}

interface AssistantMessage {
  id: string;
  role: "assistant";
  content: string;
  reasoning: string | null;
  proposal: AiProposal | null;
  skipped: number;
  status: ProposalStatus;
}

interface ErrorMessage {
  id: string;
  role: "error";
  content: string;
}

type ChatMessage = UserMessage | AssistantMessage | ErrorMessage;

interface ChatSnapshot {
  messages: ChatMessage[];
  mode: ChatMode;
  /** Время отправки запроса, на который ещё нет ответа. */
  pendingSince: number | null;
}

/** Ограничения API: до 20 сообщений, до 4000 символов в каждом, запрос до 100 КБ. */
const MAX_HISTORY = 20;
const MAX_CONTENT = 4000;
const MAX_REQUEST_BYTES = 90_000;

const QUICK_PROMPTS = [
  "Сколько можно тратить до зарплаты?",
  "Проанализируй мои траты за месяц",
  "Где я могу сэкономить?",
  "Помоги поставить лимиты по категориям",
  "Как быстрее закрыть долги?",
  "Составь план накоплений на цель",
];

const proposalSchema = z.object({
  operations: z.array(
    z.object({
      type: z.enum(["income", "expense"]),
      amount: z.number().int(),
      category: z.string(),
      title: z.string(),
      date: z.string().refine(isValidIsoDate),
      mandatory: z.boolean(),
    }),
  ),
  templates: z.array(
    z.object({
      type: z.enum(["income", "expense"]),
      amount: z.number().int(),
      category: z.string(),
      title: z.string(),
      dayOfMonth: z.number().int().min(1).max(31),
    }),
  ),
  limits: z.array(z.object({ category: z.string(), amount: z.number().int() })),
});

const storedMessageSchema = z.discriminatedUnion("role", [
  z.object({ id: z.string(), role: z.literal("user"), content: z.string() }),
  z.object({
    id: z.string(),
    role: z.literal("assistant"),
    content: z.string(),
    reasoning: z.string().nullable(),
    proposal: proposalSchema.nullable(),
    skipped: z.number().int(),
    status: z.enum(["pending", "applied", "dismissed"]),
  }),
  z.object({ id: z.string(), role: z.literal("error"), content: z.string() }),
]);

const storedChatSchema = z.object({
  mode: z.enum(["fast", "reasoning", "apple"]).catch("fast"),
  messages: z.array(z.unknown()),
});

/**
 * Новый чат — на модели Apple на телефоне: без интернета и без передачи данных. Где её нет (браузер,
 * выключена Apple Intelligence), окно само переключится на DeepSeek.
 */
const DEFAULT_MODE: ChatMode = "apple";

function storageKey(login: string): string {
  return `fp:ai-chat:${login}`;
}

function loadChat(key: string): Pick<ChatSnapshot, "messages" | "mode"> {
  try {
    const raw = globalThis.sessionStorage?.getItem(key);
    if (!raw) return { messages: [], mode: DEFAULT_MODE };
    const parsed = storedChatSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) return { messages: [], mode: DEFAULT_MODE };
    const messages: ChatMessage[] = [];
    for (const item of parsed.data.messages) {
      const message = storedMessageSchema.safeParse(item);
      if (message.success) messages.push(message.data);
    }
    // Страницу перезагрузили, пока ждали ответа, — предлагаем отправить вопрос снова.
    if (messages.at(-1)?.role === "user") {
      messages.push({ id: newId(), role: "error", content: "Ответ не пришёл: страница была перезагружена." });
    }
    return { messages, mode: parsed.data.mode };
  } catch {
    return { messages: [], mode: DEFAULT_MODE };
  }
}

function saveChat(key: string, chat: ChatSnapshot): void {
  try {
    const storage = globalThis.sessionStorage;
    if (!storage) return;
    if (!chat.messages.length) {
      storage.removeItem(key);
      return;
    }
    try {
      storage.setItem(key, JSON.stringify({ mode: chat.mode, messages: chat.messages }));
    } catch {
      // Не хватило места — сохраняем без рассуждений модели, они самые объёмные.
      const light = chat.messages.map((m) => (m.role === "assistant" ? { ...m, reasoning: null } : m));
      storage.setItem(key, JSON.stringify({ mode: chat.mode, messages: light }));
    }
  } catch {
    // sessionStorage недоступен (приватный режим) — чат живёт до перезагрузки страницы.
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

/**
 * Переписка одного пользователя. Живёт на уровне модуля, а не компонента:
 * если закрыть окно, пока помощник думает, ответ всё равно сохранится.
 */
class ChatSession {
  private snapshot: ChatSnapshot;
  private listeners = new Set<() => void>();
  private epoch = 0;

  constructor(private readonly key: string) {
    this.snapshot = { ...loadChat(key), pendingSince: null };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): ChatSnapshot => this.snapshot;

  private update(patch: Partial<ChatSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    saveChat(this.key, this.snapshot);
    for (const listener of this.listeners) listener();
  }

  setMode(mode: ChatMode): void {
    this.update({ mode });
  }

  /** mode — режим, который сейчас показан в окне (может отличаться от сохранённого, если тот недоступен). */
  send(text: string, today: IsoDate, state: State, mode: ChatMode): void {
    const content = text.trim().slice(0, MAX_CONTENT);
    if (!content || this.snapshot.pendingSince !== null) return;
    const messages = this.snapshot.messages.filter((m) => m.role !== "error");
    this.update({ messages: [...messages, { id: newId(), role: "user", content }] });
    void this.request(today, state, mode);
  }

  canRetry(): boolean {
    const messages = this.snapshot.messages.filter((m) => m.role !== "error");
    return this.snapshot.pendingSince === null && messages.at(-1)?.role === "user";
  }

  retry(today: IsoDate, state: State, mode: ChatMode): void {
    if (!this.canRetry()) return;
    this.update({ messages: this.snapshot.messages.filter((m) => m.role !== "error") });
    void this.request(today, state, mode);
  }

  setStatus(id: string, status: ProposalStatus): void {
    this.update({
      messages: this.snapshot.messages.map((m) => (m.id === id && m.role === "assistant" ? { ...m, status } : m)),
    });
  }

  clear(): void {
    this.epoch += 1;
    this.update({ messages: [], pendingSince: null });
  }

  /** state — данные бюджета на устройстве: модель Apple отвечает по ним, без сервера. */
  private async request(today: IsoDate, state: State, mode: ChatMode): Promise<void> {
    const epoch = this.epoch;
    this.update({ pendingSince: Date.now() });
    let reply: ChatMessage;
    try {
      const history = buildHistory(this.snapshot.messages);
      const response =
        mode === "apple"
          ? { ...(await askApple(history, state, today)), reasoning: null }
          : await api.aiChat(history, mode, today);
      reply = {
        id: newId(),
        role: "assistant",
        content: response.text,
        reasoning: response.reasoning?.trim() || null,
        proposal: response.proposal,
        skipped: response.skipped,
        status: "pending",
      };
    } catch (error) {
      reply = {
        id: newId(),
        role: "error",
        content:
          error instanceof ApiError || error instanceof AppleAiError
            ? error.message
            : "Не удалось получить ответ. Попробуйте ещё раз.",
      };
    }
    // Чат очистили (или вышли из аккаунта), пока ждали ответа.
    if (epoch !== this.epoch) return;
    this.update({ pendingSince: null, messages: [...this.snapshot.messages, reply] });
  }
}

const sessions = new Map<string, ChatSession>();

function getSession(login: string): ChatSession {
  const key = storageKey(login);
  let session = sessions.get(key);
  if (!session) {
    session = new ChatSession(key);
    sessions.set(key, session);
  }
  return session;
}

/** Забыть переписку (при выходе из аккаунта или его удалении). */
export function forgetAiChat(login: string): void {
  const key = storageKey(login);
  sessions.get(key)?.clear();
  sessions.delete(key);
  try {
    globalThis.sessionStorage?.removeItem(key);
  } catch {
    /* ignore */
  }
}


// ---------- связь ----------

function subscribeOnline(listener: () => void): () => void {
  window.addEventListener("online", listener);
  window.addEventListener("offline", listener);
  return () => {
    window.removeEventListener("online", listener);
    window.removeEventListener("offline", listener);
  };
}

/** Есть ли у устройства сеть. На сервере считаем, что есть. */
function useOnline(): boolean {
  return useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
}

const OFFLINE_TEXT = "Нет связи — помощник ответит, когда интернет вернётся";

/** Какая модель Apple доступна в этом приложении (null — нет; в браузере всегда null) и выяснено ли это уже. */
function useAppleModel(): { model: AppleModel | null; loading: boolean } {
  const [state, setState] = useState<{ model: AppleModel | null; loading: boolean }>({ model: null, loading: true });
  useEffect(() => {
    let cancelled = false;
    void pickAppleModel().then((picked) => {
      if (!cancelled) setState({ model: picked?.model ?? null, loading: false });
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

// ---------- окно ----------

export function AiChatSheet({ initialPrompt }: { initialPrompt?: string }) {
  const snapshot = useSnapshot();
  const online = useOnline();
  const apple = useAppleModel();
  const appleModel = apple.model;
  const { close, open } = useUi();

  // Без сети сервер мог не сообщить, включён ли AI, поэтому «недоступен» показываем только при связи.
  if (!snapshot.aiEnabled && online && !appleModel && !apple.loading) {
    return (
      <Sheet open onClose={close} title="AI-помощник">
        <EmptyState title="AI-помощник сейчас недоступен" text="Остальные функции работают как обычно." />
      </Sheet>
    );
  }

  if (snapshot.mode === "guest" || !snapshot.user) {
    return (
      <Sheet open onClose={close} title="AI-помощник">
        <EmptyState
          title="Войдите, чтобы спросить помощника"
          text="Помощник отвечает по данным вашего аккаунта, поэтому нужен вход. Данные, которые вы вели без входа, можно перенести в аккаунт."
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button icon="user" onClick={() => open({ kind: "auth", mode: "login" })}>
                Войти
              </Button>
              {snapshot.registrationOpen && (
                <Button variant="secondary" onClick={() => open({ kind: "auth", mode: "register" })}>
                  Создать аккаунт
                </Button>
              )}
            </div>
          }
        />
      </Sheet>
    );
  }

  return (
    <Chat
      key={snapshot.user.login}
      login={snapshot.user.login}
      initialPrompt={initialPrompt}
      online={online}
      appleModel={appleModel}
      appleLoading={apple.loading}
      deepseek={snapshot.aiEnabled}
    />
  );
}

function Chat({
  login,
  initialPrompt,
  online,
  appleModel,
  appleLoading,
  deepseek,
}: {
  login: string;
  initialPrompt?: string;
  online: boolean;
  appleModel: AppleModel | null;
  /** Ещё выясняем, есть ли модель Apple: до этого сохранённый режим «apple» не подменяем DeepSeek. */
  appleLoading: boolean;
  /** Включён ли на сервере DeepSeek. */
  deepseek: boolean;
}) {
  const [session] = useState(() => getSession(login));
  const snapshotChat = useSyncExternalStore(session.subscribe, session.getSnapshot, session.getSnapshot);
  // Выбранный режим недоступен (модель Apple выключили или DeepSeek отключён на сервере) — берём доступный.
  const fallbackMode: ChatMode = deepseek ? "fast" : "apple";
  const modeAvailable = snapshotChat.mode === "apple" ? appleModel !== null || appleLoading : deepseek;
  const chat = modeAvailable ? snapshotChat : { ...snapshotChat, mode: fallbackMode };
  const { state, sync, sessionExpired } = useSnapshot();
  const { close, open } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const confirm = useConfirm();
  const [input, setInput] = useState(initialPrompt ?? "");
  // Ответы, пришедшие при открытом окне, проявляются с анимацией; история при открытии — сразу.
  const [initialIds] = useState(() => new Set(snapshotChat.messages.map((m) => m.id)));
  const endRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const pending = chat.pendingSince !== null;
  // Модель на телефоне отвечает и без интернета.
  const canAsk = !(chat.mode === "apple" && appleLoading) && (online || (chat.mode === "apple" && appleModel === "device"));

  // Прокрутка к последнему сообщению: при открытии сразу, дальше — плавно.
  useEffect(() => {
    const smooth = scrolledOnce.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrolledOnce.current = true;
    endRef.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
  }, [chat.messages.length, pending]);

  const send = (text: string) => {
    if (pending || !canAsk || !text.trim()) return;
    session.send(text, today, state, chat.mode);
    setInput("");
  };

  const apply = (message: AssistantMessage) => {
    if (!message.proposal || message.status !== "pending") return;
    if (dispatch(proposalToActions(message.proposal, state, today, newId))) {
      session.setStatus(message.id, "applied");
      toast("Изменения применены");
    }
  };

  const clear = async () => {
    const ok = await confirm({
      title: "Очистить чат?",
      message: "Переписка удалится. Данные бюджета не изменятся.",
      confirmLabel: "Очистить",
      danger: true,
    });
    if (ok) session.clear();
  };

  const lastId = chat.messages.at(-1)?.id;

  return (
    <Sheet
      open
      onClose={close}
      title="AI-помощник"
      size="full"
      footer={
        <Composer
          value={input}
          onChange={setInput}
          onSend={() => send(input)}
          pending={pending}
          offline={!canAsk}
          mode={chat.mode}
          onModeChange={(mode) => session.setMode(mode)}
          appleModel={appleModel}
          deepseek={deepseek}
        />
      }
    >
      <div className="flex min-h-full flex-col gap-4">
        {!canAsk && !(chat.mode === "apple" && appleLoading) ? (
          <Notice tone="warning">
            <span role="status">{OFFLINE_TEXT}</span>
          </Notice>
        ) : chat.mode === "apple" ? (
          <Notice>
            {appleModel === "device"
              ? "Отвечает Apple Intelligence прямо на iPhone: данные не покидают телефон, интернет не нужен."
              : "Отвечает Apple Intelligence в Private Cloud Compute: данные не сохраняются и недоступны Apple."}
          </Notice>
        ) : sessionExpired ? (
          <Notice
            tone="negative"
            action={
              <Button size="sm" onClick={() => open({ kind: "auth", mode: "login" })}>
                Войти
              </Button>
            }
          >
            Сессия истекла — войдите снова, чтобы помощник мог ответить.
          </Notice>
        ) : (
          sync.pending > 0 && (
            <Notice tone="warning">Часть изменений ещё не отправлена на сервер — помощник их пока не видит.</Notice>
          )
        )}

        {chat.messages.length > 0 && (
          <div className="flex justify-end">
            <Button variant="ghost" icon="trash" disabled={pending} onClick={() => void clear()}>
              Очистить чат
            </Button>
          </div>
        )}

        {chat.messages.length === 0 && !pending ? (
          <Intro onPick={send} disabled={!canAsk} />
        ) : (
          <ol aria-live="polite" aria-relevant="additions" aria-label="Переписка с помощником" className="flex flex-col gap-3">
            {chat.messages.map((m) => (
              <li key={m.id} className="flex flex-col">
                {m.role === "user" && <UserBubble message={m} />}
                {m.role === "assistant" && (
                  <AssistantBubble
                    fresh={!initialIds.has(m.id)}
                    message={m}
                    today={today}
                    onApply={() => apply(m)}
                    onDismiss={() => session.setStatus(m.id, "dismissed")}
                  />
                )}
                {m.role === "error" && (
                  <ErrorBubble
                    message={m}
                    onRetry={m.id === lastId && canAsk && session.canRetry() ? () => session.retry(today, state, chat.mode) : undefined}
                  />
                )}
              </li>
            ))}
          </ol>
        )}

        {chat.pendingSince !== null && <TypingIndicator key={chat.pendingSince} since={chat.pendingSince} />}
        <div ref={endRef} />
        <SiriGlow active={pending} />
      </div>
    </Sheet>
  );
}

function Intro({ onPick, disabled }: { onPick: (prompt: string) => void; disabled: boolean }) {
  return (
    <div className="space-y-4">
      <div className="rounded-2xl bg-surface-2 p-4">
        <p className="font-medium">Спросите о своём бюджете</p>
        <p className="mt-1 text-sm text-muted">
          Помощник видит ваши операции, регулярные доходы и платежи, цели и долги и отвечает по ним. Если он предложит
          добавить операции или лимиты, вы сами решите, применять ли их.
        </p>
      </div>
      <div>
        <p className="mb-2 text-sm font-medium text-muted">Можно начать с вопроса:</p>
        <div className="flex flex-wrap gap-2">
          {QUICK_PROMPTS.map((prompt) => (
            <button
              key={prompt}
              type="button"
              disabled={disabled}
              onClick={() => onPick(prompt)}
              className="min-h-10 rounded-2xl border border-border bg-surface px-3.5 py-2 text-left text-sm transition hover:bg-surface-2 disabled:opacity-50 disabled:hover:bg-surface"
            >
              {prompt}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

// ---------- сообщения ----------

function UserBubble({ message }: { message: UserMessage }) {
  return (
    <div className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent px-4 py-2.5 text-[15px] text-accent-text">
      <span className="sr-only">Вы: </span>
      {message.content}
    </div>
  );
}

/** Шаг между словами: волна идёт не дольше ~1,4 с, сколько бы слов ни было. */
function wordStep(count: number): number {
  return Math.min(28, 1400 / Math.max(count, 1));
}

/** Текст ответа, который проявляется по словам из размытия, как у Siri. Пробелы и переносы остаются текстом. */
function RevealText({ text }: { text: string }) {
  const parts = text.split(/(\s+)/);
  const step = wordStep(parts.filter((x) => x && !/^\s+$/.test(x)).length);
  let index = 0;
  return (
    <>
      {parts.map((part, i) => {
        if (!part || /^\s+$/.test(part)) return part;
        const delay = Math.round(index++ * step);
        return (
          <span key={i} className="siri-word" style={{ ["--siri-delay" as string]: `${delay}ms` }}>
            {part}
          </span>
        );
      })}
    </>
  );
}

function AssistantBubble({
  message,
  fresh,
  today,
  onApply,
  onDismiss,
}: {
  message: AssistantMessage;
  /** Ответ только что пришёл — проявить с анимацией. */
  fresh: boolean;
  today: IsoDate;
  onApply: () => void;
  onDismiss: () => void;
}) {
  const words = message.content.split(/\s+/).filter(Boolean).length;
  // Карточка с предложением выезжает, когда текст почти проявился.
  const riseAfter = Math.round(words * wordStep(words)) + 250;
  return (
    <div className="flex max-w-[92%] flex-col gap-2 self-start">
      <div
        className={`whitespace-pre-wrap break-words rounded-2xl rounded-bl-md bg-surface-2 px-4 py-2.5 text-[15px] ${
          fresh ? "siri-outline" : ""
        }`}
      >
        <span className="sr-only">Помощник: </span>
        {fresh ? <RevealText text={message.content} /> : message.content}
      </div>
      {message.reasoning && (
        <details className="group px-1 text-sm">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-1 text-muted hover:text-text [&::-webkit-details-marker]:hidden">
            Ход рассуждений
            <Icon name="chevronDown" size={16} className="transition group-open:rotate-180" />
          </summary>
          <p className="whitespace-pre-wrap break-words rounded-2xl bg-surface-2 px-4 py-3 text-xs text-muted">
            {message.reasoning}
          </p>
        </details>
      )}
      {message.proposal && (
        <ProposalCard
          rise={fresh ? riseAfter : null}
          proposal={message.proposal}
          status={message.status}
          today={today}
          onApply={onApply}
          onDismiss={onDismiss}
        />
      )}
      {message.skipped > 0 && (
        <p className="px-1 text-xs text-muted">
          {message.skipped}{" "}
          {plural(message.skipped, [
            "предложение не распознано и пропущено",
            "предложения не распознаны и пропущены",
            "предложений не распознано и пропущено",
          ])}
        </p>
      )}
    </div>
  );
}

function ErrorBubble({ message, onRetry }: { message: ErrorMessage; onRetry?: () => void }) {
  return (
    <div className="flex max-w-[92%] flex-col gap-2 self-start rounded-2xl bg-negative-soft px-4 py-3 text-sm sm:flex-row sm:items-center">
      <p className="flex-1">
        <span className="sr-only">Ошибка: </span>
        {message.content}
      </p>
      {onRetry && (
        <Button variant="secondary" icon="undo" className="shrink-0" onClick={onRetry}>
          Повторить
        </Button>
      )}
    </div>
  );
}

/**
 * Свечение по краям экрана, пока помощник думает (как у Siri). Рисуется в body: внутри окна фиксированный
 * слой привязался бы к окну, а не к экрану. После ответа плавно гаснет и убирается.
 */
function SiriGlow({ active }: { active: boolean }) {
  const [mounted, setMounted] = useState(active);
  const [visible, setVisible] = useState(false);
  // Включили — сразу в разметку (видимость — со следующего кадра, чтобы сработал переход прозрачности).
  if (active && !mounted) setMounted(true);
  useEffect(() => {
    if (!mounted) return;
    const frame = requestAnimationFrame(() => setVisible(active));
    if (active) return () => cancelAnimationFrame(frame);
    const timer = setTimeout(() => setMounted(false), 750);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [active, mounted]);
  if (!mounted || typeof document === "undefined") return null;
  return createPortal(<div className="siri-glow" data-active={visible} aria-hidden="true" />, document.body);
}

function TypingIndicator({ since }: { since: number }) {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    const update = () => setSeconds(Math.max(0, Math.floor((Date.now() - since) / 1000)));
    const first = setTimeout(update, 0);
    const timer = setInterval(update, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [since]);
  return (
    <div
      role="status"
      className="flex items-center gap-2 self-start rounded-2xl rounded-bl-md bg-surface-2 px-4 py-3 text-sm text-muted"
    >
      <span className="siri-orb" aria-hidden="true" />
      <span className="siri-shimmer font-medium">Думаю…</span>
      <span className="tabular-nums" aria-hidden="true">
        {seconds} с
      </span>
    </div>
  );
}

// ---------- предложения помощника ----------

function operationLabel(op: AiOperation): string {
  if (op.type === "income") return "доход";
  return op.mandatory ? "обязательный расход" : "расход";
}

function recurringTitle(proposal: AiProposal): string {
  const incomes = proposal.templates.filter((t) => t.type === "income").length;
  if (incomes === 0) return "Регулярные платежи";
  if (incomes === proposal.templates.length) return "Регулярные доходы";
  return "Регулярные доходы и платежи";
}

function ProposalCard({
  rise,
  proposal,
  status,
  today,
  onApply,
  onDismiss,
}: {
  /** Задержка (мс), после которой карточка выезжает; null — показать сразу. */
  rise: number | null;
  proposal: AiProposal;
  status: ProposalStatus;
  today: IsoDate;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <section
      className={`rounded-2xl border border-border bg-surface p-4 ${rise !== null ? "siri-rise" : ""}`}
      style={rise !== null ? { ["--siri-delay" as string]: `${rise}ms` } : undefined}
      aria-label="Предложенные изменения"
    >
      <p className="text-sm font-semibold">Помощник предлагает изменения:</p>

      {proposal.operations.length > 0 && (
        <ProposalGroup title="Операции">
          {proposal.operations.map((op, i) => (
            <ProposalRow
              key={i}
              title={op.title || op.category}
              subtitle={`${formatDay(op.date, today)} · ${operationLabel(op)}${op.title ? ` · ${op.category}` : ""}`}
              amount={op.type === "income" ? op.amount : -op.amount}
            />
          ))}
        </ProposalGroup>
      )}

      {proposal.templates.length > 0 && (
        <ProposalGroup title={recurringTitle(proposal)}>
          {proposal.templates.map((t, i) => (
            <ProposalRow
              key={i}
              title={t.title || t.category}
              subtitle={`${t.type === "income" ? "доход" : "платёж"} каждое ${t.dayOfMonth}-е число · ${t.category}`}
              amount={t.type === "income" ? t.amount : -t.amount}
            />
          ))}
        </ProposalGroup>
      )}

      {proposal.limits.length > 0 && (
        <ProposalGroup title="Лимиты по категориям">
          {proposal.limits.map((l, i) => (
            <li key={i} className="flex items-center justify-between gap-3 py-1.5 text-[15px]">
              <span className="min-w-0 truncate">{l.category}</span>
              <span className="shrink-0 font-semibold tabular-nums">{formatMoney(l.amount)}/мес</span>
            </li>
          ))}
        </ProposalGroup>
      )}

      {status === "pending" && (
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onDismiss}>
            Отклонить
          </Button>
          <Button icon="check" className="flex-1" onClick={onApply}>
            Применить
          </Button>
        </div>
      )}
      {status === "applied" && <p className="mt-3 text-sm font-medium text-positive">Применено ✓</p>}
      {status === "dismissed" && <p className="mt-3 text-sm text-muted">Отклонено</p>}
    </section>
  );
}

function ProposalGroup({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-3">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{title}</p>
      <ul className="mt-1 divide-y divide-border">{children}</ul>
    </div>
  );
}

function ProposalRow({ title, subtitle, amount }: { title: string; subtitle: string; amount: number }) {
  return (
    <li className="flex items-center justify-between gap-3 py-1.5">
      <span className="min-w-0">
        <span className="block truncate text-[15px]">{title}</span>
        <span className="block text-xs text-muted">{subtitle}</span>
      </span>
      <Money value={amount} sign tone={amount > 0 ? "positive" : "default"} className="shrink-0 font-semibold" />
    </li>
  );
}

// ---------- поле ввода ----------

const MODE_HINTS: Record<ChatMode | "appleCloud", string> = {
  apple: "Apple Intelligence на телефоне, без интернета",
  appleCloud: "Apple Intelligence, Private Cloud Compute",
  fast: "DeepSeek, ответ за несколько секунд",
  reasoning: "DeepSeek, дольше — до 2–3 минут",
};

function Composer({
  value,
  onChange,
  onSend,
  pending,
  offline,
  mode,
  onModeChange,
  appleModel,
  deepseek,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  pending: boolean;
  offline: boolean;
  mode: ChatMode;
  onModeChange: (mode: ChatMode) => void;
  appleModel: AppleModel | null;
  deepseek: boolean;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
  const options: { value: ChatMode; label: string }[] = [
    ...(appleModel ? [{ value: "apple" as const, label: appleModel === "device" ? "iPhone" : "Apple" }] : []),
    ...(deepseek
      ? [
          { value: "fast" as const, label: "Быстро" },
          { value: "reasoning" as const, label: "Подробно" },
        ]
      : []),
  ];

  // Поле растёт вместе с текстом (до ~6 строк).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight + 2, 168)}px`;
  }, [value]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.shiftKey || e.nativeEvent.isComposing) return;
    // На телефоне Enter переносит строку, отправка — кнопкой.
    if (window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    onSend();
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSend();
      }}
    >
      <div className="flex items-end gap-2">
        <label htmlFor={id} className="sr-only">
          Сообщение помощнику
        </label>
        <textarea
          id={id}
          ref={ref}
          rows={1}
          value={value}
          maxLength={MAX_CONTENT}
          placeholder="Спросите о своём бюджете"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
          className={`${controlClass} block max-h-42 min-h-11 resize-none py-2.5 leading-6`}
        />
        <IconButton
          type="submit"
          icon="send"
          label={pending ? "Помощник отвечает" : offline ? "Нет связи" : "Отправить"}
          variant="primary"
          size={44}
          disabled={pending || offline || !value.trim()}
        />
      </div>
      {options.length > 1 && (
        <div className="flex items-center gap-3">
          <div className={`${options.length > 2 ? "w-64" : "w-48"} shrink-0`}>
            <Segmented label="Режим ответа" value={mode} onChange={onModeChange} options={options} />
          </div>
          <p className="min-w-0 text-xs text-muted">{MODE_HINTS[mode === "apple" && appleModel === "cloud" ? "appleCloud" : mode]}</p>
        </div>
      )}
    </form>
  );
}
