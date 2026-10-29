import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

// voice_calls vem de 20260925230500_voice_calls_foundation.sql e ainda não está
// no types.ts gerado pelo Lovable (arquivo intocável). Tipo local só para esta
// tabela -- mesmo padrão de use-phone-suppressions.ts.
export interface VoiceCallRow {
  id: string;
  contact_id: string;
  deal_id: string | null;
  status: string;
  phone: string;
  objective: string;
  is_simulation: boolean;
  created_at: string;
  answered_at: string | null;
  ended_at: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  transcript: string | null;
  summary: string | null;
  error_message: string | null;
}

type VoiceDatabase = Omit<Database, "public"> & {
  public: Omit<Database["public"], "Tables"> & {
    Tables: Database["public"]["Tables"] & {
      voice_calls: { Row: VoiceCallRow; Insert: never; Update: never; Relationships: [] };
    };
  };
};
const voiceClient = supabase as unknown as SupabaseClient<VoiceDatabase, "public">;

const COLUMNS =
  "id, contact_id, deal_id, status, phone, objective, is_simulation, created_at, answered_at, ended_at, duration_seconds, outcome, transcript, summary, error_message";

export const TERMINAL_CALL_STATUSES = new Set([
  "completed",
  "failed",
  "busy",
  "no_answer",
  "cancelled",
]);

const POLL_MS = 3000;

/** Ligações do contato para a timeline. Recarrega só enquanto houver ligação ativa. */
export function useContactVoiceCalls(contactId: string) {
  return useQuery({
    queryKey: ["voice-calls", "contact", contactId],
    queryFn: async () => {
      const { data, error } = await voiceClient
        .from("voice_calls")
        .select(COLUMNS)
        .eq("contact_id", contactId)
        .order("created_at", { ascending: false })
        .limit(50);
      if (error) throw error;
      return (data ?? []) as VoiceCallRow[];
    },
    refetchInterval: (query) =>
      (query.state.data ?? []).some((c) => !TERMINAL_CALL_STATUSES.has(c.status)) ? POLL_MS : false,
  });
}

export function useVoiceCall(callId: string | null) {
  return useQuery({
    queryKey: ["voice-calls", "one", callId],
    enabled: !!callId,
    queryFn: async () => {
      const { data, error } = await voiceClient
        .from("voice_calls")
        .select(COLUMNS)
        .eq("id", callId!)
        .maybeSingle();
      if (error) throw error;
      return (data ?? null) as VoiceCallRow | null;
    },
    refetchInterval: (query) => {
      const row = query.state.data;
      return row && !TERMINAL_CALL_STATUSES.has(row.status) ? POLL_MS : false;
    },
  });
}

/** Mensagem do corpo {error} de um status não-2xx do functions.invoke. */
async function invokeErrorMessage(error: unknown): Promise<string> {
  const ctx = (error as { context?: { json?: () => Promise<unknown> } }).context;
  if (ctx?.json) {
    const body = (await ctx.json().catch(() => null)) as { error?: unknown } | null;
    if (body && typeof body.error === "string") return body.error;
  }
  return error instanceof Error ? error.message : "Erro ao falar com o serviço de ligações.";
}

export interface StartVoiceCallInput {
  contactId: string;
  dealId: string | null;
  objective: string;
  idempotencyKey: string;
}

export function useStartVoiceCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: StartVoiceCallInput) => {
      const { data, error } = await supabase.functions.invoke("voice-calls", {
        body: {
          action: "create",
          contact_id: input.contactId,
          deal_id: input.dealId,
          objective: input.objective,
          idempotency_key: input.idempotencyKey,
        },
      });
      if (error) throw new Error(await invokeErrorMessage(error));
      return data as { call_id: string; status: string };
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["voice-calls"] }),
  });
}

export function useCancelVoiceCall() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (callId: string) => {
      const { error } = await supabase.functions.invoke("voice-calls", {
        body: { action: "cancel", call_id: callId },
      });
      if (error) throw new Error(await invokeErrorMessage(error));
    },
    onSettled: () => qc.invalidateQueries({ queryKey: ["voice-calls"] }),
  });
}

/** O serviço de voz está configurado neste ambiente? (edge function voice-calls, action status) */
export function useVoiceServiceStatus() {
  return useQuery({
    queryKey: ["voice-calls", "service-status"],
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const { data, error } = await supabase.functions.invoke("voice-calls", {
        body: { action: "status" },
      });
      if (error) throw new Error(await invokeErrorMessage(error));
      return data as { configured: boolean; simulation: boolean };
    },
  });
}
