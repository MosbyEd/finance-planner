import { z } from "zod";
import type { Action } from "@/domain/actions";
import type { AiProposal } from "@/domain/ai";
import type { IsoDate } from "@/domain/dates";
import { stateSchema, type State } from "@/domain/schema";
import { apiBase, isNativeApp } from "./runtime";
import { storage } from "./storage";

/** Токен сессии приложения (в браузере сессия живёт в httpOnly-cookie и сюда не попадает). */
export const TOKEN_KEY = "fp:token";

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  /** Нет связи с сервером или сервер недоступен — стоит повторить позже. */
  get isNetwork(): boolean {
    return this.status === 0 || this.status >= 500;
  }
}

const DEFAULT_TIMEOUT_MS = 20_000;
const UNEXPECTED = "Сервер вернул неожиданный ответ. Попробуем ещё раз позже.";

/**
 * Запрос к API с таймаутом. Ответ 2xx, который не является ожидаемым JSON (страница прокси,
 * captive portal), считается сетевой ошибкой — иначе изменение посчиталось бы сохранённым.
 */
async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: { method?: string; body?: unknown; timeoutMs?: number; account?: string } = {},
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), init.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  let response: Response;
  let text: string;
  try {
    const native = isNativeApp();
    const token = native ? storage.get(TOKEN_KEY) : null;
    response = await fetch(apiBase() + path, {
      method: init.method ?? "GET",
      credentials: native ? "omit" : "same-origin",
      headers: {
        ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
        ...(native ? { "X-Client": "native" } : {}),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        // Какой аккаунт ожидает вкладка: если в соседней вошли в другой, сервер ответит 409.
        ...(init.account ? { "X-Account": encodeURIComponent(init.account) } : {}),
      },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
      signal: controller.signal,
    });
    text = await response.text();
  } catch {
    throw new ApiError(controller.signal.aborted ? "Сервер не отвечает." : "Нет связи с сервером.", 0);
  } finally {
    clearTimeout(timer);
  }

  return interpret(response.status, text, schema);
}

/** Разбор ответа сервера: ошибка — ApiError с текстом сервера, неожиданный ответ — сетевая ошибка. */
function interpret<T>(status: number, text: string, schema: z.ZodType<T>): T {
  const ok = status >= 200 && status < 300;
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    if (ok) throw new ApiError(UNEXPECTED, 0);
  }
  const body = data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  if (!ok) {
    const message =
      typeof body.error === "string" ? body.error : status === 0 ? "Нет связи с сервером." : `Ошибка сервера (${status}).`;
    throw new ApiError(message, status, body);
  }
  const parsed = schema.safeParse(data);
  if (!parsed.success) throw new ApiError(UNEXPECTED, 0);
  return parsed.data;
}

const userSchema = z.object({ login: z.string(), name: z.string().nullable() });
export type PublicUser = z.infer<typeof userSchema>;

const meSchema = z.object({
  user: userSchema.nullable(),
  aiEnabled: z.boolean(),
  registrationOpen: z.boolean(),
});
export type MeResponse = z.infer<typeof meSchema>;

const userResponseSchema = z.object({ user: userSchema });
/** Ответ на вход: приложению сервер возвращает ещё и токен. */
const signInResponseSchema = z.object({ user: userSchema, token: z.string().min(20).max(200).optional() });
const okSchema = z.object({ ok: z.literal(true) });
const stateResponseSchema = z.object({ version: z.number().int().min(0), state: stateSchema });
const opsResponseSchema = z.object({ version: z.number().int().min(0), stale: z.boolean() });
/** Ключ для автоматизации «Команд», присылающей СМС банка: есть ли он и когда им пользовались. */
const smsKeyStatusSchema = z.object({
  key: z.object({ createdAt: z.number(), lastUsedAt: z.number().nullable() }).nullable(),
});
export type SmsKeyStatus = NonNullable<z.infer<typeof smsKeyStatusSchema>["key"]>;
const smsKeyCreatedSchema = z.object({ key: z.string(), createdAt: z.number() });

export interface Op {
  /** Уникальный id изменения: сервер не применит его дважды. */
  opId: string;
  action: Action;
}

export interface AiChatMessage {
  role: "user" | "assistant";
  content: string;
}

const aiChatSchema = z.object({
  text: z.string(),
  // Предложение уже проверено сервером; здесь — только форма.
  proposal: z
    .object({
      operations: z.array(z.any()),
      templates: z.array(z.any()),
      limits: z.array(z.any()),
      transfers: z.array(z.any()).default([]),
      templateUpdates: z.array(z.any()).default([]),
      balances: z.array(z.any()).default([]),
      goals: z.array(z.any()).default([]),
      loanPayments: z.array(z.any()).default([]),
    })
    .nullable(),
  skipped: z.number(),
  reasoning: z.string().nullable(),
  model: z.string(),
});
export interface AiChatResponse {
  text: string;
  proposal: AiProposal | null;
  skipped: number;
  reasoning: string | null;
  model: string;
}

/** Ответ помощника, полученный фоновым запросом приложения (статус и тело как есть). */
export function parseAiChatReply(status: number, body: string): AiChatResponse {
  return interpret(status, body, aiChatSchema) as AiChatResponse;
}

export const api = {
  me: () => request("/api/me", meSchema),
  login: (login: string, password: string) =>
    request("/api/auth/login", signInResponseSchema, { method: "POST", body: { login, password } }),
  register: (login: string, password: string, name: string) =>
    request("/api/auth/register", signInResponseSchema, { method: "POST", body: { login, password, name } }),
  logout: () => request("/api/auth/logout", okSchema, { method: "POST" }),
  getState: (account?: string): Promise<{ version: number; state: State }> =>
    request("/api/state", stateResponseSchema, { timeoutMs: 30_000, account }),
  postOps: (baseVersion: number, ops: Op[], account?: string) =>
    request("/api/state/actions", opsResponseSchema, {
      method: "POST",
      body: { baseVersion, ops },
      timeoutMs: 60_000,
      account,
    }),
  aiChat: async (messages: AiChatMessage[], mode: "auto" | "fast" | "reasoning", today: IsoDate): Promise<AiChatResponse> =>
    (await request("/api/ai/chat", aiChatSchema, {
      method: "POST",
      body: { messages, mode, today },
      timeoutMs: 200_000,
    })) as AiChatResponse,
  updateName: (name: string) => request("/api/account", userResponseSchema, { method: "PATCH", body: { name } }),
  changePassword: (currentPassword: string, newPassword: string) =>
    request("/api/account/password", okSchema, { method: "POST", body: { currentPassword, newPassword } }),
  deleteAccount: (password: string) => request("/api/account", okSchema, { method: "DELETE", body: { password } }),
  smsKeyStatus: () => request("/api/account/sms-key", smsKeyStatusSchema),
  createSmsKey: () => request("/api/account/sms-key", smsKeyCreatedSchema, { method: "POST" }),
  deleteSmsKey: () => request("/api/account/sms-key", okSchema, { method: "DELETE" }),
};
