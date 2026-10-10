import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { POST as quickAdd } from "@/app/api/shortcuts/add/route";
import { GET as today } from "@/app/api/shortcuts/today/route";
import { GET as getState } from "@/app/api/state/route";
import { todayBudgetText } from "@/domain/shortcuts";
import { stateWith, tx } from "@/domain/test-utils";
import { closeDb, getDb } from "./db";
import { clearRateLimits } from "./rateLimit";
import { clearStateCache } from "./stateStore";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-shortcuts-test-"));
process.env.DATABASE_PATH = path.join(dir, "test.sqlite");

afterAll(() => {
  closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  clearRateLimits();
  clearStateCache();
  getDb().exec("DELETE FROM users; DELETE FROM sessions; DELETE FROM states; DELETE FROM applied_ops;");
});

/** Так ходят команды приложения: только токен, без Origin и cookie. */
function request(url: string, token: string, body?: unknown) {
  return new NextRequest(`http://localhost:3001${url}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost:3001", authorization: `Bearer ${token}`, "content-type": "application/json", "x-client": "native" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signUp(): Promise<string> {
  const res = await register(
    new NextRequest("http://localhost:3001/api/auth/register", {
      method: "POST",
      headers: { host: "localhost:3001", "content-type": "application/json", "x-client": "native", origin: "capacitor://localhost" },
      body: JSON.stringify({ login: "anna", password: "correct horse" }),
    }),
  );
  return (await res.json()).token as string;
}

describe("команды приложения", () => {
  it("«Добавить операцию»: категория по названию, отметка «на проверку»", async () => {
    const token = await signUp();
    const res = await quickAdd(request("/api/shortcuts/add", token, { type: "expense", amount: 35_000, title: "Перекрёсток" }));
    expect(res.status).toBe(200);
    expect((await res.json()).message.replace(/\s/g, " ")).toBe("Расход 350 ₽ · Перекрёсток → Продукты");
    const state = (await (await getState(request("/api/state", token))).json()).state;
    expect(state.transactions).toEqual([
      expect.objectContaining({ type: "expense", amount: 35_000, category: "Продукты", title: "Перекрёсток", review: true }),
      expect.objectContaining({ type: "saving" }),
    ]);
  });

  it("явная категория важнее подсказки; без входа — 401", async () => {
    const token = await signUp();
    const res = await quickAdd(request("/api/shortcuts/add", token, { type: "expense", amount: 10_000, title: "Перекрёсток", category: "Подарки" }));
    expect((await res.json()).message).toMatch(/→ Подарки$/);
    expect((await quickAdd(request("/api/shortcuts/add", "x".repeat(43), { type: "expense", amount: 1 }))).status).toBe(401);
  });

  it("«Сколько можно потратить сегодня» отвечает готовой фразой", async () => {
    const token = await signUp();
    const res = await today(request("/api/shortcuts/today", token));
    expect(res.status).toBe(200);
    expect(typeof (await res.json()).message).toBe("string");
  });

  it("фраза о лимите: остаток, исчерпанный лимит", () => {
    const s = stateWith({ transactions: [tx({ type: "adjustment", amount: 3_000_000, date: "2026-10-01", category: "" })] });
    expect(todayBudgetText(s, "2026-10-10")).toMatch(/^Сегодня можно потратить \d/);
    const spent = { ...s, transactions: [...s.transactions, tx({ type: "expense", amount: 2_900_000, date: "2026-10-10" })] };
    expect(todayBudgetText(spent, "2026-10-10")).toMatch(/^(Лимит на сегодня исчерпан|Сегодня свободных денег нет)/);
  });
});
