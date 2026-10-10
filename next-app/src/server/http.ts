import { NextResponse, type NextRequest } from "next/server";
import type { z } from "zod";
import { SESSION_COOKIE, getSessionUser, type User } from "./auth";
import { env } from "./env";
import { loginKey } from "./loginKey";

export function jsonError(status: number, error: string, extra: Record<string, unknown> = {}): NextResponse {
  return NextResponse.json({ error, ...extra }, { status, headers: { "Cache-Control": "no-store" } });
}

export function jsonOk(data: unknown, status = 200): NextResponse {
  return NextResponse.json(data, { status, headers: { "Cache-Control": "no-store" } });
}

export function tooManyRequests(retryAfterSeconds: number): NextResponse {
  const res = jsonError(429, "Слишком много запросов. Попробуйте чуть позже.");
  res.headers.set("Retry-After", String(retryAfterSeconds));
  return res;
}

/** Токен сессии из заголовка Authorization: Bearer (так входит iOS-приложение). */
export function bearerToken(req: NextRequest): string | undefined {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(req.headers.get("authorization") ?? "");
  return match?.[1];
}

/** Приложение просит выдать токен в ответе на вход (у веб-версии токен живёт только в httpOnly-cookie). */
export function wantsToken(req: NextRequest): boolean {
  return req.headers.get("x-client") === "native";
}

/** Источник запроса, которому разрешён доступ к API (iOS-приложение). */
function allowedCorsOrigin(req: NextRequest): string | null {
  const origin = req.headers.get("origin");
  return origin && env.corsOrigins.includes(origin) ? origin : null;
}

/** Ответ на предварительный CORS-запрос (OPTIONS). */
export function corsPreflight(req: NextRequest): NextResponse {
  const res = new NextResponse(null, { status: 204 });
  const origin = allowedCorsOrigin(req);
  if (origin) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
    res.headers.set("Access-Control-Allow-Headers", "Authorization, Content-Type, X-Account, X-Client");
    res.headers.set("Access-Control-Max-Age", "600");
    res.headers.set("Vary", "Origin");
  }
  return res;
}

/** Разрешает приложению читать ответ (только для источников из CORS_ORIGINS; cookie не участвуют). */
export function withCors(
  handler: (req: NextRequest) => Promise<NextResponse> | NextResponse,
): (req: NextRequest) => Promise<NextResponse> {
  return async (req) => {
    const res = await handler(req);
    const origin = allowedCorsOrigin(req);
    if (origin) {
      res.headers.set("Access-Control-Allow-Origin", origin);
      res.headers.set("Access-Control-Expose-Headers", "Retry-After");
      res.headers.append("Vary", "Origin");
    }
    return res;
  };
}

/**
 * Защита от CSRF в дополнение к SameSite=Lax: изменяющие запросы принимаем только со своего сайта.
 * Запросы с токеном в Authorization подделать с чужого сайта нельзя (браузер не подставит его сам),
 * а iOS-приложение приходит со своего источника из CORS_ORIGINS.
 */
export function isSameOrigin(req: NextRequest): boolean {
  if (bearerToken(req) || allowedCorsOrigin(req)) return true;
  const fetchSite = req.headers.get("sec-fetch-site");
  if (fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") return false;
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

type BodyText = { ok: true; text: string } | { ok: false; response: NextResponse };

const tooLarge = () => jsonError(413, "Слишком большой запрос.");

/**
 * Читает тело потоком и считает БАЙТЫ: как только их больше maxBytes, чтение прекращается (поток
 * отменяется) и возвращается 413. Content-Length может отсутствовать (chunked) или врать,
 * поэтому req.text() — который сначала буферизует всё тело — здесь не годится.
 */
async function readText(req: NextRequest, maxBytes: number): Promise<BodyText> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (declared > maxBytes) return { ok: false, response: tooLarge() };
  if (!req.body) return { ok: true, text: "" };
  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, response: tooLarge() };
      }
      chunks.push(value);
    }
  } catch {
    await reader.cancel().catch(() => {});
    return { ok: false, response: jsonError(400, "Не удалось прочитать запрос.") };
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { ok: false, response: jsonError(400, "Запрос не в кодировке UTF-8.") };
  }
}

