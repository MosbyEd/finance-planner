"use client";

import { useEffect } from "react";
import { todayBudgetText } from "@/domain/shortcuts";
import { TOKEN_KEY } from "@/client/api";
import { nativeAckSmsInbox, nativeSetSession, nativeSetSummary, nativeSmsInbox, nativeStateMirror } from "@/client/native";
import type { Op } from "@/client/api";
import { useSnapshot, useStore, useToday } from "@/client/react";
import { useToast } from "../ui/feedback";
import { apiBase, isNativeApp } from "@/client/runtime";
import { storage } from "@/client/storage";

/**
 * В iOS-приложении передаёт командам Siri и «Команд» то, что им нужно без открытого приложения:
 * адрес сервера и токен (после выхода — null) и сводку на сегодня с категориями.
 */
export function useNativeBridge(): void {
  const { phase, mode, user, state } = useSnapshot();
  const store = useStore();
  const toast = useToast();
  const today = useToday();
  const signedIn = phase === "ready" && mode === "account" && user !== null;
  const login = signedIn ? (user?.login ?? null) : null;

  useEffect(() => {
    if (!isNativeApp() || phase !== "ready") return;
    void nativeSetSession(apiBase(), signedIn ? storage.get(TOKEN_KEY) : null, signedIn ? (user?.login ?? null) : null);
    // user — новый объект при каждом входе: после повторного входа передаём новый токен.
  }, [phase, signedIn, user]);

  useEffect(() => {
    if (!isNativeApp() || !signedIn) return;
    // С задержкой: сводка пересчитывается не на каждый ввод.
    const timer = setTimeout(() => {
      const expense = [...new Set([...state.categories.flexible, ...state.categories.mandatory])];
      void nativeSetSummary({
        date: today,
        text: todayBudgetText(state, today),
        expenseCategories: expense,
        incomeCategories: state.categories.income,
      });
    }, 1500);
    return () => clearTimeout(timer);
  }, [signedIn, state, today]);

  // Копия данных для разбора СМС на телефоне — с задержкой, не на каждое изменение.
  useEffect(() => {
    if (!isNativeApp() || !login) return;
    const timer = setTimeout(() => nativeStateMirror(login, JSON.stringify(state)), 2000);
    return () => clearTimeout(timer);
  }, [login, state]);

  // Операции из СМС, разобранные на телефоне, пока интерфейс был закрыт: применяем у себя (видно и без сети)
  // и подтверждаем приём. При запуске и при каждом возвращении в приложение.
  useEffect(() => {
    if (!isNativeApp() || !login) return;
    let cancelled = false;
    const take = () => {
      void nativeSmsInbox(login).then((items) => {
        if (cancelled || !items.length) return;
        const applied = store.ingest(items.map((item) => item.ops as Op[]));
        nativeAckSmsInbox(items.map((item) => item.id));
        if (applied > 0) toast(applied === 1 ? "Добавлена операция из СМС" : `Добавлено операций из СМС: ${applied}`);
      });
    };
    take();
    const onVisible = () => {
      if (document.visibilityState === "visible") take();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [login, store, toast]);
}
