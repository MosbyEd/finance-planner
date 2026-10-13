import { MAIN_ACCOUNT_ID, SAVINGS_ACCOUNT_ID, accountBalance, accountCards, accountKeys, accountsOf, findAccount } from "./accounts";
import { applyActions, type Action } from "./actions";
import { addDays, addMonths, diffDays, monthKeyOf, type IsoDate, type MonthKey } from "./dates";
import { OTHER_CATEGORY } from "./defaults";
import { formatMoney, MAX_KOPECKS, type Kopecks } from "./money";
import { isSkipped, occurrenceDate } from "./recurring";
import { autoSavingByDefault } from "./savings";
import { LIMITS, type Account, type State, type Transaction } from "./schema";

/**
 * Операции из СМС банков. iOS не даёт приложениям читать СМС, поэтому текст присылает автоматизация «Команд»;
 * здесь — только разбор текста и выбор категории, без сети и базы. Какой банк прислал СМС, определяет banks.ts.
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
  | { kind: "fromSavings"; amount: Kopecks; time: string | null }
  /** Перевод на свой счёт («Перевод 1000р на СЧЁТ1234»): не расход, а перевод между счетами. */
  | { kind: "ownTransfer"; amount: Kopecks; time: string | null };

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
/** Способ оплаты между словом и суммой: «Покупка по СБП 350р», «Оплата по QR-коду СБП 500р». */
const VIA_SBP = String.raw`(?:\s+по\s+(?:QR-?коду(?:\s+СБП)?|СБП))?`;

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

/** Похоже на операцию: есть сумма в рублях и это не код, отказ или реклама. Для «не разобрали СМС банка». */
export function looksLikeOperation(raw: string): boolean {
  const text = normalizeSms(raw);
  return !NOT_OPERATION.test(text) && /\d\s?(?:руб|р\.|р(?![а-яё])|₽|RUB|RUR)/iu.test(text);
}

/** Разбирает СМС Сбербанка (900). Не операция или незнакомый формат — null. */
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
    // Пополнение самого накопительного (СМС с его стороны): деньги пришли с другого своего счёта.
    m = match(String.raw`(?:Зачисление|Пополнение|Поступление)(?:\s+средств)?\s+\+?${AMOUNT}`);
    if (m) {
      const a = amount(m);
      return a ? { kind: "toSavings", amount: a, time } : null;
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

  // Входящий перевод: «Перевод 800р от Валерия В.», «Перевод из Т-Банк +5000р от ИВАН И.»,
  // «Перевод по СБП из Альфа-Банк +10р от ЭДУАРД К.».
  m = on(String.raw`Перевод(?:\s+по\s+СБП)?(?:\s+(?:из|с)\s+.+?)?\s+\+?${AMOUNT}\s+от\s+(.+)$`);
  if (m) return income("transfer", m, m[3]);

  // Возврат и отмена покупки.
  m = on(String.raw`(?:Возврат покупки|Отмена покупки|Возврат)\s+${AMOUNT}${TAIL}`);
  if (m) return income("refund", m, m[3]);

  // Прочие зачисления: «Зачисление 1500р …», «Пополнение 1000р», «Поступление 500р».
  m = on(String.raw`(?:Зачисление|Пополнение|Поступление)(?:\s+(?:перевода|средств))?\s+\+?${AMOUNT}${TAIL}`);
  if (m) return income("deposit", m, m[3]);

  // «Вам перевели 1000р от …», «Получен перевод 1000р от …», «Зачислен перевод 1000р …».
  m = on(String.raw`(?:Вам перевели|Получен перевод|Зачислен перевод|Входящий перевод)\s+\+?${AMOUNT}(?:\s+от)?${TAIL}`);
  if (m) return income("transfer", m, m[3]);

  // Перевод с «+» перед суммой — входящий: «Перевод с карты *1234 +1000р», «Перевод +1000р».
  m = on(String.raw`Перевод(?:\s+по\s+СБП)?(?:\s+(?:с|из)\s+.+?)?\s+\+${AMOUNT}(?:\s+от)?${TAIL}`);
  if (m) return income("transfer", m, m[3]);

  m = on(String.raw`Покупка${VIA_SBP}\s+${AMOUNT}${TAIL}`);
  if (m) return expense("purchase", m, m[3]);

  m = on(String.raw`Оплата(?:\s+услуг)?${VIA_SBP}\s+${AMOUNT}${TAIL}`);
  if (m) return expense("payment", m, m[3]);

  m = on(String.raw`Выдача(?:\s+наличных)?\s+${AMOUNT}${TAIL}`);
  if (m) return expense("cash", m);

  // Исходящий перевод: «перевод 3000р OZON», «перевод 8000р», «Перевод по СБП 500р для ИВАН И.».
  m = on(String.raw`Перевод(?:\s+по СБП)?\s+${AMOUNT}${TAIL}`);
  if (m) {
    const to = clean(m[3]).replace(/^(?:для|получателю|на имя)\s+/iu, "");
    // На свой счёт («на СЧЁТ5804») — деньги остаются у вас, это не расход.
    if (/^на\s+(?:СЧ[ЁЕ]Т|сч[её]т)/iu.test(to)) {
      const a = amount(m);
      return a ? { kind: "ownTransfer", amount: a, time } : null;
    }
    return expense("transfer", m, to);
  }

  m = on(String.raw`Списание${VIA_SBP}\s+${AMOUNT}${TAIL}`);
  if (m) return expense("writeoff", m, m[3]);

  return null;
}

