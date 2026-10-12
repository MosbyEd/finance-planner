"use client";

import { useState } from "react";
import { useSnapshot, useToday } from "@/client/react";
import { Button } from "../../ui/Button";
import { useToast } from "../../ui/feedback";
import { controlClass } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { useDispatch } from "../hooks";
import { useUi } from "../overlays";
import { smsTextImport } from "../smsText";

/** «Из СМС» в окне «+»: вставить текст сообщения банка — операция добавится так же, как из автоматизации. */
export function SmsPasteSheet() {
  const { state } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const { close, open } = useUi();
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const add = () => {
    const result = smsTextImport(state, text, today);
    if (!result.actions.length) {
      setError(result.message);
      return;
    }
    if (dispatch(result.actions)) {
      close();
      const txId = result.txId;
      // Категорию подобрали по магазину — поправить можно сразу.
      toast(result.message, txId ? { action: { label: "Изменить", onClick: () => open({ kind: "tx", txId }) } } : undefined);
    }
  };
  return (
    <Sheet
      open
      onClose={close}
      dirty={Boolean(text.trim())}
      title="Операция из СМС"
      // «Добавить» — только когда текст вставлен.
      footer={
        text.trim() ? (
          <Button className="w-full animate-fade" onClick={add}>
            Добавить
          </Button>
        ) : undefined
      }
    >
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Вставьте текст СМС банка: сумма, магазин, категория и счёт подставятся сами, а остаток сверится с банком.
          Поправить можно потом в «Истории».
        </p>
        <textarea
          data-autofocus
          rows={5}
          value={text}
          onChange={(e) => {
            setText(e.target.value);
            setError(null);
          }}
          aria-label="Текст СМС"
          aria-invalid={error ? true : undefined}
          placeholder="Например: СЧЁТ5804 12:00 Покупка 500р LENTA Баланс: 9 500р"
          className={`${controlClass} h-auto py-3 text-base sm:text-sm`}
        />
        {error && <p className="text-sm text-negative">{error}</p>}
      </div>
    </Sheet>
  );
}
