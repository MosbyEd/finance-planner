import type { Categories, Profile, Settings, State } from "./schema";

export const SAVINGS_CATEGORY = "Сбережения";
export const LOAN_PAYMENT_CATEGORY = "Долги";
export const LOAN_RETURN_CATEGORY = "Возврат долга";
export const ADJUSTMENT_CATEGORY = "Корректировка";
/** Куда переносятся операции с недопустимым названием категории (служебные имена вроде «constructor»). */
export const OTHER_CATEGORY = "Другое";

export function defaultCategories(): Categories {
  return {
    income: ["Зарплата", "Аванс", "Премия", "Фриланс", "Подарки"],
    mandatory: ["Аренда", "Ипотека/кредит", "Коммуналка", "Связь и интернет", "Подписки", "Здоровье", "Крупные покупки"],
    flexible: ["Продукты", "Кафе и рестораны", "Транспорт", "Такси", "Развлечения", "Одежда", "Дом", "Красота", "Подарки", "Другое"],
  };
}

export function defaultSettings(): Settings {
  return {
    savingsRatePercent: 15,
    salarySaving: { enabled: true, percent: 15, categories: ["Зарплата"] },
    purchaseSaving: {
      enabled: true,
      percent: 5,
      cap: 100_000, // 1000 ₽
      roundTo: 5_000, // до 50 ₽
      excludedCategories: ["Ипотека/кредит", "Коммуналка", "Аренда"],
    },
  };
}

export function defaultProfile(): Profile {
  return { occupation: "", riskLevel: null, savingsStyle: null, notes: "" };
}

export function emptyState(): State {
  return {
    schemaVersion: 3,
    transactions: [],
    templates: [],
    goals: [],
    loans: [],
    categories: defaultCategories(),
    categoryLimits: {},
    skipped: {},
    rollover: {},
    settings: defaultSettings(),
    profile: defaultProfile(),
  };
}
