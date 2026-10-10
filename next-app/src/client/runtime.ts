/**
 * Настройки запуска. В iOS-приложении интерфейс открывается из пакета приложения (capacitor://localhost),
 * а к серверу ходит по адресу из config.js: window.__BUDGET_CONFIG__ = { native: true, apiBase: "https://…" }.
 * В браузере config.js нет — запросы идут на тот же сайт с cookie сессии.
 */
interface BudgetConfig {
  native?: boolean;
  apiBase?: string;
}

function config(): BudgetConfig {
  return (globalThis as { __BUDGET_CONFIG__?: BudgetConfig }).__BUDGET_CONFIG__ ?? {};
}

/** Приложение (интерфейс в пакете, вход по токену), а не сайт. */
export function isNativeApp(): boolean {
  return config().native === true;
}

/** Адрес сервера для API: пустая строка — тот же сайт. */
export function apiBase(): string {
  return (config().apiBase ?? "").replace(/\/+$/, "");
}
