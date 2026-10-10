"use client";

import { useEffect, useRef, useState } from "react";
import { nativeTabBarShow, nativeTabBarUpdate, onNativeTabBar } from "@/client/native";
import type { Tab } from "./overlays";

/** SF Symbols вкладок: обычная и выбранная. */
const SYMBOLS: Record<string, [string, string]> = {
  home: ["house", "house.fill"],
  history: ["list.bullet", "list.bullet"],
  plans: ["repeat", "repeat"],
  goals: ["target", "target"],
  analytics: ["chart.bar", "chart.bar.fill"],
};

/**
 * В iOS-приложении нижняя панель — нативная, из системного стекла Liquid Glass (ios/App/App/GlassTabBar.swift).
 * Пока открыто окно интерфейса (оно выезжает снизу), панель прячется. Возвращает true, если нативная панель
 * показана — тогда панель и кнопку «+» интерфейса рисовать не нужно.
 */
export function useNativeTabBar({
  enabled,
  tabs,
  tab,
  showAdd,
  onSelect,
  onAdd,
}: {
  enabled: boolean;
  tabs: readonly { id: Exclude<Tab, "settings">; label: string }[];
  tab: Tab;
  showAdd: boolean;
  onSelect: (tab: Tab) => void;
  onAdd: () => void;
}): boolean {
  const [active, setActive] = useState(false);
  const handlers = useRef({ onSelect, onAdd, tab, showAdd });
  useEffect(() => {
    handlers.current = { onSelect, onAdd, tab, showAdd };
  });

  useEffect(() => {
    if (!enabled || active) return;
    let cancelled = false;
    const items = tabs.map((t) => ({
      id: t.id,
      title: t.label,
      symbol: SYMBOLS[t.id]?.[0] ?? "circle",
      selectedSymbol: SYMBOLS[t.id]?.[1] ?? "circle.fill",
    }));
    void nativeTabBarShow({ items, selected: handlers.current.tab, action: handlers.current.showAdd }).then((shown) => {
      if (!cancelled) setActive(shown);
    });
    return () => {
      cancelled = true;
    };
  }, [enabled, active, tabs]);

  useEffect(() => {
    if (!active) return;
    return onNativeTabBar(
      (id) => {
        if (tabs.some((t) => t.id === id)) handlers.current.onSelect(id as Tab);
      },
      () => handlers.current.onAdd(),
    );
  }, [active, tabs]);

  useEffect(() => {
    if (active) nativeTabBarUpdate({ selected: tab, action: showAdd });
  }, [active, tab, showAdd]);

  // Окна интерфейса (и подтверждения) — элементы с aria-modal: пока такое есть в разметке, панель спрятана.
  useEffect(() => {
    if (!active) return;
    let hidden: boolean | null = null;
    let frame = 0;
    const check = () => {
      frame = 0;
      const next = document.querySelector('[aria-modal="true"]') !== null;
      if (next !== hidden) {
        hidden = next;
        nativeTabBarUpdate({ hidden: next });
      }
    };
    const observer = new MutationObserver(() => {
      frame ||= requestAnimationFrame(check);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    check();
    return () => {
      observer.disconnect();
      if (frame) cancelAnimationFrame(frame);
    };
  }, [active]);

  return active;
}
