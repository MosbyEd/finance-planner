import { analysisReportSchema, type AnalysisKind, type AnalysisReport } from "@/domain/spendingAnalysis";
import { getDb } from "./db";

/** Сколько разборов и итогов хранить на пользователя: тренды за 3+ месяца — потом, им хватит. */
const MAX_REPORTS = 40;

function parse(json: string): AnalysisReport | null {
  try {
    const parsed = analysisReportSchema.safeParse(JSON.parse(json));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/** Сохраняет разбор: тот же вид и то же начало отрезка — заменяет прежний. Старые сверх предела удаляются. */
export function saveReport(userId: number, report: AnalysisReport): void {
  const db = getDb();
  db.prepare(
    "INSERT OR REPLACE INTO ai_reports (user_id, kind, period_start, created_at, report_json) VALUES (?, ?, ?, ?, ?)",
  ).run(userId, report.kind, report.from, report.createdAt, JSON.stringify(report));
  db.prepare(
    `DELETE FROM ai_reports WHERE user_id = ? AND rowid NOT IN
       (SELECT rowid FROM ai_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?)`,
  ).run(userId, userId, MAX_REPORTS);
}

export function findReport(userId: number, kind: AnalysisKind, from: string): AnalysisReport | null {
  const row = getDb()
    .prepare("SELECT report_json FROM ai_reports WHERE user_id = ? AND kind = ? AND period_start = ?")
    .get(userId, kind, from) as { report_json: string } | undefined;
  return row ? parse(row.report_json) : null;
}

/** Разборы пользователя, новые первыми. */
export function listReports(userId: number, limit = 20): AnalysisReport[] {
  const rows = getDb()
    .prepare("SELECT report_json FROM ai_reports WHERE user_id = ? ORDER BY created_at DESC LIMIT ?")
    .all(userId, limit) as { report_json: string }[];
  return rows.map((r) => parse(r.report_json)).filter((r): r is AnalysisReport => r !== null);
}
