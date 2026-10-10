"use client";

import { useEffect, useRef, useState } from "react";
import { dueOccurrences } from "@/domain/recurring";
import { FinanceStore } from "@/client/store";
import { StoreProvider, useSnapshot, useStore, useToday } from "@/client/react";
import { storage } from "@/client/storage";
import { syncNotifications } from "@/client/notifications";
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
import { forgetAiChat } from "./sheets/AiChatSheet";
import { UiProvider, useUi, type Tab } from "./overlays";

const TABS: { id: Exclude<Tab, "settings">; label: string; icon: IconName }[] = [
  { id: "home", label: "Главная", icon: "home" },
  { id: "history", label: "История", icon: "list" },
  { id: "plans", label: "Регулярные", icon: "repeat" },
  { id: "goals", label: "Цели", icon: "target" },
  { id: "analytics", label: "Аналитика", icon: "chart" },
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

  // Запоминаем вкладку между запусками.
  useEffect(() => {
    const saved = storage.get("fp:tab") as Tab | null;
    if (saved && saved !== "home" && (TABS.some((t) => t.id === saved) || saved === "settings")) setTab(saved);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- только при запуске
  }, []);
  useEffect(() => {
    storage.set("fp:tab", tab);
  }, [tab]);

  useRecurringSync();
  useNotificationSync();

  // Офлайн-оболочка (только в production: в разработке кэш мешал бы горячей перезагрузке).
  useEffect(() => registerServiceWorker(), []);

  if (snapshot.phase === "loading") return <Splash />;

  const showAdd = tab === "home" || tab === "history";

  return (
    <div className="mx-auto flex min-h-dvh max-w-3xl flex-col">
      <header className="sticky top-0 z-30 border-b border-border/60 bg-bg/90 pt-safe backdrop-blur">
        <div className="flex h-14 items-center gap-2 px-4">
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
          {snapshot.aiEnabled && (
            <IconButton icon="sparkles" label="AI-помощник" variant="soft" onClick={() => open({ kind: "ai" })} />
          )}
          <IconButton
            icon="settings"
            label="Настройки"
            variant={tab === "settings" ? "soft" : "ghost"}
            aria-current={tab === "settings" ? "page" : undefined}
            onClick={() => setTab("settings")}
          />
        </div>
        <nav aria-label="Разделы" className="hidden gap-1 px-3 pb-2 sm:flex">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={`flex items-center gap-1.5 rounded-full px-3.5 py-1.5 text-sm font-medium transition ${
                tab === t.id ? "bg-text text-bg" : "text-muted hover:bg-surface-2 hover:text-text"
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
        className={`flex-1 px-4 pt-4 ${
          showAdd
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

      {showAdd && (
        <button
          type="button"
          aria-label="Добавить операцию"
          onClick={() => open({ kind: "tx" })}
          className="fixed bottom-[calc(5.25rem+env(safe-area-inset-bottom))] right-4 z-30 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-accent-text shadow-lg transition hover:opacity-90 sm:bottom-8 sm:right-[max(1rem,calc(50%-24rem+1rem))]"
        >
          <Icon name="plus" size={26} />
        </button>
      )}

      <nav
        aria-label="Разделы"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-border bg-surface/95 pb-safe backdrop-blur sm:hidden"
      >
        <div className="mx-auto flex max-w-3xl">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              aria-current={tab === t.id ? "page" : undefined}
              onClick={() => setTab(t.id)}
              className={`flex h-16 flex-1 flex-col items-center justify-center gap-1 text-[11px] font-medium ${
                tab === t.id ? "text-accent" : "text-muted"
              }`}
            >
              <Icon name={t.icon} size={22} />
              {t.label}
            </button>
          ))}
        </div>
      </nav>

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
