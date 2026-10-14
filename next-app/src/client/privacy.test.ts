import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ ok: true }));

vi.mock("./native", () => ({ nativeBiometricAuth: vi.fn(async () => auth.ok) }));
vi.mock("./desktop", () => ({ desktopBiometricAuth: vi.fn(async () => auth.ok) }));
vi.mock("./runtime", () => ({ isNativeApp: () => true }));

const data = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (k: string) => data.get(k) ?? null,
  setItem: (k: string, v: string) => void data.set(k, v),
  removeItem: (k: string) => void data.delete(k),
});

/** Новый запуск приложения: модуль читает состояние из localStorage заново. */
async function launch() {
  vi.resetModules();
  return import("./privacy");
}

describe("глазок у сумм счетов помнит последнее состояние", () => {
  beforeEach(() => {
    data.clear();
    auth.ok = true;
  });

  it("спрятали — после перезапуска спрятаны", async () => {
    (await launch()).hideBalances();
    expect((await launch()).balancesMasked()).toBe(true);
  });

  it("показали по Face ID — после перезапуска показаны, без новой проверки", async () => {
    (await launch()).hideBalances();
    const app = await launch();
    expect(await app.revealBalances()).toBe(true);
    expect(app.balancesMasked()).toBe(false);
    expect((await launch()).balancesMasked()).toBe(false);
  });

  it("Face ID не прошёл — суммы остаются спрятанными и после перезапуска", async () => {
    (await launch()).hideBalances();
    auth.ok = false;
    const app = await launch();
    expect(await app.revealBalances()).toBe(false);
    expect(app.balancesMasked()).toBe(true);
    expect((await launch()).balancesMasked()).toBe(true);
  });
});
