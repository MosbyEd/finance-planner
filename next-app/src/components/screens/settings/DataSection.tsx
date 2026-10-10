"use client";

import { useRef, useState, type ChangeEvent } from "react";
import { parseIsoDate, type IsoDate } from "@/domain/dates";
import { emptyState } from "@/domain/defaults";
import type { MigrationReport } from "@/domain/migrate";
import type { Kopecks } from "@/domain/money";
import type { State, Transaction } from "@/domain/schema";
import { plural } from "@/domain/text";
import { saveTextFile } from "@/client/files";
import { useSnapshot, useStore, useToday } from "@/client/react";
import { useDispatch } from "../../app/hooks";
import { Button, IconButton } from "../../ui/Button";
import { Card, Notice } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { Disclosure } from "./common";

const MAX_IMPORT_BYTES = 30 * 1024 * 1024;
const DROPPED_PREVIEW = 5;

// ---------- CSV ----------

function csvField(value: string): string {
  return /[";\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

/** «-1234,50»: рубли с запятой, как ждёт русский Excel. */
function csvRubles(kopecks: Kopecks): string {
  const abs = Math.abs(kopecks);
  const rubles = Math.floor(abs / 100);
  const cents = String(abs % 100).padStart(2, "0");
  return `${kopecks < 0 ? "-" : ""}${rubles},${cents}`;
}

function csvDate(date: IsoDate): string {
  const { year, month, day } = parseIsoDate(date);
  return `${String(day).padStart(2, "0")}.${String(month).padStart(2, "0")}.${year}`;
}

/** Тип операции и её влияние на счёт (со знаком). */
function csvKind(tx: Transaction): { label: string; effect: Kopecks } {
  switch (tx.type) {
    case "income":
      return { label: "Доход", effect: tx.amount };
    case "expense":
      return { label: tx.mandatory ? "Обязательный расход" : "Расход", effect: -tx.amount };
    case "saving":
      return { label: tx.amount >= 0 ? "В сбережения" : "Из сбережений", effect: -tx.amount };
    case "adjustment":
      return { label: "Корректировка", effect: tx.amount };
  }
}

function buildCsv(state: State): string {
  const rows = [["Дата", "Тип", "Категория", "Описание", "Сумма"]];
  const sorted = [...state.transactions].sort((a, b) => a.date.localeCompare(b.date));
  for (const tx of sorted) {
    const { label, effect } = csvKind(tx);
    rows.push([csvDate(tx.date), label, tx.category, tx.title, csvRubles(effect)]);
  }
  return `﻿${rows.map((r) => r.map(csvField).join(";")).join("\r\n")}\r\n`;
}

// ---------- импорт ----------

function reportText(report: MigrationReport): string {
  const parts = [
    `${report.transactions} ${plural(report.transactions, ["операция", "операции", "операций"])}`,
    `${report.templates} ${plural(report.templates, [
      "регулярный доход или платёж",
      "регулярных дохода или платежа",
      "регулярных доходов и платежей",
    ])}`,
  ];
  if (report.goals) parts.push(`${report.goals} ${plural(report.goals, ["цель", "цели", "целей"])}`);
  if (report.loans) parts.push(`${report.loans} ${plural(report.loans, ["долг", "долга", "долгов"])}`);
  return `Перенесено: ${parts.join(", ")}`;
}

type ExportKind = "backup" | "csv";

export function DataSection() {
  const { state, mode } = useSnapshot();
  const store = useStore();
  const dispatch = useDispatch();
  const today = useToday();
  const toast = useToast();
  const confirm = useConfirm();
  const fileRef = useRef<HTMLInputElement>(null);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState<ExportKind | null>(null);
  const [dropped, setDropped] = useState<string[] | null>(null);
  const [wipeOpen, setWipeOpen] = useState(false);

  /** Вернуть данные, которые были до замены (импорта или удаления). */
  const restore = (previous: State) => {
    if (dispatch({ type: "state.import", state: previous })) {
      setDropped(null);
      toast("Прежние данные возвращены");
    }
  };

  const save = async (kind: ExportKind, filename: string, content: string, mime: string) => {
    if (exporting) return;
    setExporting(kind);
    try {
      const result = await saveTextFile(filename, content, mime);
      if (result !== "cancelled") toast(kind === "backup" ? "Резервная копия сохранена" : "Файл выгружен");
    } catch {
      toast("Не удалось сохранить файл. Попробуйте ещё раз.", { kind: "error" });
    } finally {
      setExporting(null);
    }
  };

  const exportBackup = () => {
    const content = JSON.stringify({ ...state, exportedAt: new Date().toISOString() }, null, 2);
    void save("backup", `budget-backup-${today}.json`, content, "application/json");
  };

  const exportCsv = () => {
    if (!state.transactions.length) {
      toast("Операций пока нет — выгружать нечего");
      return;
    }
    void save("csv", `budget-operations-${today}.csv`, buildCsv(state), "text/csv;charset=utf-8");
  };

  const onFile = async (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Сбрасываем, чтобы тот же файл можно было выбрать ещё раз.
    e.target.value = "";
    if (!file) return;
    if (file.size > MAX_IMPORT_BYTES) {
      toast("Файл слишком большой для резервной копии", { kind: "error" });
      return;
    }
    setImporting(true);
    try {
      let raw: unknown;
      try {
        raw = JSON.parse(await file.text());
      } catch {
        toast("Не удалось прочитать файл: это не резервная копия в формате JSON", { kind: "error" });
        return;
      }
      const ok = await confirm({
        title: "Загрузить данные из файла?",
        message: "Все текущие данные будут заменены данными из файла. Сразу после загрузки замену можно отменить.",
        confirmLabel: "Заменить",
        danger: true,
      });
      if (!ok) return;
      // Копия на случай отмены — берём самое свежее состояние, а не то, что было при рендере.
      const previous = store.getSnapshot().state;
      const result = store.importData(raw);
      if (!result.ok) {
        toast(result.error, { kind: "error" });
        return;
      }
      toast(reportText(result.report), { action: { label: "Отменить", onClick: () => restore(previous) } });
      setDropped(result.report.dropped.length ? result.report.dropped : null);
    } finally {
      setImporting(false);
    }
  };

  const wipe = async () => {
    const ok = await confirm({
      title: "Удалить все данные?",
      message:
        "Операции, регулярные доходы и платежи, цели, долги, категории и настройки будут удалены с этого устройства. Сразу после удаления это можно отменить.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    const previous = store.getSnapshot().state;
    if (!dispatch({ type: "state.import", state: emptyState() })) return;
    setWipeOpen(false);
    setDropped(null);
    toast("Все данные удалены", { action: { label: "Отменить", onClick: () => restore(previous) } });
  };

  return (
    <Card title="Данные">
      <div className="space-y-4">
        <p className="text-sm text-muted">
          {mode === "account"
            ? "Данные хранятся на сервере. Резервная копия пригодится, чтобы сохранить их у себя или перенести."
            : "Данные хранятся только на этом устройстве — время от времени сохраняйте резервную копию."}
        </p>

        <div className="grid gap-2 sm:grid-cols-2">
          <Button
            variant="secondary"
            icon="download"
            loading={exporting === "backup"}
            disabled={exporting !== null}
            onClick={exportBackup}
          >
            Сохранить резервную копию
          </Button>
          <Button
            variant="secondary"
            icon="download"
            loading={exporting === "csv"}
            disabled={exporting !== null}
            onClick={exportCsv}
          >
            Выгрузить операции в CSV
          </Button>
        </div>
        <p className="text-xs text-muted">
          CSV открывается в Excel и Google Таблицах: дата, тип, категория, описание и сумма со знаком — плюс для
          поступлений, минус для списаний со счёта.
        </p>

        <div className="space-y-2 border-t border-border pt-4">
          <Button
            variant="secondary"
            icon="upload"
            loading={importing}
            onClick={() => fileRef.current?.click()}
            className="w-full sm:w-auto"
          >
            Загрузить из файла
          </Button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            className="hidden"
            tabIndex={-1}
            aria-hidden="true"
            onChange={(e) => void onFile(e)}
          />
          <p className="text-xs text-muted">
            Подходят резервные копии этого приложения и файлы экспорта из старой версии планировщика. Текущие данные
            будут заменены{mode === "account" ? " — и на этом устройстве, и на сервере" : ""}.
          </p>
        </div>

        {dropped && (
          <Notice
            tone="warning"
            action={<IconButton icon="close" label="Скрыть" onClick={() => setDropped(null)} />}
          >
            <p className="font-medium">
              Не удалось перенести {dropped.length} {plural(dropped.length, ["запись", "записи", "записей"])}:
            </p>
            <ul className="mt-1 list-disc space-y-0.5 pl-5">
              {dropped.slice(0, DROPPED_PREVIEW).map((item, i) => (
                <li key={i}>{item}</li>
              ))}
            </ul>
            {dropped.length > DROPPED_PREVIEW && <p className="mt-1">и ещё {dropped.length - DROPPED_PREVIEW}</p>}
          </Notice>
        )}

        {mode === "guest" && (
          <div className="border-t border-border pt-4">
            <Disclosure
              label="Удалить все данные с этого устройства"
              danger
              open={wipeOpen}
              onToggle={() => setWipeOpen(!wipeOpen)}
            >
              <div className="space-y-4">
                <Notice tone="negative">
                  Удалятся операции, регулярные доходы и платежи, цели, долги, категории и настройки. Перед этим можно
                  сохранить резервную копию.
                </Notice>
                <Button variant="danger" icon="trash" onClick={() => void wipe()} className="w-full sm:w-auto">
                  Удалить данные
                </Button>
              </div>
            </Disclosure>
          </div>
        )}
      </div>
    </Card>
  );
}
