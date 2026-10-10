"use client";

import { useEffect, useState } from "react";
import { appleAiRespond, appleAiStatus, type AppleAiStatus } from "@/client/native";
import { isNativeApp } from "@/client/runtime";
import { Button } from "../../ui/Button";
import { Card, Notice } from "../../ui/controls";

const REASONS: Record<string, string> = {
  deviceNotEligible: "Этот iPhone не поддерживает Apple Intelligence.",
  appleIntelligenceNotEnabled: "Apple Intelligence выключена: Настройки → Apple Intelligence и Siri.",
  modelNotReady: "Модель Apple ещё загружается на iPhone — попробуйте позже.",
};

type Check = { kind: "idle" } | { kind: "running" } | { kind: "done"; text: string; seconds: number } | { kind: "error"; text: string };

/** Состояние модели Apple Intelligence для помощника и проверка «вживую» — только в iOS-приложении. */
export function AppleAiSection() {
  const [status, setStatus] = useState<AppleAiStatus | null>(null);
  const [check, setCheck] = useState<Check>({ kind: "idle" });

  useEffect(() => {
    if (!isNativeApp()) return;
    let cancelled = false;
    void appleAiStatus().then((s) => {
      if (!cancelled) setStatus(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!isNativeApp()) return null;

  const run = async () => {
    setCheck({ kind: "running" });
    const started = performance.now();
    const reply = await appleAiRespond(
      "device",
      "Ты помощник в приложении бюджета. Отвечай по-русски одной короткой фразой.",
      "Скажи, что ты работаешь прямо на этом iPhone, и посчитай: 1200 минус 350.",
    );
    const seconds = (performance.now() - started) / 1000;
    setCheck("text" in reply ? { kind: "done", text: reply.text, seconds } : { kind: "error", text: reply.message ?? reply.error });
  };

  const device = status?.device;
  return (
    <Card title="Apple Intelligence">
      <div className="space-y-3">
        {!status ? (
          <p className="text-sm text-muted">Проверяем…</p>
        ) : device?.available ? (
          <Notice tone="positive">
            Модель Apple на iPhone доступна{device.contextSize ? ` · контекст ${device.contextSize} токенов` : ""}. В
            AI-помощнике это режим «iPhone»: отвечает без интернета, данные не покидают телефон.
            {device.russian === false && " Русский официально не заявлен, но модель отвечает по-русски."}
          </Notice>
        ) : (
          <Notice tone="warning">{REASONS[device?.reason ?? ""] ?? "Модель Apple на этом iPhone недоступна."}</Notice>
        )}
        {device?.available && (
          <div className="space-y-2">
            <Button variant="secondary" loading={check.kind === "running"} onClick={() => void run()}>
              Проверить модель
            </Button>
            {check.kind === "done" && (
              <p className="text-sm">
                <span className="text-muted">Ответ за {check.seconds.toFixed(1)} с: </span>
                {check.text}
              </p>
            )}
            {check.kind === "error" && <p className="text-sm text-negative">Ошибка: {check.text}</p>}
          </div>
        )}
        {status?.cloud.available && (
          <p className="text-xs text-muted">
            Модель Apple в Private Cloud Compute (iOS 27) приложению недоступна: Apple выдаёт разрешение на неё только
            платным аккаунтам разработчика.
          </p>
        )}
      </div>
    </Card>
  );
}
