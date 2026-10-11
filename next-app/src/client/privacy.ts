"use client";

import { useSyncExternalStore } from "react";
import { nativeBiometricAuth } from "./native";
import { isNativeApp } from "./runtime";
import { storage } from "./storage";

/**
 * Суммы на счетах можно спрятать «глазком» (вместо них — «•••• ₽»). Спрятать — сразу, показать — по Face ID
 * (или коду телефона). Скрытие запоминается на устройстве; показ действует, пока приложение открыто:
 * свернули — суммы снова спрятаны.
 */

const KEY = "fp:hide-balances";

let hidden = storage.get(KEY) === "1";
let revealed = false;
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Суммы сейчас спрятаны. */
export function balancesMasked(): boolean {
  return hidden && !revealed;
}

/** Включено ли скрытие (даже если сейчас суммы показаны по Face ID). */
export function balancesHiding(): boolean {
  return hidden;
}

/** Спрятать суммы: без проверки, запоминается. */
export function hideBalances(): void {
  hidden = true;
  revealed = false;
  storage.set(KEY, "1");
  emit();
}

/** Показать до сворачивания приложения. verified — проверка уже пройдена (нативный экран спросил Face ID сам). */
export async function revealBalances(verified = false): Promise<boolean> {
  if (!hidden) return true;
  if (!verified && isNativeApp() && !(await nativeBiometricAuth("Показать суммы на счетах"))) return false;
  revealed = true;
  emit();
  return true;
}

/** Выключить скрытие совсем (из настроек) — тоже по Face ID. */
export async function stopHidingBalances(): Promise<boolean> {
  if (!hidden) return true;
  if (isNativeApp() && !(await nativeBiometricAuth("Больше не скрывать суммы на счетах"))) return false;
  hidden = false;
  revealed = false;
  storage.set(KEY, "0");
  emit();
  return true;
}

// Свернули приложение или ушли со вкладки — показанные суммы снова прячутся.
if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden" && revealed) {
      revealed = false;
      emit();
    }
  });
}

export function useBalancesPrivacy(): { masked: boolean; hiding: boolean } {
  const masked = useSyncExternalStore(subscribe, balancesMasked, () => false);
  const hiding = useSyncExternalStore(subscribe, balancesHiding, () => false);
  return { masked, hiding };
}

export function onBalancesPrivacy(listener: () => void): () => void {
  return subscribe(listener);
}

/** Сумма или «•••• ₽», если суммы спрятаны. */
export function maskMoney(text: string, masked: boolean): string {
  return masked ? "•••• ₽" : text;
}
