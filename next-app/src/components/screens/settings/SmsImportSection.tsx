"use client";

import { useEffect, useState } from "react";
import { banksOf } from "@/domain/banks";
import { ApiError, api, type SmsKeyStatus } from "@/client/api";
import { useSnapshot, useToday } from "@/client/react";
import { useDispatch } from "../../app/hooks";
import { useUi } from "../../app/overlays";
import { SmsAutomationSetup } from "../../app/SmsAutomationSetup";
import { allSmsSenders, copyText, keyPrompt, sendersText } from "../../app/smsSetup";
import { smsTextImport } from "../../app/smsText";
import { apiBase, isNativeApp } from "@/client/runtime";
import { Button } from "../../ui/Button";
import { Notice } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { controlClass } from "../../ui/Field";
import { Disclosure } from "./common";
import { SectionCard, useRowSummary } from "./SettingsList";

/** Адрес, куда автоматизация «Команд» отправляет СМС. */
function importUrl(): string {
  return `${apiBase() || window.location.origin}/api/import/sms`;
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

/** Банки и их отправители: СМС от них разбираются; ссылка на раздел «Банки». */
function BanksNote() {
  const { state } = useSnapshot();
  const { openSettings } = useUi();
  const banks = banksOf(state);
  return (
    <Notice
      tone="info"
      action={
        <Button size="sm" variant="secondary" onClick={() => openSettings("banks")}>
          Банки
        </Button>
      }
    >
      {banks.length
        ? `Банки: ${banks.map((b) => b.name).join(", ")}. Отправители СМС и счета каждого банка — в разделе «Банки».`
        : "Банков пока нет — СМС принимаются от Сбербанка (900). Другие банки и их отправителей добавьте в разделе «Банки»."}
    </Notice>
  );
}

/** В iOS-приложении: автоматизация с командой самого приложения (ключ не нужен), ключ — запасной способ. */
function AppActionSetup() {
  const { state } = useSnapshot();
  const [keyWay, setKeyWay] = useState(false);
  return (
    <SectionCard title="Операции из СМС">
      <div className="space-y-4">
        <p className="text-[15px] text-muted">
          Покупки, переводы и зарплата из СМС банков добавляются сами, а запланированные платежи отмечаются фактической
          суммой. Новые операции приложение покажет при запуске — их можно подтвердить или поправить.
        </p>
        <BanksNote />
        <SmsAutomationSetup senders={allSmsSenders(state)} />
        <p className="text-sm text-muted">Без интернета СМС подождёт и отправится, когда связь появится.</p>
        <Disclosure label="Другой способ — через адрес сервера и ключ" open={keyWay} onToggle={() => setKeyWay((v) => !v)}>
          <SmsImport embedded />
        </Disclosure>
        <PasteSms />
      </div>
    </SectionCard>
  );
}

type Status = { kind: "loading" } | { kind: "error"; message: string } | { kind: "ready"; key: SmsKeyStatus | null };

/** Ключ для автоматизации, которая сама шлёт СМС на сервер. embedded — внутри раздела приложения, без своей карточки. */
function SmsImport({ embedded = false }: { embedded?: boolean }) {
  const { state } = useSnapshot();
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
  // Внутри раздела приложения ключ — запасной способ, его состояние строке не показываем.
  useRowSummary(embedded || status.kind !== "ready" ? null : { text: hasKey ? "Подключено" : "Не подключено" });

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
  const senders = allSmsSenders(state);
  const siriPrompt = (key: string) => keyPrompt(url, key, senders);

  const body = (
    <div className="space-y-4">
      <p className="text-[15px] text-muted">
        {embedded
          ? "Автоматизация отправляет СМС прямо на сервер с отдельным ключом — так можно настроить и без приложения."
          : "Покупки, переводы и зарплата из СМС банков добавляются сами, а запланированные платежи отмечаются фактической суммой. Приложения на iPhone не могут читать СМС, поэтому текст передаёт автоматизация «Команд». Категорию подбираем по магазину и запоминаем, если вы её поправите."}
      </p>
      {!embedded && <BanksNote />}

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
            value={siriPrompt(fresh)}
            aria-label="Задание для Siri"
            onFocus={(e) => e.currentTarget.select()}
            className={`${controlClass} h-auto py-3 text-base sm:text-sm`}
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void copy(siriPrompt(fresh), "Задание для Siri скопировано")}>
              Скопировать задание для Siri
            </Button>
            <Button variant="secondary" onClick={() => void copy(fresh, "Ключ скопирован")}>
              Скопировать ключ
            </Button>
          </div>
          <Disclosure label="Настроить вручную" open={manual} onToggle={() => setManual((v) => !v)}>
            <ol className="list-decimal space-y-2 pl-5 text-sm">
              <li>
                «Команды» → «Автоматизация» → «+» → «Сообщение». {senders.length > 1 ? "Отправители" : "Отправитель"} —{" "}
                {sendersText(senders)} (нет в списке — создайте контакт с этим номером или именем в поле телефона). Включите
                «Запускать сразу» → «Далее» → «Новая пустая команда».
              </li>
              <li>
                Добавьте действие «Получить содержимое URL». Адрес: <span className="break-all font-mono">{url}</span>.
                Метод — POST. Заголовок <span className="font-mono">Authorization</span> со значением{" "}
                <span className="break-all font-mono">Bearer {fresh}</span>. Тело запроса — JSON: поле{" "}
                <span className="font-mono">text</span> (Текст) — «Ввод команды» → «Содержимое» и поле{" "}
                <span className="font-mono">sender</span> (Текст) — «Ввод команды» → «Отправитель».
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
      {!embedded && <PasteSms />}
    </div>
  );
  return embedded ? body : <SectionCard title="Операции из СМС">{body}</SectionCard>;
}

/**
 * СМС не добавилась сама (автоматизация не сработала или раньше была ошибка) — вставить текст и добавить так же,
 * как автоматизация: с той же категорией, сверкой остатков и защитой от повтора.
 */
function PasteSms() {
  const { state } = useSnapshot();
  const today = useToday();
  const dispatch = useDispatch();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const add = () => {
    const result = smsTextImport(state, text, today);
    if (!result.actions.length) {
      toast(result.message, { kind: "error" });
      return;
    }
    if (dispatch(result.actions)) {
      toast(result.message);
      setText("");
    }
  };
  return (
    <Disclosure label="Добавить СМС вручную" open={open} onToggle={() => setOpen((v) => !v)}>
      <div className="space-y-3">
        <p className="text-sm text-muted">
          Если СМС не добавилась сама, вставьте её текст — обработаем так же, как автоматизация, вместе со сверкой
          остатков.
        </p>
        <textarea
          rows={4}
          value={text}
          onChange={(e) => setText(e.target.value)}
          aria-label="Текст СМС"
          placeholder="Например: СЧЁТ5804 12:00 Покупка 500р LENTA Баланс: 9 500р"
          className={`${controlClass} h-auto py-3 text-base sm:text-sm`}
        />
        <Button onClick={add} disabled={!text.trim()}>
          Добавить
        </Button>
      </div>
    </Disclosure>
  );
}
