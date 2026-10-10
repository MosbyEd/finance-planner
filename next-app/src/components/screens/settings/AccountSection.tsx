"use client";

import { useState } from "react";
import { ApiError, api } from "@/client/api";
import { useSnapshot, useStore } from "@/client/react";
import { PasswordInput } from "../../app/sheets/AuthSheet";
import { useUi } from "../../app/overlays";
import { Button } from "../../ui/Button";
import { Card, Notice } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { TextInput } from "../../ui/Field";
import { Icon, type IconName } from "../../ui/Icon";
import { Disclosure } from "./common";

const MAX_NAME = 60;
const MIN_PASSWORD = 8;

export function AccountSection() {
  const { mode, user } = useSnapshot();
  if (mode === "guest" || !user) return <GuestAccount />;
  return <SignedInAccount login={user.login} name={user.name} />;
}

function GuestAccount() {
  const { open } = useUi();
  const { registrationOpen } = useSnapshot();
  return (
    <Card title="Аккаунт">
      <p className="text-[15px] text-muted">
        Вы ведёте бюджет без входа: данные хранятся только на этом устройстве. Если удалить приложение, очистить данные
        браузера или открыть приложение на другом устройстве, их там не будет. С аккаунтом данные сохраняются на сервере, доступны со всех
        ваших устройств и работает AI-помощник.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <Button icon="user" onClick={() => open({ kind: "auth", mode: "login" })}>
          Войти
        </Button>
        {registrationOpen && (
          <Button variant="secondary" onClick={() => open({ kind: "auth", mode: "register" })}>
            Создать аккаунт
          </Button>
        )}
      </div>
    </Card>
  );
}

function SignedInAccount({ login, name }: { login: string; name: string | null }) {
  return (
    <Card title="Аккаунт">
      <div className="space-y-5">
        <div className="flex items-center gap-3">
          <span className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full bg-accent-soft text-accent">
            <Icon name="user" size={22} />
          </span>
          <div className="min-w-0">
            <p className="truncate text-[15px] font-semibold">{name || login}</p>
            <p className="truncate text-sm text-muted">Логин: {login}</p>
          </div>
        </div>
        <SyncLine />
        <NameForm name={name} />
        <div className="space-y-3">
          <PasswordForm login={login} />
          <DeleteAccount login={login} />
        </div>
        <LogoutButton />
      </div>
    </Card>
  );
}

function SyncLine() {
  const { sync, sessionExpired } = useSnapshot();
  const store = useStore();
  const { open } = useUi();

  const view: Record<typeof sync.status, { icon: IconName; tone: string; text: string }> = {
    synced: { icon: "cloud", tone: "text-positive", text: "Все изменения сохранены на сервере" },
    saving: {
      icon: "cloud",
      tone: "text-muted",
      text: sync.pending ? `Отправляем изменения на сервер (${sync.pending})…` : "Отправляем изменения на сервер…",
    },
    offline: {
      icon: "cloudOff",
      tone: "text-warning",
      text: sync.pending
        ? `Нет связи с сервером. Не отправлено изменений: ${sync.pending} — отправим, когда связь появится`
        : "Нет связи с сервером",
    },
    error: { icon: "alert", tone: "text-negative", text: sync.message ?? "Ошибка синхронизации" },
  };
  const current = view[sync.status];

  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-2xl bg-surface-2 px-4 py-3">
      <p className={`flex min-w-0 flex-1 items-start gap-2 text-sm ${current.tone}`}>
        <Icon name={current.icon} size={18} className="mt-px shrink-0" />
        <span>{current.text}</span>
      </p>
      {sessionExpired ? (
        <Button size="sm" onClick={() => open({ kind: "auth", mode: "login" })}>
          Войти снова
        </Button>
      ) : (
        (sync.status === "offline" || sync.status === "error") && (
          <Button size="sm" variant="secondary" onClick={() => void store.resume()}>
            Повторить
          </Button>
        )
      )}
    </div>
  );
}

