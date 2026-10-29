import { useQuery } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";

/** Janela agregada pela RPC (fixa no SQL — repetida aqui só para o texto da UI). */
export const EDGE_ALERT_WINDOW_MINUTES = 15;

export type EdgeFunctionErrorAlert = {
  function_name: string;
  operation: string;
  severity: "error" | "warn";
  errors_15m: number;
  errors_prev_15m: number;
  spike: boolean;
  last_error_code: string | null;
  last_message: string | null;
  last_at: string | null;
};

// RPC nova ainda não está em types.ts — mesmo padrão de extensão local já
// usado em integration-health.ts.
type EdgeAlertsFunctions = {
  get_edge_function_error_alerts: {
    Args: Record<string, never>;
    Returns: EdgeFunctionErrorAlert[];
  };
};

type SupabaseWithEdgeRpcs = SupabaseClient<
  Database & {
    public: Database["public"] & {
      Functions: Database["public"]["Functions"] & EdgeAlertsFunctions;
    };
  }
>;

const edgeRpc = supabase as unknown as SupabaseWithEdgeRpcs;

export async function fetchEdgeFunctionErrorAlerts(): Promise<EdgeFunctionErrorAlert[]> {
  const { data, error } = await edgeRpc.rpc("get_edge_function_error_alerts");
  if (error) throw error;
  return (data ?? []) as EdgeFunctionErrorAlert[];
}

/**
 * Alertas de erro das Edge Functions do tenant atual, derivados da telemetria
 * gravada em `system_events` (source = 'edge'). A RPC já é fail-closed para
 * não-admin; o hook só habilita para admin com tenant para não gerar consulta
 * inútil no atendente.
 */
export function useEdgeFunctionErrorAlerts() {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  return useQuery<EdgeFunctionErrorAlert[]>({
    queryKey: ["edge-function-error-alerts", profile?.tenant_id],
    enabled,
    staleTime: 60_000,
    refetchInterval: 60_000,
    queryFn: fetchEdgeFunctionErrorAlerts,
  });
}
