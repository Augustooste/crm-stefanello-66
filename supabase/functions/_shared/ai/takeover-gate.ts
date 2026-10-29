// takeover-gate.ts — gate de AI takeover de conversas assigned.
//
// Porta de clientes/pedro/medflow-v0/lib/ai/agent/takeover-gate.ts, adaptada
// ao schema deste projeto (ver has-human-responded.ts: tabela "messages",
// coluna "sender" com sender='agent' para humano).
//
// Decide se a IA pode assumir uma conversa atribuída a um operador:
//  1. Operador ativo (mensagem/assignment há menos de `takeoverMinutes`) →
//     IA NÃO assume.
//  2. Operador inativo, mas algum HUMANO já respondeu na conversa → IA NÃO
//     assume — "humano respondeu → IA fica fora", independente de
//     inatividade. Evita o mesmo furo de atendimento humano do incidente
//     2026-06-17 do medflow-v0 (takeover por inatividade furando gaps
//     naturais >30min do atendente — este projeto configura
//     `takeoverMinutes`=30 em ai-respond/index.ts, igual ao gap do
//     incidente; ver has-human-responded.ts).
//  3. Operador inativo e NENHUM humano respondeu (ex.: auto-assignment sem
//     resposta) → takeover permitido (missed-lead-recovery).
//
// Proteção "operador recém-atribuído": quando `assignedAt` é passado, um
// operador que acabou de receber a conversa mas ainda não respondeu conta
// como ativo (referenceTime cai no assignment, não em `null`), evitando que
// a IA assuma antes de dar tempo do operador agir. Hoje `assignedAt` é
// sempre `null` no único caller real deste projeto porque o schema ainda
// não persiste o timestamp de assignment da conversa (ver comentário no
// call site para o detalhe) — a proteção existe no código mas fica inerte
// até essa coluna existir; nesse meio tempo, isOperatorActive cai direto no
// fallback de `lastOperatorMessageAt` (ou considera inativo, se não houver
// mensagem alguma do operador ainda).
// Em erro de query (fix isOperatorActive), fail-safe também é conservador:
// assume operador ativo, IA não assume a conversa.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { hasHumanResponded } from "./has-human-responded.ts";

export type TakeoverGateResult =
  | { allowed: false; reason: "operator_active" }
  | { allowed: false; reason: "human_responded" }
  | { allowed: true };

/**
 * Verifica se o operador atribuído enviou mensagem recentemente.
 * Compara o tempo desde a última mensagem do operador (sender='agent') — ou
 * o assignment, se não houver mensagem — contra o limiar de takeover.
 */
export async function isOperatorActive(
  supabase: SupabaseClient,
  conversationId: string,
  assignedAt: string | null,
  takeoverMinutes: number,
  /** Timestamp pré-carregado da última mensagem do operador. Passe para pular a query. */
  lastOperatorMessageAt?: string | null,
  /** Corte de reativação explícita da IA (conversations.ai_resumed_at). */
  resumedAt?: string | null,
): Promise<boolean> {
  let referenceTime: string | null;

  if (lastOperatorMessageAt !== undefined) {
    referenceTime = lastOperatorMessageAt || assignedAt;
  } else {
    let agentQuery = supabase
      .from("messages")
      .select("created_at")
      .eq("conversation_id", conversationId)
      .eq("sender", "agent");
    if (resumedAt) agentQuery = agentQuery.gt("created_at", resumedAt);
    const { data: lastAgentMessage, error } = await agentQuery
      .order("created_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (error) {
      console.warn(
        "[AIAgent] isOperatorActive: query falhou, assumindo operador ativo (fail-safe):",
        error.message,
      );
      return true;
    }

    referenceTime = (lastAgentMessage?.created_at as string | undefined) || assignedAt;
  }

  if (!referenceTime) {
    return false; // Nunca respondeu e não tem assignment → inativo
  }

  const minutesSince = (Date.now() - new Date(referenceTime).getTime()) / 60000;
  return minutesSince < takeoverMinutes;
}

/**
 * Avalia o gate completo. Fail-safe herdado de `hasHumanResponded`: em erro
 * de query, assume que um humano respondeu → IA fica fora (nunca fura
 * atendimento humano por falha transitória de banco).
 */
export async function evaluateTakeoverGate(
  supabase: SupabaseClient,
  conversationId: string,
  assignedAt: string | null,
  takeoverMinutes: number,
  lastOperatorMessageAt?: string | null,
  /**
   * conversations.ai_resumed_at — reativação EXPLÍCITA da IA. Mensagens de
   * atendente anteriores a este instante são ignoradas pelos dois checks
   * abaixo; a IA continua fora assim que um humano responder DE NOVO.
   */
  resumedAt?: string | null,
): Promise<TakeoverGateResult> {
  // Reativação explícita invalida o histórico humano anterior: sem isso, o
  // check "humano já respondeu" é permanente e o botão de reativar a IA no
  // inbox não tinha efeito prático (a próxima mensagem do lead voltava a
  // marcar awaiting_human).
  const cutoff = resumedAt ?? null;
  const operatorActive = await isOperatorActive(
    supabase,
    conversationId,
    assignedAt,
    takeoverMinutes,
    lastOperatorMessageAt,
    cutoff,
  );
  if (operatorActive) {
    return { allowed: false, reason: "operator_active" };
  }

  if (await hasHumanResponded(supabase, conversationId, cutoff)) {
    return { allowed: false, reason: "human_responded" };
  }

  return { allowed: true };
}
