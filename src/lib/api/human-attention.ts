import { useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";

import { supabase } from "@/integrations/supabase/client";

/**
 * Conta as conversas que precisam de atenção humana no tenant atual
 * (`awaiting_human = true`) e mantém o número vivo via realtime.
 *
 * O sinal `awaiting_human` é levantado pela edge function `ai-respond` tanto
 * no handoff normal (draft / IA declara que não sabe) quanto quando a IA
 * FALHA (geração/envio) — logo este contador cobre "IA passou pra humano" e
 * "IA morreu, humano assume" com um único flag.
 */
export function useHumanAttentionCount(tenantId: string | null): number {
  const queryClient = useQueryClient();
  const queryKey = ["human-attention-count", tenantId] as const;

  const query = useQuery({
    queryKey,
    enabled: !!tenantId,
    queryFn: async (): Promise<number> => {
      // RLS ("conversations tenant all") já escopa a contagem ao tenant do
      // usuário; head:true retorna só o count, sem trazer linhas.
      const { count, error } = await supabase
        .from("conversations")
        .select("id", { count: "exact", head: true })
        .eq("awaiting_human", true)
        // Conversa fechada não é urgência ativa, mesmo se o flag ficou ligado.
        .neq("status", "closed")
        // Conversa excluída (soft-delete) não conta como atenção pendente.
        .is("deleted_at", null);
      if (error) throw error;
      return count ?? 0;
    },
  });

  useEffect(() => {
    if (!tenantId) return;
    // ID único por EXECUÇÃO do efeito (não por render/montagem) — o efeito
    // pode rodar mais de uma vez para a MESMA instância do componente antes
    // do cleanup anterior (removeChannel, assíncrono: aguarda round-trip de
    // unsubscribe no servidor) terminar. Isso acontece mesmo sem StrictMode
    // — ex.: TanStack Router reexecuta o efeito da rota logo após a troca
    // pending→resolvido em `/app`. Um ID fixo por montagem (ex.: via useRef)
    // fica igual nas duas execuções e faz `supabase.channel()` reaproveitar
    // o canal antigo (ainda não removido) — que já chamou `.subscribe()` —
    // e o `.on()` da segunda execução lança "cannot add postgres_changes
    // callbacks ... after subscribe()". Gerar o ID aqui dentro garante um
    // tópico novo a cada execução, então nunca há canal para reaproveitar.
    const channelId =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : Math.random().toString(36).slice(2);
    const channel = supabase
      .channel(`human-attention:${tenantId}:${channelId}`)
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "conversations",
          filter: `tenant_id=eq.${tenantId}`,
        },
        () => {
          void queryClient.invalidateQueries({ queryKey: ["human-attention-count", tenantId] });
        },
      )
      .subscribe((status) => {
        // Sem este callback a falha do realtime (WS derrubado, realtime off,
        // timeout) é muda e o contador de atenção humana congela — atendente
        // deixa de ver conversas esperando. Loga e refaz a contagem.
        if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          console.error(`[human-attention] realtime ${status} (tenant ${tenantId})`);
          void queryClient.invalidateQueries({ queryKey: ["human-attention-count", tenantId] });
        }
      });
    return () => {
      void supabase.removeChannel(channel);
    };
  }, [tenantId, queryClient]);

  return query.data ?? 0;
}
