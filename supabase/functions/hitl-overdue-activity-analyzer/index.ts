// hitl-overdue-activity-analyzer — Fase 3 do PRD (docs/PRD-CRM-IA-MULTINICHO.md:1645,1674).
//
// Analisador PROATIVO mais simples da fila HITL: é regra pura (sem chamada
// LLM). Lê `activities` com `due_at IS NOT NULL AND completed_at IS NULL AND
// due_at < now()` e cria no máximo 1 `hitl_decisions` pendente por atividade
// vencida (idempotência garantida pela unique index parcial
// `idx_hitl_decisions_one_pending_per_activity (activity_id, type) WHERE
// status='pending'`, criada em
// 20260710120000_fase3_hitl_decision_queue_schema.sql).
//
// Cron: dormente por design nesta lane — pensada para ser agendada via
// `pg_cron → pg_net` (padrão de supabase/migrations/20260709100800_cron_prune_poc.sql),
// mas NENHUM `cron.schedule` é commitado aqui (mesma cautela dessa migration:
// agendamento real é passo manual pós-deploy). Por enquanto só existe como
// entry point invocável (curl/manual) com a service-role key.
//
// Auth: fail-closed — Bearer deve ser exatamente SUPABASE_SERVICE_ROLE_KEY
// (mesmo padrão de ai-memory-consolidate/index.ts). Não é chamada pelo
// front-end com JWT de usuário.
//
// Escopo deliberadamente fora desta function: NÃO grava em `hitl_audit_log`.
// A migration desta fase não tem trigger `AFTER INSERT ON hitl_decisions`
// que faria isso automaticamente, e os requisitos combinados para esta
// function não pedem auditoria de criação — decisão consciente, não omissão.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { buildOverdueDecisionInsert, type OverdueActivity } from "./logic.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Teto de segurança independente do `limit` pedido no corpo — mesmo raciocínio
// defensivo de ai-memory-consolidate/index.ts, ainda que aqui o custo por item
// seja só um INSERT (sem chamada LLM): protege contra uma invocação isolada
// varrendo um backlog gigante de atividades vencidas de uma vez.
const DEFAULT_LIMIT = 200;
const MAX_LIMIT = 1000;

// SQLSTATE do Postgres para unique_violation.
const UNIQUE_VIOLATION = "23505";

interface Payload {
  tenantId?: string;
  limit?: number;
}

export interface AnalyzeSummary {
  processed: number;
  created: number;
  skipped: number;
  failed: number;
  errors: string[];
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function resolveLimit(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_LIMIT;
  }
  // Math.floor(requested) >= 1: requested fracionário entre 0 e 1 passa o
  // check "> 0" acima mas Math.floor vira 0, o que faria a query rodar com
  // .limit(0) e nunca processar nada. Volta ao default nesse caso.
  const floored = Math.floor(requested);
  if (floored < 1) return DEFAULT_LIMIT;
  return Math.min(floored, MAX_LIMIT);
}

/**
 * Query + insert em lote. Exportada para os testes exercitarem o
 * comportamento de idempotência sem precisar montar um Request/Response
 * completo (o handler abaixo também é testado via captureHandler, que cobre
 * auth/parsing).
 */
export async function analyzeOverdueActivities(
  admin: SupabaseClient,
  params: { tenantId?: string; limit: number },
): Promise<AnalyzeSummary> {
  const now = new Date();

  let query = admin
    .from("activities")
    .select("id, tenant_id, title, due_at, deal_id, contact_id")
    .not("due_at", "is", null)
    .is("completed_at", null)
    .lt("due_at", now.toISOString());
  if (params.tenantId) query = query.eq("tenant_id", params.tenantId);

  const { data, error } = await query.order("due_at", { ascending: true }).limit(params.limit);
  if (error) {
    throw new Error(`query activities falhou: ${error.message}`);
  }
  const activities = (data ?? []) as OverdueActivity[];

  const summary: AnalyzeSummary = {
    processed: activities.length,
    created: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  // Sequencial de propósito: volume esperado é o backlog de vencidas de uma
  // janela de cron (não a base histórica inteira), e evita múltiplos INSERTs
  // concorrentes disputando a mesma unique index parcial ao mesmo tempo.
  for (const activity of activities) {
    const payload = buildOverdueDecisionInsert(activity, now);
    const { error: insertErr } = await admin.from("hitl_decisions").insert(payload);

    if (!insertErr) {
      summary.created++;
      continue;
    }

    // A unique index parcial (activity_id, type) WHERE status='pending' já
    // impede duplicata — mas PostgREST não expõe um jeito de fazer
    // `.upsert({onConflict:...})` incluir o predicado WHERE da index parcial
    // (o Postgres só infere um índice parcial como arbiter de ON CONFLICT se
    // o predicado for repetido explicitamente na cláusula; sem isso, o
    // upsert bateria em "there is no unique or exclusion constraint
    // matching the ON CONFLICT specification"). Por isso: INSERT simples +
    // tratar a violação de unicidade (23505) como sucesso idempotente
    // (decisão pendente já existe) em vez de falha real.
    if (insertErr.code === UNIQUE_VIOLATION) {
      summary.skipped++;
      continue;
    }

    summary.failed++;
    summary.errors.push(`${activity.id}: ${insertErr.message}`);
    console.error("[hitl-overdue-activity-analyzer] insert hitl_decisions falhou", {
      activityId: activity.id,
      error: insertErr.message,
    });
  }

  // Um evento agregado por execução, não um por item: o loop pode ter até
  // MAX_LIMIT (1000) atividades, e cada insert falho já vira console.error +
  // entrada em summary.errors acima — reportar até 1000 INSERTs em
  // system_events pra um backlog ruim seria pior que o problema que
  // captureEdgeError existe pra resolver. Mesmo padrão de agregação de
  // domain-event-dispatcher/index.ts.
  if (summary.failed > 0) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.overdue_activity_analyzer.insert",
      tenantId: params.tenantId ?? null,
      message:
        `${summary.failed} insert(s) em hitl_decisions falharam de ${summary.processed} atividade(s) processada(s).`,
      context: {
        processed: summary.processed,
        created: summary.created,
        skipped: summary.skipped,
        failed: summary.failed,
        errors: summary.errors.slice(0, 10),
      },
    });
  }

  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: só aceita bearer == service role (cron/processo server-side,
  // nunca JWT de usuário do front-end).
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  // Corpo é inteiramente opcional (um `net.http_post` de cron pode não
  // mandar corpo nenhum) — string vazia vira `{}` em vez de 400; só JSON
  // malformado (corpo presente e inválido) é erro.
  let body: Payload = {};
  const rawBody = await req.text();
  if (rawBody) {
    try {
      body = JSON.parse(rawBody) as Payload;
    } catch {
      return json(400, { error: "Corpo inválido." });
    }
  }

  if (body.tenantId !== undefined && (typeof body.tenantId !== "string" || !body.tenantId)) {
    return json(400, { error: "tenantId inválido." });
  }

  const limit = resolveLimit(body.limit);
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  try {
    const summary = await analyzeOverdueActivities(admin, { tenantId: body.tenantId, limit });
    return json(200, summary);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido.";
    console.error("[hitl-overdue-activity-analyzer] falhou", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.overdue_activity_analyzer",
      tenantId: body.tenantId ?? null,
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { limit },
    });
    return json(500, { error: message });
  }
});
