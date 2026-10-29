// handlers.ts — lógica HTTP de voice-calls e voice-call-webhook, com as
// dependências injetadas (clientes Supabase, provedor, relógio). Os index.ts
// só montam as dependências reais; os testes passam falsos, sem rede.
import {
  CONTRACT_VERSION,
  type CreateCallRequest,
  MAX_CLOCK_SKEW_SECONDS,
  parseVoiceEvent,
  SIGNATURE_HEADER,
  signPayload,
  TENANT_HEADER,
  TIMESTAMP_HEADER,
  type VoiceCallContext,
  type VoiceEvent,
} from "./contract.ts";
import { type CreateCallResult, MockVoiceProvider, type ProviderResolution } from "./provider.ts";
import { timingSafeEqualStrings } from "../timing-safe-equal.ts";
import { redactSecrets } from "../redact-secrets.ts";

type RpcResult = { data: unknown; error: { code?: string; message: string } | null };
export type ApplyResult = { result: string; status?: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_WEBHOOK_BYTES = 256 * 1024;

/**
 * Celular BR gravado sem o nono dígito (formato do JID do WhatsApp, ex.
 * +554599022026) não completa a ligação: a operadora recusa. Número +55 com
 * DDD + 8 dígitos começando em 6-9 ganha o 9; fixo (2-5) fica como está.
 */
export function dialablePhone(phone: string): string {
  const m = /^\+55(\d{2})([6-9]\d{7})$/.exec(phone);
  return m ? `+55${m[1]}9${m[2]}` : phone;
}

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...cors, "content-type": "application/json" },
  });
}

// ─── Webhook ────────────────────────────────────────────────────────────────

export interface WebhookDeps {
  secret: string | undefined;
  applyEvent: (event: VoiceEvent) => Promise<ApplyResult>;
  nowMs?: () => number;
}

/**
 * Ordem fail-closed: segredo configurado -> timestamp na janela -> HMAC do
 * corpo cru (antes de qualquer JSON.parse) -> formato do evento -> tenant do
 * corpo = tenant assinado -> aplicação atômica no banco (que ainda confere
 * call_id + tenant_id + provider_call_id e deduplica por event_id).
 */
export async function handleVoiceWebhook(req: Request, deps: WebhookDeps): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const secret = (deps.secret ?? "").trim();
  if (!secret) return json(404, { error: "not_found" });

  const timestamp = req.headers.get(TIMESTAMP_HEADER) ?? "";
  const signature = req.headers.get(SIGNATURE_HEADER) ?? "";
  const tenantId = req.headers.get(TENANT_HEADER) ?? "";
  const ts = Number(timestamp);
  const nowSec = Math.floor((deps.nowMs ?? Date.now)() / 1000);
  if (!signature || !UUID_RE.test(tenantId) || !Number.isInteger(ts)) {
    return json(401, { error: "unsigned" });
  }
  if (Math.abs(nowSec - ts) > MAX_CLOCK_SKEW_SECONDS) return json(401, { error: "stale" });

  const raw = await req.text();
  if (raw.length > MAX_WEBHOOK_BYTES) return json(413, { error: "too_large" });
  const expected = await signPayload(secret, tenantId, timestamp, raw);
  if (!timingSafeEqualStrings(signature, expected)) return json(401, { error: "bad_signature" });

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const event = parseVoiceEvent(parsed);
  if (!event) return json(400, { error: "invalid_event" });
  if (event.tenant_id !== tenantId) return json(401, { error: "tenant_mismatch" });

  const applied = await deps.applyEvent(event);
  // Só metadados no log: transcript/summary são dados pessoais.
  console.log("[voice-call-webhook]", {
    event_id: event.event_id,
    type: event.type,
    call_id: event.call_id,
    result: applied.result,
  });
  switch (applied.result) {
    case "applied":
    case "ignored":
    case "duplicate":
      return json(200, applied);
    case "not_found":
      return json(404, { error: "call_not_found" });
    case "mismatch":
      return json(409, { error: "provider_call_mismatch" });
    default:
      return json(400, { error: applied.result });
  }
}

// ─── Criar / cancelar ───────────────────────────────────────────────────────

export interface CallsDeps {
  /** Valida o JWT do usuário. null = não autenticado. */
  getUserId: () => Promise<string | null>;
  /** RPC com o JWT do usuário (RLS e has_permission valem). */
  userRpc: (fn: string, args: Record<string, unknown>) => Promise<RpcResult>;
  /** Escrita service_role, sempre condicionada ao estado atual. */
  updateCall: (callId: string, fromStatus: string, patch: Record<string, unknown>) => Promise<void>;
  applyEvent: (event: VoiceEvent) => Promise<ApplyResult>;
  /**
   * Provedor do tenant ATIVO do usuário, lido da mesma fonte que
   * request_voice_call usa (private.get_user_tenant_id): a chave/agente
   * usados na discagem são sempre do tenant em que a ligação é gravada.
   */
  loadProvider: () => Promise<{ tenantId: string | null; provider: ProviderResolution }>;
  callbackUrl: string;
}

const RPC_STATUS: Record<string, number> = { "42501": 403, P0002: 404, "22023": 400, "23505": 409 };

function rpcError(error: { code?: string; message: string }): Response {
  return json(RPC_STATUS[error.code ?? ""] ?? 500, { error: error.message });
}