/** Форматы СМС банков, которые приложение знает (см. KNOWN_BANKS в banks.ts). */
export type SmsFormat = "sber" | "tbank" | "alfa" | "vtb";

/** Разбор по формату банка; null — СМС этого банка пока не разбираем (нужны примеры). */
export const SMS_PARSERS: Record<SmsFormat, ((text: string) => SmsOperation | null) | null> = {
  sber: parseSberSms,
  tbank: null,
  alfa: null,
  vtb: null,
};

/** СМС, разобранная любым известным разбором (банк неизвестен): формат и операция. */
export function parseKnownSms(text: string): { format: SmsFormat; op: SmsOperation } | null {
  for (const [format, parse] of Object.entries(SMS_PARSERS) as [SmsFormat, ((text: string) => SmsOperation | null) | null][]) {
    const op = parse?.(text);
    if (op) return { format, op };
  }
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

/**
 * Как пользователь записал такую операцию в прошлый раз: последняя проверенная им операция из СМС
 * с тем же магазином или отправителем. Её название и категория важнее всего: он мог переименовать
 * «IP KASYANOV A.A» в «Кофе у дома» и поставить свою категорию. Непроверенные не учитываются —
 * ошибочная догадка не должна закрепляться; начисления регулярных платежей — тоже (у них название шаблона).
 */
function rememberedOperation(state: State, op: Extract<SmsOperation, { kind: "income" | "expense" }>): Transaction | null {
  const key = normalizeName(op.counterparty);
  if (key.length < 2) return null;
  for (let i = state.transactions.length - 1; i >= 0; i--) {
    const t = state.transactions[i];
    if (t.review || t.type !== op.kind || t.templateId || !t.category || !t.note.startsWith(SMS_NOTE_PREFIX)) continue;
    const past = parseKnownSms(t.note.slice(SMS_NOTE_PREFIX.length))?.op;
    if (past && past.kind === op.kind && normalizeName(past.counterparty) === key) return t;
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
  /** Добавлять нечего: перевод на свой счёт, которого нет в приложении, или операция уже учтена. */
  skip?: { status: "ignored" | "duplicate"; message: string };
}

// ---------- счета из СМС ----------

/** Цифры карты или счёта в СМС: «MIR-7759», «СЧЁТ5804», «*3150», «VISA1234». */
const ACCOUNT_KEY_RE = /(?:MIR|VISA|MC|ECMC|MAESTRO|СЧ[ЁЕ]Т|\*)\s?-?(\d{4})(?!\d)/giu;

/**
 * Цифры счёта, к которому относится СМС (source), и счёта, куда ушли деньги (target — после «на»):
 * «Накопительный счет *3150 16:16 Перевод 9501р на СЧЁТ5804» → 3150 и 5804.
 */
export function smsAccountKeys(raw: string): { source: string | null; target: string | null } {
  const text = normalizeSms(raw).replace(/\s*Баланс.*$/iu, "");
  const on = text.search(/\sна\s/iu);
  let source: string | null = null;
  let target: string | null = null;
  for (const m of text.matchAll(ACCOUNT_KEY_RE)) {
    if (on >= 0 && (m.index ?? 0) > on) target ??= m[1];
    else source ??= m[1];
  }
  return { source, target };
}

/**
 * Открытый счёт с этими цифрами (их указывают в настройках счёта). Одни и те же цифры могут быть у карт разных
 * банков: сначала — счёт банка этой СМС, потом — счёт без банка, потом — любой.
 */
export function accountForKey(state: State, key: string | null, bankId?: string): Account | undefined {
  if (!key) return undefined;
  const found = accountsOf(state).filter((a) => !a.archived && accountKeys(a).includes(key));
  const rank = (a: Account) => (bankId && a.bankId === bankId ? 0 : !a.bankId ? 1 : 2);
  return found.sort((a, b) => rank(a) - rank(b))[0];
}

/** Единственный открытый счёт банка — на него операции из СМС этого банка без знакомых цифр. */
function onlyBankAccount(state: State, bankId: string | undefined): Account | undefined {
  if (!bankId) return undefined;
  const own = accountsOf(state).filter((a) => !a.archived && a.bankId === bankId);
  return own.length === 1 ? own[0] : undefined;
}

/** Общие слова в названиях счетов — по ним свой счёт в СМС не узнать. */
const GENERIC_NAME_WORDS = new Set([
  "банк", "bank", "карта", "карты", "карточка", "счет", "счета", "кредитка", "кредитная", "кредитный", "кредит",
  "дебетовая", "дебетовый", "основной", "основная", "накопительный", "накопительная", "сбережения", "вклад", "мой",
  "моя", "мир", "mir", "visa", "mastercard", "наличные", "зарплатная", "зарплатный", "виртуальная", "золотая",
  "platinum", "black", "премиум", "новая", "старая",
]);

/** Значимые слова названия счёта: «Альфа кредитка» → ["альфа"], «Т-Банк» → ["т банк"]. */
function nameTokens(name: string): string[] {
  const words = normalizeName(name).split(" ").filter(Boolean);
  const tokens = words.filter((w) => w.length >= 3 && !GENERIC_NAME_WORDS.has(w));
  // Короткое название банка («Т-Банк») — целиком.
  if (!tokens.length && words.length > 1 && words.join(" ").length >= 4) tokens.push(words.join(" "));
  return tokens;
}

/**
 * Свой счёт по названию банка или получателя в СМС: «Перевод по СБП из Альфа-Банк +57р» при счёте «Альфа» —
 * деньги пришли с этого счёта; «Оплата 4000р Альфа-банк» при кредитке «Альфа» — её погашение.
 */
function accountByName(state: State, text: string, exclude: string | undefined): Account | undefined {
  const hay = normalizeName(text);
  if (!hay) return undefined;
  const words = hay.split(" ");
  return accountsOf(state).find(
    (a) =>
      !a.archived &&
      a.id !== exclude &&
      nameTokens(a.name).some((t) => (t.includes(" ") ? ` ${hay} `.includes(` ${t} `) : words.some((w) => w.startsWith(t)))),
  );
}

/** Банк, из которого пришёл перевод: «Перевод по СБП из Альфа-Банк +57р …» → «Альфа-Банк». */
function smsFromBank(raw: string): string {
  return /\s(?:из|с)\s+([^+\d*][^+]*?)\s+\+?\d/iu.exec(normalizeSms(raw))?.[1] ?? "";
}

/** Поле счёта для операции: основной счёт не пишем (его и так подразумевает операция без счёта). */
function onAccount(account: Account | undefined): { accountId?: string } {
  return account && account.id !== MAIN_ACCOUNT_ID ? { accountId: account.id } : {};
}

function nearDate(a: IsoDate, b: IsoDate): boolean {
  return Math.abs(diffDays(a, b)) <= 1;
}

/** Куда пришли деньги перемещения между своими счетами (у снятия со сбережений — на счёт, куда сняли). */
function moveTarget(tx: Transaction): string | null {
  if (tx.type === "transfer") return tx.toAccountId ?? null;
  if (tx.type === "saving") return tx.amount > 0 ? (tx.toAccountId ?? SAVINGS_ACCOUNT_ID) : (tx.accountId ?? MAIN_ACCOUNT_ID);
  return null;
}

/**
 * Перемещение, уже записанное по другой СМС того же перевода: банк присылает списание и зачисление отдельно.
 * Пара — только СМС с другой стороны (другие цифры счёта): два разных пополнения на одну сумму в один день
 * с одного счёта — это две операции, а не одна.
 */
function pairedMove(state: State, to: string, amount: Kopecks, date: IsoDate, sideKey: string | null): Transaction | undefined {
  return state.transactions.find((t) => {
    if (!t.note.startsWith(SMS_NOTE_PREFIX) || moveTarget(t) !== to || Math.abs(t.amount) !== amount || !nearDate(t.date, date)) {
      return false;
    }
    const otherSide = smsAccountKeys(t.note.slice(SMS_NOTE_PREFIX.length)).source;
    return otherSide !== sideKey && (otherSide !== null || sideKey !== null);
  });
}

/**
 * Регулярный платёж с этого счёта на тот, срок которого рядом с датой СМС (за неделю до или после) и который
 * ещё не исполнен: начисления нет или оно плановое (никто не подтверждал и не правил).
 */
function plannedMoveFor(state: State, from: string, to: string, date: IsoDate): { template: State["templates"][number]; month: MonthKey } | null {
  const smsMonth = monthKeyOf(date);
  for (const template of state.templates) {
    if (!template.active || template.kind !== "expense" || template.toAccountId !== to) continue;
    if ((template.accountId ?? MAIN_ACCOUNT_ID) !== from) continue;
    for (const month of [smsMonth, addMonths(smsMonth, -1), addMonths(smsMonth, 1)]) {
      const planned = occurrenceDate(template, month);
      if (planned < template.startDate || Math.abs(diffDays(planned, date)) > 7 || isSkipped(state, template.id, month)) continue;
      const existing = state.transactions.find((t) => t.templateId === template.id && t.occurrenceMonth === month);
      if (existing && !isPristineOccurrence(existing, template, planned)) continue;
      return { template, month };
    }
  }
  return null;
}

/**
 * Деньги между своими счетами по СМС: на накопительный — пополнение сбережений (отложено в этом месяце),
 * с накопительного — снятие, между остальными (погашение кредитки) — перевод. Вторая СМС того же перевода
 * пропускается; зачисление, записанное раньше доходом (ещё не проверенное), заменяется перемещением.
 */
function planMove(
  state: State,
  amount: Kopecks,
  from: Account | undefined,
  to: Account,
  ctx: { idBase: string; date: IsoDate; note: string; sideKey: string | null },
): SmsPlan {
  const source = from ?? findAccount(state, MAIN_ACCOUNT_ID);
  if (!source || source.id === to.id) {
    return { actions: [], summary: "", skip: { status: "ignored", message: "Перевод на тот же счёт — пропущено." } };
  }
  if (pairedMove(state, to.id, amount, ctx.date, ctx.sideKey)) {
    return { actions: [], summary: "", skip: { status: "duplicate", message: "Уже учтено — это вторая СМС того же перевода." } };
  }
  const income = state.transactions.find(
    (t) =>
      t.type === "income" &&
      t.review &&
      (t.accountId ?? MAIN_ACCOUNT_ID) === to.id &&
      t.amount === amount &&
      t.note.startsWith(SMS_NOTE_PREFIX) &&
      nearDate(t.date, ctx.date),
  );
  const replaced: Action[] = income ? [{ type: "tx.delete", id: income.id }] : [];
  const money = formatMoney(amount);
  const base = { id: ctx.idBase, date: ctx.date, note: ctx.note, review: true };
  // Регулярный платёж на этот счёт (погашение кредитки, пополнение накопительного) — отмечаем его исполненным.
  const planned = plannedMoveFor(state, source.id, to.id, ctx.date);
  if (planned) {
    const differs = planned.template.amount !== amount ? ` (по плану ${formatMoney(planned.template.amount)})` : "";
    return {
      actions: [
        ...replaced,
        {
          type: "occurrence.confirm",
          templateId: planned.template.id,
          month: planned.month,
          amount,
          date: ctx.date,
          note: ctx.note,
          review: true,
        },
      ],
      summary: `${planned.template.title} ${money} — регулярный${differs}`,
    };
  }
  if (to.kind === "savings" && source.kind !== "savings") {
    return {
      actions: [
        ...replaced,
        { type: "savings.move", ...base, amount, ...onAccount(source), ...(to.id !== SAVINGS_ACCOUNT_ID ? { toAccountId: to.id } : {}) },
      ],
      summary: `В сбережения ${money}${to.id !== SAVINGS_ACCOUNT_ID ? ` · ${to.name}` : ""}`,
    };
  }
  if (source.kind === "savings" && to.kind !== "savings") {
    return {
      actions: [
        ...replaced,
        {
          type: "savings.move",
          ...base,
          amount: -amount,
          ...onAccount(to),
          ...(source.id !== SAVINGS_ACCOUNT_ID ? { toAccountId: source.id } : {}),
        },
      ],
      summary: `Из сбережений ${money}${source.id !== SAVINGS_ACCOUNT_ID ? ` · ${source.name}` : ""}`,
    };
  }
  return {
    actions: [...replaced, { type: "transfer.add", ...base, from: source.id, to: to.id, amount }],
    summary: `Перевод ${money}: ${source.name} → ${to.name}`,
  };
}

/** Заметка операции из СМС: сам текст СМС. По ней же узнаём повторно присланную СМС и уже подтверждённые начисления. */
export const SMS_NOTE_PREFIX = "СМС: ";

export function smsNote(sms: string): string {
  return `${SMS_NOTE_PREFIX}${normalizeSms(sms)}`.slice(0, LIMITS.note).trim();
}

/**
 * Остатки из СМС: «Баланс: 5260.14р» — счёт этой СМС (key = null); «Баланс счёта *3150: 0р, баланс *5804: 9560р» —
 * по каждому счёту.
 */
export function smsBalances(raw: string): { key: string | null; amount: Kopecks }[] {
  const text = normalizeSms(raw);
  const result: { key: string | null; amount: Kopecks }[] = [];
  const re = new RegExp(String.raw`Баланс(?:\s+(?:сч[её]та|карты))?\s*(?:\*\s?(\d{4}))?\s*:\s*(-?)${AMOUNT}`, "giu");
  for (const m of text.matchAll(re)) {
    // Остаток может быть нулевым (amountOf нули не пропускает — это сумма операции).
    const amount = Number(m[3].replace(/ /g, "")) * 100 + (m[4] ? Number(m[4].padEnd(2, "0")) : 0);
    if (Number.isSafeInteger(amount) && amount <= MAX_KOPECKS) result.push({ key: m[1] ?? null, amount: m[2] ? -amount : amount });
  }
  return result;
}

/** Цифры накопительных счетов в СМС: «Накопительный счет *3150». */
function savingsKeysIn(sms: string): Set<string> {
  return new Set([...normalizeSms(sms).matchAll(/Накопительн\S*\s+сч[её]т\S*\s*\*\s?(\d{4})/giu)].map((m) => m[1]));
}

/**
 * Счёт для цифр из СМС. Цифры, которых нет ни у одного счёта, — основной, пока у него самого цифр нет (туда же
 * записываются и операции по таким цифрам). Но не цифры накопительного: его остаток с основным не сравнить.
 */
function balanceAccount(state: State, key: string | null, savingsKeys: Set<string>, bankId?: string): Account | undefined {
  const known = accountForKey(state, key, bankId);
  if (known) return known;
  if (key && savingsKeys.has(key)) return undefined;
  const own = onlyBankAccount(state, bankId);
  if (own) return accountKeys(own).length ? undefined : own;
  const main = findAccount(state, MAIN_ACCOUNT_ID);
  // Основной счёт другого банка — не сюда.
  return main && !main.archived && !accountKeys(main).length && (!bankId || !main.bankId || main.bankId === bankId) ? main : undefined;
}

/**
 * Сверка остатка по СМС: после операции сравниваем «Баланс» из СМС с остатком счёта в приложении и запоминаем
 * расхождение — приложение предложит поправить. У кредитки в СМС доступный лимит, а не долг — её не сверяем.
 * Баланс без цифр счёта относится к счёту этой СМС. unmatched — цифры, остаток по которым сверить не с чем
 * (у счёта в приложении их не указали): уведомление подскажет, где их добавить.
 */
function bankBalanceActions(
  state: State,
  actions: Action[],
  ctx: { date: IsoDate; sms: string; bankId?: string },
): { actions: Action[]; unmatched: string[] } {
  const none = { actions: [], unmatched: [] };
  const balances = smsBalances(ctx.sms);
  if (!balances.length) return none;
  let after: State;
  try {
    after = applyActions(state, actions);
  } catch {
    return none;
  }
  const keys = smsAccountKeys(ctx.sms);
  const savingsKeys = savingsKeysIn(ctx.sms);
  const unmatched: string[] = [];
  const byKey = (key: string | null) => {
    const account = balanceAccount(state, key, savingsKeys, ctx.bankId);
    if (!account && key && !unmatched.includes(key)) unmatched.push(key);
    return account;
  };
  // Накопительные счета без цифр из СМС (в том числе «Сбережения» по умолчанию с «копилкой») — конверты внутри
  // основного счёта: в банке эти деньги лежат на нём же.
  const envelopes = accountsOf(state).filter((a) => a.kind === "savings" && !accountKeys(a).length && !a.spending && !a.archived);
  const appBalance = (id: string) =>
    accountBalance(after, id, ctx.date) +
    (id === MAIN_ACCOUNT_ID ? envelopes.reduce((sum, a) => sum + accountBalance(after, a.id, ctx.date), 0) : 0);
  const result: Action[] = [];
  const seen = new Set<string>();
  for (const balance of balances) {
    const account = byKey(balance.key ?? keys.source);
    if (!account || account.kind === "credit" || seen.has(account.id)) continue;
    seen.add(account.id);
    const delta = balance.amount - appBalance(account.id);
    result.push({ type: "account.bank", accountId: account.id, amount: balance.amount, delta, date: ctx.date });
  }
  return { actions: result, unmatched };
}

/**
 * Снятие с накопительного больше, чем на нём в приложении. Чаще всего это деньги, которые банк откладывал сам
 * (округления, автопереводы без СМС): в приложении они так и не уходили с основного счёта. Поэтому денег
 * не придумываем — снятие записывается на столько, сколько на счёте в приложении (или не записывается вовсе),
 * а остаток основного сверяется с «Балансом» из СМС: если разница всё же есть, приложение предложит её поправить.
 */
function capSavingsWithdrawals(state: State, actions: Action[], date: IsoDate): { actions: Action[]; notes: string[] } {
  try {
    applyActions(state, actions);
    return { actions, notes: [] };
  } catch {
    // Не прошло — смотрим, не в нехватке ли на накопительном дело.
  }
  const left = new Map<string, Kopecks>();
  const available = (id: string) => left.get(id) ?? Math.max(0, accountBalance(state, id, date));
  const notes: string[] = [];
  const capped: Action[] = [];
  for (const a of actions) {
    const withdrawal =
      a.type === "savings.move" && a.amount < 0
        ? { account: a.toAccountId ?? SAVINGS_ACCOUNT_ID, amount: -a.amount }
        : a.type === "transfer.add" && findAccount(state, a.from)?.kind === "savings"
          ? { account: a.from, amount: a.amount }
          : null;
    if (!withdrawal || available(withdrawal.account) >= withdrawal.amount) {
      if (withdrawal) left.set(withdrawal.account, available(withdrawal.account) - withdrawal.amount);
      capped.push(a);
      continue;
    }
    const have = available(withdrawal.account);
    const name = findAccount(state, withdrawal.account)?.name ?? "";
    left.set(withdrawal.account, 0);
    if (have <= 0) {
      notes.push(`на «${name}» в приложении пусто — снятие не записано: эти деньги приложение и так считало на счёте`);
      continue;
    }
    notes.push(`на «${name}» в приложении было только ${formatMoney(have)} — записано столько`);
    capped.push(a.type === "savings.move" ? { ...a, amount: -have } : a.type === "transfer.add" ? { ...a, amount: have } : a);
  }
  try {
    applyActions(state, capped);
    return { actions: capped, notes };
  } catch {
    return { actions, notes: [] };
  }
}

/**
 * Операция пришла позже, а расхождение с банком из-за неё уже поправили корректировкой («Поправить» на Главной):
 * корректировка на ту же сумму по тому же счёту в ближайшие дни после операции заменяется самой операцией —
 * иначе деньги учлись бы дважды.
 */
function replacedCorrections(state: State, actions: Action[], date: IsoDate): { actions: Action[]; notes: string[] } {
  let after: State;
  try {
    after = applyActions(state, actions);
  } catch {
    return { actions: [], notes: [] };
  }
  const horizon = addDays(date, 30);
  const deletes: Action[] = [];
  const notes: string[] = [];
  for (const account of accountsOf(state)) {
    const effect = accountBalance(after, account.id, horizon) - accountBalance(state, account.id, horizon);
    if (effect === 0) continue;
    const correction = state.transactions.find(
      (t) =>
        t.type === "adjustment" &&
        !t.loanId &&
        (t.accountId ?? MAIN_ACCOUNT_ID) === account.id &&
        t.amount === effect &&
        t.date >= date &&
        t.date <= addDays(date, 3) &&
        !deletes.some((d) => d.type === "tx.delete" && d.id === t.id),
    );
    if (!correction) continue;
    deletes.push({ type: "tx.delete", id: correction.id });
    notes.push(`заменила корректировку остатка «${account.name}» на ту же сумму`);
  }
  return { actions: deletes, notes };
}

/** Операция из СМС: устойчивый id, дата, текст и банк, приславший СМС (по нему ищем счёт по цифрам карты). */
export interface SmsContext {
  idBase: string;
  date: IsoDate;
  sms: string;
  bankId?: string;
}

/**
 * Действия для операции из СМС. idBase — устойчивый id (по тексту СМС): повторная отправка той же СМС
 * не создаст вторую операцию. Остаток из СМС сверяется с приложением (account.bank) — даже если сама операция
 * уже учтена второй СМС того же перевода: в той СМС остаток другого счёта.
 */
export function planSmsImport(state: State, op: SmsOperation, ctx: SmsContext): SmsPlan {
  const plan = planOperation(state, op, ctx);
  if (plan.skip?.status === "ignored") return plan;
  const capped = capSavingsWithdrawals(state, plan.actions, ctx.date);
  const replaced = replacedCorrections(state, capped.actions, ctx.date);
  const actions = [...replaced.actions, ...capped.actions];
  const bank = bankBalanceActions(state, actions, ctx);
  const notes = [...capped.notes, ...replaced.notes, ...bank.unmatched.map((key) => `остаток *${key} не сверен: укажите эти цифры у счёта (Настройки → Счета)`)];
  const text = notes.join("; ");
  const summary = text && plan.summary ? `${plan.summary}. ${text[0].toUpperCase()}${text.slice(1)}.` : plan.summary;
  // Снятие не записано и сверять нечего — сообщаем почему, ничего не добавляя.
  if (plan.actions.length && !actions.length && !bank.actions.length) {
    return { actions: [], summary, skip: { status: "ignored", message: summary } };
  }
  return { ...plan, actions: [...actions, ...bank.actions], summary };
}

function planOperation(state: State, op: SmsOperation, ctx: SmsContext): SmsPlan {
  const note = smsNote(ctx.sms);
  const money = formatMoney(op.amount);
  // Счета по цифрам карты из СМС (их указывают в настройках счёта), среди счетов банка этой СМС. Цифр нет
  // или они незнакомы — единственный счёт банка, иначе основной счёт и «Сбережения».
  const keys = smsAccountKeys(ctx.sms);
  const source = accountForKey(state, keys.source, ctx.bankId) ?? onlyBankAccount(state, ctx.bankId);
  const target = accountForKey(state, keys.target, ctx.bankId);
  const savingsAccount = (a: Account | undefined) => (a?.kind === "savings" ? a : undefined);
  const notSavings = (a: Account | undefined) => (a && a.kind !== "savings" ? a : undefined);
  const defaultSavings = findAccount(state, SAVINGS_ACCOUNT_ID);
  const main = findAccount(state, MAIN_ACCOUNT_ID);
  const moveCtx = { idBase: ctx.idBase, date: ctx.date, note, sideKey: keys.source };

  if (op.kind === "ownTransfer") {
    if (!target) {
      return { actions: [], summary: "", skip: { status: "ignored", message: "Перевод на свой счёт — не расход, пропущено." } };
    }
    return planMove(state, op.amount, source, target, moveCtx);
  }

  if (op.kind === "toSavings" || op.kind === "fromSavings") {
    // Пополнение: с обычного счёта (или основного) на накопительный — он после «на» или, в СМС с его стороны,
    // в начале. Снятие: с накопительного (он в начале СМС) на счёт после «на» (или основной).
    const savings =
      (op.kind === "toSavings" ? (savingsAccount(target) ?? savingsAccount(source)) : savingsAccount(source)) ?? defaultSavings;
    const other = (op.kind === "toSavings" ? notSavings(source) : notSavings(target)) ?? main;
    if (!savings || !other) return { actions: [], summary: "", skip: { status: "ignored", message: "Не найден счёт для перевода." } };
    return op.kind === "toSavings"
      ? planMove(state, op.amount, other, savings, moveCtx)
      : planMove(state, op.amount, savings, other, moveCtx);
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
        {
          type: "savings.move",
          id: `${ctx.idBase}.m`,
          date: ctx.date,
          amount: op.amount,
          note,
          review: true,
          ...(savingsAccount(source) ? { toAccountId: source?.id } : {}),
        },
      ],
      summary: `Проценты ${money} → в сбережения`,
    };
  }

  // «Перевод 5000р на карту *1234», а *1234 — своя карта (например, кредитка): это погашение, не расход.
  if (op.kind === "expense" && op.via === "transfer" && target && target.id !== (source?.id ?? MAIN_ACCOUNT_ID)) {
    return planMove(state, op.amount, source, target, moveCtx);
  }

  // Зачисление на счёт, на который уже записан перевод с другого своего счёта (СМС о списании пришла раньше).
  // Свой счёт по названию банка или получателя: перевод из «Альфа-Банк» при счёте «Альфа», оплата «Альфа-банк»
  // при кредитке «Альфа» — перемещение между своими счетами, а не доход или расход.
  if (op.kind === "income" && (op.via === "transfer" || op.via === "deposit")) {
    const receiving = source ?? main;
    const from = accountByName(state, smsFromBank(ctx.sms), receiving?.id);
    if (from && receiving) return planMove(state, op.amount, from, receiving, moveCtx);
  }
  if (op.kind === "expense" && (op.via === "transfer" || op.via === "payment") && op.counterparty) {
    const paying = source ?? main;
    const to = accountByName(state, op.counterparty, paying?.id);
    if (to && paying) return planMove(state, op.amount, paying, to, moveCtx);
  }

  // Зачисление-перевод на свой счёт: вторая СМС уже записанного перемещения — пропускаем; на накопительный —
  // это пополнение сбережений с основного счёта, а не доход. Зарплату так не проверяем.
  if (op.kind === "income" && (op.via === "transfer" || op.via === "deposit")) {
    const account = source ?? main;
    if (account && pairedMove(state, account.id, op.amount, ctx.date, keys.source)) {
      return { actions: [], summary: "", skip: { status: "duplicate", message: "Уже учтено — это вторая СМС того же перевода." } };
    }
    if (account?.kind === "savings" && main) return planMove(state, op.amount, main, account, moveCtx);
  }

  // Название и категория — как пользователь записал такую операцию в прошлый раз, иначе из СМС и подсказок.
  const remembered = rememberedOperation(state, op);
  const title = (remembered?.title || titleOf(op)).slice(0, LIMITS.title).trim();
  const useHistory = Boolean(op.counterparty) || op.via === "transfer";
  const { category, mandatory } = remembered
    ? { category: remembered.category, mandatory: op.kind === "expense" && Boolean(remembered.mandatory) }
    : op.kind === "income"
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
          ...(source ? { accountId: source.id } : {}),
        },
      ],
      summary: `${op.kind === "income" ? "Доход" : "Расход"} ${money} · ${planned.title} — регулярный${differs}`,
    };
  }

  // «Копилка с покупок» — только с покупок картой: переводы, платежи (банку, за услуги) и снятие наличных не покупки.
  const notPurchase = op.kind === "expense" && op.via !== "purchase";
  // Цифры из СМС — карта этого счёта (а не номер самого счёта): у операции видно, какой картой платили.
  const card = source && keys.source && accountCards(source).some((c) => c.digits === keys.source) ? keys.source : undefined;
  const autoSaving =
    !notPurchase &&
    autoSavingByDefault({ type: op.kind, amount: op.amount, category, ...onAccount(source), ...(card ? { card } : {}) }, state.settings);
  return {
    actions: [
      {
        type: "tx.add",
        tx: {
          id: ctx.idBase,
          type: op.kind,
          amount: op.amount,
          date: ctx.date,
          category,
          title,
          note,
          mandatory,
          autoSaving,
          review: true,
          ...onAccount(source),
          ...(card ? { card } : {}),
        },
      },
    ],
    summary: `${op.kind === "income" ? "Доход" : "Расход"} ${money} · ${title} → ${category}`,
  };
}

