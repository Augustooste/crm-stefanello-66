// Reconciliação dormente de status/webhook_health de canais (Fase 5 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md, "Multi-canal genérico"). SEM cron.schedule:
// 100% da lógica de negócio (query genérica de canais, cálculo de
// webhook_health, checagem de status Evolution) vive em runner.ts; este
// arquivo só faz I/O (auth + client + chamada). Ligar de verdade (pg_cron
// real ou scheduler externo) fica para uma fase futura, fora de escopo aqui.
//
// Auth: MESMO padrão fail-closed de hitl-sla-monitor/index.ts e
// nurture-runner/index.ts (bearer === SUPABASE_SERVICE_ROLE_KEY) -- não é
// rota pública nem aceita JWT de usuário.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runMessagingChannelsReconcile } from "./runner.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

interface RunBody {
  limit?: number;
}

async function parseLimit(req: Request): Promise<number | undefined> {
  try {
    const body = (await req.json()) as RunBody;
    const limit = body?.limit;
    return typeof limit === "number" && Number.isFinite(limit) && limit > 0 ? limit : undefined;
  } catch {
    // Corpo ausente/vazio/inválido -- roda com o default do runner, não é erro.
    return undefined;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: só aceita bearer = service role (mesmo padrão de
  // hitl-sla-monitor/index.ts e nurture-runner/index.ts). Não é rota
  // pública nem chamada com JWT de usuário; pensada para ser chamada por um
  // processo server-side (cron futuro).
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const limit = await parseLimit(req);

  try {
    const summary = await runMessagingChannelsReconcile({ admin, supabaseUrl: SUPABASE_URL }, { limit });
    if (summary.errors.length > 0) {
      // Erro isolado por canal/checagem (runner.ts tem try/catch próprio
      // pra webhook_health e pra status Evolution) nunca lança daqui -- só
      // vira evento consultável. Sempre "warn": webhookHealthChanged=0 e
      // statusChanged=0 não indicam falha total, só "nada mudou" (caso são
      // normal quando os canais já estavam corretos) -- "error" fica
      // reservado pro catch abaixo.
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "messaging.channels_reconcile",
        message: `Reconciliação de canais processou ${summary.channelsProcessed} canal(is) com ${summary.errors.length} falha(s).`,
        context: { failure_point: "summary", ...summary },
      });
    }
    return json(200, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[messaging-channels-reconcile] falha ao buscar/processar o lote de canais:", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "messaging.channels_reconcile",
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { failure_point: "handler" },
    });
    return json(500, { error: message });
  }
});
