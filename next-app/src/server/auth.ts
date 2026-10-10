import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { getDb, transaction } from "./db";
import { loginKey } from "./loginKey";

export { loginKey };

export const SESSION_COOKIE = "fp_session";
export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
/** Срок сессии продлевается не чаще раза в сутки. */
const SESSION_REFRESH_MS = 24 * 60 * 60 * 1000;
const BCRYPT_COST = 12;

export interface User {
  id: number;
  login: string;
  name: string | null;
}

export const loginSchema = z
  .string()
  .trim()
  .min(3, "Логин — от 3 символов")
  .max(40, "Логин — до 40 символов")
  .regex(/^[\p{L}\p{N}_.@-]+$/u, "В логине можно использовать буквы, цифры и символы _ . @ -");
export const newPasswordSchema = z.string().min(8, "Пароль — от 8 символов").max(200, "Слишком длинный пароль");
export const displayNameSchema = z.string().trim().max(60, "Имя — до 60 символов");

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, BCRYPT_COST);
}

let dummyHash: string | null = null;

/** Проверка пароля; для несуществующего пользователя тратим столько же времени. */
export async function verifyPassword(password: string, hash: string | null): Promise<boolean> {
  if (!hash) {
    dummyHash ??= await bcrypt.hash("dummy-password", BCRYPT_COST);
    await bcrypt.compare(password, dummyHash);
    return false;
  }
  return bcrypt.compare(password, hash);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

type UserRow = { id: number; login: string; name: string | null; password_hash: string };

/**
 * Пользователь по логину без учёта регистра (в том числе кириллицы) — по login_key.
 * Точное написание проверяется первым: так остаются доступны старые аккаунты, которые различаются
 * только регистром кириллицы и появились до login_key (см. миграцию в db.ts).
 */
export function findUserByLogin(login: string): (User & { passwordHash: string }) | null {
  const db = getDb();
  const trimmed = login.normalize("NFC").trim();
  // login уникален с COLLATE NOCASE, поэтому строк не больше одной; точность сверяем в JS (индекс работает).
  const exact = db.prepare("SELECT id, login, name, password_hash FROM users WHERE login = ?").get(trimmed) as
    | UserRow
    | undefined;
  const row =
    exact?.login === trimmed
      ? exact
      : (db.prepare("SELECT id, login, name, password_hash FROM users WHERE login_key = ?").get(loginKey(login)) as
          | UserRow
          | undefined);
  return row ? { id: row.id, login: row.login, name: row.name, passwordHash: row.password_hash } : null;
}

export function findUserById(id: number): (User & { passwordHash: string }) | null {
  const row = getDb().prepare("SELECT id, login, name, password_hash FROM users WHERE id = ?").get(id) as
    | UserRow
    | undefined;
  return row ? { id: row.id, login: row.login, name: row.name, passwordHash: row.password_hash } : null;
}

export class LoginTakenError extends Error {}

/** Создаёт пользователя; логин, совпадающий с существующим без учёта регистра, — LoginTakenError. */
export function createUser(login: string, passwordHash: string, name: string | null): User {
  const db = getDb();
  const display = login.normalize("NFC").trim();
  try {
    const result = db
      .prepare("INSERT INTO users (login, login_key, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(display, loginKey(login), passwordHash, name || null, Date.now());
    return { id: Number(result.lastInsertRowid), login: display, name: name || null };
  } catch (error) {
    if (error instanceof Error && /UNIQUE/i.test(error.message)) throw new LoginTakenError();
    throw error;
  }
}

export function updateUserName(userId: number, name: string | null): void {
  getDb().prepare("UPDATE users SET name = ? WHERE id = ?").run(name || null, userId);
}

export function updatePassword(userId: number, passwordHash: string, keepSessionToken: string | null): void {
  const db = getDb();
  transaction(db, () => {
    db.prepare("UPDATE users SET password_hash = ? WHERE id = ?").run(passwordHash, userId);
    if (keepSessionToken) {
      db.prepare("DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?").run(userId, hashToken(keepSessionToken));
    } else {
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
    }
  });
}

export function deleteUser(userId: number): void {
  getDb().prepare("DELETE FROM users WHERE id = ?").run(userId);
}

export function createSession(userId: number, now = Date.now()): { token: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = now + SESSION_TTL_MS;
  const db = getDb();
  db.prepare("INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)").run(
    hashToken(token),
    userId,
    now,
    expiresAt,
  );
  db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(now);
  return { token, expiresAt };
}

/** Пользователь по токену сессии. Возвращает новый срок, если сессию продлили. */
export function getSessionUser(token: string | undefined, now = Date.now()): { user: User; renewedUntil: number | null } | null {
  if (!token || token.length > 200) return null;
  const db = getDb();
  const row = db
    .prepare(
      `SELECT u.id, u.login, u.name, s.expires_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token_hash = ? AND s.expires_at > ?`,
    )
    .get(hashToken(token), now) as { id: number; login: string; name: string | null; expires_at: number } | undefined;
  if (!row) return null;
  let renewedUntil: number | null = null;
  if (row.expires_at - now < SESSION_TTL_MS - SESSION_REFRESH_MS) {
    renewedUntil = now + SESSION_TTL_MS;
    db.prepare("UPDATE sessions SET expires_at = ? WHERE token_hash = ?").run(renewedUntil, hashToken(token));
  }
  return { user: { id: row.id, login: row.login, name: row.name }, renewedUntil };
}

export function deleteSession(token: string | undefined): void {
  if (!token) return;
  getDb().prepare("DELETE FROM sessions WHERE token_hash = ?").run(hashToken(token));
}
