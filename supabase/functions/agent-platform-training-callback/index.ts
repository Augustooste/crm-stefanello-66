// agent-platform-training-callback — recebe o aviso de fim de processamento de
// treinamento que o provedor de agentes dispara na `callbackUrl` enviada na criação.
//
// verify_jwt = false (config.toml): quem chama é o provedor, não um usuário. A
// autorização é a chave derivada por tenant na própria URL (ver
// _shared/agent-platform/callback.ts), comparada em tempo constante.
//
// O contrato NÃO documenta payload nem assinatura deste callback, então o corpo
// é tratado como opaco: guardamos como veio (limitado em tamanho), tentamos ler
// status/id e nunca falhamos por formato desconhecido. Reenvio do mesmo aviso é
// idempotente por `dedupe_key`.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";

import { captureEdgeError } from "../_shared/telemetry.ts";
import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";
import { deriveCallbackKey, sha256Hex } from "../_shared/agent-platform/callback.ts";

const MAX_BODY_BYTES = 32_768;

type TrainingStatus = "success" | "error" | "unknown";

function classify(
  payload: Record<string, unknown>,
): { status: TrainingStatus; message: string | null } {
  const rawStatus = typeof payload.status === "string" ? payload.status.toLowerCase() : null;
  const message = typeof payload.message === "string"
    ? payload.message
    : typeof payload.error === "string"
    ? payload.error
    : null;

  if (payload.success === true || rawStatus === "success" || rawStatus === "finished") {
    return { status: "success", message };
  }
  if (
    payload.success === false || payload.error || rawStatus === "error" || rawStatus === "failed"
  ) {
    return { status: "error", message };
  }
  return { status: "unknown", message };
}

function pickId(payload: Record<string, unknown>, keys: readonly string[]): string | null {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value) return value;
  }
  return null;
}

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });

  const url = new URL(req.url);
  const tenantId = url.searchParams.get("t") ?? "";
  const providedKey = url.searchParams.get("k") ?? "";
  const secret = Deno.env.get("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET")?.trim();

  // Segredo ausente = callback desabilitado. Responder 404 (e não 500) evita
  // dizer a um chamador anônimo que a rota existe mas está mal configurada.
  if (!secret) return new Response("Not found", { status: 404 });
  if (!tenantId || !providedKey) return new Response("Unauthorized", { status: 401 });

  const expectedKey = await deriveCallbackKey(secret, tenantId);
  if (!timingSafeEqualStrings(providedKey, expectedKey)) {
    return new Response("Unauthorized", { status: 401 });
  }

  const rawBody = (await req.text()).slice(0, MAX_BODY_BYTES);
  let payload: Record<string, unknown> = {};
  if (rawBody) {
    try {
      const parsed = JSON.parse(rawBody);
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        payload = parsed as Record<string, unknown>;
      } else {
        payload = { raw: parsed };
      }
    } catch {
      payload = { raw: rawBody };
    }
  }

  const { status, message } = classify(payload);
  const trainingId = pickId(payload, ["trainingId", "training_id", "id"]);
  const agentId = pickId(payload, ["agentId", "agent_id", "assistantId"]);
  const dedupeKey = await sha256Hex(`${trainingId ?? ""}|${agentId ?? ""}|${status}|${rawBody}`);

  const admin = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
    { auth: { persistSession: false, autoRefreshToken: false } },
  );

  const { error } = await admin.from("agent_platform_training_events").upsert(
    {
      tenant_id: tenantId,
      platform_agent_id: agentId,
      platform_training_id: trainingId,
      status,
      message,
      payload,
      dedupe_key: dedupeKey,
    },
    { onConflict: "tenant_id,dedupe_key", ignoreDuplicates: true },
  );

  if (error) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "agent-platform.training_callback.persist",
      tenantId,
      message: error.message,
      context: { training_id: trainingId, agent_id: agentId, status },
    });
    // 500 para o provedor tentar de novo — o upsert é idempotente.
    return new Response(JSON.stringify({ ok: false }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }

  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
});
