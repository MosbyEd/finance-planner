/**
 * Сколько стоит AI: запросы, токены и стоимость в рублях за период — по пользователям и видам запросов.
 * Данные — таблица ai_usage: по умолчанию с сервера (ssh, адрес из .env.deploy, база только на чтение),
 * с --db — из локальной базы. Даты включительно, по часам этого компьютера;
 * по умолчанию — с начала текущего месяца по сегодня. Курс — рублей за доллар.
 *
 *   npx tsx scripts/ai-usage.ts --rate 95 [--from 2026-10-01] [--to 2026-10-31] [--db data/finance.sqlite]
 */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { AI_USAGE_ROWS_SQL, DEEPSEEK_PRICES, readAiUsageRows, summarizeAiUsage, type AiUsageRow, type AiUsageTotals } from "../src/server/aiUsage";

const PRICED_MODEL = "deepseek-flash";
const KIND_LABELS: Record<string, string> = { chat: "чат", analysis: "анализ трат", period: "итоги периода" };
const MODE_LABELS: Record<string, string> = { fast: "быстрый", reasoning: "с рассуждением" };

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

/** Полночь даты YYYY-MM-DD по местному времени, в мс. */
function localMidnight(value: string, name: string): number {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) fail(`--${name}: дата в виде ГГГГ-ММ-ДД, а не «${value}»`);
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3])).getTime();
}

