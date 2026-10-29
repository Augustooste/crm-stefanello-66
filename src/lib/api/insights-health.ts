import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";

// Janela e limite do alerta — ficam aqui para que o teste do banner e a
// server-side (edge function) fiquem consistentes. Se um dia mudar, muda
// nos dois lados.
export const AI_INSIGHTS_ALERT_WINDOW_MINUTES = 15;
export const AI_INSIGHTS_ALERT_THRESHOLD = 3;

export type AiInsightsFailureAlert = {
  count: number;
  threshold: number;
  windowMinutes: number;
  latest: Array<{ created_at: string }>;
};

export async function fetchAiInsightsFailureAlert(): Promise<AiInsightsFailureAlert> {
  const since = new Date(Date.now() - AI_INSIGHTS_ALERT_WINDOW_MINUTES * 60_000).toISOString();

  // RLS já limita ao tenant do admin logado; contamos direto.
  const { data, count, error } = await supabase
    .from("ai_insights_write_failures")
    .select("created_at", { count: "exact" })
    .gte("created_at", since)
    .order("created_at", { ascending: false })
    .limit(10);

  if (error) throw error;

  return {
    count: count ?? 0,
    threshold: AI_INSIGHTS_ALERT_THRESHOLD,
    windowMinutes: AI_INSIGHTS_ALERT_WINDOW_MINUTES,
    latest: (data ?? []).map((row) => ({ created_at: row.created_at })),
  };
}

/**
 * Consulta a contagem de falhas de escrita do `ai_insights` na janela recente.
 * Habilitado apenas para admins com tenant. Atualiza-se a cada minuto para
 * dar sensação de "agora" sem inundar o backend.
 */
export function useAiInsightsFailureAlert() {
  const { data: profile } = useCurrentProfile();
  const enabled = !!profile?.tenant_id && profile.role === "admin";
  return useQuery<AiInsightsFailureAlert>({
    queryKey: ["ai-insights-failure-alert", profile?.tenant_id],
    enabled,
    staleTime: 60 * 1000,
    refetchInterval: 60 * 1000,
    queryFn: fetchAiInsightsFailureAlert,
  });
}
