"use client";

import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import { createPortal } from "react-dom";
import { findAccount } from "@/domain/accounts";
import { proposalSize, proposalToActions, type AiOperation, type AiProposal } from "@/domain/ai";
import { diffDays, formatDay, todayLocal, type IsoDate } from "@/domain/dates";
import { formatMoney, parseAmount, type Kopecks } from "@/domain/money";
import type { State } from "@/domain/schema";
import { pickAppleModel } from "@/client/appleAi";
import { nativeSiriOrb, type AppleModel } from "@/client/native";
import { newId, useSnapshot, useToday } from "@/client/react";
import { Button, IconButton } from "../../ui/Button";
import { EmptyState, Money, Notice } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { controlClass, controlLookClass } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { templateRoute } from "../accounts";
import {
  ENGINE_LABEL,
  MAX_CONTENT,
  getChatStore,
  type AssistantMessage,
  type ChatStore,
  type ChatThread,
  type ErrorMessage,
  type ProposalStatus,
  type UserMessage,
} from "../ai/chatStore";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";
import { plural } from "@/domain/text";

export { forgetAiChat } from "../ai/chatStore";

const QUICK_PROMPTS = [
  "Сколько можно тратить до зарплаты?",
  "Проанализируй мои траты за месяц",
  "Где я могу сэкономить?",
  "Помоги поставить лимиты по категориям",
  "Как быстрее закрыть долги?",
  "Составь план накоплений на цель",
];

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

export function AiChatSheet({ initialPrompt, threadId }: { initialPrompt?: string; threadId?: string }) {
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
      threadId={threadId}
      online={online}
      apple={appleModel === "device"}
      deepseek={snapshot.aiEnabled}
    />
  );
}

