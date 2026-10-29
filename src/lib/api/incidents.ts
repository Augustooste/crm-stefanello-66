// incidents.ts — visão unificada de incidentes: erros do app
// (public.system_events, source='client') + falhas de IA
// (public.ai_failure_logs), normalizados no mesmo formato e correlacionados
// pelo traceId.
//
// Convenção do traceId (ver supabase/functions/_shared/ai/failure-log.ts):
// é o id da mensagem de ENTRADA que originou a execução. Falhas de IA gravam
// em ai_failure_logs.trace_id; erros do app gravam em
// system_events.correlation_id (via a RPC log_client_error). Mesmo valor dos
// dois lados = mesma execução.

import { keepPreviousData, useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

export type IncidentKind = "erro_app" | "falha_ia";

export type Incident = {
  id: string;
  kind: IncidentKind;
  occurredAt: string;
  traceId: string | null;
  /** Rota do app (erro do app) ou rota/função de IA (falha de IA). */
  scope: string;
  code: string | null;
  message: string;
  provider: string | null;
  model: string | null;
  statusCode: number | null;
  context: Record<string, unknown> | null;
};

export type IncidentPeriod = "24h" | "7d" | "30d";

export const INCIDENT_PERIOD_HOURS: Record<IncidentPeriod, number> = {
  "24h": 24,
  "7d": 24 * 7,
  "30d": 24 * 30,
};

export const INCIDENT_PERIOD_LABELS: Record<IncidentPeriod, string> = {
  "24h": "Últimas 24 horas",
  "7d": "Últimos 7 dias",
  "30d": "Últimos 30 dias",
};

export const INCIDENT_KIND_LABELS: Record<IncidentKind, string> = {
  erro_app: "Erro do app",
  falha_ia: "Falha de IA",
};

/** Teto por fonte na listagem da tela. */
export const INCIDENT_FETCH_LIMIT = 300;
/** Teto por fonte na exportação — maior que a tela, mas ainda finito. */
export const INCIDENT_EXPORT_LIMIT = 5000;

export type IncidentFilters = {
  period: IncidentPeriod;
  kind: IncidentKind | "todos";
  /** Filtro por código de erro (exato). */
  code: string | null;
  /** Busca por traceId (prefixo ou valor completo). */
  traceId: string | null;
};

export const DEFAULT_INCIDENT_FILTERS: IncidentFilters = {
  period: "7d",
  kind: "todos",
  code: null,
  traceId: null,
};

export function incidentsSinceIso(period: IncidentPeriod, now = Date.now()): string {
  return new Date(now - INCIDENT_PERIOD_HOURS[period] * 60 * 60 * 1000).toISOString();
}

type AiFailureRow = {
  id: string;
  route: string;
  provider: string | null;
  model: string | null;
  status_code: number | null;
  error_code: string;
  error_message: string;
  trace_id: string | null;
  context: unknown;
  created_at: string;
};

type ClientErrorRow = {
  id: string;
  ts: string;
  operation: string;
  message: string;
  error_code: string | null;
  correlation_id: string | null;
  context: unknown;
};

function asContext(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function mapAiFailureToIncident(row: AiFailureRow): Incident {
  return {
    id: `falha_ia:${row.id}`,
    kind: "falha_ia",
    occurredAt: row.created_at,
    traceId: row.trace_id,
    scope: row.route,
    code: row.error_code || null,
    message: row.error_message,
    provider: row.provider,
    model: row.model,
    statusCode: row.status_code,
    context: asContext(row.context),
  };
}

export function mapClientErrorToIncident(row: ClientErrorRow): Incident {
  return {
    id: `erro_app:${row.id}`,
    kind: "erro_app",
    occurredAt: row.ts,
    traceId: row.correlation_id,
    scope: row.operation,
    code: row.error_code,
    message: row.message,
    provider: null,
    model: null,
    statusCode: null,
    context: asContext(row.context),
  };
}

/** Une as duas fontes numa lista única, mais recente primeiro. */
export function mergeIncidents(a: Incident[], b: Incident[]): Incident[] {
  return [...a, ...b].sort((x, y) => y.occurredAt.localeCompare(x.occurredAt));
}

/** Filtros que rodam no cliente (o período e o tipo já vão na consulta). */
export function applyClientIncidentFilters(
  incidents: Incident[],
  filters: Pick<IncidentFilters, "code" | "traceId">,
): Incident[] {
  const trace = filters.traceId?.trim().toLowerCase() ?? "";
  return incidents.filter((incident) => {
    if (filters.code && incident.code !== filters.code) return false;
    if (trace && !(incident.traceId ?? "").toLowerCase().includes(trace)) return false;
    return true;
  });
}

/** Agrupa por traceId — base do detalhe "linha do tempo de uma execução". */
export function incidentsByTrace(incidents: Incident[], traceId: string): Incident[] {
  return incidents
    .filter((incident) => incident.traceId === traceId)
    .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
}

/** Códigos distintos presentes na janela — alimenta o filtro de código. */
export function distinctIncidentCodes(incidents: Incident[]): string[] {
  return [...new Set(incidents.map((i) => i.code).filter((c): c is string => !!c))].sort();
}

export async function fetchIncidents(
  filters: IncidentFilters,
  limit = INCIDENT_FETCH_LIMIT,
): Promise<Incident[]> {
  const sinceIso = incidentsSinceIso(filters.period);
  const wantsIa = filters.kind !== "erro_app";
  const wantsApp = filters.kind !== "falha_ia";

  const [iaResult, appResult] = await Promise.all([
    wantsIa
      ? supabase
          .from("ai_failure_logs")
          .select(
            "id, route, provider, model, status_code, error_code, error_message, trace_id, context, created_at",
          )
          .gte("created_at", sinceIso)
          .order("created_at", { ascending: false })
          .limit(limit)
      : Promise.resolve({ data: [], error: null }),
    wantsApp
      ? supabase
          .from("system_events")
          .select("id, ts, operation, message, error_code, correlation_id, context")
          .eq("source", "client")
          .eq("severity", "error")
          .gte("ts", sinceIso)
          .order("ts", { ascending: false })
          .limit(limit)
      : Promise.resolve({ data: [], error: null }),
  ]);

  if (iaResult.error) throw iaResult.error;
  if (appResult.error) throw appResult.error;

  const ia = ((iaResult.data ?? []) as AiFailureRow[]).map(mapAiFailureToIncident);
  const app = ((appResult.data ?? []) as ClientErrorRow[]).map(mapClientErrorToIncident);
  return applyClientIncidentFilters(mergeIncidents(ia, app), filters);
}

/** Só admin com tenant — mesma guarda das demais telas de observabilidade. */
export function useIncidents(filters: IncidentFilters) {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  return useQuery<Incident[]>({
    queryKey: ["incidents", profile?.tenant_id, filters],
    enabled,
    staleTime: 30_000,
    placeholderData: keepPreviousData,
    queryFn: () => fetchIncidents(filters),
  });
}
