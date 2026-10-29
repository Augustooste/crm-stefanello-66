import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { AI_RESPONSE_CALLER_TIMEOUT_MS } from "../_shared/ai/execution-budget.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

// Consumidor durável de job_queue(job_type='ai_respond'). Deve ser invocado
// por scheduler server-side (recomendado: 1x/minuto) com a service-role. O
// agendamento não é commitado porque o padrão do projeto guarda URL/chave no
// Vault e proíbe credenciais reais em cron.schedule dentro de migrations.
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
// Lista única em `_shared/ai/gates.ts`: a cópia local aqui não conhecia
// `ai_settings_unavailable` (achado `12 · H1`).
import { RETRYABLE_GATE_REASONS as RETRYABLE_REASONS } from "../_shared/ai/gates.ts";

interface AIResponseJob {
  id: string;
  tenant_id: string | null;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

interface WorkerSummary {
  claimed: number;
  succeeded: number;
  retried: number;
  failed: number;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

async function patchJob(
  admin: SupabaseClient,
  jobId: string,
  patch: Record<string, unknown>,
): Promise<void> {
  const { error } = await admin.from("job_queue").update(patch).eq("id", jobId);
  if (error) throw new Error(`Falha ao atualizar job ${jobId}: ${error.message}`);
}

async function invokeAI(
  supabaseUrl: string,
  serviceRole: string,
  messageId: string,
): Promise<void> {
  const response = await fetch(`${supabaseUrl}/functions/v1/ai-respond`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${serviceRole}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ message_id: messageId }),
    signal: AbortSignal.timeout(AI_RESPONSE_CALLER_TIMEOUT_MS),
  });
  const rawBody = await response.text().catch(() => "");
  if (!response.ok) {
    throw new Error(`ai-respond HTTP ${response.status}: ${rawBody.slice(0, 500)}`);
  }

  let body: { ok?: unknown; reason?: unknown } | null = null;
  try {
    body = JSON.parse(rawBody) as { ok?: unknown; reason?: unknown };
  } catch {
    body = null;
  }
  if (
    body?.ok === false &&
    typeof body.reason === "string" &&
    RETRYABLE_REASONS.has(body.reason)
  ) {
    throw new Error(`ai-respond adiou processamento: ${body.reason}`);
  }
}

async function failOrRetryJob(
  admin: SupabaseClient,
  job: AIResponseJob,
  errorMessage: string,
): Promise<"retried" | "failed"> {
  const exhausted = job.attempts >= job.max_attempts;
  if (exhausted) {
    await patchJob(admin, job.id, {
      status: "failed",
      finished_at: new Date().toISOString(),
      error: errorMessage.slice(0, 2_000),
    });
    return "failed";
  }

  const backoffSeconds = Math.min(30 * 2 ** Math.max(job.attempts - 1, 0), 900);
  await patchJob(admin, job.id, {
    status: "pending",
    scheduled_for: new Date(Date.now() + backoffSeconds * 1_000).toISOString(),
    started_at: null,
    finished_at: null,
    error: errorMessage.slice(0, 2_000),
  });
  return "retried";
}

async function processJob(
  admin: SupabaseClient,
  supabaseUrl: string,
  serviceRole: string,
  job: AIResponseJob,
): Promise<"succeeded" | "retried" | "failed"> {
  try {
    const messageId = typeof job.payload?.message_id === "string" ? job.payload.message_id : "";
    if (!messageId) throw new Error("Job ai_respond sem payload.message_id");
    await invokeAI(supabaseUrl, serviceRole, messageId);
    await patchJob(admin, job.id, {
      status: "success",
      finished_at: new Date().toISOString(),
      error: null,
    });
    return "succeeded";
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const result = await failOrRetryJob(admin, job, message);
    await captureEdgeError(admin, {
      severity: result === "failed" ? "error" : "warn",
      source: "edge",
      operation: "ai-response-worker.process",
      tenantId: job.tenant_id,
      message,
      context: {
        job_id: job.id,
        attempt: job.attempts,
        max_attempts: job.max_attempts,
        outcome: result,
      },
    });
    return result;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
  const serviceRole = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const bearer = (req.headers.get("Authorization") ?? "").replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== serviceRole) return json(401, { error: "Unauthorized" });

  let limit = 20;
  try {
    const body = (await req.json()) as { limit?: unknown };
    if (typeof body.limit === "number" && Number.isInteger(body.limit)) {
      limit = Math.min(Math.max(body.limit, 1), 50);
    }
  } catch {
    // Corpo vazio usa o default.
  }

  const admin = createClient(supabaseUrl, serviceRole, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await admin.rpc("claim_jobs", {
    p_limit: limit,
    p_job_types: ["ai_respond"],
  });
  if (error) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai-response-worker.claim",
      message: error.message,
    });
    return json(500, { error: "Falha ao reivindicar jobs." });
  }

  const jobs = (Array.isArray(data) ? data : []) as AIResponseJob[];
  const summary: WorkerSummary = { claimed: jobs.length, succeeded: 0, retried: 0, failed: 0 };
  const outcomes = await Promise.all(
    jobs.map((job) => processJob(admin, supabaseUrl, serviceRole, job)),
  );
  for (const outcome of outcomes) summary[outcome] += 1;
  return json(200, summary);
});
