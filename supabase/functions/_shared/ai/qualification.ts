// qualification.ts — snapshot de qualificação de deal, sob demanda.
//
// Porta de clientes/pedro/medflow-v0/lib/ai/briefing/{briefing.service,schemas}.ts,
// GENERICIZADA: o medflow tinha BANT hardcoded (budget/authority/need/timeline)
// como 4 campos fixos no schema. Aqui as dimensões vêm de
// niche_templates.qualification_dimensions (jsonb, lista de {key,label}) do
// nicho do tenant — o prompt e o parsing iteram sobre essa lista, nunca
// assumem um conjunto fixo de chaves. Um tenant sem nicho configurado (ou
// nicho sem override) cai no default da própria coluna (mesmas 4 dimensões
// do medflow, só que como DADO, não como shape de código).
//
// Outras diferenças do porte:
// - schema de mensagens é public.messages (sender/content texto puro), não
//   messaging_messages com content jsonb;
// - deal -> conversa é via contact_id (não metadata.deal_id): um contato pode
//   ter conversas em múltiplos canais, então agregamos mensagens de TODAS as
//   conversas do contato do deal, não de uma única;
// - chamada LLM usa o mesmo módulo compartilhado gateway.ts (callLovableGateway),
//   que centraliza o fetch ao gateway Lovable pra todos os callers deste
//   projeto (NUNCA a abstração @ai-sdk/google do medflow — anti-padrão
//   marcado em docs/PRD-CRM-IA-MULTINICHO.md);
// - parsing manual (mesmo padrão de parseInsights em ai-insights/index.ts e
//   parseSummaryPayload em memory-summary.ts), sem Zod/structured output —
//   o gateway Lovable não garante response_format=json_schema para todo
//   modelo por trás dele;
// - FAIL-CLOSED nos pré-checks (deal/tenant não encontrado lançam erro
//   claro), diferente do fail-open de memory-summary.ts: qualificação é uma
//   ação explícita sob demanda (o usuário clicou em "gerar qualificação"),
//   então uma falha silenciosa aqui esconderia o problema em vez de deixar o
//   caller decidir o que mostrar.
//
// Este arquivo é só o orquestrador: contexto (leitura do deal/dimensões/
// mensagens), prompt (system + formatação) e parsing (validação da resposta
// da IA) vivem em ./qualification/{context,prompt,parsing}.ts. A API pública
// (generateQualificationSnapshot + os tipos exportados abaixo) é a mesma de
// antes do split.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { buildDealQualificationContext } from "./qualification/context.ts";
import { buildSystemPrompt, formatContextForPrompt } from "./qualification/prompt.ts";
import { callLovableGateway, getAIGatewayConfig, LovableGatewayHttpError } from "./gateway.ts";
import {
  parseQualificationPayload,
  type QualificationDimensionResult,
  type PendingPoint,
  type QualificationAlert,
  type RecommendedApproach,
} from "./qualification/parsing.ts";

export type { QualificationDimensionConfig } from "./qualification/context.ts";
export type {
  QualificationDimensionResult,
  PendingPoint,
  QualificationAlert,
  RecommendedApproach,
} from "./qualification/parsing.ts";

const AI_MODEL = "google/gemini-3-flash-preview";
const QUALIFICATION_MAX_OUTPUT_TOKENS = 1200;

// =============================================================================
// Tipos públicos
// =============================================================================

export interface QualificationSnapshot {
  id: string;
  tenantId: string;
  dealId: string;
  executiveSummary: string;
  dimensions: QualificationDimensionResult[];
  pendingPoints: PendingPoint[];
  recommendedApproach: RecommendedApproach;
  alerts: QualificationAlert[];
  confidence: number;
  basedOnMessages: number;
  generatedAt: string;
}

// =============================================================================
// Geração — orquestrador
// =============================================================================

/**
 * Gera um snapshot de qualificação para um deal e grava em
 * public.deal_qualification_snapshots. Ação sob demanda (não roda por
 * mensagem) — chamada pelo edge function ai-qualification.
 *
 * FAIL-CLOSED: deal ou tenant não encontrado, LOVABLE_API_KEY ausente,
 * resposta da IA malformada ou falha no INSERT lançam erro com mensagem
 * clara em português — nunca retornam um snapshot parcial/inválido.
 *
 * @param supabase client Supabase (service_role — bypassa RLS de propósito;
 *   o caller já validou que o usuário pertence ao tenant do deal)
 * @param dealId id do deal a qualificar
 */
export async function generateQualificationSnapshot(
  supabase: SupabaseClient,
  dealId: string,
): Promise<QualificationSnapshot> {
  const context = await buildDealQualificationContext(supabase, dealId);

  const gateway = getAIGatewayConfig();
  if (!gateway.apiKey) throw new Error(gateway.missingKeyMessage);

  const systemPrompt = buildSystemPrompt(context.dimensions);
  const userPrompt = formatContextForPrompt(context);
  const raw = await callQualificationLLM(systemPrompt, userPrompt);
  const payload = parseQualificationPayload(raw, context.dimensions);
  if (!payload) {
    throw new Error("A IA retornou uma qualificação em formato inválido.");
  }

  const { data: inserted, error: insertError } = await supabase
    .from("deal_qualification_snapshots")
    .insert({
      tenant_id: context.tenant.id,
      deal_id: context.deal.id,
      executive_summary: payload.executiveSummary,
      dimensions: payload.dimensions,
      pending_points: payload.pendingPoints,
      recommended_approach: payload.recommendedApproach,
      alerts: payload.alerts,
      confidence: payload.confidence,
      based_on_messages: context.messages.length,
    })
    .select("id, generated_at")
    .single();

  if (insertError || !inserted) {
    throw new Error(
      `Falha ao gravar snapshot de qualificação: ${insertError?.message ?? "erro desconhecido"}`,
    );
  }
  const insertedRow = inserted as { id: string; generated_at: string };

  return {
    id: insertedRow.id,
    tenantId: context.tenant.id,
    dealId: context.deal.id,
    executiveSummary: payload.executiveSummary,
    dimensions: payload.dimensions,
    pendingPoints: payload.pendingPoints,
    recommendedApproach: payload.recommendedApproach,
    alerts: payload.alerts,
    confidence: payload.confidence,
    basedOnMessages: context.messages.length,
    generatedAt: insertedRow.generated_at,
  };
}

// =============================================================================
// Chamada LLM
// =============================================================================

async function callQualificationLLM(systemPrompt: string, userPrompt: string): Promise<string> {
  try {
    return await callLovableGateway(
      systemPrompt,
      [{ role: "user", content: userPrompt }],
      AI_MODEL,
      {
        maxOutputTokens: QUALIFICATION_MAX_OUTPUT_TOKENS,
      },
    );
  } catch (e) {
    if (e instanceof LovableGatewayHttpError) {
      const message =
        e.statusCode === 429
          ? "Muitas requisições à IA agora. Tente de novo em instantes."
          : e.statusCode === 402
            ? "Créditos de IA esgotados."
            : "A IA não conseguiu gerar a qualificação desta vez.";
      throw Object.assign(new Error(message), { statusCode: e.statusCode, provider: "lovable" });
    }
    throw e;
  }
}
