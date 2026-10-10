import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { DIRECT_CLIENT, clientIp, isAccountMismatch, readBody } from "./http";

const schema = z.object({ text: z.string() });

/** Запрос с телом-потоком: без Content-Length (как chunked), считает, сколько кусков у него забрали. */
function streamingRequest(chunk: Uint8Array, count: number) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (pulled >= count) return controller.close();
      pulled += 1;
      controller.enqueue(chunk);
    },
  });
  const req = new NextRequest("http://localhost:3001/api/x", {
    method: "POST",
    body,
    headers: { "content-type": "application/json" },
    duplex: "half", // Node fetch требует его для тела-потока
  });
  return { req, pulled: () => pulled };
}

describe("readBody (H2)", () => {
  it("без Content-Length прекращает чтение, как только тело больше предела", async () => {
    const { req, pulled } = streamingRequest(new Uint8Array(1024 * 1024).fill(0x78), 200);
    expect(req.headers.get("content-length")).toBeNull();
    const res = await readBody(req, schema, 10_000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);
    // До исправления забирались все 200 МиБ.
    expect(pulled()).toBeLessThanOrEqual(2);
  });

  it("считает байты UTF-8, а не символы", async () => {
    const text = "я".repeat(4_000); // 4000 символов, 8000 байт
    const json = JSON.stringify({ text });
    expect(json.length).toBeLessThan(5_000);
    const { req } = streamingRequest(new TextEncoder().encode(json), 1);
    const res = await readBody(req, schema, 5_000);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.response.status).toBe(413);

    const { req: fits } = streamingRequest(new TextEncoder().encode(json), 1);
    const ok = await readBody(fits, schema, 9_000);
    expect(ok.ok && ok.data.text).toBe(text);
  });

  it("отклоняет по Content-Length, не читая тело, и разбирает обычный запрос", async () => {
    const big = new NextRequest("http://localhost:3001/api/x", {
      method: "POST",
      body: JSON.stringify({ text: "x" }),
      headers: { "content-type": "application/json", "content-length": "999999" },
    });
    const res = await readBody(big, schema, 1_000);
    expect(!res.ok && res.response.status).toBe(413);

    const normal = new NextRequest("http://localhost:3001/api/x", { method: "POST", body: JSON.stringify({ text: "привет" }) });
    const ok = await readBody(normal, schema, 1_000);
    expect(ok.ok && ok.data).toEqual({ text: "привет" });
  });

  it("некорректный UTF-8 и JSON — 400", async () => {
    const { req } = streamingRequest(new Uint8Array([0x7b, 0xff, 0xfe, 0x7d]), 1);
    const res = await readBody(req, schema, 1_000);
    expect(!res.ok && res.response.status).toBe(400);
    const { req: notJson } = streamingRequest(new TextEncoder().encode("{oops"), 1);
    const res2 = await readBody(notJson, schema, 1_000);
    expect(!res2.ok && res2.response.status).toBe(400);
  });
});

describe("clientIp (M6)", () => {
  const original = { TRUST_PROXY: process.env.TRUST_PROXY, TRUST_PROXY_HEADER: process.env.TRUST_PROXY_HEADER };
  afterEach(() => {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  const req = (headers: Record<string, string>) => new NextRequest("http://localhost:3001/api/x", { headers });

  it("без доверенного прокси не верит X-Forwarded-For и X-Real-IP", () => {
    delete process.env.TRUST_PROXY;
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(DIRECT_CLIENT);
    expect(clientIp(req({ "x-real-ip": "1.2.3.4" }))).toBe(DIRECT_CLIENT);
  });

  it("с TRUST_PROXY=true берёт только последний адрес X-Forwarded-For, X-Real-IP не читает (ревью 2)", () => {
    process.env.TRUST_PROXY = "true";
    delete process.env.TRUST_PROXY_HEADER;
    // X-Real-IP мог прислать сам клиент, если прокси его не перезаписывает.
    expect(clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" }))).toBe("1.2.3.4");
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe(DIRECT_CLIENT);
    // Первый адрес мог прислать сам клиент, последний дописал наш прокси.
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4, 10.0.0.7" }))).toBe("10.0.0.7");
    expect(clientIp(req({}))).toBe(DIRECT_CLIENT);
  });

  it("TRUST_PROXY_HEADER=x-real-ip — только X-Real-IP", () => {
    process.env.TRUST_PROXY = "true";
    process.env.TRUST_PROXY_HEADER = "X-Real-IP";
    expect(clientIp(req({ "x-real-ip": "9.9.9.9", "x-forwarded-for": "1.2.3.4" }))).toBe("9.9.9.9");
    expect(clientIp(req({ "x-forwarded-for": "1.2.3.4" }))).toBe(DIRECT_CLIENT);
    delete process.env.TRUST_PROXY;
    expect(clientIp(req({ "x-real-ip": "9.9.9.9" }))).toBe(DIRECT_CLIENT);
  });
});

describe("isAccountMismatch (X-Account)", () => {
  const user = { id: 1, login: "Аня", name: null };
  const req = (headers: Record<string, string>) => new NextRequest("http://localhost:3001/api/x", { headers });

  it("без заголовка — нет проверки; логин сравнивается без учёта регистра после декодирования", () => {
    expect(isAccountMismatch(req({}), user)).toBe(false);
    expect(isAccountMismatch(req({ "x-account": encodeURIComponent("аня") }), user)).toBe(false);
    expect(isAccountMismatch(req({ "x-account": encodeURIComponent(" АНЯ ") }), user)).toBe(false);
    expect(isAccountMismatch(req({ "x-account": encodeURIComponent("Борис") }), user)).toBe(true);
    expect(isAccountMismatch(req({ "x-account": "" }), user)).toBe(true);
  });

  it("испорченная кодировка — несовпадение", () => {
    expect(isAccountMismatch(req({ "x-account": "%D0" }), user)).toBe(true);
  });
});
