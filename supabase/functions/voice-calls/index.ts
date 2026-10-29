// voice-calls — "Ligar com IA" (create) e cancelamento, chamado pelo app com o
// JWT do usuário. Toda regra de negócio está em public.request_voice_call /
// request_voice_call_cancel (SQL, com o JWT) e em _shared/voice/handlers.ts.
// Esta function nunca faz streaming de áudio: só entrega o pedido ao Voice Service.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { handleVoiceCalls } from "../_shared/voice/handlers.ts";
import { resolveProviderForTenant } from "../_shared/voice/provider.ts";
import type { VoiceEvent } from "../_shared/voice/contract.ts";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const ANON = Deno.env.get("SUPABASE_ANON_KEY")!;
const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

Deno.serve((req) => {
  const auth = { persistSession: false, autoRefreshToken: false };
  const userClient = createClient(SUPABASE_URL, ANON, {
    auth,
    global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth });

  return handleVoiceCalls(req, {
    getUserId: async () => {
      const { data, error } = await userClient.auth.getUser();
      return error || !data.user ? null : data.user.id;
    },
    userRpc: async (fn, args) => await userClient.rpc(fn, args),
    updateCall: async (callId, fromStatus, patch) => {
      const { error } = await admin.from("voice_calls").update(patch).eq("id", callId).eq(
        "status",
        fromStatus,
      );
      if (error) throw new Error(`Falha ao atualizar ligação ${callId}: ${error.message}`);
    },
    applyEvent: async (event: VoiceEvent) => {
      const { data, error } = await admin.rpc("apply_voice_call_event", { p_event: event });
      if (error) throw new Error(`Falha ao aplicar evento ${event.event_id}: ${error.message}`);
      return data as { result: string; status?: string };
    },
    loadProvider: async () => {
      const env = (name: string) => Deno.env.get(name);
      const { data, error } = await userClient.rpc("voice_call_settings");
      if (error || !data) {
        return {
          tenantId: null,
          provider: { ok: false, error: "Não foi possível ler a configuração de voz." },
        };
      }
      const s = data as {
        tenant_id: string;
        integration_active: boolean;
        agent_id: string | null;
        phone_number_id: string | null;
      };
      let apiKey: string | null = null;
      if (s.integration_active) {
        const { data: secret, error: secretError } = await admin
          .from("integration_secrets")
          .select("value")
          .eq("tenant_id", s.tenant_id)
          .eq("slug", "elevenlabs")
          .eq("key", "api_key")
          .maybeSingle();
        if (secretError) throw new Error(`Falha ao ler chave ElevenLabs: ${secretError.message}`);
        apiKey = (secret?.value as string | undefined) ?? null;
      }
      return {
        tenantId: s.tenant_id,
        provider: await resolveProviderForTenant(env, {
          apiKey,
          agentId: s.agent_id,
          phoneNumberId: s.phone_number_id,
        }),
      };
    },
    callbackUrl: `${SUPABASE_URL.replace(/\/+$/, "")}/functions/v1/voice-call-webhook`,
  });
});