function Chat({
  login,
  initialPrompt,
  threadId,
  online,
  apple,
  deepseek,
}: {
  login: string;
  initialPrompt?: string;
  /** Открыть этот чат (из уведомления или Dynamic Island). */
  threadId?: string;
  online: boolean;
  /** Есть модель Apple на телефоне — отвечает на вопросы без интернета. */
  apple: boolean;
  /** Включён ли на сервере DeepSeek. */
  deepseek: boolean;
}) {
  const [store] = useState(() => {
    const chatStore = getChatStore(login);
    if (threadId) chatStore.open(threadId);
    return chatStore;
  });
  const chats = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const { state, sync, sessionExpired } = useSnapshot();
  const { close, open } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const [input, setInput] = useState(initialPrompt ?? "");
  const [view, setView] = useState<"chat" | "history">("chat");
  const thread = chats.threads.find((t) => t.id === chats.currentId) ?? null;
  const messages = thread?.messages ?? [];
  // Ответы, пришедшие при открытом окне, проявляются с анимацией; история при открытии — сразу.
  const [initialIds] = useState(() => new Set(chats.threads.flatMap((t) => t.messages.map((m) => m.id))));
  const endRef = useRef<HTMLDivElement>(null);
  const scrolledOnce = useRef(false);
  const pendingHere = chats.pending !== null && chats.pending.threadId === thread?.id;
  const busy = chats.pending !== null;
  const waitingHere = chats.waiting !== null && chats.waiting === thread?.id;
  const canAsk = online ? deepseek || apple : apple || deepseek;

  // Что доступно — для выбора модели (в том числе, когда вопрос дождётся сети при закрытом окне).
  useEffect(() => {
    store.setAvailability({ online, deepseek, apple, state });
  }, [store, online, deepseek, apple, state]);
  // Открыто ли окно: ответ в открытый чат приходит без уведомления; после долгого перерыва — новый чат.
  useEffect(() => {
    store.setVisible(true);
    return () => store.setVisible(false);
  }, [store]);

  // Прокрутка к последнему сообщению: при открытии сразу, дальше — плавно.
  useEffect(() => {
    if (view !== "chat") return;
    const smooth = scrolledOnce.current && !window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    scrolledOnce.current = true;
    endRef.current?.scrollIntoView({ block: "end", behavior: smooth ? "smooth" : "auto" });
  }, [messages.length, pendingHere, view, thread?.id]);

  const send = (text: string) => {
    if (busy || !canAsk || !text.trim()) return;
    store.setAvailability({ online, deepseek, apple, state });
    store.send(text);
    setInput("");
  };

  const apply = (message: AssistantMessage, picked: AiProposal) => {
    if (!thread || !message.proposal || message.status !== "pending") return;
    const total = proposalSize(message.proposal);
    const chosen = proposalSize(picked);
    if (dispatch(proposalToActions(picked, state, today, newId))) {
      store.setStatus(thread.id, message.id, "applied");
      toast(chosen < total ? `Применено ${chosen} из ${total}` : "Изменения применены");
    }
  };

  const lastId = messages.at(-1)?.id;
  const historyCount = chats.threads.length;

  return (
    <Sheet
      open
      onClose={close}
      title={view === "history" ? "История чатов" : thread ? thread.title : "AI-помощник"}
      size="full"
      actions={
        view === "history" ? (
          <IconButton icon="chevronLeft" label="К чату" variant="secondary" size={40} onClick={() => setView("chat")} />
        ) : (
          <>
            {historyCount > 0 && (
              <IconButton icon="clock" label="История чатов" variant="secondary" size={40} onClick={() => setView("history")} />
            )}
            {thread && (
              <IconButton icon="compose" label="Новый чат" variant="secondary" size={40} disabled={busy} onClick={() => store.newChat()} />
            )}
          </>
        )
      }
      footer={
        view === "chat" ? (
          <Composer
            value={input}
            onChange={setInput}
            onSend={() => send(input)}
            pending={busy}
            offline={!canAsk}
            hint={
              !online && apple
                ? "Без интернета отвечает модель на iPhone; изменения отправятся, когда связь вернётся"
                : !online
                  ? "Без интернета вопрос отправится, когда связь вернётся"
                  : null
            }
          />
        ) : undefined
      }
    >
      {view === "history" ? (
        <HistoryView
          store={store}
          threads={chats.threads}
          currentId={chats.currentId}
          pendingId={chats.pending?.threadId ?? null}
          today={today}
          onOpen={(id) => {
            store.open(id);
            setView("chat");
          }}
          onNew={() => {
            store.newChat();
            setView("chat");
          }}
        />
      ) : (
        <div className="flex min-h-full flex-col gap-4">
          {!canAsk ? (
            <Notice tone="warning">
              <span role="status">{OFFLINE_TEXT}</span>
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
            online &&
            sync.pending > 0 && (
              <Notice tone="warning">Часть изменений ещё не отправлена на сервер — помощник их пока не видит.</Notice>
            )
          )}

          {busy && !pendingHere && (
            <Notice>Помощник ещё отвечает в другом чате — новый вопрос можно задать, когда он закончит.</Notice>
          )}

          {messages.length === 0 && !pendingHere ? (
            <Intro onPick={send} disabled={!canAsk || busy} />
          ) : (
            <ol aria-live="polite" aria-relevant="additions" aria-label="Переписка с помощником" className="flex flex-col gap-3">
              {messages.map((m) => (
                <li key={m.id} className="flex flex-col">
                  {m.role === "user" && <UserBubble message={m} />}
                  {m.role === "assistant" && (
                    <AssistantBubble
                      fresh={!initialIds.has(m.id)}
                      message={m}
                      today={today}
                      onApply={(picked) => apply(m, picked)}
                      onDismiss={() => thread && store.setStatus(thread.id, m.id, "dismissed")}
                    />
                  )}
                  {m.role === "error" && (
                    <ErrorBubble
                      message={m}
                      onRetry={thread && m.id === lastId && canAsk && store.canRetry(thread.id) ? () => store.retry(thread.id) : undefined}
                    />
                  )}
                </li>
              ))}
            </ol>
          )}

          {waitingHere && (
            <p role="status" className="self-start rounded-2xl bg-surface-2 px-4 py-3 text-sm text-muted">
              Отправится, когда появится интернет
            </p>
          )}
          {pendingHere && chats.pending && <TypingIndicator key={chats.pending.since} since={chats.pending.since} />}
          <div ref={endRef} />
          <SiriFloat active={pendingHere} />
        </div>
      )}
    </Sheet>
  );
}

// ---------- история ----------

function dayGroup(at: number, today: IsoDate): string {
  const day = todayLocal(new Date(at));
  if (day === today) return "Сегодня";
  if (diffDays(day, today) === 1) return "Вчера";
  return formatDay(day, today);
}

function lastAnswer(thread: ChatThread): string {
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i];
    if (m.role === "assistant") return m.content.replace(/\s+/g, " ");
  }
  return "";
}

