// Resultado da reunião — grava no CRM o que foi decidido numa reunião e
// redige o RASCUNHO do follow-up. Nada é enviado: sem e-mail, sem WhatsApp.
//
// action "ingest": recebe { dealId, meeting } (contrato em
//   _shared/meeting-result.ts) e cria UMA atividade (nota concluída) no
//   negócio, com o resultado em metadata. Mesma meeting.meetingId no mesmo
//   negócio devolve a atividade existente (idempotente).
// action "followup": lê a última reunião gravada do negócio e devolve o
//   rascunho persistido; sem rascunho (ou com regenerate) redige via IA,
//   valida o texto inteiro e, se recusado, usa o modelo determinístico.
//
// Nunca escreve em deals/contacts: empresa, contato, cargo, valor e estágio
// continuam os do CRM. Nunca mexe em completed_at depois do insert (o update
// dispara activity.completed para o agente de pipeline).
//
// Autorização: igual a prepare-meeting — loadProfileOrFail + leituras e
// escritas com o JWT do usuário (RLS) e tenant_id explícito.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import { callLovableGateway } from "../_shared/ai/gateway.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  activityTitle,
  buildFollowupPrompt,
  draftRejectReason,
  type FollowupDraft,
  FOLLOWUP_SYSTEM_PROMPT,
  idempotencyKey,
  MEETING_RESULT_KIND,
  type MeetingResultMetadata,
  parseDraft,
  parseMeetingInput,
  templateDraft,
} from "../_shared/meeting-result.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const AI_MODEL = "google/gemini-3-flash-preview";
const AI_TIMEOUT_MS = 45_000;
const AI_MAX_OUTPUT_TOKENS = 900;
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
    operation: "ai.process_meeting.load_profile",
  });
  if (!prof.ok) {
    if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
    return json(403, { error: "Perfil não encontrado." });
  }
  const tenantId = prof.tenantId;

  let body: Record<string, unknown>;
  try {
    body = (await req.json()) as Record<string, unknown>;
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  const dealId = typeof body.dealId === "string" ? body.dealId : "";
  if (!UUID_RE.test(dealId)) return json(400, { error: "dealId inválido." });
  const action = body.action;
  if (action !== "ingest" && action !== "followup")
    return json(400, { error: "action deve ser ingest ou followup." });

  try {
    // CRM é a fonte da verdade: o negócio tem que existir NESTE tenant.
    const deal = must(
      await userClient
        .from("deals")
        .select("id, contact_id, owner_id")
        .eq("id", dealId)
        .eq("tenant_id", tenantId)
        .maybeSingle(),
      "negócio",
    ) as { id: string; contact_id: string | null; owner_id: string | null } | null;
    // 404 (não 403): não revela se o id existe em outro tenant.
    if (!deal) return json(404, { error: "Negócio não encontrado." });

    if (action === "ingest") {
      const parsed = parseMeetingInput(body.meeting);
      if (!parsed.ok) return json(400, { error: parsed.error });
      const key = idempotencyKey(dealId, parsed.meeting.meetingId);

      // ponytail: check-then-insert sem índice único — dois POSTs simultâneos
      // da mesma reunião podem duplicar; índice parcial em
      // (tenant_id, (metadata->>'idempotency_key')) se a ingestão virar automática.
      const existing = must(
        await userClient
          .from("activities")
          .select("id")
          .eq("tenant_id", tenantId)
          .eq("deal_id", dealId)
          .eq("metadata->>idempotency_key", key)
          .limit(1),
        "atividade da reunião",
      ) as { id: string }[] | null;
      if (existing && existing.length > 0)
        return json(200, { activityId: existing[0].id, duplicate: true });

      const now = new Date().toISOString();
      const metadata: MeetingResultMetadata = {
        kind: MEETING_RESULT_KIND,
        idempotency_key: key,
        meeting: parsed.meeting,
        followup_draft: null,
      };
      const inserted = must(
        await userClient
          .from("activities")
          .insert({
            tenant_id: tenantId,
            deal_id: dealId,
            contact_id: deal.contact_id,
            owner_id: deal.owner_id,
            type: "note",
            title: activityTitle(parsed.meeting),
            due_at: now,
            completed_at: now,
            metadata,
          })
          .select("id")
          .single(),
        "gravação da reunião",
      ) as { id: string };
      return json(201, { activityId: inserted.id, duplicate: false });
    }

    // action === "followup"
    const rows = must(
      await userClient
        .from("activities")
        .select("id, metadata")
        .eq("tenant_id", tenantId)
        .eq("deal_id", dealId)
        .eq("metadata->>kind", MEETING_RESULT_KIND)
        .order("created_at", { ascending: false })
        .limit(1),
      "reunião do negócio",
    ) as { id: string; metadata: MeetingResultMetadata }[] | null;
    const row = rows?.[0];
    if (!row) return json(404, { error: "Nenhuma reunião processada para este negócio." });
    if (row.metadata.followup_draft && body.regenerate !== true)
      return json(200, { draft: row.metadata.followup_draft, rejected: null });

    const rateLimit = await checkRateLimit(
      admin,
      `process-meeting:${dealId}`,
      RATE_LIMIT_MAX_CALLS,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!rateLimit.allowed) {
      return json(rateLimit.rpcFailed ? 500 : 429, {
        error: "Muitas gerações para este negócio. Tente novamente em instantes.",
      });
    }

    const contact = deal.contact_id
      ? (must(
          await userClient
            .from("contacts")
            .select("name, company_id")
            .eq("id", deal.contact_id)
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .maybeSingle(),
          "contato",
        ) as { name: string; company_id: string | null } | null)
      : null;
    const company = contact?.company_id
      ? (must(
          await userClient
            .from("crm_companies")
            .select("name")
            .eq("id", contact.company_id)
            .eq("tenant_id", tenantId)
            .is("deleted_at", null)
            .maybeSingle(),
          "empresa",
        ) as { name: string } | null)
      : null;

    const ctx = {
      contactName: contact?.name ?? null,
      companyName: company?.name ?? null,
      meeting: row.metadata.meeting,
    };
    const now = new Date();
    let draft: FollowupDraft = templateDraft(ctx, now);
    let rejected: string | null = null;
    try {
      const raw = await callLovableGateway(
        FOLLOWUP_SYSTEM_PROMPT,
        [{ role: "user", content: `Reunião:\n${buildFollowupPrompt(ctx)}` }],
        AI_MODEL,
        {
          maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
          temperature: 0.2,
          responseFormat: { type: "json_object" },
          timeoutMs: AI_TIMEOUT_MS,
        },
      );
      const ai = parseDraft(raw);
      rejected = ai
        ? draftRejectReason(`${ai.subject}\n${ai.email}\n${ai.whatsapp}`, ctx)
        : "formato";
      if (ai && !rejected) draft = { ...ai, source: "ai", generatedAt: now.toISOString() };
    } catch (e) {
      rejected = "ia_indisponivel";
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.process_meeting.gateway",
        tenantId,
        dealId,
        message: e instanceof Error ? e.message : String(e),
      });
    }
    if (rejected) console.log("process-meeting draft rejected", { tenantId, dealId, rejected });

    // Só metadata muda; completed_at fica intocado (ver cabeçalho).
    must(
      await userClient
        .from("activities")
        .update({ metadata: { ...row.metadata, followup_draft: draft } })
        .eq("id", row.id)
        .eq("tenant_id", tenantId),
      "gravação do rascunho",
    );
    return json(200, { draft, rejected });
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.process_meeting.handler",
      tenantId,
      dealId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro ao processar a reunião." });
  }
});
