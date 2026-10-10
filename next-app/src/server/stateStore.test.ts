import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { applyActions, type Action } from "@/domain/actions";
import { addDays } from "@/domain/dates";
import { emptyState } from "@/domain/defaults";
import { MAX_KOPECKS } from "@/domain/money";
import { dueOccurrences } from "@/domain/recurring";
import { stateSchema } from "@/domain/schema";
import { addTx, template } from "@/domain/test-utils";
import { closeDb, getDb, transaction } from "./db";
import {
  ActionError,
  MAX_APPLIED_OPS_PER_USER,
  MAX_OPS_PER_REQUEST,
  MAX_STATE_BYTES,
  PRUNE_EVERY_REQUESTS,
  STATE_CACHE_LIMITS,
  StoredStateError,
  applyUserOps,
  clearStateCache,
  loadState,
  pruneAppliedOps,
  writeState,
  type Op,
} from "./stateStore";

// Считаем проходы по шаблонам: пропущенная синхронизация не должна сканировать их вовсе.
vi.mock("@/domain/recurring", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/domain/recurring")>();
  return { ...original, dueOccurrences: vi.fn(original.dueOccurrences) };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-store-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const USER = 1;
const TODAY = "2026-10-10";
let opCounter = 0;
const ops = (...actions: Action[]): Op[] => actions.map((action) => ({ opId: `op${++opCounter}`, action }));

beforeEach(() => {
  clearStateCache();
  const db = getDb();
  db.exec("DELETE FROM users;");
  db.prepare("INSERT INTO users (id, login, login_key, password_hash, created_at) VALUES (?, 'u', 'u', 'x', 0)").run(USER);
});

describe("дата из действия (M3)", () => {
  it("принимает офлайн-изменения с датой в прошлом и отклоняет дату из будущего", () => {
    const tpl = template({ id: "rent", kind: "expense", amount: 4_000_000, dayOfMonth: 8, startDate: "2026-10-01" });
    applyUserOps(USER, ops({ type: "template.add", template: tpl }), "2026-10-07");
    // Офлайн 8-го: начислили и удалили аренду; отправляем 10-го.
    const result = applyUserOps(
      USER,
      ops({ type: "recurring.sync", today: "2026-10-08" }, { type: "tx.delete", id: "rent.2026-10" }),
      TODAY,
    );
    expect(result.state.transactions).toEqual([]);
    expect(result.state.skipped).toEqual({ rent: ["2026-10"] });
    expect(applyUserOps(USER, ops({ type: "recurring.sync", today: TODAY }), TODAY).state.transactions).toEqual([]);

    expect(() => applyUserOps(USER, ops({ type: "recurring.sync", today: addDays(TODAY, 1) }), TODAY)).not.toThrow();
    expect(() => applyUserOps(USER, ops({ type: "recurring.sync", today: addDays(TODAY, 2) }), TODAY)).toThrow(ActionError);
  });
});

describe("размер состояния (M4)", () => {
  it("меряется в байтах и превращается в ActionError (422), а не в необработанную ошибку", () => {
    const state = emptyState();
    const note = "н".repeat(500); // 500 символов, 1000 байт
    for (let i = 0; i < 9_500; i++) {
      state.transactions.push({ id: `t${i}`, type: "expense", amount: 100, date: "2026-10-01", category: "Продукты", title: "", note, mandatory: false, autoSaving: false });
    }
    const json = JSON.stringify(state);
    expect(json.length).toBeLessThan(MAX_STATE_BYTES);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_STATE_BYTES);
    let error: unknown;
    try {
      applyUserOps(USER, ops(addTx({ type: "income", amount: 100, date: "2026-10-01" }), { type: "state.import", state }), TODAY);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).actionIndex).toBe(1);
    expect(loadState(USER).version).toBe(0);
  }, 30_000);
});

describe("сохраняемое состояние (L8, L9)", () => {
  it("в базе — ровно результат редьюсера, как у клиента", () => {
    const name = `${"А".repeat(68)} ${"Б".repeat(10)}`;
    const loan = { id: "l", kind: "credit" as const, name, amount: 5_000_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-10-01" };
    const actions: Action[] = [
      { type: "loan.add", loan, cashFlow: { id: "cf", date: "2026-10-01" } },
      { type: "loan.payment", id: "p1", loanId: "l", amount: 100, date: "2026-10-05", note: "" },
    ];
    const local = applyActions(emptyState(), actions);
    const result = applyUserOps(USER, ops(...actions), TODAY);
    expect(result.state).toEqual(local);
    expect(loadState(USER).state).toEqual(JSON.parse(JSON.stringify(local)));
    for (const t of local.transactions) expect(t.title).toBe(t.title.trim());
  });

  it("сообщает индекс действия, которое сделало состояние некорректным", () => {
    const actions: Action[] = [
      addTx({ type: "expense", amount: MAX_KOPECKS, date: "2026-10-01" }),
      // Корректировка на 2 × MAX_KOPECKS — больше допустимой суммы, но DomainError на это нет.
      { type: "balance.set", id: "adj", date: "2026-10-02", actual: MAX_KOPECKS },
      addTx({ type: "income", amount: 100, date: "2026-10-03" }),
      addTx({ type: "income", amount: 100, date: "2026-10-04" }),
    ];
    let error: unknown;
    try {
      applyUserOps(USER, ops(...actions), TODAY);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).actionIndex).toBe(1);
    expect(loadState(USER).version).toBe(0);
  });
});

