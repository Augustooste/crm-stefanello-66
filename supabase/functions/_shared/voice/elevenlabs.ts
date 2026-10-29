// elevenlabs.ts — VoiceProvider real: ElevenLabs Agents ligando por um número
// Twilio importado na conta ElevenLabs. A ElevenLabs faz a parte de tempo real
// (streaming, VAD, barge-in); o CRM só pede a ligação e busca o resultado.
//
// Contratos conferidos na doc oficial em 28/09/2026:
//   POST /v1/convai/twilio/outbound-call
//     { agent_id, agent_phone_number_id, to_number,
//       conversation_initiation_client_data: { dynamic_variables } }
//     -> { success, message, conversation_id|null, callSid|null }
//   GET  /v1/convai/conversations/{conversation_id}
//     -> { status: initiated|in-progress|processing|done|failed,
//          metadata: { call_duration_secs, termination_reason, ... },
//          transcript: [{ role: user|agent, message, time_in_call_secs }],
//          analysis: { transcript_summary, data_collection_results } }
//
// Resultado por CONSULTA (voice-call-poller), não por webhook: o webhook
// pós-chamada da conta ElevenLabs é compartilhado com outros projetos.
// ElevenLabs não tem idempotency key: timeout = "incerto", sem reenvio.
import {
  CONTRACT_VERSION,
  type CreateCallRequest,
  type VoiceCallContext,
  type VoiceCallOutcome,
  type VoiceEvent,
} from "./contract.ts";
import type { CancelCallResult, CreateCallResult, VoiceProvider } from "./provider.ts";
import { redactSecrets } from "../redact-secrets.ts";

const API = "https://api.elevenlabs.io/v1/convai";
const TIMEOUT_MS = 15_000;

export interface ElevenLabsVoiceConfig {
  apiKey: string;
  agentId: string;
  phoneNumberId: string;
}

/**
 * Variáveis dinâmicas do agente (`{{first_name}}`, `{{objective}}`...).
 * Só o contexto mínimo já montado por public.request_voice_call, achatado em
 * texto: ElevenLabs aceita string/número/booleano nas variáveis.
 */
export function dynamicVariables(context: VoiceCallContext): Record<string, string> {
  const history = context.recent_messages
    .map((m) => `${m.from === "contact" ? "Lead" : "Empresa"}: ${m.text}`)
    .join("\n");
  return {
    first_name: context.contact.first_name,
    objective: context.objective,
    deal_title: context.deal?.title ?? "",
    deal_stage: context.deal?.stage ?? "",
    recent_messages: history,
  };
}

export class ElevenLabsVoiceProvider implements VoiceProvider {
  readonly name = "elevenlabs";
  constructor(private readonly cfg: ElevenLabsVoiceConfig) {}