/** Читает JSON-тело с ограничением размера (в байтах) и проверкой схемой. */
export async function readBody<T extends z.ZodType>(
  req: NextRequest,
  schema: T,
  maxBytes: number,
): Promise<{ ok: true; data: z.infer<T> } | { ok: false; response: NextResponse }> {
  const body = await readText(req, maxBytes);
  if (!body.ok) return body;
  let raw: unknown;
  try {
    raw = JSON.parse(body.text);
  } catch {
    return { ok: false, response: jsonError(400, "Некорректный JSON.") };
  }
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, response: jsonError(400, issue?.message ?? "Некорректные данные.", { path: issue?.path }) };
  }
  return { ok: true, data: parsed.data };
}

/** Общий «адрес» для всех запросов, когда настоящий IP клиента неизвестен (нет доверенного прокси). */
export const DIRECT_CLIENT = "direct";

/**
 * Ключ клиента для ограничителей частоты. Заголовкам верим только при TRUST_PROXY=true, и только
 * одному (см. env.trustProxyHeader): по умолчанию — ПОСЛЕДНЕМУ адресу X-Forwarded-For (его дописал наш
 * прокси; первые элементы списка может прислать сам клиент), с TRUST_PROXY_HEADER=x-real-ip — X-Real-IP.
 */
export function clientIp(req: NextRequest): string {
  if (!env.trustProxy) return DIRECT_CLIENT;
  const ip =
    env.trustProxyHeader === "x-real-ip"
      ? req.headers.get("x-real-ip")?.trim()
      : req.headers.get("x-forwarded-for")?.split(",").at(-1)?.trim();
  return ip || DIRECT_CLIENT;
}

/** Заголовок с логином, в который, по мнению вкладки, выполнен вход (encodeURIComponent(login)). */
export const ACCOUNT_HEADER = "x-account";

/**
 * Вкладка думает, что вошла в другой аккаунт (в соседней вкладке вошли под другим логином, cookie общая).
 * Без заголовка — проверки нет. Испорченная кодировка — тоже несовпадение.
 */
export function isAccountMismatch(req: NextRequest, user: User): boolean {
  const header = req.headers.get(ACCOUNT_HEADER);
  if (header === null) return false;
  let claimed: string;
  try {
    claimed = decodeURIComponent(header);
  } catch {
    return true;
  }
  return loginKey(claimed) !== loginKey(user.login);
}

export function accountMismatch(): NextResponse {
  return jsonError(409, "Вы вошли в другой аккаунт в соседней вкладке. Обновите страницу.", { code: "account-mismatch" });
}

export function setSessionCookie(res: NextResponse, token: string, expiresAt: number): void {
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: "lax",
    secure: env.cookieSecure,
    path: "/",
    expires: new Date(expiresAt),
  });
}

export function clearSessionCookie(res: NextResponse): void {
  res.cookies.set(SESSION_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: env.cookieSecure, path: "/", maxAge: 0 });
}

/** Текущий пользователь по токену (Authorization: Bearer) или cookie сессии. */
export function currentUser(
  req: NextRequest,
): { user: User; token: string; renewedUntil: number | null; viaBearer: boolean } | null {
  const bearer = bearerToken(req);
  const token = bearer ?? req.cookies.get(SESSION_COOKIE)?.value;
  const session = getSessionUser(token);
  return session && token
    ? { user: session.user, token, renewedUntil: session.renewedUntil, viaBearer: Boolean(bearer) }
    : null;
}

/**
 * Обёртка для защищённых обработчиков: проверка Origin, сессии, аккаунта из X-Account и продление cookie.
 * При несовпадении аккаунта обработчик не вызывается — ничего не читается и не применяется.
 */
export function withUser(
  handler: (req: NextRequest, ctx: { user: User; token: string }) => Promise<NextResponse> | NextResponse,
) {
  return withCors(async (req: NextRequest): Promise<NextResponse> => {
    if (req.method !== "GET" && !isSameOrigin(req)) return jsonError(403, "Запрос с чужого сайта отклонён.");
    const session = currentUser(req);
    if (!session) {
      const res = jsonError(401, "Нужно войти в аккаунт.");
      if (!bearerToken(req) && req.cookies.get(SESSION_COOKIE)) clearSessionCookie(res);
      return res;
    }
    if (isAccountMismatch(req, session.user)) return accountMismatch();
    const res = await handler(req, { user: session.user, token: session.token });
    // Токен приложения продлевается на сервере сам; cookie обновляем только веб-версии.
    if (session.renewedUntil && !session.viaBearer) setSessionCookie(res, session.token, session.renewedUntil);
    return res;
  });
}
