"use client";

import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Sheet } from "./Sheet";

// ---------- уведомления ----------

interface Toast {
  id: number;
  message: string;
  kind: "info" | "error";
  action?: { label: string; onClick: () => void };
}

type ShowToast = (message: string, options?: { kind?: "info" | "error"; action?: Toast["action"] }) => void;

const ToastContext = createContext<ShowToast>(() => {});

export function useToast(): ShowToast {
  return useContext(ToastContext);
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const counter = useRef(0);

  const dismiss = useCallback((id: number) => setToasts((list) => list.filter((t) => t.id !== id)), []);

  const show = useCallback<ShowToast>(
    (message, options = {}) => {
      counter.current += 1;
      const id = counter.current;
      setToasts((list) => [...list.slice(-2), { id, message, kind: options.kind ?? "info", action: options.action }]);
      setTimeout(() => dismiss(id), options.action ? 6000 : options.kind === "error" ? 6000 : 3500);
    },
    [dismiss],
  );

  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Стеклянные капсулы. На телефоне — над нижней панелью и слева от кнопки «+», на широком экране — по центру снизу. */}
      <div
        className="pointer-events-none fixed inset-x-0 bottom-[calc(var(--dock-offset)+var(--dock-height)+0.75rem)] z-[60] flex flex-col items-start gap-2 pl-3 pr-20 sm:bottom-6 sm:items-center sm:pr-4"
        aria-live="polite"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            role={t.kind === "error" ? "alert" : "status"}
            className={`pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-3xl px-4 py-3 text-sm font-medium animate-sheet ${
              t.kind === "error" ? "bg-negative-strong text-white sheen" : "glass-strong text-text"
            }`}
          >
            <span className="flex-1">{t.message}</span>
            {t.action && (
              <button
                type="button"
                className={`-my-2 min-h-10 shrink-0 px-1 font-semibold underline-offset-2 hover:underline ${
                  t.kind === "error" ? "" : "text-accent"
                }`}
                onClick={() => {
                  t.action?.onClick();
                  dismiss(t.id);
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------- подтверждение ----------

interface ConfirmOptions {
  title: string;
  message?: ReactNode;
  confirmLabel?: string;
  danger?: boolean;
}

type Confirm = (options: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<Confirm>(async () => false);

export function useConfirm(): Confirm {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<(ConfirmOptions & { id: number; resolve: (ok: boolean) => void }) | null>(null);
  const current = useRef<{ resolve: (ok: boolean) => void } | null>(null);
  const counter = useRef(0);

  const confirm = useCallback<Confirm>(
    (options) =>
      new Promise<boolean>((resolve) => {
        // Новый вопрос поверх незакрытого: прежний считаем отменённым, чтобы его промис не завис.
        current.current?.resolve(false);
        counter.current += 1;
        const entry = { ...options, id: counter.current, resolve };
        current.current = entry;
        setRequest(entry);
      }),
    [],
  );

  const close = (ok: boolean) => {
    request?.resolve(ok);
    if (current.current === request) current.current = null;
    setRequest(null);
  };

  const danger = Boolean(request?.danger);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Sheet
        key={request?.id ?? 0}
        open={request !== null}
        onClose={() => close(false)}
        title={request?.title ?? ""}
        description={request?.message}
        footer={
          <div className="flex gap-2">
            {/* При опасном действии фокус на «Отмене»: случайный Enter ничего не удалит. */}
            <Button variant="secondary" className="flex-1" data-autofocus={danger || undefined} onClick={() => close(false)}>
              Отмена
            </Button>
            <Button
              variant={danger ? "danger" : "primary"}
              className="flex-1"
              data-autofocus={danger ? undefined : true}
              onClick={() => close(true)}
            >
              {request?.confirmLabel ?? "Да"}
            </Button>
          </div>
        }
      >
        {null}
      </Sheet>
    </ConfirmContext.Provider>
  );
}
