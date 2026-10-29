import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";

export type IntegrationHealthAlert = {
  slug: string;
  severity: "error" | "warning";
  reason_code: "integration_error" | "repeated_send_failures";
  human_message: string;
  failures_15m: number;
  last_error: string | null;
  last_check_at: string | null;
};

// RPC nova ainda não está em types.ts (agente de sincronização não rodou pra
// esta migração) — mesmo padrão de extensão local já usado em
// use-phone-suppressions.ts e integrations.ts.
type HealthAlertsFunctions = {
  get_integration_health_alerts: {
    Args: Record<string, never>;
    Returns: IntegrationHealthAlert[];
  };
};

type SupabaseWithHealthRpcs = SupabaseClient<
  Database & {
    public: Database["public"] & {
      Functions: Database["public"]["Functions"] & HealthAlertsFunctions;
    };
  }
>;

const healthRpc = supabase as unknown as SupabaseWithHealthRpcs;

/** Alertas ativos de saúde das integrações do tenant atual. */
export function useIntegrationHealthAlerts() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<IntegrationHealthAlert[]>({
    queryKey: ["integration-health-alerts", tenantId],
    enabled: !!tenantId,
    // Curto o suficiente para o operador ver o alerta some após corrigir,
    // longo o suficiente para não sobrecarregar (system_events é indexado
    // por tenant, mas ainda é uma agregação).
    refetchInterval: 30_000,
    queryFn: async () => {
      const { data, error } = await healthRpc.rpc("get_integration_health_alerts");
      if (error) throw error;
      return (data ?? []) as IntegrationHealthAlert[];
    },
  });
}

/**
 * Dispara ação=test em integration-connect para revalidar credenciais
 * imediatamente. Os segredos NUNCA saem do banco: só o slug é enviado.
 */
export function useTestIntegration() {
  const qc = useQueryClient();
  return useMutation<{ ok: boolean; error?: string }, Error, { slug: string }>({
    mutationFn: async ({ slug }) => {
      const { data, error } = await supabase.functions.invoke("integration-connect", {
        body: { action: "test", slug },
      });
      if (error) throw new Error(error.message ?? "Falha ao testar conexão.");
      return (data ?? { ok: false }) as { ok: boolean; error?: string };
    },
    onSettled: () => {
      // Refetch imediato: last_check_at/last_error acabaram de mudar.
      qc.invalidateQueries({ queryKey: ["tenant-integrations"] });
      qc.invalidateQueries({ queryKey: ["integration-health-alerts"] });
    },
  });
}
