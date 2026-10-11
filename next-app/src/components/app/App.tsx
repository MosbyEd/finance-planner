"use client";

import { useEffect, useRef, useState } from "react";
import { dueOccurrences } from "@/domain/recurring";
import { FinanceStore } from "@/client/store";
import { StoreProvider, useSnapshot, useStore, useToday } from "@/client/react";
import { storage } from "@/client/storage";
import { pickAppleModel } from "@/client/appleAi";
import { onNotificationTap, syncNotifications } from "@/client/notifications";
import { isNativeApp } from "@/client/runtime";
import { registerServiceWorker } from "@/client/sw";
import { IconButton } from "../ui/Button";
import { ConfirmProvider, ToastProvider, useToast } from "../ui/feedback";
import { Icon, type IconName } from "../ui/Icon";
import { Analytics } from "../screens/Analytics";
import { Dashboard } from "../screens/Dashboard";
import { Goals } from "../screens/Goals";
import { History } from "../screens/History";
import { Plans } from "../screens/Plans";
import { Settings } from "../screens/Settings";
import { useDispatch } from "./hooks";
import { OverlayHost } from "./OverlayHost";
import { forgetAiChat, getChatStore } from "./ai/chatStore";
import { useWhatsNewPrompt } from "./sheets/WhatsNewSheet";
import { UiProvider, useUi, type Tab } from "./overlays";
import { useNativeHome, useNativeShell } from "./native/useNativeHome";
import { useNativeBridge } from "./useNativeBridge";
import { useNativeTabBar } from "./useNativeTabBar";
import { useReviewPrompt } from "./useReviewPrompt";

/** Вкладки панели. Аналитика открывается кнопкой в шапке (там, где раньше были настройки). */
const TABS: { id: Exclude<Tab, "analytics">; label: string; icon: IconName }[] = [
  { id: "home", label: "Главная", icon: "home" },
  { id: "history", label: "История", icon: "list" },
  { id: "plans", label: "Регулярные", icon: "repeat" },
  { id: "goals", label: "Цели", icon: "target" },
  { id: "settings", label: "Настройки", icon: "settings" },
];

/** Заголовок в шапке: на главной — название приложения, в остальных разделах — название раздела. */
const SCREEN_TITLES: Record<Tab, string> = {
  home: "Бюджет",
  history: "История",
  plans: "Регулярные",
  goals: "Цели",
  analytics: "Аналитика",
  settings: "Настройки",
};

export function App() {
  const [store] = useState(() => new FinanceStore());
  return (
    <StoreProvider store={store}>
      <ToastProvider>
        <ConfirmProvider>
          <UiProvider>
            <Shell />
          </UiProvider>
        </ConfirmProvider>
      </ToastProvider>
    </StoreProvider>
  );
}

