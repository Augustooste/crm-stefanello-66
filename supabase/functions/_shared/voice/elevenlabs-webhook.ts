// elevenlabs-webhook.ts — webhook pós-chamada da ElevenLabs no voice-call-webhook.
// Mesmo resultado do voice-call-poller, só que na hora: os eventos saem de
// conversationToEvents com os MESMOS event_id, então webhook e poller se
// deduplicam no apply_voice_call_event. O poller fica como rede de segurança.
//
// Formato conferido em 28/09/2026 (docs post-call-webhooks + elevenlabs-js
// src/wrapper/webhooks.ts):
//   header  ElevenLabs-Signature: t=<unix>,v0=<hex HMAC-SHA256(secret, "<t>.<corpo cru>")>
//   corpo   { type: post_call_transcription | call_initiation_failure | ..., event_timestamp, data }
// Segredo por tenant em integration_secrets (elevenlabs, webhook_secret).
import type { VoiceEvent } from "./contract.ts";
import { CONTRACT_VERSION, hmacHex } from "./contract.ts";
import { conversationToEvents, type ElevenLabsConversation } from "./elevenlabs.ts";
import { timingSafeEqualStrings } from "../timing-safe-equal.ts";

export const ELEVENLABS_SIGNATURE_HEADER = "elevenlabs-signature";
/** Mesma tolerância do SDK oficial. */
const MAX_AGE_SECONDS = 30 * 60;
/** Transcrição de ligação de 4 min fica em dezenas de KB; áudio não é assinado aqui. */
const MAX_BYTES = 1024 * 1024;

export interface ElevenLabsWebhookCall {
  id: string;
  tenant_id: string;
  provider_call_id: string;
}

export interface ElevenLabsWebhookDeps {
  findCall: (conversationId: string) => Promise<ElevenLabsWebhookCall | null>;
  loadSecret: (tenantId: string) => Promise<string | null>;
  applyEvent: (event: VoiceEvent) => Promise<{ result: string; status?: string }>;
  nowMs?: () => number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const FAILURE_REASON: Record<string, "busy" | "no_answer"> = {
  busy: "busy",
  "no-answer": "no_answer",
};

/**
 * Ordem: cabeçalho e janela de tempo -> tamanho -> conversation_id do corpo
 * (ainda não confiável, só para achar a ligação e o tenant) -> HMAC com o
 * segredo DESSE tenant sobre o corpo cru -> eventos. Nada é gravado antes da
 * assinatura bater. Conversa que não é de uma ligação do CRM responde 200
 * sem efeito: 4xx repetido faz a ElevenLabs desligar o webhook.
 */
export async function handleElevenLabsWebhook(
  req: Request,
  deps: ElevenLabsWebhookDeps,
): Promise<Response> {
  if (req.method !== "POST") return json(405, { error: "method_not_allowed" });

  const parts = new Map(
    (req.headers.get(ELEVENLABS_SIGNATURE_HEADER) ?? "").split(",").map((p) => {
      const i = p.indexOf("=");
      return [p.slice(0, i).trim(), p.slice(i + 1).trim()] as const;
    }),
  );
  const t = parts.get("t") ?? "";
  const v0 = parts.get("v0") ?? "";
  const ts = Number(t);
  if (!v0 || !/^\d+$/.test(t)) return json(401, { error: "unsigned" });
  const nowSec = Math.floor((deps.nowMs ?? Date.now)() / 1000);
  if (Math.abs(nowSec - ts) > MAX_AGE_SECONDS) return json(401, { error: "stale" });

  const raw = await req.text();
  if (raw.length > MAX_BYTES) return json(413, { error: "too_large" });

  let body: { type?: unknown; data?: Record<string, unknown> };
  try {
    body = JSON.parse(raw);
  } catch {
    return json(400, { error: "invalid_json" });
  }
  const conversationId = body?.data?.conversation_id;
  if (typeof conversationId !== "string" || !conversationId || conversationId.length > 200) {
    return json(400, { error: "invalid_payload" });
  }

  const call = await deps.findCall(conversationId);
  if (!call) return json(200, { result: "unknown_conversation" });
  const secret = (await deps.loadSecret(call.tenant_id))?.trim();
  if (!secret) return json(404, { error: "not_configured" });
  const expected = await hmacHex(secret, `${t}.${raw}`);
  if (!timingSafeEqualStrings(v0, expected)) return json(401, { error: "bad_signature" });

  const ref = { callId: call.id, tenantId: call.tenant_id, conversationId };
  let events: VoiceEvent[];
  if (body.type === "post_call_transcription") {
    events = conversationToEvents(body.data as unknown as ElevenLabsConversation, ref);
  } else if (body.type === "call_initiation_failure") {
    const reason = FAILURE_REASON[String(body.data?.failure_reason)] ?? "failed";
    events = [{
      version: CONTRACT_VERSION,
      // Mesmo id que o poller gera para status "failed": não duplica.
      event_id: `el-${conversationId}-failed`,
      type: "call.failed",
      call_id: call.id,
      tenant_id: call.tenant_id,
      provider_call_id: conversationId,
      occurred_at: new Date(ts * 1000).toISOString(),
      data: {
        reason,
        message: `Ligação não completou (${String(body.data?.failure_reason ?? "unknown")}).`,
      },
    }];
  } else {
    return json(200, { result: "ignored_type" });
  }

  const results: string[] = [];
  for (const event of events) results.push((await deps.applyEvent(event)).result);
  // Só metadados no log: transcrição e resumo são dados pessoais.
  console.log("[voice-call-webhook:elevenlabs]", { call_id: call.id, type: body.type, results });
  return json(200, { result: "ok", events: results });
}
