/**
 * Перенос пользователей и данных из старого сервера (server/data.sqlite) в новую базу — логика
 * для scripts/import-legacy.ts. Импорты относительные: скрипт запускается вне Next.
 */
import { DatabaseSync } from "node:sqlite";
import type { IsoDate } from "../domain/dates";
import { migrateState } from "../domain/migrate";
import { openDatabase, transaction } from "./db";
import { MAX_STATE_BYTES } from "./limits";
import { loginKey } from "./loginKey";

export interface LegacyImportOptions {
  /** Старая база (открывается только на чтение). */
  from: string;
  /** Новая база. При пробном запуске не открывается и не создаётся. */
  to: string;
  dryRun: boolean;
  today: IsoDate;
  log?: (line: string) => void;
  /** Предел размера состояния (по умолчанию — как у сервера). */
  maxStateBytes?: number;
}

export interface LegacyImportResult {
  imported: string[];
  skipped: string[];
}

type LegacyUser = { id: number; login: string; password_hash: string; name: string | null };

export function importLegacy({
  from,
  to,
  dryRun,
  today,
  log = console.log,
  maxStateBytes = MAX_STATE_BYTES,
}: LegacyImportOptions): LegacyImportResult {
  const legacy = new DatabaseSync(from, { readOnly: true });
  // Пробный запуск не создаёт и не мигрирует базу назначения: те же шаги выполняются в базе в памяти.
  // Совпадения с пользователями, уже перенесёнными в настоящую базу, при этом не проверяются.
  const target = openDatabase(dryRun ? ":memory:" : to);
  try {
    log(`Источник: ${from}\nНазначение: ${to}${dryRun ? " (пробный запуск, без записи)" : ""}\n`);
    if (dryRun) log("Пробный запуск: база назначения не открывается, совпадения с уже перенесёнными логинами не проверяются.\n");

    const users = legacy.prepare("SELECT id, login, password_hash, name FROM users ORDER BY id").all() as LegacyUser[];
    const states = new Map(
      (legacy.prepare("SELECT user_id, state_json FROM user_states").all() as { user_id: number; state_json: string }[]).map(
        (r) => [r.user_id, r.state_json],
      ),
    );

    // Логины сравниваются без учёта регистра, в том числе кириллицы («Аня» и «аня» — один пользователь).
    const findByKey = target.prepare("SELECT login FROM users WHERE login_key = ?");
    const importedKeys = new Map<string, string>();
    const imported: string[] = [];
    const skipped: string[] = [];

    for (const user of users) {
      const key = loginKey(user.login);
      const earlier = importedKeys.get(key);
      if (earlier !== undefined) {
        log(`• ${user.login}: совпадает с «${earlier}» из этой же базы без учёта регистра — пропущен`);
        skipped.push(user.login);
        continue;
      }
      const existing = findByKey.get(key) as { login: string } | undefined;
      if (existing) {
        log(`• ${user.login}: уже есть в новой базе (как «${existing.login}») — пропущен`);
        skipped.push(user.login);
        continue;
      }
      const raw = states.get(user.id);
      let migrated: ReturnType<typeof migrateState> | null = null;
      if (raw) {
        try {
          migrated = migrateState(JSON.parse(raw), today);
        } catch (error) {
          log(`• ${user.login}: данные не перенесены — ${(error as Error).message}`);
          skipped.push(user.login);
          continue;
        }
      }
      const json = migrated ? JSON.stringify(migrated.state) : null;
      const bytes = json === null ? 0 : Buffer.byteLength(json, "utf8");
      if (bytes > maxStateBytes) {
        // Сервер не принял бы ни одного изменения такого аккаунта, кроме уменьшающих его.
        log(`• ${user.login}: данные больше предела (${bytes} байт > ${maxStateBytes}) — пропущен`);
        skipped.push(user.login);
        continue;
      }
      importedKeys.set(key, user.login);
      transaction(target, () => {
        const result = target
          .prepare("INSERT INTO users (login, login_key, password_hash, name, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(user.login.normalize("NFC").trim(), key, user.password_hash, user.name, Date.now());
        if (json !== null) {
          target
            .prepare("INSERT INTO states (user_id, version, state_json, updated_at) VALUES (?, 1, ?, ?)")
            .run(Number(result.lastInsertRowid), json, Date.now());
        }
      });
      imported.push(user.login);
      const r = migrated?.report;
      log(
        `• ${user.login}: ${r ? `операций ${r.transactions}, шаблонов ${r.templates}, целей ${r.goals}, долгов ${r.loans}` : "без данных"}` +
          (r?.dropped.length ? `; не перенесено записей: ${r.dropped.length}` : ""),
      );
      for (const item of r?.dropped ?? []) log(`    – ${item}`);
    }

    if (skipped.length) {
      log(`\nПропущено пользователей: ${skipped.length} (${skipped.join(", ")}). Они не перенесены.`);
    }
    return { imported, skipped };
  } finally {
    legacy.close();
    target.close();
  }
}
