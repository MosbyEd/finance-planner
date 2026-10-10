"use client";

import { useEffect, useRef } from "react";
import { useSnapshot } from "@/client/react";
import { useUi } from "./overlays";
import { reviewQueue, reviewReturn } from "./sheets/ReviewSheet";

/**
 * Показывает окно «Новые операции», когда появились непроверенные операции из СМС или Siri: при запуске
 * и когда они пришли, пока приложение открыто. Каждую операцию предлагаем один раз за запуск — «Позже»
 * не вызывает окно снова, пока не придёт новая. После правки операции из списка возвращаемся к списку.
 */
export function useReviewPrompt(): void {
  const { phase, mode, state } = useSnapshot();
  const { overlay, open } = useUi();
  const shown = useRef(new Set<string>());

  useEffect(() => {
    if (phase !== "ready" || mode !== "account" || overlay) return;
    const queue = reviewQueue(state);
    if (reviewReturn.pending) {
      reviewReturn.pending = false;
      if (queue.length) open({ kind: "review" });
      return;
    }
    if (!queue.some((t) => !shown.current.has(t.id))) return;
    for (const t of queue) shown.current.add(t.id);
    open({ kind: "review" });
  }, [phase, mode, state, overlay, open]);
}
