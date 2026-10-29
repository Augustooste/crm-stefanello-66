import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";
import { isDealRotting } from "@/lib/deal-health";
import { usePendingFollowupContactIds } from "@/hooks/use-followup-queue";

const LIST_LIMIT = 20;

export interface ColdDealRow {
  id: string;
  title: string;
  value: number | null;
  stage_id: string;
  contact_id: string | null;
  stage_entered_at: string;
  contact: { id: string; name: string } | null;
}

async function fetchOpenDeals(): Promise<ColdDealRow[]> {
  const { data, error } = await supabase
    .from("deals")
    .select(
      "id, title, value, stage_id, contact_id, stage_entered_at, contact:contacts!contact_id(id, name)",
    )
    .eq("status", "open")
    .order("stage_entered_at", { ascending: true })
    .limit(LIST_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as ColdDealRow[];
}

/**
 * Deals "frios": sem mudança de estágio há mais de 10 dias (`isDealRotting`,
 * mesmo threshold já convencionado no pipeline) E cujo contato ainda não tem
 * follow-up pendente — mesma dedup de `useHotLeadsWithoutFollowup`, via
 * `usePendingFollowupContactIds()`, pra não sugerir "Aplicar" de novo pra
 * quem já tem um recontato agendado. Deals sem `contact_id` (sem contato
 * vinculado) nunca são excluídos por esta checagem — não há follow-up
 * possível pra eles. Filtro client-side sobre os 20 deals abertos com
 * estágio mais antigo — sem paginação real (aceitável pro volume atual de um
 * CRM SMB; revisitar se algum tenant crescer muito).
 */
export function useColdDeals(tenantId: string | null) {
  const query = useQuery({
    queryKey: ["inbox-cold-deals", tenantId],
    enabled: !!tenantId,
    queryFn: fetchOpenDeals,
  });
  const pendingContactIds = usePendingFollowupContactIds();
  const coldDeals = useMemo(
    () =>
      (query.data ?? []).filter(
        (d) =>
          isDealRotting(d.stage_entered_at) &&
          !(d.contact_id && pendingContactIds.has(d.contact_id)),
      ),
    [query.data, pendingContactIds],
  );
  return { ...query, coldDeals };
}

export interface HotLeadRow {
  contact_id: string;
  verdict: string;
  rationale: string | null;
  created_at: string;
  contact: {
    id: string;
    name: string;
    phone: string | null;
    email: string | null;
    deleted_at: string | null;
  } | null;
}

async function fetchHotVerdicts(): Promise<HotLeadRow[]> {
  const { data, error } = await supabase
    .from("ai_lead_verdicts")
    .select(
      "contact_id, verdict, rationale, created_at, contact:contacts!contact_id(id, name, phone, email, deleted_at)",
    )
    .eq("verdict", "hot")
    .order("created_at", { ascending: false })
    .limit(LIST_LIMIT);
  if (error) throw error;
  return (data ?? []) as unknown as HotLeadRow[];
}

/**
 * Contatos "hot" (`ai_lead_verdicts.verdict = 'hot'`, populado pelo webhook
 * meta-ads-leadgen da Fase 6) sem follow-up pendente. Reusa
 * `usePendingFollowupContactIds` (mesma queryKey `["followups","pending"]` já
 * em cache quando a fila de follow-up estiver montada em outra parte da tela
 * — sem fetch adicional de exclusão) pra montar o Set de contatos já cobertos
 * por um follow-up pendente. `ai_lead_verdicts.contact_id` é `isOneToOne` no
 * schema (1 veredito por contato), então a dedup por `contact_id` é
 * defensiva, não estritamente necessária.
 */
export function useHotLeadsWithoutFollowup(tenantId: string | null) {
  const query = useQuery({
    queryKey: ["inbox-hot-leads", tenantId],
    enabled: !!tenantId,
    queryFn: fetchHotVerdicts,
  });
  const pendingContactIds = usePendingFollowupContactIds();

  const hotLeads = useMemo(() => {
    const seen = new Set<string>();
    const result: HotLeadRow[] = [];
    for (const row of query.data ?? []) {
      if (row.contact?.deleted_at) continue;
      if (pendingContactIds.has(row.contact_id)) continue;
      if (seen.has(row.contact_id)) continue;
      seen.add(row.contact_id);
      result.push(row);
    }
    return result;
  }, [query.data, pendingContactIds]);

  return { ...query, hotLeads };
}
