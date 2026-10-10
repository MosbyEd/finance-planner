import { jsonError, jsonOk, tooManyRequests, withUser, corsPreflight } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { StoredStateError, loadState } from "@/server/stateStore";

/** Загрузок состояния в минуту от одного пользователя: клиент загружает его при входе и после чужих изменений. */
const LOADS_PER_MINUTE = 60;

export const OPTIONS = corsPreflight;

export const GET = withUser((_req, { user }) => {
  const limit = rateLimit(`state:${user.id}`, LOADS_PER_MINUTE, 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  try {
    const { version, state } = loadState(user.id);
    return jsonOk({ version, state });
  } catch (error) {
    if (error instanceof StoredStateError) return jsonError(423, error.message, { code: "state-corrupted" });
    throw error;
  }
});
