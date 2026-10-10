import type { NextRequest } from "next/server";
import { getSessionUser, type User } from "@/server/auth";
import { bearerToken, clientIp, jsonOk, readText } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { parseSberSms } from "@/domain/sms";
import { findUserBySmsKey, importSms, receivedTime, smsKeyFromHeader } from "@/server/smsImport";
import { StoredStateError } from "@/server/stateStore";

/**
 * Приём СМС банка от «Команд» на iPhone. Авторизация — Authorization: Bearer <ключ из настроек>
 * (автоматизация, собранная вручную) или токен сессии приложения (команда самого приложения).
 * Тело — JSON {"text": "…", "receivedAt"?: ISO-время получения}, форма с полями text/receivedAt или просто текст СМС.
 * В ответе всегда есть message — его «Команды» могут показать уведомлением.
 */

const MAX_BODY_BYTES = 8_000;
const MAX_SMS_CHARS = 1_000;

function reply(status: number, result: { status: string; message: string }) {
  return jsonOk(status === 200 ? result : { ...result, error: result.message }, status);
}

interface SmsBody {
  text: string;
  receivedAt?: unknown;
}

/**
 * Текст СМС, если «Команды» положили его не в поле text (другое имя, вложенный словарь, тип «не текст»):
 * среди всех строк запроса — та, что разбирается как СМС банка, иначе самая длинная.
 */
function findSmsText(value: unknown): string {
  const strings: string[] = [];
  const walk = (v: unknown, depth: number) => {
    if (typeof v === "string") strings.push(v);
    else if (depth < 4 && Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (depth < 4 && v && typeof v === "object") Object.values(v).forEach((x) => walk(x, depth + 1));
  };
  walk(value, 0);
  const candidates = strings.filter((x) => x.trim() && !/^\d{4}-\d{2}-\d{2}T/.test(x));
  return candidates.find((x) => parseSberSms(x) !== null) ?? candidates.sort((a, b) => b.length - a.length)[0] ?? "";
}

async function smsBody(req: NextRequest, body: string): Promise<SmsBody> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const data: unknown = JSON.parse(body);
      if (typeof data === "string") return { text: data };
      if (data && typeof data === "object") {
        const { text, receivedAt } = data as { text?: unknown; receivedAt?: unknown };
        if (typeof text === "string" && text.trim()) return { text, receivedAt };
        return { text: findSmsText(data), receivedAt };
      }
    } catch {
      // не JSON — ниже вернём пустой текст
    }
    return { text: "" };
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(body);
    const text = form.get("text")?.trim() ? (form.get("text") as string) : findSmsText([...form.values()]);
    return { text, receivedAt: form.get("receivedAt") ?? undefined };
  }
  if (type.includes("multipart/form-data")) {
    try {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      const text = form.get("text");
      const receivedAt = form.get("receivedAt");
      const values = [...form.values()].filter((v): v is string => typeof v === "string");
      return {
        text: typeof text === "string" && text.trim() ? text : findSmsText(values),
        receivedAt: typeof receivedAt === "string" ? receivedAt : undefined,
      };
    } catch {
      return { text: "" };
    }
  }
  return { text: body };
}

function authorize(req: NextRequest): User | null {
  const key = smsKeyFromHeader(req.headers.get("authorization"));
  if (key) return findUserBySmsKey(key);
  return getSessionUser(bearerToken(req))?.user ?? null;
}

export async function POST(req: NextRequest) {
  // Перебор ключей с одного адреса.
  const byIp = rateLimit(`sms-ip:${clientIp(req)}`, 30, 60_000);
  if (!byIp.ok) return reply(429, { status: "failed", message: "Слишком много запросов. Попробуйте позже." });

  if (!req.headers.get("authorization")?.trim()) {
    return reply(401, {
      status: "failed",
      message: "В запросе нет ключа: добавьте заголовок Authorization со значением «Bearer sms_…» из настроек приложения.",
    });
  }
  const user = authorize(req);
  if (!user) {
    return reply(401, { status: "failed", message: "Ключ не подходит. Создайте новый: Настройки → Операции из СМС." });
  }
  const byUser = rateLimit(`sms:${user.id}`, 60, 60_000);
  if (!byUser.ok) return reply(429, { status: "failed", message: "Слишком много СМС за минуту. Попробуйте позже." });

  const raw = await readText(req, MAX_BODY_BYTES);
  if (!raw.ok) return reply(413, { status: "failed", message: "Слишком длинное сообщение." });
  const body = await smsBody(req, raw.text);
  const text = body.text.slice(0, MAX_SMS_CHARS);
  if (!text.trim()) {
    return reply(400, {
      status: "failed",
      message: "Пустой текст СМС. Проще всего заменить запрос на действие «Добавить операцию из СМС» приложения «Бюджет».",
    });
  }

  try {
    const now = new Date();
    return reply(200, importSms(user.id, text, now, receivedTime(body.receivedAt, now)));
  } catch (error) {
    if (error instanceof StoredStateError) {
      return reply(423, { status: "failed", message: "Данные на сервере повреждены — откройте приложение." });
    }
    throw error;
  }
}
