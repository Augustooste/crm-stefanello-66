// AI Insights — analisa os agregados do relatório gerencial (dashboard_report)
// e devolve diagnósticos acionáveis. Admins only. O prompt recebe SOMENTE
// números agregados (nomes de estágio/motivos de perda inclusos) — nunca
// mensagens, contatos ou qualquer PII. Cache de 24h por tenant+período.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { loadProfileOrFail, PROFILE_DB_ERROR_MESSAGE } from "../_shared/load-profile.ts";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";
import { getAIGatewayConfig } from "../_shared/ai/gateway.ts";

const RATE_LIMIT_MAX_CALLS = 3;
const RATE_LIMIT_WINDOW_MS = 60_000;

// Audit #4: CORS por allowlist em vez de "*". Reflete o Origin só se for domínio
// do app (*.lovable.app, localhost) ou constar em ALLOWED_ORIGINS (env, p/ domínio
// custom do tenant). Origin fora da lista → "null" (browser bloqueia).
// ponytail: allowlist por sufixo/env; domínio custom precisa entrar em ALLOWED_ORIGINS.
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
    "Vary": "Origin",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
  };
}

const AI_MODEL = "google/gemini-3-flash-preview";
// Relatório roda sob request do usuário, mas o prompt é grande.
const AI_TIMEOUT_MS = 60_000;
const CACHE_HOURS = 24;
const MAX_INSIGHTS = 5;

// Rotas corrigíveis do app — a IA só pode apontar para estas telas.
const ALLOWED_LINKS = new Set([
  "/pipeline",
  "/inbox",
  "/assistente",
  "/configuracoes",
  "/atividades",
  "/contatos",
  "/integracoes",
]);

type Severidade = "alta" | "media" | "baixa";

interface Insight {
  severidade: Severidade;
  diagnostico: string;
  sugestao: string;
  link: string | null;
}

function parseInsights(raw: string): Insight[] {
  // A IA às vezes embrulha em ```json``` — remove cercas antes de parsear.
  const cleaned = raw
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return [];
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { insights?: unknown[] })?.insights)
      ? (parsed as { insights: unknown[] }).insights
      : [];
  const out: Insight[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const severidade = o.severidade;
    const diagnostico = o.diagnostico;
    const sugestao = o.sugestao;
    if (severidade !== "alta" && severidade !== "media" && severidade !== "baixa") continue;
    if (typeof diagnostico !== "string" || diagnostico.trim().length === 0) continue;
    if (typeof sugestao !== "string" || sugestao.trim().length === 0) continue;
    const link =
      typeof o.link === "string" && ALLOWED_LINKS.has(o.link.trim()) ? o.link.trim() : null;
    out.push({
      severidade,
      diagnostico: diagnostico.trim().slice(0, 400),
      sugestao: sugestao.trim().slice(0, 400),
      link,
    });
    if (out.length >= MAX_INSIGHTS) break;
  }
  return out;
}

function buildPrompt(report: unknown, fromIso: string, toIso: string): string {
  return [
    "Você é uma analista de operações comerciais de um CRM com atendimento por IA no WhatsApp.",
    `Abaixo estão APENAS métricas agregadas do período ${fromIso.slice(0, 10)} a ${toIso.slice(0, 10)} (sem dados pessoais).`,
    "Analise e devolva de 2 a 5 insights acionáveis em pt-BR.",
    "",
    "Responda SOMENTE com JSON válido, sem markdown, no formato:",
    '{"insights":[{"severidade":"alta|media|baixa","diagnostico":"o que os números mostram","sugestao":"ação concreta","link":"rota ou null"}]}',
    `O campo link deve ser null ou exatamente uma destas rotas: ${[...ALLOWED_LINKS].join(", ")}.`,
    "Priorize: tempo de 1ª resposta alto → /assistente; estágio do funil parado/acumulado → /pipeline; motivos de perda recorrentes → /pipeline; muitas transferências para humano → /assistente; poucas conversas novas → /integracoes.",
    "Se os dados forem insuficientes (tudo zerado), devolva um único insight de severidade baixa explicando isso.",
    "",
    "Métricas:",
    JSON.stringify(report),
  ].join("\n");
}

