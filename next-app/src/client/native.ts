"use client";

import { registerPlugin } from "@capacitor/core";
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

interface BudgetNativePlugin {
  setSession(options: { apiBase: string; token: string | null }): Promise<void>;
  setSummary(options: { date: string; text: string; expenseCategories: string[]; incomeCategories: string[] }): Promise<void>;
  aiStatus(): Promise<AppleAiStatus>;
  aiRespond(options: { model: AppleModel; instructions: string; prompt: string }): Promise<AppleAiReply>;
}

const plugin = registerPlugin<BudgetNativePlugin>("BudgetNative");

const UNAVAILABLE: AppleAiStatus = { device: { available: false }, cloud: { available: false } };

export async function nativeSetSession(apiBase: string, token: string | null): Promise<void> {
  if (!isNativeApp()) return;
  try {
    await plugin.setSession({ apiBase, token });
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
