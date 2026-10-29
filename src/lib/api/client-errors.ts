// client-errors.ts — leitura dos erros de frontend gravados em
// public.system_events (source = 'client') pela RPC log_client_error.
//
// Sem RPC de leitura: `authenticated` já tem GRANT SELECT na tabela e a policy
// system_events_admin_select_own_tenant restringe a admin do próprio tenant, e
// o índice (tenant_id, source, ts desc) já existe. A agregação por rota é
// pequena o bastante para sair em JS a partir da janela lida.

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

/** Janela de tempo listada na aba. */
export const CLIENT_ERROR_WINDOW_DAYS = 7;
/** Teto de linhas lidas por consulta — a contagem por rota é sobre esta janela. */
export const CLIENT_ERROR_FETCH_LIMIT = 200;

export type ClientErrorEvent = {
  id: string;
  ts: string;
  operation: string;
  message: string;
  error_code: string | null;
  context: Record<string, unknown> | null;
};

export type ClientErrorByRoute = {
  route: string;
  occurrences: number;
  lastAt: string;
  lastMessage: string;
  lastErrorCode: string | null;
};

/**
 * Agrupa por rota preservando a ordem de "mais recente primeiro" da consulta:
 * a primeira ocorrência de cada rota já é a mais nova.
 */
export function groupClientErrorsByRoute(events: ClientErrorEvent[]): ClientErrorByRoute[] {
  const byRoute = new Map<string, ClientErrorByRoute>();
  for (const event of events) {
    const existing = byRoute.get(event.operation);
    if (existing) {
      existing.occurrences += 1;
      continue;
    }
    byRoute.set(event.operation, {
      route: event.operation,
      occurrences: 1,
      lastAt: event.ts,
      lastMessage: event.message,
      lastErrorCode: event.error_code,
    });
  }
  return [...byRoute.values()].sort(
    (a, b) => b.occurrences - a.occurrences || b.lastAt.localeCompare(a.lastAt),
  );
}

export async function fetchClientErrors(): Promise<ClientErrorEvent[]> {
  const sinceIso = new Date(
    Date.now() - CLIENT_ERROR_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const { data, error } = await supabase
    .from("system_events")
    .select("id, ts, operation, message, error_code, context")
    .eq("source", "client")
    .gte("ts", sinceIso)
    .order("ts", { ascending: false })
    .limit(CLIENT_ERROR_FETCH_LIMIT);

  if (error) throw error;
  return (data ?? []) as ClientErrorEvent[];
}

/** Só admin com tenant — mesma guarda das outras telas de observabilidade. */
export function useClientErrors() {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  return useQuery<ClientErrorEvent[]>({
    queryKey: ["client-errors", profile?.tenant_id],
    enabled,
    staleTime: 60_000,
    queryFn: fetchClientErrors,
  });
}
