"use client";

import { useMemo, useState, type ReactNode } from "react";
import { formatDay, isValidIsoDate, type IsoDate } from "@/domain/dates";
import type { Kopecks } from "@/domain/money";
import { dueOccurrences, nextOccurrence, type Occurrence } from "@/domain/recurring";
import { LIMITS, type Template } from "@/domain/schema";
import { newId, useSnapshot, useToday } from "@/client/react";
import { AmountInput } from "../../ui/AmountInput";
import { Button } from "../../ui/Button";
import { CategoryPicker } from "../../ui/CategoryPicker";
import { Segmented, Switch } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { DateInput, TextInput } from "../../ui/Field";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";
import { plural } from "@/domain/text";

type Kind = Template["kind"];
type Errors = { amount?: string; title?: string; category?: string; day?: string; startDate?: string };

const QUICK_DAYS = [1, 5, 10, 15, 20, 25];

function parseDay(text: string): number | null {
  if (!/^\d{1,2}$/.test(text)) return null;
  const day = Number(text);
  return day >= 1 && day <= 31 ? day : null;
}

function groupOf(kind: Kind): "income" | "mandatory" {
  return kind === "income" ? "income" : "mandatory";
}

function templateNoun(kind: Kind): string {
  return kind === "income" ? "Регулярный доход" : "Регулярный платёж";
}