function Shell() {
  const store = useStore();
  const snapshot = useSnapshot();
  const toast = useToast();
  const { tab, setTab, open } = useUi();

  useEffect(() => store.onSignOut(forgetAiChat), [store]);

  // Нажали на уведомление: ответ помощника — открыть его чат, «Бюджет обновлён» — «Что нового».
  useEffect(
    () =>
      onNotificationTap((extra) => {
        const data = extra && typeof extra === "object" ? (extra as { kind?: unknown; threadId?: unknown }) : {};
        if (data.kind === "ai") open({ kind: "ai", threadId: typeof data.threadId === "string" ? data.threadId : undefined });
        else if (data.kind === "whatsNew") open({ kind: "whatsNew" });
      }),
    [open],
  );

  // Переписка с помощником: в приложении — сразу забрать ответы, пришедшие в фоне; в браузере (там нет
  // уведомлений системы) — подсказать, что ответ готов, если чат закрыт.
  const login = snapshot.user?.login;
  useEffect(() => {
    if (!login) return;
    const chat = getChatStore(login);
    if (isNativeApp()) return;
    return chat.onReply((threadId, message) => {
      if (chat.isVisible()) return;
      toast(message.role === "error" ? "Помощник не ответил" : "Ответ помощника готов", {
        action: { label: "Открыть", onClick: () => open({ kind: "ai", threadId }) },
      });
    });
  }, [login, toast, open]);

  useWhatsNewPrompt(snapshot.phase === "ready");

  useEffect(() => {
    store.setNotifier((message, kind) => toast(message, { kind }));
    void store.init();
    const resume = () => void store.resume();
    const onVisible = () => {
      if (document.visibilityState === "visible") void store.resume();
    };
    window.addEventListener("online", resume);
    window.addEventListener("focus", resume);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("online", resume);
      window.removeEventListener("focus", resume);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [store, toast]);

  // Запоминаем вкладку между запусками. Аналитику не восстанавливаем: её нет на панели вкладок,
  // и в iOS-приложении панель показывала бы одну вкладку, а на экране оставалась бы аналитика.
  useEffect(() => {
    const saved = storage.get("fp:tab") as Tab | null;
    if (saved && saved !== "home" && TABS.some((t) => t.id === saved)) setTab(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при запуске
  }, []);
  useEffect(() => {
    storage.set("fp:tab", tab);
  }, [tab]);

  useRecurringSync();
  useNotificationSync();
  useNativeBridge();
  useReviewPrompt();
  const appleAi = useAppleAiAvailable();
  // В iOS-приложении Главная — нативная (SwiftUI), панель вкладок — системная; интерфейс считает данные для неё
  // и рисует остальные вкладки и окна.
  const nativeShell = useNativeShell();
  useNativeHome(nativeShell, snapshot.aiEnabled || appleAi);
  const nativeHome = nativeShell && tab === "home";
  useEffect(() => {
    document.documentElement.classList.toggle("native-home", nativeHome);
  }, [nativeHome]);
  // В iOS-приложении панель вкладок и «+» — нативные, из системного стекла Liquid Glass.
  const nativeBar = useNativeTabBar({
    enabled: snapshot.phase === "ready",
    tabs: TABS,
    tab,
    showAdd: tab === "home" || tab === "history",
    onSelect: setTab,
    onAdd: () => open({ kind: "tx" }),
  });

  // Офлайн-оболочка (только в production: в разработке кэш мешал бы горячей перезагрузке).
  useEffect(() => registerServiceWorker(), []);

  // Под нативной Главной — пустая прозрачная страница: видны только окна, открытые с неё.
  if (nativeHome) return <OverlayHost />;
  if (snapshot.phase === "loading") return <Splash />;

  const showAdd = tab === "home" || tab === "history";
  const activeTabIndex = TABS.findIndex((t) => t.id === tab);

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      {/* Шапка из стекла: содержимое под ней размывается. На телефоне — во всю ширину под статус-баром,
          на широком экране — плавающая панель со скруглением. */}
      <header className="glass sticky top-0 z-30 border-0 pt-safe sm:top-3 sm:mx-4 sm:mt-3 sm:rounded-[28px] sm:border">
        <div className="flex h-14 items-center gap-2 px-4 sm:h-16 sm:px-5">
          <div className="min-w-0 flex-1">
            {/* Заголовок — название раздела. Кнопка «На главную» лежит поверх него отдельным элементом,
                чтобы заголовок читался как есть, а не как «На главную». */}
            <div className="relative">
              <h1 className="truncate text-[17px] font-semibold leading-tight">{SCREEN_TITLES[tab]}</h1>
              <button
                type="button"
                aria-label="На главную"
                title="На главную"
                className="absolute inset-0 rounded-md"
                onClick={() => setTab("home")}
              />
            </div>
            <SyncStatus />
          </div>
          {(snapshot.aiEnabled || appleAi) && (
            // Значок помощника — стеклянный «шар» в духе Siri из iOS 27.
            <button
              type="button"
              aria-label="AI-помощник"
              title="AI-помощник"
              onClick={() => open({ kind: "ai" })}
              className="glass-control inline-flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition active:scale-95"
            >
              <span className="siri-orb siri-orb-icon" aria-hidden="true" />
            </button>
          )}
          <IconButton
            icon="chart"
            label="Аналитика"
            variant={tab === "analytics" ? "soft" : "secondary"}
            size={44}
            aria-current={tab === "analytics" ? "page" : undefined}
            onClick={() => setTab("analytics")}
          />
        </div>
        <nav aria-label="Разделы" className="hidden gap-1 px-3 pb-3 sm:flex">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={`flex min-h-10 items-center gap-1.5 rounded-full px-4 py-1.5 text-sm font-medium transition ${
                tab === t.id ? "glass-lens text-accent" : "text-muted hover:bg-surface-2 hover:text-text"
              }`}
            >
              <Icon name={t.icon} size={16} />
              {t.label}
            </button>
          ))}
        </nav>
      </header>

      {/* Снизу место под навигацию и плавающую кнопку «+», чтобы она не закрывала последние строки. */}
      <main
        className={`flex-1 px-4 pt-4 sm:pt-5 ${
          nativeShell
            ? // Системная панель вкладок входит в безопасную зону WebView — отступ уже учитывает её.
              // Где над панелью есть круг «+», добавляем место под него, чтобы он не закрывал последние строки.
              showAdd
              ? "pb-[calc(5.75rem+env(safe-area-inset-bottom))]"
              : "pb-[calc(1.5rem+env(safe-area-inset-bottom))]"
            : showAdd
              ? "pb-[calc(10rem+env(safe-area-inset-bottom))] sm:pb-28"
              : "pb-[calc(6rem+env(safe-area-inset-bottom))] sm:pb-12"
        }`}
      >
        {tab === "home" && <Dashboard />}
        {tab === "history" && <History />}
        {tab === "plans" && <Plans />}
        {tab === "goals" && <Goals />}
        {tab === "analytics" && <Analytics />}
        {tab === "settings" && <Settings />}
      </main>

      {/* Кнопка «+» — отдельный круг из акцентного стекла над нижней панелью (на широком экране — в углу). */}
      {showAdd && !nativeBar && (
        <button
          type="button"
          aria-label="Добавить операцию"
          onClick={() => open({ kind: "tx" })}
          className="glass-tint fixed bottom-[calc(var(--dock-offset)+var(--dock-height)+0.75rem)] right-3 z-30 flex h-14 w-14 items-center justify-center rounded-full transition active:scale-95 sm:bottom-8 sm:right-[max(1rem,calc(50%-24rem+1rem))]"
        >
          <Icon name="plus" size={26} />
        </button>
      )}

      {/* Нижняя панель — плавающая стеклянная капсула с отступом от краёв экрана (в приложении — нативная). */}
      {!nativeBar && (
        <nav
          aria-label="Разделы"
          className="pointer-events-none fixed inset-x-0 bottom-(--dock-offset) z-30 px-3 sm:hidden"
        >
          <div className="glass pointer-events-auto relative isolate mx-auto flex h-(--dock-height) max-w-md rounded-full p-1">
            {/* «Линза» под выбранной вкладкой перетекает между пунктами. */}
            <span
              aria-hidden
              className={`glass-lens pointer-events-none absolute inset-y-1 left-1 -z-10 rounded-full transition-[transform,opacity] duration-300 ease-[cubic-bezier(0.3,1.25,0.5,1)] motion-reduce:transition-none ${
                activeTabIndex < 0 ? "opacity-0" : ""
              }`}
              style={{
                width: `calc((100% - 0.5rem) / ${TABS.length})`,
                transform: `translateX(${Math.max(0, activeTabIndex) * 100}%)`,
              }}
            />
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                aria-current={tab === t.id ? "page" : undefined}
                onClick={() => setTab(t.id)}
                className={`flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 rounded-full text-[10.5px] font-semibold tracking-tight transition-colors ${
                  tab === t.id ? "text-accent" : "text-text"
                }`}
              >
                <Icon name={t.icon} size={22} />
                <span className="max-w-full truncate">{t.label}</span>
              </button>
            ))}
          </div>
        </nav>
      )}

      <OverlayHost />
    </div>
  );
}

