// memory-summary.ts — memória tier-1: resumo periódico de conversa.
//
// Porta de clientes/pedro/medflow-v0/lib/ai/memory/summary.service.ts,
// adaptada a este projeto:
// - schema de mensagens é public.messages (colunas sender/direction/content
//   texto puro), não messaging_messages com content jsonb do medflow;
// - chamada LLM usa o mesmo módulo compartilhado gateway.ts (callLovableGateway),
//   que centraliza o fetch ao gateway Lovable pra todos os callers deste
//   projeto — NUNCA a abstração @ai-sdk/google do medflow
//   (docs/PRD-CRM-IA-MULTINICHO.md marca isso como anti-padrão a não copiar);
// - sem RPC "precisa consolidar" nem tabela ai_conversation_log (não
//   existem aqui) — só gera e grava o resumo em ai_conversation_summaries.
// O gateway Lovable não expõe garantia de response_format=json_schema para
// todos os modelos por trás dele; por isso o parsing é manual (mesmo padrão
// de parseInsights em ai-insights/index.ts:61), com validação campo a campo
// e fallback de erro claro em vez de gravar lixo no banco.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  callLovableGateway,
  getAIGatewayConfig,
  LovableGatewayHttpError,
  stripJsonFence,
  toStringArray,
} from "./gateway.ts";

const MIN_MESSAGES_FOR_SUMMARY = 5;
const MAX_MESSAGES_PER_SUMMARY = 30;
const AI_MODEL = "google/gemini-3-flash-preview";
const SUMMARY_MAX_OUTPUT_TOKENS = 700;

const VALID_SENTIMENTS = new Set(["positive", "neutral", "negative", "frustrated"]);

const SUMMARY_SYSTEM_PROMPT = `Você é um especialista em sintetizar conversas de vendas/atendimento.

Analise o histórico e responda APENAS com um objeto JSON puro (sem markdown, sem texto extra), no formato:
{
  "summary": "resumo conciso da conversa em 2-3 frases em português",
  "key_facts": ["fato importante 1", "..."],
  "sentiment": "positive" | "neutral" | "negative" | "frustrated",
  "topics_discussed": ["tópico 1", "..."],
  "open_questions": ["pergunta sem resposta 1", "..."],
  "commitments": ["promessa feita por qualquer parte", "..."],
  "objections": ["objeção ou resistência do lead", "..."]
}

REGRAS:
- Extraia APENAS informações explícitas na conversa.
- key_facts: no máximo 5 fatos mais importantes (preferências, dados pessoais, decisões).
- sentiment: avalie o tom geral do lead na conversa.
- topics_discussed: liste os assuntos abordados.
- open_questions: perguntas que ficaram sem resposta clara.
- commitments: promessas feitas por qualquer parte ("vou enviar", "ligo amanhã").
- objections: resistências ou objeções do lead ("achei caro", "preciso pensar").
- Seja conciso e factual.`;

export interface GenerateConversationSummaryParams {
  tenantId: string;
  contactId: string;
  conversationId: string;
  dealId?: string;
}

export interface GenerateConversationSummaryResult {
  success: boolean;
  error?: string;
}

interface MessageRow {
  content: string | null;
  sender: string;
  direction: string;
  created_at: string;
}

interface ConversationSummaryPayload {
  summary: string;
  key_facts: string[];
  sentiment: "positive" | "neutral" | "negative" | "frustrated" | null;
  topics_discussed: string[];
  open_questions: string[];
  commitments: string[];
  objections: string[];
}

/**
 * Gera (quando há mensagens novas suficientes) e grava um resumo estruturado
 * da conversa em public.ai_conversation_summaries.
 *
 * Nunca lança: qualquer falha (config ausente, LLM fora do ar, resposta
 * malformada, INSERT falhando) volta como `{ success: false, error }`.
 * `{ success: true }` sem `error` cobre tanto "resumo gerado e gravado"
 * quanto "menos de 5 mensagens novas, nada a fazer" — chamado fire-and-forget
 * pelo caller, que não precisa distinguir os dois caminhos felizes.
 */
