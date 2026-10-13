"use client";

import { useEffect, useMemo, type ReactNode } from "react";
import { formatDay, type IsoDate } from "@/domain/dates";
import { formatMoney, type Kopecks } from "@/domain/money";
import {
  analysisAvailability,
  analysisData,
  analysisPlan,
  availabilityText,
  type AnalysisData,
  type AnalysisReport,
  type AnalysisStep,
} from "@/domain/spendingAnalysis";
import { plural } from "@/domain/text";
import { nativeAiChatVisible } from "@/client/native";
import { isNativeApp } from "@/client/runtime";
import { useSnapshot, useToday } from "@/client/react";
import { Button } from "../../ui/Button";
import { EmptyState, Money, Notice } from "../../ui/controls";
import { Icon } from "../../ui/Icon";
import { Sheet } from "../../ui/Sheet";
import { useAnalysis } from "../ai/analysisStore";
import { useUi } from "../overlays";

/** Все суммы здесь — итоги, без копеек. */
function rubles(kopecks: Kopecks): string {
  return formatMoney(kopecks, { whole: true });
}

/** «25 сентября – 8 октября»: число и месяц не разрываются переносом. */
export function dayRange(from: IsoDate, to: IsoDate, today: IsoDate): string {
  const day = (d: IsoDate) => formatDay(d, today).replace(/ /g, "\u00a0");
  return `${day(from)} – ${day(to)}`;
}

const range = dayRange;

function createdText(report: AnalysisReport, today: IsoDate): string {
  const at = new Date(report.createdAt);
  const time = at.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit" });
  const day = `${at.getFullYear()}-${String(at.getMonth() + 1).padStart(2, "0")}-${String(at.getDate()).padStart(2, "0")}`;
  const engine = report.thinking || /reason/i.test(report.model) ? "DeepSeek с рассуждением" : "DeepSeek";
  return `${day === today ? "Сегодня" : formatDay(day, today)}, ${time} · ${engine}`;
}

export const PRIVACY_NOTE = "В AI уходят только суммы по категориям и дням и топ магазинов — без текстов СМС и остатков на счетах.";

