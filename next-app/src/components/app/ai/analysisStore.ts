"use client";

import { useSyncExternalStore } from "react";
import { todayLocal } from "@/domain/dates";
import { analysisReportSchema, type AnalysisKind, type AnalysisReport } from "@/domain/spendingAnalysis";
import { ApiError, api, parseAiAnalysisReply, type AiAnalysisResponse } from "@/client/api";
import {
  ANALYSIS_THREAD_PREFIX,
  isAnalysisThread,
  nativeAiAck,
  nativeAiChatStart,
  nativeAiInbox,
  onNativeAiReply,
  type NativeAiReply,
} from "@/client/native";
import { newId } from "@/client/react";
import { isNativeApp } from "@/client/runtime";
import { storage } from "@/client/storage";
import { ENGINE_LABEL } from "./chatStore";

/**
 * Разборы трат от AI и итоги периодов. Хранятся на сервере (итоги периода — один раз, с какого бы устройства
 * ни спросили); копия — на устройстве, чтобы разбор открывался и без сети. В приложении запрос идёт фоновым,
 * как вопрос помощнику: свернули приложение — ответ всё равно придёт, а с ним уведомление.
 */

export interface AnalysisSnapshot {
  /** Новые первыми. */
  reports: AnalysisReport[];
  /** Список уже получен с сервера в этом запуске. */
  synced: boolean;
  /** Запросы в пути. */
  pending: Partial<Record<AnalysisKind, { since: number; requestId?: string }>>;
  /** Почему не получился последний разбор по кнопке. */
  error: string | null;
}

const MAX_REPORTS = 20;

function storageKey(login: string): string {
  return `fp:ai-reports:${login}`;
}

function readCached(login: string): AnalysisReport[] {
  const raw = storage.getJson(storageKey(login));
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((r) => {
    const parsed = analysisReportSchema.safeParse(r);
    return parsed.success ? [parsed.data] : [];
  });
}

function kindOf(threadId: string): AnalysisKind | null {
  const kind = threadId.slice(ANALYSIS_THREAD_PREFIX.length);
  return kind === "analysis" || kind === "period" ? kind : null;
}

function errorText(error: unknown): string {
  return error instanceof ApiError ? error.message : "Не удалось получить разбор. Попробуйте ещё раз.";
}

export class AnalysisStore {
  private snapshot: AnalysisSnapshot;
  private listeners = new Set<() => void>();
  private stopNative: (() => void) | null = null;
  /** Какой запрос был автоматическим: его ошибку не показываем. */
  private auto = new Set<string>();

  constructor(private readonly login: string) {
    this.snapshot = { reports: readCached(login), synced: false, pending: {}, error: null };
    if (isNativeApp()) {
      this.stopNative = onNativeAiReply(this.onNativeReply);
      void this.syncNative();
    }
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): AnalysisSnapshot => this.snapshot;

  private update(patch: Partial<AnalysisSnapshot>): void {
    this.snapshot = { ...this.snapshot, ...patch };
    if (patch.reports) storage.setJson(storageKey(this.login), patch.reports);
    for (const listener of this.listeners) listener();
  }

  private setPending(kind: AnalysisKind, value: { since: number; requestId?: string } | null): void {
    const pending = { ...this.snapshot.pending };
    if (value) pending[kind] = value;
    else delete pending[kind];
    this.update({ pending });
  }

