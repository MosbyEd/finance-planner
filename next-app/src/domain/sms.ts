import type { Action } from "./actions";
import { addDays, addMonths, diffDays, monthKeyOf, type IsoDate, type MonthKey } from "./dates";
import { OTHER_CATEGORY } from "./defaults";
import { formatMoney, MAX_KOPECKS, type Kopecks } from "./money";
import { isSkipped, occurrenceDate } from "./recurring";
import { autoSavingByDefault } from "./savings";
import { LIMITS, type State, type Transaction } from "./schema";

/**
 * Операции из СМС Сбербанка (номер 900). iOS не даёт приложениям читать СМС, поэтому текст присылает
 * автоматизация «Команд» на сервер; здесь — только разбор текста и выбор категории, без сети и базы.
 */

export type SmsOperation =
  | {
      kind: "expense";
      via: "purchase" | "payment" | "transfer" | "cash" | "writeoff";
      amount: Kopecks;
      time: string | null;
      /** Магазин или получатель; пусто, если в СМС его нет. */
      counterparty: string;
    }
  | {
      kind: "income";
      via: "salary" | "advance" | "bonus" | "transfer" | "deposit" | "refund" | "interest";
      amount: Kopecks;
      time: string | null;
      counterparty: string;
    }
  /** Проценты, выплаченные на накопительный счёт: доход, который сразу лежит в сбережениях. */
  | { kind: "savingsInterest"; amount: Kopecks; time: string | null }
  /** Перевод со счёта на накопительный счёт и обратно. */
  | { kind: "toSavings"; amount: Kopecks; time: string | null }
  | { kind: "fromSavings"; amount: Kopecks; time: string | null };

type IncomeVia = Extract<SmsOperation, { kind: "income" }>["via"];
type ExpenseVia = Extract<SmsOperation, { kind: "expense" }>["via"];

