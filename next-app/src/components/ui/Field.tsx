import { useId, type InputHTMLAttributes, type ReactNode, type SelectHTMLAttributes, type TextareaHTMLAttributes } from "react";

/** Вид поля без ширины — для полей своей ширины (w-24 рядом с w-full не сработает: побеждает w-full). */
const CONTROL_LOOK =
  "rounded-2xl border border-border-strong bg-surface px-3.5 text-text placeholder:text-muted/70 outline-none transition focus:border-accent aria-[invalid=true]:border-negative disabled:opacity-60";
const CONTROL = `w-full ${CONTROL_LOOK}`;

/** id подсказки или ошибки под полем — для aria-describedby у самого поля. */
export function fieldMessageId(controlId: string): string {
  return `${controlId}-message`;
}

/** aria-describedby для поля, если под ним показывается подсказка или ошибка. */
export function describedBy(controlId: string, hint?: ReactNode, error?: string | null): string | undefined {
  return error || hint ? fieldMessageId(controlId) : undefined;
}

export function Field({
  label,
  hint,
  error,
  children,
  htmlFor,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: string | null;
  children: ReactNode;
  /** id поля. Подсказка/ошибка получают id fieldMessageId(htmlFor) — свяжите его через aria-describedby. */
  htmlFor?: string;
}) {
  const messageId = htmlFor ? fieldMessageId(htmlFor) : undefined;
  return (
    <div className="space-y-1.5">
      <label htmlFor={htmlFor} className="block text-sm font-medium text-muted">
        {label}
      </label>
      {children}
      {error ? (
        <p id={messageId} className="text-sm text-negative" role="alert">
          {error}
        </p>
      ) : hint ? (
        <p id={messageId} className="text-xs text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function TextInput({
  label,
  hint,
  error,
  className = "",
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input
        id={id}
        aria-describedby={describedBy(id, hint, error)}
        {...props}
        aria-invalid={error ? true : undefined}
        className={`${CONTROL} h-12 ${className}`}
      />
    </Field>
  );
}

export function TextArea({
  label,
  hint,
  error,
  className = "",
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <textarea
        id={id}
        rows={3}
        aria-describedby={describedBy(id, hint, error)}
        {...props}
        aria-invalid={error ? true : undefined}
        className={`${CONTROL} min-h-24 py-3 ${className}`}
      />
    </Field>
  );
}

export function Select({
  label,
  hint,
  error,
  children,
  className = "",
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <select
        id={id}
        aria-describedby={describedBy(id, hint, error)}
        {...props}
        aria-invalid={error ? true : undefined}
        className={`${CONTROL} h-12 appearance-none ${className}`}
      >
        {children}
      </select>
    </Field>
  );
}

/** Поле даты в одном стиле с остальными (iOS по-разному рисует нативные поля дат). */
export function DateInput({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input
        id={id}
        type="date"
        aria-describedby={describedBy(id, hint, error)}
        {...props}
        aria-invalid={error ? true : undefined}
        className={`${CONTROL} h-12 min-w-0 appearance-none [&::-webkit-date-and-time-value]:text-left`}
      />
    </Field>
  );
}

/**
 * Поле времени. У type="time" в WebKit на iPhone своя минимальная ширина — без min-w-0 и appearance-none
 * оно вылезает за карточку (как и поле даты, см. DateInput).
 */
export function TimeInput({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & { label: ReactNode; hint?: ReactNode; error?: string | null }) {
  const id = useId();
  return (
    <Field label={label} hint={hint} error={error} htmlFor={id}>
      <input
        id={id}
        type="time"
        aria-describedby={describedBy(id, hint, error)}
        {...props}
        aria-invalid={error ? true : undefined}
        className={`${CONTROL} h-12 min-w-0 max-w-48 appearance-none [&::-webkit-date-and-time-value]:text-left`}
      />
    </Field>
  );
}

export const controlClass = CONTROL;
export const controlLookClass = CONTROL_LOOK;
