// Разбор СМС на телефоне: этот файл собирается отдельно (vite.engine.config.mts) и выполняется во встроенном
// JavaScriptCore приложения — команда «Добавить операцию из СМС» работает и без сети, и при закрытом приложении.
// Логика та же, что на сервере (src/domain/smsImport.ts): номера изменений совпадают, дублей не будет.
import { DomainError, actionSchema, applyAction } from "@/domain/actions";
import type { IsoDate } from "@/domain/dates";
import { stateSchema, type State } from "@/domain/schema";
import { prepareSmsImport, type PreparedSms } from "@/domain/smsImport";

// В JavaScriptCore нет WebCrypto. Разбор СМС случайных номеров не берёт, но модуль ids ждёт crypto.
const scope = globalThis as unknown as { crypto?: { getRandomValues?: (bytes: Uint8Array) => Uint8Array } };
if (!scope.crypto?.getRandomValues) {
  scope.crypto = {
    getRandomValues(bytes: Uint8Array) {
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
      return bytes;
    },
  };
}

type Op = PreparedSms["ops"][number];

/** СМС → изменения и данные после них. state — копия данных, которую приложение хранит для команд. */
function plan(input: { state: unknown; text: string; day: IsoDate; time: string }): PreparedSms & { state: State | null } {
  const parsed = stateSchema.safeParse(input.state);
  if (!parsed.success) return { status: "failed", message: "Нет данных приложения на телефоне.", ops: [], state: null };
  const prepared = prepareSmsImport(parsed.data, input.text, { day: input.day, time: input.time });
  if (!prepared.ops.length) return { ...prepared, state: null };
  try {
    const next = prepared.ops.reduce((state, op) => applyAction(state, op.action), parsed.data);
    return { ...prepared, state: next };
  } catch (error) {
    if (error instanceof DomainError) return { status: "failed", message: `Не добавлено: ${error.message}`, ops: [], state: null };
    throw error;
  }
}

/**
 * Свежая копия данных из интерфейса плюс операции из СМС, которые интерфейс ещё не принял. Группа (одна СМС)
 * применяется целиком или пропускается — например, если она уже есть в данных.
 */
function apply(input: { state: unknown; groups: Op[][] }): { state: State } {
  let state = stateSchema.parse(input.state);
  for (const group of input.groups) {
    try {
      state = group.reduce((current, op) => applyAction(current, actionSchema.parse(op.action)), state);
    } catch {
      // Уже учтена или больше не применима — интерфейс разберётся при приёме.
    }
  }
  return { state };
}

(globalThis as unknown as { BudgetEngine: unknown }).BudgetEngine = {
  // Данные после изменений — строкой JSON: приложение сохраняет её как есть, не разбирая.
  planJson: (json: string) => {
    const { state, ...result } = plan(JSON.parse(json));
    return JSON.stringify({ ...result, stateJson: state ? JSON.stringify(state) : null });
  },
  applyJson: (json: string) => JSON.stringify(apply(JSON.parse(json))),
};
