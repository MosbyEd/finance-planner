import type { NextRequest } from "next/server";
import { SESSION_COOKIE, deleteSession } from "@/server/auth";
import { bearerToken, clearSessionCookie, corsPreflight, isSameOrigin, jsonError, jsonOk, withCors } from "@/server/http";

export const OPTIONS = corsPreflight;

export const POST = withCors(async (req: NextRequest) => {
  if (!isSameOrigin(req)) return jsonError(403, "Запрос с чужого сайта отклонён.");
  const bearer = bearerToken(req);
  deleteSession(bearer ?? req.cookies.get(SESSION_COOKIE)?.value);
  const res = jsonOk({ ok: true });
  if (!bearer) clearSessionCookie(res);
  return res;
});