/** Дубль от прежней версии: корректировка накопительного перед снятием по СМС и само снятие. */
export interface LegacySavingsFix {
  /** id корректировки. */
  id: string;
  title: string;
  text: string;
  /** Привести пару к тому, что записывается теперь: снятие — на столько, сколько было в приложении. */
  actions: Action[];
}

/**
 * Прежняя версия (12 октября 2026) при снятии с накопительного, на котором в приложении меньше, добавляла
 * корректировку «sms-….fix» — и деньги, которые банк откладывал сам, учитывались второй раз. Находим такие пары.
 */
export function legacySavingsFixes(state: State): LegacySavingsFix[] {
  const result: LegacySavingsFix[] = [];
  for (const fix of state.transactions) {
    const base = /^(sms-[0-9a-f]+)\.fix\d*$/.exec(fix.id)?.[1];
    if (!base || fix.type !== "adjustment" || fix.amount <= 0) continue;
    const withdrawal = state.transactions.find((t) => t.id === base);
    if (!withdrawal) continue;
    const move =
      withdrawal.type === "saving" && withdrawal.amount < 0
        ? { from: withdrawal.toAccountId ?? SAVINGS_ACCOUNT_ID, to: withdrawal.accountId ?? MAIN_ACCOUNT_ID, amount: -withdrawal.amount }
        : withdrawal.type === "transfer"
          ? { from: withdrawal.accountId ?? MAIN_ACCOUNT_ID, to: withdrawal.toAccountId ?? MAIN_ACCOUNT_ID, amount: withdrawal.amount }
          : null;
    if (!move || (fix.accountId ?? MAIN_ACCOUNT_ID) !== move.from) continue;
    const keep = Math.max(0, move.amount - fix.amount);
    const source = findAccount(state, move.from);
    const target = findAccount(state, move.to);
    const actions: Action[] = [
      keep > 0 ? { type: "tx.move", id: base, date: withdrawal.date, from: move.from, to: move.to, amount: keep } : { type: "tx.delete", id: base },
      { type: "tx.delete", id: fix.id },
    ];
    // Расхождение с банком у счёта, куда пришли деньги, считалось с лишней суммой — пересчитываем.
    if (target?.bank && target.bank.date >= withdrawal.date) {
      actions.push({ type: "account.bank", accountId: target.id, amount: target.bank.amount, delta: target.bank.delta + (move.amount - keep), date: target.bank.date });
    }
    result.push({
      id: fix.id,
      title: `«${source?.name ?? ""}»: корректировка ${formatMoney(fix.amount)} повторяет снятие по СМС`,
      text:
        keep > 0
          ? `Убрать корректировку — снятие останется на ${formatMoney(keep)}, сколько было в приложении. Остальное приложение и так считало на «${target?.name ?? ""}».`
          : `Убрать корректировку и снятие: эти деньги приложение и так считало на «${target?.name ?? ""}».`,
      actions,
    });
  }
  return result;
}
