"use client";

import { useEffect, useId, useRef, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "./Button";
import { useConfirm } from "./feedback";

let openSheets = 0;

/**
 * Модальное окно: на телефоне выезжает снизу, на широком экране — по центру.
 * Закрывается по Esc и по клику на фон; фокус переходит внутрь и возвращается обратно.
 */
export function Sheet({
  open,
  onClose,
  title,
  children,
  footer,
  size = "md",
  dirty = false,
  description,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  children: ReactNode;
  /** Короткое пояснение под заголовком; диалог ссылается на него через aria-describedby. */
  description?: ReactNode;
  footer?: ReactNode;
  size?: "md" | "lg" | "full";
  /** В форме есть несохранённые изменения: закрытие по фону или Esc сначала спросит подтверждение. */
  dirty?: boolean;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const panelRef = useRef<HTMLDivElement>(null);
  const confirm = useConfirm();
  const requestClose = async () => {
    if (dirty) {
      const ok = await confirm({
        title: "Закрыть без сохранения?",
        message: "Введённые данные пропадут.",
        confirmLabel: "Не сохранять",
        danger: true,
      });
      if (!ok) return;
    }
    onClose();
  };

  // Esc и Tab ловим React-обработчиком на панели, а не нативным слушателем: так поле внутри окна
  // (например, ввод новой категории) успевает обработать Esc само и остановить всплытие.
  const onPanelKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.isPropagationStopped() || e.defaultPrevented) return;
    const panel = panelRef.current;
    // События вложенного окна (оно в портале) React всё равно поднимает сюда — их не трогаем.
    if (!panel || !(e.target instanceof Node) || !panel.contains(e.target)) return;
    if (e.key === "Escape") {
      if (e.nativeEvent.isComposing) return;
      e.stopPropagation();
      e.preventDefault();
      void requestClose();
      return;
    }
    if (e.key === "Tab") {
      const focusable = [...panel.querySelectorAll<HTMLElement>(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
      )];
      if (!focusable.length) return;
      const firstEl = focusable[0];
      const lastEl = focusable[focusable.length - 1];
      if (e.shiftKey && document.activeElement === firstEl) {
        e.preventDefault();
        lastEl.focus();
      } else if (!e.shiftKey && document.activeElement === lastEl) {
        e.preventDefault();
        firstEl.focus();
      }
    }
  };

  useEffect(() => {
    if (!open) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    openSheets += 1;
    document.body.style.overflow = "hidden";

    const panel = panelRef.current;
    // Явно помеченный элемент важнее первого поля по порядку в разметке.
    const first =
      panel?.querySelector<HTMLElement>("[data-autofocus]") ?? panel?.querySelector<HTMLElement>("input, textarea, select");
    // На телефоне не открываем клавиатуру сразу, если поле не помечено явно.
    const isTouch = window.matchMedia("(pointer: coarse)").matches;
    if (first && (!isTouch || first.hasAttribute("data-autofocus"))) first.focus({ preventScroll: true });
    else panel?.focus({ preventScroll: true });

    return () => {
      openSheets -= 1;
      if (openSheets === 0) document.body.style.overflow = "";
      previouslyFocused?.focus?.({ preventScroll: true });
    };
  }, [open]);

  if (!open || typeof document === "undefined") return null;

  const width = size === "lg" ? "sm:max-w-2xl" : size === "full" ? "sm:max-w-3xl" : "sm:max-w-lg";
  const height = size === "full" ? "h-[92dvh] sm:h-[85dvh]" : "max-h-[92dvh] sm:max-h-[85dvh]";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center sm:items-center sm:p-4">
      <div className="absolute inset-0 bg-overlay animate-fade" onClick={() => void requestClose()} aria-hidden />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={description ? descriptionId : undefined}
        tabIndex={-1}
        onKeyDown={onPanelKeyDown}
        className={`relative flex w-full flex-col overflow-hidden rounded-t-3xl bg-surface shadow-2xl outline-none animate-sheet sm:rounded-3xl ${width} ${height}`}
      >
        <div className="flex items-center gap-2 border-b border-border px-5 py-3">
          <h2 id={titleId} className="flex-1 text-[17px] font-semibold">
            {title}
          </h2>
          <IconButton icon="close" label="Закрыть" onClick={() => void requestClose()} size={40} />
        </div>
        <div className="flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {description && (
            <div id={descriptionId} className="mb-4 text-[15px] text-muted last:mb-0">
              {description}
            </div>
          )}
          {children}
        </div>
        {footer && (
          <div className="border-t border-border px-5 pt-3 pb-[calc(0.75rem+env(safe-area-inset-bottom))]">{footer}</div>
        )}
        {!footer && <div className="shrink-0 pb-[env(safe-area-inset-bottom)]" />}
      </div>
    </div>,
    document.body,
  );
}
