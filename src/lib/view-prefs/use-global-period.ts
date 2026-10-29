// Filtro global de período. A escolha da sessão vive em sessionStorage
// (não polui o default do tenant para outros usuários). O default do tenant
// é lido de tenant_view_preferences.prefs.global.period; admin edita em
// Configurações → Visualização.
//
// Estado compartilhado entre instâncias do hook usando useSyncExternalStore,
// garantindo que o seletor (GlobalPeriodPicker) e leitores (inbox, dashboard)
// sincronizam sem remontagem. Fonte única: sessionStorage (sessão > default tenant).
import { useCallback, useEffect, useMemo, useSyncExternalStore } from "react";

import { useViewPrefs } from "@/lib/api/view-prefs";

export type PeriodKey = "today" | "last_7d" | "last_30d" | "last_90d" | "this_month" | "last_month";

export const PERIOD_OPTIONS: { key: PeriodKey; label: string }[] = [
  { key: "today", label: "Hoje" },
  { key: "last_7d", label: "Últimos 7 dias" },
  { key: "last_30d", label: "Últimos 30 dias" },
  { key: "last_90d", label: "Últimos 90 dias" },
  { key: "this_month", label: "Mês atual" },
  { key: "last_month", label: "Mês passado" },
];

const SESSION_KEY = "aceleraflow.global.period";
const DEFAULT_PERIOD: PeriodKey = "last_30d";

function isPeriodKey(v: unknown): v is PeriodKey {
  return typeof v === "string" && PERIOD_OPTIONS.some((o) => o.key === v);
}

export function rangeFor(period: PeriodKey): { from: Date; to: Date } {
  const now = new Date();
  const to = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 23, 59, 59, 999);
  const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate(), 0, 0, 0, 0);
  switch (period) {
    case "today":
      return { from: startOfDay(now), to };
    case "last_7d": {
      const from = startOfDay(new Date(now));
      from.setDate(from.getDate() - 6);
      return { from, to };
    }
    case "last_30d": {
      const from = startOfDay(new Date(now));
      from.setDate(from.getDate() - 29);
      return { from, to };
    }
    case "last_90d": {
      const from = startOfDay(new Date(now));
      from.setDate(from.getDate() - 89);
      return { from, to };
    }
    case "this_month": {
      const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
      return { from, to };
    }
    case "last_month": {
      const from = new Date(now.getFullYear(), now.getMonth() - 1, 1, 0, 0, 0, 0);
      const lastTo = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59, 999);
      return { from, to: lastTo };
    }
  }
}

// --- Store compartilhado entre instâncias do hook ---
// Sincroniza periodos entre abas (via storage event) e instâncias (via listeners).
const listeners = new Set<() => void>();
let sessionValue: PeriodKey | null = null;
let hydrated = false;

function readSessionStorage(): PeriodKey | null {
  if (typeof window === "undefined") return null;
  try {
    const v = window.sessionStorage.getItem(SESSION_KEY);
    return isPeriodKey(v) ? v : null;
  } catch {
    return null;
  }
}

function ensureHydrated(): void {
  if (!hydrated) {
    sessionValue = readSessionStorage();
    hydrated = true;
  }
}

function subscribe(cb: () => void): () => void {
  ensureHydrated();
  listeners.add(cb);
  return () => {
    listeners.delete(cb);
  };
}

function getSnapshot(): PeriodKey | null {
  ensureHydrated();
  return sessionValue;
}

// No SSR não há sessionStorage: renderiza com o default e hidrata no cliente.
function getServerSnapshot(): PeriodKey | null {
  return null;
}

function setSessionValue(next: PeriodKey | null): void {
  sessionValue = next;
  try {
    if (next === null) {
      window.sessionStorage.removeItem(SESSION_KEY);
    } else {
      window.sessionStorage.setItem(SESSION_KEY, next);
    }
  } catch {
    /* ignore */
  }
  // Notifica todos os listeners (instâncias do hook na mesma aba).
  for (const l of listeners) l();
}

// --- Hook público ---

export function useGlobalPeriod() {
  const { prefs } = useViewPrefs();
  const tenantDefault: PeriodKey = useMemo(() => {
    const v = (prefs as Record<string, Record<string, unknown>>)?.global?.period;
    return isPeriodKey(v) ? v : DEFAULT_PERIOD;
  }, [prefs]);

  const session = useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);

  // Sincroniza mudanças de outras abas/janelas (storage event).
  useEffect(() => {
    function onStorage(e: StorageEvent) {
      if (e.key === SESSION_KEY) {
        setSessionValue(isPeriodKey(e.newValue) ? (e.newValue as PeriodKey) : null);
      }
    }
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);

  const period: PeriodKey = session ?? tenantDefault;
  const range = useMemo(() => rangeFor(period), [period]);

  const setPeriod = useCallback((next: PeriodKey) => {
    setSessionValue(next);
  }, []);

  const clearSessionOverride = useCallback(() => {
    setSessionValue(null);
  }, []);

  return {
    period,
    range,
    setPeriod,
    tenantDefault,
    isSessionOverride: session !== null && session !== tenantDefault,
    clearSessionOverride,
  };
}
