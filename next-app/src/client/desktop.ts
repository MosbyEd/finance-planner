"use client";

/**
 * Приложение для Mac (папка macos/): окно, боковая панель разделов и кнопки на панели инструментов — нативные,
 * внутри окна — этот же сайт. Приложение ещё до загрузки страницы ставит на <html> класс desktop-app (сайт прячет
 * свою шапку и нижнюю панель) и добавляет обработчики сообщений:
 *  - budgetDesktop — сайт сообщает раздел и статус сохранения, чтобы окно подсветило раздел и показало статус;
 *  - budgetDesktopAuth — Touch ID (или пароль Mac), чтобы показать спрятанные суммы.
 * Команды из меню и панели инструментов приходят событием «budget-desktop».
 */

interface MessageHandler {
  postMessage(message: unknown): Promise<unknown> | void;
}

function handler(name: string): MessageHandler | undefined {
  return (globalThis as { webkit?: { messageHandlers?: Record<string, MessageHandler | undefined> } }).webkit
    ?.messageHandlers?.[name];
}

/** Сайт открыт в приложении для Mac. */
export function isDesktopApp(): boolean {
  return Boolean(handler("budgetDesktop"));
}

export interface DesktopState {
  tab: string;
  title: string;
  /** Строка под заголовком окна: «Сохранено», «Офлайн»… */
  status: string;
  /** Есть ли помощник (кнопка на панели инструментов). */
  ai: boolean;
}

export function postDesktopState(state: DesktopState): void {
  try {
    void handler("budgetDesktop")?.postMessage({ type: "state", ...state });
  } catch {
    // Окно закрывается — сообщать некуда.
  }
}

/** Touch ID или пароль Mac. Вне приложения для Mac — без проверки. */
export async function desktopBiometricAuth(reason: string): Promise<boolean> {
  const auth = handler("budgetDesktopAuth");
  if (!auth) return true;
  try {
    return (await auth.postMessage({ reason })) === true;
  } catch {
    return false;
  }
}

export type DesktopCommand = { type: "tab"; tab: string } | { type: "add" } | { type: "ai" };

export function onDesktopCommand(listener: (command: DesktopCommand) => void): () => void {
  const handle = (event: Event) => {
    const detail = (event as CustomEvent<unknown>).detail;
    if (!detail || typeof detail !== "object" || typeof (detail as { type?: unknown }).type !== "string") return;
    listener(detail as DesktopCommand);
  };
  window.addEventListener("budget-desktop", handle);
  return () => window.removeEventListener("budget-desktop", handle);
}
