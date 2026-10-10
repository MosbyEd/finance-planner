import { z } from "zod";
import { addDays, monthKeyOf, todayLocal, type IsoDate } from "@/domain/dates";
import { DomainError, IMPORT_NOT_EMPTY_MESSAGE, actionToday, applyAction, type Action } from "@/domain/actions";
import { emptyState } from "@/domain/defaults";
import { MigrationError, isCurrentFormat, migrateState } from "@/domain/migrate";
import { stateSchema, type State } from "@/domain/schema";
import { getDb, transaction } from "./db";
import { MAX_STATE_BYTES } from "./limits";

export { MAX_STATE_BYTES };

/** Изменений в одном запросе: клиент отправляет очередь пачками по 100. */
export const MAX_OPS_PER_REQUEST = 100;

/** id изменения, который генерирует клиент (сейчас — 16 символов [0-9a-z], см. newId). */
export const opIdSchema = z.string().regex(/^[A-Za-z0-9_-]{8,40}$/, "Некорректный id изменения");

export interface StoredState {
  version: number;
  state: State;
}

/** Прочитанная строка states: rev меняется при любой записи (см. миграцию в db.ts), bytes — размер JSON. */
interface LoadedState extends StoredState {
  rev: number;
  bytes: number;
}

/** Сохранённое состояние не читается и не исправляется — отдавать его клиенту нельзя. */
export class StoredStateError extends Error {
  constructor(
    readonly userId: number,
    /** Версия сохранённой строки: импорт, заменяющий повреждённое состояние, продолжает нумерацию с неё. */
    readonly version: number,
    /** Размер сохранённого JSON в байтах. */
    readonly bytes: number,
  ) {
    super("Сохранённые данные аккаунта повреждены. Обратитесь к администратору — данные в базе не тронуты.");
    this.name = "StoredStateError";
  }
}

/** Состояние больше MAX_STATE_BYTES (и больше уже сохранённого). */
export class StateTooLargeError extends DomainError {
  constructor() {
    super("Слишком много данных для одного аккаунта.");
    this.name = "StateTooLargeError";
  }
}

// ---------- кэш разобранного состояния ----------

/**
 * Разобранные и проверенные состояния последних пользователей: без кэша каждый запрос заново разбирал бы
 * и проверял схемой до 10 МБ JSON. Запись действительна, пока у строки в базе те же version и rev.
 * Состояния в кэше общие для запросов — их нельзя менять (редьюсер и метрики их и не меняют).
 */
const MAX_CACHED_STATES = 50;
/** Предел суммарного размера (по JSON) закэшированных состояний. */
const MAX_CACHED_BYTES = 48 * 1024 * 1024;
const stateCache = new Map<number, LoadedState>();
let cachedBytes = 0;

function uncache(userId: number): void {
  const entry = stateCache.get(userId);
  if (!entry) return;
  stateCache.delete(userId);
  cachedBytes -= entry.bytes;
}

function cacheGet(userId: number, version: number, rev: number): LoadedState | undefined {
  const entry = stateCache.get(userId);
  if (!entry) return undefined;
  if (entry.version !== version || entry.rev !== rev) {
    uncache(userId);
    return undefined;
  }
  // Последний использованный — в конец (вытесняется самый давний).
  stateCache.delete(userId);
  stateCache.set(userId, entry);
  return entry;
}

function cachePut(userId: number, entry: LoadedState): void {
  uncache(userId);
  if (entry.bytes > MAX_CACHED_BYTES) return;
  stateCache.set(userId, entry);
  cachedBytes += entry.bytes;
  while (stateCache.size > MAX_CACHED_STATES || cachedBytes > MAX_CACHED_BYTES) {
    const oldest = stateCache.keys().next().value;
    if (oldest === undefined) break;
    uncache(oldest);
  }
}

/** Для тестов. */
export function clearStateCache(): void {
  stateCache.clear();
  cachedBytes = 0;
}

export const STATE_CACHE_LIMITS = { states: MAX_CACHED_STATES, bytes: MAX_CACHED_BYTES } as const;

// ---------- чтение и запись ----------

