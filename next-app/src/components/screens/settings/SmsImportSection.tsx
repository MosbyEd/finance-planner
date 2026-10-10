"use client";

import { useEffect, useState } from "react";
import { Share } from "@capacitor/share";
import { ApiError, api, type SmsKeyStatus } from "@/client/api";
import { useSnapshot } from "@/client/react";
import { apiBase, isNativeApp } from "@/client/runtime";
import { Button } from "../../ui/Button";
import { Card, Notice } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { controlClass } from "../../ui/Field";
import { Disclosure } from "./common";

/** Адрес, куда автоматизация «Команд» отправляет СМС. */
function importUrl(): string {
  return `${apiBase() || window.location.origin}/api/import/sms`;
}

/** Задание для Siri с командой самого приложения: без адреса и ключа — она входит токеном приложения. */
const APP_ACTION_PROMPT = [
  "Создай в приложении «Команды» личную автоматизацию.",
  "Когда: я получаю сообщение от отправителя 900. Запускать сразу, без подтверждения.",
  "Действие: «Добавить операцию из СМС» из приложения «Бюджет», в поле «Текст СМС» — содержимое полученного сообщения.",
].join("\n");

/** Текст для Siri: по нему она сама собирает автоматизацию в «Командах» (запрос к серверу с ключом). */
function siriPrompt(url: string, key: string): string {
  return [
    "Создай в приложении «Команды» личную автоматизацию.",
    "Когда: я получаю сообщение от отправителя 900. Запускать сразу, без подтверждения.",
    "Действия:",
    `1. «Получить содержимое URL»: адрес ${url}, метод POST, заголовок Authorization со значением «Bearer ${key}», тело запроса JSON с полем text (тип «Текст»), в которое подставлено содержимое полученного сообщения.`,
    "2. «Получить значение из словаря» по ключу message из ответа.",
    "3. «Показать уведомление» с этим значением.",
  ].join("\n");
}

/** Копирует текст; если буфер обмена недоступен, в приложении открывает «Поделиться» (там есть «Скопировать»). */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    if (!isNativeApp()) return false;
    try {
      await Share.share({ text });
      return true;
    } catch {
      return false;
    }
  }
}

function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString("ru-RU", { day: "numeric", month: "long", hour: "2-digit", minute: "2-digit" });
}

/** Операции из СМС банка — только с аккаунтом: СМС приходят на сервер, а не в приложение. */
export function SmsImportSection() {
  const { mode, user } = useSnapshot();
  if (mode === "guest" || !user) return null;
  return isNativeApp() ? <AppActionSetup /> : <SmsImport />;
}

/** В iOS-приложении: автоматизация с командой самого приложения (ключ не нужен), ключ — запасной способ. */
function AppActionSetup() {
  const toast = useToast();
  const [manual, setManual] = useState(false);
  const [keyWay, setKeyWay] = useState(false);
  const copy = async () => {
    if (await copyText(APP_ACTION_PROMPT)) toast("Задание для Siri скопировано");
    else toast("Не удалось скопировать — выделите текст вручную.", { kind: "error" });
  };
  return (
    <Card title="Операции из СМС">
      <div className="space-y-4">
        <p className="text-[15px] text-muted">
          Покупки, переводы и зарплата из СМС Сбербанка (номер 900) добавляются сами, а запланированные платежи
          отмечаются фактической суммой. Новые операции приложение покажет при запуске — их можно подтвердить или
          поправить.
        </p>
        <p className="text-[15px] text-muted">
          Нужна автоматизация в «Командах» с действием «Добавить операцию из СМС» этого приложения. Скопируйте задание
          и вставьте его в Siri — она соберёт автоматизацию сама. Без интернета СМС подождёт и отправится позже.
        </p>
        <textarea
          readOnly
          rows={5}
          value={APP_ACTION_PROMPT}
          aria-label="Задание для Siri"
          onFocus={(e) => e.currentTarget.select()}
          className={`${controlClass} h-auto py-3 text-sm`}
        />
        <Button onClick={() => void copy()}>Скопировать задание для Siri</Button>
        <Disclosure label="Настроить вручную" open={manual} onToggle={() => setManual((v) => !v)}>
          <ol className="list-decimal space-y-2 pl-5 text-sm">
            <li>В «Контактах» создайте контакт «900» с номером 900 — чтобы выбрать его отправителем.</li>
            <li>
              «Команды» → «Автоматизация» → «+» → «Сообщение». Отправитель — 900. Включите «Запускать сразу» → «Далее» →
              «Новая пустая команда».
            </li>
            <li>
              Найдите действие «Добавить операцию из СМС» (приложение «Бюджет») и в поле «Текст СМС» выберите «Ввод
              команды» — содержимое сообщения.
            </li>
            <li>Команда работает, пока вы вошли в аккаунт в приложении.</li>
          </ol>
        </Disclosure>
        <Disclosure label="Другой способ — через адрес сервера и ключ" open={keyWay} onToggle={() => setKeyWay((v) => !v)}>
          <SmsImport embedded />
        </Disclosure>
      </div>
    </Card>
  );
}

type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; key: SmsKeyStatus | null };

