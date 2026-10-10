import { DomainError, actionSchema, applyAction, type Action } from "@/domain/actions";
import { monthKeyOf, todayLocal } from "@/domain/dates";
import { emptyState } from "@/domain/defaults";
import { newId } from "@/domain/ids";
import { MigrationError, migrateState, type MigrationReport } from "@/domain/migrate";
import { stateSchema, type State } from "@/domain/schema";
import { ApiError, TOKEN_KEY, api, type Op, type PublicUser } from "./api";
import { storage } from "./storage";

export type SyncStatus = "synced" | "saving" | "offline" | "error";

export interface Snapshot {
  phase: "loading" | "ready";
  mode: "guest" | "account";
  user: PublicUser | null;
  /** Сессия истекла, а на устройстве остались неотправленные изменения. */
  sessionExpired: boolean;
  aiEnabled: boolean;
  registrationOpen: boolean;
  state: State;
  version: number;
  sync: { status: SyncStatus; pending: number; message: string | null };
  /** После входа: в браузере есть гостевые данные, а аккаунт пустой — можно перенести. */
  guestImportOffer: boolean;
  /** В браузере найдены данные старой версии приложения. */
  legacyImportOffer: boolean;
}

/** Вход в другой аккаунт удалит неотправленные изменения прежнего — нужно подтверждение. */
export class PendingChangesError extends Error {
  constructor(
    readonly previousLogin: string,
    readonly pending: number,
  ) {
    super(`В аккаунте «${previousLogin}» есть неотправленные изменения (${pending}).`);
    this.name = "PendingChangesError";
  }
}

export type DispatchResult = { ok: true } | { ok: false; error: string };
export type Notify = (message: string, kind?: "info" | "error") => void;

const GUEST_KEY = "fp:guest";
const GUEST_REV_KEY = "fp:guest:rev";
/** Перенос гостевых данных в аккаунт ждёт ответа сервера: {opId, rev, login}. */
const GUEST_IMPORT_KEY = "fp:guest-import";
const ACCOUNT_KEY_PREFIX = "fp:account:";
const LAST_ACCOUNT_KEY = "fp:last-account";
/** Выход без сети: сессию на сервере нужно завершить при первой возможности. */
const LOGOUT_PENDING_KEY = "fp:logout-pending";
const LEGACY_KEYS = ["financePlannerData_v2", "financePlannerData_v1"];
const LEGACY_DONE_KEY = "fp:legacy-handled";
const BATCH_SIZE = 100;
/** Пачка не больше ~4 МБ: сервер принимает до 10 МБ, а изменения бывают большими (импорт). */
const BATCH_BYTES = 4_000_000;
/** Импорт больше этого сервер не примет (предел состояния — 10 МБ). */
const MAX_IMPORT_BYTES = 9_500_000;
const ACKED_MEMORY = 2_000;
const DROPPED_MEMORY = 500;

/** Кэш аккаунта на устройстве: подтверждённое сервером состояние и неотправленные изменения. */
interface AccountCache {
  version: number;
  state: State;
  ops: Op[];
  /** Изменения, от которых отказались (сервер отклонил или они больше не применимы) — не возвращать в очередь. */
  dropped: string[];
  /** Состояние могло отстать от сервера при той же версии — при первой возможности перечитать. */
  outdated: boolean;
  /** Сохранённое состояние не прочиталось — вместо него пустая заглушка до ответа сервера. */
  placeholder?: boolean;
}

function loginKey(login: string): string {
  return login.trim().toLocaleLowerCase("ru");
}

function sameLogin(a: string | null | undefined, b: string | null | undefined): boolean {
  return Boolean(a && b && loginKey(a) === loginKey(b));
}

function accountKey(login: string): string {
  return ACCOUNT_KEY_PREFIX + loginKey(login);
}

function hasData(state: State): boolean {
  return state.transactions.length > 0 || state.templates.length > 0 || state.goals.length > 0 || state.loans.length > 0;
}

/** Применяет изменения по одному; те, что больше не применимы (например, к удалённой операции), отбрасывает. */
function rebase(state: State, ops: Op[]): { state: State; applied: Op[]; failed: { op: Op; message: string }[] } {
  const applied: Op[] = [];
  const failed: { op: Op; message: string }[] = [];
  for (const op of ops) {
    try {
      state = applyAction(state, op.action);
      applied.push(op);
    } catch (error) {
      if (error instanceof DomainError) failed.push({ op, message: error.message });
      else throw error;
    }
  }
  return { state, applied, failed };
}

function errorMessage(error: unknown): string {
  if (error instanceof ApiError || error instanceof DomainError || error instanceof MigrationError) return error.message;
  if (error && typeof error === "object" && "issues" in error) {
    const issues = (error as { issues: { message: string }[] }).issues;
    return issues[0]?.message ?? "Некорректные данные.";
  }
  return "Что-то пошло не так.";
}

function isStateCorrupted(error: unknown): boolean {
  return error instanceof ApiError && error.data.code === "state-corrupted";
}

const encoder = new TextEncoder();
function byteSize(value: unknown): number {
  return encoder.encode(JSON.stringify(value)).length;
}

function isAccountMismatch(error: unknown): boolean {
  return error instanceof ApiError && error.status === 409 && error.data.code === "account-mismatch";
}

