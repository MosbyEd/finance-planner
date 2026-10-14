import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { env } from "./env";
import { loginKey } from "./loginKey";

/** Миграция — SQL или функция (когда нужен JS, например чтобы посчитать значения для старых строк). */
type Migration = string | ((db: DatabaseSync) => void);

const MIGRATIONS: Migration[] = [
  `
  CREATE TABLE users (
    id INTEGER PRIMARY KEY,
    login TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL,
    name TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE INDEX sessions_user_id ON sessions(user_id);
  CREATE TABLE states (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    state_json TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
  `,
  // Применённые изменения: повторная отправка того же opId (потерянный ответ, вторая вкладка) пропускается.
  `
  CREATE TABLE applied_ops (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    op_id TEXT NOT NULL,
    applied_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, op_id)
  );
  CREATE INDEX applied_ops_applied_at ON applied_ops(applied_at);
  `,
  // Логины без учёта регистра и для кириллицы (NOCASE умеет только латиницу): login_key = loginKey(login).
  addLoginKey,
  // applied_ops чистится по пользователю (срок хранения и предел строк на пользователя) — нужен индекс
  // (user_id, applied_at); прежний индекс по одному applied_at эти запросы не использовали.
  // states.rev — случайная метка содержимого, меняется при любой записи состояния (в том числе не через
  // приложение: скрипт, ручная правка). По (version, rev) кэш разобранного состояния понимает, что оно не менялось.
  // Остаток от деления на 2^53 — чтобы значение читалось как обычное число JS.
  `
  CREATE INDEX applied_ops_user_applied_at ON applied_ops(user_id, applied_at);
  DROP INDEX applied_ops_applied_at;
  ALTER TABLE states ADD COLUMN rev INTEGER NOT NULL DEFAULT 0;
  UPDATE states SET rev = random() % 9007199254740992;
  CREATE TRIGGER states_rev_insert AFTER INSERT ON states BEGIN
    UPDATE states SET rev = random() % 9007199254740992 WHERE user_id = NEW.user_id;
  END;
  CREATE TRIGGER states_rev_update AFTER UPDATE OF version, state_json ON states BEGIN
    UPDATE states SET rev = random() % 9007199254740992 WHERE user_id = NEW.user_id;
  END;
  `,
  // Ключ для автоматизации «Команд», которая присылает СМС банка (по одному на пользователя, хранится SHA-256).
  `
  CREATE TABLE sms_keys (
    user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    key_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER
  );
  `,
  // Разборы трат от AI и итоги периодов: один на вид и начало отрезка — итоги периода не просим дважды,
  // с какого бы устройства ни пришёл запрос.
  `
  CREATE TABLE ai_reports (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    period_start TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    report_json TEXT NOT NULL,
    PRIMARY KEY (user_id, kind, period_start)
  );
  `,
  // Расход токенов на каждый ответ DeepSeek — для подсчёта стоимости AI на пользователя (scripts/ai-usage.ts).
  // Тексты вопросов и ответов не хранятся. После удаления аккаунта строки остаются без user_id:
  // потраченное на ушедших пользователей тоже входит в расходы.
  `
  CREATE TABLE ai_usage (
    id INTEGER PRIMARY KEY,
    user_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
    created_at INTEGER NOT NULL,
    kind TEXT NOT NULL,
    mode TEXT NOT NULL,
    model TEXT NOT NULL,
    prompt_tokens INTEGER NOT NULL,
    cache_hit_tokens INTEGER NOT NULL,
    cache_miss_tokens INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    reasoning_tokens INTEGER
  );
  CREATE INDEX ai_usage_created_at ON ai_usage(created_at);
  CREATE INDEX ai_usage_user_id ON ai_usage(user_id);
  `,
];

function addLoginKey(db: DatabaseSync): void {
  db.exec("ALTER TABLE users ADD COLUMN login_key TEXT");
  const rows = db.prepare("SELECT id, login FROM users ORDER BY id").all() as { id: number; login: string }[];
  const update = db.prepare("UPDATE users SET login_key = ? WHERE id = ?");
  const taken = new Set<string>();
  for (const row of rows) {
    let key = loginKey(row.login);
    if (taken.has(key)) {
      // Старые аккаунты, различающиеся только регистром кириллицы («Аня» и «аня»): ключ получает
      // первый, остальные входят по точному написанию логина (см. findUserByLogin). Символа «#»
      // в логинах не бывает, так что такой ключ ни с чьим не совпадёт.
      console.warn(`[db] логин «${row.login}» (id ${row.id}) совпадает с более ранним без учёта регистра`);
      key = `${key}#${row.id}`;
    }
    taken.add(key);
    update.run(key, row.id);
  }
  db.exec("CREATE UNIQUE INDEX users_login_key ON users(login_key)");
}

export function openDatabase(file: string): DatabaseSync {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  migrate(db);
  return db;
}

/** Применяет миграции до версии upTo (по умолчанию — все). Каждая — в своей транзакции. */
export function migrate(db: DatabaseSync, upTo = MIGRATIONS.length): void {
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  for (let v = row.user_version; v < upTo; v++) {
    const step = MIGRATIONS[v];
    transaction(db, () => {
      if (typeof step === "string") db.exec(step);
      else step(db);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

/** Выполняет fn в транзакции с немедленной блокировкой на запись. */
export function transaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = fn();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch (rollbackError) {
      // Транзакцию могло уже откатить само SQLite (например, при SQLITE_FULL) — главное не потерять исходную ошибку.
      console.error("[db] ROLLBACK не удался", rollbackError);
    }
    throw error;
  }
}

// Одно подключение на процесс (и на путь — тесты подменяют DATABASE_PATH).
// globalThis переживает перезагрузку модулей в next dev.
const cache = globalThis as unknown as { __financeDb?: { file: string; db: DatabaseSync } };
/**
 * Подключения, проверенные этим экземпляром модуля. После перезагрузки модулей в next dev подключение
 * из globalThis старое, а миграции могли добавиться — догоняем их (проверка user_version дешёвая).
 */
const migrated = new WeakSet<DatabaseSync>();

export function getDb(): DatabaseSync {
  const file = env.databasePath;
  if (!cache.__financeDb || cache.__financeDb.file !== file) {
    cache.__financeDb?.db.close();
    cache.__financeDb = { file, db: openDatabase(file) };
  }
  const db = cache.__financeDb.db;
  if (!migrated.has(db)) {
    migrate(db);
    migrated.add(db);
  }
  return db;
}

export function closeDb(): void {
  cache.__financeDb?.db.close();
  cache.__financeDb = undefined;
}
