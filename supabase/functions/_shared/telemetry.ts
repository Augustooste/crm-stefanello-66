// telemetry.ts — sink de telemetria para Edge Functions (Deno).
//
// Porta de clientes/pedro/medflow-v0/supabase/functions/_shared/telemetry.ts,
// adaptada a este projeto: tenant_id (não org_id), client injetado pelo
// caller (não criado internamente a partir de env vars) e sem integração
// Sentry (aceleraflow não tem Sentry configurado nesta fase — é só o sink
// de DB em public.system_events).
//
// NUNCA lança — todo o corpo é try/catch aninhado. Seguro invocar em edge
// handlers onde um throw quebraria a resposta ao cliente, mesmo se o INSERT
// falhar (ex.: banco fora do ar).
//
// Uso — importar `captureEdgeError` de `../_shared/telemetry.ts` (caminho como
// uma edge function o vê). A linha de import fica em prosa de propósito: o
// bundler do Supabase CLI coleta specifiers por regex INCLUSIVE dentro de
// comentário, e uma linha de import apontando pra `../_shared/...` escrita
// aqui, que já está em `_shared/`, resolvia pra `_shared/_shared/...` — e
// derrubava `supabase start` com "failed to read file". Mesmo bug de
// ai/failure-log.ts, corrigido junto em 2026-07-27.
//
//   await captureEdgeError(supabaseAdmin, {
//     severity: "error",
//     source: "edge",
//     operation: "webhook.meta.process",
//     tenantId: tenant?.id ?? null,
//     message: err instanceof Error ? err.message : String(err),
//     stack: err instanceof Error ? err.stack ?? null : null,
//   });

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

export type SystemEventSeverity = "error" | "warn" | "info";
// 'db' entrou no CHECK de public.system_events.source em
// 20260725103000_rls_grant_drift_sentinel.sql: o sentinela de drift escreve de
// dentro do banco, não é edge function nem cliente. Nenhuma edge function passa
// 'db' — o valor existe aqui só para o tipo não mentir sobre o domínio da
// coluna, que é o que faria alguém escrever um leitor com `switch` incompleto.
export type SystemEventSource = "edge" | "client" | "db";

export interface CaptureEdgeErrorParams {
  severity: SystemEventSeverity;
  source: SystemEventSource;
  operation: string;
  tenantId?: string | null;
  conversationId?: string | null;
  dealId?: string | null;
  correlationId?: string | null;
  errorCode?: string | null;
  message: string;
  stack?: string | null;
  context?: Record<string, unknown>;
}

/**
 * Persiste um evento de erro/warn/info em public.system_events via o client
 * (service_role) passado pelo caller. Best-effort: se o INSERT falhar (rede,
 * RLS, banco fora do ar), loga no console e retorna normalmente — nunca
 * propaga a falha para quem chamou.
 *
 * @param supabaseAdminClient client Supabase já inicializado com service_role
 * @returns Promise<void> — sempre resolve, nunca rejeita.
 */
/**
 * Último recurso quando `system_events` não aceita o INSERT.
 *
 * No Lovable Cloud o canal fora do Postgres é o log de runtime da própria edge
 * function — é o que continua existindo quando o banco é justamente o que caiu.
 * Antes daqui o fallback logava só `error.message`, então o evento perdido
 * chegava sem `operation`, sem tenant e sem a mensagem original: dava para ver
 * que ALGO se perdeu, não O QUE. Uma linha só, prefixo estável e JSON, para dar
 * para achar e ler no painel de logs.
 */
function registrarPerdaDeEvento(params: CaptureEdgeErrorParams, motivo: string): void {
  console.error(
    "[system_events_perdido]",
    JSON.stringify({
      motivo,
      severity: params.severity,
      operation: params.operation,
      tenant_id: params.tenantId ?? null,
      message: params.message,
      error_code: params.errorCode ?? null,
    }),
  );
}

export async function captureEdgeError(
  supabaseAdminClient: SupabaseClient,
  params: CaptureEdgeErrorParams,
): Promise<void> {
  try {
    try {
      const { error } = await supabaseAdminClient.from("system_events").insert({
        severity: params.severity,
        source: params.source,
        operation: params.operation,
        tenant_id: params.tenantId ?? null,
        conversation_id: params.conversationId ?? null,
        deal_id: params.dealId ?? null,
        correlation_id: params.correlationId ?? null,
        error_code: params.errorCode ?? null,
        message: params.message,
        stack: params.stack ?? null,
        context: params.context ?? {},
      });

      if (error) {
        registrarPerdaDeEvento(params, error.message);
      }
    } catch (insertErr) {
      // Cobre rejeições do client (ex.: fetch falhou, banco fora do ar).
      registrarPerdaDeEvento(params, insertErr instanceof Error ? insertErr.message : String(insertErr));
    }
  } catch (outerErr) {
    // Swallow externo — garante que captureEdgeError NUNCA lança, mesmo se
    // algo inesperado quebrar antes do INSERT (ex.: params malformado).
    console.error("[captureEdgeError] erro inesperado:", outerErr);
  }
}