function isoDay(date: Date): string {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

/** KEY=value из .env.deploy (тот же файл читает scripts/deploy.sh). */
function deployEnv(): Record<string, string> {
  const file = path.join(import.meta.dirname, "..", ".env.deploy");
  if (!fs.existsSync(file)) return {};
  const vars: Record<string, string> = {};
  for (const line of fs.readFileSync(file, "utf8").split("\n")) {
    const match = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (match) vars[match[1]] = match[2].trim().replace(/^(['"])(.*)\1$/, "$2");
  }
  return vars;
}

/** Таблицу создаёт сервер при первом обращении к базе после выкладки — до этого её нет. */
const TABLE_EXISTS_SQL = "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ai_usage'";

/** Строки с сервера (null — таблицы ещё нет): тот же запрос, что и локально, выполняет node сервера от пользователя службы. */
function readServerRows(from: number, to: number): AiUsageRow[] | null {
  const vars = { ...deployEnv(), ...process.env };
  const host = vars.DEPLOY_HOST ?? fail("Задайте DEPLOY_HOST в .env.deploy или укажите --db.");
  const key = vars.DEPLOY_KEY ?? path.join(os.homedir(), ".ssh", "budget_server_ed25519");
  const dbPath = vars.DEPLOY_DB_PATH ?? "/var/lib/budget/finance.sqlite";
  const program = `
    import { DatabaseSync } from "node:sqlite";
    const db = new DatabaseSync(${JSON.stringify(dbPath)}, { readOnly: true });
    const exists = db.prepare(${JSON.stringify(TABLE_EXISTS_SQL)}).get();
    process.stdout.write(exists ? JSON.stringify(db.prepare(${JSON.stringify(AI_USAGE_ROWS_SQL)}).all(${from}, ${to})) : "null");
  `;
  try {
    const out = execFileSync("ssh", ["-i", key, "-o", "BatchMode=yes", host, "sudo -n -u budget-app node --input-type=module -"], {
      input: program,
      encoding: "utf8",
      maxBuffer: 512 * 1024 * 1024,
      stdio: ["pipe", "pipe", "inherit"],
    });
    return JSON.parse(out) as AiUsageRow[] | null;
  } catch {
    fail(`Не удалось прочитать базу на ${host} — подробности выше.`);
  }
}

function readLocalRows(file: string, from: number, to: number): AiUsageRow[] | null {
  if (!fs.existsSync(file)) fail(`Нет базы ${file}.`);
  const db = new DatabaseSync(path.resolve(file), { readOnly: true });
  try {
    return db.prepare(TABLE_EXISTS_SQL).get() ? readAiUsageRows(db, from, to) : null;
  } finally {
    db.close();
  }
}

const rate = Number((arg("rate") ?? "").replace(",", "."));
if (!(rate > 0)) fail("Укажите курс: --rate 95 (рублей за доллар).");
const today = new Date();
const fromDay = arg("from") ?? isoDay(new Date(today.getFullYear(), today.getMonth(), 1));
const toDay = arg("to") ?? isoDay(today);
const from = localMidnight(fromDay, "from");
const toDate = new Date(localMidnight(toDay, "to"));
const to = new Date(toDate.getFullYear(), toDate.getMonth(), toDate.getDate() + 1).getTime();
if (to <= from) fail("--to раньше --from.");

const dbFile = arg("db");
const rows = dbFile ? readLocalRows(dbFile, from, to) : readServerRows(from, to);

const userLabel = (row: AiUsageRow) => (row.userId === null ? "удалённые аккаунты" : `#${row.userId} ${row.login ?? ""}`.trim());
const kindLabel = (row: AiUsageRow) => `${KIND_LABELS[row.kind] ?? row.kind} · ${MODE_LABELS[row.mode] ?? row.mode}`;

const thousands = (n: number) => (n / 1000).toFixed(1);
const percent = (part: number, whole: number) => (whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—");
const columns = [
  { title: "запросов", width: 10 },
  { title: "вход, тыс.", width: 12 },
  { title: "из кэша", width: 9 },
  { title: "выход, тыс.", width: 13 },
  { title: "рассужд.", width: 10 },
  { title: "$", width: 9 },
  { title: "₽", width: 9 },
  { title: "₽/запрос", width: 10 },
];
const LABEL_WIDTH = 34;

function line(label: string, t: AiUsageTotals): string {
  const cells = [
    String(t.requests),
    thousands(t.promptTokens),
    percent(t.cacheHitTokens, t.promptTokens),
    thousands(t.completionTokens),
    thousands(t.reasoningTokens),
    t.usd.toFixed(4),
    (t.usd * rate).toFixed(2),
    (t.requests > 0 ? (t.usd * rate) / t.requests : 0).toFixed(2),
  ];
  return label.padEnd(LABEL_WIDTH) + cells.map((cell, i) => cell.padStart(columns[i].width)).join("");
}

const header = "".padEnd(LABEL_WIDTH) + columns.map((c) => c.title.padStart(c.width)).join("");
const rule = "─".repeat(header.length);
const price = (p: { cacheHit: number; cacheMiss: number; output: number }) =>
  `вход из кэша $${p.cacheHit}, вход без кэша $${p.cacheMiss}, выход $${p.output}`;

console.log(`Расход AI с ${fromDay} по ${toDay} · курс ${rate} ₽/$ · ${dbFile ? `база ${dbFile}` : "сервер"}`);
console.log(`Цены ${PRICED_MODEL} за 1 млн токенов: пик — ${price(DEEPSEEK_PRICES.peak)}; вне пика — ${price(DEEPSEEK_PRICES.offPeak)}`);
console.log("Часы пик — по будням 01:00–04:00 и 06:00–10:00 UTC. Выход — вместе с рассуждением.\n");

if (rows === null) {
  console.log("Таблицы ai_usage ещё нет: сервер создаёт её при первом обращении к базе после выкладки новой версии.");
  process.exit(0);
}
if (rows.length === 0) {
  console.log("За период запросов к AI не записано.");
  process.exit(0);
}

console.log(header);
console.log(rule);
const byUser = summarizeAiUsage(rows, userLabel);
for (const [user, totals] of byUser) {
  console.log(line(user, totals));
  const own = rows.filter((row) => userLabel(row) === user);
  for (const [kind, kindTotals] of summarizeAiUsage(own, kindLabel)) console.log(line(`   ${kind}`, kindTotals));
}
console.log(rule);
console.log("По видам запросов");
for (const [kind, totals] of summarizeAiUsage(rows, kindLabel)) console.log(line(`   ${kind}`, totals));
console.log(rule);
const total = summarizeAiUsage(rows, () => "Итого").get("Итого")!;
console.log(line("Итого", total));
const known = rows.filter((row) => row.userId !== null);
const users = new Set(known.map((row) => row.userId)).size;
console.log(`\nВ часы пик: ${total.peakRequests} из ${total.requests} запросов.`);
if (users > 0) {
  const perUser = (summarizeAiUsage(known, () => "").get("")!.usd * rate) / users;
  console.log(`Пользователей с запросами: ${users}, в среднем ${perUser.toFixed(2)} ₽ на пользователя за период (без удалённых аккаунтов).`);
}

const otherModels = [...new Set(rows.map((row) => row.model))].filter((model) => model !== PRICED_MODEL);
if (otherModels.length > 0) console.log(`Внимание: цены взяты для ${PRICED_MODEL}, а в ответах есть и ${otherModels.join(", ")}.`);
