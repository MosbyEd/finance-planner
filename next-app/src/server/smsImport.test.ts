import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/auth/register/route";
import { DELETE as deleteKey, GET as keyStatus, POST as createKey } from "@/app/api/account/sms-key/route";
import { POST as importSmsRoute } from "@/app/api/import/sms/route";
import { GET as getState } from "@/app/api/state/route";
import { closeDb, getDb } from "./db";
import { clearRateLimits } from "./rateLimit";
import { clearStateCache } from "./stateStore";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "finance-sms-test-"));
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

const APP = { origin: "capacitor://localhost", "sec-fetch-site": "cross-site", "x-client": "native" };

function request(url: string, init: { method?: string; body?: string; headers?: Record<string, string> } = {}) {
  return new NextRequest(`http://localhost:3001${url}`, {
    method: init.method ?? "GET",
    headers: { host: "localhost:3001", ...init.headers },
    body: init.body,
  });
}

async function signUp(): Promise<string> {
  const res = await register(
    request("/api/auth/register", {
      method: "POST",
      headers: { ...APP, "content-type": "application/json" },
      body: JSON.stringify({ login: "anna", password: "correct horse" }),
    }),
  );
  return (await res.json()).token as string;
}

async function newKey(token: string): Promise<string> {
  const res = await createKey(request("/api/account/sms-key", { method: "POST", headers: { ...APP, authorization: `Bearer ${token}` } }));
  expect(res.status).toBe(200);
  return (await res.json()).key as string;
}

function sendSms(key: string, body: string, contentType = "application/json") {
  return importSmsRoute(
    request("/api/import/sms", { method: "POST", headers: { authorization: `Bearer ${key}`, "content-type": contentType }, body }),
  );
}

async function transactions(token: string) {
  const res = await getState(request("/api/state", { headers: { ...APP, authorization: `Bearer ${token}` } }));
  return (await res.json()).state.transactions as { type: string; amount: number; category: string; title: string }[];
}

const PURCHASE = "Счёт карты MIR-7759 19:29 Покупка 162.38р Перекрёсток Баланс: 5097.76р";

describe("операции из СМС", () => {
  it("СМС с ключом добавляет операцию; повтор той же СМС её не задваивает", async () => {
    const token = await signUp();
    const key = await newKey(token);

    const first = await sendSms(key, JSON.stringify({ text: PURCHASE }));
    expect(first.status).toBe(200);
    const body = await first.json();
    expect(body.status).toBe("added");
    expect(body.message.replace(/\s/g, " ")).toBe("Расход 162,38 ₽ · Перекрёсток → Продукты");

    const again = await (await sendSms(key, JSON.stringify({ text: PURCHASE }))).json();
    expect(again.status).toBe("duplicate");

    const list = await transactions(token);
    expect(list.filter((t) => t.type === "expense")).toEqual([
      expect.objectContaining({ amount: 16_238, category: "Продукты", title: "Перекрёсток" }),
    ]);
  });

  it("принимает форму и простой текст; рекламу пропускает", async () => {
    const key = await newKey(await signUp());
    const form = await sendSms(key, new URLSearchParams({ text: "СЧЁТ5804 19:31 Перевод 800р от Валерия В. Баланс: 5897.76р" }).toString(), "application/x-www-form-urlencoded");
    expect((await form.json()).status).toBe("added");
    const plain = await sendSms(key, "Счёт карты MIR-1750 01:49 Покупка 199р PODPISKA PAKET Баланс: 4125.04р", "text/plain");
    expect((await plain.json()).status).toBe("added");
    const ad = await sendSms(key, JSON.stringify({ text: "Подключены привилегии Mir Supreme: s.sber.ru/250KnZ" }));
    expect(await ad.json()).toMatchObject({ status: "ignored" });
  });

  it("без ключа, с чужим или отозванным ключом — 401; сессионный токен ключом не является", async () => {
    const token = await signUp();
    const key = await newKey(token);
    expect((await sendSms("sms_" + "x".repeat(32), JSON.stringify({ text: PURCHASE }))).status).toBe(401);
    expect((await sendSms(token, JSON.stringify({ text: PURCHASE }))).status).toBe(401);

    const status = await keyStatus(request("/api/account/sms-key", { headers: { ...APP, authorization: `Bearer ${token}` } }));
    expect((await status.json()).key).toMatchObject({ createdAt: expect.any(Number) });

    await deleteKey(request("/api/account/sms-key", { method: "DELETE", headers: { ...APP, authorization: `Bearer ${token}` } }));
    const revoked = await sendSms(key, JSON.stringify({ text: PURCHASE }));
    expect(revoked.status).toBe(401);
    expect((await revoked.json()).message).toMatch(/Ключ не подходит/);
  });

  it("новый ключ заменяет прежний", async () => {
    const token = await signUp();
    const old = await newKey(token);
    const fresh = await newKey(token);
    expect((await sendSms(old, JSON.stringify({ text: PURCHASE }))).status).toBe(401);
    expect((await sendSms(fresh, JSON.stringify({ text: PURCHASE }))).status).toBe(200);
  });

  it("операцию, которую нельзя применить, не добавляет и объясняет почему", async () => {
    const key = await newKey(await signUp());
    const res = await sendSms(key, JSON.stringify({ text: "Накопительный счет *3150 16:16 Перевод 9501.32р на СЧЁТ5804. Баланс счёта *3150: 0р" }));
    expect(await res.json()).toMatchObject({ status: "failed", message: expect.stringMatching(/^Не добавлено: Нельзя снять больше/) });
  });
});
