import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DomainError, applyAction, type Action } from "@/domain/actions";
import { todayLocal } from "@/domain/dates";
import { emptyState } from "@/domain/defaults";
import type { State } from "@/domain/schema";
import type { Op } from "./api";
import { FinanceStore, PendingChangesError } from "./store";

// ---------- окружение: localStorage и поддельный сервер ----------

class MemoryStorage {
  data = new Map<string, string>();
  getItem(k: string) {
    return this.data.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.data.set(k, v);
  }
  removeItem(k: string) {
    this.data.delete(k);
  }
}

interface FakeServer {
  user: { login: string; name: string | null } | null;
  version: number;
  state: State;
  applied: Set<string>;
  online: boolean;
  unauthorized: boolean;
  /** Следующий GET /api/state упадёт как при обрыве связи. */
  failNextGet: boolean;
  /** Следующий POST применится, но ответ «потеряется». */
  loseNextPostResponse: boolean;
  /** Ответ 200 с HTML вместо JSON (страница прокси). */
  htmlResponses: boolean;
  /** Задержать следующий GET /api/state до вызова release(). */
  holdNextGet: boolean;
  release: (() => void) | null;
  posts: { baseVersion: number; ops: Op[] }[];
  gets: number;
  logouts: number;
}

let server: FakeServer;
let storage: MemoryStorage;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function applyOps(body: { baseVersion: number; ops: Op[] }) {
  let state = server.state;
  let duplicates = 0;
  for (let i = 0; i < body.ops.length; i++) {
    const { opId, action } = body.ops[i];
    if (server.applied.has(opId)) {
      duplicates++;
      continue;
    }
    try {
      state = applyAction(state, action);
    } catch (error) {
      if (error instanceof DomainError) return { error: { status: 422, body: { error: error.message, actionIndex: i } } };
      throw error;
    }
  }
  for (const op of body.ops) server.applied.add(op.opId);
  const changed = state !== server.state;
  if (changed) {
    server.state = state;
    server.version += 1;
  }
  const expected = body.baseVersion + (changed ? 1 : 0);
  return { result: { version: server.version, stale: server.version !== expected || duplicates > 0 } };
}

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  if (!server.online) throw new TypeError("Failed to fetch");
  if (server.htmlResponses) return new Response("<html>Maintenance</html>", { status: 200 });
  const url = String(input);
  const body = init?.body ? JSON.parse(String(init.body)) : undefined;
  if (url === "/api/me") return json(200, { user: server.user, aiEnabled: false, registrationOpen: true });
  if (url === "/api/auth/login") {
    server.user = { login: body.login, name: null };
    server.unauthorized = false;
    return json(200, { user: server.user });
  }
  if (url === "/api/auth/logout") {
    server.logouts += 1;
    server.user = null;
    return json(200, { ok: true });
  }
  if (!server.user || server.unauthorized) return json(401, { error: "Нужно войти в аккаунт." });
  const expected = new Headers(init?.headers).get("X-Account");
  if (expected && decodeURIComponent(expected).toLowerCase() !== server.user.login.toLowerCase()) {
    return json(409, { error: "Вы вошли в другой аккаунт в соседней вкладке.", code: "account-mismatch" });
  }
  server.gets += url === "/api/state" ? 1 : 0;
  if (url === "/api/state") {
    if (server.failNextGet) {
      server.failNextGet = false;
      throw new TypeError("Failed to fetch");
    }
    if (server.holdNextGet) {
      server.holdNextGet = false;
      const snapshot = { version: server.version, state: server.state };
      await new Promise<void>((resolve) => (server.release = resolve));
      return json(200, snapshot);
    }
    return json(200, { version: server.version, state: server.state });
  }
  if (url === "/api/state/actions") {
    server.posts.push(body);
    const outcome = applyOps(body);
    if (outcome.error) return json(outcome.error.status, outcome.error.body);
    if (server.loseNextPostResponse) {
      server.loseNextPostResponse = false;
      throw new TypeError("Network connection was lost");
    }
    return json(200, outcome.result);
  }
  return json(404, { error: "not found" });
}

const today = todayLocal();
const income = (id: string, amount = 100_000): Action => ({
  type: "tx.add",
  tx: { id, type: "income", amount, date: today, category: "Премия", title: "", note: "", mandatory: false, autoSaving: false },
});

async function settle() {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
}

