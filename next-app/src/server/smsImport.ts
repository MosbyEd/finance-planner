import { createHash, randomBytes } from "node:crypto";
import { todayLocal } from "@/domain/dates";
import { normalizeSms, parseSberSms, planSmsImport, smsDate } from "@/domain/sms";
import type { User } from "./auth";
import { getDb } from "./db";
import { ActionError, applyUserOps, loadState } from "./stateStore";

/**
 * Операции из СМС банка. Текст присылает автоматизация «Команд» на iPhone с отдельным ключом:
 * ключ годится только для этого — им нельзя прочитать данные или войти в аккаунт.
 */

const KEY_PREFIX = "sms_";
const KEY_RE = /^sms_[A-Za-z0-9_-]{32}$/;

function hashKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export interface SmsKeyStatus {
  createdAt: number;
  lastUsedAt: number | null;
}

/** Новый ключ (прежний перестаёт работать). Сам ключ показывается один раз — в базе только его хэш. */
export function createSmsKey(userId: number, now = Date.now()): { key: string; createdAt: number } {
  const key = KEY_PREFIX + randomBytes(24).toString("base64url");
  getDb()
    .prepare(
      `INSERT INTO sms_keys (user_id, key_hash, created_at, last_used_at) VALUES (?, ?, ?, NULL)
       ON CONFLICT(user_id) DO UPDATE SET key_hash = excluded.key_hash, created_at = excluded.created_at, last_used_at = NULL`,
    )
    .run(userId, hashKey(key), now);
  return { key, createdAt: now };
}

export function deleteSmsKey(userId: number): void {
  getDb().prepare("DELETE FROM sms_keys WHERE user_id = ?").run(userId);
}

export function smsKeyStatus(userId: number): SmsKeyStatus | null {
  const row = getDb().prepare("SELECT created_at, last_used_at FROM sms_keys WHERE user_id = ?").get(userId) as
    | { created_at: number; last_used_at: number | null }
    | undefined;
  return row ? { createdAt: row.created_at, lastUsedAt: row.last_used_at } : null;
}

/** Ключ из заголовка Authorization: Bearer sms_… */
export function smsKeyFromHeader(header: string | null): string | null {
  const match = /^Bearer (\S+)$/.exec(header ?? "");
  return match && KEY_RE.test(match[1]) ? match[1] : null;
}

/** Пользователь по ключу; отмечает время использования. */
export function findUserBySmsKey(key: string, now = Date.now()): User | null {
  if (!KEY_RE.test(key)) return null;
  const db = getDb();
  const row = db
    .prepare("SELECT u.id, u.login, u.name FROM sms_keys k JOIN users u ON u.id = k.user_id WHERE k.key_hash = ?")
    .get(hashKey(key)) as User | undefined;
  if (!row) return null;
  db.prepare("UPDATE sms_keys SET last_used_at = ? WHERE user_id = ?").run(now, row.id);
  return { id: row.id, login: row.login, name: row.name };
}

export interface SmsImportResult {
  /** added — операция добавлена; duplicate — эту СМС уже присылали; ignored — не операция; failed — не добавлено. */
  status: "added" | "duplicate" | "ignored" | "failed";
  /** Короткий текст для уведомления на телефоне. */
  message: string;
}

function hhmm(now: Date): string {
  return `${String(now.getHours()).padStart(2, "0")}:${String(now.getMinutes()).padStart(2, "0")}`;
}

/** Разбирает СМС и добавляет операцию пользователю. Бросает StoredStateError, если состояние повреждено. */
export function importSms(userId: number, text: string, now = new Date()): SmsImportResult {
  const sms = normalizeSms(text);
  const op = parseSberSms(sms);
  if (!op) return { status: "ignored", message: "Не похоже на операцию — пропущено." };

  const today = todayLocal(now);
  const date = smsDate(today, hhmm(now), op.time);
  // Один и тот же текст в один день — та же операция: повторный запуск автоматизации её не задвоит.
  const hash = createHash("sha256").update(`${date}|${sms}`).digest("hex");
  const idBase = `sms-${hash.slice(0, 24)}`;
  const { state } = loadState(userId);
  if (state.transactions.some((t) => t.id === idBase)) return { status: "duplicate", message: "Эта операция уже добавлена." };

  const plan = planSmsImport(state, op, { idBase, date, sms });
  const ops = plan.actions.map((action, i) => ({ opId: `sms-${hash.slice(0, 30)}-${i}`, action }));
  try {
    const result = applyUserOps(userId, ops, today, now.getTime());
    if (!result.changed) return { status: "duplicate", message: "Эта операция уже добавлена." };
    return { status: "added", message: plan.summary };
  } catch (error) {
    if (error instanceof ActionError) return { status: "failed", message: `Не добавлено: ${error.message}` };
    throw error;
  }
}