describe("повторная синхронизация в одной пачке (H1)", () => {
  const scans = vi.mocked(dueOccurrences);
  const sync = (today: string): Action => ({ type: "recurring.sync", today });
  const rent = () => template({ id: "rent", kind: "expense", amount: 100, dayOfMonth: 5, startDate: "2026-01-01" });

  it("100 синхронизаций на одну дату сканируют шаблоны один раз", () => {
    applyUserOps(USER, ops({ type: "template.add", template: rent() }), TODAY);
    scans.mockClear();
    const result = applyUserOps(USER, ops(...Array.from({ length: MAX_OPS_PER_REQUEST }, () => sync(TODAY))), TODAY);
    expect(scans).toHaveBeenCalledTimes(1);
    expect(result.state.transactions).toHaveLength(10);
  });

  it("более ранняя дата того же месяца на неизменном состоянии тоже не сканирует", () => {
    applyUserOps(USER, ops({ type: "template.add", template: rent() }), TODAY);
    scans.mockClear();
    applyUserOps(USER, ops(sync(TODAY), sync("2026-10-03"), sync(TODAY)), TODAY);
    expect(scans).toHaveBeenCalledTimes(1);
  });

  it("если состояние изменилось, дата позже или другой месяц — синхронизация выполняется, как в редьюсере", () => {
    const tpl = template({ id: "new", kind: "expense", amount: 100, dayOfMonth: 1, startDate: "2026-10-01" });
    const actions: Action[] = [
      sync("2026-09-30"),
      sync("2026-10-01"),
      { type: "template.add", template: tpl },
      sync("2026-10-01"),
      sync(TODAY),
    ];
    scans.mockClear();
    const result = applyUserOps(USER, ops(...actions), TODAY);
    expect(scans).toHaveBeenCalledTimes(4);
    expect(result.state.transactions.map((t) => t.id)).toEqual(["new.2026-10"]);
    expect(result.state).toEqual(applyActions(emptyState(), actions));
  });
});

describe("чтение и транзакции (L10)", () => {
  it("повреждённое или некорректное состояние в базе — понятная ошибка, а не мусор", () => {
    const db = getDb();
    const insert = db.prepare("INSERT OR REPLACE INTO states (user_id, version, state_json, updated_at) VALUES (?, 3, ?, 0)");
    insert.run(USER, "{not json");
    expect(() => loadState(USER)).toThrow(StoredStateError);
    insert.run(USER, JSON.stringify({ ...emptyState(), transactions: [{ id: "x" }] }));
    expect(() => loadState(USER)).toThrow(StoredStateError);
    expect(() => applyUserOps(USER, ops({ type: "recurring.sync", today: TODAY }), TODAY)).toThrow(StoredStateError);
    insert.run(USER, JSON.stringify(emptyState()));
    expect(loadState(USER)).toEqual({ version: 3, state: emptyState() });
  });

  it("неудачный ROLLBACK не подменяет исходную ошибку", () => {
    const db = getDb();
    expect(() =>
      transaction(db, () => {
        db.exec("ROLLBACK"); // транзакции больше нет — ROLLBACK в обработчике ошибки упадёт
        throw new Error("исходная ошибка");
      }),
    ).toThrow("исходная ошибка");
  });
});

/** Большое состояние: 9 500 операций с заметкой по 1000 байт — больше MAX_STATE_BYTES в UTF-8. */
function oversizedState() {
  const state = emptyState();
  const note = "н".repeat(500);
  for (let i = 0; i < 9_500; i++) {
    state.transactions.push({ id: `t${i}`, type: "expense", amount: 100, date: "2026-10-01", category: "Продукты", title: "", note, mandatory: false, autoSaving: false });
  }
  return state;
}

const insertRow = (version: number, json: string) =>
  getDb()
    .prepare("INSERT OR REPLACE INTO states (user_id, version, state_json, updated_at) VALUES (?, ?, ?, 0)")
    .run(USER, version, json);