export function AnalysisSheet() {
  const snap = useSnapshot();
  const today = useToday();
  const { close, open } = useUi();
  const { store, snapshot } = useAnalysis(snap.user?.login);

  // Ответ в открытое окно — без уведомления.
  useEffect(() => {
    nativeAiChatVisible(true, "analysis");
    return () => nativeAiChatVisible(false, "analysis");
  }, []);
  useEffect(() => {
    void store?.refresh();
  }, [store]);

  const availability = useMemo(() => analysisAvailability(snap.state, today), [snap.state, today]);
  const plan = useMemo(() => analysisPlan(availability, "analysis"), [availability]);
  const latest = snapshot.reports.find((r) => r.kind === "analysis");
  const current = latest && plan && latest.from === plan.from && latest.to === plan.to ? latest : null;
  // Разбор есть — показываем цифры, которые видела модель; нет — посчитанные сейчас.
  const data = useMemo(() => current?.data ?? (plan ? analysisData(snap.state, plan, today) : null), [current, plan, snap.state, today]);
  const periods = snapshot.reports.filter((r) => r.kind === "period");
  const pending = Boolean(snapshot.pending.analysis);

  if (!snap.user) {
    return (
      <Sheet open onClose={close} title="Анализ трат">
        <EmptyState
          title="Войдите, чтобы получить разбор"
          text="Разбор делает AI-помощник по данным аккаунта."
          action={
            <Button icon="user" onClick={() => open({ kind: "auth", mode: "login" })}>
              Войти
            </Button>
          }
        />
      </Sheet>
    );
  }

  const run = () => void store?.run("analysis");
  const footer = plan ? (
    <Button icon="sparkles" className="w-full" loading={pending} disabled={!snap.aiEnabled} onClick={run}>
      {pending ? "Разбираем траты…" : current ? "Обновить разбор" : "Разобрать с AI"}
    </Button>
  ) : undefined;

  return (
    <Sheet
      open
      onClose={close}
      title="Анализ трат"
      size="lg"
      tall
      description={plan ? `${range(plan.from, plan.to, today)} · два ${availability.periodKind === "pay" ? "периода от зарплаты до зарплаты" : "месяца"}` : undefined}
      footer={footer}
    >
      <div className="space-y-5 text-[15px]">
        {periods[0] && <PeriodSummary report={periods[0]} today={today} />}

        {!plan && (
          <Notice>
            <p className="font-medium">Разбор пока закрыт</p>
            <p className="mt-0.5 text-muted">{availabilityText(availability, today)}</p>
          </Notice>
        )}

        {pending && (
          <Notice>
            <span className="flex items-start gap-2">
              <span className="mt-1 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-accent border-r-transparent" aria-hidden />
              <span>
                Помощник разбирает траты — обычно до минуты.{" "}
                {isNativeApp() ? "Окно можно закрыть: когда разбор будет готов, придёт уведомление." : "Окно можно закрыть — разбор сохранится."}
              </span>
            </span>
          </Notice>
        )}
        {snapshot.error && !pending && (
          <Notice tone="negative" action={<Button size="sm" variant="secondary" onClick={() => store?.dismissError()}>Скрыть</Button>}>
            {snapshot.error}
          </Notice>
        )}

        {current && (
          <section className="rounded-2xl bg-accent-soft px-4 py-3">
            <p className="flex items-center gap-1.5 text-sm font-semibold text-accent">
              <Icon name="sparkles" size={16} />
              Главное
            </p>
            <p className="mt-1.5">{current.summary}</p>
            <p className="mt-2 text-xs text-muted">{createdText(current, today)}</p>
          </section>
        )}

        {data && <Where data={data} notes={current?.where ?? []} />}
        {data && <Changes data={data} notes={current?.changes ?? []} today={today} />}
        {current && current.steps.length > 0 && <Steps steps={current.steps} />}
        {plan && !current && !pending && (
          <p className="text-sm text-muted">
            Нажмите «Разобрать с AI» — помощник объяснит цифры и предложит 3–5 шагов с эффектом в рублях.
          </p>
        )}

        {periods.length > 1 && <PastPeriods reports={periods.slice(1)} today={today} />}

        <p className="text-xs text-muted">{PRIVACY_NOTE}</p>
      </div>
    </Sheet>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="mb-2 text-[15px] font-semibold">{title}</h3>
      {children}
    </section>
  );
}

function Notes({ items }: { items: string[] }) {
  if (!items.length) return null;
  return (
    <ul className="mt-3 space-y-1.5">
      {items.map((note) => (
        <li key={note} className="flex gap-2 text-sm">
          <Icon name="sparkles" size={14} className="mt-1 shrink-0 text-accent" />
          <span className="min-w-0">{note}</span>
        </li>
      ))}
    </ul>
  );
}

function Bar({ share }: { share: number }) {
  return (
    <span className="mt-1.5 block h-2 w-full overflow-hidden rounded-full bg-surface-3" aria-hidden="true">
      <span className="block h-full rounded-full bg-accent" style={{ width: `${Math.max(0, Math.min(1, share)) * 100}%` }} />
    </span>
  );
}

function times(n: number): string {
  return `${n} ${plural(n, ["раз", "раза", "раз"])}`;
}

// ---------- куда уходят деньги ----------

