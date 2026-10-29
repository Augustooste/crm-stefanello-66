import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";
import { useCurrentProfile } from "@/lib/api/session";

// ─── Tipos ────────────────────────────────────────────────────────────────

export type NurtureTriggerType =
  "manual" | "stage_change" | "stagnant" | "periodic" | "won" | "birthday";

export type NurtureEnrollmentStatus = "active" | "sending" | "paused" | "completed" | "cancelled";

// Subconjunto de status que a RPC set_nurture_enrollment_status aceita como
// alvo (supabase/migrations/20260710140000_fase4_nurture_schema.sql) --
// "sending"/"completed" são geridos só pelo worker, nunca por esta UI.
export type SettableNurtureEnrollmentStatus = "active" | "paused" | "cancelled";

export interface NurtureStepRow {
  id: string;
  sequence_id: string;
  step_number: number;
  delay_hours: number;
  message_template: string;
  created_at: string;
  updated_at: string;
}

export interface NurtureSequenceRow {
  id: string;
  tenant_id: string;
  name: string;
  description: string | null;
  channel_id: string | null;
  trigger_type: NurtureTriggerType;
  trigger_stage_id: string | null;
  stagnant_days: number | null;
  periodic_days: number | null;
  notify_owner: boolean;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  nurture_steps: NurtureStepRow[];
}

export interface NurtureEnrollmentRow {
  id: string;
  tenant_id: string;
  sequence_id: string;
  deal_id: string | null;
  contact_id: string;
  current_step: number;
  status: NurtureEnrollmentStatus;
  enrolled_at: string;
  next_send_at: string | null;
  completed_at: string | null;
  updated_at: string;
  contact: { id: string; name: string } | null;
  deal: { id: string; title: string } | null;
}

export type NurtureExecutionRow = {
  id: string;
  tenant_id: string;
  enrollment_id: string;
  step_number: number;
  outcome:
    | "sent"
    | "completed"
    | "retry"
    | "exhausted"
    | "skipped_suppressed"
    | "skipped_cancelled"
    | "deferred_frequency"
    | "deferred_handoff"
    | "deferred_window";
  detail: string | null;
  executed_at: string;
};

// Tabela da migration 20261015140000; types.ts gerado pelo Lovable é intocável.
type NurtureDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      nurture_execution_history: {
        Row: NurtureExecutionRow;
        Insert: never;
        Update: never;
        Relationships: [];
      };
    };
  };
};
const historyClient = supabase as unknown as SupabaseClient<NurtureDatabase, "public">;

export interface BoardStageOption {
  id: string;
  name: string;
}

const SEQUENCES_KEY = ["nurture-sequences"] as const;
const ENROLLMENTS_KEY = ["nurture-enrollments"] as const;
const BOARD_STAGES_KEY = ["board-stages-for-nurture"] as const;

// ─── Queries ─────────────────────────────────────────────────────────────

async function fetchNurtureSequences(): Promise<NurtureSequenceRow[]> {
  const { data, error } = await supabase
    .from("nurture_sequences")
    .select(
      "id, tenant_id, name, description, channel_id, trigger_type, trigger_stage_id, stagnant_days, periodic_days, notify_owner, is_active, created_at, updated_at, nurture_steps(id, sequence_id, step_number, delay_hours, message_template, created_at, updated_at)",
    )
    .order("name", { ascending: true });
  if (error) throw error;
  const rows = (data ?? []) as unknown as NurtureSequenceRow[];
  // O select aninhado do Supabase não garante ordem determinística da tabela
  // filha -- ordena por step_number no client (cópia nova, nunca muta `rows`).
  return rows.map((row) => ({
    ...row,
    nurture_steps: [...row.nurture_steps].sort((a, b) => a.step_number - b.step_number),
  }));
}

export function useNurtureSequences() {
  return useQuery({
    queryKey: SEQUENCES_KEY,
    queryFn: fetchNurtureSequences,
  });
}

async function fetchNurtureEnrollments(tenantId: string): Promise<NurtureEnrollmentRow[]> {
  const { data, error } = await supabase
    .from("nurture_enrollments")
    .select(
      "id, tenant_id, sequence_id, deal_id, contact_id, current_step, status, enrolled_at, next_send_at, completed_at, updated_at, contact:contacts!contact_id(id, name), deal:deals!deal_id(id, title)",
    )
    .eq("tenant_id", tenantId)
    .order("enrolled_at", { ascending: false });
  if (error) throw error;
  return (data ?? []) as unknown as NurtureEnrollmentRow[];
}

export function useNurtureEnrollments() {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery({
    queryKey: [...ENROLLMENTS_KEY, tenantId],
    enabled: !!tenantId,
    queryFn: () => fetchNurtureEnrollments(tenantId!),
  });
}

export function useNurtureExecutionHistory(enrollmentId: string, enabled: boolean) {
  const { data: profile } = useCurrentProfile();
  const tenantId = profile?.tenant_id;
  return useQuery({
    queryKey: ["nurture-execution-history", tenantId, enrollmentId],
    enabled: enabled && !!tenantId,
    queryFn: async (): Promise<NurtureExecutionRow[]> => {
      const { data, error } = await historyClient
        .from("nurture_execution_history")
        .select("id, tenant_id, enrollment_id, step_number, outcome, detail, executed_at")
        .eq("tenant_id", tenantId!)
        .eq("enrollment_id", enrollmentId)
        .order("executed_at", { ascending: false })
        .limit(100);
      if (error) throw error;
      return data ?? [];
    },
  });
}

