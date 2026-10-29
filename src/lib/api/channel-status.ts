// Histórico de estado de um canal + progresso ao vivo de reconexão/teste.
//
// A edge function `integration-connect` grava uma linha em
// public.channel_status_events por passo (com `run_id` comum). Assinamos
// Realtime nessa tabela para o operador ver o progresso enquanto acontece,
// em vez de esperar a resposta final da chamada.
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export type ChannelStatusEventRow = {
  id: string;
  channel_id: string;
  status: string;
  reason_code: string;
  reason_detail: string | null;
  source: "webhook" | "reconcile" | "reconnect" | "test" | "connect";
  step: string | null;
  step_state: "running" | "ok" | "failed" | "skipped" | null;
  run_id: string | null;
  created_at: string;
};

const HISTORY_LIMIT = 30;

/**
 * Últimos eventos de estado do canal (mais recente primeiro), com atualização
 * em tempo real. `enabled=false` quando não há canal (modal fechado, provedor
 * sem canal criado).
 */
export function useChannelStatusEvents(channelId: string | null | undefined, enabled = true) {
  const qc = useQueryClient();
  const key = useMemo(() => ["channel-status-events", channelId] as const, [channelId]);

  const query = useQuery<ChannelStatusEventRow[]>({
    queryKey: key,
    enabled: Boolean(channelId) && enabled,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("channel_status_events")
        .select(
          "id, channel_id, status, reason_code, reason_detail, source, step, step_state, run_id, created_at",
        )
        .eq("channel_id", channelId!)
        .order("created_at", { ascending: false })
        .limit(HISTORY_LIMIT);
      if (error) throw error;
      return (data ?? []) as ChannelStatusEventRow[];
    },
  });

  useEffect(() => {
    if (!channelId || !enabled) return;
    // Ambientes de teste (e o SSR) podem expor um cliente sem Realtime.
    if (typeof supabase.channel !== "function") return;
    // Nome único por assinatura: o realtime-js devolve o canal existente para
    // nomes iguais, e reabrir o diagnóstico antes do removeChannel assíncrono
    // concluir faria `.on()` lançar sobre um canal já inscrito.
    const channel = supabase
      .channel(`channel-status-${channelId}:${Math.random().toString(36).slice(2)}`)
      .on(
        "postgres_changes",
        {
          event: "INSERT",
          schema: "public",
          table: "channel_status_events",
          filter: `channel_id=eq.${channelId}`,
        },
        (payload) => {
          const row = payload.new as ChannelStatusEventRow;
          qc.setQueryData<ChannelStatusEventRow[]>(key, (prev) =>
            [row, ...(prev ?? []).filter((e) => e.id !== row.id)].slice(0, HISTORY_LIMIT),
          );
        },
      )
      .subscribe();
    return () => {
      supabase.removeChannel(channel);
    };
  }, [channelId, enabled, qc, key]);

  return query;
}

/** Eventos de uma execução específica (reconnect/test), em ordem cronológica. */
export function eventsForRun(
  events: ChannelStatusEventRow[] | undefined,
  runId: string | null,
): ChannelStatusEventRow[] {
  if (!runId) return [];
  return (events ?? [])
    .filter((e) => e.run_id === runId)
    .slice()
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}