/** Пробелы СМС (неразрывные, узкие) — обычные, по одному. */
export function normalizeSms(text: string): string {
  return text
    .replace(/[    ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// Сумма в рублях: «1440р», «162.38р», «61 848.91р», «358,90р.», «500 руб.», «500 ₽».
const AMOUNT = String.raw`(\d{1,3}(?: \d{3})+|\d+)(?:[.,](\d{1,2}))?\s?(?:руб\.?|р\.?|₽|RUB)(?![а-яё])`;
/** Остаток строки — магазин или получатель (текст уже без «Баланс…»). */
const TAIL = String.raw`(?:\s+(.+))?$`;

function amountOf(rubles: string, fraction: string | undefined): Kopecks | null {
  const whole = Number(rubles.replace(/ /g, ""));
  const kopecks = fraction ? Number(fraction.padEnd(2, "0")) : 0;
  const total = whole * 100 + kopecks;
  return Number.isSafeInteger(total) && total > 0 && total <= MAX_KOPECKS ? total : null;
}

/** Магазин или получатель без хвостовой пунктуации; точку инициала («Валерия В.») оставляем. */
function clean(text: string | undefined): string {
  const trimmed = (text ?? "").replace(/[\s,;:]+$/, "");
  const withoutDot = / [A-ZА-ЯЁ]\.$/u.test(trimmed) ? trimmed : trimmed.replace(/\.+$/, "");
  return withoutDot.trim().slice(0, 60);
}

/** Время операции «ЧЧ:ММ» из СМС, если есть. */
function timeOf(text: string): string | null {
  const m = /(?:^|\s)([01]?\d|2[0-3]):([0-5]\d)(?=\s)/.exec(text);
  return m ? `${m[1].padStart(2, "0")}:${m[2]}` : null;
}

/** Не операции: отказы, коды, пароли, реклама с суммами. */
const NOT_OPERATION = /отказ|отклон|недостаточно|не выполн|не прош|код[\s:]|парол|одобрен|предлага|акци[яи]|https?:\/\/|\.ru\//iu;
const SAVINGS_ACCOUNT = /^(?:Накопительный|Сберегательный) сч[её]т|^Вклад/iu;

/** Разбирает СМС от 900. Не операция или незнакомый формат — null. */
export function parseSberSms(raw: string): SmsOperation | null {
  const text = normalizeSms(raw);
  if (!text || NOT_OPERATION.test(text)) return null;
  const time = timeOf(text);
  const match = (re: string) => new RegExp(re, "iu").exec(text);
  const amount = (m: RegExpExecArray) => amountOf(m[1], m[2]);

  // Со счёта на накопительный: «Зачисление средств 45 045р на счёт Накопительный счет *7272».
  let m = match(String.raw`(?:Зачисление средств|Перевод)\s+${AMOUNT}\s+на (?:сч[её]т\s+)?(?:Накопительный|Сберегательный|вклад)`);
  if (m) {
    const a = amount(m);
    return a ? { kind: "toSavings", amount: a, time } : null;
  }

  if (SAVINGS_ACCOUNT.test(text)) {
    // С накопительного на основной счёт: «Накопительный счет *3150 16:16 Перевод 9501.32р на СЧЁТ5804».
    m = match(String.raw`Перевод\s+${AMOUNT}\s+на\s+(?:СЧ[ЁЕ]Т|карту|сч[её]т)`);
    if (m) {
      const a = amount(m);
      return a ? { kind: "fromSavings", amount: a, time } : null;
    }
    m = match(String.raw`(?:Выплатили проценты|Зачисление процентов|Капитализация|Проценты)\s+${AMOUNT}`);
    if (m) {
      const a = amount(m);
      return a ? { kind: "savingsInterest", amount: a, time } : null;
    }
    // Остальное по накопительному (пополнение с него же, закрытие) — без изменений на счёте в приложении.
    return null;
  }

  // Дальше нужна только сама операция: «Баланс…» и всё после него отрезаем, чтобы он не попал в получателя.
  const head = text.replace(/\s*Баланс.*$/iu, "");
  const on = (re: string) => new RegExp(re, "iu").exec(head);
  const income = (via: IncomeVia, m: RegExpExecArray, counterparty = ""): SmsOperation | null => {
    const a = amount(m);
    return a ? { kind: "income", via, amount: a, time, counterparty: clean(counterparty) } : null;
  };
  const expense = (via: ExpenseVia, m: RegExpExecArray, counterparty = ""): SmsOperation | null => {
    const a = amount(m);
    return a ? { kind: "expense", via, amount: a, time, counterparty: clean(counterparty) } : null;
  };

  // «Зачисление зарплаты 61 848.91р», «Зачисление аванса …».
  m = on(String.raw`Зачисление\s+(зарплаты|заработной платы|аванса|премии|пенсии|стипендии|отпускных)\s+${AMOUNT}`);
  if (m) {
    const word = m[1].toLowerCase();
    const a = amountOf(m[2], m[3]);
    const via: IncomeVia = word.startsWith("аванс") ? "advance" : word.startsWith("прем") ? "bonus" : "salary";
    return a ? { kind: "income", via, amount: a, time, counterparty: "" } : null;
  }

  // Входящий перевод: «Перевод 800р от Валерия В.», «Перевод из Т-Банк +5000р от ИВАН И.».
  m = on(String.raw`Перевод(?:\s+из\s+.+?)?\s+\+?${AMOUNT}\s+от\s+(.+)$`);
  if (m) return income("transfer", m, m[3]);

  // Возврат и отмена покупки.
  m = on(String.raw`(?:Возврат покупки|Отмена покупки|Возврат)\s+${AMOUNT}${TAIL}`);
  if (m) return income("refund", m, m[3]);

  // Прочие зачисления: «Зачисление 1500р …».
  m = on(String.raw`Зачисление\s+\+?${AMOUNT}${TAIL}`);
  if (m) return income("deposit", m, m[3]);

  m = on(String.raw`Покупка\s+${AMOUNT}${TAIL}`);
  if (m) return expense("purchase", m, m[3]);

  m = on(String.raw`Оплата(?:\s+услуг)?\s+${AMOUNT}${TAIL}`);
  if (m) return expense("payment", m, m[3]);

  m = on(String.raw`Выдача(?:\s+наличных)?\s+${AMOUNT}${TAIL}`);
  if (m) return expense("cash", m);

  // Исходящий перевод: «перевод 3000р OZON», «перевод 8000р», «Перевод по СБП 500р для ИВАН И.».
  m = on(String.raw`Перевод(?:\s+по СБП)?\s+${AMOUNT}${TAIL}`);
  if (m) {
    const to = clean(m[3]).replace(/^(?:для|получателю|на имя)\s+/iu, "");
    // На свой счёт («на СЧЁТ5804») — деньги остаются у вас, это не расход.
    if (/^на\s+(?:СЧ[ЁЕ]Т|сч[её]т)/iu.test(to)) return null;
    return expense("transfer", m, to);
  }

  m = on(String.raw`Списание\s+${AMOUNT}${TAIL}`);
  if (m) return expense("writeoff", m, m[3]);

  return null;
}

/**
 * Дата операции. В СМС есть только время; если оно заметно позже текущего — СМС пришла после полуночи
 * за вчерашнюю операцию (час запаса — на расхождение часов).
 */
export function smsDate(today: IsoDate, nowTime: string, smsTime: string | null): IsoDate {
  if (!smsTime) return today;
  const minutes = (t: string) => Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5));
  return minutes(smsTime) - minutes(nowTime) > 60 ? addDays(today, -1) : today;
}

// ---------- категории ----------

/** Для сравнения названий: регистр, «ё», пунктуация и лишние пробелы не важны. */
function normalizeName(text: string): string {
  return text
    .toLocaleLowerCase("ru")
    .replace(/ё/g, "е")
    .replace(/[^a-zа-я0-9]+/g, " ")
    .trim();
}

/**
 * Подсказки по названию магазина: первая категория из списка, которая есть у пользователя.
 * Важнее любой подсказки — категория прошлой операции с тем же названием (см. learnedCategory).
 */
const CATEGORY_HINTS: { re: RegExp; categories: string[] }[] = [
  {
    re: /perekrest|перекрест|pyater|пятероч|magnit|магнит|vkusvill|вкусвилл|lenta|лента|auchan|ашан|dixy|дикси|spar\b|azbuka|азбука вкуса|samokat|самокат|globus|глобус|okey|окей|verny|верный|chestnyj losos|losos|myaso|мясо|ovoshch|овощ|produkt|продукт/,
    categories: ["Продукты"],
  },
  {
    re: /yandex ?go|yandex ?taxi|яндекс ?такси|яндекс ?go|uber|citymobil|ситимобил|taxi|такси/,
    categories: ["Такси", "Транспорт"],
  },
  {
    re: /metropoliten|метрополитен|mosmetro|metro (?!c ?c)|мцд|mcd|troika|тройка|mosgortrans|transport|транспорт|aeroexpress|аэроэкспресс|rzd|ржд|whoosh|urent|самокат шеринг/,
    categories: ["Транспорт"],
  },
  {
    re: /yandex ?eda|яндекс ?еда|delivery|деливери|kuper|купер/,
    categories: ["Доставка", "Кафе/рестораны", "Кафе и рестораны"],
  },
  {
    re: /kafe|cafe|кафе|restoran|ресторан|coffee|кофе|kofe|burger|бургер|vkusno|вкусно|kfc|rostics|ростикс|teremok|теремок|shokoladnica|шоколадница|starbucks|cofix|pizza|пицц|sushi|суши|stolovaya|столовая|dodo|додо|bar\b|бар\b|grill|гриль|pekarn|пекарн|bakery/,
    categories: ["Кафе/рестораны", "Кафе и рестораны", "Кафе", "Кофе"],
  },
  {
    re: /podpisk|подписк|yandex ?plus|яндекс ?плюс|kinopoisk|кинопоиск|ivi\b|okko|spotify|apple ?com|itunes|google|youtube|telegram|телеграм|sberprime|сберпрайм|prime/,
    categories: ["Подписки"],
  },
  {
    re: /apteka|аптек|pharm|фарм|zdorov|здоров|clinic|клиник|medsi|медси|invitro|инвитро|gemotest|гемотест|stomat|стомат|doctor|доктор/,
    categories: ["Здоровье"],
  },
  {
    re: /\bmts\b|\bмтс\b|beeline|билайн|megafon|мегафон|tele2|\bt2\b|yota|йота|rostelecom|ростелеком/,
    categories: ["Связь и интернет", "Связь", "Мобильная связь"],
  },
  {
    re: /\bazs\b|\bазс\b|lukoil|лукойл|gazpromneft|газпромнефть|rosneft|роснефть|tatneft|татнефть|shell|neste|parking|парковк|avtomoyka|автомойк/,
    categories: ["Автомобиль", "Транспорт"],
  },
  { re: /kino|кино|cinema|синема|karo|каро|formula kino/, categories: ["Кино", "Развлечения"] },
  { re: /cvety|цветы|flowers|flowwow/, categories: ["Цветы", "Подарки"] },
  { re: /\bzoo|зоо|chetyre lapy|четыре лапы|beethoven|бетховен|petshop/, categories: ["Коты", "Животные", "Питомцы"] },
  { re: /fitness|фитнес|sport|спорт|world ?class|ddx|x ?fit|бассейн/, categories: ["Спорт"] },
  { re: /zara|uniqlo|lamoda|ламода|gloria|befree|ostin|остин|h ?m\b|zolla|золла|love republic|sela/, categories: ["Одежда"] },
];

const INCOME_CATEGORY: Record<IncomeVia, string> = {
  salary: "Зарплата",
  advance: "Аванс",
  bonus: "Премия",
  transfer: "Переводы",
  deposit: "Переводы",
  refund: "Возвраты",
  interest: "Проценты",
};
const EXPENSE_FALLBACK: Record<ExpenseVia, string> = {
  purchase: OTHER_CATEGORY,
  payment: OTHER_CATEGORY,
  writeoff: OTHER_CATEGORY,
  transfer: "Переводы",
  cash: "Наличные",
};

function findCategory(state: State, name: string): string | null {
  const wanted = normalizeName(name);
  const all = [...state.categories.flexible, ...state.categories.mandatory, ...state.categories.income];
  return all.find((c) => normalizeName(c) === wanted) ?? null;
}

/** Категория и «обязательность» последней операции того же типа с тем же названием — пользователь мог её поправить. */
function learnedCategory(state: State, type: "income" | "expense", title: string): Transaction | null {
  const key = normalizeName(title);
  if (!key) return null;
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const t = state.transactions[i];
    if (t.type === type && t.category && normalizeName(t.title) === key) return t;
  }
  return null;
}