  /** Разбор пришёл: тот же вид и тот же отрезок — заменяет прежний. */
  private upsert(report: AnalysisReport): void {
    const reports = [report, ...this.snapshot.reports.filter((r) => !(r.kind === report.kind && r.from === report.from))]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, MAX_REPORTS);
    this.update({ reports });
  }

  /** Список с сервера. Без сети остаётся копия на устройстве. */
  async refresh(): Promise<void> {
    try {
      const reports = await api.aiReports();
      this.update({ reports: reports.slice(0, MAX_REPORTS), synced: true });
    } catch {
      /* без сети — копия на устройстве */
    }
  }

  /** Ответы, пришедшие, пока интерфейса не было, и запросы, которые ещё в пути. */
  private async syncNative(): Promise<void> {
    const inbox = await nativeAiInbox();
    if (!inbox) return;
    for (const r of inbox.running) {
      const kind = isAnalysisThread(r.threadId) ? kindOf(r.threadId) : null;
      if (kind && !this.snapshot.pending[kind]) this.setPending(kind, { since: r.startedAt, requestId: r.requestId });
    }
    for (const reply of inbox.done) this.onNativeReply(reply);
  }

  private onNativeReply = (reply: NativeAiReply): void => {
    if (!isAnalysisThread(reply.threadId)) return;
    nativeAiAck([reply.requestId]);
    const kind = kindOf(reply.threadId);
    if (!kind) return;
    let response: AiAnalysisResponse | null = null;
    let error: unknown = null;
    try {
      response = parseAiAnalysisReply(reply.status, reply.body);
    } catch (e) {
      error = e;
    }
    // Ответ на запрос, который уже не ждём (пришёл после перезапуска), всё равно сохраняем.
    if (this.snapshot.pending[kind]?.requestId === reply.requestId || !this.snapshot.pending[kind]) this.setPending(kind, null);
    if (response) this.accept(response);
    else if (!this.auto.has(reply.requestId) && kind === "analysis") this.update({ error: errorText(error) });
    this.auto.delete(reply.requestId);
  };

  private accept(response: AiAnalysisResponse): void {
    if (response.report) this.upsert(response.report);
  }

  /**
   * Разбор (по кнопке) или итоги периода (auto — приложение просит само после зарплаты или аванса: без Live
   * Activity, и если итоги не нужны, сервер ответит без уведомления).
   */
  async run(kind: AnalysisKind, auto = false): Promise<void> {
    if (this.snapshot.pending[kind]) return;
    const requestId = newId();
    const today = todayLocal();
    if (auto) this.auto.add(requestId);
    this.snapshot = { ...this.snapshot, error: kind === "analysis" && !auto ? null : this.snapshot.error };
    this.setPending(kind, { since: Date.now(), requestId });
    try {
      const started = await nativeAiChatStart({
        requestId,
        threadId: `${ANALYSIS_THREAD_PREFIX}${kind}`,
        question: kind === "analysis" ? "Разбор трат: куда уходят деньги и что можно сделать" : "Итоги периода",
        engine: ENGINE_LABEL.reasoning,
        expectedSeconds: kind === "analysis" ? 60 : 40,
        body: { analysis: { kind, auto }, mode: "auto", today },
        kind,
        silent: auto,
      });
      // Ответ придёт событием (onNativeReply).
      if (started) return;
      const response = await api.aiAnalysis(kind, today, auto);
      this.setPending(kind, null);
      this.accept(response);
    } catch (error) {
      this.setPending(kind, null);
      if (!auto) this.update({ error: errorText(error) });
    } finally {
      if (!isNativeApp()) this.auto.delete(requestId);
    }
  }

  dismissError(): void {
    this.update({ error: null });
  }

  dispose(): void {
    this.stopNative?.();
  }
}

const stores = new Map<string, AnalysisStore>();

export function getAnalysisStore(login: string): AnalysisStore {
  let store = stores.get(login);
  if (!store) {
    store = new AnalysisStore(login);
    stores.set(login, store);
  }
  return store;
}

/** Забыть разборы на устройстве (при выходе из аккаунта или его удалении). */
export function forgetAnalysis(login: string): void {
  stores.get(login)?.dispose();
  stores.delete(login);
  storage.remove(storageKey(login));
}

const EMPTY: AnalysisSnapshot = { reports: [], synced: false, pending: {}, error: null };
const noop = () => () => {};

/** Разборы аккаунта; без входа — пусто. */
export function useAnalysis(login: string | undefined): { store: AnalysisStore | null; snapshot: AnalysisSnapshot } {
  const store = login ? getAnalysisStore(login) : null;
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? noop,
    store?.getSnapshot ?? (() => EMPTY),
    () => EMPTY,
  );
  return { store, snapshot };
}
