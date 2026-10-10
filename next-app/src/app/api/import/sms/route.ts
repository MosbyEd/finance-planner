import type { NextRequest } from "next/server";
import { clientIp, jsonOk, readText } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { findUserBySmsKey, importSms, smsKeyFromHeader } from "@/server/smsImport";
import { StoredStateError } from "@/server/stateStore";

/**
 * Приём СМС банка от автоматизации «Команд» на iPhone: Authorization: Bearer <ключ из настроек>,
 * тело — JSON {"text": "…"}, форма с полем text или просто текст СМС.
 * В ответе всегда есть message — его «Команды» могут показать уведомлением.
 */

const MAX_BODY_BYTES = 8_000;
const MAX_SMS_CHARS = 1_000;

function reply(status: number, result: { status: string; message: string }) {
  return jsonOk(status === 200 ? result : { ...result, error: result.message }, status);
}

async function smsText(req: NextRequest, body: string): Promise<string> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const data: unknown = JSON.parse(body);
      if (typeof data === "string") return data;
      if (data && typeof data === "object" && typeof (data as { text?: unknown }).text === "string") {
        return (data as { text: string }).text;
      }
    } catch {
      // не JSON — ниже вернём пустой текст
    }
    return "";
  }
  if (type.includes("application/x-www-form-urlencoded")) return new URLSearchParams(body).get("text") ?? "";
  if (type.includes("multipart/form-data")) {
    try {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      const value = form.get("text");
      return typeof value === "string" ? value : "";
    } catch {
      return "";
    }
  }
  return body;
}

export async function POST(req: NextRequest) {
  // Перебор ключей с одного адреса.
  const byIp = rateLimit(`sms-ip:${clientIp(req)}`, 30, 60_000);
  if (!byIp.ok) return reply(429, { status: "failed", message: "Слишком много запросов. Попробуйте позже." });

  const key = smsKeyFromHeader(req.headers.get("authorization"));
  const user = key ? findUserBySmsKey(key) : null;
  if (!user) {
    return reply(401, { status: "failed", message: "Ключ не подходит. Создайте новый: Настройки → Операции из СМС." });
  }
  const byUser = rateLimit(`sms:${user.id}`, 60, 60_000);
  if (!byUser.ok) return reply(429, { status: "failed", message: "Слишком много СМС за минуту. Попробуйте позже." });

  const body = await readText(req, MAX_BODY_BYTES);
  if (!body.ok) return reply(413, { status: "failed", message: "Слишком длинное сообщение." });
  const text = (await smsText(req, body.text)).slice(0, MAX_SMS_CHARS);
  if (!text.trim()) return reply(400, { status: "failed", message: "Пустой текст СМС: проверьте поле text в команде." });

  try {
    return reply(200, importSms(user.id, text));
  } catch (error) {
    if (error instanceof StoredStateError) {
      return reply(423, { status: "failed", message: "Данные на сервере повреждены — откройте приложение." });
    }
    throw error;
  }
}
