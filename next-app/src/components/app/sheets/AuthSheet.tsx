"use client";

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { ApiError } from "@/client/api";
import { useSnapshot, useStore } from "@/client/react";
import { PendingChangesError } from "@/client/store";
import { Button } from "../../ui/Button";
import { Notice, Segmented } from "../../ui/controls";
import { useConfirm, useToast } from "../../ui/feedback";
import { Field, TextInput, controlClass, describedBy } from "../../ui/Field";
import { Sheet } from "../../ui/Sheet";
import { useUi } from "../overlays";

type AuthMode = "login" | "register";

const LOGIN_PATTERN = /^[\p{L}\p{N}_.@-]+$/u;
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 200;
const MAX_NAME = 60;

interface Errors {
  login?: string;
  password?: string;
  name?: string;
}

export function AuthSheet({ mode }: { mode: AuthMode }) {
  const snapshot = useSnapshot();
  const store = useStore();
  const { close, overlay } = useUi();
  const toast = useToast();
  const confirm = useConfirm();
  const { registrationOpen, sessionExpired, user } = snapshot;

  const [tab, setTab] = useState<AuthMode>(mode === "register" && registrationOpen ? "register" : "login");
  const [initialLogin] = useState(() => (sessionExpired ? (user?.login ?? "") : ""));
  const [login, setLogin] = useState(initialLogin);
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [serverError, setServerError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  // Вход может идти долго: за это время окно могут закрыть или открыть другое.
  // Тогда после ответа сервера не трогаем чужое окно.
  const overlayRef = useRef(overlay);
  const mountedRef = useRef(false);
  useEffect(() => {
    overlayRef.current = overlay;
  });
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const isRegister = tab === "register" && registrationOpen;
  const dirty = login !== initialLogin || password !== "" || name !== "";

  const switchTab = (next: AuthMode) => {
    setTab(next);
    setErrors({});
    setServerError(null);
  };

  const validate = (): Errors => {
    const result: Errors = {};
    const trimmed = login.trim();
    if (!trimmed) result.login = "Введите логин";
    else if (isRegister && trimmed.length < 3) result.login = "Логин — от 3 символов";
    else if (trimmed.length > 40) result.login = "Логин — до 40 символов";
    else if (isRegister && !LOGIN_PATTERN.test(trimmed)) {
      result.login = "В логине можно использовать буквы, цифры и символы _ . @ -";
    }
    if (!password) result.password = "Введите пароль";
    else if (isRegister && password.length < MIN_PASSWORD) result.password = `Пароль — не короче ${MIN_PASSWORD} символов`;
    else if (password.length > MAX_PASSWORD) result.password = "Слишком длинный пароль";
    if (isRegister && name.trim().length > MAX_NAME) result.name = `Имя — до ${MAX_NAME} символов`;
    return result;
  };

  const submit = async () => {
    if (pending) return;
    const nextErrors = validate();
    setErrors(nextErrors);
    setServerError(null);
    if (Object.keys(nextErrors).length) return;

    const registering = isRegister;
    const credentials = { login: login.trim(), password, name: name.trim() };
    const signIn = (discardPending: boolean) =>
      registering
        ? store.register(credentials.login, credentials.password, credentials.name, { discardPending })
        : store.login(credentials.login, credentials.password, { discardPending });

    setPending(true);
    try {
      try {
        await signIn(false);
      } catch (error) {
        if (!(error instanceof PendingChangesError)) throw error;
        const discard = await confirm({
          title: "Войти в другой аккаунт?",
          message: `В аккаунте «${error.previousLogin}» остались неотправленные изменения (${error.pending}). Если войти в другой аккаунт, они пропадут.`,
          confirmLabel: "Войти и удалить изменения",
          danger: true,
        });
        if (!discard) {
          setPending(false);
          return;
        }
        await signIn(true);
      }
      const signedIn = store.getSnapshot().user?.login ?? credentials.login;
      if (mountedRef.current && overlayRef.current?.kind === "auth") close();
      toast(`Вы вошли как ${signedIn}`);
    } catch (error) {
      const fallback = registering
        ? "Не удалось создать аккаунт. Попробуйте ещё раз."
        : "Не удалось войти. Попробуйте ещё раз.";
      const message = error instanceof ApiError ? error.message : fallback;
      if (mountedRef.current) {
        setServerError(message);
        setPending(false);
      } else {
        // Окно уже закрыли — сообщаем об ошибке уведомлением.
        toast(message, { kind: "error" });
      }
    }
  };

  return (
    <Sheet
      open
      onClose={close}
      dirty={dirty}
      title={isRegister ? "Создание аккаунта" : "Вход в аккаунт"}
      footer={
        <Button className="w-full" loading={pending} onClick={() => void submit()}>
          {isRegister ? "Создать аккаунт" : "Войти"}
        </Button>
      }
    >
      <form
        className="space-y-4"
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        {sessionExpired && (
          <Notice tone="warning">
            Сессия истекла. Войдите в тот же аккаунт{user ? ` (${user.login})` : ""} — неотправленные изменения
            отправятся сразу после входа.
          </Notice>
        )}

        {registrationOpen ? (
          <Segmented
            label="Вход или регистрация"
            value={tab}
            onChange={switchTab}
            options={[
              { value: "login", label: "Вход" },
              { value: "register", label: "Регистрация" },
            ]}
          />
        ) : (
          mode === "register" && <Notice>Регистрация новых аккаунтов сейчас закрыта. Войдите в существующий.</Notice>
        )}

        <TextInput
          label="Логин"
          value={login}
          maxLength={40}
          autoComplete="username"
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          error={errors.login}
          hint={isRegister ? "Буквы, цифры и символы _ . @ -" : undefined}
          onChange={(e) => setLogin(e.target.value)}
        />

        {isRegister && (
          <TextInput
            label="Имя (необязательно)"
            value={name}
            maxLength={MAX_NAME}
            autoComplete="nickname"
            error={errors.name}
            onChange={(e) => setName(e.target.value)}
          />
        )}

        <PasswordInput
          label="Пароль"
          value={password}
          onChange={setPassword}
          autoComplete={isRegister ? "new-password" : "current-password"}
          hint={isRegister ? `Не короче ${MIN_PASSWORD} символов` : undefined}
          error={errors.password}
        />

        {serverError && (
          <p role="alert" className="rounded-2xl bg-negative-soft px-4 py-3 text-sm">
            {serverError}
          </p>
        )}

        <div className="space-y-1 text-sm text-muted">
          <p>С аккаунтом данные синхронизируются между вашими устройствами. Пароль хранится только в виде хеша.</p>
          {snapshot.mode === "guest" && (
            <p>Если вы уже вели бюджет без входа, после входа приложение предложит перенести эти данные.</p>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Sheet>
  );
}

/** Поле пароля с кнопкой «Показать пароль». */
export function PasswordInput({
  label,
  value,
  onChange,
  autoComplete,
  hint,
  error,
}: {
  label: ReactNode;
  value: string;
  onChange: (value: string) => void;
  autoComplete: "current-password" | "new-password";
  hint?: ReactNode;
  error?: string | null;
}) {
  const id = useId();
  const [visible, setVisible] = useState(false);
  return (
    <Field label={label} htmlFor={id} hint={hint} error={error}>
      <div className="relative">
        <input
          id={id}
          type={visible ? "text" : "password"}
          value={value}
          maxLength={MAX_PASSWORD}
          autoComplete={autoComplete}
          autoCapitalize="off"
          autoCorrect="off"
          spellCheck={false}
          aria-describedby={describedBy(id, hint, error)}
          aria-invalid={error ? true : undefined}
          onChange={(e) => onChange(e.target.value)}
          className={`${controlClass} h-12 pr-12`}
        />
        <button
          type="button"
          aria-label="Показать пароль"
          aria-pressed={visible}
          title={visible ? "Скрыть пароль" : "Показать пароль"}
          onClick={() => setVisible((v) => !v)}
          className="absolute right-1 top-1/2 flex h-10 w-10 -translate-y-1/2 items-center justify-center rounded-full text-muted transition hover:bg-surface-2 hover:text-text"
        >
          <EyeIcon crossed={visible} />
        </button>
      </div>
    </Field>
  );
}

/** В общем наборе иконок нет «глаза», поэтому он нарисован здесь. */
function EyeIcon({ crossed }: { crossed: boolean }) {
  return (
    <svg
      width={20}
      height={20}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
      <path d="M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
      {crossed && <path d="M4 4l16 16" />}
    </svg>
  );
}
