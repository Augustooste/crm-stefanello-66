// hitl-stagnant-deal-analyzer — Fase 3 do PRD (docs/PRD-CRM-IA-MULTINICHO.md,
// seção "Analisadores proativos", linhas ~1644 e ~1670-1673).
//
// Detecta deals `status='open'` sem atualização de `stage_entered_at` há mais
// de N dias (configurável), e para os que têm evidência mínima de conversa
// real vinculada (ver guardrail em logic.ts — hasEnoughEvidence), chama um
// LLM pra avaliar se há sinal de oportunidade de avanço ou risco de perda, e
// sugere via `hitl_decisions` (categoria 'opportunity' ou 'risk').
//
// Guardrail "sem conversa real, sem avanço automático": deals sem conversa
// vinculada com evidência suficiente NUNCA são avaliados por LLM — só contados
// e logados (summary.skippedNoEvidence + console.log estruturado no fim).
//
// NÃO reusa evaluateAdvancementCriteria de _shared/ai/pipeline.ts: aquela
// função avalia critérios de avanço ESPECÍFICOS DE ESTÁGIO
// (stage_ai_config.advancement_criteria) contra o texto que a IA acabou de
// gerar numa resposta — um formato de entrada (lista de critérios + aiText)
// que este analisador não tem (aqui não há uma resposta de IA recém-gerada
// nem uma lista de critérios configurados por estágio, só o histórico
// estagnado da conversa). Mesmo agora que essa função foi expandida em
// paralelo nesta mesma fase pra devolver confidence (ver diff não commitado
// de pipeline.ts), o contrato dela continua stage-criteria-shaped, não
// stagnant-deal-shaped — não é um drop-in. Por isso este arquivo tem sua
// própria chamada de LLM simples (assessStagnantDeal abaixo), reusando só a
// infraestrutura de baixo nível já compartilhada (callLovableGateway,
// sanitizeProviderError, reportAIFailure). TODO: se um dia existir uma função
// verdadeiramente genérica de "avalie esta conversa e devolva confidence +
// assessment" em _shared/ai/, trocar esta chamada local por ela.
//
// Cron: dormente por design nesta lane (mesma cautela das outras 2
// edge functions desta fase, hitl-sla-monitor e
// hitl-overdue-activity-analyzer) — pensada para ser agendada via
// `pg_cron -> pg_net`, mas NENHUM `cron.schedule` é commitado aqui.
// Por enquanto só existe como entry point invocável manualmente (curl com a
// service role key).
//
// Auth: fail-closed — Bearer deve ser exatamente SUPABASE_SERVICE_ROLE_KEY
// (mesmo padrão de ai-memory-consolidate/index.ts). Não é chamada pelo
// front-end com JWT de usuário.
//
// Escopo deliberadamente fora desta function: NÃO grava em `hitl_audit_log`
// (mesma decisão de hitl-overdue-activity-analyzer — a migration desta fase
// não tem trigger de auditoria automática em INSERT de hitl_decisions, e os
// requisitos combinados não pedem isso aqui).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sanitizeProviderError } from "../_shared/ai/errors.ts";
import { callLovableGateway, LovableGatewayHttpError } from "../_shared/ai/gateway.ts";
import { reportAIFailure } from "../_shared/ai/failure-log.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  buildStagnantDecisionInsert,
  type ConversationEvidence,
  daysStagnant,
  hasEnoughEvidence,
  MIN_EVIDENCE_MESSAGES,
  resolveRateLimit,
  resolveScanBatchSize,
  resolveStaleDays,
  type StagnantAssessment,
  type StagnantDealAssessment,
  type StagnantDealCandidate,
} from "./logic.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Mesmo modelo default de ai-respond/index.ts (DEFAULT_AI_MODEL) — duplicado
// aqui deliberadamente (não importado do módulo de ai-respond) pra não
// acoplar este analisador dormente ao módulo de resposta em tempo real por
// uma única constante de string.
const DEFAULT_MODEL = "google/gemini-3-flash-preview";
const AI_MAX_OUTPUT_TOKENS = 500;
// Janela de histórico usada para montar o transcript avaliado pela IA —
// mesma ordem de grandeza de HISTORY_LIMIT em ai-respond/index.ts.
const TRANSCRIPT_MESSAGE_LIMIT = 20;

interface Payload {
  tenantId?: string;
  staleDays?: number;
  limit?: number;
}

