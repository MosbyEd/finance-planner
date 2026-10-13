"use client";

import { formatDay } from "@/domain/dates";
import { useUi } from "../../app/overlays";
import { APP_VERSION, LATEST_RELEASE } from "../../app/whatsNew/releases";
import { Button } from "../../ui/Button";
import { SectionCard } from "./SettingsList";

/** Коммит, из которого собран интерфейс: у телефона он свой (интерфейс в пакете), у сайта и Mac — серверный. */
const COMMIT = process.env.NEXT_PUBLIC_APP_COMMIT ?? "";

export function AboutSection() {
  const { open } = useUi();
  return (
    <SectionCard title="О приложении">
      <div className="space-y-3 text-[15px]">
        <p>
          Лимит на день — меньшее из двух чисел. Первое — остаток гибкого бюджета месяца (доходы минус обязательные
          расходы и норма сбережений, минус уже потраченное на повседневные траты), разделённый на оставшиеся дни. Второе — деньги на счёте минус платежи
          до ближайшего дохода, разделённые на дни до него. Так денег хватит и на план месяца, и на обязательные платежи.
        </p>
        <p className="text-sm text-muted">
          Все суммы хранятся в копейках целыми числами, поэтому расчёты точные — без ошибок округления.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="soft" icon="sparkles" onClick={() => open({ kind: "whatsNew" })}>
            Что нового
          </Button>
          <Button variant="soft" icon="info" onClick={() => open({ kind: "explain" })}>
            Как посчитан лимит сегодня
          </Button>
        </div>
        <p className="text-sm text-muted">
          Версия {APP_VERSION} от {formatDay(LATEST_RELEASE.date)}
          {COMMIT && ` · сборка ${COMMIT}`}
        </p>
      </div>
    </SectionCard>
  );
}