function hintedCategory(state: State, counterparty: string): string | null {
  const name = normalizeName(counterparty);
  if (!name) return null;
  for (const hint of CATEGORY_HINTS) {
    if (!hint.re.test(name)) continue;
    for (const candidate of hint.categories) {
      const found = findCategory(state, candidate);
      if (found) return found;
    }
  }
  return null;
}

function isMandatoryCategory(state: State, category: string): boolean {
  const key = normalizeName(category);
  const inGroup = (list: string[]) => list.some((c) => normalizeName(c) === key);
  return inGroup(state.categories.mandatory) && !inGroup(state.categories.flexible);
}

/**
 * Категория для новой операции без явной категории: как у прошлой операции с тем же названием
 * (пользователь мог её поправить), иначе по подсказкам магазинов, иначе fallback. Обязательность —
 * как у прошлой операции или по группе категории.
 */
export function suggestCategory(
  state: State,
  kind: "income" | "expense",
  title: string,
  options: { fallback: string; hintFrom?: string; useHistory?: boolean },
): { category: string; mandatory: boolean } {
  const learned = options.useHistory === false ? null : learnedCategory(state, kind, title);
  if (learned) return { category: learned.category, mandatory: kind === "expense" && Boolean(learned.mandatory) };
  if (kind === "income") return { category: findCategory(state, options.fallback) ?? options.fallback, mandatory: false };
  const category = hintedCategory(state, options.hintFrom ?? title) ?? findCategory(state, options.fallback) ?? options.fallback;
  return { category, mandatory: isMandatoryCategory(state, category) };
}

