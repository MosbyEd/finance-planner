import { z } from "zod";
import { findUserById, hashPassword, newPasswordSchema, updatePassword, verifyPassword } from "@/server/auth";
import { jsonError, jsonOk, readBody, withUser } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { tooManyRequests } from "@/server/http";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Введите текущий пароль").max(200),
  newPassword: newPasswordSchema,
});

export const POST = withUser(async (req, { user, token }) => {
  const limit = rateLimit(`password:${user.id}`, 10, 15 * 60 * 1000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const body = await readBody(req, bodySchema, 10_000);
  if (!body.ok) return body.response;
  const record = findUserById(user.id);
  if (!record || !(await verifyPassword(body.data.currentPassword, record.passwordHash))) {
    return jsonError(403, "Текущий пароль неверен.");
  }
  // Остальные сессии (другие устройства) завершаются.
  updatePassword(user.id, await hashPassword(body.data.newPassword), token);
  return jsonOk({ ok: true });
});