interface Body {
  from?: string;
  to?: string;
  force?: boolean;
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

  const startedAt = Date.now();
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  const userClient = createClient(SUPABASE_URL, ANON, { auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  // Catch de topo: envolve tudo daqui em diante — zero sink hoje para
  // qualquer falha de infra nesta function. Começa aqui (não antes) porque
  // `json` fecha sobre `cors`/`admin`, que já estão em escopo.
  try {
    const { data: userData, error: userErr } = await userClient.auth.getUser();
    if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

    const prof = await loadProfileOrFail(admin, userData.user.id, {
      operation: "ai.insights.load_profile",
      requireAdmin: true,
    });
    if (!prof.ok) {
      // 503, não 403: falha de banco é retentável e o cliente precisa saber
      // disso. O 403 anterior mandava o usuário caçar um problema de cadastro
      // que não existia.
      if (prof.reason === "db_error") return json(503, { error: PROFILE_DB_ERROR_MESSAGE });
      if (prof.reason === "not_admin") return json(403, { error: "Apenas administradores." });
      return json(403, { error: "Perfil não encontrado." });
    }
    const tenantId = prof.tenantId;

    let body: Body;
    try {
      body = (await req.json()) as Body;
    } catch {
      return json(400, { error: "Corpo inválido." });
    }
    const from = new Date(body.from ?? "");
    const to = new Date(body.to ?? "");
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || to <= from) {
      return json(400, { error: "Período inválido." });
    }
    const fromIso = from.toISOString();
    const toIso = to.toISOString();

    // Cache 24h por tenant+período (a menos que force=true).
    if (!body.force) {
      const since = new Date(Date.now() - CACHE_HOURS * 3600 * 1000).toISOString();
      const { data: cached, error: cacheErr } = await admin
        .from("ai_insights")
        .select("insights, created_at")
        .eq("tenant_id", tenantId)
        .eq("period_from", fromIso)
        .eq("period_to", toIso)
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(1)
        .maybeSingle();
      if (cacheErr) {
        // Falha aqui não bloqueia a resposta, mas não pode ser invisível: sem
        // cache, cada chamada regenera via IA paga — exatamente o custo que o
        // teto abaixo existe para conter.
        await captureEdgeError(admin, {
          severity: "warn",
          source: "edge",
          operation: "ai.insights.cache_lookup_failed",
          tenantId,
          message: cacheErr.message,
        });
      }
      if (cached) {
        return json(200, {
          insights: cached.insights,
          cached: true,
          generated_at: cached.created_at,
        });
      }
    }

    // Teto DEPOIS do cache: um cache hit custa zero e não pode consumir a cota
    // dimensionada para a chamada cara ao gateway. Antes disso, abrir o
    // relatório 4 vezes no mesmo minuto levava 429 sem ter gasto nada.
    const limite = await checkRateLimit(
      admin,
      `ai-insights:${userData.user.id}`,
      RATE_LIMIT_MAX_CALLS,
      RATE_LIMIT_WINDOW_MS,
    );
    if (!limite.allowed) {
      if (limite.rpcFailed) {
        await captureEdgeError(admin, {
          severity: "error",
          source: "edge",
          operation: "ai.insights.rate_limit",
          tenantId,
          message: "RPC check_and_record_rate_limit falhou; negado por fail-closed.",
          context: { user_id: userData.user.id },
        });
        return json(500, { error: "Erro ao verificar limite de uso. Tente de novo em instantes." });
      }
      return json(429, {
        error: "Muitas gerações seguidas de insight. Tente de novo em instantes.",
        retryAfterSeconds: Math.ceil((limite.retryAfterMs ?? RATE_LIMIT_WINDOW_MS) / 1000),
      });
    }

    // Reusa o RPC no contexto do usuário — mesmas regras de tenant/admin do relatório.
    const { data: report, error: reportErr } = await userClient.rpc("dashboard_report", {
      p_from: fromIso,
      p_to: toIso,
    });
    if (reportErr || !report) {
      // Branch de {data,error} do supabase-js que hoje só devolvia 500 —
      // nem console.error, nenhum registro em lugar nenhum.
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.insights.dashboard_report",
        tenantId,
        errorCode: reportErr?.code ?? null,
        message: reportErr?.message ?? "RPC dashboard_report não retornou dados.",
        context: { period_from: fromIso, period_to: toIso },
      });
      return json(500, { error: "Não foi possível montar o relatório." });
    }

