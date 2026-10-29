// has-human-responded.ts — sinal autoritativo de handoff humano.
//
// Porta de clientes/pedro/medflow-v0/lib/ai/agent/has-human-responded.ts,
// adaptada ao schema deste projeto: tabela "messages" (não
// "messaging_messages") e coluna única "sender" com valores
// 'contact' | 'agent' | 'ai' (não "direction" + "sender_type"). Humano
// respondeu = existe mensagem com sender='agent' (NÃO 'ai', que é a própria
// Clara/IA).
//
// Usado pelos gates de pausa da IA para decidir se ela pode assumir uma
// conversa pausada: só assume quando NENHUM humano respondeu.
//
// Fail-safe: em erro de query, assume que houve resposta humana (retorna
// `true`) para nunca furar um atendimento humano por causa de uma falha
// transitória de banco — mesma política que motivou o incidente 2026-06-17
// no medflow-v0 (atendente respondendo pelo WhatsApp com gaps naturais
// >30min; um takeover por inatividade furou o atendimento humano ativo).
// Neste projeto o threshold de takeover (`takeoverMinutes`, ver
// takeover-gate.ts) está configurado em 30min (constante em
// ai-respond/index.ts) — igual ao gap real do incidente, não menor. Por
// isso esta função (checagem "humano já respondeu" independente de
// inatividade) é a proteção que efetivamente evita repetir o furo.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

/**
 * Verifica se algum humano (atendente) já respondeu nesta conversa.
 *
 * @param supabase client Supabase já inicializado (service_role nas edge functions)
 * @param conversationId id da conversa a verificar
 * @returns true se já houve resposta humana (sender='agent') OU se a query falhou (fail-closed)
 */
export async function hasHumanResponded(
  supabase: SupabaseClient,
  conversationId: string,
  /**
   * Corte temporal: só contam respostas humanas POSTERIORES a este instante
   * (conversations.ai_resumed_at). Sem ele, uma única mensagem de atendente
   * bloqueava a IA para sempre — mesmo depois de o admin reativar a IA
   * explicitamente no inbox, que é o único caminho de retomada previsto.
   */
  resumedAt?: string | null,
): Promise<boolean> {
  let query = supabase
    .from("messages")
    .select("id")
    .eq("conversation_id", conversationId)
    .eq("sender", "agent");
  if (resumedAt) query = query.gt("created_at", resumedAt);
  const { data, error } = await query
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn(
      "[AIAgent] hasHumanResponded: query falhou, assumindo handoff humano (fail-safe):",
      error.message,
    );
    return true;
  }

  return data !== null;
}
