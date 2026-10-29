// Preparar reunião — briefing de UM negócio antes da call do vendedor.
//
// Diferente de ai-deal-chat/ai-copilot, o front manda só `dealId`: todo fato
// (empresa, contato, cargo, valor, estágio, reunião) é lido aqui e devolvido
// em `facts`, que a UI renderiza direto. A IA recebe esses fatos e devolve só
// `generated` (resumo, hipóteses, perguntas, pontos de atenção), filtrado por
// sanitizeGenerated. Ver _shared/meeting-prep.ts.
//
// Autorização: loadProfileOrFail (membership ativa) + TODAS as leituras de
// dados pelo client com o JWT do usuário (RLS vale) e com tenant_id explícito.
// O service_role só serve ao rate limit e à telemetria.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import { callLovableGateway, LovableGatewayHttpError } from "../_shared/ai/gateway.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  type ActivityRow,
  buildMeetingFacts,
  buildPromptContext,
  type CompanyRow,
  type ContactRow,
  type DealRow,
  type GeneratedBriefing,
  MEETING_PREP_SYSTEM_PROMPT,
  parseGenerated,
  sanitizeGenerated,
} from "../_shared/meeting-prep.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_MODEL = "google/gemini-3-flash-preview";
const AI_TIMEOUT_MS = 45_000;
const AI_MAX_OUTPUT_TOKENS = 1200;
const RATE_LIMIT_MAX_CALLS = 6;
const RATE_LIMIT_WINDOW_MS = 60_000;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/** Erro de leitura vira exceção — nunca "zero resultados" silencioso. */
function must<T>(res: { data: T; error: { message: string } | null }, what: string): T {
  if (res.error) throw new Error(`Falha ao ler ${what}: ${res.error.message}`);
  return res.data;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  const prof = await loadProfileOrFail(admin, userData.user.id, {
    operation: "ai.prepare_meeting.load_profile",
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    return json(403, { error: "Perfil não encontrado." });
  }
  const tenantId = prof.tenantId;

  let dealId = "";
  try {
    const body = (await req.json()) as { dealId?: unknown };
    dealId = typeof body.dealId === "string" ? body.dealId : "";
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  if (!UUID_RE.test(dealId)) return json(400, { error: "dealId inválido." });

  try {
    const deal = must(
      await userClient
        .from("deals")
        .select("title, value, status, owner_id, board_id, stage_id, contact_id")
        .eq("id", dealId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      "negócio",
    ) as (DealRow & { board_id: string; stage_id: string; contact_id: string | null }) | null;
    // 404 (não 403): não revela se o id existe em outro tenant.
    if (!deal) return json(404, { error: "Negócio não encontrado." });

    const rateLimit = await checkRateLimit(
      admin,
      `prepare-meeting:${dealId}`,
      RATE_LIMIT_MAX_CALLS,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      if (rateLimit.rpcFailed) {
        return json(500, {
          error: "Erro ao verificar limite de uso. Tente novamente em instantes.",
        });
      }
      return json(429, {
        error: "Muitas preparações para este negócio. Tente novamente em instantes.",
        retryAfterSeconds: Math.ceil((rateLimit.retryAfterMs ?? RATE_LIMIT_WINDOW_MS) / 1000),
      });
    }

    const [stage, contact, activities, owner] = await Promise.all([
      userClient
        .from("board_stages")
        .select("name")
        .eq("id", deal.stage_id)
        // board_stages não tem tenant_id: o escopo vem do board do negócio,
        // que já foi lido com tenant_id acima.
        .eq("board_id", deal.board_id)
        .maybeSingle(),
      deal.contact_id
        ? userClient
            .from("contacts")
            .select("name, job_title, email, phone, description, notes, address_city, company_id")
            .eq("id", deal.contact_id)
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .maybeSingle()
        : Promise.resolve({ data: null, error: null }),
      userClient
        .from("activities")
        .select("type, title, due_at, completed_at")
        .eq("deal_id", dealId)
        .eq("tenant_id", tenantId)
        .order("due_at", { ascending: true })
        .limit(50),
      deal.owner_id
        ? userClient.from("profiles").select("name").eq("id", deal.owner_id).maybeSingle()
        : Promise.resolve({ data: null, error: null }),
    ]);
    const contactRow = must(contact, "contato") as
      (ContactRow & { company_id: string | null }) | null;

    const company = contactRow?.company_id
      ? (must(
          await userClient
            .from("crm_companies")
            .select("name, industry")
            .eq("id", contactRow.company_id)
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .maybeSingle(),
          "empresa",
        ) as CompanyRow | null)
      : null;

    const facts = buildMeetingFacts({
      deal,
      stageName: (must(stage, "estágio") as { name: string } | null)?.name ?? null,
      // Nome do responsável é enfeite: RLS de profiles pode não liberar — sem throw.
      ownerName: (owner.data as { name: string | null } | null)?.name ?? null,
      contact: contactRow,
      company,
      activities: (must(activities, "atividades") as ActivityRow[] | null) ?? [],
      now: new Date(),
    });

    let generated: GeneratedBriefing | null = null;
    let aiError: string | null = null;
    let rejected: string[] = [];
    try {
      const raw = await callLovableGateway(
        MEETING_PREP_SYSTEM_PROMPT,
        [{ role: "user", content: `Contexto do CRM:\n${buildPromptContext(facts)}` }],
        AI_MODEL,
        {
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          responseFormat: { type: "json_object" },
          timeoutMs: AI_TIMEOUT_MS,
        },
      );
      const parsed = parseGenerated(raw);
      if (!parsed) {
        aiError = "A IA devolveu um formato inválido. Os fatos do CRM abaixo continuam válidos.";
      } else {
        ({ briefing: generated, rejected } = sanitizeGenerated(parsed, facts));
      }
    } catch (e) {
      const status = e instanceof LovableGatewayHttpError ? e.statusCode : null;
      aiError =
        status === 402
          ? "Créditos de IA esgotados. Os fatos do CRM abaixo continuam válidos."
          : "Não foi possível gerar as sugestões da IA agora. Os fatos do CRM abaixo continuam válidos.";
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.prepare_meeting.gateway",
        tenantId,
        dealId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (rejected.length > 0)
      console.log("prepare-meeting rejected", { tenantId, dealId, rejected });

    return json(200, { facts, generated, aiError, rejectedCount: rejected.length });
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.prepare_meeting.handler",
      tenantId,
      dealId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro ao preparar a reunião." });
  }
});
