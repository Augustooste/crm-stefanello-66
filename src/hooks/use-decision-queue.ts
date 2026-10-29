import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

// ─── Tipos ────────────────────────────────────────────────────────────────

export type Priority = "critical" | "high" | "medium" | "low";
export type DecisionCategory = "follow_up" | "deadline" | "opportunity" | "risk" | "routine";
export type StageAdvanceStatus = "pending" | "approved" | "rejected" | "expired" | "auto_approved";
export type HitlDecisionStatus = "pending" | "approved" | "rejected" | "snoozed" | "expired";

export interface StageAdvanceRow {
  id: string;
  tenant_id: string;
  deal_id: string;
  conversation_id: string | null;
  current_stage_id: string;
  suggested_stage_id: string;
  confidence: number;
  reason: string;
  criteria_evaluation: unknown;
  status: StageAdvanceStatus;
  created_at: string;
  expires_at: string;
  deal: {
    id: string;
    title: string;
    board_id: string;
    contact: { id: string; name: string } | null;
  } | null;
}

export interface HitlDecisionRow {
  id: string;
  tenant_id: string;
  type: string;
  priority: Priority;
  category: DecisionCategory;
  title: string;
  description: string | null;
  reasoning: string | null;
  deal_id: string | null;
  contact_id: string | null;
  activity_id: string | null;
  suggested_action: unknown;
  alternative_actions: unknown;
  status: HitlDecisionStatus;
  created_at: string;
  expires_at: string | null;
  snooze_until: string | null;
  deal: { id: string; title: string } | null;
  contact: { id: string; name: string } | null;
  activity: { id: string; title: string } | null;
}

export type QueueItem =
  | {
      kind: "stage_advance";
      id: string;
      priority: Priority;
      createdAt: string;
      row: StageAdvanceRow;
    }
  | { kind: "decision"; id: string; priority: Priority; createdAt: string; row: HitlDecisionRow };

// ─── Heurística de prioridade derivada (stage advances) ────────────────────
//
// `ai_pending_stage_advances` NÃO tem coluna `priority` própria (schema da
// migration 20260710120000_fase3_hitl_decision_queue_schema.sql) -- só chegam
// nesta fila linhas com `hitl_reject_threshold <= confidence <
// hitl_auto_threshold` (banda em ai_settings, defaults 0.40/0.90: abaixo do
// reject_threshold o backend descarta sem enfileirar, acima do auto_threshold
// avança sozinho sem passar por aqui). Dentro dessa banda:
//   - confidence >= 0.7 (mais perto do limite de auto-aprovação) -> a IA já
//     está bem confiante, a revisão humana é mais um "rubber stamp" que uma
//     investigação -> priority 'medium'.
//   - confidence < 0.7 (mais perto do limite de descarte) -> a sugestão é
//     mais incerta e precisa de mais atenção antes que o deal fique parado
//     ou avance errado -> priority 'high'.
// 0.7 é o ponto médio aproximado da banda [0.4, 0.9). Documentado aqui
// porque não existe consenso de produto ainda sobre o corte exato -- é a
// heurística desta sessão, revisável quando houver dado real de acerto/erro
// por faixa de confidence.
export function deriveStageAdvancePriority(
  confidence: number,
): Extract<Priority, "medium" | "high"> {
  return Number(confidence) >= 0.7 ? "medium" : "high";
}

export const PRIORITY_RANK: Record<Priority, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Funde as duas filas (hitl_decisions + ai_pending_stage_advances) num único
 * array ordenado por prioridade (crítica -> baixa) e, dentro da mesma
 * prioridade, por `created_at` ASCENDENTE (FIFO -- quem está esperando há
 * mais tempo aparece primeiro). Não é union SQL: cada tabela já chega
 * filtrada por status pela query que a busca; esta função só combina e
 * ordena o resultado em memória.
 */
export function mergeAndSortQueue(
  decisions: HitlDecisionRow[],
  advances: StageAdvanceRow[],
): QueueItem[] {
  const items: QueueItem[] = [
    ...advances.map((row): QueueItem => ({
      kind: "stage_advance",
      id: row.id,
      priority: deriveStageAdvancePriority(row.confidence),
      createdAt: row.created_at,
      row,
    })),
    ...decisions.map((row): QueueItem => ({
      kind: "decision",
      id: row.id,
      priority: row.priority,
      createdAt: row.created_at,
      row,
    })),
  ];

  return [...items].sort((a, b) => {
    const rankDiff = PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority];
    if (rankDiff !== 0) return rankDiff;
    return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
  });
}

// ─── Queries ────────────────────────────────────────────────────────────────

const DECISION_QUEUE_KEY = ["decision-queue"] as const;

