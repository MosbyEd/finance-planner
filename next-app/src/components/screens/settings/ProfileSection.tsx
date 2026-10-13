"use client";

import { useState } from "react";
import { LIMITS, type Profile } from "@/domain/schema";
import { useSnapshot } from "@/client/react";
import { useDispatch } from "../../app/hooks";
import { useLeaveGuard } from "../../app/overlays";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/feedback";
import { TextArea, TextInput } from "../../ui/Field";
import { ChoiceChips, UnsavedHint } from "./common";
import { SectionCard, UNSAVED_SUMMARY, useRowSummary } from "./SettingsList";

const MAX_OCCUPATION = 100;

type Risk = "none" | NonNullable<Profile["riskLevel"]>;
type Style = "none" | NonNullable<Profile["savingsStyle"]>;

/**
 * Варианты с тем, что помощник с ними делает (effect). Для модели те же правила записаны в profilePrompt
 * (domain/ai.ts) и в анализе трат (domain/spendingAnalysis.ts) — меняются вместе.
 */
const RISK_OPTIONS: { value: Risk; label: string; effect: string }[] = [
  {
    value: "none",
    label: "Не указано",
    effect: "Про вложения помощник заговорит, только если спросите, — и сначала уточнит, готовы ли вы к колебаниям.",
  },
  {
    value: "low",
    label: "Низкий",
    effect: "Сначала подушка на 6 месяцев расходов, сбережения — на вкладах и накопительных счетах. Акции и криптовалюту помощник не предложит.",
  },
  {
    value: "medium",
    label: "Средний",
    effect: "Сначала подушка на 3–6 месяцев расходов, потом вклады и надёжные облигации; небольшую часть — в фонды акций, с предупреждением о колебаниях.",
  },
  {
    value: "high",
    label: "Высокий",
    effect: "После подушки на 3 месяца расходов помощник может предложить и доходные вложения с колебаниями — акции, фонды — и предупредит о риске.",
  },
];

const STYLE_OPTIONS: { value: Style; label: string; effect: string }[] = [
  { value: "none", label: "Не указано", effect: "Темп помощник подбирает сам — по вашим доходам и целям." },
  {
    value: "relaxed",
    label: "Спокойно",
    effect: "До 10% дохода, привычные траты не урезать. Не успеваете к цели — помощник предложит сдвинуть срок, а не затянуть пояс. В анализе трат — мягкие шаги.",
  },
  {
    value: "balanced",
    label: "Сбалансированно",
    effect: "10–20% дохода и сокращение самых заметных необязательных трат. В анализе трат — умеренные шаги.",
  },
  {
    value: "aggressive",
    label: "Активно",
    effect: "20% дохода и больше, строже сокращать необязательные траты и ставить лимиты пониже — чтобы прийти к целям быстрее. В анализе трат — смелые шаги.",
  },
];

const effectOf = <T extends string>(options: { value: T; effect: string }[], value: T) =>
  options.find((o) => o.value === value)?.effect;

interface Form {
  occupation: string;
  risk: Risk;
  style: Style;
  notes: string;
}

function toForm(p: Profile): Form {
  return { occupation: p.occupation, risk: p.riskLevel ?? "none", style: p.savingsStyle ?? "none", notes: p.notes };
}

function toProfile(f: Form): Profile {
  return {
    occupation: f.occupation.trim(),
    riskLevel: f.risk === "none" ? null : f.risk,
    savingsStyle: f.style === "none" ? null : f.style,
    notes: f.notes.trim(),
  };
}

function sameProfile(a: Profile, b: Profile): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function ProfileSection() {
  const { state } = useSnapshot();
  const dispatch = useDispatch();
  const toast = useToast();
  const saved = state.profile;

  const [base, setBase] = useState(saved);
  const [form, setForm] = useState(() => toForm(saved));

  // Профиль изменился снаружи — подхватываем, если черновик не трогали.
  if (saved !== base) {
    setBase(saved);
    if (sameProfile(toProfile(form), base)) setForm(toForm(saved));
  }

  const dirty = !sameProfile(toProfile(form), saved);
  useLeaveGuard(dirty);
  useRowSummary(dirty ? UNSAVED_SUMMARY : null);
  const patch = (next: Partial<Form>) => setForm((f) => ({ ...f, ...next }));

  const save = () => {
    const profile = toProfile(form);
    if (dispatch({ type: "profile.update", profile })) {
      setForm(toForm(profile));
      toast("Профиль сохранён");
    }
  };

  return (
    <SectionCard title="Профиль для AI-помощника">
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <p className="text-sm text-muted">
          Так AI-помощник сможет давать советы под вашу ситуацию. Профиль меняет только его ответы: лимит на день, бюджет
          и отчисления в сбережения от него не зависят — они в настройках «Сбережения». Всё необязательно. Профиль
          отправляется помощнику, только когда вы задаёте ему вопрос; «Как копить» учитывает ещё анализ трат.
        </p>
        <TextInput
          label="Чем вы занимаетесь"
          placeholder="Например, инженер, фрилансер, студент"
          value={form.occupation}
          maxLength={MAX_OCCUPATION}
          onChange={(e) => patch({ occupation: e.target.value })}
        />
        <div className="space-y-2">
          <ChoiceChips
            label="Отношение к риску"
            description="Готовы ли вы к тому, что вложения временно подешевеют, ради бо́льшего дохода. Влияет на советы, где держать сбережения."
            value={form.risk}
            options={RISK_OPTIONS}
            onChange={(risk) => patch({ risk })}
          />
          <p className="text-sm" aria-live="polite">
            {effectOf(RISK_OPTIONS, form.risk)}
          </p>
        </div>
        <div className="space-y-2">
          <ChoiceChips
            label="Как копить"
            description="Насколько усердно откладывать. Влияет на советы, сколько откладывать и какие траты сократить."
            value={form.style}
            options={STYLE_OPTIONS}
            onChange={(style) => patch({ style })}
          />
          <p className="text-sm" aria-live="polite">
            {effectOf(STYLE_OPTIONS, form.style)}
          </p>
        </div>
        <p className="text-xs text-muted">
          При любом выборе помощник не советует вкладывать деньги на обязательные платежи, подушку и заёмные и не
          называет конкретные акции, фонды и брокеров.
        </p>
        <TextArea
          label="Что ещё важно знать"
          placeholder="Семья, планы, крупные расходы впереди"
          hint={`${form.notes.length} из ${LIMITS.profileNotes} символов`}
          value={form.notes}
          maxLength={LIMITS.profileNotes}
          rows={4}
          onChange={(e) => patch({ notes: e.target.value })}
        />
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={!dirty}>
            Сохранить
          </Button>
          {dirty && (
            <Button variant="ghost" onClick={() => setForm(toForm(saved))}>
              Отменить
            </Button>
          )}
          <UnsavedHint dirty={dirty} />
        </div>
      </form>
    </SectionCard>
  );
}
