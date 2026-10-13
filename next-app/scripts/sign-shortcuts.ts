// Команды «Бюджет СМС» для приложения «Команды»: общая — без автоматизации, и по одной на каждый известный банк
// (KNOWN_BANKS) — с автоматизацией «Сообщение» от его отправителей. iOS открывает только подписанные команды,
// а подписать можно только на Mac со входом в iCloud (shortcuts sign), поэтому команды собираются заранее
// и лежат в пакете приложения: ios/App/App/Shortcuts. Шаблон — ios/shortcuts/budget-sms.plist.
// Запуск после правки шаблона или отправителей банков: npx tsx scripts/sign-shortcuts.ts
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GENERIC_SHORTCUT, KNOWN_BANKS, bankShortcut } from "../src/domain/banks";

const TEMPLATE = "ios/shortcuts/budget-sms.plist";
const OUT = "ios/App/App/Shortcuts";
const TRIGGER = "WFWorkflowTriggers.0.WFTriggerSerializedParameters";

const plutil = (...args: string[]) => execFileSync("plutil", args, { stdio: "inherit" });

/** Один и тот же UUID для одной и той же команды — чтобы повторная сборка не меняла шаблон зря. */
function stableUuid(name: string): string {
  const h = createHash("sha256").update(name).digest("hex").toUpperCase();
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

/** Отправители в автоматизации «Сообщение»: номер или имя, как в «Сообщениях». */
function sendersJson(senders: string[]): string {
  return JSON.stringify(senders.map((s) => ({ EntryType: 1, SerializedEntry: { "link.contentkit.phonenumber": s } })));
}

const work = mkdtempSync(join(tmpdir(), "budget-shortcuts-"));
try {
  mkdirSync(OUT, { recursive: true });
  for (const old of readdirSync(OUT)) if (old.endsWith(".shortcut")) rmSync(join(OUT, old));

  const variants = [
    { name: GENERIC_SHORTCUT, senders: null },
    ...KNOWN_BANKS.map((bank) => bankShortcut(bank)!),
  ];
  for (const variant of variants) {
    const file = join(work, `${variant.name}.shortcut`); // shortcuts sign принимает только .shortcut
    copyFileSync(TEMPLATE, file);
    plutil("-replace", "WFWorkflowName", "-string", variant.name, file);
    if (!variant.senders) {
      plutil("-remove", "WFWorkflowTriggers", file);
    } else {
      const senders = sendersJson(variant.senders);
      plutil("-replace", `${TRIGGER}.WFMessageSender.Value.WFContactFieldValues`, "-json", senders, file);
      plutil(
        "-replace",
        `${TRIGGER}.WFMessageConditions.Value.WFActionParameterFilterTemplates.0.Values.Sender.Value.WFContactFieldValues`,
        "-json",
        senders,
        file,
      );
      plutil("-replace", "WFWorkflowTriggers.0.WFTriggerUUID", "-string", stableUuid(variant.name), file);
    }
    plutil("-convert", "binary1", file);
    execFileSync("shortcuts", ["sign", "--mode", "anyone", "--input", file, "--output", join(OUT, `${variant.name}.shortcut`)], {
      stdio: "inherit",
    });
    console.log(`✓ ${variant.name}${variant.senders ? ` — ${variant.senders.join(", ")}` : " — без автоматизации"}`);
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