    const gateway = getAIGatewayConfig();
    if (!gateway.apiKey) return json(500, { error: "IA indisponível no momento." });

    let insights: Insight[] = [];
    try {
      const r = await fetch(gateway.url, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${gateway.apiKey}` },
        body: JSON.stringify({
          model: gateway.model || AI_MODEL,
          reasoning_effort: gateway.reasoningEffort,
          messages: [{ role: "user", content: buildPrompt(report, fromIso, toIso) }],
        }),
        signal: AbortSignal.timeout(AI_TIMEOUT_MS),
      });
      if (!r.ok) {
        if (r.status === 429)
          return json(429, { error: "Muitas requisições à IA agora. Tente de novo em instantes." });
        if (r.status === 402) return json(402, { error: "Créditos de IA esgotados." });
        return json(500, { error: "A IA não conseguiu responder desta vez." });
      }
      const data = (await r.json()) as { choices?: Array<{ message?: { content?: string } }> };
      insights = parseInsights(data.choices?.[0]?.message?.content ?? "");
    } catch (e) {
      // Falha de rede/parse chamando o gateway — sem reportAIFailure nesta
      // function, então vai para captureEdgeError (melhor que nada).
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "ai.insights.gateway",
        tenantId,
        message: e instanceof Error ? e.message : String(e),
        stack: e instanceof Error ? (e.stack ?? null) : null,
      });
      return json(500, {
        error: "Não conseguimos falar com a IA agora — tente novamente em instantes.",
      });
    }
    if (insights.length === 0) {
      // A IA respondeu 200 mas o conteúdo não parseou em insights válidos —
      // hoje isso só vira uma resposta de erro pro cliente, sem nenhum
      // registro (nem console.log). Mesma classificação do catch acima: sem
      // reportAIFailure neste arquivo, o sink é captureEdgeError.
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "ai.insights.empty_output",
        tenantId,
        message: "A IA retornou uma análise que não parseou em insights válidos.",
        context: { period_from: fromIso, period_to: toIso },
      });
      return json(500, { error: "A IA retornou uma análise inválida. Tente novamente." });
    }

    const generatedAt = new Date().toISOString();
    // Cache é best-effort: falha de escrita não bloqueia a resposta. Cada
    // tentativa emite um evento estruturado (uma linha JSON) para auditoria —
    // zero PII, apenas metadados (tenant, request id, contagem, duração).
    const { error: insertErr } = await admin.from("ai_insights").insert({
      tenant_id: tenantId,
      period_from: fromIso,
      period_to: toIso,
      insights,
      model: AI_MODEL,
      created_at: generatedAt,
    });
    console.log(
      JSON.stringify({
        event: "ai_insights.write",
        tenant_id: tenantId,
        user_id: userData.user.id,
        request_id: requestId,
        period_from: fromIso,
        period_to: toIso,
        model: AI_MODEL,
        insight_count: insights.length,
        generated_at: generatedAt,
        duration_ms: Date.now() - startedAt,
        status: insertErr ? "error" : "ok",
        error_code: insertErr ? "insert_failed" : null,
        error_message: insertErr ? String(insertErr.message ?? insertErr) : null,
      }),
    );

    // Sinal in-app da falha: alimenta o banner de saúde em /relatorios.
    // Também best-effort — se essa segunda escrita falhar, o log estruturado
    // acima continua sendo a fonte de auditoria confiável.
    if (insertErr) {
      try {
        await admin.from("ai_insights_write_failures").insert({
          tenant_id: tenantId,
          request_id: requestId,
          error_message: String(insertErr.message ?? insertErr).slice(0, 500),
        });
      } catch (_e) {
        // engolido de propósito — não muda contrato da resposta.
      }
    }

    return json(200, { insights, cached: false, generated_at: generatedAt });
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.insights.handler",
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro ao gerar insights." });
  }
});

