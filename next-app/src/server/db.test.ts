import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { migrate } from "./db";
import { loginKey } from "./loginKey";

describe("миграция login_key (L3)", () => {
  it("заполняет ключ для старых строк и не падает на логинах, различающихся регистром кириллицы", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, 2); // база до появления login_key
    const insert = db.prepare("INSERT INTO users (login, password_hash, created_at) VALUES (?, 'x', 0)");
    for (const login of ["Аня", "Bob", "аня", "АНЯ"]) insert.run(login);

    migrate(db);
    const rows = db.prepare("SELECT id, login, login_key FROM users ORDER BY id").all();
    expect(rows).toEqual([
      { id: 1, login: "Аня", login_key: "аня" },
      { id: 2, login: "Bob", login_key: "bob" },
      { id: 3, login: "аня", login_key: "аня#3" },
      { id: 4, login: "АНЯ", login_key: "аня#4" },
    ]);
    // Новый пользователь с тем же ключом не создаётся.
    expect(() =>
      db.prepare("INSERT INTO users (login, login_key, password_hash, created_at) VALUES ('аНя', ?, 'x', 0)").run(loginKey("аНя")),
    ).toThrow(/UNIQUE/);
    expect((db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(4);
    db.close();
  });

  it("ключ — без пробелов по краям, в нижнем регистре и в NFC", () => {
    expect(loginKey("  Ёжик ")).toBe("ёжик");
    expect(loginKey("Йод".normalize("NFD"))).toBe(loginKey("йод"));
  });
});

describe("миграция applied_ops и states.rev (ревью 2: H1, H2)", () => {
  it("индекс (user_id, applied_at) вместо индекса по applied_at; rev меняется при любой записи состояния", () => {
    const db = new DatabaseSync(":memory:");
    migrate(db, 3);
    db.exec("INSERT INTO users (id, login, login_key, password_hash, created_at) VALUES (1, 'a', 'a', 'x', 0)");
    db.exec(`INSERT INTO states (user_id, version, state_json, updated_at) VALUES (1, 1, '{}', 0)`);
    migrate(db);

    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'applied_ops'").all() as { name: string }[]).map(
      (r) => r.name,
    );
    expect(indexes).toContain("applied_ops_user_applied_at");
    expect(indexes).not.toContain("applied_ops_applied_at");

    const rev = () => (db.prepare("SELECT rev FROM states WHERE user_id = 1").get() as { rev: number }).rev;
    const revs = [rev()];
    // Та же версия и то же время — но другое содержимое: метка всё равно новая.
    db.exec(`UPDATE states SET state_json = '{"a":1}' WHERE user_id = 1`);
    revs.push(rev());
    db.exec(`INSERT OR REPLACE INTO states (user_id, version, state_json, updated_at) VALUES (1, 1, '{}', 0)`);
    revs.push(rev());
    db.exec(`UPDATE states SET updated_at = 5 WHERE user_id = 1`);
    expect(rev()).toBe(revs[2]);
    expect(new Set(revs).size).toBe(3);
    for (const r of revs) expect(Number.isSafeInteger(r)).toBe(true);
    db.close();
  });
});
