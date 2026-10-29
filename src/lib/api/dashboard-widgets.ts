import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentProfile } from "@/lib/api/session";
import { rpcRetry, waitForSession } from "@/lib/api/session-guard";

/**
 * Épico C (Dashboard rico) — hooks dos 4 cards novos de `/app`.
 *
 * Card 1/2/3 chamam RPCs SECURITY DEFINER tenant-scoped (mesmo padrão de
 * `useDashboardReport` em reports.ts), sem gate de admin — `/app` não é
 * admin-only, diferente de `/relatorios`. Card 4 não tem RPC dedicada: 2
 * selects client-side com RLS (activities/deal_followups já são
 * tenant-scoped por policy), igual ao padrão de useUnansweredLeads em
 * _app.app.tsx.
 *
 * "Responsável" (p_owner_id / ownerId) mapeia SEMPRE para o dono do
 * contato/negócio/atividade (owner_id / created_by) — NUNCA para o
 * remetente de mensagem. `messages` não tem coluna de atribuição por
 * vendedor neste projeto (só `sender` em 'contact'|'agent'|'ai'), diferente
 * do medflow-v0.
 *
 * Os três RPCs recebem p_board_id e mantêm o quadro na chave de cache.
 * Retornos pendentes filtram por deals.board_id no client. Os extras de
 * contatos/follow-ups do card de mensagens exibem explicitamente seu escopo
 * em todos os quadros.
 */

const walletHealthSchema = z.object({
  contatos_ativos: z.number(),
  contatos_inativos: z.number(),
  contatos_total: z.number(),
  negocios_parados: z.number(),
  negocios_parados_valor: z.number(),
  ltv_medio: z.number().nullable(),
  inactive_days_threshold: z.number(),
  stagnant_days_threshold: z.number(),
});

const PENDING_RETURNS_QUERY_LIMIT = 200;

export type WalletHealth = z.infer<typeof walletHealthSchema>;

export function useWalletHealth(ownerId: string | null, boardId: string | null = null) {
  const { data: profile } = useCurrentProfile();
  return useQuery<WalletHealth>({
    queryKey: ["dashboard-wallet-health", profile?.tenant_id, ownerId, boardId],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    retry: rpcRetry,
    retryDelay: 400,
    throwOnError: false,
    queryFn: async () => {
      await waitForSession();
      const { data, error } = await supabase.rpc("dashboard_wallet_health", {
        p_owner_id: ownerId ?? undefined,
        p_board_id: boardId ?? undefined,
      });
      if (error) throw error;
      return walletHealthSchema.parse(data);
    },
  });
}

const messagingPerformanceSchema = z.object({
  frt_mediana_seg: z.number().nullable(),
  conversas_com_frt: z.number(),
  msgs_ia: z.number(),
  msgs_humano: z.number(),
  taxa_resposta_pct: z.number().nullable(),
  conversas_total: z.number(),
});

export type MessagingPerformance = z.infer<typeof messagingPerformanceSchema>;

export function useMessagingPerformance(
  from: Date,
  to: Date,
  ownerId: string | null,
  boardId: string | null = null,
) {
  const { data: profile } = useCurrentProfile();
  return useQuery<MessagingPerformance>({
    queryKey: [
      "dashboard-messaging-performance",
      profile?.tenant_id,
      from.toISOString(),
      to.toISOString(),
      ownerId,
      boardId,
    ],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    retry: rpcRetry,
    retryDelay: 400,
    throwOnError: false,
    queryFn: async () => {
      await waitForSession();
      const { data, error } = await supabase.rpc("dashboard_messaging_performance", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_owner_id: ownerId ?? undefined,
        p_board_id: boardId ?? undefined,
      });
      if (error) throw error;
      return messagingPerformanceSchema.parse(data);
    },
  });
}

const aiHitlPerformanceSchema = z.object({
  aguardando_humano: z.number(),
  auto_avancos: z.number(),
  drafts_aprovados_sem_edicao: z.number(),
  drafts_editados: z.number(),
  sugestoes_pendentes: z.number(),
  avancos_auto_aprovados: z.number(),
  avancos_aprovados_humano: z.number(),
  avancos_rejeitados: z.number(),
  taxa_aprovacao_pct: z.number().nullable(),
  cobertura_24h_pct: z.number(),
});

export type AiHitlPerformance = z.infer<typeof aiHitlPerformanceSchema>;

