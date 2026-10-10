import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  LoginTakenError,
  createSession,
  createUser,
  displayNameSchema,
  hashPassword,
  loginSchema,
  newPasswordSchema,
} from "@/server/auth";
import { env } from "@/server/env";
import {
  clientIp,
  corsPreflight,
  isSameOrigin,
  jsonError,
  jsonOk,
  readBody,
  setSessionCookie,
  tooManyRequests,
  wantsToken,
  withCors,
} from "@/server/http";
import { rateLimit } from "@/server/rateLimit";

const HOUR_MS = 60 * 60 * 1000;
/** Регистраций в час со всех адресов вместе: без доверенного прокси IP неизвестен, и это главный предел. */
const REGISTRATIONS_PER_HOUR = 20;

const bodySchema = z.object({
  login: loginSchema,
  password: newPasswordSchema,
  name: displayNameSchema.optional(),
});

export const OPTIONS = corsPreflight;

export const POST = withCors(async (req: NextRequest) => {
  if (!isSameOrigin(req)) return jsonError(403, "Запрос с чужого сайта отклонён.");
  if (!env.registrationOpen) return jsonError(403, "Регистрация закрыта.");
  const limit = rateLimit(`register:${clientIp(req)}`, 10, HOUR_MS);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);

  const body = await readBody(req, bodySchema, 10_000);
  if (!body.ok) return body.response;
  const { login, password, name } = body.data;
  // Общий предел считаем только для корректных заявок, чтобы мусорные запросы его не расходовали.
  const global = rateLimit("register:all", REGISTRATIONS_PER_HOUR, HOUR_MS);
  if (!global.ok) return tooManyRequests(global.retryAfterSeconds);

  try {
    const user = createUser(login, await hashPassword(password), name ?? null);
    const session = createSession(user.id);
    const publicUser = { login: user.login, name: user.name };
    if (wantsToken(req)) return jsonOk({ user: publicUser, token: session.token, expiresAt: session.expiresAt }, 201);
    const res = jsonOk({ user: publicUser }, 201);
    setSessionCookie(res, session.token, session.expiresAt);
    return res;
  } catch (error) {
    if (error instanceof LoginTakenError) return jsonError(409, "Этот логин уже занят.");
    throw error;
  }
});