export interface AnalyzeSummary {
  scanned: number;
  evaluated: number;
  skippedNoEvidence: number;
  skippedAlreadyPending: number;
  skippedRateLimit: number;
  created: number;
  failed: number;
  errors: string[];
}

interface DealCandidateRow {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  stage_id: string | null;
  stage_entered_at: string;
  title: string | null;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

// deno-lint-ignore no-explicit-any
type AdminClient = ReturnType<typeof createClient<any>>;

/**
 * Tenants elegíveis: `ai_enabled = true` (mesmo gate usado em
 * _shared/ai/gates.ts para o resto do pipeline de IA — chamar um LLM em
 * nome de um tenant que desligou IA seria uma violação de configuração, não
 * um bug de guardrail de evidência). Com `tenantId` explícito, restringe a
 * ele (e ainda respeita `ai_enabled`); sem `tenantId`, roda para todos os
 * tenants ativos.
 */
async function resolveActiveTenantIds(admin: AdminClient, tenantId?: string): Promise<string[]> {
  let query = admin.from("tenants").select("id").eq("ai_enabled", true);
  if (tenantId) query = query.eq("id", tenantId);

  const { data, error } = await query.returns<{ id: string }[]>();
  if (error) {
    console.error("[hitl-stagnant-deal-analyzer] query tenants falhou:", error.message);
    return [];
  }
  return (data ?? []).map((t) => t.id);
}

/**
 * Conta mensagens por conversa vinculada ao contato do deal (2 queries: uma
 * pra achar as conversas do contato, uma contagem `head:true` por conversa —
 * ver countMessages). Contagem por conversa, não somada entre conversas: o
 * guardrail (hasEnoughEvidence) exige UMA conversa com evidência suficiente,
 * não o total fragmentado entre canais.
 */
async function fetchConversationEvidence(
  admin: AdminClient,
  tenantId: string,
  contactId: string,
): Promise<ConversationEvidence[]> {
  const { data: conversations, error } = await admin
    .from("conversations")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .returns<{ id: string }[]>();

  if (error) {
    console.error("[hitl-stagnant-deal-analyzer] query conversations falhou:", error.message);
    return [];
  }
  if (!conversations || conversations.length === 0) return [];

  const evidence: ConversationEvidence[] = [];
  for (const conv of conversations) {
    const totalMessages = await countMessages(admin, conv.id);
    // Curto-circuito: só verifica engajamento do contato se o total já bate
    // o mínimo — poupa 1 query no caso comum de conversa curta demais.
    const contactMessages =
      totalMessages >= MIN_EVIDENCE_MESSAGES ? await countMessages(admin, conv.id, "contact") : 0;
    evidence.push({ conversationId: conv.id, totalMessages, contactMessages });
  }
  return evidence;
}

async function countMessages(
  admin: AdminClient,
  conversationId: string,
  sender?: string,
): Promise<number> {
  let query = admin
    .from("messages")
    .select("id", { count: "exact", head: true })
    .eq("conversation_id", conversationId);
  if (sender) query = query.eq("sender", sender);

  const { count, error } = await query;
  if (error) {
    console.error("[hitl-stagnant-deal-analyzer] count messages falhou:", error.message);
    return 0;
  }
  return count ?? 0;
}

/**
 * Dedupe a nível de aplicação: a unique index parcial do schema Fase 3
 * (`idx_hitl_decisions_one_pending_per_activity`) só cobre
 * `(activity_id, type) WHERE status='pending' AND activity_id IS NOT NULL` —
 * sugestões deste analisador não têm `activity_id` (são por `deal_id`), então
 * essa constraint NÃO as protege de duplicata. Por isso, checagem explícita
 * "já existe pending pra este deal_id" antes de inserir. Não é atômico (race
 * entre 2 execuções concorrentes ainda poderia duplicar), mas para uma
 * function dormente, disparada manualmente/por 1 cron por vez, é aceitável —
 * documentado aqui em vez de fingir que é uma garantia forte.
 */
async function hasPendingStagnantDecision(
  admin: AdminClient,
  tenantId: string,
  dealId: string,
): Promise<boolean> {
  const { data, error } = await admin
    .from("hitl_decisions")
    .select("id")
    .eq("tenant_id", tenantId)
    .eq("deal_id", dealId)
    .eq("type", "stagnant_deal")
    .eq("status", "pending")
    .limit(1)
    .maybeSingle<{ id: string }>();

  if (error) {
    console.error(
      "[hitl-stagnant-deal-analyzer] query hitl_decisions (dedupe) falhou:",
      error.message,
    );
    // Fail-closed: na falha da própria checagem de dedupe, assume que já
    // existe pendência (pula o insert) em vez de arriscar duplicata — mais
    // seguro errar pro lado de "não sugeriu de novo" do que duplicar a fila.
    return true;
  }
  return !!data;
}

/**
 * "default" é o valor de fábrica de ai_settings.model — mesma convenção de
 * ensureAiSettings em _shared/ai/gates.ts: só troca pelo modelo configurado
 * do tenant quando ele de fato mudou o default.
 */
async function resolveTenantModel(admin: AdminClient, tenantId: string): Promise<string> {
  const { data, error } = await admin
    .from("ai_settings")
    .select("model")
    .eq("tenant_id", tenantId)
    .maybeSingle<{ model: string }>();

  if (error) {
    console.error("[hitl-stagnant-deal-analyzer] query ai_settings falhou:", error.message);
  }
  const model = data?.model;
  return model && model !== "default" ? model : DEFAULT_MODEL;
}

async function buildTranscript(
  admin: AdminClient,
  tenantId: string,
  dealId: string,
  conversationIds: string[],
): Promise<string> {
  if (conversationIds.length === 0) return "";

  const { data, error } = await admin
    .from("messages")
    .select("sender, content, created_at")
    .in("conversation_id", conversationIds)
    .order("created_at", { ascending: false })
    .limit(TRANSCRIPT_MESSAGE_LIMIT)
    .returns<{ sender: string; content: string | null }[]>();

  if (error) {
    console.error(
      "[hitl-stagnant-deal-analyzer] query messages (transcript) falhou:",
      error.message,
    );
    // Guardrail hasEnoughEvidence já garantiu >= MIN_EVIDENCE_MESSAGES pra
    // este deal -- se chegou aqui com transcript vazio, quase certamente é
    // esta query falhando, não ausência legítima de conversa. Sem isto o
    // deal só vira "avaliação de IA não produziu resultado utilizável" em
    // summary.failed e desaparece sem nenhum evento em system_events.
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.stagnant_deal_analyzer.transcript",
      tenantId,
      dealId,
      message: error.message,
      context: { conversationCount: conversationIds.length },
    });
    return "";
  }

  return (data ?? [])
    .slice()
    .reverse()
    .map((m) => `${m.sender === "contact" ? "Lead" : "Atendimento"}: ${m.content ?? ""}`)
    .join("\n");
}

