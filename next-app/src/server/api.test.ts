import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { addDays, todayLocal } from "@/domain/dates";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/me/route";
import { GET as getState } from "@/app/api/state/route";
import { POST as postActions } from "@/app/api/state/actions/route";
import { POST as aiChat } from "@/app/api/ai/chat/route";
import { GET as aiReports } from "@/app/api/ai/reports/route";
import { DELETE as deleteAccount } from "@/app/api/account/route";
import { POST as changePassword } from "@/app/api/account/password/route";
import { emptyState } from "@/domain/defaults";
import type { IsoDate } from "@/domain/dates";
import { stateWith, template, tx } from "@/domain/test-utils";
import { hashPassword, verifyPassword } from "./auth";
import { closeDb, getDb } from "./db";
import { AiProviderError, deepseekChat, type AiUsage } from "./deepseek";
import { clearRateLimits } from "./rateLimit";
import { clearStateCache, writeState } from "./stateStore";

// Внешний AI не вызываем: ответ провайдера подменён.
vi.mock("./deepseek", async (importOriginal) => {
  const original = await importOriginal<typeof import("./deepseek")>();
  return { ...original, deepseekChat: vi.fn(async () => ({ text: "Ответ", reasoning: null, model: "test", usage: null })) };
});

// Проверка пароля несуществующего пользователя (фиктивный bcrypt) в тестах мгновенная — считаем вызовы.
vi.mock("./auth", async (importOriginal) => {
  const original = await importOriginal<typeof import("./auth")>();
  return {
    ...original,
    verifyPassword: vi.fn(async (password: string, hash: string | null) =>
      hash === null ? false : original.verifyPassword(password, hash),
    ),
  };
});

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");
delete process.env.DEEPSEEK_API_KEY;

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

const savedEnv = {
  TRUST_PROXY: process.env.TRUST_PROXY,
  TRUST_PROXY_HEADER: process.env.TRUST_PROXY_HEADER,
  DEEPSEEK_API_KEY: process.env.DEEPSEEK_API_KEY,
};

beforeEach(() => {
  clearRateLimits();
  clearStateCache();
  getDb().exec("DELETE FROM users; DELETE FROM sessions; DELETE FROM states;");
});