const ids = (store: FinanceStore) => store.getSnapshot().state.transactions.map((t) => t.id).sort();
const serverIds = () => server.state.transactions.map((t) => t.id).sort();

beforeEach(() => {
  storage = new MemoryStorage();
  vi.stubGlobal("localStorage", storage);
  vi.stubGlobal("fetch", vi.fn(fakeFetch));
  server = {
    user: null,
    version: 0,
    state: emptyState(),
    applied: new Set(),
    online: true,
    unauthorized: false,
    failNextGet: false,
    loseNextPostResponse: false,
    htmlResponses: false,
    holdNextGet: false,
    release: null,
    posts: [],
    gets: 0,
    logouts: 0,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function newStore() {
  const store = new FinanceStore();
  const messages: string[] = [];
  store.setNotifier((m) => messages.push(m));
  return { store, messages };
}

// ---------- тесты ----------

describe("гостевой режим", () => {
  it("сохраняет данные в браузере и восстанавливает после перезагрузки", async () => {
    const { store } = newStore();
    await store.init();
    expect(store.getSnapshot().mode).toBe("guest");
    expect(store.dispatch(income("a")).ok).toBe(true);
    expect(server.posts).toHaveLength(0);

    const { store: reloaded } = newStore();
    await reloaded.init();
    expect(ids(reloaded)).toEqual(["a"]);
  });

  it("возвращает понятную ошибку на некорректное действие", async () => {
    const { store } = newStore();
    await store.init();
    const result = store.dispatch({ type: "tx.delete", id: "nope" });
    expect(result).toEqual({ ok: false, error: "Операция не найдена — возможно, она уже удалена." });
  });

  it("две вкладки не затирают изменения друг друга", async () => {
    const { store: tabA } = newStore();
    const { store: tabB } = newStore();
    await tabA.init();
    await tabB.init();
    tabA.dispatch(income("from-A"));
    tabB.dispatch(income("from-B"));
    const { store: reloaded } = newStore();
    await reloaded.init();
    expect(ids(reloaded)).toEqual(["from-A", "from-B"]);
    // Вкладка A подхватывает изменения B по событию storage.
    tabA.handleStorageChange("fp:guest:rev");
    expect(ids(tabA)).toEqual(["from-A", "from-B"]);
  });

  it("нечитаемые данные не затираются без копии", async () => {
    storage.setItem("fp:guest", JSON.stringify({ schemaVersion: 99 }));
    const { store, messages } = newStore();
    await store.init();
    expect(storage.getItem("fp:guest:backup")).toContain("99");
    expect(messages[0]).toContain("Копия сохранена");
  });
});

describe("аккаунт", () => {
  beforeEach(() => {
    server.user = { login: "anna", name: null };
  });

  it("сначала загружает данные с сервера, потом отправляет изменения с id", async () => {
    server.state = applyAction(emptyState(), income("server-tx"));
    server.version = 3;
    const { store } = newStore();
    await store.init();
    expect(ids(store)).toEqual(["server-tx"]);
    expect(server.posts).toHaveLength(0);

    store.dispatch(income("local"));
    await settle();
    expect(server.posts).toHaveLength(1);
    expect(server.posts[0].baseVersion).toBe(3);
    expect(server.posts[0].ops[0]).toMatchObject({ opId: expect.any(String), action: income("local") });
    expect(serverIds()).toEqual(["local", "server-tx"]);
    expect(store.getSnapshot().sync).toMatchObject({ status: "synced", pending: 0 });
    expect(store.getSnapshot().version).toBe(4);
  });

  it("операции из СМС, разобранные на телефоне: применяет с их номерами, уже учтённые сервером пропускает", async () => {
    const { store } = newStore();
    await store.init();
    // Первую СМС телефон уже отправил на сервер сам (тот же номер изменения).
    const first: Op = { opId: "sms-aaa-0", action: income("sms-1") };
    applyOps({ baseVersion: server.version, ops: [first] });
    const second: Op = { opId: "sms-bbb-0", action: income("sms-2") };
    server.online = false;
    expect(store.ingest([[first], [second]])).toBe(2);
    expect(ids(store).sort()).toEqual(["sms-1", "sms-2"]);
    server.online = true;
    await store.resume();
    await settle();
    // На сервере обе — по одному разу: первая не применилась повторно.
    expect(serverIds().sort()).toEqual(["sms-1", "sms-2"]);
    expect(store.getSnapshot().sync).toMatchObject({ status: "synced", pending: 0 });
    // Повторный приём тех же операций — ничего не меняет.
    expect(store.ingest([[first], [second]])).toBe(0);
  });

  it("без сети копит изменения и отправляет их после восстановления связи", async () => {
    const { store } = newStore();
    await store.init();
    server.online = false;
    store.dispatch(income("a"));
    store.dispatch(income("b"));
    await settle();
    expect(store.getSnapshot().sync.status).toBe("offline");
    expect(store.getSnapshot().state.transactions).toHaveLength(2);

    // Перезагрузка без сети — данные и очередь берутся из кэша.
    const { store: reloaded } = newStore();
    await reloaded.init();
    expect(reloaded.getSnapshot().mode).toBe("account");
    expect(reloaded.getSnapshot().sync.pending).toBe(2);

    server.online = true;
    await reloaded.resume();
    await settle();
    expect(serverIds()).toEqual(["a", "b"]);
    expect(reloaded.getSnapshot().sync).toMatchObject({ status: "synced", pending: 0 });
  });

  it("потерянный ответ: повторная отправка не дублирует и не ругается", async () => {
    const { store, messages } = newStore();
    await store.init();
    server.loseNextPostResponse = true;
    store.dispatch(income("a"));
    await settle();
    expect(store.getSnapshot().sync.status).toBe("offline");
    await store.resume();
    await settle();
    expect(server.posts).toHaveLength(2);
    expect(serverIds()).toEqual(["a"]);
    expect(messages.filter((m) => m.includes("не принял"))).toHaveLength(0);
    expect(store.getSnapshot().sync).toMatchObject({ status: "synced", pending: 0 });
  });

  it("ответ 200 с HTML (прокси) не считается сохранением", async () => {
    const { store } = newStore();
    await store.init();
    server.htmlResponses = true;
    store.dispatch(income("a"));
    await settle();
    expect(store.getSnapshot().sync).toMatchObject({ status: "offline", pending: 1 });
    server.htmlResponses = false;
    await store.resume();
    await settle();
    expect(serverIds()).toEqual(["a"]);
  });

  it("если данные менялись на другом устройстве — подтягивает их и не теряет свои", async () => {
    const { store } = newStore();
    await store.init();
    server.state = applyAction(server.state, income("other"));
    server.version += 1;
    store.dispatch(income("mine"));
    await settle();
    expect(ids(store)).toEqual(["mine", "other"]);
    expect(store.getSnapshot().version).toBe(server.version);
  });

  it("не отправляет пачку повторно, если после успешной отправки не удалось обновить данные", async () => {
    const { store } = newStore();
    await store.init();
    server.state = applyAction(server.state, income("other"));
    server.version += 1;
    server.failNextGet = true;
    store.dispatch(income("mine"));
    await settle();
    expect(server.posts).toHaveLength(1);
    expect(serverIds()).toEqual(["mine", "other"]);
    expect(ids(store)).toEqual(["mine", "other"]);
  });

  it("отклонённое сервером действие выбрасывается, остальные доходят", async () => {
    const { store, messages } = newStore();
    await store.init();
    store.dispatch(income("a"));
    await settle();
    server.state = applyAction(server.state, { type: "tx.delete", id: "a" });
    server.version += 1;
    store.dispatch([{ type: "tx.delete", id: "a" }, income("b")]);
    await settle();
    expect(messages.some((m) => m.includes("не принял"))).toBe(true);
    expect(serverIds()).toEqual(["b"]);
    expect(ids(store)).toEqual(["b"]);
    expect(store.getSnapshot().sync.pending).toBe(0);
  });

  it("ошибка 400 без номера изменения не выбрасывает очередь", async () => {
    const { store } = newStore();
    await store.init();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/state/actions" ? json(400, { error: "Некорректный JSON." }) : fakeFetch(input, init),
      ),
    );
    store.dispatch(income("a"));
    await settle();
    expect(store.getSnapshot().sync).toMatchObject({ status: "error", pending: 1 });
  });

  it("при истёкшей сессии не теряет очередь и отправляет её после повторного входа", async () => {
    const { store } = newStore();
    await store.init();
    server.unauthorized = true;
    store.dispatch(income("a"));
    await settle();
    expect(store.getSnapshot().sessionExpired).toBe(true);
    expect(store.getSnapshot().state.transactions).toHaveLength(1);

    await store.login("anna", "password");
    await settle();
    expect(store.getSnapshot().sessionExpired).toBe(false);
    expect(store.getSnapshot().sync.status).toBe("synced");
    expect(serverIds()).toEqual(["a"]);
  });

  it("после перезагрузки с истёкшей сессией показывает данные и просит войти", async () => {
    const { store } = newStore();
    await store.init();
    server.online = false;
    store.dispatch(income("a"));
    await settle();
    server.online = true;
    server.user = null; // сессию завершили, например сменой пароля на другом устройстве

    const { store: reloaded } = newStore();
    await reloaded.init();
    expect(reloaded.getSnapshot()).toMatchObject({ mode: "account", sessionExpired: true });
    expect(ids(reloaded)).toEqual(["a"]);
  });

  it("вход в другой аккаунт с неотправленными изменениями требует подтверждения", async () => {
    const { store } = newStore();
    await store.init();
    server.unauthorized = true;
    store.dispatch(income("a"));
    await settle();
    await expect(store.login("boris", "password")).rejects.toBeInstanceOf(PendingChangesError);
    await store.login("boris", "password", { discardPending: true });
    expect(store.getSnapshot().user?.login).toBe("boris");
    expect([...storage.data.keys()].some((k) => k === "fp:account:anna")).toBe(false);
  });

  it("выход во время обновления не переносит данные аккаунта в гостевой режим", async () => {
    server.state = applyAction(emptyState(), income("secret"));
    server.version = 1;
    const { store } = newStore();
    await store.init();
    server.holdNextGet = true;
    const refreshing = store.refresh(true);
    await settle();
    await store.logout();
    server.release?.();
    await refreshing;
    await settle();
    expect(store.getSnapshot().mode).toBe("guest");
    expect(ids(store)).toEqual([]);
    store.dispatch(income("guest-1"));
    expect(storage.getItem("fp:guest")).not.toContain("secret");
  });

  it("выход удаляет кэш аккаунта с устройства", async () => {
    const { store } = newStore();
    await store.init();
    store.dispatch(income("a"));
    await settle();
    expect([...storage.data.keys()].some((k) => k.startsWith("fp:account:"))).toBe(true);
    await store.logout();
    expect([...storage.data.keys()].some((k) => k.startsWith("fp:account:"))).toBe(false);
    expect(store.getSnapshot().mode).toBe("guest");
    expect(store.getSnapshot().state.transactions).toHaveLength(0);
  });

  it("две вкладки без сети: после перезагрузки уходят изменения обеих", async () => {
    const { store: tabA } = newStore();
    const { store: tabB } = newStore();
    await tabA.init();
    await tabB.init();
    server.online = false;
    tabA.dispatch(income("A-offline"));
    tabB.dispatch(income("B-offline"));
    await settle();
    server.online = true;
    const { store: reloaded } = newStore();
    await reloaded.init();
    await settle();
    expect(serverIds()).toEqual(["A-offline", "B-offline"]);
  });

  it("выход в другой вкладке переводит эту вкладку в гостевой режим", async () => {
    const { store: tabA } = newStore();
    const { store: tabB } = newStore();
    await tabA.init();
    await tabB.init();
    await tabA.logout();
    tabB.handleStorageChange("fp:account:anna");
    expect(tabB.getSnapshot().mode).toBe("guest");
  });
});

describe("перенос гостевых данных", () => {
  it("переносит в пустой аккаунт и удаляет гостевую копию только после ответа сервера", async () => {
    const { store } = newStore();
    await store.init();
    store.dispatch(income("guest-tx"));
    server.online = true;
    await store.login("anna", "password");
    expect(store.getSnapshot().guestImportOffer).toBe(true);
    server.online = false;
    expect(store.acceptGuestImport().ok).toBe(true);
    await settle();
    expect(storage.getItem("fp:guest")).toContain("guest-tx");
    server.online = true;
    await store.resume();
    await settle();
    expect(serverIds()).toEqual(["guest-tx"]);
    expect(storage.getItem("fp:guest")).toBeNull();
  });

  it("не переносит, если в аккаунте уже появились данные", async () => {
    const { store } = newStore();
    await store.init();
    store.dispatch(income("guest-tx"));
    await store.login("anna", "password");
    store.dispatch(income("account-tx"));
    const result = store.acceptGuestImport();
    expect(result.ok).toBe(false);
    await settle();
    expect(serverIds()).toEqual(["account-tx"]);
  });
});

describe("импорт", () => {
  it("принимает файл старой версии и заменяет данные", async () => {
    const { store } = newStore();
    await store.init();
    const result = store.importData({
      months: { "2026-03": { transactions: [{ id: "x", type: "flexibleExpense", category: "Кафе", amount: 250.5, date: "2026-03-02" }] } },
    });
    expect(result.ok).toBe(true);
    expect(store.getSnapshot().state.transactions[0]).toMatchObject({ amount: 25_050, type: "expense" });
  });

  it("отклоняет непонятный файл", async () => {
    const { store } = newStore();
    await store.init();
    expect(store.importData({ hello: "world" })).toEqual({ ok: false, error: "Не удалось распознать формат данных." });
  });
});

describe("второй круг ревью", () => {
  beforeEach(() => {
    server.user = { login: "anna", name: null };
  });

  it("отклонённое изменение не возвращается из кэша после перезагрузки", async () => {
    const { store } = newStore();
    await store.init();
    store.dispatch(income("a"));
    await settle();
    server.state = applyAction(server.state, { type: "tx.delete", id: "a" });
    server.version += 1;
    store.dispatch({ type: "tx.delete", id: "a" });
    await settle();
    const { store: reloaded, messages } = newStore();
    await reloaded.init();
    await settle();
    expect(messages.filter((m) => /не применена|не принял/.test(m))).toHaveLength(0);
    expect(reloaded.getSnapshot().sync.pending).toBe(0);
  });

  it("вход в другой аккаунт в соседней вкладке: эта вкладка не пишет в чужой аккаунт", async () => {
    const { store: tabA } = newStore();
    await tabA.init();
    // В соседней вкладке вошли как boris — cookie общая.
    server.user = { login: "boris", name: null };
    server.online = false;
    tabA.dispatch(income("anna-tx"));
    await settle();
    server.online = true;
    await tabA.resume();
    await settle();
    expect(tabA.getSnapshot().user?.login).toBe("boris");
    expect(serverIds()).toEqual([]); // в аккаунт boris изменение anna не попало
    expect(storage.getItem("fp:account:anna")).toContain("anna-tx");
  });

  it("выход без сети завершает сессию на сервере при следующем подключении", async () => {
    const { store } = newStore();
    await store.init();
    server.online = false;
    await store.logout();
    expect(store.getSnapshot().mode).toBe("guest");
    server.online = true;
    const { store: reloaded } = newStore();
    await reloaded.init();
    expect(server.logouts).toBe(1);
    expect(reloaded.getSnapshot().mode).toBe("guest");
  });

  it("после сбоя обновления повторная попытка действительно обновляет данные", async () => {
    const { store } = newStore();
    await store.init();
    server.failNextGet = true;
    await store.refresh(true);
    expect(store.getSnapshot().sync.status).toBe("offline");
    server.state = applyAction(server.state, income("other"));
    server.version += 1;
    await store.resume();
    expect(ids(store)).toEqual(["other"]);
    expect(store.getSnapshot().sync.status).toBe("synced");
  });

  it("перенос гостевых данных отклоняется сервером, если аккаунт уже не пустой", async () => {
    server.user = null;
    const { store } = newStore();
    await store.init();
    store.dispatch(income("guest-tx"));
    await store.login("anna", "password");
    server.online = false;
    expect(store.acceptGuestImport().ok).toBe(true);
    // Пока телефон без сети, с другого устройства добавили данные.
    server.state = applyAction(server.state, income("laptop"));
    server.version += 1;
    server.online = true;
    await store.resume();
    await settle();
    expect(serverIds()).toEqual(["laptop"]);
    expect(storage.getItem("fp:guest")).toContain("guest-tx");
  });
});


describe("третий круг ревью", () => {
  beforeEach(() => {
    server.user = { login: "anna", name: null };
  });

  it("кэш, записанный прежней версией и не проходящий схему, не теряет офлайн-изменения", async () => {
    server.state = applyAction(emptyState(), income("t1"));
    server.version = 1;
    const { store } = newStore();
    await store.init();
    server.online = false;
    store.dispatch({ type: "tx.update", id: "t1", patch: { amount: 200_000 } });
    await settle();
    // Портим сохранённое состояние: дубликат id (новая схема его не принимает).
    const key = "fp:account:anna";
    const cache = JSON.parse(storage.getItem(key)!);
    cache.state.transactions.push({ ...cache.state.transactions[0] });
    cache.state = { ...cache.state, transactions: cache.state.transactions };
    cache.state.schemaVersion = 99; // нечитаемо даже после починки
    storage.setItem(key, JSON.stringify(cache));
    server.online = true;
    const { store: reloaded, messages } = newStore();
    await reloaded.init();
    await settle();
    expect(messages.filter((m) => m.includes("не применена"))).toHaveLength(0);
    expect(server.state.transactions[0].amount).toBe(200_000);
  });

  it("последний аккаунт устройства следует за сервером, ложных ошибок при сохранении нет", async () => {
    storage.setItem("fp:last-account", "boris");
    const { store, messages } = newStore();
    await store.init();
    expect(storage.getItem("fp:last-account")).toBe("anna");
    for (let i = 0; i < 3; i++) store.dispatch(income(`x${i}`));
    await settle();
    expect(messages).toHaveLength(0);
    expect(serverIds()).toEqual(["x0", "x1", "x2"]);
  });

  it("413: пачка делится, слишком большое изменение отбрасывается, очередь не встаёт", async () => {
    const { store, messages } = newStore();
    await store.init();
    let rejectBig = true;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input) === "/api/state/actions") {
          const body = JSON.parse(String(init?.body));
          const tooBig = body.ops.length > 1 || body.ops.some((o: Op) => o.action.type === "tx.add" && o.action.tx.id === "huge");
          if (rejectBig && tooBig) return json(413, { error: "Слишком большой запрос." });
        }
        return fakeFetch(input, init);
      }),
    );
    server.online = false;
    store.dispatch(income("small-1"));
    store.dispatch(income("huge"));
    store.dispatch(income("small-2"));
    server.online = true;
    await store.resume();
    await settle();
    expect(serverIds()).toEqual(["small-1", "small-2"]);
    expect(messages.some((m) => m.includes("слишком большое"))).toBe(true);
    expect(store.getSnapshot().sync.pending).toBe(0);
    rejectBig = false;
  });

  it("повреждённые данные на сервере: понятная ошибка вместо «нет связи», без бесконечных повторов", async () => {
    const { store } = newStore();
    await store.init();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        String(input) === "/api/state/actions"
          ? json(423, { error: "Данные аккаунта на сервере повреждены.", code: "state-corrupted" })
          : fakeFetch(input, init),
      ),
    );
    store.dispatch(income("a"));
    await settle();
    expect(store.getSnapshot().sync).toMatchObject({ status: "error", message: "Данные аккаунта на сервере повреждены.", pending: 1 });
  });

  it("истёкшая сессия восстанавливается, когда в аккаунт снова вошли в другой вкладке", async () => {
    const { store } = newStore();
    await store.init();
    server.unauthorized = true;
    store.dispatch(income("a"));
    await settle();
    expect(store.getSnapshot().sessionExpired).toBe(true);
    server.unauthorized = false; // вошли снова в соседней вкладке (cookie общая)
    store.handleStorageChange("fp:account:anna");
    await settle();
    expect(store.getSnapshot().sessionExpired).toBe(false);
    expect(serverIds()).toEqual(["a"]);
  });
});

describe("четвёртый круг ревью", () => {
  it("перенос гостевых данных не выбрасывает неотправленные настройки аккаунта", async () => {
    const { store } = newStore();
    await store.init();
    store.dispatch(income("guest-tx"));
    server.online = true;
    await store.login("anna", "password");
    server.online = false;
    const settings = { ...store.getSnapshot().state.settings, savingsRatePercent: 30 };
    store.dispatch([{ type: "settings.update", settings }, { type: "category.setLimit", name: "Кафе и рестораны", amount: 500_000 }]);
    expect(store.acceptGuestImport().ok).toBe(true);
    server.online = true;
    await store.resume();
    await settle();
    expect(serverIds()).toEqual(["guest-tx"]);
    expect(server.state.settings.savingsRatePercent).toBe(30);
    expect(server.state.categoryLimits).toMatchObject({ "Кафе и рестораны": 500_000 });
    expect(store.getSnapshot().state.settings.savingsRatePercent).toBe(30);
  });
});