/**
 * Разбор сохранённого JSON. Не прошедшее проверку состояние текущего формата пробуем исправить
 * так же, как файл при импорте (дубликаты id, служебные имена — см. migrateState): данные, сохранённые
 * до ужесточения схемы, не должны запирать аккаунт. Исправленное сохранится при следующей записи.
 */
function parseStored(userId: number, version: number, json: string, bytes: number): State {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch (error) {
    console.error(`[state] user ${userId} v${version}: state_json не разбирается как JSON`, error);
    throw new StoredStateError(userId, version, bytes);
  }
  const parsed = stateSchema.safeParse(raw);
  // Только проверка: отдаём ровно то, что сохранено (результат редьюсера, см. applyUserOps), без преобразований схемы.
  if (parsed.success) return raw as State;
  const issue = parsed.error.issues[0];
  const problem = `${issue?.path.join(".")}: ${issue?.message}`;
  if (isCurrentFormat(raw)) {
    try {
      const repaired = migrateState(raw, todayLocal());
      console.warn(
        `[state] user ${userId} v${version}: состояние не проходило проверку (${problem}) и исправлено при чтении` +
          (repaired.report.dropped.length ? `: ${repaired.report.dropped.join("; ")}` : ""),
      );
      return repaired.state;
    } catch (error) {
      if (!(error instanceof MigrationError)) throw error;
    }
  }
  console.error(`[state] user ${userId} v${version}: состояние не проходит проверку — ${problem}`);
  throw new StoredStateError(userId, version, bytes);
}

function readRow(userId: number): LoadedState | null {
  const db = getDb();
  // Сначала только метка строки: если состояние не менялось, 10 МБ JSON не читаются и не разбираются.
  const head = db.prepare("SELECT version, rev FROM states WHERE user_id = ?").get(userId) as
    | { version: number; rev: number }
    | undefined;
  if (!head) return null;
  const cached = cacheGet(userId, head.version, head.rev);
  if (cached) return cached;
  const row = db.prepare("SELECT version, rev, state_json FROM states WHERE user_id = ?").get(userId) as
    | { version: number; rev: number; state_json: string }
    | undefined;
  if (!row) return null;
  const bytes = Buffer.byteLength(row.state_json, "utf8");
  const state = parseStored(userId, row.version, row.state_json, bytes);
  const loaded: LoadedState = { version: row.version, rev: row.rev, bytes, state };
  cachePut(userId, loaded);
  return loaded;
}

/** Состояние пользователя; у нового пользователя — пустое с версией 0. Бросает StoredStateError. */
export function loadState(userId: number): StoredState {
  const loaded = readRow(userId);
  return loaded ? { version: loaded.version, state: loaded.state } : { version: 0, state: emptyState() };
}

/**
 * Записывает состояние (кэш не трогает: его обновляет applyUserOps после фиксации транзакции).
 * Больше MAX_STATE_BYTES можно записать, только если состояние не больше уже сохранённого (currentBytes):
 * аккаунт, переросший предел, остаётся доступным, чтобы удалить лишнее.
 */
export function writeState(userId: number, state: State, version: number, currentBytes = 0): LoadedState {
  const json = JSON.stringify(state);
  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes > Math.max(MAX_STATE_BYTES, currentBytes)) throw new StateTooLargeError();
  const db = getDb();
  db.prepare(
    `INSERT INTO states (user_id, version, state_json, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET version = excluded.version, state_json = excluded.state_json,
     updated_at = excluded.updated_at`,
  ).run(userId, version, json, Date.now());
  const { rev } = db.prepare("SELECT rev FROM states WHERE user_id = ?").get(userId) as { rev: number };
  return { version, rev, bytes, state };
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly actionIndex: number,
  ) {
    super(message);
  }
}

export interface Op {
  /** Уникальный id изменения, который генерирует клиент. */
  opId: string;
  action: Action;
}

export interface ApplyResult extends StoredState {
  /** Изменило ли что-то это применение (иначе версия не увеличивается). */
  changed: boolean;
  /** Сколько изменений уже были применены раньше и пропущены. */
  duplicates: number;
}

// ---------- применённые opId ----------