function titleOf(op: Extract<SmsOperation, { kind: "income" | "expense" }>): string {
  const who = op.counterparty;
  switch (op.via) {
    case "salary":
      return "Зарплата";
    case "advance":
      return "Аванс";
    case "bonus":
      return "Премия";
    case "interest":
      return "Проценты";
    case "refund":
      return who ? `Возврат: ${who}` : "Возврат покупки";
    case "deposit":
      return who ? `Зачисление: ${who}` : "Зачисление";
    case "cash":
      return "Снятие наличных";
    case "transfer":
      if (op.kind === "income") return who ? `Перевод от ${who}` : "Входящий перевод";
      return who ? `Перевод ${who}` : "Перевод";
    default:
      return who || (op.via === "payment" ? "Оплата" : op.via === "writeoff" ? "Списание" : "Покупка");
  }
}

// ---------- сопоставление с планом ----------

/** На сколько дней раньше плана может прийти доход или пройти платёж — и на сколько позже. */
const MATCH_EARLY_DAYS = { income: 10, expense: 7 } as const;
const MATCH_LATE_DAYS = { income: 5, expense: 7 } as const;

export interface PlannedMatch {
  templateId: string;
  month: MonthKey;
  title: string;
  /** Плановая сумма (из шаблона). */
  planned: Kopecks;
}

