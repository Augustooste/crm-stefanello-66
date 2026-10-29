import { supabase } from "@/integrations/supabase/client";
import type { Json } from "@/integrations/supabase/types";
import { BASE_ASSUMPTIONS, sellersFromText } from "@/lib/business-case";
import type { ProposalMeeting } from "@/lib/proposal-draft";

/** Premissas editáveis da simulação. Números são SEMPRE premissa, nunca fato. */
export interface ProposalAssumptions {
  adminHoursPerDay: number | null;
  workDaysPerMonth: number | null;
  automatableShare: number | null;
  hourlyCost: number | null;
}

export interface ProposalView {
  deal: {
    title: string;
    value: number | null;
    stageName: string | null;
    contactName: string | null;
    contactTitle: string | null;
    companyName: string | null;
    /** Fato lido de contacts.description ("12 vendedores"), ou null. */
    sellers: number | null;
  };
  meeting: ProposalMeeting | null;
  draft: { activityId: string; assumptions: ProposalAssumptions; updatedAt: string } | null;
}

const PROPOSAL_KIND = "proposal_draft";

export async function fetchProposal(dealId: string): Promise<ProposalView> {
  const [dealRes, actsRes] = await Promise.all([
    supabase
      .from("deals")
      .select(
        "title, value, tenant_id, stage:board_stages(name), contact:contacts(name, job_title, description, company_id)",
      )
      .eq("id", dealId)
      .maybeSingle(),
    supabase
      .from("activities")
      .select("id, updated_at, metadata")
      .eq("deal_id", dealId)
      .in("metadata->>kind", ["meeting_result", PROPOSAL_KIND])
      .order("created_at", { ascending: false }),
  ]);
  if (dealRes.error) throw dealRes.error;
  if (actsRes.error) throw actsRes.error;
  if (!dealRes.data) throw new Error("Negócio não encontrado.");
  const d = dealRes.data;

  let companyName: string | null = null;
  if (d.contact?.company_id) {
    const { data, error } = await supabase
      .from("crm_companies")
      .select("name")
      .eq("id", d.contact.company_id)
      .maybeSingle();
    if (error) throw error;
    companyName = data?.name ?? null;
  }

  type Meta = { kind: string; meeting?: ProposalMeeting; assumptions?: ProposalAssumptions };
  const rows = actsRes.data.map((r) => ({ ...r, meta: r.metadata as unknown as Meta }));
  const meetingRow = rows.find((r) => r.meta.kind === "meeting_result");
  const draftRow = rows.find((r) => r.meta.kind === PROPOSAL_KIND);

  return {
    deal: {
      title: d.title,
      value: d.value === null ? null : Number(d.value),
      stageName: d.stage?.name ?? null,
      contactName: d.contact?.name ?? null,
      contactTitle: d.contact?.job_title ?? null,
      companyName,
      sellers: sellersFromText(d.contact?.description),
    },
    meeting: meetingRow?.meta.meeting ?? null,
    draft: draftRow?.meta.assumptions
      ? {
          activityId: draftRow.id,
          assumptions: draftRow.meta.assumptions,
          updatedAt: draftRow.updated_at,
        }
      : null,
  };
}

/**
 * Cria (1ª vez) ou atualiza o rascunho da proposta do negócio. Só grava em
 * activities.metadata — nunca em deals/contacts, nunca move estágio.
 * Tipo `ai_log`: não entra no "Contexto conhecido" do Preparar reunião.
 */
export async function saveProposalAssumptions(
  dealId: string,
  existingActivityId: string | null,
  assumptions: ProposalAssumptions,
): Promise<void> {
  const metadata = { kind: PROPOSAL_KIND, assumptions: { ...assumptions } } satisfies Json;
  if (existingActivityId) {
    const { error } = await supabase
      .from("activities")
      .update({ metadata })
      .eq("id", existingActivityId);
    if (error) throw error;
    return;
  }
  const { data: deal, error: dealErr } = await supabase
    .from("deals")
    .select("tenant_id, contact_id, owner_id")
    .eq("id", dealId)
    .single();
  if (dealErr) throw dealErr;
  // Nasce concluída: rascunho não é pendência na lista de Atividades. É INSERT,
  // então o trigger activity.completed (AFTER UPDATE OF completed_at) não dispara.
  const now = new Date().toISOString();
  const { error } = await supabase.from("activities").insert({
    due_at: now,
    completed_at: now,
    tenant_id: deal.tenant_id,
    deal_id: dealId,
    contact_id: deal.contact_id,
    owner_id: deal.owner_id,
    type: "ai_log",
    title: "Proposta (simulação) — rascunho",
    metadata,
  });
  if (error) throw error;
}

export const DEFAULT_ASSUMPTIONS: ProposalAssumptions = { ...BASE_ASSUMPTIONS };