export function TemplateSheet({
  templateId,
  preset,
}: {
  templateId?: string;
  preset?: { kind?: "income" | "expense" };
}) {
  const { state } = useSnapshot();
  const { close } = useUi();
  const today = useToday();
  const dispatch = useDispatch();
  const confirm = useConfirm();
  const toast = useToast();
  const existing = templateId ? state.templates.find((t) => t.id === templateId) : undefined;

  // Значения на момент открытия: с ними сравниваем, есть ли несохранённые изменения.
  const [initial] = useState(() => ({
    kind: existing?.kind ?? preset?.kind ?? "expense",
    amount: existing?.amount ?? null,
    category: existing?.category ?? "",
    title: existing?.title ?? "",
    dayText: existing ? String(existing.dayOfMonth) : "",
    active: existing?.active ?? true,
  }));
  const [kind, setKind] = useState<Kind>(initial.kind);
  const [amount, setAmount] = useState<Kopecks | null>(initial.amount);
  const [category, setCategory] = useState(initial.category);
  const [title, setTitle] = useState(initial.title);
  // Пока название не вводили вручную, оно повторяет категорию.
  const [titleTouched, setTitleTouched] = useState(Boolean(existing));
  const [dayText, setDayText] = useState(initial.dayText);
  // null — дату не меняли: показываем актуальную из записи (её сдвигает возобновление после паузы).
  const [startDraft, setStartDraft] = useState<IsoDate | null>(null);
  // Пауза применяется вместе с остальными полями — по кнопке «Сохранить».
  const [active, setActive] = useState(initial.active);
  const [errors, setErrors] = useState<Errors>({});

  const resuming = Boolean(existing && !existing.active && active);
  // При возобновлении пропущенные за паузу месяцы не начисляются: дата начала сдвигается на сегодня.
  const currentStart = existing ? (resuming && existing.startDate < today ? today : existing.startDate) : today;
  const startDate = startDraft ?? currentStart;
  const day = parseDay(dayText);
  const draftId = existing?.id ?? "draft";

  /** Что произойдёт после сохранения: какие операции появятся сразу и когда следующая. */
  const preview = useMemo(() => {
    if (day === null || !isValidIsoDate(startDate)) return null;
    const draft: Template = {
      id: draftId,
      kind: "expense",
      title: "-",
      category: "-",
      amount: 1,
      dayOfMonth: day,
      active: true,
      startDate,
      note: "",
    };
    const draftState = { ...state, templates: [draft] };
    return { due: dueOccurrences(draftState, today), next: nextOccurrence(draftState, draft, today) };
  }, [draftId, day, startDate, state, today]);

  // Запись удалили (например, на другом устройстве) — окно закрывается, а не превращается в форму создания.
  if (templateId && !existing) return null;

  const noun = kind === "income" ? "доход" : "платёж";
  const dirty =
    kind !== initial.kind ||
    amount !== initial.amount ||
    category !== initial.category ||
    title !== initial.title ||
    dayText !== initial.dayText ||
    (startDraft !== null && startDraft !== currentStart) ||
    active !== initial.active;
  const clearError = (key: keyof Errors) => setErrors((e) => (e[key] ? { ...e, [key]: undefined } : e));

  const pickCategory = (value: string) => {
    setCategory(value);
    if (!titleTouched) setTitle(value);
    clearError("category");
    clearError("title");
  };

  const switchKind = (next: Kind) => {
    setKind(next);
    if (category && !state.categories[groupOf(next)].includes(category)) {
      setCategory("");
      if (!titleTouched) setTitle("");
    }
  };

  const save = () => {
    const next: Errors = {};
    if (!amount || amount <= 0) next.amount = "Введите сумму";
    if (!category.trim()) next.category = "Выберите категорию";
    if (!title.trim()) next.title = "Введите название";
    if (day === null) next.day = "Укажите число от 1 до 31";
    if (!isValidIsoDate(startDate)) next.startDate = "Укажите дату";
    setErrors(next);
    if (Object.keys(next).length || !amount || day === null) return;

    const fields = { kind, title: title.trim(), category: category.trim(), amount, dayOfMonth: day, startDate };
    if (!existing) {
      if (templateId) return;
      if (dispatch({ type: "template.add", template: { id: newId(), ...fields, active: true, note: "" } })) close();
      return;
    }
    const activeChanged = active !== existing.active;
    // Сначала пауза/возобновление (оно сдвигает дату начала), затем поля формы — так сохраняется дата,
    // которую человек выбрал сам.
    const ok = dispatch([
      ...(activeChanged ? [{ type: "template.setActive" as const, id: existing.id, active, today }] : []),
      { type: "template.update", id: existing.id, patch: fields },
    ]);
    if (!ok) return;
    if (activeChanged) toast(`${templateNoun(kind)} «${fields.title}» ${active ? "возобновлён" : "приостановлен"}`);
    close();
  };

  const remove = async () => {
    if (!existing) return;
    const ok = await confirm({
      title: `Удалить ${templateNoun(existing.kind).toLowerCase()} «${existing.title}»?`,
      message: "Уже созданные операции останутся в истории, новые появляться перестанут.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    close();
    if (dispatch({ type: "template.delete", id: existing.id })) toast(`${templateNoun(existing.kind)} удалён`);
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={existing ? existing.title : templateNoun(kind)}
      footer={
        <div className="flex gap-2">
          {existing && (
            <Button variant="secondary" icon="trash" onClick={remove}>
              Удалить
            </Button>
          )}
          <Button className="flex-1" onClick={save}>
            {existing ? "Сохранить" : "Добавить"}
          </Button>
        </div>
      }
    >
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <Segmented
          label="Тип"
          value={kind}
          onChange={switchKind}
          options={[
            { value: "expense", label: "Расход" },
            { value: "income", label: "Доход" },
          ]}
        />

        <AmountInput
          label="Сумма"
          value={amount}
          autoFocus={!existing}
          error={errors.amount}
          onChange={(v) => {
            setAmount(v);
            clearError("amount");
          }}
        />

        <CategoryPicker
          label="Категория"
          categories={state.categories[groupOf(kind)]}
          value={category}
          onChange={pickCategory}
          error={errors.category}
        />

        <TextInput
          label="Название"
          placeholder={kind === "income" ? "Например, зарплата" : "Например, аренда квартиры"}
          value={title}
          maxLength={LIMITS.title}
          error={errors.title}
          onChange={(e) => {
            setTitle(e.target.value);
            setTitleTouched(e.target.value.trim() !== "");
            clearError("title");
          }}
        />

        <div className="space-y-2">
          <TextInput
            label="Какого числа"
            inputMode="numeric"
            pattern="[0-9]*"
            enterKeyHint="done"
            autoComplete="off"
            maxLength={2}
            placeholder="От 1 до 31"
            value={dayText}
            error={errors.day}
            onChange={(e) => {
              setDayText(e.target.value.replace(/\D/g, "").slice(0, 2));
              clearError("day");
            }}
          />
          <div className="flex flex-wrap gap-2" role="group" aria-label="Частые дни">
            {QUICK_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                aria-pressed={day === d}
                aria-label={`${d}-е число`}
                onClick={() => {
                  setDayText(String(d));
                  clearError("day");
                }}
                className={`h-10 min-w-10 rounded-full px-3 text-sm ${
                  day === d ? "bg-accent-soft font-medium text-accent" : "bg-surface-2 text-muted hover:text-text"
                }`}
              >
                {d}
              </button>
            ))}
          </div>
          <p className="text-xs text-muted">Если в месяце меньше дней — в последний день месяца</p>
        </div>

        <DateInput
          label="Начать с"
          value={startDate}
          error={errors.startDate}
          hint={
            kind === "income"
              ? "Если доход в этом месяце уже был, но не записан, поставьте дату раньше — он появится в истории"
              : "Если платёж в этом месяце уже был, но не записан, поставьте дату раньше — он появится в истории"
          }
          onChange={(e) => {
            setStartDraft(e.target.value);
            clearError("startDate");
          }}
        />

        {!active ? (
          <PreviewBox>На паузе — новые операции не появятся в истории.</PreviewBox>
        ) : (
          preview && <Preview due={preview.due} next={preview.next} noun={noun} today={today} />
        )}

        {existing && (
          <Switch
            checked={active}
            onChange={setActive}
            label="Активен"
            description={
              active === existing.active
                ? active
                  ? "Операция появляется в истории каждый месяц"
                  : "Сейчас на паузе. Включите и сохраните, чтобы операции снова появлялись"
                : active
                  ? "После сохранения операции снова начнут появляться — без пропущенных за паузу месяцев"
                  : "После сохранения новые операции перестанут появляться"
            }
          />
        )}
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

function PreviewBox({ children }: { children: ReactNode }) {
  return (
    <div className="flex gap-2.5 rounded-2xl bg-surface-2 px-4 py-3 text-sm">
      <Icon name="calendar" size={18} className="mt-0.5 shrink-0 text-muted" />
      <div className="space-y-1">{children}</div>
    </div>
  );
}

function Preview({ due, next, noun, today }: { due: Occurrence[]; next: Occurrence | null; noun: string; today: IsoDate }) {
  if (!due.length && !next) return null;
  return (
    <PreviewBox>
      {due.length === 1 && <p>Операция за {formatDay(due[0].date, today)} сразу появится в истории.</p>}
      {due.length > 1 && (
        <p>
          Сразу появятся в истории: {due.length} {plural(due.length, ["операция", "операции", "операций"])}, начиная с{" "}
          {formatDay(due[0].date, today)}.
        </p>
      )}
      {next && (
        <p className={due.length ? "text-muted" : ""}>
          {due.length ? "Следующая" : `Ближайший ${noun}`} — {formatDay(next.date, today)}.
        </p>
      )}
    </PreviewBox>
  );
}