async function fetchPendingDecisions(): Promise<HitlDecisionRow[]> {
  const nowIso = new Date().toISOString();
  const { data, error } = await supabase
    .from("hitl_decisions")
    .select(
      "id, tenant_id, type, priority, category, title, description, reasoning, deal_id, contact_id, activity_id, suggested_action, alternative_actions, status, created_at, expires_at, snooze_until, deal:deals(id, title), contact:contacts(id, name), activity:activities(id, title)",
    )
    // status='pending' OR (status='snoozed' AND snooze_until já venceu) --
    // critério de aceite: snooze "some da fila até a data", volta sozinho
    // depois sem precisar apagar/recriar o registro.
    .or(`status.eq.pending,and(status.eq.snoozed,snooze_until.lte.${nowIso})`)
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as HitlDecisionRow[];
}

async function fetchPendingStageAdvances(): Promise<StageAdvanceRow[]> {
  const { data, error } = await supabase
    .from("ai_pending_stage_advances")
    .select(
      "id, tenant_id, deal_id, conversation_id, current_stage_id, suggested_stage_id, confidence, reason, criteria_evaluation, status, created_at, expires_at, deal:deals(id, title, board_id, contact:contacts(id, name))",
    )
    .eq("status", "pending")
    .order("created_at", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as StageAdvanceRow[];
}

export function useDecisionQueue() {
  const decisionsQ = useQuery({
    queryKey: [...DECISION_QUEUE_KEY, "decisions"],
    queryFn: fetchPendingDecisions,
  });
  const advancesQ = useQuery({
    queryKey: [...DECISION_QUEUE_KEY, "stage-advances"],
    queryFn: fetchPendingStageAdvances,
  });

  const items = useMemo(
    () => mergeAndSortQueue(decisionsQ.data ?? [], advancesQ.data ?? []),
    [decisionsQ.data, advancesQ.data],
  );

  return {
    items,
    isLoading: decisionsQ.isLoading || advancesQ.isLoading,
    isError: decisionsQ.isError || advancesQ.isError,
    error: decisionsQ.error ?? advancesQ.error,
    refetch: () => {
      void decisionsQ.refetch();
      void advancesQ.refetch();
    },
  };
}

export interface BoardStageOption {
  id: string;
  name: string;
  position: number;
}

/** Estágios do MESMO board do deal -- usado só pelo seletor de "editar antes de aprovar". */
export function useBoardStagesForBoard(boardId: string | null | undefined) {
  return useQuery({
    queryKey: ["board-stages-for-board", boardId],
    enabled: !!boardId,
    queryFn: async (): Promise<BoardStageOption[]> => {
      const { data, error } = await supabase
        .from("board_stages")
        .select("id, name, position")
        .eq("board_id", boardId!)
        .order("position");
      if (error) throw error;
      return (data ?? []) as BoardStageOption[];
    },
  });
}

// ─── Mutations (RPC-only -- atomicidade é responsabilidade do banco) ───────
//
// Nunca fazer UPDATE direto em ai_pending_stage_advances/hitl_decisions a
// partir do client: as RPCs resolve_pending_stage_advance/resolve_hitl_decision
// (supabase/migrations/20260710120000_fase3_hitl_decision_queue_schema.sql)
// já fazem o guard otimista, o `UPDATE deals.stage_id` e a linha de
// hitl_audit_log dentro da MESMA transação. Duplicar isso no client quebraria
// a atomicidade e a trilha de auditoria.

function useInvalidateAfterResolution() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: DECISION_QUEUE_KEY });
    qc.invalidateQueries({ queryKey: ["deals"] });
    qc.invalidateQueries({ queryKey: ["dashboard"] });
  };
}

export interface ResolveStageAdvanceInput {
  advanceId: string;
  action: "approve" | "reject";
  reason?: string;
  /** Preenchido só no fluxo "Editar antes de aprovar" -- troca o stage sugerido. */
  suggestedStageId?: string;
}

export function useResolveStageAdvance() {
  const invalidate = useInvalidateAfterResolution();
  return useMutation({
    mutationFn: async (input: ResolveStageAdvanceInput) => {
      const { data, error } = await supabase.rpc("resolve_pending_stage_advance", {
        p_advance_id: input.advanceId,
        p_action: input.action,
        p_reason: input.reason ?? undefined,
        p_modifications: input.suggestedStageId
          ? { suggested_stage_id: input.suggestedStageId }
          : null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}

export interface ResolveHitlDecisionInput {
  decisionId: string;
  action: "approve" | "reject" | "snooze";
  reason?: string;
  snoozeUntil?: string;
}

export function useResolveHitlDecision() {
  const invalidate = useInvalidateAfterResolution();
  return useMutation({
    mutationFn: async (input: ResolveHitlDecisionInput) => {
      const { data, error } = await supabase.rpc("resolve_hitl_decision", {
        p_decision_id: input.decisionId,
        p_action: input.action,
        p_reason: input.reason ?? undefined,
        p_snooze_until: input.snoozeUntil ?? undefined,
        p_modifications: null,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}
