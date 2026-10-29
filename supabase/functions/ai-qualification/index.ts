// AI Qualification — gera um snapshot de qualificação estruturado para um
// deal, sob demanda (POST {dealId}). Qualquer usuário autenticado do MESMO
// tenant do deal pode disparar (não é admin-only como ai-insights: é uma
// ferramenta de preparação de vendedor para o próprio deal, não um relatório
// gerencial). Auth + CORS seguem o mesmo padrão de ai-insights/index.ts.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { generateQualificationSnapshot } from "../_shared/ai/qualification.ts";
import { reportAIFailure } from "../_shared/ai/failure-log.ts";
import { sanitizeProviderError } from "../_shared/ai/errors.ts";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";

// Teto conservador: ferramenta sob demanda de vendedor (não um loop
// automático como ai-respond), mas ainda assim uma chamada LLM cobrada por
// token — sem teto, um clique nervoso repetido ou um bug de retry no
// front-end vira custo sem controle. 3 chamadas/60s por deal cobre o caso de
// uso real (gerar, ajustar contexto, gerar de novo) sem travar o vendedor.
const AI_QUALIFICATION_RATE_LIMIT_MAX_CALLS = 3;
const AI_QUALIFICATION_RATE_LIMIT_WINDOW_MS = 60_000;

// Mesma allowlist por sufixo/env de ai-insights/index.ts (Audit #4: CORS por
// allowlist em vez de "*").
function buildCors(req: Request): Record<string, string> {
  const origin = req.headers.get("Origin") ?? "";
  const extra = (Deno.env.get("ALLOWED_ORIGINS") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  let allowed = false;
  if (origin) {
    if (extra.includes(origin)) allowed = true;
    else {
      try {
        const host = new URL(origin).hostname;
        allowed =
          host.endsWith(".lovable.app") ||
          host.endsWith(".lovableproject.com") ||
          host.endsWith(".sandbox.lovable.dev") ||
          host === "localhost" ||
          host === "127.0.0.1";
      } catch {
        allowed = false;
      }
    }
  }
  return {
    "Access-Control-Allow-Origin": allowed ? origin : "null",
    Vary: "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

interface Body {
  dealId?: string;
}

Deno.serve(async (req) => {
  const cors = buildCors(req);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { ...cors, "content-type": "application/json" },
    });
  if (req.method === "OPTIONS") return new Response(null, { headers: cors });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  const prof = await loadProfileOrFail(admin, userData.user.id, {
    operation: "ai.qualification.load_profile",
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    return json(403, { error: "Perfil não encontrado." });
  }
  const tenantId = prof.tenantId;

  // Catch de topo: tudo daqui pra baixo (parse de body, lookup de deal, rate
  // limit) não tinha nenhum sink antes — só o bloco de geração (try interno
  // abaixo) já reportava via reportAIFailure. tenantId já resolvido acima,
  // então o evento sai correlacionável mesmo quando o throw é de infra.
  try {
    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json(400, { error: "Corpo inválido." });
    }
    const dealId = body.dealId;
    if (!dealId || typeof dealId !== "string") {
      return json(400, { error: "dealId obrigatório." });
    }

    // Checagem de tenant ANTES de gerar: generateQualificationSnapshot usa o
    // client service_role (bypassa RLS de propósito para montar o contexto
    // completo), então a checagem de posse do deal é responsabilidade daqui.
    const { data: dealRow } = await admin
      .from("deals")
      .select("tenant_id")
      .eq("id", dealId)
      .maybeSingle();
    if (!dealRow || (dealRow.tenant_id as string) !== tenantId) {
      return json(404, { error: "Deal não encontrado." });
    }

    // Rate limit por deal (chave própria "ai-qualification:<dealId>", não
    // compartilha janela com o rate limit de "ai-agent:<conversationId>" do
    // ai-respond) — evita chamada LLM em loop sob demanda do vendedor.
    const rateLimit = await checkRateLimit(
      admin,
      `ai-qualification:${dealId}`,
      AI_QUALIFICATION_RATE_LIMIT_MAX_CALLS,
      AI_QUALIFICATION_RATE_LIMIT_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      // rpcFailed=true = a RPC em si quebrou (banco fora do ar, etc.) — não é
      // um rate-limit legítimo, é uma falha de infra fail-closed disfarçada de
      // rate limit (mesma distinção de ai-respond/index.ts, seção "Rate
      // limit"). Reporta e responde 500 (erro de infra) em vez de 429
      // (rate-limit normal), pra não confundir o vendedor achando que só
      // precisa esperar a janela passar.
      if (rateLimit.rpcFailed) {
        console.error("ai-qualification rate_limit_rpc_failed", { tenantId, dealId });
        await reportAIFailure(admin, {
          tenantId,
          route: "ai-qualification.rate-limit",
          errorCode: "UNKNOWN",
          errorMessage: "RPC check_and_record_rate_limit falhou; negado por fail-closed.",
          context: { dealId },
        });
        return json(500, { error: "Erro ao verificar limite de uso. Tente novamente em instantes." });
      }
      const retryAfterSeconds = Math.ceil(
        (rateLimit.retryAfterMs ?? AI_QUALIFICATION_RATE_LIMIT_WINDOW_MS) / 1000,
      );
      console.log("ai-qualification rate_limited", { tenantId, dealId, retryAfterSeconds });
      return json(429, {
        error: "Muitas gerações de qualificação para este deal. Tente novamente em instantes.",
        retryAfterSeconds,
      });
    }

    try {
      const snapshot = await generateQualificationSnapshot(admin, dealId);
      return json(200, { snapshot });
    } catch (err) {
      const aiError = sanitizeProviderError(err);
      console.error("ai-qualification falhou", { tenantId, dealId, error: aiError.message });
      await reportAIFailure(admin, {
        tenantId,
        route: "ai-qualification",
        provider: aiError.provider ?? "lovable",
        model: "google/gemini-3-flash-preview",
        statusCode: aiError.statusCode ?? null,
        errorCode: aiError.code,
        errorMessage: aiError.message,
        context: { dealId },
      });
      return json(500, { error: aiError.message });
    }
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.qualification.handler",
      tenantId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro ao gerar qualificação." });
  }
});
