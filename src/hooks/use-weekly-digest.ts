import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

// ─── Tipos ────────────────────────────────────────────────────────────────

export type RecipientChannel = "email" | "whatsapp";
export type DeliveryStatus = "pending" | "sending" | "sent" | "failed";
export type ReportStatus = "generated" | "sent" | "failed";

export interface WeeklyReportRecipientRow {
  id: string;
  tenant_id: string;
  channel: RecipientChannel;
  address: string;
  name: string | null;
  active: boolean;
}

export interface WeeklyReportDeliveryRow {
  id: string;
  report_id: string;
  recipient_id: string;
  channel: string;
  address: string;
  status: DeliveryStatus;
  attempt_count: number;
  updated_at: string | null;
}

export interface WeeklyReportRow {
  id: string;
  tenant_id: string;
  period_start: string;
  period_end: string;
  status: ReportStatus;
  created_at: string | null;
  weekly_report_deliveries: WeeklyReportDeliveryRow[];
}

const RECIPIENTS_KEY = ["weekly-report-recipients"] as const;
const REPORTS_KEY = ["weekly-reports"] as const;

// Histórico recente, não paginação completa -- ~3 meses de cadência semanal
// (supabase/migrations/20260711100000_fase4_prb_weekly_digest_schema.sql
// gera no máximo 1 relatório por tenant/semana).
const RECENT_REPORTS_LIMIT = 12;

// ─── Queries ─────────────────────────────────────────────────────────────

async function fetchWeeklyReportRecipients(): Promise<WeeklyReportRecipientRow[]> {
  const { data, error } = await supabase
    .from("weekly_report_recipients")
    .select("id, tenant_id, channel, address, name, active")
    .order("name", { ascending: true });
  if (error) throw error;
  return (data ?? []) as unknown as WeeklyReportRecipientRow[];
}

/** SELECT liberado a qualquer authenticated do tenant (RLS); CRUD fica atrás de is_admin(). */
export function useWeeklyReportRecipients() {
  return useQuery({
    queryKey: RECIPIENTS_KEY,
    queryFn: fetchWeeklyReportRecipients,
  });
}

async function fetchWeeklyReports(): Promise<WeeklyReportRow[]> {
  const { data, error } = await supabase
    .from("weekly_reports")
    .select(
      "id, tenant_id, period_start, period_end, status, created_at, weekly_report_deliveries(id, report_id, recipient_id, channel, address, status, attempt_count, updated_at)",
    )
    .order("period_start", { ascending: false })
    .limit(RECENT_REPORTS_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as WeeklyReportRow[];
}

/**
 * Histórico só-leitura: weekly_reports/weekly_report_deliveries não têm
 * policy de insert/update/delete para authenticated -- só o digest-generator
 * (service_role) escreve. Nunca expor mutation para estas tabelas aqui.
 */
export function useWeeklyReports() {
  return useQuery({
    queryKey: REPORTS_KEY,
    queryFn: fetchWeeklyReports,
  });
}

function useInvalidateRecipients() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: RECIPIENTS_KEY });
}

// ─── Mutations: weekly_report_recipients (CRUD direto -- RLS "admin all"
// já exige private.is_admin() para insert/update/delete, mesmo padrão de
// nurture_sequences; não existe RPC para esta tabela) ──────────────────────

export interface WeeklyReportRecipientFormInput {
  channel: RecipientChannel;
  address: string;
  name: string | null;
  active: boolean;
}

export interface CreateWeeklyReportRecipientInput extends WeeklyReportRecipientFormInput {
  tenantId: string;
}

export function useCreateWeeklyReportRecipient() {
  const invalidate = useInvalidateRecipients();
  return useMutation({
    mutationFn: async (input: CreateWeeklyReportRecipientInput): Promise<void> => {
      const { error } = await supabase.from("weekly_report_recipients").insert({
        tenant_id: input.tenantId,
        channel: input.channel,
        address: input.address,
        name: input.name,
        active: input.active,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export interface UpdateWeeklyReportRecipientInput extends WeeklyReportRecipientFormInput {
  id: string;
}

export function useUpdateWeeklyReportRecipient() {
  const invalidate = useInvalidateRecipients();
  return useMutation({
    mutationFn: async (input: UpdateWeeklyReportRecipientInput): Promise<void> => {
      const { error } = await supabase
        .from("weekly_report_recipients")
        .update({
          channel: input.channel,
          address: input.address,
          name: input.name,
          active: input.active,
        })
        .eq("id", input.id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useDeleteWeeklyReportRecipient() {
  const invalidate = useInvalidateRecipients();
  return useMutation({
    mutationFn: async (id: string): Promise<void> => {
      const { error } = await supabase.from("weekly_report_recipients").delete().eq("id", id);
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}