describe("ревью 2: applied_ops (H1)", () => {
  const count = () => (getDb().prepare("SELECT COUNT(*) AS n FROM applied_ops WHERE user_id = ?").get(USER) as { n: number }).n;

  function fillOps(n: number, now: number) {
    const db = getDb();
    const insert = db.prepare("INSERT INTO applied_ops (user_id, op_id, applied_at) VALUES (?, ?, ?)");
    transaction(db, () => {
      for (let i = 0; i < n; i++) insert.run(USER, `old-${String(i).padStart(8, "0")}`, now - n + i);
    });
  }

  it("на пользователя хранится не больше MAX_APPLIED_OPS_PER_USER самых новых opId", () => {
    const now = Date.now();
    fillOps(MAX_APPLIED_OPS_PER_USER + 50, now);
    pruneAppliedOps(USER);
    expect(count()).toBe(MAX_APPLIED_OPS_PER_USER);
    // Удалены самые старые.
    const oldest = getDb().prepare("SELECT MIN(op_id) AS id FROM applied_ops WHERE user_id = ?").get(USER) as { id: string };
    expect(oldest.id).toBe("old-00000050");
  });

  it("подрезка выполняется раз в PRUNE_EVERY_REQUESTS запросов пользователя", () => {
    const now = Date.now();
    fillOps(MAX_APPLIED_OPS_PER_USER + 500, now - 1000);
    for (let i = 0; i < PRUNE_EVERY_REQUESTS; i++) {
      applyUserOps(USER, ops({ type: "recurring.sync", today: TODAY }), TODAY, now);
    }
    // За эти запросы подрезка прошла; после неё добавилось не больше изменений, чем запросов до следующей.
    expect(count()).toBeLessThanOrEqual(MAX_APPLIED_OPS_PER_USER + PRUNE_EVERY_REQUESTS - 1);
    // Свежие opId не забыты: повтор не применяется.
    const result = applyUserOps(USER, [{ opId: `op${opCounter}`, action: { type: "recurring.sync", today: TODAY } }], TODAY, now);
    expect(result.duplicates).toBe(1);
  });

  it("индекс (user_id, applied_at) используется при очистке", () => {
    const plan = getDb()
      .prepare("EXPLAIN QUERY PLAN DELETE FROM applied_ops WHERE user_id = ? AND applied_at < ?")
      .all(USER, 0) as { detail: string }[];
    expect(plan.map((r) => r.detail).join(" ")).toMatch(/applied_ops_user_applied_at/);
  });
});

describe("ревью 2: нагрузка на сервер (H2)", () => {
  it("в одном вызове не больше MAX_OPS_PER_REQUEST изменений — столько же промежуточных состояний", () => {
    const sync: Action = { type: "recurring.sync", today: TODAY };
    expect(() => applyUserOps(USER, ops(...Array.from({ length: MAX_OPS_PER_REQUEST + 1 }, () => sync)), TODAY)).toThrow(RangeError);
    expect(() => applyUserOps(USER, ops(...Array.from({ length: MAX_OPS_PER_REQUEST }, () => sync)), TODAY)).not.toThrow();
  });

  it("разобранное состояние берётся из кэша, пока строка в базе не менялась", () => {
    const written = applyUserOps(USER, ops(addTx({ type: "income", amount: 100, date: TODAY })), TODAY);
    const first = loadState(USER);
    // Тот же объект — значит, JSON не разбирался и схема не проверялась заново.
    expect(first.state).toBe(written.state);
    expect(loadState(USER).state).toBe(first.state);
    // Запись заменяет запись кэша.
    const next = applyUserOps(USER, ops(addTx({ type: "income", amount: 200, date: TODAY })), TODAY);
    expect(loadState(USER).state).toBe(next.state);
    // Изменение строки в обход приложения (та же версия!) кэш не обманывает.
    getDb().prepare("UPDATE states SET state_json = ? WHERE user_id = ?").run(JSON.stringify(emptyState()), USER);
    expect(loadState(USER)).toEqual({ version: next.version, state: emptyState() });
  });

  it("кэш ограничен по числу пользователей", () => {
    const db = getDb();
    const users = STATE_CACHE_LIMITS.states + 1;
    for (let id = 2; id <= users + 1; id++) {
      db.prepare("INSERT INTO users (id, login, login_key, password_hash, created_at) VALUES (?, ?, ?, 'x', 0)").run(id, `u${id}`, `u${id}`);
      db.prepare("INSERT INTO states (user_id, version, state_json, updated_at) VALUES (?, 1, ?, 0)").run(id, JSON.stringify(emptyState()));
    }
    const firstLoad = loadState(2).state;
    expect(loadState(2).state).toBe(firstLoad);
    for (let id = 3; id <= users + 1; id++) loadState(id);
    // Пользователь 2 вытеснен самым давним — читается заново.
    expect(loadState(2).state).not.toBe(firstLoad);
    expect(loadState(users + 1).state).toBe(loadState(users + 1).state);
  });
});