/**
 * Регулярный доход или платёж, которому соответствует операция из СМС. Суммы могут отличаться от плана,
 * поэтому сопоставляем прежде всего по смыслу и дате:
 *  - этот шаблон уже подтверждали СМС с тем же магазином или отправителем, и пользователь это проверил
 *    (сумма — не больше чем вдвое от плана);
 *  - зарплата, аванс или премия — шаблон с той же категорией (сумма — в пределах ±60 %);
 *  - название шаблона совпадает с магазином (сумма — в пределах ±60 %);
 *  - та же категория (сумма — в пределах ±40 %);
 *  - сумма совпадает до копейки и дата — в пределах 3 дней, если магазина в СМС нет;
 *  - перевод без получателя на ту же сумму (±10 %) в пределах 3 дней.
 * Из подходящих выбирается самый уверенный, затем ближайший по дате и сумме. Не рассматриваются пропущенные
 * месяцы и начисления, которые уже не плановые: подтверждённые СМС или Siri, исправленные вручную —
 * их не перезаписываем, такая СМС станет отдельной операцией.
 */
export function matchPlanned(
  state: State,
  op: Extract<SmsOperation, { kind: "income" | "expense" }>,
  date: IsoDate,
  category: string,
): PlannedMatch | null {
  const counterparty = normalizeName(op.counterparty);
  const smsMonth = monthKeyOf(date);
  const months = [addMonths(smsMonth, -1), smsMonth, addMonths(smsMonth, 1)];
  const occurrences = new Map<string, Transaction>();
  const confirmedNotes = new Map<string, string[]>();
  for (const t of state.transactions) {
    if (!t.templateId || !t.occurrenceMonth) continue;
    occurrences.set(`${t.templateId}|${t.occurrenceMonth}`, t);
    // Учимся только на сопоставлениях, которые пользователь проверил: ошибочное не должно закрепляться.
    if (t.note.startsWith(SMS_NOTE_PREFIX) && !t.review) {
      const list = confirmedNotes.get(t.templateId) ?? [];
      list.push(normalizeName(t.note));
      confirmedNotes.set(t.templateId, list);
    }
  }
  const payroll = op.kind === "income" && (op.via === "salary" || op.via === "advance" || op.via === "bonus");

  let best: { match: PlannedMatch; score: number } | null = null;
  for (const template of state.templates) {
    if (!template.active || template.kind !== op.kind) continue;
    const learned = counterparty.length >= 3 && (confirmedNotes.get(template.id) ?? []).some((n) => n.includes(counterparty));
    const titleKey = normalizeName(template.title);
    const titleMatch =
      counterparty.length >= 3 && titleKey.length >= 3 && (counterparty.includes(titleKey) || titleKey.includes(counterparty));
    const categoryMatch = normalizeName(template.category) === normalizeName(category);
    const diff = Math.abs(op.amount - template.amount) / template.amount;

    for (const month of months) {
      const planned = occurrenceDate(template, month);
      if (planned < template.startDate) continue;
      const shift = diffDays(planned, date); // > 0 — СМС позже плана
      if (shift > MATCH_LATE_DAYS[op.kind] || -shift > MATCH_EARLY_DAYS[op.kind]) continue;
      if (isSkipped(state, template.id, month)) continue;
      const existing = occurrences.get(`${template.id}|${month}`);
      // Начисление уже не плановое (подтверждено или исправлено) — не трогаем его.
      if (existing && !isPristineOccurrence(existing, template, planned)) continue;
      const distance = Math.abs(shift);

      let strength = 0;
      if (learned && diff <= 1) strength = 5;
      else if (payroll && categoryMatch && diff <= 0.6) strength = 4;
      else if (titleMatch && diff <= 0.6) strength = 3;
      else if (categoryMatch && diff <= 0.4) strength = 2;
      else if (diff === 0 && distance <= 3 && !counterparty) strength = 2;
      else if (op.via === "transfer" && !counterparty && diff <= 0.1 && distance <= 3) strength = 1;
      if (!strength) continue;

      // Дата важнее суммы: из двух шаблонов одной категории выбираем ближайший по сроку.
      const score = strength * 1000 - distance * 20 - diff * 50;
      if (!best || score > best.score) {
        best = { match: { templateId: template.id, month, title: template.title, planned: template.amount }, score };
      }
    }
  }
  return best?.match ?? null;
}

