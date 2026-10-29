// failure-log.ts — sink de falhas de provider de IA para Edge Functions (Deno).
//
// Mesmo padrão defensivo de ../telemetry.ts (captureEdgeError): NUNCA lança —
// todo o corpo é try/catch aninhado. Seguro invocar de dentro de um catch de
// erro de provider (OpenAI/Anthropic/etc.) sem quebrar a resposta ao cliente,
// mesmo se o INSERT em ai_failure_logs falhar (ex.: banco fora do ar).
//
// Diferença do medflow-v0: SEM Sentry/PostHog/Telegram — anti-padrão explícito
// pra este projeto (docs/PRD-CRM-IA-MULTINICHO.md:1110/1162). Só o INSERT.
//
// errorMessage já deve chegar sanitizado pelo chamador (sanitizeProviderError
// da lane "errors", que roda antes na integração) — este módulo não sanitiza
// de novo, só persiste.
//
// Uso — importar `reportAIFailure` de `../_shared/ai/failure-log.ts` (caminho
// como uma edge function o vê). A linha de import fica em prosa de propósito: o
// bundler do Supabase CLI coleta specifiers por regex INCLUSIVE dentro de
// comentário, e uma linha de import apontando pra `../_shared/...` escrita
// aqui, que já está em `_shared/`, resolvia pra `_shared/_shared/...` — e
// derrubava `supabase start` com "failed to read file". Quebrou o CI de
// 2026-07-09 a 2026-07-27.
//
//   await reportAIFailure(supabaseAdmin, {
//     tenantId: tenant.id,
//     route: "ai-respond",
//     provider: "openai",
//     model: "gpt-4o-mini",
//     statusCode: 429,
//     errorCode: "rate_limited",
//     errorMessage: sanitizeProviderError(err),
//   });

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

export interface ReportAIFailureParams {
  tenantId: string;
  route: string;
  provider?: string | null;
  model?: string | null;
  statusCode?: number | null;
  errorCode: string;
  errorMessage: string;
  /**
   * Identificador de execução por mensagem. Convenção do projeto: é o id da
   * mensagem de ENTRADA que originou a execução (messages.id do inbound) —
   * assim uma falha de IA, um evento em system_events e um erro de frontend
   * da mesma mensagem caem no mesmo traceId na visão de incidentes.
   */
  traceId?: string | null;
  context?: Record<string, unknown>;
}

/**
 * Deriva o traceId: explícito ganha; senão tenta o que o context já carrega
 * (call-sites antigos passam messageId/aiMessageId sem saber de trace).
 */
export function resolveTraceId(params: ReportAIFailureParams): string | null {
  if (params.traceId) return String(params.traceId);
  const ctx = params.context ?? {};
  for (const key of ["traceId", "trace_id", "messageId", "inboundMessageId"]) {
    const value = (ctx as Record<string, unknown>)[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

/**
 * Persiste uma falha de provider de IA em public.ai_failure_logs via o client
 * (service_role) passado pelo caller. Best-effort: se o INSERT falhar (rede,
 * RLS, banco fora do ar), loga no console e retorna normalmente — nunca
 * propaga a falha para quem chamou.
 *
 * @param supabaseAdminClient client Supabase já inicializado com service_role
 * @returns Promise<void> — sempre resolve, nunca rejeita.
 */
export async function reportAIFailure(
  supabaseAdminClient: SupabaseClient,
  params: ReportAIFailureParams,
): Promise<void> {
  try {
    try {
      const { error } = await supabaseAdminClient.from("ai_failure_logs").insert({
        tenant_id: params.tenantId,
        route: params.route,
        provider: params.provider ?? null,
        model: params.model ?? null,
        status_code: params.statusCode ?? null,
        error_code: params.errorCode,
        error_message: params.errorMessage,
        trace_id: resolveTraceId(params),
        context: params.context ?? {},
      });

      if (error) {
        console.error("[reportAIFailure] INSERT falhou:", error.message);
      }
    } catch (insertErr) {
      // Cobre rejeições do client (ex.: fetch falhou, banco fora do ar).
      console.error("[reportAIFailure] INSERT lançou:", insertErr);
    }
  } catch (outerErr) {
    // Swallow externo — garante que reportAIFailure NUNCA lança, mesmo se
    // algo inesperado quebrar antes do INSERT (ex.: params malformado).
    console.error("[reportAIFailure] erro inesperado:", outerErr);
  }
}
