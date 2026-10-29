import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database, Json } from "@/integrations/supabase/types";

// ─── Tipos ────────────────────────────────────────────────────────────────

export type TemplateScheduleStatus = "pending" | "running" | "completed" | "failed";

// Contrato com o runner (supabase/functions/template-schedule-runner/
// runner.ts::expandAudience) e com public.estimate_campaign_audience: AND
// entre os filtros presentes; nenhum filtro = nenhum contato, nunca "todos".
export interface AudienceFilter {
  tags?: string[];
  stage_id?: string;
  custom_field?: Record<string, string>;
}

export interface CampaignStats {
  total: number;
  pending: number;
  sent: number;
  failed: number;
  suppressed: number;
}

export interface TemplateScheduleRow {
  id: string;
  tenant_id: string;
  template_id: string;
  template_name: string;
  name: string | null;
  channel_id: string | null;
  audience_filter: AudienceFilter;
  scheduled_for: string;
  status: TemplateScheduleStatus;
  stats: CampaignStats;
  created_at: string;
}

const SCHEDULES_KEY = ["template-schedules"] as const;

// name/channel_id e as 2 RPCs vêm de 20260925150000_campanhas_nativas.sql e
// ainda não estão no types.ts gerado pelo Lovable (arquivo intocável). Tipo
// local só para estas chamadas -- mesmo padrão de use-phone-suppressions.ts.
type CampaignFunctions = {
  estimate_campaign_audience: { Args: { p_filter: Json }; Returns: number };
  campaign_execution_stats: {
    Args: { p_schedule_ids: string[] };
    Returns: { schedule_id: string; status: string; total: number }[];
  };
};
type ScheduleTable = Database["public"]["Tables"]["template_schedules"];
type CampaignScheduleTable = Omit<ScheduleTable, "Row" | "Insert"> & {
  Row: ScheduleTable["Row"] & { name: string | null; channel_id: string | null };
  Insert: ScheduleTable["Insert"] & { name?: string | null; channel_id?: string | null };
};
type CampaignDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Functions" | "Tables"> & {
    Tables: Omit<Database["public"]["Tables"], "template_schedules"> & {
      template_schedules: CampaignScheduleTable;
    };
    Functions: Database["public"]["Functions"] & CampaignFunctions;
  };
};
const campaignClient = supabase as unknown as SupabaseClient<CampaignDatabase, "public">;

interface RawScheduleRow {
  id: string;
  tenant_id: string;
  template_id: string;
  name: string | null;
  channel_id: string | null;
  audience_filter: AudienceFilter;
  scheduled_for: string;
  status: string;
  created_at: string;
  template: { name: string } | null;
}

const EMPTY_STATS: CampaignStats = { total: 0, pending: 0, sent: 0, failed: 0, suppressed: 0 };

/**
 * Agrega as linhas (schedule_id, status, total) da RPC em contadores por
 * campanha. `sending` conta como pendente: a execução foi reivindicada mas
 * ainda não terminou. Execução adiada pelo guard de frequência volta a
 * `pending`, então também aparece como pendente.
 */
export function buildCampaignStats(
  rows: { schedule_id: string; status: string; total: number }[],
): Map<string, CampaignStats> {
  const byId = new Map<string, CampaignStats>();
  for (const r of rows) {
    const s = byId.get(r.schedule_id) ?? { ...EMPTY_STATS };
    s.total += r.total;
    if (r.status === "sent") s.sent += r.total;
    else if (r.status === "failed") s.failed += r.total;
    else if (r.status === "skipped_suppressed") s.suppressed += r.total;
    else s.pending += r.total;
    byId.set(r.schedule_id, s);
  }
  return byId;
}

