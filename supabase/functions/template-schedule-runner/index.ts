// Worker dormente de broadcast agendado (Fase 4 do PRD — user story C).
// SEM cron.schedule: processa template_schedules pendentes vencidos e as
// execuções (1 por contato) já geradas, uma invocação por chamada. Ligar de
// verdade (pg_cron real ou scheduler externo) fica para uma fase futura,
// fora de escopo aqui — mesmo racional de hitl-sla-monitor/index.ts e
// nurture-auto-enroll-scanner/index.ts.
//
// Toda a regra de negócio (expansão de audiência, claims atômicos, guards de
// 24h/supressão/frequência, envio) mora em runner.ts — este arquivo só faz
// auth + wiring, para o handler ficar testável sem depender de Deno.serve.
//
// Auth: MESMO padrão fail-closed de hitl-sla-monitor/index.ts (bearer ===
// SUPABASE_SERVICE_ROLE_KEY, comparação direta) — não é rota pública nem
// aceita JWT de usuário; pensada para ser chamada por um processo
// server-side. Nota: a tarefa original pedia "HMAC constant-time", mas não
// existe nenhum helper de comparação constant-time neste repo (grep
// confirmado nesta sessão) — inventar um aqui destoaria do padrão real de
// todo o resto da Fase 3/4. Copiado literalmente o mesmo bearer-compare de
// hitl-sla-monitor, como o restante da tarefa também instruiu.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runTemplateScheduleRunner } from "./runner.ts";
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

  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const summary = await runTemplateScheduleRunner(admin);
    if (summary.failed > 0 || summary.errors.length > 0) {
      // Erro isolado por execução/schedule (runner.ts try/catch por item)
      // nunca lança daqui -- só vira evento consultável. Sempre "warn": o
      // runner isola por item e `failed` conta desfechos terminais que nem
      // sempre populam `errors` (ver processExecution), então não há campo
      // único e confiável pra distinguir falha parcial de perda total do
      // batch aqui -- "error" fica reservado pro catch abaixo.
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "template.schedule_runner",
        message: `Template schedule runner processou ${summary.executionsClaimed} execução(ões) com ${summary.failed} falha(s) e ${summary.errors.length} erro(s) de log.`,
        context: { failure_point: "summary", ...summary },
      });
    }
    return json(200, summary);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error("[template-schedule-runner] falha inesperada na execução:", msg);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "template.schedule_runner",
      message: msg,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { failure_point: "handler" },
    });
    return json(500, { error: msg });
  }
});
