import { supabase } from "@/integrations/supabase/client";

/** Espelho de supabase/functions/_shared/meeting-result.ts. O resultado da
 * reunião é gravado como veio (sem IA) em activities.metadata; só o rascunho
 * de follow-up passa pela IA — e nunca é enviado. */
export interface MeetingResult {
  meetingId: string;
  title: string;
  seller: string | null;
  participants: string[];
  summary: string;
  painPoints: string[];
  objections: string[];
  priorities: string[];
  nextSteps: string[];
}

export interface FollowupDraft {
  subject: string;
  email: string;
  whatsapp: string;
  source: "ai" | "template";
  generatedAt: string;
}

export interface DealMeetingView {
  deal: {
    title: string;
    value: number | null;
    stageName: string | null;
    contactName: string | null;
    contactTitle: string | null;
    companyName: string | null;
  };
  lastMeeting: {
    activityId: string;
    processedAt: string;
    meeting: MeetingResult;
    followupDraft: FollowupDraft | null;
  } | null;
}

interface MeetingMetadata {
  meeting: MeetingResult;
  followup_draft: FollowupDraft | null;
}

/** Negócio + última reunião processada, lidos direto do banco (RLS). */
export async function fetchDealMeeting(dealId: string): Promise<DealMeetingView> {
  const [dealRes, meetingRes] = await Promise.all([
    supabase
      .from("deals")
      .select(
        "title, value, stage:board_stages(name), contact:contacts(name, job_title, company_id)",
      )
      .eq("id", dealId)
      .maybeSingle(),
    supabase
      .from("activities")
      .select("id, created_at, metadata")
      .eq("deal_id", dealId)
      .eq("metadata->>kind", "meeting_result")
      .order("created_at", { ascending: false })
      .limit(1),
  ]);
  if (dealRes.error) throw dealRes.error;
  if (meetingRes.error) throw meetingRes.error;
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

  const row = meetingRes.data[0];
  const meta = row ? (row.metadata as unknown as MeetingMetadata) : null;
  return {
    deal: {
      title: d.title,
      value: d.value === null ? null : Number(d.value),
      stageName: d.stage?.name ?? null,
      contactName: d.contact?.name ?? null,
      contactTitle: d.contact?.job_title ?? null,
      companyName,
    },
    lastMeeting:
      row && meta
        ? {
            activityId: row.id,
            processedAt: row.created_at,
            meeting: meta.meeting,
            followupDraft: meta.followup_draft ?? null,
          }
        : null,
  };
}

/** Gera (ou devolve o já salvo) rascunho de follow-up. Não envia nada. */
export async function generateFollowup(
  dealId: string,
  regenerate: boolean,
): Promise<FollowupDraft> {
  const { data, error } = await supabase.functions.invoke("process-meeting", {
    body: { action: "followup", dealId, regenerate },
  });
  if (error) {
    // Status não-2xx: supabase-js só diz "non-2xx"; a mensagem útil está no corpo.
    const ctx = (error as { context?: Response }).context;
    const body = ctx ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
    throw new Error(body?.error || "Não foi possível gerar o follow-up. Tente novamente.");
  }
  const payload = data as { draft?: FollowupDraft; error?: string } | null;
  if (!payload?.draft) throw new Error(payload?.error || "Resposta inválida ao gerar o follow-up.");
  return payload.draft;
}
