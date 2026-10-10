import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import { migrateState } from "@/domain/migrate";
import { importLegacy } from "./legacyImport";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-legacy-test-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Старая база: пользователи и их состояния в формате корневого приложения. */
const legacyState = (i: number, note = "") => ({
  months: {
    "2026-03": {
      transactions: [{ id: `t${i}`, type: "income", category: "Зарплата", title: "", amount: 1000, date: "2026-03-10", note }],
    },
  },
});

function legacyDb(file: string, users: { login: string; note?: string }[]): string {
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE users (id INTEGER PRIMARY KEY, login TEXT, password_hash TEXT, name TEXT);
    CREATE TABLE user_states (user_id INTEGER PRIMARY KEY, state_json TEXT);
  `);
  users.forEach((u, i) => {
    db.prepare("INSERT INTO users (id, login, password_hash, name) VALUES (?, ?, 'hash', NULL)").run(i + 1, u.login);
    db.prepare("INSERT INTO user_states (user_id, state_json) VALUES (?, ?)").run(i + 1, JSON.stringify(legacyState(i, u.note)));
  });
  db.close();
  return file;
}

const quiet = () => {};

describe("перенос из старой базы (ревью 2)", () => {
  it("пробный запуск не создаёт и не открывает базу назначения (L3)", () => {
    const from = legacyDb(path.join(dir, "legacy-dry.sqlite"), [{ login: "anna" }, { login: "Anna" }]);
    const to = path.join(dir, "nested", "target.sqlite");
    const result = importLegacy({ from, to, dryRun: true, today: "2026-03-20", log: quiet });
    expect(result).toEqual({ imported: ["anna"], skipped: ["Anna"] });
    expect(fs.existsSync(to)).toBe(false);
    expect(fs.existsSync(path.dirname(to))).toBe(false);
  });

  it("пользователь с данными больше предела пропускается с сообщением (M3)", () => {
    const from = legacyDb(path.join(dir, "legacy-big.sqlite"), [{ login: "small" }, { login: "big", note: "н".repeat(400) }]);
    const to = path.join(dir, "target-big.sqlite");
    const lines: string[] = [];
    // Предел между размерами: заметка в 400 символов кириллицы — 800 байт.
    const smallBytes = Buffer.byteLength(JSON.stringify(migrateState(legacyState(0), "2026-03-20").state));
    const maxStateBytes = smallBytes + 400;
    const result = importLegacy({ from, to, dryRun: false, today: "2026-03-20", log: (l) => lines.push(l), maxStateBytes });
    expect(result).toEqual({ imported: ["small"], skipped: ["big"] });
    expect(lines.some((l) => l.includes("big") && l.includes("больше предела"))).toBe(true);
    const db = new DatabaseSync(to, { readOnly: true });
    expect(db.prepare("SELECT login FROM users").all()).toEqual([{ login: "small" }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM states").get()).toEqual({ n: 1 });
    db.close();
  });
});
