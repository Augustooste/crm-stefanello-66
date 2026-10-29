import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { mensagemDeErroDaFunction } from "./edge-errors";
import { useCurrentProfile } from "@/lib/api/session";
import { rpcRetry, waitForSession } from "@/lib/api/session-guard";

export type ReportAtendimento = {
  conversas_novas: number;
  primeira_resposta_min: number | null;
  handoff: number;
  msgs_recebidas: number;
  msgs_enviadas: number;
  msgs_ia: number;
  msgs_humano: number;
};

export type ReportDia = {
  dia: string;
  recebidas: number;
  enviadas: number;
};

export type ReportStage = {
  stage_id: string;
  nome: string;
  posicao: number;
  is_won: boolean;
  is_lost: boolean;
  negocios: number;
  valor: number;
  dias_medio_no_estagio: number | null;
};

export type ReportResultados = {
  ganhos: number;
  ganhos_valor: number;
  perdidos: number;
  ciclo_medio_dias: number | null;
  motivos_perda: Array<{ motivo: string; n: number }>;
};

export type DashboardReport = {
  atendimento: ReportAtendimento;
  mensagens_por_dia: ReportDia[];
  funil: ReportStage[];
  resultados: ReportResultados;
};

export type AiInsight = {
  severidade: "alta" | "media" | "baixa";
  diagnostico: string;
  sugestao: string;
  link: string | null;
};

export type AiInsightsResponse = {
  insights: AiInsight[];
  cached: boolean;
  generated_at: string;
};

export async function fetchAiInsights(
  from: Date,
  to: Date,
  force = false,
): Promise<AiInsightsResponse> {
  const { data, error, response } = await supabase.functions.invoke("ai-insights", {
    body: { from: from.toISOString(), to: to.toISOString(), force },
  });
  // `throw error` mostrava a string fixa em inglês do SDK: o corpo com a
  // mensagem em PT-BR (e o 429 de limite de uso) é descartado em não-2xx.
  if (error) throw new Error(mensagemDeErroDaFunction(response?.status));
  return data as AiInsightsResponse;
}

export function useDashboardReport(from: Date, to: Date) {
  const { data: profile } = useCurrentProfile();
  return useQuery<DashboardReport>({
    queryKey: ["dashboard-report", profile?.tenant_id, from.toISOString(), to.toISOString()],
    // `dashboard_report` levanta `forbidden` para quem não é admin (a RPC checa
    // `private.is_admin()`), então chamar sem o papel é erro garantido. O gate
    // vivia só no componente (`_app.app.tsx`); trazê-lo para cá vale para TODO
    // chamador do hook, presente e futuro — defesa em profundidade junto com o
    // fix da causa raiz em `useSwitchWorkspace`.
    enabled: !!profile?.tenant_id && profile?.role === "admin",
    staleTime: 60 * 1000,
    // Trava de sessão + retry: mesmo padrão de entitlements.ts (session-guard.ts)
    // contra o 42501 quando a RPC sai antes do token anexar.
    retry: rpcRetry,
    retryDelay: 400,
    throwOnError: false,
    queryFn: async () => {
      await waitForSession();
      const { data, error } = await supabase.rpc("dashboard_report", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
      });
      if (error) throw error;
      return data as unknown as DashboardReport;
    },
  });
}

export type HandoffSlaEvent = {
  awaiting_human_since: string;
  resolved_at: string;
};

export type HandoffSlaPercentiles = {
  p50: number;
  p95: number;
};

/**
 * p50/p95 (minutos) da latência handoff→resolução. Nearest-rank (mesmo
 * método usado por ferramentas de observabilidade como k6/Grafana): sem
 * interpolação, o resultado é sempre uma latência real observada, nunca um
 * valor sintético entre dois eventos.
 *
 * Função pura — recebe eventos já filtrados por tenant/período, não faz
 * I/O. Latências negativas (relógio inconsistente) são descartadas. Retorna
 * `null` sem eventos válidos (nunca p50/p95 parciais ou NaN).
 */