afterEach(() => {
  vi.useRealTimers();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

type Opts = { method?: string; body?: unknown; cookie?: string; headers?: Record<string, string> };

function request(url: string, { method = "GET", body, cookie, headers = {} }: Opts = {}): NextRequest {
  return new NextRequest(`http://localhost:3001${url}`, {
    method,
    headers: {
      "content-type": "application/json",
      host: "localhost:3001",
      origin: "http://localhost:3001",
      ...(cookie ? { cookie } : {}),
      ...headers,
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function sessionCookie(res: Response): string {
  const header = res.headers.get("set-cookie") ?? "";
  const match = /fp_session=([^;]*)/.exec(header);
  if (!match) throw new Error("нет cookie сессии");
  return `fp_session=${match[1]}`;
}

async function signUp(loginName = "anna", password = "correct horse") {
  const res = await register(request("/api/auth/register", { method: "POST", body: { login: loginName, password } }));
  expect(res.status).toBe(201);
  return sessionCookie(res);
}

let opCounter = 0;
/** opId в формате сервера: 8–40 символов [A-Za-z0-9_-]. */
const nextOpId = () => `op-${String(++opCounter).padStart(8, "0")}`;
/** Тело запроса изменений: каждое действие — отдельное изменение со своим opId. */
function opsBody(baseVersion: number, ...actions: unknown[]) {
  return { baseVersion, ops: actions.map((action) => ({ opId: nextOpId(), action })) };
}

function postOps(cookie: string, body: unknown, headers: Record<string, string> = {}) {
  return postActions(request("/api/state/actions", { method: "POST", cookie, body, headers }));
}

function loginAs(login: string, password: string, headers: Record<string, string> = {}) {
  return loginRoute(request("/api/auth/login", { method: "POST", body: { login, password }, headers }));
}

const today = todayLocal();
const addIncome = (id: string) => ({
  type: "tx.add",
  tx: { id, type: "income", amount: 100_000, date: today, category: "Премия", title: "", note: "", mandatory: false, autoSaving: false },
});

describe("авторизация", () => {
  it("регистрация сразу входит, сессия — случайный токен, а не логин", async () => {
    const cookie = await signUp();
    expect(cookie).not.toContain("anna");
    expect(cookie.length).toBeGreaterThan(40);
    const res = await me(request("/api/me", { cookie }));
    expect((await res.json()).user).toEqual({ login: "anna", name: null });
  });

  it("поддельная cookie с логином не даёт доступа", async () => {
    await signUp();
    const res = await getState(request("/api/state", { cookie: "fp_session=anna" }));
    expect(res.status).toBe(401);
  });

  it("логин без учёта регистра, неверный пароль — 401, повторная регистрация — 409", async () => {
    await signUp();
    const ok = await loginAs("ANNA", "correct horse");
    expect(ok.status).toBe(200);
    const bad = await loginAs("anna", "wrong");
    expect(bad.status).toBe(401);
    const dup = await register(request("/api/auth/register", { method: "POST", body: { login: "Anna", password: "12345678" } }));
    expect(dup.status).toBe(409);
  });

  it("короткий пароль и странный логин отклоняются", async () => {
    const res = await register(request("/api/auth/register", { method: "POST", body: { login: "a b", password: "1" } }));
    expect(res.status).toBe(400);
  });

  it("перебор паролей ограничен", async () => {
    await signUp();
    let last = 0;
    for (let i = 0; i < 11; i++) {
      last = (await loginAs("anna", `x${i}`)).status;
    }
    expect(last).toBe(429);
  }, 30_000);

  it("выход завершает сессию на сервере", async () => {
    const cookie = await signUp();
    await logout(request("/api/auth/logout", { method: "POST", cookie }));
    expect((await getState(request("/api/state", { cookie }))).status).toBe(401);
  });

  it("смена пароля завершает другие сессии, но не текущую", async () => {
    const first = await signUp();
    const second = sessionCookie(
      await loginAs("anna", "correct horse"),
    );
    const res = await changePassword(
      request("/api/account/password", {
        method: "POST",
        cookie: first,
        body: { currentPassword: "correct horse", newPassword: "battery staple" },
      }),
    );
    expect(res.status).toBe(200);
    expect((await getState(request("/api/state", { cookie: first }))).status).toBe(200);
    expect((await getState(request("/api/state", { cookie: second }))).status).toBe(401);
  });

  it("удаление аккаунта требует пароль и удаляет данные", async () => {
    const cookie = await signUp();
    await postOps(cookie, opsBody(0, addIncome("a")));
    const wrong = await deleteAccount(request("/api/account", { method: "DELETE", cookie, body: { password: "nope" } }));
    expect(wrong.status).toBe(403);
    const ok = await deleteAccount(request("/api/account", { method: "DELETE", cookie, body: { password: "correct horse" } }));
    expect(ok.status).toBe(200);
    expect(getDb().prepare("SELECT COUNT(*) AS n FROM states").get()).toEqual({ n: 0 });
  });
});

describe("состояние", () => {
  it("новый пользователь получает пустое состояние и может сразу добавлять операции", async () => {
    const cookie = await signUp();
    const initial = await (await getState(request("/api/state", { cookie }))).json();
    expect(initial.version).toBe(0);
    expect(initial.state.transactions).toEqual([]);

    const res = await postOps(cookie, opsBody(0, addIncome("a")));
    expect(await res.json()).toEqual({ version: 1, stale: false });
    const after = await (await getState(request("/api/state", { cookie }))).json();
    expect(after.state.transactions).toHaveLength(1);
  });

  it("сообщает, что данные менялись с другого устройства", async () => {
    const cookie = await signUp();
    await postOps(cookie, opsBody(0, addIncome("a")));
    const res = await postOps(cookie, opsBody(0, addIncome("b")));
    expect(await res.json()).toEqual({ version: 2, stale: true });
  });

  it("пачка применяется атомарно: ошибка в одном действии откатывает все", async () => {
    const cookie = await signUp();
    const res = await postOps(cookie, opsBody(0, addIncome("a"), { type: "tx.delete", id: "missing" }));
    expect(res.status).toBe(422);
    expect((await res.json()).actionIndex).toBe(1);
    const after = await (await getState(request("/api/state", { cookie }))).json();
    expect(after.version).toBe(0);
  });

  it("некорректные действия отклоняются схемой", async () => {
    const cookie = await signUp();
    const res = await postOps(cookie, opsBody(0, { type: "tx.add", tx: { id: "x", type: "income", amount: "много" } }));
    expect(res.status).toBe(400);
    // Старый формат ({ actions }) больше не принимается.
    const legacy = await postOps(cookie, { baseVersion: 0, actions: [addIncome("a")] });
    expect(legacy.status).toBe(400);
  });

  it("дата из будущего в recurring.sync отклоняется", async () => {
    const cookie = await signUp();
    const res = await postOps(cookie, opsBody(0, { type: "recurring.sync", today: "2099-01-01" }));
    expect(res.status).toBe(422);
  });

  it("офлайн-изменения с прошедшей датой принимаются (M3)", async () => {
    const cookie = await signUp();
    const res = await postOps(cookie, opsBody(0, addIncome("a"), { type: "recurring.sync", today: addDays(today, -3) }));
    expect(res.status).toBe(200);
  });

  it("повторная отправка того же opId не применяется второй раз", async () => {
    const cookie = await signUp();
    const body = opsBody(0, addIncome("a"));
    expect(await (await postOps(cookie, body)).json()).toEqual({ version: 1, stale: false });
    // Ответ потерялся — клиент отправляет ту же пачку ещё раз.
    const again = await postOps(cookie, { ...body, baseVersion: 1 });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ version: 1, stale: true });
    const after = await (await getState(request("/api/state", { cookie }))).json();
    expect(after.state.transactions).toHaveLength(1);
    expect(after.version).toBe(1);
  });

  it("частота запросов изменений ограничена (H1)", async () => {
    const cookie = await signUp();
    const body = opsBody(0, addIncome("a"));
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) statuses.push((await postOps(cookie, body)).status);
    expect(statuses.slice(0, 120).every((s) => s === 200)).toBe(true);
    expect(statuses[120]).toBe(429);
  });

  it("повреждённые данные в базе — понятная ошибка (L10)", async () => {
    const cookie = await signUp();
    await postOps(cookie, opsBody(0, addIncome("a")));
    getDb().exec(`UPDATE states SET state_json = '{"schemaVersion":3}'`);
    const res = await getState(request("/api/state", { cookie }));
    expect(res.status).toBe(423);
    expect((await res.json()).error).toMatch(/повреждены/);
    expect((await postOps(cookie, opsBody(1, addIncome("b")))).status).toBe(423);
  });

  it("запросы с чужого сайта отклоняются", async () => {
    const cookie = await signUp();
    const res = await postActions(
      request("/api/state/actions", {
        method: "POST",
        cookie,
        headers: { origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: opsBody(0, addIncome("a")),
      }),
    );
    expect(res.status).toBe(403);
  });

  it("пользователи изолированы друг от друга", async () => {
    const anna = await signUp("anna");
    const boris = await signUp("boris");
    await postOps(anna, opsBody(0, addIncome("a")));
    const borisState = await (await getState(request("/api/state", { cookie: boris }))).json();
    expect(borisState.state.transactions).toEqual([]);
  });
});

describe("AI", () => {
  it("недоступен без входа и без ключа", async () => {
    const body = { messages: [{ role: "user", content: "привет" }], mode: "fast", today };
    expect((await aiChat(request("/api/ai/chat", { method: "POST", body }))).status).toBe(401);
    const cookie = await signUp();
    expect((await aiChat(request("/api/ai/chat", { method: "POST", cookie, body }))).status).toBe(503);
  });

  const usage = (over: Partial<AiUsage> = {}): AiUsage => ({
    model: "deepseek-flash",
    mode: "fast",
    promptTokens: 9000,
    cacheHitTokens: 6400,
    cacheMissTokens: 2600,
    completionTokens: 120,
    reasoningTokens: null,
    ...over,
  });
  const usageRows = () =>
    getDb().prepare("SELECT u.login, a.kind, a.mode, a.model, a.prompt_tokens, a.completion_tokens FROM ai_usage a JOIN users u ON u.id = a.user_id ORDER BY a.id").all();

  it("каждый ответ записывает расход токенов: кто, вид запроса, режим — без текста вопроса", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    getDb().exec("DELETE FROM ai_usage");
    const cookie = await signUp("anna");
    vi.mocked(deepseekChat).mockResolvedValueOnce({ text: "Ответ", reasoning: null, model: "deepseek-flash", usage: usage() });
    const body = { messages: [{ role: "user", content: "Сколько ушло на такси?" }], mode: "fast", today };
    expect((await aiChat(request("/api/ai/chat", { method: "POST", cookie, body }))).status).toBe(200);
    expect(usageRows()).toEqual([{ login: "anna", kind: "chat", mode: "fast", model: "deepseek-flash", prompt_tokens: 9000, completion_tokens: 120 }]);
    expect(JSON.stringify(getDb().prepare("SELECT * FROM ai_usage").all())).not.toContain("такси");
  });

  it("пустой ответ тоже стоит денег; при таймауте модели с рассуждением записывается быстрая", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    getDb().exec("DELETE FROM ai_usage");
    const cookie = await signUp("anna");
    const body = { messages: [{ role: "user", content: "Посоветуй, как накопить на отпуск" }], mode: "auto", today };
    vi.mocked(deepseekChat).mockRejectedValueOnce(new AiProviderError("AI вернул пустой ответ.", 502, usage({ mode: "reasoning", completionTokens: 0 })));
    expect((await aiChat(request("/api/ai/chat", { method: "POST", cookie, body }))).status).toBe(502);
    vi.mocked(deepseekChat)
      .mockRejectedValueOnce(new AiProviderError("AI не ответил вовремя.", 504))
      .mockResolvedValueOnce({ text: "Ответ", reasoning: null, model: "deepseek-flash", usage: usage({ completionTokens: 300 }) });
    expect((await aiChat(request("/api/ai/chat", { method: "POST", cookie, body }))).status).toBe(200);
    expect(usageRows()).toEqual([
      { login: "anna", kind: "chat", mode: "reasoning", model: "deepseek-flash", prompt_tokens: 9000, completion_tokens: 0 },
      { login: "anna", kind: "chat", mode: "fast", model: "deepseek-flash", prompt_tokens: 9000, completion_tokens: 300 },
    ]);
  });
});

describe("ревью: логины и ограничители частоты", () => {
  // Наш прокси дописывает адрес клиента в конец X-Forwarded-For.
  const ipHeaders = (ip: string) => ({ "x-forwarded-for": ip });

  it("кириллица в логине без учёта регистра (L3)", async () => {
    await signUp("Аня");
    const dup = await register(request("/api/auth/register", { method: "POST", body: { login: "аня", password: "12345678" } }));
    expect(dup.status).toBe(409);
    const ok = await loginAs("АНЯ", "correct horse");
    expect(ok.status).toBe(200);
    expect((await ok.json()).user.login).toBe("Аня");
  });

  it("старые аккаунты, различающиеся регистром кириллицы, входят по точному написанию (L3)", async () => {
    await signUp("Аня");
    getDb()
      .prepare("INSERT INTO users (login, login_key, password_hash, created_at) VALUES ('аня', 'аня#legacy', ?, 0)")
      .run(await hashPassword("second password"));
    const second = await loginAs("аня", "second password");
    expect(second.status).toBe(200);
    expect((await second.json()).user.login).toBe("аня");
    expect((await loginAs("АНЯ", "correct horse")).status).toBe(200);
  });

  it("перебор с чужого адреса не запирает владельца (L1)", async () => {
    process.env.TRUST_PROXY = "true";
    await signUp("victim", "victim-pass");
    for (let i = 0; i < 10; i++) expect((await loginAs("victim", `wrong${i}`, ipHeaders("6.6.6.6"))).status).toBe(401);
    // Дальше этот адрес упирается в предел и не расходует общий счётчик логина.
    for (let i = 0; i < 45; i++) expect((await loginAs("victim", `more${i}`, ipHeaders("6.6.6.6"))).status).toBe(429);
    expect((await loginAs("victim", "victim-pass", ipHeaders("8.8.8.8"))).status).toBe(200);
  }, 30_000);

  it("подбор пароля через удаление аккаунта ограничен (L2)", async () => {
    const cookie = await signUp();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) {
      statuses.push((await deleteAccount(request("/api/account", { method: "DELETE", cookie, body: { password: `guess${i}` } }))).status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 403)).toBe(true);
    expect(statuses[10]).toBe(429);
  }, 30_000);

  it("подделанный X-Forwarded-For не обходит предел регистраций, общий предел — 20 в час (M6)", async () => {
    const signUpFrom = (i: number, headers: Record<string, string>) =>
      register(request("/api/auth/register", { method: "POST", body: { login: `bot${i}`, password: "password123" }, headers }));
    // Без доверенного прокси заголовок игнорируется: все запросы — с одного «адреса».
    for (let i = 0; i < 10; i++) expect((await signUpFrom(i, { "x-forwarded-for": `5.5.5.${i}` })).status).toBe(201);
    expect((await signUpFrom(10, { "x-forwarded-for": "5.5.5.10" })).status).toBe(429);

    clearRateLimits();
    process.env.TRUST_PROXY = "true";
    for (let i = 20; i < 40; i++) expect((await signUpFrom(i, ipHeaders(`7.7.7.${i}`))).status).toBe(201);
    expect((await signUpFrom(40, ipHeaders("7.7.7.40"))).status).toBe(429);
  }, 60_000);

  it("общий предел запросов к AI — 200 в час (M6)", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    const body = { messages: [{ role: "user", content: "привет" }], mode: "fast", today };
    const cookies: string[] = [];
    for (let u = 0; u < 7; u++) cookies.push(await signUp(`user${u}`));
    const statuses: number[] = [];
    for (let i = 0; i < 201; i++) {
      // По 30 запросов на пользователя — в пределах личного лимита.
      const cookie = cookies[Math.floor(i / 30)];
      statuses.push((await aiChat(request("/api/ai/chat", { method: "POST", cookie, body }))).status);
    }
    expect(statuses.slice(0, 200).every((s) => s === 200)).toBe(true);
    expect(statuses[200]).toBe(429);
  }, 60_000);
});

