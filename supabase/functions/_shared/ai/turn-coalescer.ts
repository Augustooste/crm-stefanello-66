// turn-coalescer.ts — coalescer de turnos + claim atômico de lock de IA.
//
// Porta de clientes/pedro/medflow-v0/lib/ai/agent/turn-coalescer.ts, adaptada
// ao schema do aceleraflow:
//   - "messaging_messages" -> "messages", direction 'inbound'/'outbound' ->
//     'in'/'out' (check constraint da tabela messages).
//   - "messaging_conversations" -> "conversations", que já tem ai_lock_until
//     (20260707170000_conversations_ai_lock.sql) e ganhou ai_lock_token nesta
//     fase (20260709110000_fase2_ia_profunda_schema.sql) — claimAITurn grava
//     o token pra releaseAITurn saber que é dono do lock antes de liberar
//     (evita liberar lock de uma invocação concorrente que já reclamou depois
//     de um timeout).
//   - wasAlreadyAnswered não usa mais "ai_conversation_log" (não existe aqui,
//     era telemetria de tokens fora de escopo desta lane). Em vez disso
//     consulta a própria "messages": uma resposta da IA (sender='ai',
//     direction='out') recente é o sinal de "já respondido" — mesmo dado,
//     fonte mais simples, sem tabela nova.
//   - Não porta "ai_conversation_log" em si; ai_processing_log (claim por
//     message_id, 20260709100200) já existe e resolve uma camada diferente
//     do problema (dedupe por mensagem, não por conversa) — fora de escopo
//     aqui.
//
// Previne a IA de disparar múltiplas respostas quando o lead manda várias
// mensagens em rajada. Estratégia (burst-aware):
//   1. fetchRecentInbound único no início.
//   2. Solo (1 inbound) -> segue sem sleep.
//   3. Burst (>=2) -> sleep coalesceWindowMs e re-consulta.
//   4. Só a invocação cujo messageId é o mais recente prossegue.
//   5. Dedupe defensivo: resposta da IA recente pra esta conversa.
//
// Segurança multi-processo: use claimAITurn (UPDATE atômico test-and-set em
// conversations.ai_lock_*) ANTES de invocar a IA; libere via releaseAITurn
// no fim. Módulo puro (sem estado de módulo) — coordenação via linhas
// Postgres, não memória de processo.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { limitAiResponseWait, type AiResponseBudget } from "./execution-budget.ts";

export const DEFAULT_COALESCE_WINDOW_MS = 3000;
export const DEFAULT_BURST_LOOKBACK_MS = 5000;
export const DEFAULT_DEDUPE_WINDOW_MS = 30_000;
export const DEFAULT_AI_LOCK_TTL_MS = 30_000;

/**
 * Resultado discriminado: proceed=true nunca acompanha motivo de erro, e
 * proceed=false sempre carrega uma razão — consumo type-safe.
 *
 * not_latest sempre inclui latestMessageId (obrigatório pro caller
 * redirecionar o turno pro id correto). duplicate_answer não carrega id pois
 * a deduplicação não depende de qual mensagem é a mais recente.
 */
export type CoalesceDecision =
  | { proceed: true; reason?: "no_burst" | "no_message_id" }
  | { proceed: false; reason: "not_latest"; latestMessageId: string }
  | { proceed: false; reason: "duplicate_answer" };

interface InboundRow {
  id: string;
  created_at: string;
}

/**
 * Busca mensagens inbound recebidas dentro da janela de lookback. Usado pra
 * decidir se um burst está em andamento.
 */
async function fetchRecentInbound(
  supabase: SupabaseClient,
  conversationId: string,
  lookbackMs: number,
  now: Date,
): Promise<InboundRow[]> {
  const cutoff = new Date(now.getTime() - lookbackMs).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("id, created_at")
    .eq("conversation_id", conversationId)
    .eq("direction", "in")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false });
  if (error) {
    // Sem logger central no projeto: log estruturado p/ futura ingestão.
    console.warn(
      JSON.stringify({
        event: "turn_coalescer_db_error",
        op: "fetchRecentInbound",
        conversationId,
        message: error.message,
      }),
    );
    return [];
  }
  return (data as InboundRow[] | null) ?? [];
}

/**
 * Guarda de idempotência: retorna true quando esta conversa já tem uma
 * mensagem de resposta da IA (sender='ai', direction='out') dentro da janela
 * de dedupe, criada DEPOIS (ou no mesmo instante) da mensagem inbound atual.
 *
 * O guard messageCreatedAt corrige o bug de "turno órfão": sem ele, uma
 * resposta à mensagem A (T=6s) bloquearia a nova mensagem B (T=9s) porque
 * ambas caem na janela de 30s. Com o guard, só pula quando o timestamp da
 * resposta armazenada >= timestamp da mensagem (ou seja, a resposta era
 * genuinamente pra ESTE turno ou um posterior, não um anterior).
 */
