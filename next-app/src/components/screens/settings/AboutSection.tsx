"use client";

import { useUi } from "../../app/overlays";
import { Button } from "../../ui/Button";
import { Card } from "../../ui/controls";

const APP_VERSION = "3.0";

export function AboutSection() {
  const { open } = useUi();
  return (
    <Card title="О приложении">
      <div className="space-y-3 text-[15px]">
        <p>
          Лимит на день — меньшее из двух чисел. Первое — остаток гибкого бюджета месяца (доходы минус обязательные
          расходы и норма сбережений, минус уже потраченное на повседневные траты), разделённый на оставшиеся дни. Второе — деньги на счёте минус платежи
          до ближайшего дохода, разделённые на дни до него. Так денег хватит и на план месяца, и на обязательные платежи.
        </p>
        <p className="text-sm text-muted">
          Все суммы хранятся в копейках целыми числами, поэтому расчёты точные — без ошибок округления.
        </p>
        <Button variant="soft" icon="info" onClick={() => open({ kind: "explain" })}>
          Как посчитан лимит сегодня
        </Button>
        <p className="text-sm text-muted">Версия {APP_VERSION}</p>
      </div>
    </Card>
  );
}
