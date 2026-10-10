/**
 * Перенос пользователей и данных из старого сервера (server/data.sqlite) в новую базу.
 * Пароли переносятся как есть (bcrypt-хэши совместимы). Старая база открывается только на чтение.
 * Данные больше предела сервера (MAX_STATE_BYTES) не переносятся — пользователь пропускается.
 * Пробный запуск (--dry-run) базу назначения не создаёт и не открывает.
 *
 *   npm run import-legacy -- --from ../server/data.sqlite [--to data/finance.sqlite] [--dry-run]
 */
import path from "node:path";
import { todayLocal } from "../src/domain/dates";
import { importLegacy } from "../src/server/legacyImport";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

importLegacy({
  from: path.resolve(arg("from") ?? "../server/data.sqlite"),
  to: path.resolve(arg("to") ?? process.env.DATABASE_PATH ?? "data/finance.sqlite"),
  dryRun: process.argv.includes("--dry-run"),
  today: todayLocal(),
});