describe("ревью 2: состояние, не проходящее новую проверку (M2)", () => {
  it("исправляется при чтении: дубликаты id, служебные категории и ключи; сохраняется при следующей записи", () => {
    const t = { id: "dup", type: "expense", amount: 100, date: "2026-10-01", category: "constructor", title: "", note: "", mandatory: false, autoSaving: false };
    const raw = {
      ...emptyState(),
      transactions: [t, { ...t, amount: 200 }],
      categoryLimits: JSON.parse('{"toString": 100, "Продукты": 200}'),
    };
    insertRow(7, JSON.stringify(raw));
    const loaded = loadState(USER);
    expect(loaded.version).toBe(7);
    expect(loaded.state.transactions).toHaveLength(1);
    expect(loaded.state.transactions[0]).toMatchObject({ id: "dup", amount: 100, category: "Другое" });
    expect(loaded.state.categoryLimits).toEqual({ Продукты: 200 });

    const result = applyUserOps(USER, ops(addTx({ type: "income", amount: 100, date: TODAY })), TODAY);
    expect(result.version).toBe(8);
    clearStateCache();
    const stored = JSON.parse((getDb().prepare("SELECT state_json FROM states WHERE user_id = ?").get(USER) as { state_json: string }).state_json);
    expect(stateSchema.safeParse(stored).success).toBe(true);
    expect(loadState(USER).state).toEqual(stored);
  });

  it("неисправимое состояние: ошибка с версией; заменить его можно только импортом первым в пачке", () => {
    insertRow(5, "{not json");
    let error: unknown;
    try {
      loadState(USER);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(StoredStateError);
    expect((error as StoredStateError).version).toBe(5);

    const imported = { ...emptyState(), profile: { ...emptyState().profile, occupation: "Из файла" } };
    // Импорт не первым — повреждённое состояние не трогаем.
    expect(() => applyUserOps(USER, ops({ type: "recurring.sync", today: TODAY }, { type: "state.import", state: imported }), TODAY)).toThrow(
      StoredStateError,
    );
    // «Только в пустой аккаунт» не заменяет: там могут быть данные.
    expect(() => applyUserOps(USER, ops({ type: "state.import", state: imported, ifEmpty: true }), TODAY)).toThrow(ActionError);
    const result = applyUserOps(USER, ops({ type: "state.import", state: imported }, addTx({ type: "income", amount: 100, date: TODAY })), TODAY);
    expect(result.version).toBe(6);
    expect(loadState(USER).state.profile.occupation).toBe("Из файла");
    expect(loadState(USER).state.transactions).toHaveLength(1);
  });
});

describe("ревью 2: состояние больше предела (M3)", () => {
  it("переросшее предел состояние можно уменьшать, но не увеличивать", () => {
    const big = oversizedState();
    const json = JSON.stringify(big);
    expect(Buffer.byteLength(json)).toBeGreaterThan(MAX_STATE_BYTES);
    insertRow(1, json);

    const deleted = applyUserOps(USER, ops({ type: "tx.delete", id: "t0" }), TODAY);
    expect(deleted.version).toBe(2);
    let error: unknown;
    const note = "н".repeat(500);
    try {
      applyUserOps(
        USER,
        ops(
          addTx({ type: "income", amount: 100, date: TODAY, note }),
          addTx({ type: "income", amount: 100, date: TODAY }),
          addTx({ type: "income", amount: 100, date: TODAY }),
        ),
        TODAY,
      );
    } catch (e) {
      error = e;
    }
    // Виновник — первое добавление (после него состояние больше сохранённого), а не последнее действие.
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).actionIndex).toBe(0);
    expect(loadState(USER).version).toBe(2);
    // Удаление по-прежнему проходит.
    expect(applyUserOps(USER, ops({ type: "tx.delete", id: "t1" }), TODAY).version).toBe(3);
  }, 30_000);

  it("writeState: больше предела — только если не больше уже сохранённого", () => {
    const big = oversizedState();
    const bytes = Buffer.byteLength(JSON.stringify(big));
    expect(() => writeState(USER, big, 1)).toThrow(/Слишком много данных/);
    expect(() => writeState(USER, big, 1, bytes - 1)).toThrow(/Слишком много данных/);
    expect(() => writeState(USER, big, 1, bytes)).not.toThrow();
  }, 30_000);

  it("ошибка размера указывает на действие, которое переросло предел, а не на последнее", () => {
    let error: unknown;
    try {
      applyUserOps(
        USER,
        ops(addTx({ type: "income", amount: 100, date: "2026-10-01" }), { type: "state.import", state: oversizedState() }, addTx({ type: "income", amount: 100, date: "2026-10-02" })),
        TODAY,
      );
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ActionError);
    expect((error as ActionError).actionIndex).toBe(1);
  }, 30_000);
});
