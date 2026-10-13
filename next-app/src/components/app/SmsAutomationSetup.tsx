"use client";

import { useState } from "react";
import { nativeAddSmsShortcut, nativeOpenShortcuts, nativeOpenShortcutsApp } from "@/client/native";
import { isNativeApp } from "@/client/runtime";
import { Button } from "../ui/Button";
import { useToast } from "../ui/feedback";
import { controlClass } from "../ui/Field";
import { Disclosure } from "../screens/settings/common";
import { appActionPrompt, copyText, sendersText } from "./smsSetup";

/**
 * Автоматизация «Команд» для СМС от этих отправителей: команда «Бюджет СМС», шаги автоматизации, задание для Siri
 * и способ без команды — действием приложения. Создать автоматизацию по сообщениям iOS разрешает только самому
 * пользователю. Кнопки «Команд» — только в iOS-приложении; на компьютере видны шаги и задание.
 */
export function SmsAutomationSetup({ senders }: { senders: string[] }) {
  const toast = useToast();
  const native = isNativeApp();
  const [siri, setSiri] = useState(false);
  const [manual, setManual] = useState(false);
  const list = sendersText(senders);
  const prompt = appActionPrompt(senders);
  const many = senders.length > 1;
  const copy = async () => {
    if (await copyText(prompt)) toast("Задание для Siri скопировано");
    else toast("Не удалось скопировать — выделите текст вручную.", { kind: "error" });
  };
  return (
    <div className="space-y-4">
      <ol className="space-y-3 text-[15px]">
        <li>
          <p className="font-medium">1. Добавьте команду «Бюджет СМС»</p>
          <p className="text-sm text-muted">
            {native
              ? "В окне «Поделиться» выберите «Команды» → «Добавить быструю команду». Уже добавлена до этого обновления — добавьте заново: новая передаёт и отправителя."
              : "В приложении «Бюджет» на iPhone: Настройки → «Банки» → этот банк → «Добавить команду», в окне «Поделиться» — «Команды»."}
          </p>
          {native && (
            <Button
              className="mt-2"
              icon="plus"
              onClick={() =>
                void nativeAddSmsShortcut().then((ok) => {
                  if (!ok) toast("Обновите приложение — в этой сборке команды нет.", { kind: "error" });
                })
              }
            >
              Добавить команду
            </Button>
          )}
        </li>
        <li>
          <p className="font-medium">2. Создайте автоматизацию</p>
          <p className="text-sm text-muted">
            «Команды» → «Автоматизация» → «+» → «Сообщение». {many ? "Отправители" : "Отправитель"} — {list}, включите
            «Запускать сразу» → «Новая пустая автоматизация» → действие «Запустить быструю команду» → «Бюджет СМС», ввод —
            «Ввод команды». Автоматизация для другого банка уже есть — можно добавить этих отправителей в неё.
          </p>
          {native && (
            <Button
              className="mt-2"
              variant="secondary"
              onClick={() =>
                void nativeOpenShortcutsApp().then((ok) => {
                  if (!ok) toast("Не удалось открыть «Команды».", { kind: "error" });
                })
              }
            >
              Открыть «Команды»
            </Button>
          )}
        </li>
      </ol>
      <p className="text-sm text-muted">
        Отправителя нет в списке — создайте в «Контактах» контакт, у которого в поле телефона этот номер или имя (например,
        {" "}
        {senders[0] ?? "900"}), и выберите его.
      </p>
      <Disclosure label="Задание для Siri" open={siri} onToggle={() => setSiri((v) => !v)}>
        <div className="space-y-3">
          <textarea
            readOnly
            rows={6}
            value={prompt}
            aria-label="Задание для Siri"
            onFocus={(e) => e.currentTarget.select()}
            className={`${controlClass} h-auto py-3 text-base sm:text-sm`}
          />
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => void copy()}>
              Скопировать задание для Siri
            </Button>
            {native && (
              <Button
                variant="secondary"
                icon="sparkles"
                onClick={() =>
                  void nativeOpenShortcuts().then((ok) => {
                    if (!ok) toast("Обновите приложение, чтобы открыть «Siri и Команды».", { kind: "error" });
                  })
                }
              >
                Siri и Команды
              </Button>
            )}
          </div>
        </div>
      </Disclosure>
      <Disclosure label="Без команды — действием приложения" open={manual} onToggle={() => setManual((v) => !v)}>
        <ol className="list-decimal space-y-2 pl-5 text-sm">
          <li>
            «Команды» → «Автоматизация» → «+» → «Сообщение». {many ? "Отправители" : "Отправитель"} — {list}. Включите
            «Запускать сразу» → «Далее» → «Новая пустая команда».
          </li>
          <li>
            Найдите действие «Добавить операцию из СМС» (приложение «Бюджет»). В поле «Текст СМС» выберите «Ввод команды» →
            «Содержимое», в поле «Отправитель» — «Ввод команды» → «Отправитель».
          </li>
          <li>Команда работает, пока вы вошли в аккаунт в приложении.</li>
        </ol>
      </Disclosure>
    </div>
  );
}