export async function generateConversationSummary(
  supabase: SupabaseClient,
  params: GenerateConversationSummaryParams,
): Promise<GenerateConversationSummaryResult> {
  const { tenantId, contactId, conversationId, dealId } = params;

  try {
    const lastPeriodEnd = await fetchLastPeriodEnd(supabase, conversationId);
    const messages = await fetchMessagesSince(supabase, conversationId, lastPeriodEnd);

    if (messages.length < MIN_MESSAGES_FOR_SUMMARY) {
      return { success: true };
    }

    const gateway = getAIGatewayConfig();
    if (!gateway.apiKey) return { success: false, error: gateway.missingKeyMessage };

    const raw = await callSummaryLLM(messages);
    const payload = parseSummaryPayload(raw);
    if (!payload) {
      return { success: false, error: "A IA retornou um resumo em formato inválido." };
    }

    const periodStart = lastPeriodEnd ?? messages[0].created_at;
    const periodEnd = messages[messages.length - 1].created_at;

    const { error: insertError } = await supabase.from("ai_conversation_summaries").insert({
      tenant_id: tenantId,
      contact_id: contactId,
      conversation_id: conversationId,
      deal_id: dealId ?? null,
      summary: payload.summary,
      key_facts: payload.key_facts,
      sentiment: payload.sentiment,
      topics_discussed: payload.topics_discussed,
      open_questions: payload.open_questions,
      commitments: payload.commitments,
      objections: payload.objections,
      messages_covered: messages.length,
      period_start: periodStart,
      period_end: periodEnd,
    });

    if (insertError) {
      return { success: false, error: insertError.message };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error: err instanceof Error ? err.message : "Erro desconhecido ao gerar resumo da conversa.",
    };
  }
}

/** Último `period_end` já resumido desta conversa, ou null se nunca resumida. */
async function fetchLastPeriodEnd(
  supabase: SupabaseClient,
  conversationId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("ai_conversation_summaries")
    .select("period_end")
    .eq("conversation_id", conversationId)
    .order("period_end", { ascending: false })
    .limit(1)
    .maybeSingle();
  return (data as { period_end: string } | null)?.period_end ?? null;
}

/** Mensagens da conversa desde `sinceIso` (exclusive), até o teto de contexto. */
async function fetchMessagesSince(
  supabase: SupabaseClient,
  conversationId: string,
  sinceIso: string | null,
): Promise<MessageRow[]> {
  let query = supabase
    .from("messages")
    .select("content, sender, direction, created_at")
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(MAX_MESSAGES_PER_SUMMARY);

  if (sinceIso) {
    query = query.gt("created_at", sinceIso);
  }

  const { data, error } = await query;
  if (error) throw new Error(`Falha ao buscar mensagens: ${error.message}`);
  return (data ?? []) as MessageRow[];
}

function roleLabel(sender: string): string {
  if (sender === "contact") return "LEAD";
  if (sender === "ai") return "IA";
  return "ATENDENTE";
}

function formatMessages(messages: MessageRow[]): string {
  return messages
    .map((m) => `[${roleLabel(m.sender)}]: ${m.content?.trim() || "[mensagem sem texto]"}`)
    .join("\n");
}

/** Chama o gateway Lovable e devolve o texto bruto da resposta (sem parsear). */
async function callSummaryLLM(messages: MessageRow[]): Promise<string> {
  try {
    return await callLovableGateway(
      SUMMARY_SYSTEM_PROMPT,
      [{ role: "user", content: `Resuma esta conversa:\n\n${formatMessages(messages)}` }],
      AI_MODEL,
      { maxOutputTokens: SUMMARY_MAX_OUTPUT_TOKENS },
    );
  } catch (e) {
    if (e instanceof LovableGatewayHttpError) {
      if (e.statusCode === 429)
        throw new Error("Muitas requisições à IA agora. Tentaremos de novo em instantes.");
      if (e.statusCode === 402) throw new Error("Créditos de IA esgotados.");
      throw new Error("A IA não conseguiu gerar o resumo desta vez.");
    }
    throw e;
  }
}

/**
 * Parseia e valida a resposta da LLM contra o shape esperado. Retorna null
 * (nunca lança) se o JSON estiver ausente, malformado ou faltando o campo
 * obrigatório `summary` — o caller trata isso como falha reportável.
 */
export function parseSummaryPayload(raw: string): ConversationSummaryPayload | null {
  // A IA às vezes embrulha em ```json``` — remove cercas antes de parsear
  // (mesmo padrão de parseInsights em ai-insights/index.ts).
  const cleaned = stripJsonFence(raw);
  if (!cleaned) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;

  const summary = typeof o.summary === "string" ? o.summary.trim() : "";
  if (!summary) return null;

  const sentimentRaw = typeof o.sentiment === "string" ? o.sentiment : null;
  const sentiment =
    sentimentRaw && VALID_SENTIMENTS.has(sentimentRaw)
      ? (sentimentRaw as ConversationSummaryPayload["sentiment"])
      : null;

  return {
    summary,
    key_facts: toStringArray(o.key_facts).slice(0, 5),
    sentiment,
    topics_discussed: toStringArray(o.topics_discussed),
    open_questions: toStringArray(o.open_questions),
    commitments: toStringArray(o.commitments),
    objections: toStringArray(o.objections),
  };
}
