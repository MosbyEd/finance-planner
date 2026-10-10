import type { NextRequest } from "next/server";
import { SESSION_COOKIE } from "@/server/auth";
import { env } from "@/server/env";
import { bearerToken, clearSessionCookie, corsPreflight, currentUser, jsonOk, setSessionCookie, withCors } from "@/server/http";

export const OPTIONS = corsPreflight;

export const GET = withCors((req: NextRequest) => {
  const session = currentUser(req);
  const res = jsonOk({
    user: session ? { login: session.user.login, name: session.user.name } : null,
    aiEnabled: Boolean(env.deepseekApiKey),
    registrationOpen: env.registrationOpen,
  });
  if (!bearerToken(req)) {
    if (session?.renewedUntil) setSessionCookie(res, session.token, session.renewedUntil);
    if (!session && req.cookies.get(SESSION_COOKIE)) clearSessionCookie(res);
  }
  return res;
});