async function fetchTemplateSchedules(): Promise<TemplateScheduleRow[]> {
  const { data, error } = await supabase
    .from("template_schedules")
    .select(
      "id, tenant_id, template_id, name, channel_id, audience_filter, scheduled_for, status, created_at, template:messaging_templates(name)",
    )
    .order("scheduled_for", { ascending: false });
  if (error) throw error;
  const rows = (data ?? []) as unknown as RawScheduleRow[];

  // Contagem agregada no servidor -- contar linhas de execução no client
  // esbarra no max-rows do PostgREST e trunca em silêncio.
  let statsById = new Map<string, CampaignStats>();
  if (rows.length > 0) {
    const { data: stats, error: statsError } = await campaignClient.rpc(
      "campaign_execution_stats",
      {
        p_schedule_ids: rows.map((r) => r.id),
      },
    );
    if (statsError) throw statsError;
    statsById = buildCampaignStats(stats ?? []);
  }

  return rows.map((r) => ({
    id: r.id,
    tenant_id: r.tenant_id,
    template_id: r.template_id,
    template_name: r.template?.name ?? "Modelo removido",
    name: r.name,
    channel_id: r.channel_id,
    audience_filter: r.audience_filter ?? {},
    scheduled_for: r.scheduled_for,
    status: r.status as TemplateScheduleStatus,
    stats: statsById.get(r.id) ?? EMPTY_STATS,
    created_at: r.created_at,
  }));
}

export function useTemplateSchedules() {
  return useQuery({
    queryKey: SCHEDULES_KEY,
    queryFn: fetchTemplateSchedules,
  });
}

function useInvalidateSchedules() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SCHEDULES_KEY });
}

/** true se o filtro tem ao menos um critério que o runner reconhece. */
export function hasAudienceCriteria(filter: AudienceFilter): boolean {
  return (
    (filter.tags?.length ?? 0) > 0 ||
    !!filter.stage_id ||
    Object.keys(filter.custom_field ?? {}).length > 0
  );
}

export function useEstimateAudience(filter: AudienceFilter, enabled: boolean) {
  return useQuery({
    queryKey: ["campaign-audience-estimate", filter],
    enabled: enabled && hasAudienceCriteria(filter),
    queryFn: async () => {
      const { data, error } = await campaignClient.rpc("estimate_campaign_audience", {
        p_filter: filter as Json,
      });
      if (error) throw error;
      return data ?? 0;
    },
  });
}

// ─── Mutations ───────────────────────────────────────────────────────────
//
// template_schedules aceita INSERT/DELETE direto de admin (RLS de
// 20260925150000: admin, template aprovado e canal do mesmo tenant, status
// pending) -- não existe RPC própria para isto.

export interface CreateTemplateScheduleInput {
  tenantId: string;
  templateId: string;
  channelId: string;
  name: string;
  scheduledFor: string; // ISO 8601
  audience: AudienceFilter;
}

export function useCreateTemplateSchedule() {
  const invalidate = useInvalidateSchedules();
  return useMutation({
    mutationFn: async (input: CreateTemplateScheduleInput) => {
      if (!hasAudienceCriteria(input.audience)) {
        throw new Error("Escolha ao menos um critério de público.");
      }
      const { error } = await campaignClient.from("template_schedules").insert({
        tenant_id: input.tenantId,
        template_id: input.templateId,
        channel_id: input.channelId,
        name: input.name,
        audience_filter: input.audience as Json,
        scheduled_for: input.scheduledFor,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useCancelTemplateSchedule() {
  const invalidate = useInvalidateSchedules();
  return useMutation({
    mutationFn: async (scheduleId: string) => {
      // Cancelar = excluir enquanto ainda pendente. Não existe status
      // "cancelled" na tabela e a policy de UPDATE exige status='pending'
      // tanto antes quanto depois (nunca deixa sair do estado pending) --
      // quem reforça "só cancela enquanto pending" é a policy de DELETE, daí
      // cancelamento aqui ser sempre um DELETE, nunca um UPDATE de status.
      const { error, count } = await supabase
        .from("template_schedules")
        .delete({ count: "exact" })
        .eq("id", scheduleId)
        .eq("status", "pending");
      if (error) throw error;
      if (!count) {
        throw new Error("Campanha não pode mais ser cancelada (já começou a rodar)");
      }
    },
    onSuccess: invalidate,
  });
}