export async function wasAlreadyAnswered(
  supabase: SupabaseClient,
  params: {
    conversationId: string;
    dedupeWindowMs?: number;
    now?: Date;
    /** Timestamp ISO da mensagem inbound sendo processada. Quando fornecido,
     *  uma resposta da IA só é considerada duplicata se foi registrada em ou
     *  após este timestamp. */
    messageCreatedAt?: string;
  },
): Promise<boolean> {
  const dedupeWindowMs = params.dedupeWindowMs ?? DEFAULT_DEDUPE_WINDOW_MS;
  const now = params.now ?? new Date();
  const cutoff = new Date(now.getTime() - dedupeWindowMs).toISOString();
  const { data, error } = await supabase
    .from("messages")
    .select("id, created_at")
    .eq("conversation_id", params.conversationId)
    .eq("sender", "ai")
    .eq("direction", "out")
    .gte("created_at", cutoff)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    console.warn(
      JSON.stringify({
        event: "turn_coalescer_db_error",
        op: "wasAlreadyAnswered",
        conversationId: params.conversationId,
        message: error.message,
      }),
    );
    return false; // fail-open: não bloqueia respostas legítimas por hiccup de infra
  }
  if (!data || data.length === 0) return false;
  if (params.messageCreatedAt) {
    const responseAt = new Date(
      (data[0] as { id: string; created_at: string }).created_at,
    ).getTime();
    const messageAt = new Date(params.messageCreatedAt).getTime();
    // Só é duplicata quando a resposta armazenada foi pra este turno ou um
    // posterior. Uma resposta anterior a esta mensagem pertence a um turno prévio.
    return responseAt >= messageAt;
  }
  return true;
}

/**
 * Corrida entre o sleep da janela de coalescing e o cancelamento via
 * AbortSignal — extraído de coalesceTurn pra manter a função principal
 * dentro do limite de 50 linhas do projeto. Se já chegar abortado, nem
 * agenda o sleep.
 */
async function sleepOrAbort(
  ms: number,
  sleep: (ms: number) => Promise<void>,
  signal?: AbortSignal,
): Promise<"timeout" | "aborted"> {
  if (signal?.aborted) return "aborted";
  const sleepPromise = sleep(ms).then(() => "timeout" as const);
  if (!signal) {
    await sleepPromise;
    return "timeout";
  }
  const abortPromise = new Promise<"aborted">((resolve) => {
    signal.addEventListener("abort", () => resolve("aborted"), { once: true });
  });
  return Promise.race([sleepPromise, abortPromise]);
}

interface CoalesceParams {
  conversationId: string;
  messageId: string | null | undefined;
  coalesceWindowMs?: number | null;
  lookbackMs?: number;
  dedupeWindowMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => Date;
  budget?: AiResponseBudget;
  reservedOperationMs?: number;
  /** Opcional: aborta a janela de espera em caso de cancelamento upstream. */
  signal?: AbortSignal;
  /** Timestamp ISO do inbound sendo processado. Passado pra
   *  wasAlreadyAnswered pra que respostas anteriores à mensagem não
   *  bloqueiem o novo turno. */
  messageCreatedAt?: string;
}

/**
 * Pipeline completo de coalescing. Chame uma vez no início do processamento
 * da mensagem inbound.
 *
 *   1. fetchRecentInbound
 *   2. solo -> segue; burst -> sleep + re-fetch
 *   3. checagem de latest-trigger
 *   4. guarda de dedupe
 *
 * Fail-closed em messageId ausente: roda só o dedupe — se já houve resposta
 * recente, bloqueia o retry sem id; senão, libera.
 */
