"use client";

import { useEffect } from "react";
import { todayBudgetText } from "@/domain/shortcuts";
import { TOKEN_KEY } from "@/client/api";
import { nativeSetSession, nativeSetSummary } from "@/client/native";
import { useSnapshot, useToday } from "@/client/react";
import { apiBase, isNativeApp } from "@/client/runtime";
import { storage } from "@/client/storage";

/**
 * В iOS-приложении передаёт командам Siri и «Команд» то, что им нужно без открытого приложения:
 * адрес сервера и токен (после выхода — null) и сводку на сегодня с категориями.
 */
export function useNativeBridge(): void {
  const { phase, mode, user, state } = useSnapshot();
  const today = useToday();
  const signedIn = phase === "ready" && mode === "account" && user !== null;

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
}
