"use client";

import { registerPlugin, type PluginListenerHandle } from "@capacitor/core";
import { isNativeApp } from "./runtime";

/**
 * Плагин iOS-приложения (ios/App/App/BudgetNativePlugin.swift): сессия и сводка для команд Siri,
 * модели Apple Intelligence для помощника. В браузере его нет — функции ничего не делают.
 */

export interface AppleModelStatus {
  available: boolean;
  /** Почему недоступна: deviceNotEligible, appleIntelligenceNotEnabled, modelNotReady… */
  reason?: string;
  /** Размер контекста модели в токенах. */
  contextSize?: number;
  /** Понимает ли модель русский. */
  russian?: boolean;
}

export interface AppleAiStatus {
  /** Модель на самом телефоне — работает без интернета. */
  device: AppleModelStatus;
  /** Private Cloud Compute (iOS 27): модель Apple на её защищённых серверах. */
  cloud: AppleModelStatus;
}

export type AppleModel = "device" | "cloud";

/** Ответ модели или код ошибки: context — данных слишком много, refused — модель отказалась отвечать… */
export type AppleAiReply = { text: string } | { error: string; message?: string };

export interface TabBarItem {
  id: string;
  title: string;
  /** SF Symbol вкладки и выбранной вкладки. */
  symbol: string;
  selectedSymbol: string;
}

/** Уведомление интерфейса, которое показывает нативная оболочка (над панелью вкладок). */
export interface NativeToast {
  id: number;
  message: string;
  kind: "info" | "error";
  /** Подпись кнопки («Отменить»); нажатие вернётся командой toastAction с этим id. */
  actionLabel?: string;
}

interface BudgetNativePlugin {
  shellInfo(): Promise<{ nativeHome: boolean }>;
  homeModel(options: { model: unknown }): Promise<void>;
  toast(options: NativeToast): Promise<void>;
  commandResult(options: { requestId: string; result: unknown }): Promise<void>;
  addListener(event: "command", listener: (data: { requestId: string; command: unknown }) => void): Promise<PluginListenerHandle>;
  tabBarShow(options: { items: TabBarItem[]; selected: string; action: boolean }): Promise<void>;
  tabBarUpdate(options: { selected?: string; action?: boolean; hidden?: boolean }): Promise<void>;
  addListener(event: "tabBarSelect", listener: (data: { id: string }) => void): Promise<PluginListenerHandle>;
  addListener(event: "tabBarAction", listener: () => void): Promise<PluginListenerHandle>;
  openShortcuts(): Promise<void>;
  addSmsShortcut(): Promise<void>;
  stateMirror(options: { account: string; stateJson: string }): Promise<void>;
  smsInbox(options: { account: string }): Promise<{ items: { id: string; ops: { opId: string; action: unknown }[] }[] }>;
  ackSmsInbox(options: { ids: string[] }): Promise<void>;
  openShortcutsApp(): Promise<void>;
  siriOrb(options: { active: boolean }): Promise<void>;
  setSession(options: { apiBase: string; token: string | null; account: string | null }): Promise<void>;
  setSummary(options: { date: string; text: string; expenseCategories: string[]; incomeCategories: string[] }): Promise<void>;
  aiStatus(): Promise<AppleAiStatus>;
  aiRespond(options: { model: AppleModel; instructions: string; prompt: string }): Promise<AppleAiReply>;
}

const plugin = registerPlugin<BudgetNativePlugin>("BudgetNative");

const UNAVAILABLE: AppleAiStatus = { device: { available: false }, cloud: { available: false } };

export async function nativeSetSession(apiBase: string, token: string | null, account: string | null): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await plugin.setSession({ apiBase, token, account });
  } catch {
    // Старая сборка приложения без плагина — команды Siri просто не узнают о входе.
  }
}

export async function nativeSetSummary(summary: Parameters<BudgetNativePlugin["setSummary"]>[0]): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await plugin.setSummary(summary);
  } catch {
    /* см. nativeSetSession */
  }
}

let statusPromise: Promise<AppleAiStatus> | null = null;

/** Доступность моделей Apple (запрашивается один раз за запуск). */
export function appleAiStatus(): Promise<AppleAiStatus> {
  if (!isNativeApp()) return Promise.resolve(UNAVAILABLE);
  statusPromise ??= plugin.aiStatus().catch(() => UNAVAILABLE);
  return statusPromise;
}