export async function coalesceTurn(
  supabase: SupabaseClient,
  params: CoalesceParams,
): Promise<CoalesceDecision> {
  const sleep = params.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
  const now = params.now ?? (() => new Date());
  const coalesceWindowMs = params.coalesceWindowMs ?? DEFAULT_COALESCE_WINDOW_MS;
  const lookbackMs = params.lookbackMs ?? DEFAULT_BURST_LOOKBACK_MS;

  // Fail-closed pra webhook retry sem messageId: NÃO libera direto — checa dedupe.
  if (!params.messageId) {
    const duplicated = await wasAlreadyAnswered(supabase, {
      conversationId: params.conversationId,
      dedupeWindowMs: params.dedupeWindowMs,
      now: now(),
    });
    return duplicated
      ? { proceed: false, reason: "duplicate_answer" }
      : { proceed: true, reason: "no_message_id" };
  }

  // 1. Fetch inicial (uma vez)
  const initialNow = now();
  const initialInbound = await fetchRecentInbound(
    supabase,
    params.conversationId,
    lookbackMs,
    initialNow,
  );
  const isBurst = initialInbound.length >= 2;

  // 2. Burst -> sleep abortável + re-fetch. Solo -> segue direto pro dedupe.
  let finalInbound = initialInbound;
  if (isBurst) {
    const waitMs = limitAiResponseWait(
      coalesceWindowMs,
      params.budget,
      params.reservedOperationMs ?? 0,
    );
    const result = waitMs > 0
      ? await sleepOrAbort(waitMs, sleep, params.signal)
      : params.signal?.aborted ? "aborted" : "timeout";
    if (result === "aborted") {
      return { proceed: false, reason: "duplicate_answer" };
    }
    // Mantém o início da rajada na consulta: uma janela configurada maior
    // que o lookback não pode apagar os inbounds e liberar o turno antigo.
    finalInbound = await fetchRecentInbound(supabase, params.conversationId, lookbackMs, initialNow);
  }

  // 3. Checagem de latest-trigger (mesmo no fast-path: dois solos podem cruzar)
  const latest = finalInbound[0]?.id ?? null;
  if (latest !== null && latest !== params.messageId) {
    return {
      proceed: false,
      reason: "not_latest",
      latestMessageId: latest,
    };
  }

  // 4. Guarda de dedupe — usa o timestamp da própria mensagem inbound (de
  //    finalInbound ou fallback fornecido pelo caller) pra que respostas de
  //    turnos anteriores não bloqueiem este turno.
  const messageCreatedAt =
    finalInbound.find((m) => m.id === params.messageId)?.created_at ?? params.messageCreatedAt;
  const duplicated = await wasAlreadyAnswered(supabase, {
    conversationId: params.conversationId,
    dedupeWindowMs: params.dedupeWindowMs,
    now: now(),
    messageCreatedAt,
  });
  if (duplicated) {
    return { proceed: false, reason: "duplicate_answer" };
  }

  return isBurst ? { proceed: true } : { proceed: true, reason: "no_burst" };
}

// -----------------------------------------------------------------------------
// Claim atômico de IA — segurança multi-processo
// -----------------------------------------------------------------------------

export type ClaimResult = { claimed: true; token: string } | { claimed: false; token: null };

interface ClaimParams {
  conversationId: string;
  lockTtlMs?: number;
  now?: () => Date;
  /** Injetável só pra testes determinísticos do token gerado. */
  generateToken?: () => string;
}

/**
 * Claim atômico em "conversations". Equivalente SQL:
 *
 *   UPDATE conversations
 *   SET ai_lock_token = gen_random_uuid(),
 *       ai_lock_until = now() + interval '30 seconds'
 *   WHERE id = $1
 *     AND (ai_lock_until IS NULL OR ai_lock_until < now())
 *   RETURNING ai_lock_token;
 *
 * Só um writer ganha quando múltiplos processos disputam.
 */
export async function claimAITurn(
  supabase: SupabaseClient,
  params: ClaimParams,
): Promise<ClaimResult> {
  const lockTtlMs = params.lockTtlMs ?? DEFAULT_AI_LOCK_TTL_MS;
  const now = (params.now ?? (() => new Date()))();
  const nowIso = now.toISOString();
  const token = (params.generateToken ?? (() => crypto.randomUUID()))();
  const lockUntilIso = new Date(now.getTime() + lockTtlMs).toISOString();

  const { data, error } = await supabase
    .from("conversations")
    .update({ ai_lock_token: token, ai_lock_until: lockUntilIso })
    .eq("id", params.conversationId)
    .or(`ai_lock_until.is.null,ai_lock_until.lt.${nowIso}`)
    .select("ai_lock_token")
    .single();

  // PGRST116: "Results contain 0 rows" — claim perdido pra outro processo.
  if (error) {
    if (error.code === "PGRST116") {
      return { claimed: false, token: null };
    }
    console.warn(
      JSON.stringify({
        event: "turn_coalescer_db_error",
        op: "claimAITurn",
        conversationId: params.conversationId,
        message: error.message,
      }),
    );
    return { claimed: false, token: null };
  }
  if (!data) {
    return { claimed: false, token: null };
  }
  return { claimed: true, token };
}

/**
 * Libera o claim. Idempotente — passe o token recebido em claimAITurn pra
 * evitar liberar lock de outro processo (defesa em profundidade).
 */
export async function releaseAITurn(
  supabase: SupabaseClient,
  params: { conversationId: string; token?: string | null },
): Promise<void> {
  let query = supabase
    .from("conversations")
    .update({ ai_lock_token: null, ai_lock_until: null })
    .eq("id", params.conversationId);
  if (params.token) {
    query = query.eq("ai_lock_token", params.token);
  }
  const { error } = await query;
  if (error) {
    console.warn(
      JSON.stringify({
        event: "turn_coalescer_db_error",
        op: "releaseAITurn",
        conversationId: params.conversationId,
        message: error.message,
      }),
    );
  }
}