/** Ключ для автоматизации, которая сама шлёт СМС на сервер. embedded — внутри раздела приложения, без своей карточки. */
function SmsImport({ embedded = false }: { embedded?: boolean }) {
  const toast = useToast();
  const confirm = useConfirm();
  const [status, setStatus] = useState<Status>({ kind: "loading" });
  /** Только что созданный ключ — показывается один раз. */
  const [fresh, setFresh] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api.smsKeyStatus().then(
      (r) => !cancelled && setStatus({ kind: "ready", key: r.key }),
      (e) => !cancelled && setStatus({ kind: "error", message: e instanceof ApiError ? e.message : "Не удалось загрузить." }),
    );
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  const hasKey = status.kind === "ready" && status.key !== null;

  const create = async () => {
    if (busy) return;
    if (hasKey) {
      const ok = await confirm({
        title: "Создать новый ключ?",
        message: "Прежний перестанет работать — в автоматизации «Команд» нужно будет заменить ключ.",
        confirmLabel: "Создать",
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const created = await api.createSmsKey();
      setFresh(created.key);
      setStatus({ kind: "ready", key: { createdAt: created.createdAt, lastUsedAt: null } });
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось создать ключ.", { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const disable = async () => {
    if (busy) return;
    const ok = await confirm({
      title: "Отключить операции из СМС?",
      message: "Ключ перестанет работать, автоматизация в «Командах» больше ничего не добавит. Её можно удалить.",
      confirmLabel: "Отключить",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteSmsKey();
      setFresh(null);
      setStatus({ kind: "ready", key: null });
      toast("Операции из СМС отключены");
    } catch (e) {
      toast(e instanceof ApiError ? e.message : "Не удалось отключить.", { kind: "error" });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, done: string) => {
    if (await copyText(text)) toast(done);
    else toast("Не удалось скопировать — выделите текст вручную.", { kind: "error" });
  };

  const url = importUrl();

  const body = (
    <div className="space-y-4">
      <p className="text-[15px] text-muted">
        {embedded
          ? "Автоматизация отправляет СМС прямо на сервер с отдельным ключом — так можно настроить и без приложения."
          : "Покупки, переводы и зарплата из СМС Сбербанка (номер 900) добавляются сами, а запланированные платежи отмечаются фактической суммой. Приложения на iPhone не могут читать СМС, поэтому текст передаёт автоматизация «Команд». Категорию подбираем по магазину и запоминаем, если вы её поправите."}
      </p>

      {status.kind === "loading" && <p className="text-sm text-muted">Загружаем…</p>}
      {status.kind === "error" && (
        <Notice
          tone="warning"
          action={
            <Button size="sm" variant="secondary" onClick={() => setAttempt((n) => n + 1)}>
              Повторить
            </Button>
          }
        >
          {status.message}
        </Notice>
      )}

      {status.kind === "ready" && status.key && !fresh && (
        <Notice tone="positive">
          Подключено.{" "}
          {status.key.lastUsedAt
            ? `Последняя СМС: ${formatWhen(status.key.lastUsedAt)}.`
            : "СМС ещё не приходили — проверьте автоматизацию в «Командах»."}
        </Notice>
      )}

      {fresh && (
        <div className="space-y-3">
          <Notice tone="positive">
            Ключ создан. Он показывается один раз: скопируйте задание для Siri и вставьте его в Siri — она соберёт
            автоматизацию. Если не получится, настройте вручную (ниже).
          </Notice>
          <textarea
            readOnly
            rows={7}
            value={siriPrompt(url, fresh)}
            aria-label="Задание для Siri"
            onFocus={(e) => e.currentTarget.select()}
            className={`${controlClass} h-auto py-3 text-sm`}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy(siriPrompt(url, fresh), "Задание для Siri скопировано")}>
              Скопировать задание для Siri
            </Button>
            <Button variant="secondary" onClick={() => void copy(fresh, "Ключ скопирован")}>
              Скопировать ключ
            </Button>
          </div>
          <Disclosure label="Настроить вручную" open={manual} onToggle={() => setManual((v) => !v)}>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>В «Контактах» создайте контакт «900» с номером 900 — чтобы выбрать его отправителем.</li>
              <li>
                «Команды» → «Автоматизация» → «+» → «Сообщение». Отправитель — 900. Включите «Запускать сразу» → «Далее» →
                «Новая пустая команда».
              </li>
              <li>
                Добавьте действие «Получить содержимое URL». Адрес: <span className="break-all font-mono">{url}</span>.
                Метод — POST. Заголовок <span className="font-mono">Authorization</span> со значением{" "}
                <span className="break-all font-mono">Bearer {fresh}</span>. Тело запроса — JSON: поле{" "}
                <span className="font-mono">text</span> (Текст), значение — «Ввод команды» (содержимое сообщения).
              </li>
              <li>
                По желанию: «Получить значение из словаря» по ключу <span className="font-mono">message</span> и «Показать
                уведомление» — так вы увидите, что добавилось.
              </li>
            </ol>
          </Disclosure>
        </div>
      )}

      {status.kind === "ready" && (
        <div className="flex flex-wrap gap-2">
          <Button variant={hasKey ? "secondary" : "primary"} loading={busy && !hasKey} onClick={() => void create()}>
            {hasKey ? "Создать новый ключ" : "Подключить"}
          </Button>
          {hasKey && (
            <Button variant="ghost" disabled={busy} onClick={() => void disable()}>
              Отключить
            </Button>
          )}
        </div>
      )}
    </div>
  );
  return embedded ? body : <Card title="Операции из СМС">{body}</Card>;
}
