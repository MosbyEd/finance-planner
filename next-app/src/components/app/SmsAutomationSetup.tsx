"use client";

import { useState } from "react";
import { GENERIC_SHORTCUT, senderKey, type BankShortcut } from "@/domain/banks";
import { nativeAddSmsShortcut, nativeOpenShortcuts, nativeOpenShortcutsApp } from "@/client/native";
import { isNativeApp } from "@/client/runtime";
import { Button } from "../ui/Button";
import { useToast } from "../ui/feedback";
import { controlClass } from "../ui/Field";
import { Disclosure } from "../screens/settings/common";
import { appActionPrompt, copyText, sendersText } from "./smsSetup";

/**
 * Автоматизация «Команд» для СМС от этих отправителей. У известного банка — своя готовая команда («Бюджет СМС
 * Т-Банк»): при добавлении она сама создаёт автоматизацию на его отправителей. Иначе — общая «Бюджет СМС»
 * и автоматизация вручную. Или отправителей можно дописать в уже созданную автоматизацию. Ещё — задание для Siri
 * и способ без команды. Кнопки «Команд» — только в iOS-приложении; на компьютере видны шаги и задание.
 */
export function SmsAutomationSetup({ senders, shortcut = null }: { senders: string[]; shortcut?: BankShortcut | null }) {
  const toast = useToast();
  const native = isNativeApp();
  const [siri, setSiri] = useState(false);
  const [manual, setManual] = useState(false);
  const [existing, setExisting] = useState(false);
  const list = sendersText(senders);
  const prompt = appActionPrompt(senders);
  const many = senders.length > 1;
  // Отправители банка, которых нет в готовой команде: их дописывают в автоматизацию вручную.
  const inShortcut = new Set((shortcut?.senders ?? []).map(senderKey));
  const extra = shortcut ? senders.filter((s) => !inShortcut.has(senderKey(s))) : [];
  const copy = async () => {
    if (await copyText(prompt)) toast("Задание для Siri скопировано");
    else toast("Не удалось скопировать — выделите текст вручную.", { kind: "error" });
  };
  const add = (name?: string) =>
    void nativeAddSmsShortcut(name).then((ok) => {
      if (!ok) toast("Обновите приложение — в этой сборке такой команды нет.", { kind: "error" });
    });
  const openApp = () =>
    void nativeOpenShortcutsApp().then((ok) => {
      if (!ok) toast("Не удалось открыть «Команды».", { kind: "error" });
    });
  const onIphone = "В приложении «Бюджет» на iPhone: Настройки → «Банки» → этот банк → «Добавить команду», в окне «Поделиться» — «Команды».";

  return (
    <div className="space-y-4">
      {shortcut ? (
        <div className="space-y-2 text-[15px]">
          <p className="font-medium">Добавьте команду «{shortcut.name}»</p>
          <p className="text-sm text-muted">
            {native ? "В окне «Поделиться» выберите «Команды» → «Добавить быструю команду». " : `${onIphone} `}
            Команда сама создаст автоматизацию на сообщения от {sendersText(shortcut.senders)}. Проверьте в «Командах» →
            «Автоматизация», что у неё включено «Запускать сразу».
          </p>
          {extra.length > 0 && (
            <p className="text-sm text-warning">
              {extra.length > 1 ? "Отправителей" : "Отправителя"} {sendersText(extra)} в готовой команде нет — допишите в её
              автоматизации: «Команды» → «Автоматизация» → она → «Отправитель».
            </p>
          )}
          <p className="text-sm text-muted">
            Не добавляйте команду второй раз, если автоматизация на этих отправителей уже есть, — иначе каждая СМС придёт
            дважды.
          </p>
          {native && (
            <Button className="mt-1" icon="plus" onClick={() => add(shortcut.name)}>
              Добавить команду
            </Button>
          )}
        </div>
      ) : (
        <ol className="space-y-3 text-[15px]">
          <li>
            <p className="font-medium">1. Добавьте команду «{GENERIC_SHORTCUT}»</p>
            <p className="text-sm text-muted">
              {native
                ? "В окне «Поделиться» выберите «Команды» → «Добавить быструю команду». Уже добавлена до этого обновления — добавьте заново: новая передаёт и отправителя."
                : onIphone}
            </p>
            {native && (
              <Button className="mt-2" icon="plus" onClick={() => add()}>
                Добавить команду
              </Button>
            )}
          </li>
          <li>
            <p className="font-medium">2. Создайте автоматизацию</p>
            <p className="text-sm text-muted">
              «Команды» → «Автоматизация» → «+» → «Сообщение». {many ? "Отправители" : "Отправитель"} — {list}, включите
              «Запускать сразу» → «Новая пустая автоматизация» → действие «Запустить быструю команду» → «{GENERIC_SHORTCUT}»,
              ввод — «Ввод команды».
            </p>
            {native && (
              <Button className="mt-2" variant="secondary" onClick={openApp}>
                Открыть «Команды»
              </Button>
            )}
          </li>
        </ol>
      )}
      <Disclosure label="Или — в уже созданную автоматизацию" open={existing} onToggle={() => setExisting((v) => !v)}>
        <div className="space-y-3 text-sm">
          <p>
            Одна автоматизация на все банки: «Команды» → «Автоматизация» → ваша автоматизация по СМС → «Отправитель» →
            добавьте {list}. Новую команду тогда добавлять не нужно.
          </p>
          <p className="text-muted">
            Отправителя нет в списке — создайте в «Контактах» контакт, у которого в поле телефона этот номер или имя
            (например, {senders[0] ?? "900"}), и выберите его.
          </p>
          {native && (
            <Button variant="secondary" onClick={openApp}>
              Открыть «Команды»
            </Button>
          )}
        </div>
      </Disclosure>
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
