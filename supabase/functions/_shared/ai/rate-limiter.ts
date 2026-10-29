// rate-limiter.ts — wrapper client fino para o rate limiter distribuído
// (RPC public.check_and_record_rate_limit, migration
// 20260709110000_fase2_ia_profunda_schema.sql).
//
// Porta da INTERFACE de
// clientes/pedro/medflow-v0/lib/ai/agent/rate-limiter.ts
// (checkRateLimit(id, maxCalls?, windowMs?) → { allowed; retryAfterMs? }),
// mas a IMPLEMENTAÇÃO muda: lá o wrapper delega para lib/rate-limit.ts
// (helper Next.js com seu próprio client); aqui a RPC já É a camada atômica
// (INSERT + COUNT numa única function SECURITY DEFINER), então chamamos
// supabase.rpc(...) direto — não existe (nem deveria existir) um
// @/lib/rate-limit intermediário em Edge Functions Deno.
//
// Política de falha da RPC: FAIL-CLOSED (nega a chamada de IA se o RPC
// falhar). Rate limiter aqui é controle de CUSTO (chamadas a provedores de
// IA cobradas por token), não só anti-abuso — o mesmo raciocínio de
// segurança que já faz auth/lock deste projeto serem fail-closed
// (ver ai-respond/index.ts:3 "Auth: fail-closed"). Se o banco estiver
// instável, a pior consequência de negar é um retry manual do agente
// humano; a pior consequência de permitir é gasto de IA sem controle
// justamente na janela em que a infra já está degradada. Loga o erro antes
// de negar para o caller decidir se quer alertar.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

const DEFAULT_MAX_CALLS = 5;
const DEFAULT_WINDOW_MS = 60 * 1000; // 1 minuto

/** Prefixo de namespace da key, evita colisão com outros usos futuros da tabela rate_limits. */
const KEY_PREFIX = "ai-agent";

export interface RateLimitResult {
  allowed: boolean;
  retryAfterMs?: number;
  /**
   * true quando `allowed:false` veio de a RPC em si ter falhado (banco fora
   * do ar, erro de rede) e não de o limite ter sido legitimamente atingido —
   * distinção que o caller precisa para não tratar uma falha de infra como
   * um rate-limit normal (ver ai-respond/index.ts, seção "Rate limit").
   * Ausente/undefined no caminho feliz (allowed=true ou allowed=false
   * legítimo vindo da RPC).
   */
  rpcFailed?: boolean;
}

interface CheckAndRecordRpcResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Checa (e registra atomicamente) uma chamada de IA para `conversationId`,
 * via a RPC `check_and_record_rate_limit`. RPC faz INSERT + COUNT na mesma
 * transação — sem TOCTOU entre invocações concorrentes de múltiplas
 * réplicas da edge function.
 *
 * @param supabaseAdminClient client Supabase (service_role — a RPC só concede EXECUTE a service_role)
 * @param conversationId id da conversa; vira `ai-agent:<id>` na tabela rate_limits
 * @param maxCalls limite de chamadas na janela (default 5)
 * @param windowMs tamanho da janela em ms (default 60_000 = 1 minuto)
 * @returns `{ allowed: true }` se ok; `{ allowed: false, retryAfterMs }` se estourou o limite ou se a RPC falhou (fail-closed)
 */
export async function checkRateLimit(
  supabaseAdminClient: SupabaseClient,
  conversationId: string,
  maxCalls = DEFAULT_MAX_CALLS,
  windowMs = DEFAULT_WINDOW_MS,
): Promise<RateLimitResult> {
  const windowSeconds = Math.ceil(windowMs / 1000);
  const key = `${KEY_PREFIX}:${conversationId}`;

  const { data, error } = await supabaseAdminClient.rpc("check_and_record_rate_limit", {
    p_key: key,
    p_max_calls: maxCalls,
    p_window_seconds: windowSeconds,
  });

  if (error) {
    console.error(
      "[checkRateLimit] RPC falhou, negando por segurança (fail-closed):",
      error.message,
    );
    return { allowed: false, retryAfterMs: windowMs, rpcFailed: true };
  }

  const result = data as CheckAndRecordRpcResult;

  if (!result.allowed) {
    return { allowed: false, retryAfterMs: result.retryAfterSeconds * 1000 };
  }

  return { allowed: true };
}
