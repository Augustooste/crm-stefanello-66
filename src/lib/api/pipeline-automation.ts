import { useEffect } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

type RpcResult = PromiseLike<{ data: unknown; error: { message: string } | null }>;
type RpcFn = (name: string, args?: Record<string, unknown>) => RpcResult;
const getRpc = (): RpcFn => supabase.rpc.bind(supabase) as unknown as RpcFn;

// As tabelas do pipeline autônomo JÁ estão em integrations/supabase/types.ts
// (o comentário anterior, "migration pendente", ficou obsoleto quando os tipos
// foram regenerados). Por isso o `.from()` aqui é o client tipado: nome de
// coluna em `.select()` e payload de `.update()` passam a ser verificados pelo
// tsc. Só o `.rpc()` continua frouxo (getRpc) — as funções do pipeline não
// estão no types.ts gerado.
// Exportados para o teste de contrato (pipeline-automation.test.ts) pinar o
// vínculo com o schema: se alguém afrouxar isto de volta para
// `Record<string, unknown>`, o `@ts-expect-error` de lá vira TS2578 e o
// `tsc --noEmit` quebra.
export type DealsUpdate = Database["public"]["Tables"]["deals"]["Update"];
export type StageTransitionsUpdate = Database["public"]["Tables"]["stage_transitions"]["Update"];

export type AutomationMode = "manual" | "shadow" | "assisted" | "autonomous";

export interface StageTransitionRule {
  id: string;
  tenant_id: string;
  board_id: string;
  from_stage_id: string;
  to_stage_id: string;
  enabled: boolean;
  autonomy_mode: AutomationMode;
  required_signals: Record<string, unknown>;
  min_confidence: number;
  cooldown_minutes: number;
  requires_human_approval: boolean;
}

export interface DealStageEvaluation {
  id: string;
  deal_id: string;
  stage_id: string;
  criterion_key: string;
  criterion_label: string;
  status: "met" | "unmet" | "insufficient" | "corrected";
  confidence: number;
  evidence: string | null;
  evaluated_at: string;
  human_feedback: string | null;
}

export interface PendingStageAdvance {
  id: string;
  deal_id: string;
  current_stage_id: string;
  suggested_stage_id: string;
  confidence: number;
  reason: string;
  criteria_evaluation: unknown;
  status: string;
  created_at: string;
}

export interface DealStageHistory {
  id: string;
  deal_id: string;
  from_stage_id: string | null;
  to_stage_id: string | null;
  actor_type: string | null;
  reason: string | null;
  evidence: Record<string, unknown> | null;
  confidence: number | null;
  decision: string | null;
  created_at: string;
  reversal_of_history_id: string | null;
}

export interface TransitionCommand {
  id: string;
  deal_id: string;
  status: string;
  decision: string;
  confidence: number | null;
  created_at: string;
}

export interface PipelineAutomationState {
  evaluations: DealStageEvaluation[];
  pending: PendingStageAdvance[];
  history: DealStageHistory[];
  commands: TransitionCommand[];
}

export interface TransitionDealInput {
  dealId: string;
  expectedStageId: string;
  targetStageId: string;
  reason: string;
  evidence?: Record<string, unknown>;
  confidence?: number | null;
  idempotencyKey?: string;
  reversalOfHistoryId?: string | null;
}

export async function transitionDealStage(input: TransitionDealInput) {
  const { data, error } = await getRpc()("transition_deal_stage", {
    p_deal_id: input.dealId,
    p_expected_stage_id: input.expectedStageId,
    p_target_stage_id: input.targetStageId,
    p_actor_type: "human",
    p_actor_id: null,
    p_reason: input.reason,
    p_evidence: input.evidence ?? {},
    p_confidence: input.confidence ?? null,
    p_idempotency_key: input.idempotencyKey ?? crypto.randomUUID(),
    p_model_version: null,
    p_prompt_snapshot: null,
    p_criteria_evaluation: [],
    p_trigger_event: "kanban.manual",
    p_correlation_id: crypto.randomUUID(),
    p_reversal_of_history_id: input.reversalOfHistoryId ?? null,
  });
  if (error) throw new Error(error.message);
  const result = data as { success?: boolean; status?: string; reason?: string };
  if (result?.status !== "accepted") {
    const reason =
      result?.reason === "stage_changed"
        ? "Este negócio já foi movido. O funil foi atualizado."
        : `Movimento bloqueado: ${result?.reason ?? "regra de transição"}.`;
    throw new Error(reason);
  }
  return result;
}

export function usePipelineAutomationState(dealIds: string[]) {
  const stableIds = [...dealIds].sort();
  return useQuery({
    queryKey: ["pipeline-automation-state", stableIds],
    enabled: stableIds.length > 0,
    queryFn: async (): Promise<PipelineAutomationState> => {
      const [evaluations, pending, history, commands] = await Promise.all([
        supabase
          .from("deal_stage_evaluations")
          .select(
            "id, deal_id, stage_id, criterion_key, criterion_label, status, confidence, evidence, evaluated_at, human_feedback",
          )
          .in("deal_id", stableIds)
          .order("evaluated_at", { ascending: false }),
        supabase
          .from("ai_pending_stage_advances")
          .select(
            "id, deal_id, current_stage_id, suggested_stage_id, confidence, reason, criteria_evaluation, status, created_at",
          )
          .in("deal_id", stableIds)
          .eq("status", "pending"),
        supabase
          .from("deal_stage_history")
          .select(
            "id, deal_id, from_stage_id, to_stage_id, actor_type, reason, evidence, confidence, decision, created_at, reversal_of_history_id",
          )
          .in("deal_id", stableIds)
          .order("created_at", { ascending: false })
          .limit(500),
        supabase
          .from("deal_stage_transition_commands")
          .select("id, deal_id, status, decision, confidence, created_at")
          .in("deal_id", stableIds)
          .order("created_at", { ascending: false })
          .limit(500),
      ]);

      for (const result of [evaluations, pending, history, commands]) {
        if (result.error) throw result.error;
      }
      return {
        evaluations: (evaluations.data ?? []) as unknown as DealStageEvaluation[],
        pending: (pending.data ?? []) as unknown as PendingStageAdvance[],
        history: (history.data ?? []) as unknown as DealStageHistory[],
        commands: (commands.data ?? []) as unknown as TransitionCommand[],
      };
    },
  });
}

