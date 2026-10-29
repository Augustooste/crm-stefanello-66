// contract.ts — contrato v1 entre o CRM (control plane) e o Voice Service
// (execution plane). Espelho de docs/VOICE-SERVICE-CONTRACT.md: mudar os dois
// juntos. O CRM não conhece o provedor de telefonia; só este contrato.
//
// Assinatura (os dois sentidos): HMAC-SHA256 em hex sobre `${timestamp}.${corpo}`,
// com chave derivada por tenant = HMAC(segredo global, tenant_id) -- mesmo
// esquema de _shared/agent-platform/callback.ts. Evento de um tenant não vale
// para outro, e vazar uma chave derivada não expõe o segredo.

export const CONTRACT_VERSION = "v1";
export const SIGNATURE_HEADER = "x-voice-signature";
export const TIMESTAMP_HEADER = "x-voice-timestamp";
export const TENANT_HEADER = "x-voice-tenant";
/** Janela de validade do timestamp (anti-replay junto com event_id único). */
export const MAX_CLOCK_SKEW_SECONDS = 300;

export type VoiceCallStatus =
  | "queued"
  | "initiating"
  | "ringing"
  | "answered"
  | "completed"
  | "failed"
  | "busy"
  | "no_answer"
  | "cancelled";

export const TERMINAL_STATUSES: readonly VoiceCallStatus[] = [
  "completed",
  "failed",
  "busy",
  "no_answer",
  "cancelled",
];

export type VoiceCallOutcome =
  | "interested"
  | "not_interested"
  | "callback_requested"
  | "voicemail"
  | "wrong_number"
  | "no_decision";

/** Contexto mínimo montado por public.request_voice_call (whitelist). */
export interface VoiceCallContext {
  contact: { first_name: string };
  deal: { title: string; stage: string | null } | null;
  objective: string;
  recent_messages: Array<{ from: "contact" | "company"; text: string; at: string }>;
}

/** POST /v1/calls */
export interface CreateCallRequest {
  call_id: string;
  tenant_id: string;
  contact_id: string;
  phone: string;
  agent_ref: string;
  context: VoiceCallContext;
  callback_url: string;
  /** O Voice Service DEVE deduplicar por (tenant_id, idempotency_key). */
  idempotency_key: string;
}

export interface CreateCallResponse {
  provider: string;
  provider_call_id: string;
  status: "initiating" | "ringing";
}

export type VoiceEventType =
  | "call.created"
  | "call.ringing"
  | "call.answered"
  | "call.completed"
  | "call.failed"
  | "call.transcript.updated"
  | "call.summary.ready";

export interface VoiceEvent {
  version: typeof CONTRACT_VERSION;
  event_id: string;
  type: VoiceEventType;
  call_id: string;
  tenant_id: string;
  provider_call_id: string;
  occurred_at: string;
  /** Obrigatório em transcript/summary: o maior vence. */
  sequence?: number;
  data?: {
    reason?: "busy" | "no_answer" | "cancelled" | "failed";
    message?: string;
    duration_seconds?: number;
    outcome?: VoiceCallOutcome;
    /** ISO 8601: horário de retorno pedido pelo lead (callback_requested). */
    callback_at?: string;
    answered_at?: string;
    transcript?: string;
    summary?: string;
    recording_ref?: string;
  };
}

const EVENT_TYPES = new Set<string>([
  "call.created",
  "call.ringing",
  "call.answered",
  "call.completed",
  "call.failed",
  "call.transcript.updated",
  "call.summary.ready",
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Validação estrutural do evento (depois da assinatura). null = inválido. */
export function parseVoiceEvent(raw: unknown): VoiceEvent | null {
  if (!raw || typeof raw !== "object") return null;
  const e = raw as Record<string, unknown>;
  if (e.version !== CONTRACT_VERSION) return null;
  if (typeof e.event_id !== "string" || e.event_id.length < 8 || e.event_id.length > 200) {
    return null;
  }
  if (typeof e.type !== "string" || !EVENT_TYPES.has(e.type)) return null;
  if (typeof e.call_id !== "string" || !UUID_RE.test(e.call_id)) return null;
  if (typeof e.tenant_id !== "string" || !UUID_RE.test(e.tenant_id)) return null;
  if (typeof e.provider_call_id !== "string" || !e.provider_call_id) return null;
  if (typeof e.occurred_at !== "string" || Number.isNaN(Date.parse(e.occurred_at))) return null;
  const isContent = e.type === "call.transcript.updated" || e.type === "call.summary.ready";
  if (isContent && !Number.isInteger(e.sequence)) return null;
  if (e.data !== undefined && (typeof e.data !== "object" || e.data === null)) return null;
  return e as unknown as VoiceEvent;
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function hmacHex(key: string, message: string): Promise<string> {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return toHex(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message)));
}

export function deriveTenantKey(secret: string, tenantId: string): Promise<string> {
  return hmacHex(secret, tenantId);
}

export async function signPayload(
  secret: string,
  tenantId: string,
  timestamp: string,
  body: string,
): Promise<string> {
  return `v1=${await hmacHex(await deriveTenantKey(secret, tenantId), `${timestamp}.${body}`)}`;
}
