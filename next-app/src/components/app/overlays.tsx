"use client";

import { createContext, useCallback, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { IsoDate, MonthKey } from "@/domain/dates";
import { useConfirm } from "../ui/feedback";

/** Какое окно сейчас открыто поверх экрана. Одновременно открыто не больше одного. */
export type Overlay =
  | { kind: "tx"; txId?: string; preset?: { type?: "income" | "expense"; mandatory?: boolean; date?: IsoDate } }
  | { kind: "template"; templateId?: string; preset?: { kind?: "income" | "expense" } }
  | { kind: "goal"; goalId?: string }
  | { kind: "goalMoney"; goalId: string; direction: "in" | "out" }
  | { kind: "loan"; loanId?: string }
  | { kind: "loanPayment"; loanId: string }
  | { kind: "savings"; direction: "in" | "out" }
  | { kind: "balance"; accountId?: string }
  /** Счёт: новый или правка (название, вид, цифры карты, лимит кредитки). */
  | { kind: "account"; accountId?: string; preset?: { kind?: "debit" | "cash" | "savings" | "credit" } }
  /** Перевод между своими счетами; amount — подставить (погашение всего долга кредитки). */
  | { kind: "transfer"; from?: string; to?: string; amount?: number; resolveBank?: string }
  | { kind: "explain" }
  | { kind: "planned"; templateId: string; month: MonthKey }
  | { kind: "ai"; prompt?: string }
  | { kind: "auth"; mode?: "login" | "register" }
  | { kind: "limit"; category?: string }
  /** Новые операции из СМС и Siri — подтвердить или поправить. */
  | { kind: "review" };

export type Tab = "home" | "history" | "plans" | "goals" | "analytics" | "settings";

interface UiContextValue {
  overlay: Overlay | null;
  open: (overlay: Overlay) => void;
  close: () => void;
  tab: Tab;
  /** Переключает вкладку. Если на текущей есть несохранённый черновик, сначала спросит подтверждение. */
  setTab: (tab: Tab) => void;
  /** Открытый раздел настроек (отдельная страница); null — список разделов. */
  settingsSection: string | null;
  /** Открывает настройки на разделе (или списке, если раздел не указан). */
  openSettings: (section?: string | null) => void;
  /** Проверка «есть несохранённые изменения» перед уходом с вкладки. Возвращает функцию, снимающую проверку. */
  registerLeaveGuard: (key: string, isDirty: () => boolean) => () => void;
  unregisterLeaveGuard: (key: string) => void;
}

const UiContext = createContext<UiContextValue | null>(null);

export function UiProvider({ children, initialTab = "home" }: { children: ReactNode; initialTab?: Tab }) {
  const confirm = useConfirm();
  const [overlay, setOverlay] = useState<Overlay | null>(null);
  const [tab, setTabState] = useState<Tab>(initialTab);
  const [settingsSection, setSettingsSection] = useState<string | null>(null);
  const guards = useRef(new Map<string, () => boolean>());

  const unregisterLeaveGuard = useCallback((key: string) => {
    guards.current.delete(key);
  }, []);
  const registerLeaveGuard = useCallback((key: string, isDirty: () => boolean) => {
    guards.current.set(key, isDirty);
    return () => {
      // Снимаем, только если под ключом всё ещё наша проверка.
      if (guards.current.get(key) === isDirty) guards.current.delete(key);
    };
  }, []);

  const setTab = useCallback(
    (next: Tab) => {
      const go = () => {
        // Повторное касание «Настроек» — к списку разделов, как у вкладок iOS.
        if (next === "settings" && tab === "settings") setSettingsSection(null);
        setTabState(next);
        window.scrollTo({ top: 0 });
      };
      const dirty = next !== tab && [...guards.current.values()].some((isDirty) => isDirty());
      if (!dirty) {
        go();
        return;
      }
      void confirm({
        title: "Уйти без сохранения?",
        message: "Изменения в настройках пропадут.",
        confirmLabel: "Не сохранять",
        danger: true,
      }).then((ok) => {
        if (ok) go();
      });
    },
    [confirm, tab],
  );

  const value: UiContextValue = {
    overlay,
    open: setOverlay,
    close: () => setOverlay(null),
    tab,
    setTab,
    settingsSection,
    openSettings: (section) => {
      setSettingsSection(section ?? null);
      setTabState("settings");
      window.scrollTo({ top: 0 });
    },
    registerLeaveGuard,
    unregisterLeaveGuard,
  };
  return <UiContext.Provider value={value}>{children}</UiContext.Provider>;
}

export function useUi(): UiContextValue {
  const ctx = useContext(UiContext);
  if (!ctx) throw new Error("useUi вне UiProvider");
  return ctx;
}

/** Пока dirty, переход на другую вкладку сначала спросит, можно ли бросить черновик. */
export function useLeaveGuard(dirty: boolean): void {
  const { registerLeaveGuard } = useUi();
  const key = useId();
  const dirtyRef = useRef(dirty);
  useEffect(() => {
    dirtyRef.current = dirty;
  }, [dirty]);
  useEffect(() => registerLeaveGuard(key, () => dirtyRef.current), [key, registerLeaveGuard]);
}