interface CallRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  phone: string;
  agent_ref: string;
  idempotency_key: string;
  status: string;
  provider_call_id: string | null;
}

export async function handleVoiceCalls(req: Request, deps: CallsDeps): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });
  const userId = await deps.getUserId();
  if (!userId) return json(401, { error: "Não autenticado." });

  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!body) return json(400, { error: "Corpo inválido." });

  // Para a UI não oferecer "Ligar com IA" quando nada está configurado.
  if (body.action !== "status" && body.action !== "cancel" && body.action !== "create") {
    return json(400, { error: "action deve ser status, create ou cancel." });
  }
  const loaded = await deps.loadProvider();
  if (body.action === "status") {
    return json(200, {
      configured: loaded.provider.ok,
      simulation: loaded.provider.ok && loaded.provider.provider instanceof MockVoiceProvider,
    });
  }
  if (body.action === "cancel") return await cancelCall(body, deps, loaded.provider);

  // Sem provedor configurado, nenhuma linha é criada.
  if (!loaded.provider.ok) return json(503, { error: loaded.provider.error });
  const provider = loaded.provider.provider;

  const { data, error } = await deps.userRpc("request_voice_call", {
    p_contact_id: body.contact_id ?? null,
    p_deal_id: body.deal_id ?? null,
    p_objective: body.objective ?? null,
    p_agent_ref: body.agent_ref ?? null,
    p_idempotency_key: body.idempotency_key ?? null,
  });
  if (error) return rpcError(error);
  const result = data as { existing: boolean; call: CallRow; context?: VoiceCallContext };
  const call = result.call;
  if (result.existing) {
    return json(200, { call_id: call.id, status: call.status, existing: true });
  }
  if (loaded.tenantId !== call.tenant_id) {
    // Nunca discar com a credencial de um tenant uma ligação gravada em outro.
    await deps.updateCall(call.id, "queued", {
      status: "failed",
      ended_at: new Date().toISOString(),
      error_code: "tenant_mismatch",
      error_message: "Empresa ativa mudou durante o pedido. Tente de novo.",
    });
    return json(409, { error: "Empresa ativa mudou durante o pedido. Tente de novo." });
  }

  const request: CreateCallRequest = {
    call_id: call.id,
    tenant_id: call.tenant_id,
    contact_id: call.contact_id,
    phone: dialablePhone(call.phone),
    agent_ref: call.agent_ref,
    context: result.context as VoiceCallContext,
    callback_url: deps.callbackUrl,
    idempotency_key: call.idempotency_key,
  };

  let created: CreateCallResult;
  try {
    created = await provider.createCall(request);
  } catch (err) {
    created = { kind: "uncertain" as const, error: redactSecrets(err) };
  }

  if (created.kind === "rejected") {
    await deps.updateCall(call.id, "queued", {
      status: "failed",
      ended_at: new Date().toISOString(),
      error_code: "provider_rejected",
      error_message: created.error,
    });
    return json(502, { call_id: call.id, status: "failed", error: created.error });
  }
  if (created.kind === "uncertain") {
    // Não marca failed nem tenta de novo: a ligação pode ter saído. O
    // Voice Service deduplica pela idempotency_key e os eventos corrigem o estado.
    await deps.updateCall(call.id, "queued", {
      status: "initiating",
      started_at: new Date().toISOString(),
      error_code: "provider_uncertain",
      error_message: created.error,
    });
    return json(202, { call_id: call.id, status: "initiating", uncertain: true });
  }

  await deps.updateCall(call.id, "queued", {
    status: "initiating",
    started_at: new Date().toISOString(),
    provider: created.provider,
    provider_call_id: created.providerCallId,
    is_simulation: created.simulation,
  });

  let status = "initiating";
  if (provider instanceof MockVoiceProvider) {
    for (const event of provider.simulateEvents({ call_id: call.id, tenant_id: call.tenant_id })) {
      const applied = await deps.applyEvent(event);
      if (applied.status) status = applied.status;
    }
  }
  return json(200, { call_id: call.id, status, simulation: created.simulation });
}

async function cancelCall(
  body: Record<string, unknown>,
  deps: CallsDeps,
  resolution: ProviderResolution,
): Promise<Response> {
  const { data, error } = await deps.userRpc("request_voice_call_cancel", {
    p_call_id: body.call_id ?? null,
  });
  if (error) return rpcError(error);
  const result = data as { action: string; call: CallRow };
  if (result.action !== "cancel_remote") {
    return json(200, { call_id: result.call.id, status: result.call.status });
  }
  if (!resolution.ok) return json(503, { error: resolution.error });

  const cancelled = await resolution.provider.cancelCall({
    tenantId: result.call.tenant_id,
    callId: result.call.id,
    providerCallId: result.call.provider_call_id ?? "",
  });
  if (!cancelled.ok) return json(502, { error: cancelled.error });

  // Cancelamento confirmado vira evento pelo MESMO aplicador dos webhooks.
  const applied = await deps.applyEvent({
    version: CONTRACT_VERSION,
    event_id: `crm-cancel-${result.call.id}`,
    type: "call.failed",
    call_id: result.call.id,
    tenant_id: result.call.tenant_id,
    provider_call_id: result.call.provider_call_id ?? "",
    occurred_at: new Date().toISOString(),
    data: { reason: "cancelled", message: "Cancelada pelo usuário no CRM." },
  });
  return json(200, { call_id: result.call.id, status: applied.status ?? result.call.status });
}