  async createCall(req: CreateCallRequest): Promise<CreateCallResult> {
    let res: Response;
    try {
      res = await fetch(`${API}/twilio/outbound-call`, {
        method: "POST",
        headers: { "content-type": "application/json", "xi-api-key": this.cfg.apiKey },
        body: JSON.stringify({
          agent_id: this.cfg.agentId,
          agent_phone_number_id: this.cfg.phoneNumberId,
          to_number: req.phone,
          conversation_initiation_client_data: {
            dynamic_variables: dynamicVariables(req.context),
          },
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return { kind: "uncertain", error: `ElevenLabs sem resposta: ${redactSecrets(err)}` };
    }
    const text = await res.text().catch(() => "");
    if (!res.ok) {
      const detail = redactSecrets(text).slice(0, 300);
      // 4xx: pedido recusado, nada foi discado. 5xx: pode ter discado.
      return res.status < 500
        ? { kind: "rejected", error: `ElevenLabs recusou (HTTP ${res.status}). ${detail}`.trim() }
        : { kind: "uncertain", error: `ElevenLabs HTTP ${res.status}. ${detail}`.trim() };
    }
    let data: { success?: unknown; message?: unknown; conversation_id?: unknown };
    try {
      data = JSON.parse(text);
    } catch {
      return { kind: "uncertain", error: "ElevenLabs respondeu sem JSON válido." };
    }
    if (data.success !== true) {
      const msg = typeof data.message === "string" ? data.message : "sem detalhe";
      return { kind: "rejected", error: `ElevenLabs não iniciou a ligação: ${redactSecrets(msg)}` };
    }
    if (typeof data.conversation_id !== "string" || !data.conversation_id) {
      return { kind: "uncertain", error: "ElevenLabs aceitou mas não devolveu conversation_id." };
    }
    return {
      kind: "accepted",
      provider: this.name,
      providerCallId: data.conversation_id,
      simulation: false,
    };
  }

  cancelCall(): Promise<CancelCallResult> {
    return Promise.resolve({
      ok: false,
      error: "A ElevenLabs não permite encerrar a ligação pela API; ela termina sozinha.",
    });
  }

  getCall(): Promise<{ status: string } | null> {
    return Promise.resolve(null);
  }

  /** GET da conversa. null = ainda não existe/404; lança em erro de rede. */
  async fetchConversation(conversationId: string): Promise<ElevenLabsConversation | null> {
    const res = await fetch(`${API}/conversations/${encodeURIComponent(conversationId)}`, {
      headers: { "xi-api-key": this.cfg.apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 404) return null;
    if (!res.ok) {
      const detail = redactSecrets(await res.text().catch(() => "")).slice(0, 200);
      throw new Error(`ElevenLabs HTTP ${res.status} ao consultar conversa. ${detail}`.trim());
    }
    return (await res.json()) as ElevenLabsConversation;
  }
}

export interface ElevenLabsConversation {
  status: "initiated" | "in-progress" | "processing" | "done" | "failed";
  metadata?: {
    start_time_unix_secs?: number;
    call_duration_secs?: number;
    termination_reason?: string;
  };
  transcript?: Array<
    { role: "user" | "agent"; message?: string | null; time_in_call_secs?: number }
  >;
  analysis?: {
    transcript_summary?: string;
    data_collection_results?: Record<string, { value?: unknown }>;
  } | null;
}

const OUTCOMES: readonly VoiceCallOutcome[] = [
  "interested",
  "not_interested",
  "callback_requested",
  "voicemail",
  "wrong_number",
  "no_decision",
];

/**
 * Converte o estado da conversa em eventos do contrato v1. event_id
 * determinístico por (conversa, fase): consultar de novo gera o mesmo id e o
 * ledger responde "duplicate". `processing` não gera evento (análise ainda
 * não pronta). Resultado vem do campo de coleta `outcome` do agente; sem ele,
 * `no_decision` -- nunca derivado de `call_successful`.
 */
export function conversationToEvents(
  conv: ElevenLabsConversation,
  ref: { callId: string; tenantId: string; conversationId: string },
  now = new Date(),
): VoiceEvent[] {
  const base = {
    version: CONTRACT_VERSION,
    call_id: ref.callId,
    tenant_id: ref.tenantId,
    provider_call_id: ref.conversationId,
  } as const;
  const start = conv.metadata?.start_time_unix_secs;
  const at = (offsetSecs = 0) =>
    start ? new Date((start + offsetSecs) * 1000).toISOString() : now.toISOString();
  const id = (phase: string) => `el-${ref.conversationId}-${phase}`;

  switch (conv.status) {
    case "initiated":
      return [{ ...base, event_id: id("ringing"), type: "call.ringing", occurred_at: at() }];
    case "in-progress":
      return [{ ...base, event_id: id("answered"), type: "call.answered", occurred_at: at() }];
    case "processing":
      return [];
    case "failed":
      return [{
        ...base,
        event_id: id("failed"),
        type: "call.failed",
        occurred_at: at(conv.metadata?.call_duration_secs ?? 0),
        data: {
          reason: "failed",
          message: (conv.metadata?.termination_reason ?? "Falha na ligação.").slice(0, 300),
        },
      }];
    case "done": {
      const duration = Math.max(0, Math.round(conv.metadata?.call_duration_secs ?? 0));
      const turns = conv.transcript ?? [];
      const leadSpoke = turns.some((t) => t.role === "user" && (t.message ?? "").trim());
      if (duration === 0 || !leadSpoke) {
        return [{
          ...base,
          event_id: id("no-answer"),
          type: "call.failed",
          occurred_at: at(duration),
          data: {
            reason: "no_answer",
            message: conv.metadata?.termination_reason ?? "Sem resposta.",
          },
        }];
      }
      const raw = conv.analysis?.data_collection_results?.outcome?.value;
      const outcome = OUTCOMES.includes(raw as VoiceCallOutcome)
        ? (raw as VoiceCallOutcome)
        : "no_decision";
      // Horário de retorno coletado pelo agente; o banco valida janela e fuso.
      const rawCallback = conv.analysis?.data_collection_results?.callback_at?.value;
      const callbackAt = outcome === "callback_requested" && typeof rawCallback === "string" &&
          !Number.isNaN(Date.parse(rawCallback))
        ? rawCallback
        : undefined;
      const transcript = turns
        .filter((t) => (t.message ?? "").trim())
        .map((t) => `${t.role === "agent" ? "Agente" : "Lead"}: ${t.message}`)
        .join("\n");
      const events: VoiceEvent[] = [
        { ...base, event_id: id("answered"), type: "call.answered", occurred_at: at() },
        {
          ...base,
          event_id: id("completed"),
          type: "call.completed",
          occurred_at: at(duration),
          data: {
            duration_seconds: duration,
            outcome,
            ...(callbackAt ? { callback_at: callbackAt } : {}),
          },
        },
        {
          ...base,
          event_id: id("transcript"),
          type: "call.transcript.updated",
          occurred_at: at(duration),
          sequence: 1,
          data: { transcript },
        },
      ];
      const summary = conv.analysis?.transcript_summary?.trim();
      if (summary) {
        events.push({
          ...base,
          event_id: id("summary"),
          type: "call.summary.ready",
          occurred_at: at(duration),
          sequence: 1,
          data: { summary, outcome },
        });
      }
      return events;
    }
  }
}
