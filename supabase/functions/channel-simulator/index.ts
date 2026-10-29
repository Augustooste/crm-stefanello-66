import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { validatePublicHttpsUrl } from "../_shared/validate-http-url.ts";
import { ensureContactIdentity } from "../_shared/messaging/contact-identity.ts";
import {
  type InboundMessage,
  cancelNurtureOnReply,
  enqueueAIResponseJob,
  persistInbound,
  runInBackground,
  triggerAiRespond,
} from "../_shared/messaging/inbound.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MEDIA_TYPES: Record<string, true> = {
  "image/jpeg": true,
  "image/png": true,
  "image/webp": true,
  "image/gif": true,
  "audio/mpeg": true,
  "audio/ogg": true,
  "audio/mp4": true,
  "audio/aac": true,
  "audio/amr": true,
  "audio/wav": true,
  "audio/webm": true,
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Método não permitido." });
  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const auth = { persistSession: false, autoRefreshToken: false };
  const userClient = createClient(supabaseUrl, anonKey, {
    auth,
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const admin = createClient(supabaseUrl, serviceRole, { auth });
  let tenantId: string | undefined;
  try {
    const { data: user, error: authError } = await userClient.auth.getUser();
    if (authError || !user.user) return json(401, { error: "Não autenticado." });
    const profile = await loadProfileOrFail(admin, user.user.id, {
      operation: "channel_simulator.load_profile",
    });
    if (!profile.ok) {
      return json(profile.reason === "db_error" ? 503 : 403, {
        error: profile.reason === "db_error" ? PROFILE_DB_ERROR_MESSAGE : "Membro ativo não encontrado.",
      });
    }
    tenantId = profile.tenantId;
    let body: Record<string, unknown>;
    try {
      const raw = await req.text();
      if (raw.length > 16_384) {
        return json(413, {
          error: "Mensagem acima do limite. Envie o anexo pelo armazenamento.",
        });
      }
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("Corpo inválido");
      }
      body = parsed as Record<string, unknown>;
    } catch {
      return json(400, { error: "Corpo inválido." });
    }

    if (body.action === "create") {
      if (profile.role !== "admin") {
        return json(403, {
          error: "Apenas administradores podem criar o canal de demonstração.",
        });
      }
      // RPC sob o JWT do usuário: valida admin e ativa canal/integração/opt-in na mesma transação.
      const { data: channelId, error } = await userClient.rpc("create_simulator_channel");
      if (error) throw error;
      return json(200, { ok: true, channel_id: channelId, provider_slug: "simulator", simulated: true });
    }
    if (body.action !== "send" || typeof body.channel_id !== "string" || !UUID_RE.test(body.channel_id)) {
      return json(400, { error: "Ação ou canal de demonstração inválido." });
    }
    const channelId = body.channel_id;
    const { data: channel, error: channelError } = await admin
      .from("channels")
      .select("id, tenant_id, type, provider_slug, status")
      .eq("id", channelId)
      .eq("tenant_id", tenantId)
      .eq("type", "simulator")
      .eq("provider_slug", "simulator")
      .maybeSingle();
    if (channelError) throw channelError;
    if (
      !channel || channel.tenant_id !== tenantId ||
      channel.type !== "simulator" || channel.provider_slug !== "simulator"
    ) {
      return json(404, { error: "Canal de demonstração não encontrado." });
    }
    if (channel.status !== "connected") {
      return json(409, { error: "Ative o canal de demonstração em Integrações." });
    }
    const { data: feature, error: featureError } = await admin
      .from("tenant_ai_features")
      .select("enabled")
      .eq("tenant_id", tenantId)
      .eq("feature_key", "channel_simulator")
      .maybeSingle();
    if (featureError) throw featureError;
    if (feature?.enabled !== true) {
      return json(403, {
        error: "O administrador precisa ativar o canal de demonstração.",
      });
    }
    const { data: integration, error: integrationError } = await admin
      .from("tenant_integrations")
      .select("status")
      .eq("tenant_id", tenantId)
      .eq("slug", "simulator")
      .maybeSingle();
    if (integrationError) throw integrationError;
    if (integration?.status !== "active") return json(409, { error: "Canal de demonstração desativado." });

    const content = typeof body.content === "string" ? body.content.trim() : "";
    if (content.length > 8000 || (!content && !body.media)) {
      return json(400, { error: "Envie texto (até 8.000 caracteres), imagem ou áudio." });
    }
    if (
      body.conversation_id !== undefined &&
      (typeof body.conversation_id !== "string" || !UUID_RE.test(body.conversation_id))
    ) {
      return json(400, { error: "Conversa inválida." });
    }
    if (
      !body.conversation_id && body.client_id !== undefined &&
      (typeof body.client_id !== "string" || !UUID_RE.test(body.client_id))
    ) {
      return json(400, { error: "Identificador do cliente simulado inválido." });
    }
    const { data: limit, error: limitError } = await admin.rpc("check_and_record_rate_limit", {
      p_key: `channel-simulator:${tenantId}:${user.user.id}`,
      p_max_calls: 20,
      p_window_seconds: 60,
    });
    if (limitError) throw limitError;
    const rate = Array.isArray(limit) ? limit[0] : limit;
    if (rate?.allowed !== true) {
      return json(429, {
        error: "Limite de 20 mensagens por minuto atingido. Aguarde um minuto.",
      });
    }

    let media: InboundMessage["media"];
    if (body.media) {
      if (typeof body.media !== "object" || Array.isArray(body.media)) {
        return json(400, { error: "Anexo inválido." });
      }
      const attachment = body.media as Record<string, unknown>;
      if (typeof attachment.type !== "string" || MEDIA_TYPES[attachment.type] !== true) {
        return json(400, { error: "Formato de imagem ou áudio não suportado." });
      }
      if (typeof attachment.storage_path === "string") {
        const prefix = `${tenantId}/simulator/${channelId}/`;
        if (
          !attachment.storage_path.startsWith(prefix) ||
          !/^[a-zA-Z0-9._-]+$/.test(attachment.storage_path.slice(prefix.length)) ||
          attachment.storage_path.includes("..")
        ) {
          return json(400, { error: "O anexo precisa pertencer a este canal e tenant." });
        }
        const { data: signed, error } = await admin.storage
          .from("simulator-media")
          .createSignedUrl(attachment.storage_path, 7 * 24 * 60 * 60);
        if (error || !signed?.signedUrl) {
          return json(400, { error: "Anexo não encontrado. Envie o arquivo novamente." });
        }
        media = { url: signed.signedUrl, type: attachment.type };
      } else if (typeof attachment.url === "string") {
        const valid = await validatePublicHttpsUrl(attachment.url);
        if (!valid.ok) return json(400, { error: valid.error });
        media = { url: attachment.url, type: attachment.type };
      } else return json(400, { error: "Informe a URL pública ou envie o anexo." });
    }

    let identity = `simulator:${channelId}:${body.client_id ?? crypto.randomUUID()}`;
    if (typeof body.conversation_id === "string") {
      const { data: conversation, error } = await admin
        .from("conversations")
        .select("id, contact_id, tenant_id, channel_id, status")
        .eq("id", body.conversation_id)
        .eq("tenant_id", tenantId)
        .eq("channel_id", channelId)
        .is("deleted_at", null)
        .maybeSingle();
      if (error) throw error;
      if (
        !conversation || conversation.tenant_id !== tenantId ||
        conversation.channel_id !== channelId
      ) {
        return json(404, { error: "Conversa de demonstração não encontrada." });
      }
      if (conversation.status !== "open") {
        return json(409, { error: "Reabra a conversa antes de simular uma resposta." });
      }
      const { data: identities, error: identityError } = await admin
        .from("contact_identities")
        .select("external_id")
        .eq("tenant_id", tenantId)
        .eq("contact_id", conversation.contact_id)
        .eq("provider_slug", "simulator")
        .eq("identity_type", "provider_user")
        .limit(1);
      if (identityError) throw identityError;
      identity = identities?.[0]?.external_id ?? `simulator:${channelId}:${conversation.contact_id}`;
      const synced = await ensureContactIdentity(admin, {
        tenantId,
        contactId: conversation.contact_id,
        type: "provider_user",
        rawValue: identity,
        providerSlug: "simulator",
      });
      if (synced !== "created" && synced !== "existing") {
        throw new Error("Não foi possível vincular o cliente simulado.");
      }
    }
    const result = await persistInbound(admin, tenantId, channelId, "simulator", "simulator", {
      provider: "simulator",
      external_id: `simulator:in:${crypto.randomUUID()}`,
      from: identity,
      to: channelId,
      content,
      media,
      timestamp: new Date().toISOString(),
      fromMe: false,
      senderName: "Cliente simulado",
    });
    if (!result.messageId || !result.contactId) {
      throw new Error("Não foi possível registrar a mensagem simulada.");
    }
    await cancelNurtureOnReply(admin, tenantId, result.contactId);
    const job = await enqueueAIResponseJob(admin, tenantId, result.messageId);
    // A demo é ao vivo: dispatch imediato com o mesmo job durável e os mesmos gates de takeover.
    if (job.shouldDispatch) {
      await runInBackground(
        triggerAiRespond(admin, supabaseUrl, serviceRole, tenantId, result.messageId, job.jobId),
      );
    }
    return json(200, {
      ok: true,
      simulated: true,
      message_id: result.messageId,
      conversation_id: result.conversationId,
      contact_id: result.contactId,
    });
  } catch (error) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "channel_simulator.send",
      tenantId,
      message: error instanceof Error ? error.message : String(error),
    });
    return json(503, {
      error: "Não foi possível concluir a simulação. Confira o histórico antes de tentar novamente.",
    });
  }
});
