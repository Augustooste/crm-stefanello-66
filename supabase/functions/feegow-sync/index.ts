// feegow-sync/index.ts — I/O fino do sync de agendamentos Feegow (Fase 6,
// Sub-feature 2). Toda a lógica de negócio (mapeamento, upsert idempotente,
// isolamento por tenant via Promise.allSettled) vive em runner.ts; este
// arquivo só faz auth + monta o client real + chama runFeegowSync. NÃO é
// webhook -- disparado por cron (ver RUNBOOK no fim da migration
// 20260712150000_fase6_feegow_sync_log.sql) ou manualmente via
// `supabase functions invoke feegow-sync` para teste.
//
// Auth: mesmo padrão fail-closed de messaging-channels-reconcile/index.ts,
// hitl-sla-monitor/index.ts e nurture-runner/index.ts (bearer ===
// SUPABASE_SERVICE_ROLE_KEY) -- não é rota pública nem aceita JWT de
// usuário; pensada para ser chamada por um processo server-side (cron).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runFeegowSync } from "./runner.ts";
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

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });
  const limit = await parseLimit(req);

  try {
    const summary = await runFeegowSync({ admin }, { limit });
    if (summary.tenantsFailed > 0 || summary.errors.length > 0) {
      // Erro isolado por tenant (Promise.allSettled em runner.ts) nunca
      // lança daqui -- só vira evento consultável. "error" só quando 100%
      // dos tenants processados falharam; do contrário é falha parcial
      // ("warn").
      const totalWipeout = summary.tenantsProcessed > 0 && summary.tenantsFailed === summary.tenantsProcessed;
      await captureEdgeError(admin, {
        severity: totalWipeout ? "error" : "warn",
        source: "edge",
        operation: "feegow.sync",
        message: `Feegow sync processou ${summary.tenantsProcessed} tenant(s) com ${summary.tenantsFailed} falha(s).`,
        context: { failure_point: "summary", ...summary },
      });
    }
    return json(200, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[feegow-sync] falha ao buscar/processar integrações ativas:", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "feegow.sync",
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { failure_point: "handler" },
    });
    return json(500, { error: message });
  }
});