async function fetchDefaultBoardStages(): Promise<BoardStageOption[]> {
  const { data: board, error: boardError } = await supabase
    .from("boards")
    .select("id")
    .eq("is_default", true)
    .maybeSingle();
  if (boardError) throw boardError;
  if (!board) return [];

  const { data, error } = await supabase
    .from("board_stages")
    .select("id, name")
    .eq("board_id", board.id)
    .order("position", { ascending: true });
  if (error) throw error;
  return (data ?? []) as BoardStageOption[];
}

/** Etapas do funil default, para o seletor de trigger_stage_id (stage_change/stagnant). */
export function useBoardStagesForNurture() {
  return useQuery({
    queryKey: BOARD_STAGES_KEY,
    queryFn: fetchDefaultBoardStages,
  });
}

function useInvalidateSequences() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SEQUENCES_KEY });
}

function useInvalidateEnrollments() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ENROLLMENTS_KEY });
}

// ─── Mutations: nurture_sequences (CRUD direto -- RLS "admin all" já exige
// private.is_admin() para insert/update; não existe RPC de sequence, ao
// contrário de messaging_templates. Só o enrollment tem RPC própria.) ───────

export interface NurtureSequenceFormInput {
  name: string;
  triggerType: NurtureTriggerType;
  triggerStageId: string | null;
  stagnantDays: number | null;
  periodicDays: number | null;
  notifyOwner: boolean;
}

export interface CreateNurtureSequenceInput extends NurtureSequenceFormInput {
  tenantId: string;
}

export function useCreateNurtureSequence() {
  const invalidate = useInvalidateSequences();
  return useMutation({
    mutationFn: async (input: CreateNurtureSequenceInput): Promise<void> => {
      const { error } = await supabase.from("nurture_sequences").insert({
        tenant_id: input.tenantId,
        name: input.name,
        trigger_type: input.triggerType,
        trigger_stage_id: input.triggerStageId,
        stagnant_days: input.stagnantDays,
        periodic_days: input.periodicDays,
        notify_owner: input.notifyOwner,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export interface UpdateNurtureSequenceInput extends NurtureSequenceFormInput {
  id: string;
  isActive: boolean;
}

export function useUpdateNurtureSequence() {
  const invalidate = useInvalidateSequences();
  return useMutation({
    mutationFn: async (input: UpdateNurtureSequenceInput): Promise<void> => {
      const { error } = await supabase
        .from("nurture_sequences")
        .update({
          name: input.name,
          trigger_type: input.triggerType,
          trigger_stage_id: input.triggerStageId,
          stagnant_days: input.stagnantDays,
          periodic_days: input.periodicDays,
          notify_owner: input.notifyOwner,
          is_active: input.isActive,
        })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

// ─── Mutations: nurture_steps (CRUD direto, mesma RLS admin all herdada da
// sequence via EXISTS) ──────────────────────────────────────────────────────

export interface NurtureStepFormInput {
  stepNumber: number;
  delayHours: number;
  messageTemplate: string;
}

export interface CreateNurtureStepInput extends NurtureStepFormInput {
  sequenceId: string;
}

export function useCreateNurtureStep() {
  const invalidate = useInvalidateSequences();
  return useMutation({
    mutationFn: async (input: CreateNurtureStepInput): Promise<void> => {
      const { error } = await supabase.from("nurture_steps").insert({
        sequence_id: input.sequenceId,
        step_number: input.stepNumber,
        delay_hours: input.delayHours,
        message_template: input.messageTemplate,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export interface UpdateNurtureStepInput extends NurtureStepFormInput {
  id: string;
}

export function useUpdateNurtureStep() {
  const invalidate = useInvalidateSequences();
  return useMutation({
    mutationFn: async (input: UpdateNurtureStepInput): Promise<void> => {
      const { error } = await supabase
        .from("nurture_steps")
        .update({
          step_number: input.stepNumber,
          delay_hours: input.delayHours,
          message_template: input.messageTemplate,
        })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteNurtureStep() {
  const invalidate = useInvalidateSequences();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from("nurture_steps").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

// ─── Mutations: nurture_enrollments (RPC-only -- NUNCA update direto, não
// existe policy de UPDATE para authenticated nesta tabela, de propósito) ────

export interface SetNurtureEnrollmentStatusInput {
  enrollmentId: string;
  status: SettableNurtureEnrollmentStatus;
}

export function useSetNurtureEnrollmentStatus() {
  const invalidate = useInvalidateEnrollments();
  return useMutation({
    mutationFn: async (input: SetNurtureEnrollmentStatusInput) => {
      const { data, error } = await supabase.rpc("set_nurture_enrollment_status", {
        p_enrollment_id: input.enrollmentId,
        p_status: input.status,
      });
      if (error) throw error;
      return data;
    },
    onSuccess: invalidate,
  });
}