describe("ревью 2: пачки изменений и нагрузка", () => {
  const sync = { type: "recurring.sync", today };

  it("opId — 8–40 символов [A-Za-z0-9_-], в пачке не больше 100 изменений (H1)", async () => {
    const cookie = await signUp();
    const post = (opId: string) => postOps(cookie, { baseVersion: 0, ops: [{ opId, action: addIncome(`i${opId}`) }] });
    expect((await post("short")).status).toBe(400);
    expect((await post("x".repeat(41))).status).toBe(400);
    expect((await post("has.dot.inside")).status).toBe(400);
    // Так генерирует id клиент: 16 символов [0-9a-z].
    expect((await post("0123456789abcdef")).status).toBe(200);
    expect((await postOps(cookie, opsBody(1, ...Array.from({ length: 101 }, () => sync)))).status).toBe(400);
    expect((await postOps(cookie, opsBody(1, ...Array.from({ length: 100 }, () => sync)))).status).toBe(200);
  });

  it("загрузка состояния ограничена 60 в минуту на пользователя (H2)", async () => {
    const cookie = await signUp();
    const statuses: number[] = [];
    for (let i = 0; i < 61; i++) statuses.push((await getState(request("/api/state", { cookie }))).status);
    expect(statuses.slice(0, 60).every((s) => s === 200)).toBe(true);
    expect(statuses[60]).toBe(429);
    // Другой пользователь не затронут.
    const other = await signUp("boris");
    expect((await getState(request("/api/state", { cookie: other }))).status).toBe(200);
  });

  it("изменений — не больше 1500 в минуту на пользователя, считая каждое в пачке (H2)", async () => {
    const cookie = await signUp();
    const statuses: number[] = [];
    for (let i = 0; i < 16; i++) {
      statuses.push((await postOps(cookie, opsBody(0, ...Array.from({ length: 100 }, () => sync)))).status);
    }
    expect(statuses.slice(0, 15).every((s) => s === 200)).toBe(true);
    const res = await postOps(cookie, opsBody(0, sync));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("повреждённое состояние можно заменить импортом, идущим первым в пачке (M2)", async () => {
    const cookie = await signUp();
    await postOps(cookie, opsBody(0, addIncome("a")));
    getDb().exec(`UPDATE states SET state_json = '{"schemaVersion":3}'`);
    expect((await postOps(cookie, opsBody(1, addIncome("b")))).status).toBe(423);
    const imported = { ...emptyState(), profile: { ...emptyState().profile, notes: "из файла" } };
    const res = await postOps(cookie, opsBody(1, { type: "state.import", state: imported }, addIncome("c")));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ version: 2, stale: false });
    const after = await (await getState(request("/api/state", { cookie }))).json();
    expect(after.state.profile.notes).toBe("из файла");
    expect(after.state.transactions.map((t: { id: string }) => t.id)).toEqual(["c"]);
  });
});