function SyncStatus() {
  const { mode, sync } = useSnapshot();
  if (mode === "guest") return <span className="block text-xs text-muted">Данные только на этом устройстве</span>;
  const map = {
    synced: { text: "Сохранено", cls: "text-muted", icon: "cloud" as const },
    saving: { text: "Сохраняем…", cls: "text-muted", icon: "cloud" as const },
    offline: { text: `Офлайн${sync.pending ? ` · не отправлено: ${sync.pending}` : ""}`, cls: "text-warning", icon: "cloudOff" as const },
    error: { text: sync.message ?? "Ошибка синхронизации", cls: "text-negative", icon: "alert" as const },
  }[sync.status];
  return (
    <span className={`flex items-center gap-1 truncate text-xs ${map.cls}`} title={sync.message ?? undefined}>
      <Icon name={map.icon} size={13} />
      {map.text}
    </span>
  );
}

/** Есть ли на этом iPhone модель Apple Intelligence для помощника (тогда он работает и без DeepSeek на сервере). */
function useAppleAiAvailable(): boolean {
  const [available, setAvailable] = useState(false);
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    void pickAppleModel().then((picked) => {
      if (!cancelled) setAvailable(picked !== null);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return available;
}

/** Создаёт операции по регулярным платежам, когда наступает их день. */
/** В iOS-приложении перепланирует локальные уведомления, когда меняются данные (с задержкой — не на каждый ввод). */
function useNotificationSync() {
  const { state, phase } = useSnapshot();
  useEffect(() => {
    if (phase !== "ready" || !isNativeApp()) return;
    const timer = setTimeout(() => void syncNotifications(state), 2000);
    return () => clearTimeout(timer);
  }, [state, phase]);
}

function useRecurringSync() {
  const { state, phase, version, sessionExpired } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const attempted = useRef<string | null>(null);
  useEffect(() => {
    if (phase !== "ready" || sessionExpired) return;
    const key = `${today}|${version}|${state.templates.length}|${state.templates.filter((t) => t.active).length}`;
    if (attempted.current === key) return;
    if (dueOccurrences(state, today).length === 0) return;
    attempted.current = key;
    dispatch({ type: "recurring.sync", today });
  }, [state, phase, version, sessionExpired, today, dispatch]);
}

function Splash() {
  return (
    <div className="flex min-h-dvh items-center justify-center" aria-busy="true" aria-label="Загрузка">
      <div className="h-8 w-8 animate-spin rounded-full border-2 border-accent border-r-transparent" />
    </div>
  );
}
