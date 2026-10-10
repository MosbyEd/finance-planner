"use client";

import { useEffect, useRef, useState } from "react";
import { formatMoney } from "@/domain/money";
import { autoSavingAmount, autoSavingByDefault } from "@/domain/savings";
import type { State } from "@/domain/schema";
import { nativeHomeModel, nativeShellInfo, nativeToast, onNativeCommand } from "@/client/native";
import { newId, useSnapshot, useStore, useToday } from "@/client/react";
import { isNativeApp } from "@/client/runtime";
import { storage } from "@/client/storage";
import { runToastAction, setToastSink, useToast } from "../../ui/feedback";
import { useUi } from "../overlays";
import { quickPicks } from "../quickPicks";
import { bankResolveActions } from "../accounts";
import { BALANCE_CONFIRMED_KEY } from "../sheets/MoneySheets";
import { commandSchema, type CommandResult, type NativeCommand } from "./commands";
import { SKIP_MANDATORY_KEY, buildHomeModel, quickKey } from "./homeModel";

/**
 * Есть ли нативная оболочка iOS (системная панель вкладок, Главная на SwiftUI). Пока не выяснили — false:
 * интерфейс рисует всё сам, как в браузере.
 */
export function useNativeShell(): boolean {
  const [active, setActive] = useState(false);
  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    void nativeShellInfo().then((info) => {
      if (!cancelled) setActive(info.nativeHome);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Уведомления показывает оболочка — над нативной панелью вкладок и поверх нативной Главной.
  useEffect(() => {
    if (!active) return;
    setToastSink((toast) => nativeToast(toast));
    return () => setToastSink(null);
  }, [active]);

  // Пока открыта Главная, страница прозрачная: окна интерфейса ложатся поверх нативного экрана.
  return active;
}

function isMandatoryCategory(state: State, category: string): boolean {
  return state.categories.mandatory.includes(category) && !state.categories.flexible.includes(category);
}

/**
 * Связь с нативной Главной: отдаёт ей модель экрана при каждом изменении данных и выполняет её команды
 * (открыть окно, добавить трату, отложить остаток…) тем же кодом, что и веб-экран.
 */
export function useNativeHome(active: boolean, assistant: boolean): void {
  const snapshot = useSnapshot();
  const store = useStore();
  const today = useToday();
  const toast = useToast();
  const ui = useUi();
  // Флаги первых шагов хранятся вне состояния: пересобираем модель и после их изменения.
  const [flagsRevision, setFlagsRevision] = useState(0);

  const latest = useRef({ snapshot, today, ui, toast });
  useEffect(() => {
    latest.current = { snapshot, today, ui, toast };
  });

  const ready = active && snapshot.phase === "ready";
  useEffect(() => {
    if (!ready) return;
    const timer = setTimeout(() => {
      nativeHomeModel(
        buildHomeModel({
          snapshot,
          today,
          balanceConfirmed: storage.get(BALANCE_CONFIRMED_KEY) === "1",
          mandatorySkipped: storage.get(SKIP_MANDATORY_KEY) === "1",
          assistant,
        }),
      );
    }, 60);
    return () => clearTimeout(timer);
    // ui.overlay: «Остаток совпадает» в окне сверки меняет только флаг — пересчитываем, когда окно закрылось.
  }, [ready, snapshot, today, assistant, flagsRevision, ui.overlay]);

  useEffect(() => {
    if (!ready) return;
    return onNativeCommand(async (raw): Promise<CommandResult> => {
      const parsed = commandSchema.safeParse(raw);
      if (!parsed.success) return { ok: false, error: "Непонятная команда." };
      return run(parsed.data);
    });

    function run(command: NativeCommand): CommandResult | Promise<CommandResult> {
      const { snapshot: snap, today: day, ui: currentUi, toast: show } = latest.current;
      const { state } = snap;
      switch (command.type) {
        case "open":
          currentUi.open(command.overlay);
          return { ok: true };
        case "tab":
          currentUi.setTab(command.tab);
          return { ok: true };
        case "rollover": {
          const result = store.dispatch({
            type: "rollover.resolve",
            month: command.month,
            decision: command.decision,
            id: newId(),
            date: day,
          });
          if (!result.ok) return result;
          return command.decision === "saved"
            ? { ok: true, message: `${formatMoney(command.amount, { whole: true })} отложено в сбережения` }
            : { ok: true };
        }
        case "guestImport": {
          if (!command.accept) {
            store.dismissGuestImport();
            return { ok: true };
          }
          const result = store.acceptGuestImport();
          return result.ok ? { ok: true, message: "Данные перенесены в аккаунт" } : result;
        }
        case "legacyImport": {
          if (!command.accept) {
            store.dismissLegacyImport();
            return { ok: true };
          }
          const result = store.acceptLegacyImport();
          return result.ok ? { ok: true, message: "Данные старой версии перенесены" } : result;
        }
        case "skipMandatory":
          storage.set(SKIP_MANDATORY_KEY, "1");
          setFlagsRevision((n) => n + 1);
          return { ok: true };
        case "quick": {
          const pick = quickPicks(state, day, 6).find((p) => quickKey(p) === command.key);
          if (!pick) return { ok: false, error: "Эта трата уже не в списке частых." };
          const id = newId();
          const result = store.dispatch({
            type: "tx.add",
            tx: {
              id,
              type: "expense",
              amount: pick.amount,
              date: day,
              category: pick.category,
              title: pick.title,
              note: "",
              mandatory: pick.mandatory,
              autoSaving: autoSavingByDefault({ type: "expense", amount: pick.amount, category: pick.category }, state.settings),
            },
          });
          if (!result.ok) return result;
          return { ok: true, txId: id, message: `${pick.title || pick.category} · ${formatMoney(pick.amount)} — добавлено` };
        }
        case "add": {
          const { kind, amount, title, date, accountId } = command.draft;
          const category = command.draft.category.trim();
          const autoSaving =
            autoSavingAmount({ type: kind, amount, category, autoSaving: true }, state.settings) > 0 &&
            autoSavingByDefault({ type: kind, amount, category }, state.settings);
          const id = newId();
          const result = store.dispatch({
            type: "tx.add",
            tx: {
              id,
              type: kind,
              amount,
              date,
              category,
              title: title.trim(),
              note: "",
              mandatory: kind === "expense" && isMandatoryCategory(state, category),
              autoSaving,
              ...(accountId ? { accountId } : {}),
            },
          });
          if (!result.ok) return result;
          return { ok: true, txId: id, message: kind === "income" ? "Доход добавлен" : "Расход добавлен" };
        }
        case "undo": {
          const result = store.dispatch({ type: "tx.delete", id: command.txId });
          return result.ok ? { ok: true, message: "Отменено" } : result;
        }
        case "refresh":
          return store.resume().then(() => ({ ok: true }) as const);
        case "bank": {
          const actions = bankResolveActions(state, command.accountId, command.fix, day, newId());
          if (!actions.length) return { ok: true };
          const result = store.dispatch(actions);
          if (!result.ok) return result;
          return command.fix ? { ok: true, message: "Остаток поправлен" } : { ok: true };
        }
        case "toastAction":
          if (!runToastAction(command.id)) show("Уже нельзя отменить", { kind: "info" });
          return { ok: true };
      }
    }
  }, [ready, store]);
}
