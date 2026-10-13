import type { NextRequest } from "next/server";
import { getSessionUser, type User } from "@/server/auth";
import { bearerToken, clientIp, jsonOk, readText } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { parseKnownSms } from "@/domain/sms";
import { findUserBySmsKey, importSms, receivedTime, smsKeyFromHeader } from "@/server/smsImport";
import { StoredStateError } from "@/server/stateStore";

/**
 * Приём СМС банка от «Команд» на iPhone. Авторизация — Authorization: Bearer <ключ из настроек>
 * (автоматизация, собранная вручную) или токен сессии приложения (команда самого приложения).
 * Тело — JSON {"text": "…", "sender"?: отправитель, "receivedAt"?: ISO-время получения}, форма с полями
 * text/sender/receivedAt или просто текст СМС. По отправителю определяется банк (Настройки → Банки).
 * В ответе всегда есть message — его «Команды» могут показать уведомлением.
 */

const MAX_BODY_BYTES = 8_000;
const MAX_SMS_CHARS = 1_000;

function reply(status: number, result: { status: string; message: string }) {
  return jsonOk(status === 200 ? result : { ...result, error: result.message }, status);
}

interface SmsBody {
  text: string;
  sender?: string;
  receivedAt?: unknown;
}

/** Отправитель из «Команд»: строка (номер или имя) или контакт, превращённый в словарь. */
function senderOf(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim().slice(0, 60) || undefined;
  if (value && typeof value === "object") {
    const { name, phone, value: inner } = value as { name?: unknown; phone?: unknown; value?: unknown };
    return senderOf(phone) ?? senderOf(inner) ?? senderOf(name);
  }
  return undefined;
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
  return candidates.find((x) => parseKnownSms(x) !== null) ?? candidates.sort((a, b) => b.length - a.length)[0] ?? "";
}

async function smsBody(req: NextRequest, body: string): Promise<SmsBody> {
  const type = req.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    try {
      const data: unknown = JSON.parse(body);
      if (typeof data === "string") return { text: data };
      if (data && typeof data === "object") {
        const { text, sender: rawSender, receivedAt, ...rest } = data as { text?: unknown; sender?: unknown; receivedAt?: unknown };
        const sender = senderOf(rawSender);
        if (typeof text === "string" && text.trim()) return { text, sender, receivedAt };
        // Отправителя среди строк для поиска текста не берём: он короче СМС, но мог бы разобраться как она.
        return { text: findSmsText({ text, ...rest }), sender, receivedAt };
      }
    } catch {
      // не JSON — ниже вернём пустой текст
    }
    return { text: "" };
  }
  if (type.includes("application/x-www-form-urlencoded")) {
    const form = new URLSearchParams(body);
    const text = form.get("text")?.trim() ? (form.get("text") as string) : findSmsText([...form.values()]);
    return { text, sender: senderOf(form.get("sender")), receivedAt: form.get("receivedAt") ?? undefined };
  }
  if (type.includes("multipart/form-data")) {
    try {
      const form = await new Response(body, { headers: { "content-type": type } }).formData();
      const text = form.get("text");
      const receivedAt = form.get("receivedAt");
      const values = [...form.values()].filter((v): v is string => typeof v === "string");
      return {
        text: typeof text === "string" && text.trim() ? text : findSmsText(values),
        sender: senderOf(form.get("sender")),
        receivedAt: typeof receivedAt === "string" ? receivedAt : undefined,
      };
    } catch {
      return { text: "" };
    }
  }
  return { text: body };
}

/** Кто прислал СМС и как: ключом из настроек (автоматизация с адресом сервера) или токеном приложения (его действие). */
function authorize(req: NextRequest): { user: User; via: "key" | "app" } | null {
  const key = smsKeyFromHeader(req.headers.get("authorization"));
  if (key) {
    const user = findUserBySmsKey(key);
    return user ? { user, via: "key" } : null;
  }
  const user = getSessionUser(bearerToken(req))?.user;
  return user ? { user, via: "app" } : null;
}

/**
 * Строка в журнале сервера на каждую СМС — без текста СМС: чтобы понять, какая из автоматизаций на телефоне
 * сработала (ключ или действие приложения) и чем закончилось.
 */
function logImport(userId: number | null, via: string, status: string, queuedFor: number, shape = ""): void {
  const queued = queuedFor > 60_000 ? ` queued=${Math.round(queuedFor / 60_000)}m` : "";
  console.log(`[sms] user=${userId ?? "-"} via=${via} status=${status}${queued}${shape ? ` ${shape}` : ""}`);
}

/**
 * ВРЕМЕННО, для отладки нераспознанных СМС: какие поля прислала команда и текст с замаскированными цифрами
 * (суммы, балансы и номера карт не попадают в журнал). Убрать, когда форматы будут разобраны.
 */
function debugShape(req: NextRequest, raw: string, text: string): string {
  const type = (req.headers.get("content-type") ?? "-").split(";")[0];
  let keys = "-";
  try {
    const data: unknown = JSON.parse(raw);
    if (data && typeof data === "object") keys = Object.keys(data).join(",") || "{}";
  } catch {
    // не JSON
  }
  const masked = text.replace(/\d/g, "#").replace(/\s+/g, " ").slice(0, 200);
  return `type=${type} keys=${keys} len=${text.length} text="${masked}"`;
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
  const auth = authorize(req);
  if (!auth) {
    logImport(null, "?", "unauthorized", 0);
    return reply(401, { status: "failed", message: "Ключ не подходит. Создайте новый: Настройки → Операции из СМС." });
  }
  const { user, via } = auth;
  const byUser = rateLimit(`sms:${user.id}`, 60, 60_000);
  if (!byUser.ok) return reply(429, { status: "failed", message: "Слишком много СМС за минуту. Попробуйте позже." });

  const raw = await readText(req, MAX_BODY_BYTES);
  if (!raw.ok) return reply(413, { status: "failed", message: "Слишком длинное сообщение." });
  const body = await smsBody(req, raw.text);
  const text = body.text.slice(0, MAX_SMS_CHARS);
  if (!text.trim()) {
    logImport(user.id, via, "empty-text", 0, debugShape(req, raw.text, raw.text));
    return reply(400, {
      status: "failed",
      message: "Пустой текст СМС. Проще всего заменить запрос на действие «Добавить операцию из СМС» приложения «Бюджет».",
    });
  }

  try {
    const now = new Date();
    const received = receivedTime(body.receivedAt, now);
    const result = importSms(user.id, text, now, received, body.sender);
    logImport(
      user.id,
      via,
      result.status,
      now.getTime() - received.getTime(),
      result.status === "ignored" || result.status === "unparsed" ? debugShape(req, raw.text, text) : "",
    );
    return reply(200, result);
  } catch (error) {
    if (error instanceof StoredStateError) {
      return reply(423, { status: "failed", message: "Данные на сервере повреждены — откройте приложение." });
    }
    throw error;
  }
}