/** Разбор очереди из кэша: изменения в старом формате (без opId) получают новые id. */
function parseOps(raw: unknown): Op[] {
  if (!Array.isArray(raw)) return [];
  const ops: Op[] = [];
  for (const item of raw) {
    const candidate =
      item && typeof item === "object" && "opId" in item && "action" in item
        ? (item as { opId: unknown; action: unknown })
        : { opId: newId(), action: item };
    const action = actionSchema.safeParse(candidate.action);
    if (action.success && typeof candidate.opId === "string") ops.push({ opId: candidate.opId, action: action.data });
  }
  return ops;
}

function parseIds(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/**
 * Хранилище данных приложения.
 *
 * Гость: всё в localStorage. Аккаунт: подтверждённое сервером состояние (base) плюс очередь
 * неотправленных изменений (pending). Экран показывает base + pending — изменения видны сразу,
 * а сервер применяет те же действия тем же кодом и остаётся источником истины.
 *
 * Надёжность:
 *  - у каждого изменения есть opId, сервер не применяет его дважды — повторная отправка безопасна;
 *  - после каждого ожидания ответа проверяется epoch: если за это время вышли из аккаунта
 *    или вошли в другой, ответ игнорируется;
 *  - несколько вкладок работают с общим localStorage: перед записью гостевых данных проверяется ревизия,
 *    очередь аккаунта объединяется, отброшенные изменения помнятся («надгробия»), изменения и входы/выходы
 *    в других вкладках подхватываются по событию storage; запросы несут ожидаемый логин (X-Account).
 */
export class FinanceStore {
  private listeners = new Set<() => void>();
  private snapshot: Snapshot = {
    phase: "loading",
    mode: "guest",
    user: null,
    sessionExpired: false,
    aiEnabled: false,
    registrationOpen: true,
    state: emptyState(),
    version: 0,
    sync: { status: "synced", pending: 0, message: null },
    guestImportOffer: false,
    legacyImportOffer: false,
  };
  private base: { version: number; state: State } = { version: 0, state: emptyState() };
  private pending: Op[] = [];
  private inflight: Op[] | null = null;
  private outdated = false;
  /** База — заглушка вместо нечитаемого кэша: изменения не отбрасываем, пока не придут данные сервера. */
  private basePlaceholder = false;
  /** После ответа 413 отправляем по одному изменению. */
  private singleOpBatches = false;
  /** Подтверждённые сервером opId — чтобы не вернуть их в очередь из кэша другой вкладки. */
  private acked = new Set<string>();
  /** Отброшенные opId (общие для вкладок через кэш). */
  private dropped = new Set<string>();
  /** Меняется при входе, выходе и смене режима: ответы на старые запросы игнорируются. */
  private epoch = 0;
  private guestRev: string | null = null;
  /** Этот экземпляр уже записывал кэш текущего аккаунта (значит, его пропажа — выход в другой вкладке). */
  private cacheWritten = false;
  /** Нужно заново спросить сервер, кто вошёл (первый запрос не удался или выход ещё не дошёл до сервера). */
  private needsReinit = false;
  private connecting: Promise<void> | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryDelay = 2_000;
  private lastRefresh = 0;
  private cacheWarningShown = false;
  private notify: Notify = () => {};
  private signOutListeners = new Set<(login: string) => void>();
  private initialized = false;

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): Snapshot => this.snapshot;

  setNotifier(notify: Notify): void {
    this.notify = notify;
  }

  /** Подписка на выход из аккаунта (например, чтобы забыть переписку с AI). */
  onSignOut(listener: (login: string) => void): () => void {
    this.signOutListeners.add(listener);
    return () => this.signOutListeners.delete(listener);
  }

  private emitSignOut(login: string | undefined): void {
    if (!login) return;
    for (const l of this.signOutListeners) l(login);
  }

  private set(patch: Partial<Snapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    for (const l of this.listeners) l();
  }

  private queueSize(): number {
    return this.pending.length + (this.inflight?.length ?? 0);
  }

  private get currentLogin(): string | undefined {
    return this.snapshot.mode === "account" ? this.snapshot.user?.login : undefined;
  }

  // ---------- загрузка ----------

  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;
    this.set({ legacyImportOffer: this.detectLegacyData() });
    if (typeof window !== "undefined") window.addEventListener("storage", (e) => this.handleStorageChange(e.key));

    // Если на устройстве есть кэш аккаунта — показываем его сразу, не дожидаясь сервера.
    const lastLogin = storage.get(LAST_ACCOUNT_KEY);
    const cache = lastLogin && !storage.get(LOGOUT_PENDING_KEY) ? this.readAccountCache(lastLogin) : null;
    if (lastLogin && cache) this.showCachedAccount({ login: lastLogin, name: null }, cache);
    await this.connect();
  }

  /** Спрашивает сервер, кто вошёл, и переходит в нужный режим. Параллельные вызовы объединяются. */
  private connect(): Promise<void> {
    this.connecting ??= this.doConnect().finally(() => {
      this.connecting = null;
    });
    return this.connecting;
  }

  private async doConnect(): Promise<void> {
    const epoch = this.epoch;
    if (storage.get(LOGOUT_PENDING_KEY)) {
      // Выход был без сети: пока сервер не завершил сессию, не доверяем ей.
      try {
        await api.logout();
        storage.remove(LOGOUT_PENDING_KEY);
        storage.remove(TOKEN_KEY);
      } catch {
        this.needsReinit = true;
        if (this.snapshot.mode !== "guest" || this.snapshot.phase === "loading") this.enterGuest();
        this.scheduleRetry();
        return;
      }
    }

    let me;
    try {
      me = await api.me();
    } catch {
      if (epoch !== this.epoch) return;
      this.needsReinit = true;
      if (this.snapshot.mode === "account") {
        this.setSync("offline", "Нет связи с сервером — изменения сохранятся на устройстве и отправятся позже.");
      } else {
        this.enterGuest();
      }
      this.scheduleRetry();
      return;
    }
    if (epoch !== this.epoch) return;
    this.needsReinit = false;
    this.set({ aiEnabled: me.aiEnabled, registrationOpen: me.registrationOpen });

    if (me.user) {
      const shown = this.currentLogin;
      if (shown && !sameLogin(shown, me.user.login)) {
        // На устройстве показан другой аккаунт — его очередь остаётся в кэше до входа в него.
        this.emitSignOut(shown);
      }
      await this.enterAccount(me.user);
      return;
    }
    // Сессии нет.
    const shown = this.currentLogin;
    if (shown) {
      if (this.queueSize() > 0) {
        this.set({ sessionExpired: true });
        this.setSync("error", "Сессия истекла — войдите снова, чтобы отправить изменения.");
        return;
      }
      this.dropAccountCache(shown);
      storage.remove(TOKEN_KEY);
      this.emitSignOut(shown);
    }
    this.enterGuest();
  }

  private enterGuest(): void {
    this.epoch += 1;
    this.cacheWritten = false;
    this.base = { version: 0, state: this.readGuestState() };
    this.pending = [];
    this.inflight = null;
    this.outdated = false;
    this.dropped = new Set();
    this.set({
      phase: "ready",
      mode: "guest",
      user: null,
      sessionExpired: false,
      state: this.base.state,
      version: 0,
      sync: { status: "synced", pending: 0, message: null },
      guestImportOffer: false,
    });
  }

  private readGuestState(): State {
    this.guestRev = storage.get(GUEST_REV_KEY);
    const raw = storage.getJson(GUEST_KEY);
    if (!raw) return emptyState();
    try {
      return migrateState(raw, todayLocal()).state;
    } catch {
      // Не затираем то, что не смогли прочитать: сохраняем копию, прежде чем начать с чистого листа.
      const backupKey = `${GUEST_KEY}:backup`;
      if (!storage.get(backupKey)) storage.set(backupKey, storage.get(GUEST_KEY) ?? "");
      this.notify(
        "Не удалось прочитать данные из браузера. Копия сохранена — обратитесь к разработчику, если она нужна.",
        "error",
      );
      return emptyState();
    }
  }

  private readAccountCache(login: string): AccountCache | null {
    const raw = storage.getJson(accountKey(login));
    if (!raw || typeof raw !== "object") return null;
    const cache = raw as Record<string, unknown>;
    const dropped = parseIds(cache.dropped);
    const droppedSet = new Set(dropped);
    const ops = parseOps(cache.ops ?? cache.pending).filter((op) => !droppedSet.has(op.opId));
    let state: State | null = null;
    const parsedState = stateSchema.safeParse(cache.state);
    if (parsedState.success) state = parsedState.data;
    else {
      // Кэш записан прежней версией приложения — пробуем починить так же, как это делает сервер.
      try {
        state = migrateState(cache.state, todayLocal()).state;
      } catch {
        state = null;
      }
    }
    if (!state || typeof cache.version !== "number") {
      // Сохранённое состояние не прочиталось, но очередь не теряем: свежие данные придут с сервера.
      return ops.length ? { version: 0, state: emptyState(), ops, dropped, outdated: true, placeholder: true } : null;
    }
    return { version: cache.version, state, ops, dropped, outdated: cache.outdated === true };
  }

  /**
   * Записывает кэш аккаунта, объединяя очередь с тем, что успели записать другие вкладки.
   * Более новая подтверждённая версия (от другой вкладки) не затирается.
   */
  private writeAccountCache(authoritative = false): void {
    const login = this.currentLogin;
    if (!login) return;
    const last = storage.get(LAST_ACCOUNT_KEY);
    if (this.cacheWritten && !last) {
      // В другой вкладке вышли из аккаунта — не воскрешаем кэш.
      queueMicrotask(() => this.handleStorageChange(LAST_ACCOUNT_KEY));
      return;
    }
    const key = accountKey(login);
    const existing = storage.getJson(key) as Record<string, unknown> | null;
    for (const id of parseIds(existing?.dropped)) this.dropped.add(id);
    if (this.dropped.size > DROPPED_MEMORY) this.dropped = new Set([...this.dropped].slice(-DROPPED_MEMORY));
    const own = [...(this.inflight ?? []), ...this.pending];
    const ownIds = new Set(own.map((op) => op.opId));
    const foreign = parseOps(existing?.ops).filter(
      (op) => !this.acked.has(op.opId) && !ownIds.has(op.opId) && !this.dropped.has(op.opId),
    );
    const existingVersion = typeof existing?.version === "number" ? existing.version : -1;
    // Более новую версию другой вкладки не затираем — если только наша база не пришла с сервера только что
    // (версия на сервере могла уменьшиться: восстановление из копии, пересоздание аккаунта).
    const keepExisting = !authoritative && existingVersion > this.base.version && existing?.state;
    const cache = {
      version: keepExisting ? existingVersion : this.base.version,
      state: keepExisting ? existing.state : this.base.state,
      ops: [...foreign, ...own],
      dropped: [...this.dropped],
      outdated: keepExisting ? existing.outdated === true : this.outdated,
    };
    let ok = storage.setJson(key, cache);
    // Последний аккаунт переписываем только если он наш: вход в другой аккаунт в соседней вкладке не трогаем.
    if (!last || sameLogin(last, login)) ok = storage.set(LAST_ACCOUNT_KEY, login) && ok;
    else queueMicrotask(() => this.handleStorageChange(LAST_ACCOUNT_KEY));
    this.cacheWritten = true;
    if (!ok && !this.cacheWarningShown) {
      this.cacheWarningShown = true;
      this.notify(
        "Не удалось сохранить данные на устройстве (нет места). Не закрывайте приложение, пока изменения не отправятся.",
        "error",
      );
    }
  }

  private dropAccountCache(login: string): void {
    if (sameLogin(storage.get(LAST_ACCOUNT_KEY), login)) storage.remove(LAST_ACCOUNT_KEY);
    storage.remove(accountKey(login));
  }

  private showCachedAccount(user: PublicUser, cache: AccountCache): void {
    this.base = { version: cache.version, state: cache.state };
    this.pending = cache.ops;
    this.dropped = new Set(cache.dropped);
    this.outdated = cache.outdated;
    this.basePlaceholder = cache.placeholder === true;
    this.set({ phase: "ready", mode: "account", user, sessionExpired: false, guestImportOffer: false });
    this.recompute();
  }

  private async enterAccount(user: PublicUser): Promise<void> {
    this.epoch += 1;
    const epoch = this.epoch;
    this.cacheWritten = false;
    const cache = this.readAccountCache(user.login);
    this.base = cache ? { version: cache.version, state: cache.state } : { version: 0, state: emptyState() };
    this.pending = cache?.ops ?? [];
    this.dropped = new Set(cache?.dropped ?? []);
    this.inflight = null;
    this.outdated = cache?.outdated ?? false;
    this.basePlaceholder = cache?.placeholder === true;
    this.set({
      mode: "account",
      user,
      sessionExpired: false,
      sync: { status: this.pending.length ? "saving" : "synced", pending: this.pending.length, message: null },
      // С кэшем показываем данные сразу, свежие подтянутся следом.
      ...(cache ? { phase: "ready" as const } : {}),
    });
    this.recompute();
    try {
      const server = await api.getState(user.login);
      if (epoch !== this.epoch) return;
      this.base = server;
      this.outdated = false;
      this.basePlaceholder = false;
      this.lastRefresh = Date.now();
      // Сервер подтвердил, в чей аккаунт мы вошли, — это и есть «последний аккаунт» устройства.
      storage.set(LAST_ACCOUNT_KEY, user.login);
      this.recompute();
      this.set({
        phase: "ready",
        guestImportOffer: this.guestHasData() && !hasData(server.state) && this.queueSize() === 0,
      });
      this.writeAccountCache(true);
      void this.flush();
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.set({ phase: "ready" });
      if (error instanceof ApiError && error.status === 401) this.handleUnauthorized();
      else if (isAccountMismatch(error)) void this.connect();
      else if (isStateCorrupted(error)) this.setSync("error", (error as ApiError).message);
      else {
        this.setSync("offline", "Нет связи с сервером — показываем сохранённые на устройстве данные.");
        this.scheduleRetry();
      }
    }
  }

  private guestHasData(): boolean {
    const raw = storage.getJson(GUEST_KEY);
    if (!raw) return false;
    try {
      return hasData(migrateState(raw, todayLocal()).state);
    } catch {
      return false;
    }
  }

  // ---------- другие вкладки ----------

  /** Другая вкладка изменила localStorage (или эта вкладка заметила такое изменение сама). */
  handleStorageChange(key: string | null): void {
    if (this.snapshot.phase !== "ready") return;
    const last = storage.get(LAST_ACCOUNT_KEY);

    if (key === LAST_ACCOUNT_KEY || key === null) {
      // Вход в аккаунт в другой вкладке — cookie сессии общая, значит и эта вкладка теперь в нём.
      if (last && this.snapshot.mode === "guest" && !storage.get(LOGOUT_PENDING_KEY)) {
        void this.connect();
        return;
      }
      const login = this.currentLogin;
      if (last && login && (!sameLogin(last, login) || this.snapshot.sessionExpired)) {
        void this.connect();
        return;
      }
    }

    if (this.snapshot.mode === "guest") {
      if (key !== GUEST_KEY && key !== GUEST_REV_KEY && key !== null) return;
      if (storage.get(GUEST_REV_KEY) === this.guestRev) return;
      this.base = { version: 0, state: this.readGuestState() };
      this.set({ state: this.base.state });
      return;
    }

    const login = this.currentLogin;
    if (!login || (key !== LAST_ACCOUNT_KEY && key !== accountKey(login) && key !== null)) return;
    if (this.snapshot.sessionExpired && storage.get(accountKey(login))) {
      // Возможно, в соседней вкладке снова вошли в этот аккаунт — проверим сессию.
      void this.connect();
      return;
    }
    if (!last && !storage.get(accountKey(login))) {
      // В другой вкладке вышли из аккаунта.
      this.emitSignOut(login);
      this.enterGuest();
      return;
    }
    const cache = this.readAccountCache(login);
    if (!cache) return;
    for (const id of cache.dropped) this.dropped.add(id);
    const cacheIds = new Set(cache.ops.map((op) => op.opId));
    if (cache.version > this.base.version) {
      this.base = { version: cache.version, state: cache.state };
      this.outdated = cache.outdated;
      // Чего нет в кэше с более новой версией — уже подтверждено сервером через другую вкладку.
      this.pending = this.pending.filter((op) => cacheIds.has(op.opId));
    }
    const known = new Set([...this.pending, ...(this.inflight ?? [])].map((op) => op.opId));
    const adopted = cache.ops.filter(
      (op) => !known.has(op.opId) && !this.acked.has(op.opId) && !this.dropped.has(op.opId),
    );
    if (adopted.length) this.pending.push(...adopted);
    this.recompute();
    if (adopted.length) queueMicrotask(() => void this.flush());
  }

  // ---------- изменения ----------

  /** Проверяет и применяет действия. Ошибку можно сразу показать пользователю. */
  dispatch(input: Action | Action[]): DispatchResult {
    const result = this.dispatchOps(input);
    return result.ok ? { ok: true } : result;
  }

  private dispatchOps(input: Action | Action[]): { ok: true; opIds: string[] } | { ok: false; error: string } {
    let actions: Action[];
    try {
      actions = (Array.isArray(input) ? input : [input]).map((a) =>
        // Новая норма сбережений действует с текущего месяца, прошлые месяцы не пересчитываются.
        actionSchema.parse(a.type === "settings.update" && !a.effectiveFrom ? { ...a, effectiveFrom: monthKeyOf(todayLocal()) } : a),
      );
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }

    if (this.snapshot.mode === "guest") {
      // Другая вкладка могла записать свои изменения — применяем поверх них, а не поверх устаревшей копии.
      if (storage.get(GUEST_REV_KEY) !== this.guestRev) this.base = { version: 0, state: this.readGuestState() };
      let next: State;
      try {
        next = actions.reduce(applyAction, this.base.state);
      } catch (error) {
        if (error instanceof DomainError) return { ok: false, error: error.message };
        throw error;
      }
      this.base = { version: 0, state: next };
      const rev = newId();
      if (storage.setJson(GUEST_KEY, next) && storage.set(GUEST_REV_KEY, rev)) this.guestRev = rev;
      else this.notify("Не удалось сохранить данные в браузере (нет места или приватный режим).", "error");
      this.set({ state: next });
      return { ok: true, opIds: [] };
    }

    let next: State;
    try {
      next = actions.reduce(applyAction, this.snapshot.state);
    } catch (error) {
      if (error instanceof DomainError) return { ok: false, error: error.message };
      throw error;
    }
    if (next === this.snapshot.state) return { ok: true, opIds: [] };
    const ops = actions.map((action) => ({ opId: newId(), action }));
    if (actions.some((a) => a.type === "state.import" && !a.ifEmpty)) {
      // Полный импорт заменяет все данные: ещё не отправленные изменения до него теряют смысл.
      // Перенос гостевых данных (ifEmpty) сохраняет настройки аккаунта — очередь перед ним не трогаем.
      const importIndex = actions.findIndex((a) => a.type === "state.import" && !a.ifEmpty);
      for (const op of this.pending) this.dropped.add(op.opId);
      this.pending = [];
      ops.splice(0, importIndex);
    }
    this.pending.push(...ops);
    this.set({ state: next });
    this.writeAccountCache();
    this.updatePendingCount();
    queueMicrotask(() => void this.flush());
    return { ok: true, opIds: ops.map((op) => op.opId) };
  }

  private recompute(): void {
    // Отправленную пачку не трогаем — её судьбу решит ответ сервера.
    const withInflight = rebase(this.base.state, this.inflight ?? []).state;
    const { state, applied, failed } = rebase(withInflight, this.pending);
    // Пока вместо базы заглушка, «не применилось» ничего не значит — ждём данных сервера.
    if (failed.length && !this.basePlaceholder) {
      this.pending = applied;
      for (const { op } of failed) this.dropped.add(op.opId);
      this.notify(`Часть изменений не применена: ${failed[0].message}`, "error");
      this.writeAccountCache();
    }
    this.set({ state, version: this.base.version });
    this.updatePendingCount();
  }

  private updatePendingCount(): void {
    const pending = this.queueSize();
    const status = this.snapshot.sync.status;
    this.set({
      sync: {
        status: pending > 0 && status === "synced" ? "saving" : pending === 0 && status === "saving" ? "synced" : status,
        pending,
        message: pending === 0 && status !== "error" ? null : this.snapshot.sync.message,
      },
    });
  }

  private setSync(status: SyncStatus, message: string | null): void {
    this.set({ sync: { status, pending: this.queueSize(), message } });
  }

  private scheduleRetry(): void {
    if (this.retryTimer) return;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.resume();
    }, this.retryDelay);
    this.retryDelay = Math.min(this.retryDelay * 2, 60_000);
  }

  private cancelRetry(): void {
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  /** Повторная попытка связи (по таймеру, кнопке, при возвращении сети или фокусе окна). */
  async resume(): Promise<void> {
    if (this.needsReinit) {
      await this.connect();
      return;
    }
    if (this.snapshot.mode !== "account") return;
    if (this.snapshot.sessionExpired) {
      await this.connect(); // вдруг вошли снова (в другой вкладке)
      return;
    }
    if (this.queueSize() > 0) {
      await this.flush();
      return;
    }
    // После сбоя обновляем без паузы: иначе повтор упирался бы в ограничение частоты обновлений.
    await this.refresh(this.snapshot.sync.status !== "synced" || this.outdated);
  }

  private async flush(): Promise<void> {
    const login = this.currentLogin;
    if (!login || this.inflight || !this.pending.length || this.snapshot.sessionExpired) return;
    const epoch = this.epoch;
    const batch = this.pending.splice(0, this.nextBatchLength());
    this.inflight = batch;
    this.setSync("saving", null);
    const baseVersion = this.base.version;
    let result: { version: number; stale: boolean };
    try {
      result = await api.postOps(baseVersion, batch, login);
    } catch (error) {
      if (epoch !== this.epoch) return;
      await this.handleFlushError(error, batch);
      return;
    }
    if (epoch !== this.epoch) return;

    // Сервер применил пачку — дальше она не должна попасть в очередь повторно.
    this.inflight = null;
    this.retryDelay = 2_000;
    this.singleOpBatches = false;
    for (const op of batch) this.acked.add(op.opId);
    if (this.acked.size > ACKED_MEMORY) this.acked = new Set([...this.acked].slice(-ACKED_MEMORY / 2));
    this.finishGuestImport(batch, null);

    // Пока пачка летела, база могла смениться (другая вкладка) — тогда версия ответа к ней не подходит.
    const stale = result.stale || this.base.version !== baseVersion;
    const local = rebase(this.base.state, batch).state;
    let authoritative = false;
    if (!stale) {
      this.base = { version: result.version, state: local };
    } else {
      // Данные менялись с другого устройства — берём свежую версию и накладываем очередь сверху.
      try {
        const server = await api.getState(login);
        if (epoch !== this.epoch) return;
        this.base = server;
        this.outdated = false;
        this.basePlaceholder = false;
        authoritative = true;
      } catch (error) {
        if (epoch !== this.epoch) return;
        if (isAccountMismatch(error)) {
          void this.connect();
          return;
        }
        // Версию оставляем прежней: следующий запрос заметит расхождение и перечитает данные.
        this.base = { version: baseVersion, state: local };
        this.outdated = true;
      }
    }
    this.lastRefresh = Date.now();
    this.recompute();
    this.setSync(this.pending.length ? "saving" : "synced", null);
    this.writeAccountCache(authoritative);
    if (this.pending.length) await this.flush();
    else if (this.outdated) await this.refresh(true);
  }

  /**
   * Сколько изменений из начала очереди отправить одной пачкой: не больше BATCH_SIZE и ~BATCH_BYTES,
   * импорт — всегда отдельной пачкой (сервер разрешает импорт поверх повреждённых данных только первым).
   */
  private nextBatchLength(): number {
    if (this.singleOpBatches) return 1;
    if (this.pending[0]?.action.type === "state.import") return 1;
    let bytes = 0;
    let count = 0;
    for (const op of this.pending) {
      if (count >= BATCH_SIZE || op.action.type === "state.import") break;
      bytes += byteSize(op);
      if (count > 0 && bytes > BATCH_BYTES) break;
      count += 1;
    }
    return Math.max(1, count);
  }

  private async handleFlushError(error: unknown, batch: Op[]): Promise<void> {
    this.inflight = null;
    const rejectedIndex = error instanceof ApiError ? this.rejectedIndex(error, batch.length) : null;
    if (rejectedIndex !== null && error instanceof ApiError) {
      // Сервер отклонил одно изменение — выкидываем его, остальные отправляем снова.
      const rejected = batch[rejectedIndex];
      this.dropped.add(rejected.opId);
      this.finishGuestImport([], rejected.opId);
      this.pending = [...batch.slice(0, rejectedIndex), ...batch.slice(rejectedIndex + 1), ...this.pending];
      this.notify(`Сервер не принял изменение: ${error.message}`, "error");
      const epoch = this.epoch;
      let authoritative = false;
      try {
        const server = await api.getState(this.currentLogin);
        if (epoch !== this.epoch) return;
        this.base = server;
        this.outdated = false;
        this.basePlaceholder = false;
        authoritative = true;
      } catch {
        if (epoch !== this.epoch) return;
        this.outdated = true;
      }
      this.recompute();
      this.writeAccountCache(authoritative);
      this.setSync(this.pending.length ? "saving" : "synced", null);
      if (this.pending.length) await this.flush();
      return;
    }

    if (error instanceof ApiError && error.status === 413) {
      if (batch.length > 1) {
        // Пачка великовата — отправим по одному изменению.
        this.singleOpBatches = true;
        this.pending = [...batch, ...this.pending];
        await this.flush();
        return;
      }
      // Одно изменение больше, чем принимает сервер: отправить его нельзя — не держим из-за него очередь.
      this.dropped.add(batch[0].opId);
      this.singleOpBatches = false;
      this.notify("Изменение слишком большое для отправки на сервер и не сохранено.", "error");
      this.recompute();
      this.writeAccountCache();
      this.setSync(this.pending.length ? "saving" : "synced", null);
      if (this.pending.length) await this.flush();
      return;
    }
    this.pending = [...batch, ...this.pending];
    this.writeAccountCache();
    if (error instanceof ApiError && error.status === 401) {
      this.handleUnauthorized();
      return;
    }
    if (isStateCorrupted(error)) {
      // Данные на сервере не читаются: повторять бессмысленно, поможет восстановление из файла.
      this.setSync("error", (error as ApiError).message);
      return;
    }
    if (isAccountMismatch(error)) {
      // В соседней вкладке вошли в другой аккаунт: очередь остаётся в кэше прежнего, переключаемся.
      void this.connect();
      return;
    }
    if (error instanceof ApiError && (error.status === 400 || error.status === 422)) {
      // Не понятно, какое изменение виновато: ничего не выбрасываем и не повторяем по кругу.
      this.setSync("error", "Сервер не принял изменения. Обновите приложение и попробуйте снова.");
      return;
    }
    if (error instanceof ApiError && error.status === 429) {
      this.setSync("offline", "Сервер просит подождать — отправим изменения чуть позже.");
      this.scheduleRetry();
      return;
    }
    this.setSync("offline", "Нет связи с сервером — изменения сохранены на устройстве и отправятся позже.");
    this.scheduleRetry();
  }

  /** Номер отклонённого изменения в пачке, если сервер его указал. */
  private rejectedIndex(error: ApiError, size: number): number | null {
    let index: unknown = null;
    if (error.status === 422) index = error.data.actionIndex;
    if (error.status === 400 && Array.isArray(error.data.path) && error.data.path[0] === "ops") index = error.data.path[1];
    return typeof index === "number" && Number.isInteger(index) && index >= 0 && index < size ? index : null;
  }

  /** Подтягивает свежие данные с сервера (например, при возвращении во вкладку). */
  async refresh(force = false): Promise<void> {
    const login = this.currentLogin;
    if (!login || this.inflight || this.pending.length || this.snapshot.sessionExpired) return;
    if (!force && Date.now() - this.lastRefresh < 15_000) return;
    this.lastRefresh = Date.now();
    const epoch = this.epoch;
    try {
      const server = await api.getState(login);
      if (epoch !== this.epoch || this.inflight || this.pending.length) return;
      this.retryDelay = 2_000;
      if (server.version !== this.base.version || this.outdated || this.basePlaceholder) {
        this.base = server;
        this.outdated = false;
        this.basePlaceholder = false;
        this.recompute();
        this.writeAccountCache(true);
      }
      this.setSync("synced", null);
    } catch (error) {
      if (epoch !== this.epoch) return;
      this.lastRefresh = 0; // следующая попытка не должна упираться в паузу между обновлениями
      if (error instanceof ApiError && error.status === 401) this.handleUnauthorized();
      else if (isAccountMismatch(error)) void this.connect();
      else if (isStateCorrupted(error)) this.setSync("error", (error as ApiError).message);
      else {
        this.setSync("offline", "Нет связи с сервером.");
        this.scheduleRetry();
      }
    }
  }

  private handleUnauthorized(): void {
    if (this.queueSize() > 0) {
      // Не теряем изменения: просим войти снова, данные остаются на экране.
      this.set({ sessionExpired: true });
      this.setSync("error", "Сессия истекла — войдите снова, чтобы отправить изменения.");
      return;
    }
    const login = this.currentLogin;
    if (login) this.dropAccountCache(login);
    storage.remove(TOKEN_KEY); // токен приложения больше не действует
    this.emitSignOut(login);
    this.notify("Сессия истекла — войдите снова.", "info");
    this.enterGuest();
  }

  // ---------- аккаунт ----------

  /**
   * Вход. Если сессия прежнего аккаунта истекла и у него остались неотправленные изменения,
   * а входят в другой аккаунт — бросает PendingChangesError, пока не передан discardPending.
   */
  async login(login: string, password: string, options: { discardPending?: boolean } = {}): Promise<void> {
    this.assertCanSwitchAccount(login, options.discardPending);
    const { user, token } = await api.login(login, password);
    if (token) storage.set(TOKEN_KEY, token);
    await this.afterSignIn(user);
  }

  async register(
    login: string,
    password: string,
    name: string,
    options: { discardPending?: boolean } = {},
  ): Promise<void> {
    this.assertCanSwitchAccount(login, options.discardPending);
    const { user, token } = await api.register(login, password, name);
    if (token) storage.set(TOKEN_KEY, token);
    await this.afterSignIn(user);
  }

  private assertCanSwitchAccount(login: string, discardPending?: boolean): void {
    const previous = this.currentLogin;
    const pending = this.queueSize();
    if (previous && !sameLogin(previous, login) && pending > 0 && !discardPending) {
      throw new PendingChangesError(previous, pending);
    }
  }

  private async afterSignIn(user: PublicUser): Promise<void> {
    const previous = this.currentLogin;
    this.cancelRetry();
    this.needsReinit = false;
    storage.remove(LOGOUT_PENDING_KEY);
    if (previous && !sameLogin(previous, user.login)) {
      this.dropAccountCache(previous);
      this.emitSignOut(previous);
    } else if (previous) {
      // Тот же аккаунт после истечения сессии: очередь сохранена в кэше и отправится после входа.
      this.writeAccountCache();
    }
    storage.set(LAST_ACCOUNT_KEY, user.login);
    await this.enterAccount(user);
  }

  setUserName(name: string | null): void {
    if (this.snapshot.user) this.set({ user: { ...this.snapshot.user, name } });
  }

  /** Выход. Кэш аккаунта на устройстве удаляется; без сети сессия завершится на сервере позже. */
  async logout(): Promise<void> {
    const login = this.currentLogin;
    this.epoch += 1; // ответы на запросы, отправленные до выхода, больше не применяются
    this.cancelRetry();
    this.needsReinit = false;
    let reached = true;
    try {
      await api.logout();
    } catch {
      reached = false;
    }
    if (!reached) {
      storage.set(LOGOUT_PENDING_KEY, "1");
      this.needsReinit = true;
    } else {
      storage.remove(TOKEN_KEY);
    }
    if (login) this.dropAccountCache(login);
    this.emitSignOut(login);
    this.enterGuest();
    if (!reached) this.scheduleRetry();
  }

  /** Аккаунт удалён на сервере — чистим всё локальное. */
  forgetAccount(): void {
    const login = this.currentLogin;
    storage.remove(TOKEN_KEY);
    this.cancelRetry();
    this.needsReinit = false;
    if (login) this.dropAccountCache(login);
    this.emitSignOut(login);
    this.enterGuest();
  }

  // ---------- импорт ----------

  /** Импорт файла (резервная копия этой или старой версии). Полностью заменяет данные. */
  importData(raw: unknown): { ok: true; report: MigrationReport } | { ok: false; error: string } {
    try {
      const { state, report } = migrateState(raw, todayLocal());
      if (byteSize(state) > MAX_IMPORT_BYTES) {
        return { ok: false, error: "Файл слишком большой: сервер принимает данные объёмом до 9,5 МБ." };
      }
      const result = this.dispatch({ type: "state.import", state });
      return result.ok ? { ok: true, report } : result;
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /**
   * Перенос гостевых данных в аккаунт — только пока аккаунт пустой (проверяет и сервер).
   * Гостевая копия удаляется после ответа сервера и только если её не меняли с момента переноса.
   */
  acceptGuestImport(): DispatchResult {
    this.set({ guestImportOffer: false });
    const login = this.currentLogin;
    if (!login) return { ok: false, error: "Сначала войдите в аккаунт." };
    if (hasData(this.snapshot.state)) {
      return { ok: false, error: "В аккаунте уже появились данные — перенос отменён, чтобы ничего не потерять." };
    }
    const raw = storage.getJson(GUEST_KEY);
    if (!raw) return { ok: false, error: "Данных в браузере не найдено." };
    try {
      const { state } = migrateState(raw, todayLocal());
      const result = this.dispatchOps({ type: "state.import", state, ifEmpty: true });
      if (!result.ok) return result;
      storage.setJson(GUEST_IMPORT_KEY, { opId: result.opIds[0], rev: storage.get(GUEST_REV_KEY), login });
      return { ok: true };
    } catch (error) {
      return { ok: false, error: errorMessage(error) };
    }
  }

  /** Завершает перенос гостевых данных: после подтверждения сервера или отказа. */
  private finishGuestImport(acked: Op[], rejectedOpId: string | null): void {
    const marker = storage.getJson(GUEST_IMPORT_KEY) as { opId?: unknown; rev?: unknown } | null;
    if (!marker || typeof marker.opId !== "string") return;
    if (rejectedOpId === marker.opId) {
      storage.remove(GUEST_IMPORT_KEY);
      return;
    }
    if (!acked.some((op) => op.opId === marker.opId)) return;
    storage.remove(GUEST_IMPORT_KEY);
    // Если в гостевом режиме (другая вкладка) успели что-то добавить — копию не удаляем.
    if (storage.get(GUEST_REV_KEY) === (marker.rev ?? null)) {
      storage.remove(GUEST_KEY);
      storage.remove(GUEST_REV_KEY);
    }
  }

  dismissGuestImport(): void {
    this.set({ guestImportOffer: false });
  }

  private detectLegacyData(): boolean {
    if (storage.get(LEGACY_DONE_KEY)) return false;
    return LEGACY_KEYS.some((k) => storage.get(k));
  }

  acceptLegacyImport(): DispatchResult {
    const key = LEGACY_KEYS.find((k) => storage.get(k));
    if (!key) return { ok: false, error: "Данные старой версии не найдены." };
    const result = this.importData(storage.getJson(key));
    if (result.ok) {
      storage.set(LEGACY_DONE_KEY, "1");
      this.set({ legacyImportOffer: false });
      return { ok: true };
    }
    return result;
  }

  dismissLegacyImport(): void {
    storage.set(LEGACY_DONE_KEY, "1");
    this.set({ legacyImportOffer: false });
  }
}