function NameForm({ name }: { name: string | null }) {
  const store = useStore();
  const toast = useToast();
  const [base, setBase] = useState(name);
  const [draft, setDraft] = useState(name ?? "");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Имя поменялось снаружи (например, после повторного входа) — обновляем поле.
  if (name !== base) {
    setBase(name);
    setDraft(name ?? "");
  }

  const next = draft.trim();
  const dirty = next !== (name ?? "");

  const save = async () => {
    if (!dirty || saving) return;
    if (next.length > MAX_NAME) {
      setError(`Имя — до ${MAX_NAME} символов`);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await api.updateName(next);
      store.setUserName(next || null);
      toast(next ? "Имя сохранено" : "Имя удалено");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось сохранить имя.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <TextInput
        label="Имя"
        placeholder="Как к вам обращаться"
        value={draft}
        maxLength={MAX_NAME}
        autoComplete="nickname"
        error={error}
        hint="Необязательно. Показывается только вам."
        onChange={(e) => {
          setDraft(e.target.value);
          setError(null);
        }}
      />
      {dirty && (
        <div className="flex gap-2">
          <Button type="submit" loading={saving}>
            Сохранить имя
          </Button>
          <Button variant="ghost" disabled={saving} onClick={() => setDraft(name ?? "")}>
            Отменить
          </Button>
        </div>
      )}
    </form>
  );
}

interface PasswordErrors {
  current?: string;
  next?: string;
  repeat?: string;
  form?: string;
}

function PasswordForm({ login }: { login: string }) {
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [errors, setErrors] = useState<PasswordErrors>({});
  const [saving, setSaving] = useState(false);

  const reset = () => {
    setCurrent("");
    setNext("");
    setRepeat("");
    setErrors({});
  };

  const submit = async () => {
    if (saving) return;
    const nextErrors: PasswordErrors = {};
    if (!current) nextErrors.current = "Введите текущий пароль";
    if (next.length < MIN_PASSWORD) nextErrors.next = `Пароль — не короче ${MIN_PASSWORD} символов`;
    else if (next === current) nextErrors.next = "Новый пароль совпадает с текущим";
    if (!nextErrors.next && repeat !== next) nextErrors.repeat = "Пароли не совпадают";
    setErrors(nextErrors);
    if (Object.keys(nextErrors).length) return;

    setSaving(true);
    try {
      await api.changePassword(current, next);
      toast("Пароль изменён, другие устройства вышли из аккаунта");
      reset();
      setOpen(false);
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) setErrors({ current: e.message });
      else setErrors({ form: e instanceof ApiError ? e.message : "Не удалось сменить пароль." });
    } finally {
      setSaving(false);
    }
  };

  return (
    <Disclosure
      label="Сменить пароль"
      open={open}
      onToggle={() => {
        if (open) reset();
        setOpen(!open);
      }}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {/* Подсказка менеджеру паролей, для какого логина новый пароль. */}
        <input type="text" name="username" autoComplete="username" value={login} readOnly hidden />
        <PasswordInput
          label="Текущий пароль"
          value={current}
          onChange={setCurrent}
          autoComplete="current-password"
          error={errors.current}
        />
        <PasswordInput
          label="Новый пароль"
          value={next}
          onChange={setNext}
          autoComplete="new-password"
          hint={`Не короче ${MIN_PASSWORD} символов`}
          error={errors.next}
        />
        <PasswordInput
          label="Повторите новый пароль"
          value={repeat}
          onChange={setRepeat}
          autoComplete="new-password"
          error={errors.repeat}
        />
        {errors.form && (
          <p role="alert" className="rounded-2xl bg-negative-soft px-4 py-3 text-sm">
            {errors.form}
          </p>
        )}
        <p className="text-sm text-muted">После смены пароля на других устройствах нужно будет войти заново.</p>
        <Button type="submit" loading={saving} className="w-full sm:w-auto">
          Сменить пароль
        </Button>
      </form>
    </Disclosure>
  );
}

function DeleteAccount({ login }: { login: string }) {
  const store = useStore();
  const toast = useToast();
  const confirm = useConfirm();
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (busy) return;
    if (!password) {
      setError("Введите пароль");
      return;
    }
    setError(null);
    const ok = await confirm({
      title: "Удалить аккаунт навсегда?",
      message: "Аккаунт и все данные на сервере будут удалены. Восстановить их не получится.",
      confirmLabel: "Удалить",
      danger: true,
    });
    if (!ok) return;
    setBusy(true);
    try {
      await api.deleteAccount(password);
      store.forgetAccount();
      toast("Аккаунт удалён");
    } catch (e) {
      setError(e instanceof ApiError ? e.message : "Не удалось удалить аккаунт.");
      setBusy(false);
    }
  };

  return (
    <Disclosure
      label="Удалить аккаунт"
      danger
      open={open}
      onToggle={() => {
        setOpen(!open);
        setPassword("");
        setError(null);
      }}
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Notice tone="negative">
          Аккаунт и все данные на сервере будут удалены без возможности восстановления. Сначала можно скачать
          резервную копию в разделе «Данные» ниже.
        </Notice>
        <input type="text" name="username" autoComplete="username" value={login} readOnly hidden />
        <PasswordInput
          label="Пароль для подтверждения"
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          autoComplete="current-password"
          error={error}
        />
        <Button type="submit" variant="danger" icon="trash" loading={busy} className="w-full sm:w-auto">
          Удалить аккаунт
        </Button>
      </form>
    </Disclosure>
  );
}

function LogoutButton() {
  const store = useStore();
  const toast = useToast();
  const confirm = useConfirm();
  const { sync } = useSnapshot();
  const [busy, setBusy] = useState(false);

  const logout = async () => {
    if (sync.pending > 0) {
      const ok = await confirm({
        title: "Выйти из аккаунта?",
        message: "Есть неотправленные изменения — они пропадут.",
        confirmLabel: "Выйти",
        danger: true,
      });
      if (!ok) return;
    }
    setBusy(true);
    await store.logout();
    toast("Вы вышли из аккаунта");
  };

  return (
    <div className="space-y-2">
      <Button variant="secondary" icon="logout" loading={busy} onClick={() => void logout()} className="w-full sm:w-auto">
        Выйти
      </Button>
      <p className="text-xs text-muted">
        Данные останутся на сервере, а с этого устройства копия аккаунта удалится.
      </p>
    </div>
  );
}
