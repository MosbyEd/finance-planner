import { z } from "zod";
import { todayLocal } from "@/domain/dates";
import { newId } from "@/domain/ids";
import { positiveKopecksSchema } from "@/domain/schema";
import { planQuickAdd } from "@/domain/shortcuts";
import { corsPreflight, jsonError, jsonOk, readBody, tooManyRequests, withUser } from "@/server/http";
import { rateLimit } from "@/server/rateLimit";
import { ActionError, StoredStateError, applyUserOps, loadState } from "@/server/stateStore";

/** Команда приложения «Добавить операцию» (Siri, «Команды»): входит токеном сессии приложения. */

const bodySchema = z.object({
  type: z.enum(["income", "expense"]),
  amount: positiveKopecksSchema,
  title: z.string().max(200).optional(),
  category: z.string().max(100).optional(),
  /** Id запуска команды: повтор того же запроса (ответ потерялся) не добавит операцию второй раз. */
  requestId: z.string().regex(/^[a-z0-9-]{8,36}$/).optional(),
});

export const OPTIONS = corsPreflight;

export const POST = withUser(async (req, { user }) => {
  const limit = rateLimit(`shortcuts:${user.id}`, 60, 60_000);
  if (!limit.ok) return tooManyRequests(limit.retryAfterSeconds);
  const body = await readBody(req, bodySchema, 4_000);
  if (!body.ok) return body.response;
  try {
    const today = todayLocal();
    const { state } = loadState(user.id);
    const plan = planQuickAdd(state, { ...body.data, title: body.data.title ?? "" }, { id: newId(), date: today });
    applyUserOps(
      user.id,
      plan.actions.map((action, i) => ({ opId: `qa-${body.data.requestId ?? newId()}${i ? `-${i}` : ""}`.slice(0, 40), action })),
      today,
    );
    return jsonOk({ status: "added", message: plan.summary });
  } catch (error) {
    if (error instanceof ActionError) return jsonError(422, `Не добавлено: ${error.message}`, { message: `Не добавлено: ${error.message}` });
    if (error instanceof StoredStateError) return jsonError(423, error.message, { code: "state-corrupted" });
    throw error;
  }
});
