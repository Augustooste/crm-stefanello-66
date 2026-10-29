import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { SupabaseClient } from "@supabase/supabase-js";

import { supabase } from "@/integrations/supabase/client";
import type { Database } from "@/integrations/supabase/types";

// ─── Tipos ────────────────────────────────────────────────────────────────

export type PhoneSuppressionSource = "keyword" | "manual" | "api";

export interface PhoneSuppressionRow {
  id: string;
  phone: string;
  reason: string;
  source: PhoneSuppressionSource;
  suppressed_at: string;
  reactivated_at: string | null;
}

const SUPPRESSIONS_KEY = ["phone-suppressions"] as const;

function toSource(value: string): PhoneSuppressionSource {
  return value === "manual" || value === "api" ? value : "keyword";
}

// As RPCs add_manual_phone_suppression/reactivate_phone_suppression (Fase 4
// PR-B, user story H) ainda não estão em types.ts: o Backend phase desta
// mesma PR cria as funções direto na DB e o agente de sincronização
// regenera types.ts depois -- não é este arquivo que deve tocar nele (ver
// instrução da tarefa). Este tipo local só aumenta Functions para estas
// duas chamadas, sem editar types.ts e sem any/@ts-ignore/@ts-expect-error.
type PhoneSuppressionFunctions = {
  add_manual_phone_suppression: {
    Args: { p_phone: string; p_reason: string };
    Returns: Database["public"]["Tables"]["messaging_phone_suppressions"]["Row"];
  };
  reactivate_phone_suppression: {
    Args: { p_suppression_id: string };
    Returns: Database["public"]["Tables"]["messaging_phone_suppressions"]["Row"];
  };
};

type SupabaseWithSuppressionRpcs = SupabaseClient<
  Database & {
    public: Database["public"] & {
      Functions: Database["public"]["Functions"] & PhoneSuppressionFunctions;
    };
  }
>;

const rpcClient = supabase as unknown as SupabaseWithSuppressionRpcs;

// ─── Query ───────────────────────────────────────────────────────────────

type SuppressionSelectRow = Omit<PhoneSuppressionRow, "source"> & { source: string };

async function fetchPhoneSuppressions(): Promise<PhoneSuppressionRow[]> {
  const { data, error } = await supabase
    .from("messaging_phone_suppressions")
    .select("id, phone, reason, source, suppressed_at, reactivated_at")
    .order("suppressed_at", { ascending: false });
  if (error) throw error;
  return ((data ?? []) as unknown as SuppressionSelectRow[]).map((row) => ({
    ...row,
    source: toSource(row.source),
  }));
}

/** Listagem tenant-scoped, já coberta pela RLS de messaging_phone_suppressions (select own tenant). */
export function usePhoneSuppressions() {
  return useQuery({
    queryKey: SUPPRESSIONS_KEY,
    queryFn: fetchPhoneSuppressions,
  });
}

function useInvalidateSuppressions() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: SUPPRESSIONS_KEY });
}

// ─── Mutations (sempre via RPC SECURITY DEFINER -- não existe policy de
// insert/update direto nesta tabela, de propósito: ver migration
// 20260710140200_fase4_suppressions_schema.sql) ────────────────────────────

export interface AddManualPhoneSuppressionInput {
  phone: string;
  reason: string;
}

export function useAddManualPhoneSuppression() {
  const invalidate = useInvalidateSuppressions();
  return useMutation({
    mutationFn: async (input: AddManualPhoneSuppressionInput): Promise<void> => {
      const { error } = await rpcClient.rpc("add_manual_phone_suppression", {
        p_phone: input.phone,
        p_reason: input.reason,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}

export function useReactivatePhoneSuppression() {
  const invalidate = useInvalidateSuppressions();
  return useMutation({
    mutationFn: async (suppressionId: string): Promise<void> => {
      const { error } = await rpcClient.rpc("reactivate_phone_suppression", {
        p_suppression_id: suppressionId,
      });
      if (error) throw error;
    },
    onSuccess: invalidate,
  });
}