export function computeHandoffSlaPercentiles(
  events: HandoffSlaEvent[],
): HandoffSlaPercentiles | null {
  const latenciesMin = events
    .map(
      (e) =>
        (new Date(e.resolved_at).getTime() - new Date(e.awaiting_human_since).getTime()) / 60_000,
    )
    .filter((min) => Number.isFinite(min) && min >= 0)
    .sort((a, b) => a - b);

  if (latenciesMin.length === 0) return null;

  return { p50: nearestRank(latenciesMin, 50), p95: nearestRank(latenciesMin, 95) };
}

function nearestRank(sortedAsc: number[], p: number): number {
  const rank = Math.ceil((p / 100) * sortedAsc.length);
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, rank - 1));
  return sortedAsc[idx];
}

export type DealOwnerLeaderboardRow = {
  owner_id: string | null;
  owner_name: string | null;
  wins: number | null;
  decided: number | null;
  win_rate_pct: number | null;
  total_won_value: number | null;
};

/**
 * Ranking de owners de deals (user story G). Consulta a view
 * `deal_owner_leaderboard` (security_invoker=true, RLS de `deals`/`profiles`
 * aplicada normalmente) já ordenada por vitórias.
 *
 * Decisão: sem filtro de período nesta primeira versão. A view não fixa
 * período (ver comentário na migration) e o AC da PRD não exige período
 * obrigatório no leaderboard — só no dashboard (user story K). Filtrar por
 * período aqui exigiria join adicional com `deals.updated_at`/
 * `stage_entered_at` na própria view ou trocar para uma RPC; o ranking
 * "geral" cobre o AC com a menor complexidade possível. Revisitar se o
 * produto pedir período no ranking depois.
 */
export function useDealOwnerLeaderboard() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<DealOwnerLeaderboardRow[]>({
    queryKey: ["deal-owner-leaderboard", tenantId],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("deal_owner_leaderboard")
        .select("owner_id, owner_name, wins, decided, win_rate_pct, total_won_value")
        .eq("tenant_id", tenantId!)
        .order("wins", { ascending: false });
      if (error) throw error;
      return (data ?? []) as DealOwnerLeaderboardRow[];
    },
  });
}

export type PeriodOverPeriod = {
  pct: number | null;
  label: string;
};

/**
 * Variação percentual entre o período atual e o anterior de mesma duração
 * (user story K). Função pura, sem I/O — mesmo estilo de
 * `computeHandoffSlaPercentiles` acima.
 *
 * - `previous === 0 && current === 0`: não há base de comparação nem
 *   crescimento — `{ pct: null, label: "sem dados" }`.
 * - `previous === 0 && current > 0`: variação percentual não é definida
 *   (divisão por zero); é dado novo que não existia no período anterior —
 *   `{ pct: null, label: "novo" }` (nunca divide por zero).
 * - Caso contrário: variação percentual normal, arredondada ao inteiro mais
 *   próximo.
 */
export function computePeriodOverPeriod(current: number, previous: number): PeriodOverPeriod {
  if (previous === 0 && current === 0) return { pct: null, label: "sem dados" };
  if (previous === 0) return { pct: null, label: "novo" };
  const pct = Math.round(((current - previous) / previous) * 100);
  const label = `${pct > 0 ? "+" : ""}${pct}%`;
  return { pct, label };
}

export function useHandoffSlaEvents(from: Date, to: Date) {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id ?? null;
  return useQuery<HandoffSlaEvent[]>({
    queryKey: ["handoff-sla-events", tenantId, from.toISOString(), to.toISOString()],
    enabled: !!tenantId,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("hitl_handoff_sla_events")
        .select("awaiting_human_since, resolved_at")
        .eq("tenant_id", tenantId!)
        .not("resolved_at", "is", null)
        .gte("resolved_at", from.toISOString())
        .lt("resolved_at", to.toISOString());
      if (error) throw error;
      const rows = (data ?? []) as Array<{
        awaiting_human_since: string;
        resolved_at: string | null;
      }>;
      return rows.filter((r): r is HandoffSlaEvent => r.resolved_at !== null);
    },
  });
}
