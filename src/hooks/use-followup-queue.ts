import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

// ─── Timezone bounds (tz-aware "hoje") ───────────────────────────────────────
//
// LIMITAÇÃO DOCUMENTADA (PRD, riscos/armadilhas #9): o fuso é hardcoded como
// "America/Sao_Paulo" — aceitável para o MVP brasileiro, mas um tenant fora
// do Brasil veria horários errados na fila "hoje". Não é bloqueante, é dívida
// documentada. Portado de clientes/pedro/medflow-v0/app/api/followups/route.ts
// (`todayBoundsIn`/`offsetSuffix`), adaptado de fetch server-side para bounds
// client-side usados em filtros já carregados/memorizados.
export const FOLLOWUP_TZ = "America/Sao_Paulo";

/** Fim do dia "hoje" (23:59:59.999) no fuso `tz`, calculado a partir de `now`. */
export function todayEndIn(tz: string, now: Date): Date {
  const fmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const ymd = fmt.format(now);
  return new Date(`${ymd}T23:59:59.999${offsetSuffix(tz, now)}`);
}

function offsetSuffix(tz: string, ref: Date): string {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "shortOffset",
  });
  const part = dtf.formatToParts(ref).find((p) => p.type === "timeZoneName");
  const raw = part?.value ?? "GMT-03"; // fallback seguro para São Paulo
  const match = raw.match(/GMT([+-])(\d{1,2})(?::?(\d{2}))?/);
  if (!match) return "-03:00";
  const sign = match[1];
  const hh = match[2].padStart(2, "0");
  const mm = (match[3] ?? "00").padStart(2, "0");
  return `${sign}${hh}:${mm}`;
}

// ─── Tipos ────────────────────────────────────────────────────────────────

export type FollowupStatus = "pending" | "completed" | "cancelled";
export type FollowupSource = "manual" | "ai_suggested";

export interface FollowupRow {
  id: string;
  tenant_id: string;
  deal_id: string | null;
  contact_id: string;
  scheduled_at: string;
  description: string | null;
  status: FollowupStatus;
  ai_suggested: boolean;
  source: FollowupSource;
  created_at: string;
  contact: { id: string; name: string } | null;
  deal: { id: string; title: string } | null;
}

const ROW_LIMIT = 500;

async function fetchPendingFollowups(): Promise<FollowupRow[]> {
  const { data, error } = await supabase
    .from("deal_followups")
    .select(
      "id, tenant_id, deal_id, contact_id, scheduled_at, description, status, ai_suggested, source, created_at, contact:contacts!contact_id(id, name), deal:deals!deal_id(id, title)",
    )
    .eq("status", "pending")
    .order("scheduled_at", { ascending: true })
    .limit(ROW_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as FollowupRow[];
}

/**
 * Fila de follow-up/recontato: um único fetch de pendentes, particionado em
 * três baldes MUTUAMENTE EXCLUSIVOS (nunca overlap):
 *   - atrasados: scheduled_at < now()               (critério de aceite exato do PRD)
 *   - hoje:      now() <= scheduled_at <= fim do dia de hoje (tz-aware)
 *   - proximos:  fim de hoje < scheduled_at <= now() + daysAhead dias
 * Um item às 8h de hoje quando já são 15h cai em "hoje", nunca em "atrasados"
 * — o corte é sempre `now()` vs. o fim do dia local, não os dois inícios de
 * dia se sobrepondo.
 */
export function useFollowupQueue(daysAhead = 7) {
  const query = useQuery({
    queryKey: ["followups", "pending"],
    queryFn: fetchPendingFollowups,
  });

  const buckets = useMemo(() => {
    const rows = query.data ?? [];
    const now = new Date();
    const todayEnd = todayEndIn(FOLLOWUP_TZ, now);
    const horizon = new Date(now.getTime() + daysAhead * 24 * 60 * 60 * 1000);

    const atrasados: FollowupRow[] = [];
    const hoje: FollowupRow[] = [];
    const proximos: FollowupRow[] = [];

    for (const row of rows) {
      const scheduled = new Date(row.scheduled_at);
      if (scheduled < now) {
        atrasados.push(row);
      } else if (scheduled <= todayEnd) {
        hoje.push(row);
      } else if (scheduled <= horizon) {
        proximos.push(row);
      }
    }
    return { atrasados, hoje, proximos };
  }, [query.data, daysAhead]);

  return { ...query, ...buckets };
}

/**
 * IDs de contato com pelo menos um follow-up pendente (união dos três baldes
 * de `useFollowupQueue` — `atrasados`/`hoje`/`proximos`). Set compartilhado
 * usado pra deduplicar os painéis Risco/Oportunidades da Visão Geral (nenhum
 * deles deve sugerir "Aplicar" um novo follow-up pra quem já tem um agendado):
 * `useColdDeals`/`coldConversations` (painel Risco) e
 * `useHotLeadsWithoutFollowup` (painel Oportunidades).
 */
export function usePendingFollowupContactIds(): Set<string> {
  const { atrasados, hoje, proximos } = useFollowupQueue();
  return useMemo(() => {
    const ids = new Set<string>();
    for (const f of [...atrasados, ...hoje, ...proximos]) ids.add(f.contact_id);
    return ids;
  }, [atrasados, hoje, proximos]);
}

// ─── Mutations ──────────────────────────────────────────────────────────────

export interface CreateFollowupInput {
  tenantId: string;
  contactId: string;
  dealId?: string | null;
  scheduledAt: string;
  description?: string | null;
  createdBy: string;
  source: FollowupSource;
  aiSuggested: boolean;
}

/**
 * Cria um follow-up. Parametrizado por `source`/`aiSuggested` para servir os
 * dois caminhos exigidos pelo PRD (critérios de aceite — "Fila de follow-up"):
 * manual → `source: "manual"`, `aiSuggested: false`; sugestão aceita do banner
 * → `source: "ai_suggested"`, `aiSuggested: true`.
 */
export function useCreateFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateFollowupInput): Promise<void> => {
      const { error } = await supabase.from("deal_followups").insert({
        tenant_id: input.tenantId,
        contact_id: input.contactId,
        deal_id: input.dealId ?? null,
        scheduled_at: input.scheduledAt,
        description: input.description ?? null,
        created_by: input.createdBy,
        status: "pending",
        source: input.source,
        ai_suggested: input.aiSuggested,
      });
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["followups"] });
    },
  });
}

/** Marca um follow-up pendente como concluído (ação mínima da fila — sem UI de gestão de status completa). */
export function useCompleteFollowup() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, completedBy }: { id: string; completedBy: string }): Promise<void> => {
      const { error } = await supabase
        .from("deal_followups")
        .update({
          status: "completed",
          completed_at: new Date().toISOString(),
          completed_by: completedBy,
        })
        .eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["followups"] });
    },
  });
}