/**
 * Chamada de LLM própria e simples deste analisador (ver comentário no topo
 * do arquivo sobre por que não reusa evaluateAdvancementCriteria). Nunca
 * lança para erros esperados (HTTP não-ok do gateway, JSON malformado) —
 * devolve null, que o caller trata como falha registrada em
 * summary.failed/errors, sem reportar em ai_failure_logs (mesmo padrão de
 * "skip silencioso" de evaluateAdvancementCriteria original). Falha de rede
 * (fetch rejeitando) ou LOVABLE_API_KEY ausente propagam — ao contrário da
 * avaliação de critérios de estágio (que silencia sem chave, porque roda a
 * cada mensagem no caminho reativo), aqui uma chave ausente é uma
 * configuração quebrada persistente que vale a pena reportar (o caller
 * chama reportAIFailure para esse caso).
 */
async function assessStagnantDeal(params: {
  admin: AdminClient;
  tenantId: string;
  dealId: string;
  dealTitle: string;
  daysStagnantValue: number;
  transcript: string;
  effectiveModel: string;
}): Promise<StagnantAssessment | null> {
  const { admin, tenantId, dealId, dealTitle, daysStagnantValue, transcript, effectiveModel } =
    params;
  if (!transcript) return null;

  const systemPrompt =
    "Você analisa deals parados de um CRM. Dado o histórico de conversa e há quantos dias o deal " +
    "está parado no mesmo estágio, avalie se há evidência de oportunidade real de avanço (o lead " +
    "demonstrou interesse concreto, falta só uma ação) ou sinal de risco de perda (esfriou, objeção " +
    "não resolvida, parou de responder). Responda em JSON: " +
    '{"confidence": 0 a 1, "assessment": "advance" ou "stalled", "reasoning": "...", "suggestedAction": "..."}.';
  const userPrompt =
    `Deal: ${dealTitle || "(sem título)"}\n` +
    `Dias parado no estágio atual: ${Math.floor(daysStagnantValue)}\n\n` +
    `Conversa recente:\n${transcript}`;

  let raw: string;
  try {
    raw = await callLovableGateway(
      systemPrompt,
      [{ role: "user", content: userPrompt }],
      effectiveModel,
      {
        maxOutputTokens: AI_MAX_OUTPUT_TOKENS,
        responseFormat: { type: "json_object" },
      },
    );
  } catch (e) {
    if (e instanceof LovableGatewayHttpError) {
      console.error("[hitl-stagnant-deal-analyzer] gateway HTTP não-ok:", e.statusCode);
      // 429 é esperado sob carga (rate limit do gateway) -- warn, não error.
      // Qualquer outro status não-ok (4xx/5xx do provider) é anomalia real.
      await captureEdgeError(admin, {
        severity: e.statusCode === 429 ? "warn" : "error",
        source: "edge",
        operation: "hitl.stagnant_deal_analyzer.gateway",
        tenantId,
        dealId,
        errorCode: String(e.statusCode),
        message: e.message,
        stack: e.stack ?? null,
        context: { retryAfterSeconds: e.retryAfterSeconds ?? null, model: effectiveModel },
      });
      return null;
    }
    throw e;
  }

  let parsed: Partial<{
    confidence: unknown;
    assessment: unknown;
    reasoning: unknown;
    suggestedAction: unknown;
  }>;
  try {
    parsed = JSON.parse(raw || "{}");
  } catch (e) {
    console.error(
      "[hitl-stagnant-deal-analyzer] parse da resposta da IA falhou:",
      (e as Error).message,
    );
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.stagnant_deal_analyzer.parse",
      tenantId,
      dealId,
      message: (e as Error).message,
      stack: (e as Error).stack ?? null,
      context: { model: effectiveModel, rawLength: raw?.length ?? 0 },
    });
    return null;
  }

  // Qualquer coisa que não seja literalmente "advance" vira "stalled" —
  // falha pro lado cauteloso (risco) em vez de silenciosamente sugerir uma
  // falsa oportunidade quando a resposta da IA vem malformada/ambígua.
  const assessment: StagnantDealAssessment =
    parsed.assessment === "advance" ? "advance" : "stalled";
  const rawConfidence = Number(parsed.confidence);
  const confidence = Number.isFinite(rawConfidence) ? Math.min(1, Math.max(0, rawConfidence)) : 0.5;
  const reasoning = typeof parsed.reasoning === "string" ? parsed.reasoning : "";
  const suggestedAction =
    typeof parsed.suggestedAction === "string" && parsed.suggestedAction.trim()
      ? parsed.suggestedAction
      : "review_manually";

  return { confidence, assessment, reasoning, suggestedAction };
}

