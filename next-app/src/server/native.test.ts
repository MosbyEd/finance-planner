import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { todayLocal } from "@/domain/dates";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as loginRoute } from "@/app/api/auth/login/route";
import { POST as logout } from "@/app/api/auth/logout/route";
import { GET as me } from "@/app/api/me/route";
import { GET as getState, OPTIONS as stateOptions } from "@/app/api/state/route";
import { POST as postActions } from "@/app/api/state/actions/route";
import { closeDb, getDb } from "./db";
import { clearRateLimits } from "./rateLimit";
import { clearStateCache } from "./stateStore";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-native-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");
delete process.env.CORS_ORIGINS;

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clearRateLimits();
  clearStateCache();
  getDb().exec("DELETE FROM users; DELETE FROM sessions; DELETE FROM states;");
});

/** Так ходит iOS-приложение: интерфейс открыт с capacitor://localhost, запросы к серверу — с другого источника. */
const APP_HEADERS = { origin: "capacitor://localhost", "sec-fetch-site": "cross-site", "x-client": "native" };

function request(url: string, init: { method?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost:3001${url}`, {
    method: init.method ?? "GET",
    headers: { "content-type": "application/json", host: "localhost:3001", ...init.headers },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

const addIncome = (id: string) => ({
  opId: `op-${id}-0001`,
  action: {
    type: "tx.add",
    tx: { id, type: "income", amount: 100_000, date: todayLocal(), category: "Премия", title: "", note: "", mandatory: false, autoSaving: false },
  },
});

async function appSignUp(): Promise<string> {
  const res = await register(
    request("/api/auth/register", { method: "POST", headers: APP_HEADERS, body: { login: "anna", password: "correct horse" } }),
  );
  expect(res.status).toBe(201);
  const body = await res.json();
  expect(typeof body.token).toBe("string");
  return body.token as string;
}

describe("iOS-приложение: вход по токену и CORS", () => {
  it("вход приложения возвращает токен и не ставит cookie, веб-вход токен не возвращает", async () => {
    await appSignUp();
    const app = await loginRoute(
      request("/api/auth/login", { method: "POST", headers: APP_HEADERS, body: { login: "anna", password: "correct horse" } }),
    );
    expect(app.status).toBe(200);
    expect(app.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(app.headers.get("set-cookie")).toBeNull();
    expect(typeof (await app.json()).token).toBe("string");

    const web = await loginRoute(
      request("/api/auth/login", {
        method: "POST",
        headers: { origin: "http://localhost:3001" },
        body: { login: "anna", password: "correct horse" },
      }),
    );
    expect((await web.json()).token).toBeUndefined();
    expect(web.headers.get("set-cookie")).toContain("fp_session=");
  });

  it("с токеном можно читать и менять данные, после выхода токен недействителен", async () => {
    const token = await appSignUp();
    const auth = { ...APP_HEADERS, authorization: `Bearer ${token}` };

    const meRes = await me(request("/api/me", { headers: auth }));
    expect((await meRes.json()).user).toEqual({ login: "anna", name: null });

    const post = await postActions(
      request("/api/state/actions", { method: "POST", headers: auth, body: { baseVersion: 0, ops: [addIncome("app-tx")] } }),
    );
    expect(post.status).toBe(200);
    expect(post.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");

    const state = await getState(request("/api/state", { headers: auth }));
    expect((await state.json()).state.transactions).toHaveLength(1);

    await logout(request("/api/auth/logout", { method: "POST", headers: auth }));
    expect((await getState(request("/api/state", { headers: auth }))).status).toBe(401);
  });

  it("предварительный запрос CORS разрешён только приложению", async () => {
    const ok = await stateOptions(request("/api/state", { method: "OPTIONS", headers: { origin: "capacitor://localhost" } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
    expect(ok.headers.get("access-control-allow-headers")).toContain("Authorization");
    const evil = await stateOptions(request("/api/state", { method: "OPTIONS", headers: { origin: "https://evil.example" } }));
    expect(evil.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("чужой сайт по-прежнему не может менять данные через cookie", async () => {
    const web = await register(
      request("/api/auth/register", {
        method: "POST",
        headers: { origin: "http://localhost:3001" },
        body: { login: "boris", password: "correct horse" },
      }),
    );
    const cookie = /fp_session=[^;]*/.exec(web.headers.get("set-cookie") ?? "")?.[0] ?? "";
    const res = await postActions(
      request("/api/state/actions", {
        method: "POST",
        headers: { cookie, origin: "https://evil.example", "sec-fetch-site": "cross-site" },
        body: { baseVersion: 0, ops: [addIncome("evil")] },
      }),
    );
    expect(res.status).toBe(403);
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
  });

  it("поддельный токен не принимается", async () => {
    await appSignUp();
    const res = await getState(request("/api/state", { headers: { ...APP_HEADERS, authorization: `Bearer ${"x".repeat(43)}` } }));
    expect(res.status).toBe(401);
  });
});
