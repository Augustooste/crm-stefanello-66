// channel-status.ts — histórico persistente do "porquê" do estado de um canal.
//
// Motivação (2026-08): o card da integração mostrava só o último `status` +
// `status_message`, que é sobrescrito a cada evento. Quando a Zappaz entra em
// loop `open -> close(conflict 440) -> connecting`, o operador via um estado
// instantâneo sem nenhuma trilha para diagnosticar. Agora todo evento relevante
// (webhook, reconcile, reconnect interativo, teste de mensagem) vira uma linha
// em public.channel_status_events, e o motivo consolidado fica em
// channels.last_status_reason para leitura barata no card.
//
// Best-effort por contrato: registrar diagnóstico NUNCA pode derrubar o fluxo
// que está sendo diagnosticado. Falhas aqui só viram console.warn.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

export type ChannelStatusSource = "webhook" | "reconcile" | "reconnect" | "test" | "connect";
export type ChannelStatusStepState = "running" | "ok" | "failed" | "skipped";

export interface ChannelStatusEventInput {
  tenantId: string;
  channelId: string;
  /** Estado do canal no momento do evento (connected/connecting/disconnected/error/...). */
  status: string;
  /** Código curto e estável, usado por UI e suporte. Ex.: "conflict_440". */
  reasonCode: string;
  /** Texto em PT-BR mostrado ao operador. */
  reasonDetail?: string | null;
  source: ChannelStatusSource;
  /** Passo de uma execução multi-etapas (reconnect/test). */
  step?: string | null;
  stepState?: ChannelStatusStepState | null;
  /** Correlaciona os passos de uma mesma execução (progresso em tempo real). */
  runId?: string | null;
  raw?: Record<string, unknown>;
  /**
   * Quando true, também grava `channels.last_status_reason` com
   * `reasonCode: reasonDetail`. Padrão: true para eventos finais (sem step).
   */
  persistOnChannel?: boolean;
}

export async function recordChannelStatusEvent(
  admin: SupabaseClient,
  input: ChannelStatusEventInput,
): Promise<void> {
  const {
    tenantId,
    channelId,
    status,
    reasonCode,
    reasonDetail = null,
    source,
    step = null,
    stepState = null,
    runId = null,
    raw = {},
    persistOnChannel,
  } = input;

  try {
    const { error } = await admin.from("channel_status_events").insert({
      tenant_id: tenantId,
      channel_id: channelId,
      status,
      reason_code: reasonCode,
      reason_detail: reasonDetail,
      source,
      step,
      step_state: stepState,
      run_id: runId,
      raw,
    });
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn("[channel-status] falha ao registrar evento", {
      channel_id: channelId,
      reason_code: reasonCode,
      error: e instanceof Error ? e.message : String(e),
    });
  }

  const shouldPersist = persistOnChannel ?? step === null;
  if (!shouldPersist) return;

  try {
    const detail = reasonDetail ? `${reasonCode}: ${reasonDetail}` : reasonCode;
    const { error } = await admin
      .from("channels")
      .update({ last_status_reason: detail })
      .eq("id", channelId);
    if (error) throw new Error(error.message);
  } catch (e) {
    console.warn("[channel-status] falha ao gravar last_status_reason", {
      channel_id: channelId,
      error: e instanceof Error ? e.message : String(e),
    });
  }
}

/** Identificador de execução (reconnect/test) para correlacionar os passos. */
export function newRunId(): string {
  return crypto.randomUUID();
}
