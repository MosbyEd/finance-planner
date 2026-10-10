import { addMonths, formatMonth, type MonthKey } from "@/domain/dates";
import { IconButton } from "./Button";

export function MonthSwitcher({
  value,
  onChange,
  max,
}: {
  value: MonthKey;
  onChange: (value: MonthKey) => void;
  /** Не дальше этого месяца вперёд. */
  max?: MonthKey;
}) {
  const next = addMonths(value, 1);
  return (
    <div className="flex items-center gap-1">
      <IconButton icon="chevronLeft" label="Предыдущий месяц" onClick={() => onChange(addMonths(value, -1))} />
      <span className="min-w-36 text-center text-[15px] font-semibold" aria-live="polite">
        {formatMonth(value)}
      </span>
      <IconButton
        icon="chevronRight"
        label="Следующий месяц"
        disabled={max !== undefined && next > max}
        onClick={() => onChange(next)}
      />
    </div>
  );
}