export function usePipelineRealtime(input: { tenantId?: string; boardId?: string }) {
  const qc = useQueryClient();
  useEffect(() => {
    if (!input.tenantId || !input.boardId) return;
    if (typeof supabase.channel !== "function") return;

    const invalidate = () => {
      void qc.invalidateQueries({ queryKey: ["deals", input.boardId] });
      void qc.invalidateQueries({ queryKey: ["pipeline-automation-state"] });
      void qc.invalidateQueries({ queryKey: ["pipeline-automation-metrics", input.boardId] });
    };
    // Nome único por subscribe: o RealtimeClient de @supabase/realtime-js
    // devolve o canal EXISTENTE para nomes iguais, e `RealtimeChannel.on()`
    // lança "cannot add postgres_changes callbacks after subscribe()" numa
    // remontagem rápida (StrictMode no dev; trocar de rota e voltar em prod).
    // O nome é local e não afeta o filtro realtime — quem importa são os
    // filtros `postgres_changes` abaixo.
    const channel = supabase
      .channel(`pipeline:${input.tenantId}:${input.boardId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "deals",
          filter: `board_id=eq.${input.boardId}`,
        },
        invalidate,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "ai_pending_stage_advances",
          filter: `tenant_id=eq.${input.tenantId}`,
        },
        invalidate,
      )
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "deal_stage_history",
          filter: `tenant_id=eq.${input.tenantId}`,
        },
        invalidate,
      )
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "deal_stage_evaluations",
          filter: `tenant_id=eq.${input.tenantId}`,
        },
        invalidate,
      )
      .subscribe();

    return () => {
      void supabase.removeChannel(channel);
    };
  }, [input.boardId, input.tenantId, qc]);
}

export function useResolvePipelineAdvance() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      advanceId: string;
      action: "approve" | "reject";
      reason?: string;
      suggestedStageId?: string;
    }) => {
      const { data, error } = await getRpc()("resolve_pending_stage_advance", {
        p_advance_id: input.advanceId,
        p_action: input.action,
        p_reason: input.reason ?? null,
        p_modifications: input.suggestedStageId
          ? { suggested_stage_id: input.suggestedStageId }
          : null,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: async () => {
      await Promise.all([
        qc.invalidateQueries({ queryKey: ["deals"] }),
        qc.invalidateQueries({ queryKey: ["pipeline-automation-state"] }),
      ]);
    },
  });
}

export function usePauseDealAutomation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { dealId: string; paused: boolean }) => {
      // Tipado pelo schema gerado: coluna inexistente ou tipo errado agora
      // quebra o `tsc --noEmit` em vez de virar 42703/PGRST204 em runtime.
      const patch: DealsUpdate = {
        automation_mode: input.paused ? "paused" : "inherit",
        automation_lock_reason: input.paused ? "Pausada manualmente no Kanban" : null,
        automation_paused_until: null,
      };
      const { error } = await supabase.from("deals").update(patch).eq("id", input.dealId);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["deals"] }),
  });
}

export function useReviewDealEvaluation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: { evaluationId: string; note: string }) => {
      const { data, error } = await getRpc()("review_deal_stage_evaluation", {
        p_evaluation_id: input.evaluationId,
        p_status: "corrected",
        p_note: input.note,
      });
      if (error) throw new Error(error.message);
      return data;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["pipeline-automation-state"] }),
  });
}

export function useStageTransitionRules(boardId?: string) {
  return useQuery({
    queryKey: ["stage-transition-rules", boardId],
    enabled: !!boardId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("stage_transitions")
        .select(
          "id, tenant_id, board_id, from_stage_id, to_stage_id, enabled, autonomy_mode, required_signals, min_confidence, cooldown_minutes, requires_human_approval",
        )
        .eq("board_id", boardId!)
        .order("created_at");
      if (error) throw error;
      return (data ?? []) as unknown as StageTransitionRule[];
    },
  });
}

export function useUpdateStageTransitionRule(boardId?: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: {
      id: string;
      autonomyMode: AutomationMode;
      minConfidence: number;
      requiresHumanApproval: boolean;
    }) => {
      const patch: StageTransitionsUpdate = {
        autonomy_mode: input.autonomyMode,
        min_confidence: input.minConfidence,
        requires_human_approval: input.requiresHumanApproval,
      };
      const { error } = await supabase.from("stage_transitions").update(patch).eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["stage-transition-rules", boardId] }),
  });
}

export function usePipelineAutomationMetrics(boardId?: string) {
  return useQuery({
    queryKey: ["pipeline-automation-metrics", boardId],
    enabled: !!boardId,
    queryFn: async () => {
      const { data, error } = await getRpc()("get_pipeline_automation_metrics", {
        p_board_id: boardId!,
      });
      if (error) throw new Error(error.message);
      return data as {
        suggested: number;
        queued: number;
        automatic: number;
        blocked: number;
        rejected: number;
        reversals: number;
        wonAfterAi: number;
      };
    },
  });
}
