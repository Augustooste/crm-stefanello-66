// Scanner dormente de auto-enrollment (stagnant + periodic) — Fase 4 do PRD
// (docs/PRD-CRM-IA-MULTINICHO.md, user story D). SEM cron.schedule: a RPC
// `enroll_stagnant_and_periodic_nurture()`
// (supabase/migrations/20260710140000_fase4_nurture_schema.sql) já existe e
// já concentra 100% da lógica de negócio (idempotência via índice único
// parcial, guardrails de stagnant_days/periodic_days, DISTINCT ON pra não
// duplicar candidatos dentro do mesmo INSERT) — este arquivo só chama a RPC
// via service_role e loga o resultado. Ligar de verdade (pg_cron real) fica
// para uma fase Backend futura, fora de escopo aqui.
//
// Auth: MESMO padrão fail-closed de hitl-sla-monitor/index.ts (bearer ===
// SUPABASE_SERVICE_ROLE_KEY), copiado literalmente — não é rota pública nem
// aceita JWT de usuário; pensada para ser chamada por um processo
// server-side (futuro pg_cron ou scheduler externo).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { formatEnrollSummary, parseEnrollCounts } from "./logic.ts";
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

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: só aceita bearer = service role (mesmo padrão de
  // hitl-sla-monitor/index.ts). Não é rota pública nem chamada com JWT de
  // usuário.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  // Sem try/catch de topo antes desta instrumentação: uma exceção não
  // tratada (ex.: parseEnrollCounts/formatEnrollSummary quebrando com um
  // shape inesperado da RPC) virava 500 opaco do runtime, sem log
  // consultável. Cobre tanto isso quanto o ramo `{ data, error }` abaixo.
  try {
    const { data, error } = await admin.rpc("enroll_stagnant_and_periodic_nurture");

    if (error) {
      // Nunca engolir: se a RPC falhar, o log tem que deixar isso visível pra
      // quem for investigar por que o auto-enrollment parou de rodar.
      console.error(
        "[nurture-auto-enroll-scanner] RPC enroll_stagnant_and_periodic_nurture falhou:",
        error.message,
      );
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "nurture.auto_enroll_scanner",
        message: error.message,
        context: { failure_point: "rpc", db_code: error.code ?? null },
      });
      // Detalhe fica só no log acima — não devolver error.message cru do
      // Postgres ao caller (padrão sanitizeProviderError do resto do projeto).
      return json(500, { error: "Falha ao executar auto-enrollment — ver logs da function." });
    }

    const counts = parseEnrollCounts(data);
    const summary = formatEnrollSummary(counts);
    console.log(`[nurture-auto-enroll-scanner] ${summary}`);

    return json(200, { ...counts, summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[nurture-auto-enroll-scanner] falha inesperada:", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "nurture.auto_enroll_scanner",
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { failure_point: "handler" },
    });
    return json(500, { error: "Falha ao executar auto-enrollment — ver logs da function." });
  }
});
