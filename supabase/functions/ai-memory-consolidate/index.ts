// Entry point invocável para consolidação de memória de contato (tier-2).
//
// `_shared/ai/memory-consolidator.ts` (consolidateContactMemory,
// findContactsNeedingConsolidation) já existia e era testado, mas não tinha
// NENHUM caller em produção — 327 linhas de lógica que nunca rodavam. Esta
// function fecha esse gap: dado um tenant, encontra os contatos com memória
// desatualizada e consolida cada um.
//
// Auth: fail-closed — Bearer deve ser exatamente SUPABASE_SERVICE_ROLE_KEY
// (mesmo padrão de supabase/functions/ai-respond/index.ts). Não é uma rota
// pública nem chamada pelo frontend com JWT de usuário; é pensada para ser
// chamada por um processo server-side (cron, job manual, etc).
//
// IMPORTANTE — escopo deliberadamente limitado nesta lane: esta function NÃO
// está agendada (sem pg_cron, sem migration de agendamento). Rodar isso
// periodicamente para todos os tenants significa custo recorrente de LLM
// (uma chamada por contato elegível, por tenant, por execução) — isso é uma
// decisão de produto/custo/autonomia, não uma correção de bug, e precisa de
// aprovação explícita antes de virar automação. Por enquanto ela só existe
// como entry point invocável manualmente (ex.: via curl com a service role
// key, ou por um botão futuro em /configuracoes).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  consolidateContactMemory,
  findContactsNeedingConsolidation,
} from "../_shared/ai/memory-consolidator.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

// Teto de segurança independente do `limit` pedido no corpo — evita que uma
// chamada mal-configurada (ex.: limit muito alto) dispare uma quantidade
// grande demais de chamadas LLM sequenciais numa única invocação.
const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

interface Payload {
  tenantId?: string;
  limit?: number;
}

interface ConsolidateSummary {
  processed: number;
  succeeded: number;
  failed: number;
  errors: string[];
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

function resolveLimit(requested: unknown): number {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_LIMIT;
  }
  return Math.min(Math.floor(requested), MAX_LIMIT);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

  // Fail-closed: only accept service-role bearer.
  const authHeader = req.headers.get("Authorization") ?? "";
  const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
  if (!bearer || bearer !== SERVICE_ROLE) {
    return json(401, { error: "Unauthorized" });
  }

  let body: Payload;
  try {
    body = (await req.json()) as Payload;
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  if (!body.tenantId || typeof body.tenantId !== "string") {
    return json(400, { error: "tenantId obrigatório." });
  }
  const tenantId = body.tenantId;
  const limit = resolveLimit(body.limit);

  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false, autoRefreshToken: false } });

  // Catch de topo: antes deste ponto em diante nada era instrumentado — um
  // throw de findContactsNeedingConsolidation (rede/DB) virava 500 sem
  // nenhum evento consultável.
  try {
    const contactIds = await findContactsNeedingConsolidation(admin, tenantId, limit);

    const summary: ConsolidateSummary = {
      processed: contactIds.length,
      succeeded: 0,
      failed: 0,
      errors: [],
    };

    // Sequencial de propósito: cada consolidação já faz uma chamada LLM; rodar
    // em paralelo multiplicaria a chance de estourar rate limit do gateway
    // dentro de uma única invocação (mesma cautela de findContactsNeedingConsolidation
    // ser fail-open — aqui preferimos previsibilidade de custo/carga a velocidade).
    for (const contactId of contactIds) {
      const result = await consolidateContactMemory(admin, { tenantId, contactId });
      if (result.success) {
        summary.succeeded++;
      } else {
        summary.failed++;
        if (result.error) summary.errors.push(`${contactId}: ${result.error}`);
      }
    }

    // consolidateContactMemory devolve { success: false, error } em vez de lançar,
    // e esta function sempre respondia 200 mesmo com falhas parciais — trabalho
    // parcial silencioso (ninguém lê o corpo da resposta de um invocador
    // server-side). Reporta o agregado, não por item, para não multiplicar
    // eventos num tenant com muitos contatos elegíveis.
    if (summary.failed > 0) {
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "ai.memory_consolidate.partial_failure",
        tenantId,
        message: `${summary.failed} de ${summary.processed} consolidação(ões) de memória falharam.`,
        context: { limit, errors: summary.errors.slice(0, 10) },
      });
    }

    return json(200, summary);
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "ai.memory_consolidate.handler",
      tenantId,
      message: e instanceof Error ? e.message : String(e),
      stack: e instanceof Error ? (e.stack ?? null) : null,
    });
    return json(500, { error: "Erro ao consolidar memórias." });
  }
});
