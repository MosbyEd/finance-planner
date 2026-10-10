import { todayLocal } from "@/domain/dates";
import { todayBudgetText } from "@/domain/shortcuts";
import { corsPreflight, jsonError, jsonOk, withUser } from "@/server/http";
import { StoredStateError, loadState } from "@/server/stateStore";

/** Команда приложения «Сколько можно потратить сегодня»: готовая фраза для Siri. */

export const OPTIONS = corsPreflight;

export const GET = withUser((_req, { user }) => {
  try {
    const { state } = loadState(user.id);
    return jsonOk({ status: "ok", message: todayBudgetText(state, todayLocal()) });
  } catch (error) {
    if (error instanceof StoredStateError) return jsonError(423, error.message, { code: "state-corrupted" });
    throw error;
  }
});
