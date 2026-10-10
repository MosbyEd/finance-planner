import { describe, expect, it } from "vitest";
import { applyActions, actionSchema } from "./actions";
import { buildAiSystemPrompt, parseAiReply, proposalToActions } from "./ai";
import { stateWith, testId, tx } from "./test-utils";

describe("разбор ответа модели", () => {
  const state = stateWith();
  const today = "2026-03-15";

  it("без команд возвращает текст", () => {
    expect(parseAiReply("Всё хорошо.", state, today)).toEqual({ text: "Всё хорошо.", proposal: null, skipped: 0 });
  });

  it("вырезает AI_CMDS и проверяет команды", () => {
    const reply = [
      "Добавил кофе и лимит.",
      'AI_CMDS: {"operations":[',
      '{"type":"expense","amount":"250,5","category":"Кафе и рестораны","title":"Кофе {латте}"},',
      '{"type":"expense","amount":100,"category":"Кафе","title":"x","date":"2026-02-30"},',
      '{"type":"expense","amount":-5,"category":"Кафе","title":"x"},',
      '{"type":"fixedExpense","amount":1000,"category":"Ремонт","title":"Мастер","date":"2026-03-20"}',
      '],"presets":[{"type":"expense","amount":500,"category":"Подписки","title":"Облако","dayOfMonth":40}],',
      '"categoryLimits":{"Продукты":20000,"Кафе":"много"}}',
    ].join("\n");
    const { text, proposal, skipped } = parseAiReply(reply, state, today);
    expect(text).toBe("Добавил кофе и лимит.");
    expect(skipped).toBe(4); // дата 30 февраля, минусовая сумма, день 40, лимит «много»
    expect(proposal?.operations).toEqual([
      { type: "expense", amount: 25_050, category: "Кафе и рестораны", title: "Кофе {латте}", date: "2026-03-15", mandatory: false },
      { type: "expense", amount: 100_000, category: "Ремонт", title: "Мастер", date: "2026-03-20", mandatory: true },
    ]);
    expect(proposal?.templates).toEqual([]);
    expect(proposal?.limits).toEqual([{ category: "Продукты", amount: 2_000_000 }]);
  });

  it("битый JSON не ломает ответ", () => {
    const r = parseAiReply('Текст\nAI_CMDS: {"operations":[', state, today);
    expect(r).toEqual({ text: "Текст", proposal: null, skipped: 1 });
  });

  it("подтверждённое предложение превращается в валидные действия", () => {
    const { proposal } = parseAiReply(
      'Ок AI_CMDS: {"operations":[{"type":"income","amount":5000,"category":"Фриланс","title":"Проект"}],"templates":[{"type":"expense","amount":990,"category":"Подписки","title":"Кино","dayOfMonth":10}]}',
      state,
      today,
    );
    const actions = proposalToActions(proposal!, state, today, () => testId("ai"));
    for (const a of actions) expect(actionSchema.safeParse(a).success).toBe(true);
    const next = applyActions(state, actions);
    expect(next.transactions).toHaveLength(1);
    // 10-е уже прошло — шаблон начнёт со следующего месяца
    expect(next.templates[0].startDate).toBe("2026-04-01");
  });
});

describe("разбор ответа модели: служебные имена (L4, L8)", () => {
  it("категории «constructor»/«__proto__» не попадают в действия, обрезанные названия без пробелов", () => {
    const state = stateWith();
    const today = "2026-03-15";
    const longTitle = `${"а".repeat(79)} хвост`;
    const reply =
      'AI_CMDS: {"operations":[{"type":"expense","amount":100,"category":"constructor","title":"' +
      longTitle +
      '"}],"categoryLimits":{"__proto__":100,"toString":200,"Кафе":300}}';
    const { proposal, skipped } = parseAiReply(reply, state, today);
    expect(proposal?.operations[0]).toMatchObject({ category: "Другое", title: "а".repeat(79) });
    expect(proposal?.limits).toEqual([{ category: "Кафе", amount: 30_000 }]);
    expect(skipped).toBe(2);
    const actions = proposalToActions(proposal!, state, today, () => testId("ai"));
    for (const a of actions) expect(actionSchema.safeParse(a).success).toBe(true);
  });
});

describe("системный промпт", () => {
  it("содержит снимок с актуальными суммами в рублях", () => {
    const s = stateWith({ transactions: [tx({ type: "income", amount: 1_234_500, date: "2026-03-01" })] });
    const prompt = buildAiSystemPrompt(s, "2026-03-15");
    expect(prompt).toContain('"balanceOnAccount":12345');
    expect(prompt).toContain("AI_CMDS");
  });
});