/** Начисление в том виде, как его создала синхронизация шаблонов: ещё никто не подтверждал и не правил. */
function isPristineOccurrence(tx: Transaction, template: State["templates"][number], planned: IsoDate): boolean {
  return tx.amount === template.amount && tx.date === planned && tx.note === template.note;
}

export interface SmsPlan {
  actions: Action[];
  /** Что добавлено — для уведомления «Команд». */
  summary: string;
}

/**
 * Действия для операции из СМС. idBase — устойчивый id (по тексту СМС): повторная отправка той же СМС
 * не создаст вторую операцию.
 */
/** Заметка операции из СМС: сам текст СМС. По ней же узнаём повторно присланную СМС и уже подтверждённые начисления. */
export const SMS_NOTE_PREFIX = "СМС: ";

export function smsNote(sms: string): string {
  return `${SMS_NOTE_PREFIX}${normalizeSms(sms)}`.slice(0, LIMITS.note).trim();
}

export function planSmsImport(state: State, op: SmsOperation, ctx: { idBase: string; date: IsoDate; sms: string }): SmsPlan {
  const note = smsNote(ctx.sms);
  const money = formatMoney(op.amount);

  if (op.kind === "toSavings" || op.kind === "fromSavings") {
    const amount = op.kind === "toSavings" ? op.amount : -op.amount;
    return {
      actions: [{ type: "savings.move", id: ctx.idBase, date: ctx.date, amount, note, review: true }],
      summary: op.kind === "toSavings" ? `В сбережения ${money}` : `Из сбережений ${money}`,
    };
  }

  if (op.kind === "savingsInterest") {
    // Доход месяца, который сразу лежит в сбережениях: на остаток счёта не влияет.
    const category = findCategory(state, INCOME_CATEGORY.interest) ?? INCOME_CATEGORY.interest;
    return {
      actions: [
        {
          type: "tx.add",
          tx: {
            id: ctx.idBase,
            type: "income",
            amount: op.amount,
            date: ctx.date,
            category,
            title: "Проценты по накопительному счёту",
            note,
            mandatory: false,
            autoSaving: false,
            review: true,
          },
        },
        { type: "savings.move", id: `${ctx.idBase}.m`, date: ctx.date, amount: op.amount, note, review: true },
      ],
      summary: `Проценты ${money} → в сбережения`,
    };
  }

  const title = titleOf(op).slice(0, LIMITS.title).trim();
  const useHistory = Boolean(op.counterparty) || op.via === "transfer";
  const { category, mandatory } =
    op.kind === "income"
      ? suggestCategory(state, "income", title, { fallback: INCOME_CATEGORY[op.via], useHistory })
      : suggestCategory(state, "expense", title, { fallback: EXPENSE_FALLBACK[op.via], hintFrom: op.counterparty, useHistory });

  // Запланированный регулярный платёж или доход: отмечаем его фактическими суммой и датой, а не добавляем второй раз.
  const planned = matchPlanned(state, op, ctx.date, category);
  if (planned) {
    const differs = planned.planned !== op.amount ? ` (по плану ${formatMoney(planned.planned)})` : "";
    return {
      actions: [
        {
          type: "occurrence.confirm",
          templateId: planned.templateId,
          month: planned.month,
          amount: op.amount,
          date: ctx.date,
          note,
          review: true,
        },
      ],
      summary: `${op.kind === "income" ? "Доход" : "Расход"} ${money} · ${planned.title} — регулярный${differs}`,
    };
  }

  // «Копилка с покупок» — только с покупок картой: переводы, платежи (банку, за услуги) и снятие наличных не покупки.
  const notPurchase = op.kind === "expense" && op.via !== "purchase";
  const autoSaving = !notPurchase && autoSavingByDefault({ type: op.kind, amount: op.amount, category }, state.settings);
  return {
    actions: [
      {
        type: "tx.add",
        tx: { id: ctx.idBase, type: op.kind, amount: op.amount, date: ctx.date, category, title, note, mandatory, autoSaving, review: true },
      },
    ],
    summary: `${op.kind === "income" ? "Доход" : "Расход"} ${money} · ${title} → ${category}`,
  };
}
