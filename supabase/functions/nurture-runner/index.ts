// Motor dormente de envio de sequências de nutrição (Fase 4 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md, user story A). SEM cron.schedule: 100% da
// lógica de negócio (claim atômico, supressão, guard de frequência,
// avanço/retry) vive em runner.ts; este arquivo só faz I/O (auth + client +
// chamada). Ligar de verdade (pg_cron real ou scheduler externo) fica para
// uma fase futura, fora de escopo aqui.
//
// Auth: MESMO padrão fail-closed de hitl-sla-monitor/index.ts (bearer ===
// SUPABASE_SERVICE_ROLE_KEY) -- não é rota pública nem aceita JWT de usuário.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runNurtureRunner } from "./runner.ts";
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
  // hitl-sla-monitor/index.ts). Não é rota pública nem chamada com JWT de
  // usuário; pensada para ser chamada por um processo server-side.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const limit = await parseLimit(req);

  try {
    const summary = await runNurtureRunner({ admin }, { limit });
    if (summary.errors.length > 0) {
      // Erro isolado por enrollment (runner.ts try/catch por item) nunca
      // lança daqui -- só vira evento consultável. "error" só quando 100%
      // do batch reivindicado terminou em erro/retry; do contrário é falha
      // parcial ("warn").
      const totalWipeout = summary.processed > 0 && summary.errors.length >= summary.processed;
      await captureEdgeError(admin, {
        severity: totalWipeout ? "error" : "warn",
        source: "edge",
        operation: "nurture.runner",
        message: `Nurture runner processou ${summary.processed} enrollment(s) com ${summary.errors.length} falha(s).`,
        context: { failure_point: "summary", ...summary },
      });
    }
    return json(200, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[nurture-runner] falha ao reivindicar/processar o batch:", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "nurture.runner",
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { failure_point: "handler" },
    });
    return json(500, { error: message });
  }
});
