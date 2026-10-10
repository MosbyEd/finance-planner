"use client";

import { createContext, useContext, useEffect, useState, useSyncExternalStore, type ReactNode } from "react";
import { todayLocal, type IsoDate } from "@/domain/dates";
import { newId } from "@/domain/ids";
import { FinanceStore, type Snapshot } from "./store";

const StoreContext = createContext<FinanceStore | null>(null);

export function StoreProvider({ store, children }: { store: FinanceStore; children: ReactNode }) {
  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>;
}

export function useStore(): FinanceStore {
  const store = useContext(StoreContext);
  if (!store) throw new Error("useStore вне StoreProvider");
  return store;
}

export function useSnapshot(): Snapshot {
  const store = useStore();
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}

/** Сегодняшняя дата; обновляется после полуночи и при возвращении в приложение. */
export function useToday(): IsoDate {
  const [today, setToday] = useState(() => todayLocal());
  useEffect(() => {
    const update = () => setToday(todayLocal());
    const timer = setInterval(update, 60_000);
    document.addEventListener("visibilitychange", update);
    return () => {
      clearInterval(timer);
      document.removeEventListener("visibilitychange", update);
    };
  }, []);
  return today;
}

export { newId };
