// voice-call-webhook — eventos assinados de ligação. Sem JWT (config.toml
// verify_jwt=false): a autorização é sempre uma assinatura HMAC, validada
// antes de gravar qualquer coisa.
//   - Header ElevenLabs-Signature: webhook pós-chamada da ElevenLabs
//     (_shared/voice/elevenlabs-webhook.ts), segredo por tenant.
//   - Senão: Voice Service, contrato v1 (docs/VOICE-SERVICE-CONTRACT.md),
//     _shared/voice/handlers.ts::handleVoiceWebhook.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { handleVoiceWebhook } from "../_shared/voice/handlers.ts";
import {
  ELEVENLABS_SIGNATURE_HEADER,
  handleElevenLabsWebhook,
} from "../_shared/voice/elevenlabs-webhook.ts";
import type { VoiceEvent } from "../_shared/voice/contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve((req) => {
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const applyEvent = async (event: VoiceEvent) => {
    const { data, error } = await admin.rpc("apply_voice_call_event", { p_event: event });
    if (error) throw new Error(`Falha ao aplicar evento de ligação: ${error.message}`);
    return data as { result: string; status?: string };
  };

  if (req.headers.has(ELEVENLABS_SIGNATURE_HEADER)) {
    return handleElevenLabsWebhook(req, {
      applyEvent,
      findCall: async (conversationId) => {
        const { data, error } = await admin
          .from("voice_calls")
          .select("id, tenant_id, provider_call_id")
          .eq("provider", "elevenlabs")
          .eq("provider_call_id", conversationId)
          .maybeSingle();
        if (error) throw new Error(`Falha ao buscar ligação: ${error.message}`);
        return data;
      },
      loadSecret: async (tenantId) => {
        const { data, error } = await admin
          .from("integration_secrets")
          .select("value")
          .eq("tenant_id", tenantId)
          .eq("slug", "elevenlabs")
          .eq("key", "webhook_secret")
          .maybeSingle();
        if (error) throw new Error(`Falha ao ler segredo do webhook: ${error.message}`);
        return (data?.value as string | undefined) ?? null;
      },
    });
  }

  return handleVoiceWebhook(req, {
    secret: Deno.env.get("VOICE_SERVICE_SECRET"),
    applyEvent,
  });
});
