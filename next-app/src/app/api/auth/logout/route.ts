import type { NextRequest } from "next/server";
import { SESSION_COOKIE, deleteSession } from "@/server/auth";
import { clearSessionCookie, isSameOrigin, jsonError, jsonOk } from "@/server/http";

export async function POST(req: NextRequest) {
  if (!isSameOrigin(req)) return jsonError(403, "Запрос с чужого сайта отклонён.");
  deleteSession(req.cookies.get(SESSION_COOKIE)?.value);
  const res = jsonOk({ ok: true });
  clearSessionCookie(res);
  return res;
}