export async function appleAiRespond(model: AppleModel, instructions: string, prompt: string): Promise<AppleAiReply> {
  try {
    return await plugin.aiRespond({ model, instructions, prompt });
  } catch (error) {
    return { error: "failed", message: error instanceof Error ? error.message : undefined };
  }
}

/** Нативная нижняя панель Liquid Glass. false — плагина нет (браузер, старая сборка): остаётся панель интерфейса. */
export async function nativeTabBarShow(options: Parameters<BudgetNativePlugin["tabBarShow"]>[0]): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    await plugin.tabBarShow(options);
    return true;
  } catch {
    return false;
  }
}

export function nativeTabBarUpdate(options: Parameters<BudgetNativePlugin["tabBarUpdate"]>[0]): void {
  plugin.tabBarUpdate(options).catch(() => {});
}

export function onNativeTabBar(onSelect: (id: string) => void, onAction: () => void): () => void {
  const handles = [plugin.addListener("tabBarSelect", ({ id }) => onSelect(id)), plugin.addListener("tabBarAction", () => onAction())];
  return () => {
    for (const handle of handles) void handle.then((h) => h.remove()).catch(() => {});
  };
}

/** Экран «Siri и Команды» (системная кнопка «Команды» и подсказки Siri). false — в этой сборке его нет. */
export async function nativeOpenShortcuts(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    await plugin.openShortcuts();
    return true;
  } catch {
    return false;
  }
}

/** Нативный стеклянный «шар» Siri сверху экрана. false — в этой сборке его нет (тогда рисуем CSS-шар). */
export async function nativeSiriOrb(active: boolean): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    await plugin.siriOrb({ active });
    return true;
  } catch {
    return false;
  }
}

/**
 * Нативная оболочка iOS: системная панель вкладок и Главная на SwiftUI. false — браузер или старая сборка,
 * где Главная рисуется интерфейсом.
 */
export async function nativeShellInfo(): Promise<{ nativeHome: boolean }> {
  if (!isNativeApp()) return { nativeHome: false };
  try {
    return await plugin.shellInfo();
  } catch {
    return { nativeHome: false };
  }
}

/** Модель нативной Главной: всё посчитано и отформатировано в интерфейсе, Swift только рисует. */
export function nativeHomeModel(model: unknown): void {
  plugin.homeModel({ model }).catch(() => {});
}

export function nativeToast(toast: NativeToast): void {
  plugin.toast(toast).catch(() => {});
}

/** Команды нативного экрана: обработчик возвращает результат, он уходит обратно в Swift. */
export function onNativeCommand(handler: (command: unknown) => Promise<unknown>): () => void {
  const handle = plugin.addListener("command", ({ requestId, command }) => {
    void handler(command)
      .catch((error: unknown) => ({ ok: false, error: error instanceof Error ? error.message : "Не получилось." }))
      .then((result) => plugin.commandResult({ requestId, result }))
      .catch(() => {});
  });
  return () => {
    void handle.then((h) => h.remove()).catch(() => {});
  };
}

/** Окно «Поделиться» с командой «Бюджет СМС» (в нём «Команды» → «Добавить»). false — в этой сборке её нет. */
export async function nativeAddSmsShortcut(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    await plugin.addSmsShortcut();
    return true;
  } catch {
    return false;
  }
}

/** Открывает приложение «Команды». false — не получилось или старая сборка. */
export async function nativeOpenShortcutsApp(): Promise<boolean> {
  if (!isNativeApp()) return false;
  try {
    await plugin.openShortcutsApp();
    return true;
  } catch {
    return false;
  }
}

/** Копия данных для разбора СМС на телефоне (команда работает без сети и без открытого интерфейса). */
export function nativeStateMirror(account: string, stateJson: string): void {
  if (!isNativeApp()) return;
  plugin.stateMirror({ account, stateJson }).catch(() => {});
}

/** Операции из СМС, разобранные на телефоне и ещё не принятые интерфейсом. */
export async function nativeSmsInbox(account: string): Promise<{ id: string; ops: { opId: string; action: unknown }[] }[]> {
  if (!isNativeApp()) return [];
  try {
    return (await plugin.smsInbox({ account })).items;
  } catch {
    return [];
  }
}

export function nativeAckSmsInbox(ids: string[]): void {
  if (!ids.length) return;
  plugin.ackSmsInbox({ ids }).catch(() => {});
}