describe("ревью 2: вход", () => {
  it("попытки с несуществующими логинами не тратят bcrypt сверх 60 в минуту (M1)", async () => {
    const dummyChecks = () => vi.mocked(verifyPassword).mock.calls.filter(([, hash]) => hash === null).length;
    const before = dummyChecks();
    const statuses: number[] = [];
    for (let i = 0; i < 65; i++) statuses.push((await loginAs(`ghost${i}`, "whatever")).status);
    // Ответ одинаковый, но фиктивная проверка выполнена только 60 раз.
    expect(statuses.every((s) => s === 401)).toBe(true);
    expect(dummyChecks() - before).toBe(60);
    // Существующий пользователь входит как обычно.
    await signUp("real", "real-password");
    expect((await loginAs("real", "real-password")).status).toBe(200);
  }, 30_000);

  it("без доверенного прокси перебор не запирает владельца: после 10 попыток — одна в 20 секунд (M6)", async () => {
    await signUp("victim", "victim-pass");
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    for (let i = 0; i < 10; i++) expect((await loginAs("victim", `wrong${i}`)).status).toBe(401);
    const blocked = await loginAs("victim", "wrong-again");
    expect(blocked.status).toBe(429);
    expect(Number(blocked.headers.get("retry-after"))).toBeLessThanOrEqual(20);
    // Подождав, владелец входит (раньше — блокировка на 15 минут).
    vi.setSystemTime(start + 21_000);
    expect((await loginAs("victim", "victim-pass")).status).toBe(200);
  }, 30_000);

  it("замедление: одна попытка в 20 секунд, а не блокировка; общий предел логина сохраняется (M6)", async () => {
    await signUp("victim", "victim-pass");
    vi.useFakeTimers({ toFake: ["Date"] });
    let now = Date.now();
    for (let i = 0; i < 10; i++) await loginAs("victim", `wrong${i}`);
    now += 20_000;
    vi.setSystemTime(now);
    expect((await loginAs("victim", "slow1")).status).toBe(401);
    expect((await loginAs("victim", "slow2")).status).toBe(429);
    now += 20_000;
    vi.setSystemTime(now);
    expect((await loginAs("victim", "slow3")).status).toBe(401);
  }, 30_000);

  it("с TRUST_PROXY берётся последний адрес X-Forwarded-For, X-Real-IP — только с TRUST_PROXY_HEADER (M6)", async () => {
    process.env.TRUST_PROXY = "true";
    await signUp("victim", "victim-pass");
    // Подставленный клиентом X-Real-IP не меняет адрес: все 11 попыток — с одного адреса прокси.
    for (let i = 0; i < 10; i++) {
      expect((await loginAs("victim", `w${i}`, { "x-real-ip": `1.1.1.${i}`, "x-forwarded-for": "6.6.6.6" })).status).toBe(401);
    }
    expect((await loginAs("victim", "w10", { "x-real-ip": "1.1.1.99", "x-forwarded-for": "6.6.6.6" })).status).toBe(429);
    // Другой адрес (последний в списке) не заперт.
    expect((await loginAs("victim", "victim-pass", { "x-forwarded-for": "6.6.6.6, 8.8.8.8" })).status).toBe(200);
  }, 30_000);
});

