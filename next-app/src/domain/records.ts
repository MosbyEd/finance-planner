/**
 * Безопасная работа с записями-словарями состояния (skipped, categoryLimits, rollover).
 * Ключи приходят от пользователя (id шаблонов, названия категорий), поэтому:
 *  - читаем только собственные свойства: obj["constructor"] или obj["toString"] вернули бы функцию прототипа;
 *  - пишем через Object.fromEntries: присваивание obj["__proto__"] = … подменило бы прототип.
 */

/**
 * Имена, совпадающие со свойствами Object.prototype. Список фиксированный (а не из рантайма),
 * чтобы клиент и сервер одинаково проверяли данные в любом движке.
 */
export const RESERVED_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "hasOwnProperty",
  "isPrototypeOf",
  "propertyIsEnumerable",
  "toLocaleString",
  "toString",
  "valueOf",
  "__defineGetter__",
  "__defineSetter__",
  "__lookupGetter__",
  "__lookupSetter__",
]);

export function isReservedKey(key: string): boolean {
  return RESERVED_KEYS.has(key);
}

/** Значение собственного свойства записи (или undefined). */
export function getOwn<T>(record: Readonly<Record<string, T>>, key: string): T | undefined {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

/** Копия записи с ключом key = value. */
export function withKey<T>(record: Readonly<Record<string, T>>, key: string, value: T): Record<string, T> {
  const entries = Object.entries(record).filter(([k]) => k !== key);
  entries.push([key, value]);
  return Object.fromEntries(entries);
}

/** Копия записи без ключа key (та же запись, если ключа не было). */
export function withoutKey<T>(record: Readonly<Record<string, T>>, key: string): Record<string, T> {
  if (!Object.hasOwn(record, key)) return record as Record<string, T>;
  return Object.fromEntries(Object.entries(record).filter(([k]) => k !== key));
}