/** Сколько помним применённые opId: дольше этого очередь на устройстве не живёт. */
const OP_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
/** И не больше стольких последних на пользователя: столько изменений очередь одного устройства не накопит. */
export const MAX_APPLIED_OPS_PER_USER = 20_000;
/** Подрезка до предела проходит по всем opId пользователя, поэтому — раз в столько запросов пользователя. */
export const PRUNE_EVERY_REQUESTS = 20;
const requestsSincePrune = new Map<number, number>();

/** Оставляет у пользователя не больше MAX_APPLIED_OPS_PER_USER самых новых opId. */
export function pruneAppliedOps(userId: number): void {
  getDb()
    .prepare(
      `DELETE FROM applied_ops WHERE rowid IN (
         SELECT rowid FROM applied_ops WHERE user_id = ? ORDER BY applied_at DESC LIMIT -1 OFFSET ?)`,
    )
    .run(userId, MAX_APPLIED_OPS_PER_USER);
}

function forgetOldOps(userId: number, now: number): void {
  // Индекс (user_id, applied_at): удаляются только просроченные строки, без прохода по всем.
  getDb().prepare("DELETE FROM applied_ops WHERE user_id = ? AND applied_at < ?").run(userId, now - OP_RETENTION_MS);
  const requests = (requestsSincePrune.get(userId) ?? 0) + 1;
  if (requests < PRUNE_EVERY_REQUESTS) {
    requestsSincePrune.set(userId, requests);
    return;
  }
  requestsSincePrune.delete(userId);
  pruneAppliedOps(userId);
}

// ---------- применение изменений ----------

type Issues = readonly { message: string }[];
type Step = { index: number; state: State };

/**
 * Ищет двоичным поиском границу «ещё хорошо → уже плохо» среди состояний после каждого действия:
 * O(log n) дорогих проверок вместо n. Исходное состояние хорошее, а плохое, раз появившись,
 * обычно не исчезает, — тогда найденное действие и есть первое такое. Работает только на пути ошибки.
 */
function findBadStep(steps: readonly Step[], isBad: (state: State) => boolean): number {
  let lo = -1; // последний известный хороший шаг (-1 — исходное состояние)
  let hi = steps.length - 1; // известный плохой шаг
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (isBad(steps[mid].state)) hi = mid;
    else lo = mid;
  }
  return hi;
}

/** Итоговое состояние не прошло проверку схемой: индекс действия, после которого оно стало некорректным. */
function findInvalidStep(steps: readonly Step[], finalIssues: Issues): ActionError {
  let issues = finalIssues;
  const hi = findBadStep(steps, (state) => {
    const checked = stateSchema.safeParse(state);
    if (!checked.success) issues = checked.error.issues;
    return !checked.success;
  });
  return new ActionError(`Некорректные данные: ${issues[0]?.message ?? "ошибка проверки"}`, steps[hi]?.index ?? 0);
}

/** Итоговое состояние слишком большое: индекс действия, после которого оно переросло предел. */
function findOversizedStep(steps: readonly Step[], allowedBytes: number, message: string): ActionError {
  const hi = findBadStep(steps, (state) => Buffer.byteLength(JSON.stringify(state), "utf8") > allowedBytes);
  return new ActionError(message, steps[hi]?.index ?? 0);
}

/**
 * Повторная синхронизация шаблонов, которая заведомо ничего не начислит, — её можно не выполнять
 * (пачка из сотни синхронизаций иначе сканировала бы шаблоны сотню раз). Так бывает, если состояние
 * не менялось с прошлой синхронизации, а новая дата — в том же месяце и не позже прежней: окно месяцев
 * то же, а всё, что было к прежней дате, уже начислено. Результат совпадает с редьюсером на клиенте.
 */
function isNoopSync(last: { today: IsoDate; result: State }, state: State, today: IsoDate): boolean {
  return last.result === state && today <= last.today && monthKeyOf(today) === monthKeyOf(last.today);
}

/**
 * Состояние, к которому применяется пачка. Если сохранённое не читается и не исправляется, заменить его
 * можно только импортом, идущим в пачке первым (восстановление из файла): нумерация версий продолжается
 * с сохранённой. Импорт «только в пустой аккаунт» повреждённое состояние не заменяет — там могут быть данные.
 */
