import { z } from "zod";
import { actionSchema } from "@/domain/actions";
import { todayLocal } from "@/domain/dates";
import { jsonError, jsonOk, readBody, tooManyRequests, withUser, corsPreflight } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import {
  ActionError,
  MAX_OPS_PER_REQUEST,
  MAX_STATE_BYTES,
  StoredStateError,
  applyUserOps,
  opIdSchema,
} from "@/server/stateStore";

const bodySchema = z.object({
  /** Версия, на которой клиент построил эти изменения. */
  baseVersion: z.number().int().min(0),
  ops: z.array(z.object({ opId: opIdSchema, action: actionSchema })).min(1).max(MAX_OPS_PER_REQUEST),
});

/** Запросов на изменение в минуту от одного пользователя: клиенту хватает с запасом, перебору — нет. */
const ACTIONS_PER_MINUTE = 120;
/**
 * Изменений в минуту от одного пользователя (каждое — шаг редьюсера и, на пути ошибки, проверка схемой):
 * 15 полных пачек. Один пользователь не займёт процессор целиком.
 */
const OPS_PER_MINUTE = 1500;

export const OPTIONS = corsPreflight;

export const POST = withUser(async (req, { user }) => {
  // До чтения и разбора тела: они сами по себе дорогие для больших пачек.
  const limit = rateLimit(`actions:${user.id}`, ACTIONS_PER_MINUTE, 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const body = await readBody(req, bodySchema, MAX_STATE_BYTES + 100_000);
  if (!body.ok) return body.response;
  const budget = rateLimit(`ops:${user.id}`, OPS_PER_MINUTE, 60_000, { cost: body.data.ops.length });
  if (!budget.ok) return tooManyRequests(budget.retryAfterSeconds);
  try {
    const result = applyUserOps(user.id, body.data.ops, todayLocal());
    // Если версия ушла дальше, чем на эту пачку, — данные менялись с другого устройства.
    const expected = body.data.baseVersion + (result.changed ? 1 : 0);
    const stale = result.version !== expected || result.duplicates > 0;
    return jsonOk({ version: result.version, stale });
  } catch (error) {
    if (error instanceof ActionError) return jsonError(422, error.message, { actionIndex: error.actionIndex });
    if (error instanceof StoredStateError) return jsonError(423, error.message, { code: "state-corrupted" });
    throw error;
  }
});
