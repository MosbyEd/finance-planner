"use client";

import { useMemo } from "react";
import {
  ANALYSIS_MIN_DAYS,
  ANALYSIS_MIN_PERIODS,
  analysisAvailability,
  analysisPlan,
  availabilityText,
} from "@/domain/spendingAnalysis";
import { useSnapshot, useToday } from "@/client/react";
import { useAnalysis } from "../../app/ai/analysisStore";
import { useUi } from "../../app/overlays";
import { PRIVACY_NOTE, dayRange } from "../../app/sheets/AnalysisSheet";
import { Button } from "../../ui/Button";
import { Card, Progress } from "../../ui/controls";
import { Icon } from "../../ui/Icon";

/**
 * «Анализ трат от AI»: пока данных мало — сколько осталось до разбора; когда открыт — последние итоги периода
 * и кнопка разбора.
 */
export function AiAnalysisCard() {
  const { state, user, aiEnabled } = useSnapshot();
  const today = useToday();
  const { open } = useUi();
  const { store, snapshot } = useAnalysis(user?.login);
  const availability = useMemo(() => analysisAvailability(state, today), [state, today]);

  // Разбор делает помощник на сервере: без входа или без AI карточки нет.
  if (!user || !aiEnabled) return null;

  const title = (
    <span className="flex items-center gap-1.5">
      <Icon name="sparkles" size={17} className="text-accent" />
      Анализ трат от AI
    </span>
  );

  if (!availability.open) {
    const periodsLabel = availability.periodKind === "pay" ? "Полных периодов" : "Полных месяцев";
    return (
      <Card title={title}>
        <p className="text-[15px]">{availabilityText(availability, today)}</p>
        <div className="mt-3 space-y-2.5">
          <ProgressRow label={periodsLabel} value={availability.completed.length} max={ANALYSIS_MIN_PERIODS} />
          <ProgressRow label="Дней с тратами" value={availability.spendingDays} max={ANALYSIS_MIN_DAYS} />
        </div>
        <p className="mt-3 text-sm text-muted">
          Разберём, куда уходят деньги и что изменилось к прошлому периоду, и предложим 3–5 шагов с эффектом в рублях.
          После каждой зарплаты и аванса — короткие итоги периода.
        </p>
        <p className="mt-1.5 text-xs text-muted">{PRIVACY_NOTE}</p>
      </Card>
    );
  }

  const plan = analysisPlan(availability, "analysis");
  const latest = snapshot.reports.find((r) => r.kind === "analysis");
  const ready = Boolean(latest && plan && latest.from === plan.from && latest.to === plan.to);
  const pending = Boolean(snapshot.pending.analysis);
  const summary = snapshot.reports.find((r) => r.kind === "period");

  const openAnalysis = () => {
    open({ kind: "analysis" });
    if (!ready && !pending) void store?.run("analysis");
  };

  return (
    <Card title={title}>
      {summary ? (
        <div className="rounded-2xl bg-surface-2 px-3 py-2.5">
          <p className="text-sm font-semibold">
            Итоги периода · {dayRange(summary.from, summary.to, today)}
          </p>
          <p className="mt-0.5 text-[15px]">{summary.summary}</p>
        </div>
      ) : (
        <p className="text-[15px]">
          Данных хватает: разберём, куда уходят деньги, что изменилось к прошлому периоду, и предложим шаги с эффектом в
          рублях.
        </p>
      )}
      {snapshot.pending.period && <p className="mt-2 text-sm text-muted">Подводим итоги периода…</p>}
      <Button icon="sparkles" className="mt-3" loading={pending} onClick={openAnalysis}>
        {pending ? "Разбираем траты…" : ready ? "Открыть разбор" : "Разобрать траты"}
      </Button>
    </Card>
  );
}

function ProgressRow({ label, value, max }: { label: string; value: number; max: number }) {
  return (
    <div>
      <div className="mb-1 flex items-baseline justify-between gap-3 text-sm">
        <span className="min-w-0 text-muted">{label}</span>
        <span className="shrink-0 font-medium tabular-nums">
          {Math.min(value, max)} из {max}
        </span>
      </div>
      <Progress value={value} max={max} tone={value >= max ? "positive" : "accent"} label={label} />
    </div>
  );
}
