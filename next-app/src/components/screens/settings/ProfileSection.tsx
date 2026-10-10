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

const RISK_OPTIONS: { value: Risk; label: string }[] = [
  { value: "none", label: "Не указано" },
  { value: "low", label: "Низкий" },
  { value: "medium", label: "Средний" },
  { value: "high", label: "Высокий" },
];

const STYLE_OPTIONS: { value: Style; label: string }[] = [
  { value: "none", label: "Не указано" },
  { value: "relaxed", label: "Спокойно" },
  { value: "balanced", label: "Сбалансированно" },
  { value: "aggressive", label: "Активно" },
];

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
          Так AI-помощник сможет давать советы под вашу ситуацию. Всё необязательно. Профиль отправляется помощнику,
          только когда вы задаёте ему вопрос.
        </p>
        <TextInput
          label="Чем вы занимаетесь"
          placeholder="Например, инженер, фрилансер, студент"
          value={form.occupation}
          maxLength={MAX_OCCUPATION}
          onChange={(e) => patch({ occupation: e.target.value })}
        />
        <ChoiceChips label="Отношение к риску" value={form.risk} options={RISK_OPTIONS} onChange={(risk) => patch({ risk })} />
        <ChoiceChips
          label="Как копить"
          value={form.style}
          options={STYLE_OPTIONS}
          onChange={(style) => patch({ style })}
        />
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
