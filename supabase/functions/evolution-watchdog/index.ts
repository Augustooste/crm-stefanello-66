// Watchdog dormente de reconexão automática de canais Evolution
// (WhatsApp self-hosted) caídos — Fase 5 do PRD. SEM cron.schedule: fica
// para um scheduler futuro (fora de escopo aqui). Toda a lógica de
// negócio (query genérica + reconexão + persistência) vive em runner.ts;
// este arquivo só faz I/O (auth + client + chamada) -- mesmo padrão de
// hitl-sla-monitor/index.ts e weekly-digest-generator/index.ts.
//
// Auth: MESMO padrão fail-closed dos dois arquivos acima (bearer ===
// SUPABASE_SERVICE_ROLE_KEY, comparação simples de string) -- não é rota
// pública nem aceita JWT de usuário.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { runEvolutionWatchdog } from "./runner.ts";
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

  // Fail-closed: só aceita bearer = service role. Não é rota pública nem
  // chamada com JWT de usuário; pensada para ser chamada por um processo
  // server-side (scheduler futuro).
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const summary = await runEvolutionWatchdog({ admin });
    if (summary.stillDown > 0 || summary.errors.length > 0) {
      // Falha isolada por canal (processChannel captura por item) nunca
      // lança daqui -- só vira evento consultável. "error" só quando NENHUM
      // canal escaneado reconectou/ficou aguardando QR (perda total do
      // batch); do contrário é falha parcial ("warn").
      const totalWipeout =
        (summary.scanned === 0 && summary.errors.length > 0) ||
        (summary.scanned > 0 && summary.stillDown === summary.scanned);
      await captureEdgeError(admin, {
        severity: totalWipeout ? "error" : "warn",
        source: "edge",
        operation: "evolution.watchdog",
        message: `Watchdog Evolution processou ${summary.scanned} canal(is): ${summary.stillDown} ainda caído(s), ${summary.errors.length} erro(s).`,
        context: { failure_point: "summary", ...summary },
      });
    }
    return json(200, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[evolution-watchdog] falha ao reconectar canais Evolution:", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "evolution.watchdog",
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { failure_point: "handler" },
    });
    return json(500, { error: message });
  }
});