function Where({ data, notes }: { data: AnalysisData; notes: string[] }) {
  const top = data.categories.slice(0, 6);
  const max = Math.max(1, ...top.map((c) => c.amount));
  return (
    <Section title="Куда уходят деньги">
      <p className="text-sm text-muted">
        Повседневные траты — <Money whole value={data.flexible} className="font-semibold text-text" />, в среднем{" "}
        {rubles(data.perDay)} в день
        {data.mandatory > 0 && <> · обязательные — {rubles(data.mandatory)}</>}
      </p>
      {top.length > 0 ? (
        <ul className="mt-2 space-y-2.5">
          {top.map((c) => (
            <li key={c.name}>
              <div className="flex items-baseline justify-between gap-3">
                <span className="min-w-0 truncate font-medium">{c.name}</span>
                <span className="shrink-0">
                  <Money whole value={c.amount} className="font-semibold" />
                  <span className="text-sm text-muted"> · {Math.round(c.share * 100)}%</span>
                </span>
              </div>
              <p className="text-xs text-muted">
                {times(c.count)} · {rubles(c.perDay)} в день
              </p>
              <Bar share={c.amount / max} />
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2 text-sm text-muted">Повседневных трат за эти дни нет.</p>
      )}
      <Notes items={notes} />

      <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
        <Tile title="Частые мелкие траты" sub={`до ${rubles(data.small.threshold)}`}>
          {data.small.count > 0 ? (
            <>
              <p>
                <span className="font-semibold">{times(data.small.count)}</span> на{" "}
                <Money whole value={data.small.amount} className="font-semibold" />
              </p>
              <ul className="mt-1 space-y-0.5 text-sm text-muted">
                {data.small.categories.slice(0, 3).map((c) => (
                  <li key={c.category} className="flex justify-between gap-2">
                    <span className="min-w-0 truncate">{c.category}</span>
                    <span className="shrink-0 tabular-nums">
                      {times(c.count)} · {rubles(c.amount)}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          ) : (
            <p className="text-sm text-muted">Мелких трат не было.</p>
          )}
        </Tile>
        <Tile title="Будни и выходные" sub="повседневные в среднем за день">
          <dl className="space-y-0.5">
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Будни</dt>
              <dd>
                <Money whole value={data.week.weekdayPerDay} className="font-semibold" />
              </dd>
            </div>
            <div className="flex justify-between gap-2">
              <dt className="text-muted">Выходные</dt>
              <dd>
                <Money whole value={data.week.weekendPerDay} className="font-semibold" />
              </dd>
            </div>
          </dl>
          {data.week.weekendCategories[0] && (
            <p className="mt-1 text-sm text-muted">В выходные больше всего — {data.week.weekendCategories[0].category}</p>
          )}
        </Tile>
      </div>

      {data.merchants.length > 0 && (
        <div className="mt-4">
          <h4 className="mb-1 text-sm font-semibold">Где тратите чаще всего</h4>
          <ul className="divide-y divide-border">
            {data.merchants.slice(0, 6).map((m) => (
              <li key={m.name} className="flex items-baseline justify-between gap-3 py-1.5">
                <span className="min-w-0">
                  <span className="block truncate">{m.name}</span>
                  <span className="block truncate text-xs text-muted">
                    {m.category} · {times(m.count)}
                  </span>
                </span>
                <Money whole value={m.amount} className="shrink-0 font-semibold" />
              </li>
            ))}
          </ul>
        </div>
      )}
    </Section>
  );
}

function Tile({ title, sub, children }: { title: string; sub: string; children: ReactNode }) {
  return (
    <div className="min-w-0 rounded-2xl bg-surface-2 px-3 py-2.5">
      <p className="text-sm font-semibold">{title}</p>
      <p className="mb-1.5 text-xs text-muted">{sub}</p>
      {children}
    </div>
  );
}

// ---------- что изменилось ----------

function Changes({ data, notes, today }: { data: AnalysisData; notes: string[]; today: IsoDate }) {
  const { previous, last } = data;
  const delta = last.perDay - previous.perDay;
  // Меньше 10 ₽ в день — не изменение.
  const rows = data.changes.filter((c) => Math.abs(c.after - c.before) >= 1_000).slice(0, 5);
  return (
    <Section title="Что изменилось к прошлому периоду">
      <p className="text-sm text-muted">
        {range(previous.start, previous.end, today)} → {range(last.start, last.end, today)}, повседневные в среднем за день:
      </p>
      <p className="mt-1">
        <span className="tabular-nums">{rubles(previous.perDay)}</span> →{" "}
        <span className="font-semibold tabular-nums">{rubles(last.perDay)}</span>{" "}
        {delta !== 0 && (
          <span className={`whitespace-nowrap text-sm font-medium ${delta > 0 ? "text-negative" : "text-positive"}`}>
            {delta > 0 ? "+" : "−"}
            {rubles(Math.abs(delta))} в день
          </span>
        )}
      </p>
      {last.budget !== null && last.left !== null && (
        <p className="mt-1 text-sm text-muted">
          Последний период: потрачено {rubles(last.flexible)} из бюджета {rubles(last.budget)}
          {last.left >= 0 ? `, осталось ${rubles(last.left)}` : `, перерасход ${rubles(-last.left)}`}.
        </p>
      )}
      {rows.length > 0 && (
        <ul className="mt-2 divide-y divide-border">
          {rows.map((c) => {
            const d = c.after - c.before;
            return (
              <li key={c.category} className="flex flex-wrap items-baseline justify-between gap-x-3 py-1.5">
                <span className="min-w-0 truncate">{c.category}</span>
                <span className="shrink-0 text-sm tabular-nums">
                  <span className="text-muted">
                    {rubles(c.before)} → {rubles(c.after)}
                  </span>{" "}
                  <span className={`font-medium ${d > 0 ? "text-negative" : "text-positive"}`}>
                    {d > 0 ? "+" : "−"}
                    {rubles(Math.abs(d))}
                  </span>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      <Notes items={notes} />
    </Section>
  );
}

// ---------- шаги ----------

/** «Такси −30% → +150 ₽ в день к лимиту». */
export function stepEffectText(step: AnalysisStep): string | null {
  if (step.effectPerDay === null || !step.target || step.cutPercent === null) return null;
  return `${step.target} −${step.cutPercent}% → +${rubles(step.effectPerDay)} в день к лимиту`;
}

function Steps({ steps }: { steps: AnalysisStep[] }) {
  return (
    <Section title="Что можно сделать">
      <ol className="space-y-2">
        {steps.map((step, i) => (
          <StepItem key={`${i}-${step.title}`} step={step} n={i + 1} />
        ))}
      </ol>
    </Section>
  );
}

export function StepItem({ step, n }: { step: AnalysisStep; n?: number }) {
  const effect = stepEffectText(step);
  return (
    <li className="flex gap-3 rounded-2xl bg-surface-2 px-3 py-2.5">
      {n !== undefined && (
        <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-accent-soft text-sm font-semibold text-accent">
          {n}
        </span>
      )}
      <div className="min-w-0">
        <p className="font-medium">{step.title}</p>
        {effect && (
          <p className="mt-0.5 text-sm font-medium text-positive">
            {effect}
            {step.effectPerPeriod !== null && <span className="font-normal text-muted"> · ≈ {rubles(step.effectPerPeriod)} за период</span>}
          </p>
        )}
        {step.why && <p className="mt-0.5 text-sm text-muted">{step.why}</p>}
      </div>
    </li>
  );
}

// ---------- итоги периодов ----------

function PeriodSummary({ report, today }: { report: AnalysisReport; today: IsoDate }) {
  return (
    <section className="rounded-2xl border border-border px-4 py-3">
      <p className="text-sm font-semibold">Итоги периода · {range(report.from, report.to, today)}</p>
      <p className="mt-1">{report.summary}</p>
      <Notes items={report.changes} />
      {report.steps[0] && (
        <ul className="mt-3">
          <StepItem step={report.steps[0]} />
        </ul>
      )}
    </section>
  );
}

function PastPeriods({ reports, today }: { reports: AnalysisReport[]; today: IsoDate }) {
  return (
    <details className="rounded-2xl bg-surface-2 px-4 py-3">
      <summary className="cursor-pointer text-sm font-semibold">Итоги прошлых периодов</summary>
      <ul className="mt-2 space-y-3">
        {reports.map((r) => (
          <li key={`${r.kind}-${r.from}`} className="text-sm">
            <p className="font-medium">{range(r.from, r.to, today)}</p>
            <p className="text-muted">{r.summary}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}
