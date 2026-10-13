import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { APP_VERSION, RELEASES } from "./releases";

describe("версия приложения", () => {
  it("сборки iOS и Mac получают ту же версию, что и «О приложении»", () => {
    const script = fileURLToPath(new URL("../../../../scripts/app-version.sh", import.meta.url));
    expect(execFileSync("bash", [script], { encoding: "utf8" }).trim()).toBe(APP_VERSION);
  });

  it("id выпусков не повторяются", () => {
    expect(new Set(RELEASES.map((r) => r.id)).size).toBe(RELEASES.length);
  });
});
