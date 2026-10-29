// incident-alerts.ts — alertas de incidentes recorrentes/críticos nas últimas
// 24h, agregados no banco pela RPC public.get_incident_alerts (admin do
// próprio tenant).

import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import type { IncidentKind } from "@/lib/api/incidents";

export type IncidentAlert = {
  kind: IncidentKind;
  code: string;
  scope: string;
  occurrences: number;
  lastAt: string;
  severity: "critical" | "warning";
};

export const INCIDENT_ALERT_WINDOW_HOURS = 24;

export async function fetchIncidentAlerts(): Promise<IncidentAlert[]> {
  const { data, error } = await supabase.rpc("get_incident_alerts");
  if (error) throw error;
  return (data ?? []).map((row) => ({
    kind: (row.kind === "falha_ia" ? "falha_ia" : "erro_app") as IncidentKind,
    code: row.code ?? "UNKNOWN",
    scope: row.scope ?? "",
    occurrences: Number(row.occurrences ?? 0),
    lastAt: row.last_at as string,
    severity: row.severity === "critical" ? "critical" : "warning",
  }));
}

export function useIncidentAlerts() {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  return useQuery<IncidentAlert[]>({
    queryKey: ["incident-alerts", profile?.tenant_id],
    enabled,
    staleTime: 60_000,
    refetchInterval: 5 * 60_000,
    queryFn: fetchIncidentAlerts,
  });
}

/** Críticos primeiro, depois por volume. */
export function sortIncidentAlerts(alerts: IncidentAlert[]): IncidentAlert[] {
  return [...alerts].sort((a, b) => {
    if (a.severity !== b.severity) return a.severity === "critical" ? -1 : 1;
    return b.occurrences - a.occurrences;
  });
}
