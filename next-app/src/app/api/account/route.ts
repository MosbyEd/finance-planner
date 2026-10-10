import { z } from "zod";
import { deleteUser, displayNameSchema, findUserById, updateUserName, verifyPassword } from "@/server/auth";
import { clearSessionCookie, jsonError, jsonOk, readBody, tooManyRequests, withUser, corsPreflight } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";

const patchSchema = z.object({ name: displayNameSchema });
const deleteSchema = z.object({ password: z.string().min(1, "Введите пароль").max(200) });

export const OPTIONS = corsPreflight;

export const PATCH = withUser(async (req, { user }) => {
  const body = await readBody(req, patchSchema, 10_000);
  if (!body.ok) return body.response;
  updateUserName(user.id, body.data.name || null);
  return jsonOk({ user: { login: user.login, name: body.data.name || null } });
});

export const DELETE = withUser(async (req, { user }) => {
  // Тот же счётчик, что у смены пароля: подбирать пароль через удаление аккаунта не выйдет.
  const limit = rateLimit(`password:${user.id}`, 10, 15 * 60 * 1000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const body = await readBody(req, deleteSchema, 10_000);
  if (!body.ok) return body.response;
  const record = findUserById(user.id);
  if (!record || !(await verifyPassword(body.data.password, record.passwordHash))) {
    return jsonError(403, "Неверный пароль.");
  }
  deleteUser(user.id);
  const res = jsonOk({ ok: true });
  clearSessionCookie(res);
  return res;
});
