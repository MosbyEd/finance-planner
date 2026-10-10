import { describe, expect, it } from "vitest";
import { applyActions, actionSchema } from "./actions";
import { buildAiSystemPrompt, parseAiReply, proposalToActions, refineLocalProposal } from "./ai";
import { emptyState } from "./defaults";
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

describe("страховка для модели на телефоне", () => {
  const state = stateWith({ categories: { ...emptyState().categories, mandatory: ["Подписки", "Аренда"] } });
  const today = "2026-10-10";

  it("на обычный вопрос придуманное предложение отбрасывается", () => {
    const reply =
      'Сегодня можно потратить 773 рубля.\n\nAI_CMDS: {"operations":[{"type":"expense","amount":773,"category":"Продукты","title":"Деньги на сегодня","date":"2026-10-10"}]}';
    const parsed = parseAiReply(reply, state, today);
    expect(parsed.proposal).not.toBeNull();
    expect(refineLocalProposal(parsed.proposal, "Сколько можно тратить до зарплаты?", state)).toBeNull();
  });

  it("на просьбу добавить — категория по подсказкам, а не та, что выбрала модель", () => {
    const reply =
      'Предлагаю добавить расход на кофе.\n\nAI_CMDS: {"operations":[{"type":"expense","amount":300,"category":"Подписки","title":"Кофе","date":"2026-10-10","mandatory":true}]}';
    const parsed = parseAiReply(reply, state, today);
    const refined = refineLocalProposal(parsed.proposal, "Добавь расход 300 рублей на кофе сегодня", state);
    expect(refined?.operations).toEqual([
      expect.objectContaining({ amount: 30_000, title: "Кофе", category: "Кафе и рестораны", mandatory: false }),
    ]);
  });
});

describe("новые действия помощника: счета, переводы, правки регулярных, цели, долги", () => {
  const today = "2026-10-11";
  function state() {
    return applyActions(stateWith(), [
      { type: "balance.set", id: "b", date: "2026-10-01", actual: 5_000_000 },
      { type: "account.add", account: { id: "cc", name: "Альфа кредитка", kind: "credit", spending: false } },
      { type: "account.add", account: { id: "dep", name: "Накопительный", kind: "savings", spending: false } },
      {
        type: "template.add",
        template: { id: "net", kind: "expense", title: "Netflix", category: "Подписки", amount: 60_000, dayOfMonth: 6, active: true, startDate: "2026-10-01", note: "" },
      },
      { type: "goal.add", goal: { id: "car", name: "Машина", targetAmount: 100_000_000, initialAmount: 0, dueDate: null, note: "", createdAt: "2026-01-01" } },
      {
        type: "loan.add",
        loan: { id: "tb", kind: "credit", name: "Тбанк", amount: 6_000_000, initialPaid: 0, dueDate: null, note: "", createdAt: "2026-01-01" },
      },
    ]);
  }

  it("разбирает по названиям из данных; неизвестные пропускает; применяется без ошибок", () => {
    const s = state();
    const reply = [
      "Предлагаю изменения.",
      "AI_CMDS: " +
        JSON.stringify({
          operations: [{ type: "expense", amount: 500, category: "Продукты", title: "Лента", account: "альфа кредитка" }],
          transfers: [
            { from: "Основной счёт", to: "Альфа", amount: 3000 },
            { from: "Основной счёт", to: "Накопительный", amount: 1000 },
            { from: "Нет такого", to: "Альфа", amount: 1 },
          ],
          templateUpdates: [
            { title: "netflix", amount: 699, active: false },
            { title: "Spotify", amount: 1 },
          ],
          balances: [{ account: "Основной", amount: 49000 }, { account: "Альфа кредитка", amount: 2500 }],
          goals: [{ goal: "Машина", amount: 2000 }],
          loanPayments: [{ loan: "Тбанк", amount: 5000 }],
        }),
    ].join("\n");
    const { proposal, skipped } = parseAiReply(reply, s, today);
    expect(skipped).toBe(2);
    expect(proposal?.operations[0]).toMatchObject({ accountId: "cc", amount: 50_000 });
    expect(proposal?.transfers).toEqual([
      { from: "main", to: "cc", amount: 300_000, date: today },
      { from: "main", to: "dep", amount: 100_000, date: today },
    ]);
    expect(proposal?.templateUpdates).toEqual([{ templateId: "net", amount: 69_900, active: false }]);
    expect(proposal?.balances).toEqual([
      { accountId: "main", actual: 4_900_000 },
      { accountId: "cc", actual: -250_000 },
    ]);

    let ids = 0;
    const actions = proposalToActions(proposal!, s, today, () => `ai-${++ids}`);
    for (const a of actions) expect(actionSchema.safeParse(a).success).toBe(true);
    expect(actions.map((a) => a.type)).toEqual([
      "tx.add",
      "transfer.add",
      "savings.move",
      "template.setActive",
      "template.update",
      "balance.set",
      "balance.set",
      "savings.move",
      "loan.payment",
    ]);
    const after = applyActions(s, actions);
    expect(after.templates[0]).toMatchObject({ amount: 69_900, active: false });
  });
});
