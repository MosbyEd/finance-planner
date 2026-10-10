/**
 * Деньги храним в копейках (целые числа), чтобы не было ошибок округления float.
 */
export type Kopecks = number;

/** Максимальная сумма одной операции: 1 млрд ₽. */
export const MAX_KOPECKS = 100_000_000_000;

export function rublesToKopecks(rubles: number): Kopecks {
  return Math.round(rubles * 100);
}

export function kopecksToRubles(kopecks: Kopecks): number {
  return kopecks / 100;
}

/** Округление до целых рублей (результат в копейках). */
export function roundToRubles(kopecks: Kopecks): Kopecks {
  return Math.round(kopecks / 100) * 100;
}

/** Процент от суммы, округлённый до целых рублей. */
export function percentOf(kopecks: Kopecks, percent: number): Kopecks {
  return roundToRubles((kopecks * percent) / 100);
}

/**
 * Разбор суммы, введённой человеком. Понимает «12 500», «12 500,50», «12500.5»,
 * «1.000.000», «1,000,000.25». Один разделитель с 1–2 цифрами после него — дробная часть,
 * ровно с 3 цифрами — разделитель тысяч. Возвращает копейки или null, если строка не сумма.
 */
export function parseAmount(input: string, options: { allowNegative?: boolean } = {}): Kopecks | null {
  let s = input.replace(/[\s  '₽]/g, "").replace(/руб\.?$|р\.?$/i, "");
  if (!s) return null;

  let negative = false;
  if (s.startsWith("-") || s.startsWith("−")) {
    if (!options.allowNegative) return null;
    negative = true;
    s = s.slice(1);
  }
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return null;

  const lastDot = s.lastIndexOf(".");
  const lastComma = s.lastIndexOf(",");
  let integerPart: string;
  let fractionPart = "";

  if (lastDot >= 0 && lastComma >= 0) {
    // Оба разделителя: последний — дробный, другой — группировка тысяч.
    const decimalSep = lastDot > lastComma ? "." : ",";
    const groupSep = decimalSep === "." ? "," : ".";
    const decimalIndex = s.lastIndexOf(decimalSep);
    if (s.indexOf(decimalSep) !== decimalIndex) return null;
    integerPart = s.slice(0, decimalIndex);
    fractionPart = s.slice(decimalIndex + 1);
    if (!isValidGrouping(integerPart, groupSep)) return null;
    integerPart = integerPart.split(groupSep).join("");
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? "." : ",";
    const parts = s.split(sep);
    if (parts.length === 2 && parts[1].length !== 3) {
      [integerPart, fractionPart] = parts;
    } else {
      if (!isValidGrouping(s, sep)) return null;
      integerPart = parts.join("");
    }
  } else {
    integerPart = s;
  }

  if (!/^\d*$/.test(integerPart) || !/^\d{0,2}$/.test(fractionPart)) return null;
  if (!integerPart && !fractionPart) return null;

  const rubles = integerPart ? Number(integerPart) : 0;
  const kopecks = rubles * 100 + (fractionPart ? Number(fractionPart.padEnd(2, "0")) : 0);
  if (!Number.isSafeInteger(kopecks) || kopecks > MAX_KOPECKS) return null;
  return negative ? -kopecks : kopecks;
}

function isValidGrouping(value: string, sep: string): boolean {
  const groups = value.split(sep);
  if (groups.length === 1) return /^\d+$/.test(value);
  if (!/^\d{1,3}$/.test(groups[0])) return false;
  return groups.slice(1).every((g) => /^\d{3}$/.test(g));
}

const formatters = new Map<string, Intl.NumberFormat>();

function getFormatter(fractionDigits: number): Intl.NumberFormat {
  const key = String(fractionDigits);
  let f = formatters.get(key);
  if (!f) {
    f = new Intl.NumberFormat("ru-RU", {
      style: "currency",
      currency: "RUB",
      minimumFractionDigits: fractionDigits,
      maximumFractionDigits: fractionDigits,
    });
    formatters.set(key, f);
  }
  return f;
}

/** «12 500 ₽», «12 500,50 ₽». Копейки показываем только если они есть. */
export function formatMoney(kopecks: Kopecks, options: { sign?: boolean } = {}): string {
  const fraction = kopecks % 100 === 0 ? 0 : 2;
  const text = getFormatter(fraction).format(Math.abs(kopecks) / 100);
  if (kopecks < 0) return `−${text}`;
  if (options.sign && kopecks > 0) return `+${text}`;
  return text;
}

/** Значение для поля ввода: «12500» или «12500,5». */
export function kopecksToInput(kopecks: Kopecks): string {
  const abs = Math.abs(kopecks);
  const rub = Math.floor(abs / 100);
  const kop = abs % 100;
  const text = kop === 0 ? String(rub) : `${rub},${String(kop).padStart(2, "0")}`;
  return kopecks < 0 ? `-${text}` : text;
}