describe("вход в другой аккаунт в соседней вкладке (X-Account)", () => {
  const account = (login: string) => ({ "x-account": encodeURIComponent(login) });

  it("совпадающий аккаунт (без учёта регистра, кириллица) — обычный ответ; без заголовка — как раньше", async () => {
    const cookie = await signUp("Аня");
    expect((await getState(request("/api/state", { cookie, headers: account("аня") }))).status).toBe(200);
    expect((await getState(request("/api/state", { cookie }))).status).toBe(200);
    expect((await postOps(cookie, opsBody(0, addIncome("a")), account("Аня"))).status).toBe(200);
  });

  it("другой аккаунт или испорченный заголовок — 409 account-mismatch, ничего не применяется", async () => {
    const cookie = await signUp("anna");
    const res = await getState(request("/api/state", { cookie, headers: account("boris") }));
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      error: "Вы вошли в другой аккаунт в соседней вкладке. Обновите страницу.",
      code: "account-mismatch",
    });
    expect((await postOps(cookie, opsBody(0, addIncome("a")), account("boris"))).status).toBe(409);
    expect((await postOps(cookie, opsBody(0, addIncome("a")), { "x-account": "%E0%A4%A" })).status).toBe(409);
    const after = await (await getState(request("/api/state", { cookie }))).json();
    expect(after.version).toBe(0);
    const body = { messages: [{ role: "user", content: "привет" }], mode: "fast", today };
    const ai = await aiChat(request("/api/ai/chat", { method: "POST", cookie, body, headers: account("boris") }));
    expect(ai.status).toBe(409);
  });
});