function HistoryView({
  store,
  threads,
  currentId,
  pendingId,
  today,
  onOpen,
  onNew,
}: {
  store: ChatStore;
  threads: ChatThread[];
  currentId: string | null;
  pendingId: string | null;
  today: IsoDate;
  onOpen: (id: string) => void;
  onNew: () => void;
}) {
  const confirm = useConfirm();
  const [query, setQuery] = useState("");
  const needle = query.trim().toLocaleLowerCase("ru");
  const shown = needle
    ? threads.filter((t) => t.messages.some((m) => m.content.toLocaleLowerCase("ru").includes(needle)))
    : threads;
  const groups: { label: string; items: ChatThread[] }[] = [];
  for (const thread of shown) {
    const label = dayGroup(thread.updatedAt, today);
    const group = groups.at(-1);
    if (group?.label === label) group.items.push(thread);
    else groups.push({ label, items: [thread] });
  }

  const remove = async (thread: ChatThread) => {
    const ok = await confirm({
      title: `Удалить чат «${thread.title}»?`,
      message: "Переписка удалится. Данные бюджета не изменятся.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (ok) store.remove(thread.id);
  };

  return (
    <div className="space-y-4">
      <Button className="w-full" icon="plus" onClick={onNew} disabled={pendingId !== null}>
        Новый чат
      </Button>
      {threads.length > 5 && (
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск по чатам"
          aria-label="Поиск по чатам"
          className={`${controlClass} h-11`}
        />
      )}
      {groups.length === 0 && <p className="px-1 text-sm text-muted">Ничего не нашлось.</p>}
      {groups.map((group) => (
        <section key={group.label} aria-label={group.label} className="space-y-2">
          <h3 className="px-1 text-sm font-medium text-muted">{group.label}</h3>
          <ul className="space-y-2">
            {group.items.map((thread) => {
              const questions = thread.messages.filter((m) => m.role === "user").length;
              const answer = lastAnswer(thread);
              return (
                <li key={thread.id} className="flex items-stretch gap-1">
                  <button
                    type="button"
                    onClick={() => onOpen(thread.id)}
                    aria-current={thread.id === currentId || undefined}
                    className={`min-w-0 flex-1 rounded-2xl px-4 py-3 text-left transition ${
                      thread.id === currentId ? "bg-accent-soft" : "bg-surface-2 hover:bg-surface-3"
                    }`}
                  >
                    <span className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate font-medium">{thread.title}</span>
                      <span className="shrink-0 text-xs text-muted tabular-nums">
                        {new Date(thread.updatedAt).toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" })}
                      </span>
                    </span>
                    <span className="mt-0.5 block truncate text-sm text-muted">
                      {thread.id === pendingId ? "Помощник отвечает…" : answer || "Без ответа"}
                    </span>
                    <span className="mt-0.5 block text-xs text-muted">
                      {questions} {plural(questions, ["вопрос", "вопроса", "вопросов"])}
                    </span>
                  </button>
                  <IconButton
                    icon="trash"
                    label={`Удалить чат «${thread.title}»`}
                    variant="ghost"
                    size={44}
                    disabled={thread.id === pendingId}
                    onClick={() => void remove(thread)}
                  />
                </li>
              );
            })}
          </ul>
        </section>
      ))}
      <p className="px-1 text-xs text-muted">
        Чаты хранятся на этом устройстве. Новый чат начинается сам, если не открывать помощника больше шести часов.
      </p>
    </div>
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
    <div className="max-w-[85%] self-end whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent-fill px-4 py-2.5 text-[15px] text-on-accent">
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
  onApply: (picked: AiProposal) => void;
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
      {message.engine && <p className="-mt-1 px-1 text-xs text-muted">{ENGINE_LABEL[message.engine]}</p>}
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
        <details className="group px-1 text-xs text-muted">
          <summary className="flex min-h-8 cursor-pointer list-none items-center gap-1 hover:text-text [&::-webkit-details-marker]:hidden">
            {message.skipped}{" "}
            {plural(message.skipped, ["предложение пропущено", "предложения пропущены", "предложений пропущено"])} — почему
            <Icon name="chevronDown" size={14} className="transition group-open:rotate-180" />
          </summary>
          {message.skippedReasons?.length ? (
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {message.skippedReasons.map((reason, i) => (
                <li key={i}>{reason}</li>
              ))}
            </ul>
          ) : (
            <p className="mt-1">Помощник прислал команды, которые приложение не смогло понять.</p>
          )}
        </details>
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
 * «Шар» Siri из iOS 27, пока помощник думает: выплывает сверху. В приложении — нативный, из системного стекла;
 * в браузере (или в старой сборке без него) — CSS-шар, который рисуется в body, чтобы не привязаться к окну.
 */
function SiriFloat({ active }: { active: boolean }) {
  // null — ещё не знаем, есть ли нативный шар; true — показывает приложение; false — рисуем сами.
  const [native, setNative] = useState<boolean | null>(null);
  const [mounted, setMounted] = useState(active);
  const [visible, setVisible] = useState(false);
  if (active && !mounted) setMounted(true);

  useEffect(() => {
    let cancelled = false;
    void nativeSiriOrb(active).then((ok) => {
      if (!cancelled) setNative(ok);
    });
    return () => {
      cancelled = true;
    };
  }, [active]);
  // Окно закрыли, пока помощник думал, — нативный шар тоже убираем.
  useEffect(() => () => void nativeSiriOrb(false), []);

  useEffect(() => {
    if (!mounted || native !== false) return;
    const frame = requestAnimationFrame(() => setVisible(active));
    if (active) return () => cancelAnimationFrame(frame);
    const timer = setTimeout(() => setMounted(false), 700);
    return () => {
      cancelAnimationFrame(frame);
      clearTimeout(timer);
    };
  }, [active, mounted, native]);

  if (native !== false || !mounted || typeof document === "undefined") return null;
  return createPortal(<div className="siri-float" data-active={visible} aria-hidden="true" />, document.body);
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

type ProposalKey = keyof AiProposal;

interface ProposalItem {
  /** «группа:номер» — по нему отбираются выбранные пункты. */
  id: string;
  group: ProposalKey;
  index: number;
  title: string;
  subtitle: string;
  /** Сумма со знаком (null — без суммы, например пауза платежа). */
  amount: number | null;
  /** Подпись справа вместо суммы. */
  right?: string;
}

const GROUP_TITLES: Partial<Record<ProposalKey, string>> = {
  newGoals: "Новые цели",
  operations: "Операции",
  limits: "Лимиты по категориям",
  transfers: "Переводы между счетами",
  templateUpdates: "Изменения регулярных",
  balances: "Остатки счетов",
  goals: "Цели",
  loanPayments: "Платежи по долгам",
};

/** Пункты предложения для карточки: по ним пользователь отмечает, что применить. */
function proposalItems(proposal: AiProposal, state: State, today: IsoDate): ProposalItem[] {
  const accountName = (id: string | undefined) => (id ? (findAccount(state, id)?.name ?? "счёт") : null);
  const items: ProposalItem[] = [];
  proposal.newGoals.forEach((g, index) =>
    items.push({
      id: `newGoals:${index}`,
      group: "newGoals",
      index,
      title: g.name,
      subtitle: [g.dueDate ? `к ${formatDay(g.dueDate, today)}` : "без срока", accountName(g.accountId)].filter(Boolean).join(" · "),
      amount: null,
      right: g.targetAmount ? formatMoney(g.targetAmount) : "",
    }),
  );
  proposal.operations.forEach((op, index) =>
    items.push({
      id: `operations:${index}`,
      group: "operations",
      index,
      title: op.title || op.category,
      subtitle: [formatDay(op.date, today), operationLabel(op), op.title ? op.category : null, accountName(op.accountId)]
        .filter(Boolean)
        .join(" · "),
      amount: op.type === "income" ? op.amount : -op.amount,
    }),
  );
  proposal.templates.forEach((t, index) =>
    items.push({
      id: `templates:${index}`,
      group: "templates",
      index,
      title: t.title || t.category,
      subtitle: [
        `${t.type === "income" ? "доход" : "платёж"} каждое ${t.dayOfMonth}-е число`,
        t.category,
        t.newGoal ? `в новую цель «${t.newGoal}»` : templateRoute(state, t),
        t.untilDone ? (t.loanId ? "пока не закрыт долг" : "пока не накоплена цель") : t.endDate ? `до ${formatDay(t.endDate, today)}` : null,
      ]
        .filter(Boolean)
        .join(" · "),
      amount: t.type === "income" ? t.amount : -t.amount,
    }),
  );
  proposal.limits.forEach((l, index) =>
    items.push({ id: `limits:${index}`, group: "limits", index, title: l.category, subtitle: "лимит на месяц", amount: null, right: `${formatMoney(l.amount)}/мес` }),
  );
  proposal.transfers.forEach((t, index) =>
    items.push({
      id: `transfers:${index}`,
      group: "transfers",
      index,
      title: `${accountName(t.from)} → ${accountName(t.to)}`,
      subtitle: formatDay(t.date, today),
      amount: null,
      right: formatMoney(t.amount),
    }),
  );
  proposal.templateUpdates.forEach((u, index) => {
    const template = state.templates.find((t) => t.id === u.templateId);
    const changes: string[] = [];
    if (u.amount !== undefined) changes.push(`сумма ${formatMoney(u.amount)}`);
    if (u.dayOfMonth !== undefined) changes.push(`${u.dayOfMonth}-го числа`);
    if (u.active !== undefined) changes.push(u.active ? "возобновить" : "приостановить");
    if (u.accountId !== undefined) changes.push(`со счёта «${accountName(u.accountId)}»`);
    if (u.toAccountId) changes.push(`на «${accountName(u.toAccountId)}»`);
    else if (u.loanId) changes.push(`в счёт «${state.loans.find((l) => l.id === u.loanId)?.name ?? "долга"}»`);
    else if (u.goalId) changes.push(`в цель «${state.goals.find((g) => g.id === u.goalId)?.name ?? "цель"}»`);
    else if (u.toAccountId === null && u.loanId === null) changes.push("обычный платёж");
    if (u.untilDone) changes.push("пока не закрыт долг или не накоплена цель");
    else if (u.endDate) changes.push(`до ${formatDay(u.endDate, today)}`);
    else if (u.endDate === null && u.untilDone === false) changes.push("без срока");
    items.push({ id: `templateUpdates:${index}`, group: "templateUpdates", index, title: template?.title ?? "Регулярный платёж", subtitle: changes.join(" · "), amount: null });
  });
  proposal.balances.forEach((b, index) => {
    const account = findAccount(state, b.accountId);
    items.push({
      id: `balances:${index}`,
      group: "balances",
      index,
      title: account?.name ?? "Счёт",
      subtitle: account?.kind === "credit" ? "долг по карте сейчас" : "остаток сейчас",
      amount: null,
      right: formatMoney(Math.abs(b.actual)),
    });
  });
  proposal.goals.forEach((g, index) =>
    items.push({
      id: `goals:${index}`,
      group: "goals",
      index,
      title: state.goals.find((goal) => goal.id === g.goalId)?.name ?? "Цель",
      subtitle: g.amount > 0 ? "пополнить" : "снять",
      amount: g.amount,
    }),
  );
  proposal.loanPayments.forEach((p, index) =>
    items.push({
      id: `loanPayments:${index}`,
      group: "loanPayments",
      index,
      title: state.loans.find((l) => l.id === p.loanId)?.name ?? "Долг",
      subtitle: formatDay(p.date, today),
      amount: -p.amount,
    }),
  );
  return items;
}

/** Предложение только из отмеченных пунктов. */
export function pickProposal(proposal: AiProposal, selected: ReadonlySet<string>): AiProposal {
  const keep = <T,>(group: ProposalKey, list: T[]) => list.filter((_, i) => selected.has(`${group}:${i}`));
  return {
    operations: keep("operations", proposal.operations),
    templates: keep("templates", proposal.templates),
    limits: keep("limits", proposal.limits),
    transfers: keep("transfers", proposal.transfers),
    templateUpdates: keep("templateUpdates", proposal.templateUpdates),
    balances: keep("balances", proposal.balances),
    goals: keep("goals", proposal.goals),
    loanPayments: keep("loanPayments", proposal.loanPayments),
    newGoals: keep("newGoals", proposal.newGoals),
  };
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
  /** Применить только отмеченные пункты. */
  onApply: (picked: AiProposal) => void;
  onDismiss: () => void;
}) {
  const { state } = useSnapshot();
  const items = proposalItems(proposal, state, today);
  // По умолчанию отмечено всё; снятые пункты не применятся.
  const [unchecked, setUnchecked] = useState<ReadonlySet<string>>(() => new Set());
  const selected = new Set(items.filter((item) => !unchecked.has(item.id)).map((item) => item.id));
  const toggle = (id: string) =>
    setUnchecked((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const groups = [...new Set(items.map((item) => item.group))];
  const pending = status === "pending";
  // Сумма новой цели, которую модель не знала: человек вводит её здесь.
  const [goalText, setGoalText] = useState<Record<number, string>>({});
  const goalTarget = (index: number): Kopecks | null =>
    proposal.newGoals[index]?.targetAmount ?? parseAmount(goalText[index] ?? "");
  const missingTarget = proposal.newGoals.some((_, i) => selected.has(`newGoals:${i}`) && !goalTarget(i));
  const picked = (): AiProposal => {
    const chosen = pickProposal(proposal, selected);
    const targets = proposal.newGoals.map((g, i) => ({ ...g, targetAmount: goalTarget(i) }));
    return { ...chosen, newGoals: targets.filter((_, i) => selected.has(`newGoals:${i}`)) };
  };

  return (
    <section
      className={`rounded-2xl border border-border bg-surface p-4 ${rise !== null ? "siri-rise" : ""}`}
      style={rise !== null ? { ["--siri-delay" as string]: `${rise}ms` } : undefined}
      aria-label="Предложенные изменения"
    >
      <p className="text-sm font-semibold">
        Помощник предлагает изменения{pending && items.length > 1 ? " — отметьте, что применить:" : ":"}
      </p>

      {groups.map((group) => (
        <div key={group} className="mt-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted">
            {group === "templates" ? recurringTitle(proposal) : GROUP_TITLES[group]}
          </p>
          <ul className="mt-1 divide-y divide-border">
            {items
              .filter((item) => item.group === group)
              .map((item) => (
                <li key={item.id}>
                  <label className={`flex items-center gap-3 py-1.5 ${pending ? "cursor-pointer" : ""}`}>
                    {pending && items.length > 1 && (
                      <input
                        type="checkbox"
                        checked={selected.has(item.id)}
                        onChange={() => toggle(item.id)}
                        className="h-5 w-5 shrink-0 accent-[var(--accent-fill)]"
                        aria-label={`Применить: ${item.title}`}
                      />
                    )}
                    <span className={`min-w-0 flex-1 ${pending && !selected.has(item.id) ? "opacity-50" : ""}`}>
                      <span className="block truncate text-[15px]">{item.title}</span>
                      {item.subtitle && <span className="block text-xs text-muted">{item.subtitle}</span>}
                    </span>
                    {item.amount !== null ? (
                      <Money value={item.amount} sign tone={item.amount > 0 ? "positive" : "default"} className="shrink-0 font-semibold" />
                    ) : (
                      item.right && <span className="shrink-0 font-semibold tabular-nums">{item.right}</span>
                    )}
                  </label>
                  {item.group === "newGoals" && !proposal.newGoals[item.index]?.targetAmount && pending && (
                    <label className="mb-2 flex items-center gap-2 text-sm">
                      <span className="shrink-0 text-muted">Сколько нужно накопить</span>
                      <input
                        inputMode="decimal"
                        placeholder="Сумма, ₽"
                        value={goalText[item.index] ?? ""}
                        onChange={(e) => setGoalText((v) => ({ ...v, [item.index]: e.target.value }))}
                        aria-invalid={Boolean(goalText[item.index]) && !goalTarget(item.index)}
                        className={`${controlLookClass} h-10 min-w-0 flex-1 text-right tabular-nums`}
                      />
                    </label>
                  )}
                </li>
              ))}
          </ul>
        </div>
      ))}

      {pending && (
        <div className="mt-3 flex gap-2">
          <Button variant="secondary" className="flex-1" onClick={onDismiss}>
            Отклонить
          </Button>
          <Button icon="check" className="flex-1" disabled={selected.size === 0 || missingTarget} onClick={() => onApply(picked())}>
            {items.length > 1 && selected.size < items.length ? `Применить ${selected.size} из ${items.length}` : "Применить"}
          </Button>
        </div>
      )}
      {pending && missingTarget && <p className="mt-2 text-xs text-muted">Укажите сумму цели — без неё цель не создать.</p>}
      {status === "applied" && <p className="mt-3 text-sm font-medium text-positive">Применено ✓</p>}
      {status === "dismissed" && <p className="mt-3 text-sm text-muted">Отклонено</p>}
    </section>
  );
}

// ---------- поле ввода ----------

function Composer({
  value,
  onChange,
  onSend,
  pending,
  offline,
  hint,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  pending: boolean;
  offline: boolean;
  /** Подсказка под полем: кто ответит без интернета. */
  hint: string | null;
}) {
  const id = useId();
  const ref = useRef<HTMLTextAreaElement>(null);
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
      {hint && <p className="text-xs text-muted">{hint}</p>}
    </form>
  );
}