function loadForUpdate(userId: number, ops: readonly Op[], isApplied: (opId: string) => boolean): LoadedState {
  try {
    return readRow(userId) ?? { version: 0, rev: 0, bytes: 0, state: emptyState() };
  } catch (error) {
    const first = ops[0];
    if (!(error instanceof StoredStateError) || first?.action.type !== "state.import" || isApplied(first.opId)) {
      throw error;
    }
    if (first.action.ifEmpty) throw new ActionError(IMPORT_NOT_EMPTY_MESSAGE, 0);
    console.warn(`[state] user ${userId} v${error.version}: повреждённое состояние заменяется импортом`);
    return { version: error.version, rev: 0, bytes: error.bytes, state: emptyState() };
  }
}

/**
 * Применяет пачку изменений атомарно: либо все, либо ни одного.
 * Изменения с уже известным opId пропускаются — повторная отправка безопасна.
 * serverToday — дата сервера. «Сегодня» из действия не может опережать её больше чем на сутки
 * (часовые пояса), иначе устройство с неверными часами начислило бы платежи из будущего.
 * Дата в прошлом допустима: изменения, сделанные офлайн несколько дней назад, отправляются как есть.
 */
export function applyUserOps(userId: number, ops: Op[], serverToday: IsoDate, now = Date.now()): ApplyResult {
  // Промежуточные состояния (для поиска виновника ошибки) хранятся по одному на изменение — их не больше этого.
  if (ops.length > MAX_OPS_PER_REQUEST) throw new RangeError(`Не больше ${MAX_OPS_PER_REQUEST} изменений за запрос`);
  const db = getDb();
  let written = null as LoadedState | null;
  const result = transaction(db, (): ApplyResult => {
    const seen = db.prepare("SELECT 1 FROM applied_ops WHERE user_id = ? AND op_id = ?");
    const isApplied = (opId: string) => seen.get(userId, opId) !== undefined;
    const current = loadForUpdate(userId, ops, isApplied);
    const remember = db.prepare("INSERT OR IGNORE INTO applied_ops (user_id, op_id, applied_at) VALUES (?, ?, ?)");
    const latestToday = addDays(serverToday, 1);
    let state = current.state;
    let duplicates = 0;
    const batchIds = new Set<string>();
    /** Состояния после каждого применённого действия — только для поиска виновника, если итог плохой. */
    const steps: Step[] = [];
    /** Последняя выполненная синхронизация шаблонов и её результат. */
    let lastSync: { today: IsoDate; result: State } | null = null;

    ops.forEach(({ opId, action }, index) => {
      if (batchIds.has(opId) || isApplied(opId)) {
        duplicates += 1;
        return;
      }
      batchIds.add(opId);
      const today = actionToday(action);
      if (today && today > latestToday) {
        throw new ActionError("Дата на устройстве опережает текущую. Проверьте часы.", index);
      }
      if (action.type === "recurring.sync" && lastSync && isNoopSync(lastSync, state, action.today)) {
        steps.push({ index, state });
        return;
      }
      try {
        state = applyAction(state, action);
      } catch (error) {
        if (error instanceof DomainError) throw new ActionError(error.message, index);
        throw error;
      }
      if (action.type === "recurring.sync") lastSync = { today: action.today, result: state };
      steps.push({ index, state });
    });

    for (const opId of batchIds) remember.run(userId, opId, now);
    forgetOldOps(userId, now);

    if (state === current.state) return { version: current.version, state, changed: false, duplicates };
    // Страховка: в базу попадает только корректное состояние. Сохраняем сам результат редьюсера
    // (а не результат разбора схемой) — ровно то же, что получил клиент, применив те же действия.
    const checked = stateSchema.safeParse(state);
    if (!checked.success) throw findInvalidStep(steps, checked.error.issues);
    const version = current.version + 1;
    try {
      written = writeState(userId, state, version, current.bytes);
    } catch (error) {
      if (error instanceof StateTooLargeError) {
        throw findOversizedStep(steps, Math.max(MAX_STATE_BYTES, current.bytes), error.message);
      }
      throw error;
    }
    return { version, state, changed: true, duplicates };
  });
  // В кэш — только после фиксации: откаченная запись не должна попасть в него.
  if (written) cachePut(userId, written);
  return result;
}