describe("анализ трат от AI", () => {
  /** Учёт с 10 октября, зарплата 10-го, аванс 25-го; траты — в 22 днях октября. */
  function seed(login: string) {
    const s = stateWith();
    s.templates = [
      template({ id: "salary", kind: "income", amount: 10_000_000, dayOfMonth: 10, startDate: "2026-11-10" }),
      template({ id: "advance", kind: "income", title: "Аванс", category: "Аванс", amount: 5_000_000, dayOfMonth: 25, startDate: "2026-10-25" }),
    ];
    s.transactions = [tx({ type: "adjustment", amount: 7_777_700, date: "2026-10-10", category: "" })];
    for (let d = 10; d <= 31; d++) {
      const date: IsoDate = `2026-10-${d}`;
      s.transactions.push(tx({ type: "expense", amount: 150_000, date, category: "Такси", title: "Яндекс Такси", note: "Покупка 1500р Баланс 12345,67р" }));
    }
    const user = getDb().prepare("SELECT id FROM users WHERE login = ?").get(login) as { id: number };
    writeState(user.id, s, 1);
  }

  const analysis = (kind: "analysis" | "period", day: IsoDate, auto = false) => ({ analysis: { kind, auto }, mode: "auto", today: day });

  it("до 10 ноября закрыт: ручной разбор — 409 с причиной, автоматические итоги — тихо, без модели", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 9, 12) });
    const cookie = await signUp();
    seed("anna");
    vi.mocked(deepseekChat).mockClear();
    const manual = await aiChat(request("/api/ai/chat", { method: "POST", cookie, body: analysis("analysis", "2026-11-09") }));
    expect(manual.status).toBe(409);
    expect((await manual.json()).error).toBe("Откроется после зарплаты 10 ноября · дней с тратами уже 22");
    const auto = await aiChat(request("/api/ai/chat", { method: "POST", cookie, body: analysis("period", "2026-11-09", true) }));
    expect(await auto.json()).toMatchObject({ silent: true, report: null });
    expect(deepseekChat).not.toHaveBeenCalled();
  });

  it("10 ноября: итоги периода — моделью с рассуждением, один раз; в модель — без СМС и остатков", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 10, 12) });
    const cookie = await signUp();
    seed("anna");
    vi.mocked(deepseekChat).mockClear();
    vi.mocked(deepseekChat).mockResolvedValueOnce({
      text: JSON.stringify({ summary: "За период ушло 10 500 ₽ — почти всё на такси. Остальное в норме.", changes: [], steps: [{ title: "Такси реже", target: "Такси", cutPercent: 30, why: "" }] }),
      reasoning: null,
      model: "deepseek-reasoner",
      usage: { model: "deepseek-flash", mode: "reasoning", promptTokens: 3000, cacheHitTokens: 0, cacheMissTokens: 3000, completionTokens: 900, reasoningTokens: 700 },
    });
    const first = await aiChat(request("/api/ai/chat", { method: "POST", cookie, body: analysis("period", "2026-11-10", true) }));
    expect(first.status).toBe(200);
    const body = await first.json();
    // Числа — с неразрывными пробелами: в уведомлении и на экране сумма не рвётся на строки.
    expect(body.text).toBe("За период ушло 10\u00a0500\u00a0₽ — почти всё на такси.");
    expect(body.silent).toBeUndefined();
    expect(body.report).toMatchObject({ kind: "period", from: "2026-10-25", to: "2026-11-09" });
    expect(body.report.steps[0].effectPerDay).toBeGreaterThan(0);

    const [, mode, messages] = vi.mocked(deepseekChat).mock.calls[0];
    expect(mode).toBe("reasoning");
    const prompt = JSON.stringify(messages);
    expect(prompt).toContain("Такси");
    expect(prompt).not.toMatch(/12345|Баланс|77777/);

    // Второй раз (другое устройство, повтор) — готовые итоги, без модели и без уведомления.
    const again = await aiChat(request("/api/ai/chat", { method: "POST", cookie, body: analysis("period", "2026-11-10", true) }));
    expect(await again.json()).toMatchObject({ cached: true, silent: true, report: { from: "2026-10-25" } });
    expect(deepseekChat).toHaveBeenCalledTimes(1);
    // Расход записан один раз — с видом «итоги периода».
    expect(getDb().prepare("SELECT kind, mode, reasoning_tokens FROM ai_usage WHERE user_id = (SELECT id FROM users WHERE login = 'anna')").all()).toEqual([
      { kind: "period", mode: "reasoning", reasoning_tokens: 700 },
    ]);

    const list = await (await aiReports(request("/api/ai/reports", { cookie }))).json();
    expect(list.reports).toHaveLength(1);
    expect(list.reports[0]).toMatchObject({ kind: "period", summary: expect.stringContaining("такси") });
  });

  it("разбор — по двум полным периодам; чужие разборы не видны", async () => {
    process.env.DEEPSEEK_API_KEY = "test-key";
    vi.useFakeTimers({ toFake: ["Date"], now: new Date(2026, 10, 10, 12) });
    const anna = await signUp("anna");
    const boris = await signUp("boris");
    seed("anna");
    vi.mocked(deepseekChat).mockResolvedValueOnce({ text: "Не JSON, а просто текст.", reasoning: null, model: "deepseek-reasoner", usage: null });
    const res = await aiChat(request("/api/ai/chat", { method: "POST", cookie: anna, body: analysis("analysis", "2026-11-10") }));
    expect((await res.json()).report).toMatchObject({ kind: "analysis", from: "2026-10-10", to: "2026-11-09", summary: "Не JSON, а просто текст." });
    expect((await (await aiReports(request("/api/ai/reports", { cookie: boris }))).json()).reports).toEqual([]);
    expect((await aiReports(request("/api/ai/reports"))).status).toBe(401);
  });
});