/**
 * Query + guardrail + avaliação + insert em lote. Exportada para os testes
 * exercitarem o comportamento fim-a-fim sem precisar montar um
 * Request/Response completo (o handler abaixo também é testado via
 * captureHandler, que cobre auth/parsing) — mesmo padrão de
 * analyzeOverdueActivities em hitl-overdue-activity-analyzer/index.ts.
 */
export async function analyzeStagnantDeals(
  admin: AdminClient,
  params: { tenantId?: string; staleDays: number; limit: number },
): Promise<AnalyzeSummary> {
  const now = new Date();
  const scanBatchSize = resolveScanBatchSize(params.limit);

  const summary: AnalyzeSummary = {
    scanned: 0,
    evaluated: 0,
    skippedNoEvidence: 0,
    skippedAlreadyPending: 0,
    skippedRateLimit: 0,
    created: 0,
    failed: 0,
    errors: [],
  };

  const activeTenantIds = await resolveActiveTenantIds(admin, params.tenantId);
  if (activeTenantIds.length === 0) return summary;

  const cutoffIso = new Date(now.getTime() - params.staleDays * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await admin
    .from("deals")
    .select("id, tenant_id, contact_id, stage_id, stage_entered_at, title")
    .eq("status", "open")
    .lt("stage_entered_at", cutoffIso)
    .in("tenant_id", activeTenantIds)
    .order("stage_entered_at", { ascending: true })
    .limit(scanBatchSize)
    .returns<DealCandidateRow[]>();

  if (error) throw new Error(`query deals falhou: ${error.message}`);

  const deals = data ?? [];
  // Orçamento de avaliações por LLM COMPARTILHADO entre todos os tenants
  // nesta execução (não por tenant) — "um limite de quantos deals processa
  // por execução", pedido explicitamente pela tarefa desta fase. Os deals já
  // vêm ordenados globalmente por stage_entered_at ascendente, então o
  // orçamento vai naturalmente para os mais estagnados primeiro.
  let budgetRemaining = params.limit;
  // Contador separado de summary.failed: summary.failed também soma o caso
  // "avaliação de IA não produziu resultado utilizável" (já tem telemetria
  // própria via captureEdgeError dentro de assessStagnantDeal/no catch
  // acima) -- misturar os dois na mesma agregação duplicaria o sinal.
  let insertFailures = 0;
  const modelByTenant = new Map<string, string>();
  const perTenantBreakdown = new Map<
    string,
    { scanned: number; skippedNoEvidence: number; evaluated: number; created: number }
  >();

  const bumpTenant = (
    tenantId: string,
    patch: Partial<{
      scanned: number;
      skippedNoEvidence: number;
      evaluated: number;
      created: number;
    }>,
  ) => {
    const current = perTenantBreakdown.get(tenantId) ?? {
      scanned: 0,
      skippedNoEvidence: 0,
      evaluated: 0,
      created: 0,
    };
    perTenantBreakdown.set(tenantId, {
      scanned: current.scanned + (patch.scanned ?? 0),
      skippedNoEvidence: current.skippedNoEvidence + (patch.skippedNoEvidence ?? 0),
      evaluated: current.evaluated + (patch.evaluated ?? 0),
      created: current.created + (patch.created ?? 0),
    });
  };

  for (const deal of deals) {
    summary.scanned++;
    bumpTenant(deal.tenant_id, { scanned: 1 });
    const daysStagnantValue = daysStagnant(deal.stage_entered_at, now);
    const candidate: StagnantDealCandidate = {
      id: deal.id,
      tenant_id: deal.tenant_id,
      contact_id: deal.contact_id,
      title: deal.title,
    };
    const { error: eventError } = await admin.rpc("publish_pipeline_signal_event", {
      p_event_type: "deal.stagnant",
      p_deal_id: deal.id,
      p_contact_id: deal.contact_id,
      p_payload: {
        days_stagnant: daysStagnantValue,
        stage_id: deal.stage_id,
      },
      p_idempotency_key: `deal.stagnant:v1:${deal.id}:${deal.stage_id}:${daysStagnantValue}`,
    });
    if (eventError) {
      console.error("[hitl-stagnant-deal-analyzer] publicação deal.stagnant falhou", {
        dealId: deal.id,
        error: eventError.message,
      });
    }

    if (!deal.contact_id) {
      summary.skippedNoEvidence++;
      bumpTenant(deal.tenant_id, { skippedNoEvidence: 1 });
      continue;
    }

    const evidence = await fetchConversationEvidence(admin, deal.tenant_id, deal.contact_id);
    if (!hasEnoughEvidence(evidence)) {
      summary.skippedNoEvidence++;
      bumpTenant(deal.tenant_id, { skippedNoEvidence: 1 });
      continue;
    }

    if (budgetRemaining <= 0) {
      summary.skippedRateLimit++;
      continue;
    }

    const alreadyPending = await hasPendingStagnantDecision(admin, deal.tenant_id, deal.id);
    if (alreadyPending) {
      summary.skippedAlreadyPending++;
      continue;
    }

    budgetRemaining--;
    summary.evaluated++;
    bumpTenant(deal.tenant_id, { evaluated: 1 });

    if (!modelByTenant.has(deal.tenant_id)) {
      modelByTenant.set(deal.tenant_id, await resolveTenantModel(admin, deal.tenant_id));
    }
    const effectiveModel = modelByTenant.get(deal.tenant_id) as string;

    let assessment: StagnantAssessment | null = null;
    try {
      const transcript = await buildTranscript(
        admin,
        deal.tenant_id,
        deal.id,
        evidence.map((e) => e.conversationId),
      );
      assessment = await assessStagnantDeal({
        admin,
        tenantId: deal.tenant_id,
        dealId: deal.id,
        dealTitle: deal.title ?? "",
        daysStagnantValue,
        transcript,
        effectiveModel,
      });
    } catch (e) {
      const aiError = sanitizeProviderError(e);
      console.error("[hitl-stagnant-deal-analyzer] avaliação de IA falhou", {
        dealId: deal.id,
        error: aiError.message,
      });
      await reportAIFailure(admin, {
        tenantId: deal.tenant_id,
        route: "hitl-stagnant-deal-analyzer",
        provider: aiError.provider ?? "lovable-gateway",
        errorCode: aiError.code,
        errorMessage: aiError.message,
        context: { dealId: deal.id },
      });
      // Sem captureEdgeError aqui, de propósito: reportAIFailure já é o sink
      // desta falha. `ai_failure_logs` é o sink ESPECIALIZADO — exige
      // tenantId, carrega provider/model/statusCode (campos que
      // system_events não tem) e alimenta o painel de Falhas IA. Gravar nos
      // dois faria a mesma falha ser contada duas vezes em consultas que
      // cruzam os sinks. Regra do projeto: onde reportAIFailure dispara,
      // captureEdgeError não dispara. Os pontos `.gateway` e `.parse` acima
      // NÃO violam isso — ficam dentro de assessStagnantDeal, que devolve
      // null nesses casos sem chamar reportAIFailure, então lá o
      // captureEdgeError é o único sink.
    }

    if (!assessment) {
      summary.failed++;
      summary.errors.push(`${deal.id}: avaliação de IA não produziu resultado utilizável`);
      continue;
    }

    const payload = buildStagnantDecisionInsert(candidate, assessment, daysStagnantValue);
    const { error: insertErr } = await admin.from("hitl_decisions").insert(payload);

    if (insertErr) {
      summary.failed++;
      insertFailures++;
      summary.errors.push(`${deal.id}: ${insertErr.message}`);
      console.error("[hitl-stagnant-deal-analyzer] insert hitl_decisions falhou", {
        dealId: deal.id,
        error: insertErr.message,
      });
    } else {
      summary.created++;
      bumpTenant(deal.tenant_id, { created: 1 });
    }
  }

  // Agregado por execução (não por deal): volume por run é limitado pelo
  // budget de avaliações LLM (params.limit), mas ainda assim 1 evento por
  // falha de insert seria ruído desnecessário -- mesmo racional de
  // hitl-overdue-activity-analyzer/index.ts.
  if (insertFailures > 0) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.stagnant_deal_analyzer.persist",
      message: `${insertFailures} insert(s) em hitl_decisions falharam de ${summary.evaluated} avaliação(ões) concluída(s).`,
      context: { evaluated: summary.evaluated, created: summary.created, insertFailures },
    });
  }

  // Log estruturado obrigatório pela tarefa desta fase: quantos ficaram de
  // fora (por guardrail de evidência, por já ter pendência, por rate limit)
  // e a quebra por tenant, mesmo que a resposta HTTP devolva só os totais.
  console.log("hitl-stagnant-deal-analyzer resumo", {
    staleDays: params.staleDays,
    rateLimit: params.limit,
    scanBatchSize,
    ...summary,
    perTenant: Object.fromEntries(perTenantBreakdown),
  });

  return summary;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: só aceita bearer == service role (cron/processo server-side,
  // nunca JWT de usuário do front-end) — mesmo padrão de
  // ai-memory-consolidate/index.ts e das outras 2 edge functions desta fase.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  // Corpo é inteiramente opcional (um `net.http_post` de cron pode não
  // mandar corpo nenhum) — string vazia vira `{}` em vez de 400; só JSON
  // malformado (corpo presente e inválido) é erro. Mesmo padrão de
  // hitl-overdue-activity-analyzer/index.ts.
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

  const staleDays = resolveStaleDays(body.staleDays, Deno.env.get("HITL_STAGNANT_DEAL_DAYS"));
  const limit = resolveRateLimit(body.limit, Deno.env.get("HITL_STAGNANT_DEAL_RATE_LIMIT"));
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  try {
    const summary = await analyzeStagnantDeals(admin, {
      tenantId: body.tenantId,
      staleDays,
      limit,
    });
    return json(200, { staleDays, limit, ...summary });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Erro desconhecido.";
    console.error("[hitl-stagnant-deal-analyzer] falhou", message);
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "hitl.stagnant_deal_analyzer",
      tenantId: body.tenantId ?? null,
      message,
      stack: err instanceof Error ? (err.stack ?? null) : null,
      context: { staleDays, limit },
    });
    return json(500, { error: message });
  }
});
