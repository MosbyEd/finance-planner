import type { NextRequest } from "next/server";
import { z } from "zod";
import { createSession, findUserByLogin, loginKey, verifyPassword } from "@/server/auth";
import {
  DIRECT_CLIENT,
  clientIp,
  isSameOrigin,
  jsonError,
  jsonOk,
  readBody,
  setSessionCookie,
  tooManyRequests,
} from "@/server/http";
import { rateLimit, resetRateLimit } from "@/server/rateLimit";

const bodySchema = z.object({
  login: z.string().trim().min(1, "Введите логин").max(100),
  password: z.string().min(1, "Введите пароль").max(200),
});

const WINDOW_MS = 15 * 60 * 1000;
/** Строгий предел: попыток для пары (логин, адрес). Перебирающий с одного адреса упрётся в него первым. */
const PER_LOGIN_AND_IP = 10;
/** Мягкий предел на логин со всех адресов: чтобы запереть владельца, нужно много разных адресов. */
const PER_LOGIN = 50;
/** Попыток с одного адреса по всем логинам (перебор логинов). */
const PER_IP = 50;
/**
 * Без настоящего IP (нет доверенного прокси) адрес у всех один, и строгий предел на 15 минут запер бы
 * владельца вместе с перебирающим. Поэтому сверх него — не блокировка, а замедление: не чаще одной
 * попытки на логин за это время. Владелец войдёт, подождав, а перебор останется медленным.
 */
const SLOWDOWN_MS = 20_000;
/**
 * Попыток входа с несуществующими логинами в минуту со всех адресов. Для них bcrypt с фиктивным хэшем
 * выравнивает время ответа, но стоит процессора; сверх предела отвечаем сразу (разница во времени
 * под перебором допустима).
 */
const UNKNOWN_LOGINS_PER_MINUTE = 60;

const invalidCredentials = () => jsonError(401, "Неверный логин или пароль.");

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return jsonError(403, "Запрос с чужого сайта отклонён.");
  const body = await readBody(req, bodySchema, 10_000);
  if (!body.ok) return body.response;
  const { login, password } = body.data;

  const ip = clientIp(req);
  const key = loginKey(login);
  const pairKey = `login:${key}|${ip}`;
  const perLoginKey = `login:${key}`;
  const slowKey = `login-slow:${key}`;
  // Счётчики проверяются по очереди: попытки, отбитые строгим пределом, не расходуют мягкий,
  // поэтому один адрес добавляет к счётчику логина не больше PER_LOGIN_AND_IP за окно (плюс медленные).
  // Без доверенного прокси адрес у всех один (DIRECT_CLIENT) — предел по адресу тогда был бы общим
  // для всех пользователей и позволял бы запереть всех сразу, поэтому он действует только с настоящим IP.
  if (ip !== DIRECT_CLIENT) {
    const perIp = rateLimit(`login-ip:${ip}`, PER_IP, WINDOW_MS);
    if (!perIp.ok) return tooManyRequests(perIp.retryAfterSeconds);
  }
  const pair = rateLimit(pairKey, PER_LOGIN_AND_IP, WINDOW_MS);
  if (ip === DIRECT_CLIENT) {
    // Счётчик замедления ведётся и до строгого предела: сразу за ним тоже придётся подождать.
    const slow = rateLimit(slowKey, 1, SLOWDOWN_MS);
    if (!pair.ok && !slow.ok) return tooManyRequests(slow.retryAfterSeconds);
  } else if (!pair.ok) {
    return tooManyRequests(pair.retryAfterSeconds);
  }
  const perLogin = rateLimit(perLoginKey, PER_LOGIN, WINDOW_MS);
  if (!perLogin.ok) return tooManyRequests(perLogin.retryAfterSeconds);

  const user = findUserByLogin(login);
  if (!user) {
    if (rateLimit("login-unknown:all", UNKNOWN_LOGINS_PER_MINUTE, 60_000).ok) await verifyPassword(password, null);
    return invalidCredentials();
  }
  if (!(await verifyPassword(password, user.passwordHash))) return invalidCredentials();

  resetRateLimit(pairKey);
  resetRateLimit(perLoginKey);
  resetRateLimit(slowKey);
  const session = createSession(user.id);
  const res = jsonOk({ user: { login: user.login, name: user.name } });
  setSessionCookie(res, session.token, session.expiresAt);
  return res;
}
