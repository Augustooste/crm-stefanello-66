// voice-call-poller — cron (a cada minuto) que busca na ElevenLabs o resultado
// das Ligações IA em andamento. Auth: bearer === service role (mesmo padrão
// fail-closed de template-schedule-runner); não é rota pública.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { pollElevenLabsCalls } from "../_shared/voice/poller.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

// Ligações mais velhas que isso são expiradas por request_voice_call (2h).
const MAX_AGE_MS = 3 * 60 * 60 * 1000;

Deno.serve(async (req: Request) => {
  if (req.method !== "POST") return new Response("Method not allowed", { status: 405 });
  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const summary = await pollElevenLabsCalls({
      listActiveCalls: async () => {
        const { data, error } = await admin
          .from("voice_calls")
          .select("id, tenant_id, provider_call_id")
          .eq("provider", "elevenlabs")
          .in("status", ["initiating", "ringing", "answered"])
          .not("provider_call_id", "is", null)
          .gte("created_at", new Date(Date.now() - MAX_AGE_MS).toISOString())
          .limit(50);
        if (error) throw new Error(`Falha ao listar ligações ativas: ${error.message}`);
        return data ?? [];
      },
      loadApiKey: async (tenantId) => {
        const { data, error } = await admin
          .from("integration_secrets")
          .select("value")
          .eq("tenant_id", tenantId)
          .eq("slug", "elevenlabs")
          .eq("key", "api_key")
          .maybeSingle();
        if (error) throw new Error(`Falha ao ler chave ElevenLabs: ${error.message}`);
        return (data?.value as string | undefined) ?? null;
      },
      applyEvent: async (event) => {
        const { data, error } = await admin.rpc("apply_voice_call_event", { p_event: event });
        if (error) throw new Error(`Falha ao aplicar evento ${event.event_id}: ${error.message}`);
        return data as { result: string; status?: string };
      },
    });
    if (summary.errors.length > 0) {
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "voice.call_poller",
        message:
          `Poller de ligações: ${summary.errors.length} erro(s) em ${summary.polled} consulta(s).`,
        context: { ...summary },
      });
    }
    return new Response(JSON.stringify(summary), {
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "voice.call_poller",
      message: msg,
      context: { failure_point: "handler" },
    });
    return new Response(JSON.stringify({ error: msg }), { status: 500 });
  }
});