export function useAiHitlPerformance(
  from: Date,
  to: Date,
  ownerId: string | null,
  boardId: string | null = null,
) {
  const { data: profile } = useCurrentProfile();
  return useQuery<AiHitlPerformance>({
    queryKey: [
      "dashboard-ai-hitl-performance",
      profile?.tenant_id,
      from.toISOString(),
      to.toISOString(),
      ownerId,
      boardId,
    ],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    retry: rpcRetry,
    retryDelay: 400,
    throwOnError: false,
    queryFn: async () => {
      await waitForSession();
      const { data, error } = await supabase.rpc("dashboard_ai_hitl_performance", {
        p_from: from.toISOString(),
        p_to: to.toISOString(),
        p_owner_id: ownerId ?? undefined,
        p_board_id: boardId ?? undefined,
      });
      if (error) throw error;
      return aiHitlPerformanceSchema.parse(data);
    },
  });
}

// Horizonte de retornos pendentes (Card 4) — mesma janela do PendingReturnsCard
// do medflow-v0 (features/dashboard/components/PendingReturnsCard.tsx: 14 dias).
const PENDING_RETURNS_HORIZON_DAYS = 14;

export type PendingReturn = {
  id: string;
  kind: "activity" | "followup";
  title: string;
  contactId: string | null;
  scheduledAt: string;
  overdue: boolean;
};

type PendingActivityRow = {
  id: string;
  title: string;
  due_at: string | null;
  contact_id: string | null;
  deal: { board_id: string } | null;
};

type PendingFollowupRow = {
  id: string;
  description: string | null;
  scheduled_at: string;
  contact_id: string;
  deal: { board_id: string } | null;
};

/**
 * Filtro de board client-side (ver nota de limitação no topo do arquivo).
 * `deal` vem de um embed opcional (`deal_id` é nullable em ambas as
 * tabelas) -- itens sem negócio vinculado não pertencem a nenhum board, e
 * ficam ocultos quando um board específico é selecionado (não há como
 * atribuí-los a um funil). Sem board selecionado (`null` = "todos"), tudo
 * passa.
 */
function matchesBoard(deal: { board_id: string } | null, boardId: string | null): boolean {
  return boardId === null || deal?.board_id === boardId;
}

export function usePendingReturns(ownerId: string | null, boardId: string | null) {
  const { data: profile } = useCurrentProfile();
  return useQuery<PendingReturn[]>({
    queryKey: ["dashboard-pending-returns", profile?.tenant_id, ownerId, boardId],
    enabled: !!profile?.tenant_id,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const now = new Date();
      const horizon = new Date(now.getTime() + PENDING_RETURNS_HORIZON_DAYS * 86_400_000);

      let activitiesQuery = supabase
        .from("activities")
        .select("id, title, due_at, contact_id, deal:deals(board_id)")
        .is("completed_at", null)
        .not("due_at", "is", null)
        .lte("due_at", horizon.toISOString());
      if (ownerId) activitiesQuery = activitiesQuery.eq("owner_id", ownerId);

      let followupsQuery = supabase
        .from("deal_followups")
        .select("id, description, scheduled_at, contact_id, deal:deals(board_id)")
        .eq("status", "pending")
        .lte("scheduled_at", horizon.toISOString());
      if (ownerId) followupsQuery = followupsQuery.eq("created_by", ownerId);

      const [activitiesRes, followupsRes] = await Promise.all([
        activitiesQuery.order("due_at").limit(PENDING_RETURNS_QUERY_LIMIT),
        followupsQuery.order("scheduled_at").limit(PENDING_RETURNS_QUERY_LIMIT),
      ]);
      if (activitiesRes.error) throw activitiesRes.error;
      if (followupsRes.error) throw followupsRes.error;

      const activities = (activitiesRes.data ?? []) as unknown as PendingActivityRow[];
      const followups = (followupsRes.data ?? []) as unknown as PendingFollowupRow[];

      const items: PendingReturn[] = [
        ...activities
          .filter((a): a is PendingActivityRow & { due_at: string } => a.due_at !== null)
          .filter((a) => matchesBoard(a.deal, boardId))
          .map((a) => ({
            id: a.id,
            kind: "activity" as const,
            title: a.title,
            contactId: a.contact_id,
            scheduledAt: a.due_at,
            overdue: new Date(a.due_at) < now,
          })),
        ...followups
          .filter((f) => matchesBoard(f.deal, boardId))
          .map((f) => ({
            id: f.id,
            kind: "followup" as const,
            title: f.description ?? "Retorno agendado",
            contactId: f.contact_id,
            scheduledAt: f.scheduled_at,
            overdue: new Date(f.scheduled_at) < now,
          })),
      ];

      return items.sort(
        (a, b) => new Date(a.scheduledAt).getTime() - new Date(b.scheduledAt).getTime(),
      );
    },
  });
}
