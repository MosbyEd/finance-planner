import { corsPreflight, jsonOk, tooManyRequests, withUser } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { createSmsKey, deleteSmsKey, smsKeyStatus } from "@/server/smsImport";

/** Ключ для автоматизации «Команд», которая присылает СМС банка (см. /api/import/sms). */

export const OPTIONS = corsPreflight;

export const GET = withUser((_req, { user }) => jsonOk({ key: smsKeyStatus(user.id) }));

export const POST = withUser((_req, { user }) => {
  const limit = rateLimit(`sms-key:${user.id}`, 10, 60 * 60 * 1000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const { key, createdAt } = createSmsKey(user.id);
  return jsonOk({ key, createdAt });
});

export const DELETE = withUser((_req, { user }) => {
  deleteSmsKey(user.id);
  return jsonOk({ ok: true });
});
