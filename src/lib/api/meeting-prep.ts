import { supabase } from "@/integrations/supabase/client";

/** Espelho do retorno de supabase/functions/prepare-meeting. `facts` vem do
 * banco (determinístico); `generated` vem da IA já filtrada. A UI renderiza
 * fatos SÓ a partir de `facts` — nunca de texto da IA. */
export interface MeetingFacts {
  company: { name: string; industry: string | null; city: string | null } | null;
  contact: {
    name: string;
    title: string | null;
    email: string | null;
    phone: string | null;
  } | null;
  deal: {
    title: string;
    value: number | null;
    valueLabel: string;
    stageName: string | null;
    ownerName: string | null;
  };
  meeting: { title: string; dateLabel: string; timeLabel: string; dueAt: string } | null;
  objective: string | null;
  knownContext: string[];
  recordedHypotheses: string[];
  nextStep: { title: string; dateLabel: string | null } | null;
  attentionPoints: string[];
}

export interface GeneratedBriefing {
  summary: string | null;
  hypotheses: Array<{ text: string; reason: string }>;
  suggestedQuestions: string[];
  attentionPoints: string[];
}

export interface MeetingPrep {
  facts: MeetingFacts;
  generated: GeneratedBriefing | null;
  aiError: string | null;
}

export async function prepareMeeting(dealId: string): Promise<MeetingPrep> {
  const { data, error } = await supabase.functions.invoke("prepare-meeting", { body: { dealId } });
  if (error) {
    // Status não-2xx: supabase-js só diz "non-2xx"; a mensagem útil está no corpo.
    const ctx = (error as { context?: Response }).context;
    const body = ctx ? ((await ctx.json().catch(() => null)) as { error?: string } | null) : null;
    throw new Error(body?.error || "Não foi possível preparar a reunião. Tente novamente.");
  }
  const payload = data as (MeetingPrep & { error?: string }) | null;
  if (payload?.error) throw new Error(payload.error);
  if (!payload?.facts) throw new Error("Resposta inválida ao preparar a reunião.");
  return {
    facts: payload.facts,
    generated: payload.generated ?? null,
    aiError: payload.aiError ?? null,
  };
}
