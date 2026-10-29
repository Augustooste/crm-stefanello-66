// memory-consolidator.ts — memória tier-2: perfil consolidado por contato.
//
// Porta de clientes/pedro/medflow-v0/lib/ai/memory/consolidator.service.ts
// (função `consolidateContactMemory`) + `findContactsNeedingConsolidation`,
// adaptada a este projeto:
// - schema de saída simplificado (ContactMemorySchema em
//   lib/ai/memory/schemas.ts do medflow): { personality, preferences[],
//   history_summary, important_dates[], relationship_notes };
// - chamada LLM usa o mesmo módulo compartilhado gateway.ts (callLovableGateway),
//   que centraliza o fetch ao gateway Lovable pra todos os callers deste
//   projeto — NUNCA `getModel`/`getOrgAIConfig` do medflow (multi-provider BYO
//   nunca existiu aqui: a chave vem do ambiente do gateway, não de coluna por-tenant);
// - parsing é manual (mesmo padrão de parseSummaryPayload em
//   ./memory-summary.ts e parseInsights em ai-insights/index.ts), com
//   validação campo a campo — o gateway Lovable não garante
//   response_format=json_schema para todos os modelos por trás dele;
// - `findContactsNeedingConsolidation` NÃO tenta uma RPC dedicada primeiro
//   (o medflow tenta `contacts_needing_memory_consolidation` e cai no
//   fallback manual se não existir) — aqui a RPC nunca foi criada (fora do
//   escopo desta migration), então já vai direto pro fallback manual;
// - sem log de tokens em `ai_conversation_log` (tabela não existe aqui,
//   mesma genericização já aplicada em memory-summary.ts).

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  callLovableGateway,
  getAIGatewayConfig,
  LovableGatewayHttpError,
  stripJsonFence,
  toStringArray,
} from "./gateway.ts";

const MAX_SUMMARIES_FOR_CONSOLIDATION = 20;
const AI_MODEL = "google/gemini-3-flash-preview";
const CONSOLIDATOR_MAX_OUTPUT_TOKENS = 800;

const CONSOLIDATOR_SYSTEM_PROMPT = `Você é um especialista em criar perfis de relacionamento com clientes.

A partir de múltiplos resumos de conversas com o mesmo contato, gere um perfil consolidado em PORTUGUÊS BRASILEIRO.

Responda APENAS com um objeto JSON puro (sem markdown, sem texto extra), no formato:
{
  "personality": "estilo de comunicação observado (direto, detalhista, impaciente, amigável, etc) ou null",
  "preferences": ["preferência concreta 1 (horários, canais, etc)", "..."],
  "history_summary": "história do relacionamento em 3-5 frases cronológicas",
  "important_dates": [{"date": "data ou referência textual", "note": "o que é essa data"}],
  "relationship_notes": "contexto relacional (quem indicou, VIP, etc) ou null"
}

REGRAS:
- Priorize informações RECENTES sobre antigas quando conflitarem.
- Seja factual, não invente.
- history_summary é obrigatório e nunca vazio.`;

/** Shape gravado em `contacts.ai_memory` (sem `last_consolidated_at` — ver StoredContactMemory). */
export interface ContactMemory {
  personality: string | null;
  preferences: string[];
  history_summary: string;
  important_dates: Array<{ date: string; note: string }>;
  relationship_notes: string | null;
}

/** `ContactMemory` + carimbo de quando a consolidação rodou — é o que de fato vai pro banco. */
export interface StoredContactMemory extends ContactMemory {
  last_consolidated_at: string;
}

export interface ConsolidateContactMemoryParams {
  tenantId: string;
  contactId: string;
}

export interface ConsolidateContactMemoryResult {
  success: boolean;
  error?: string;
}

interface SummaryRow {
  summary: string;
  key_facts: string[];
  sentiment: string | null;
  topics_discussed: string[];
  commitments: string[];
  objections: string[];
  period_start: string;
  period_end: string;
}

/**
 * Consolida os resumos de conversa de um contato (public.ai_conversation_summaries)
 * em um perfil de memória de longo prazo, gravado em public.contacts.ai_memory.
 *
 * Nunca lança: qualquer falha (sem chave, LLM fora do ar, resposta malformada,
 * UPDATE falhando) volta como `{ success: false, error }`. `{ success: true }`
 * sem `error` cobre tanto "memória consolidada e gravada" quanto "contato sem
 * nenhum resumo ainda, nada a fazer" — mesma política fail-open leve do
 * medflow (chamado em lote periódico, não deve travar o cron por um contato).
 */
export async function consolidateContactMemory(
  supabase: SupabaseClient,
  params: ConsolidateContactMemoryParams,
): Promise<ConsolidateContactMemoryResult> {
  const { tenantId, contactId } = params;

  try {
    const { rows: summaries, queryError } = await fetchSummariesForConsolidation(
      supabase,
      tenantId,
      contactId,
    );
    // Erro de banco NÃO é "nada a fazer": conta como falha deste contato (o lote
    // segue, mas o cron para de reportar sucesso sobre algo que não aconteceu).
    if (queryError) {
      return { success: false, error: `Falha ao ler resumos do contato: ${queryError}` };
    }
    if (summaries.length === 0) return { success: true };

    const gateway = getAIGatewayConfig();
    if (!gateway.apiKey) return { success: false, error: gateway.missingKeyMessage };

    const contactName = await fetchContactName(supabase, tenantId, contactId);

    const raw = await callConsolidatorLLM(contactName, summaries);
    const parsed = parseContactMemory(raw);
    if (!parsed) {
      return { success: false, error: "A IA retornou uma memória em formato inválido." };
    }

    const memory: StoredContactMemory = {
      ...parsed,
      last_consolidated_at: new Date().toISOString(),
    };

    const { error: updateError } = await supabase
      .from("contacts")
      .update({ ai_memory: memory })
      .eq("id", contactId)
      .eq("tenant_id", tenantId);

    if (updateError) {
      return { success: false, error: updateError.message };
    }

    return { success: true };
  } catch (err) {
    return {
      success: false,
      error:
        err instanceof Error ? err.message : "Erro desconhecido ao consolidar memória do contato.",
    };
  }
}

/**
 * Busca contatos cuja memória consolidada está desatualizada (ou nunca foi
 * gerada) em relação aos resumos mais recentes disponíveis. Usado pelo cron
 * de consolidação em lote para decidir quais contatos processar nesta rodada.
 *
 * Sem RPC dedicada (ver header) — filtra direto: busca os `limit * 3`
 * resumos mais recentes do tenant, deduplica por contato (mantendo o
 * `period_end` do resumo mais recente) e compara com
 * `contacts.ai_memory->>'last_consolidated_at'`.
 */
export async function findContactsNeedingConsolidation(
  supabase: SupabaseClient,
  tenantId: string,
  limit = 10,
): Promise<string[]> {
  const { data: summaries } = await supabase
    .from("ai_conversation_summaries")
    .select("contact_id, period_end")
    .eq("tenant_id", tenantId)
    .order("created_at", { ascending: false })
    .limit(limit * 3);

  if (!summaries || summaries.length === 0) return [];

  // Dedup: mantém o period_end do resumo mais recente (created_at desc) por contato.
  const latestPeriodEndByContact = new Map<string, string>();
  for (const s of summaries as Array<{ contact_id: string; period_end: string }>) {
    if (!latestPeriodEndByContact.has(s.contact_id)) {
      latestPeriodEndByContact.set(s.contact_id, s.period_end);
    }
  }

  const candidateIds = [...latestPeriodEndByContact.keys()].slice(0, limit);
  if (candidateIds.length === 0) return [];

  const { data: contacts } = await supabase
    .from("contacts")
    .select("id, ai_memory")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .in("id", candidateIds);

  // Query falhou (data null): fail-open, consolidar todos os candidatos em
  // vez de travar o lote inteiro por causa de uma falha transitória de banco.
  if (!contacts) return candidateIds;

  return (contacts as Array<{ id: string; ai_memory: Record<string, unknown> | null }>)
    .filter((c) => {
      const lastConsolidatedAt = c.ai_memory?.last_consolidated_at as string | undefined;
      if (!lastConsolidatedAt) return true; // nunca consolidado
      const latestSummaryAt = latestPeriodEndByContact.get(c.id);
      return latestSummaryAt ? latestSummaryAt > lastConsolidatedAt : false;
    })
    .map((c) => c.id)
    .slice(0, limit);
}

/** Até MAX_SUMMARIES_FOR_CONSOLIDATION resumos do contato, do mais antigo pro mais novo. */
async function fetchSummariesForConsolidation(
  supabase: SupabaseClient,
  tenantId: string,
  contactId: string,
): Promise<{ rows: SummaryRow[]; queryError: string | null }> {
  // CRITICAL (code review): antes, erro de query caía no MESMO caminho de "sem
  // resumos" e o caller devolvia { success: true } — falha de banco reportada
  // como sucesso, memória nunca consolidada e degrade invisível (nenhuma métrica
  // de erro subia). O fail-open segue (não travar o lote do cron), mas agora o
  // erro é um terceiro estado distinguível de "não há o que fazer".
  const { data, error } = await supabase
    .from("ai_conversation_summaries")
    .select(
      "summary, key_facts, sentiment, topics_discussed, commitments, objections, period_start, period_end",
    )
    .eq("tenant_id", tenantId)
    .eq("contact_id", contactId)
    .order("period_end", { ascending: true })
    .limit(MAX_SUMMARIES_FOR_CONSOLIDATION);
  if (error) {
    console.error(
      `[memory-consolidator] falha ao ler resumos (tenant=${tenantId} contact=${contactId}): ${error.message}`,
    );
    return { rows: [], queryError: error.message };
  }
  return { rows: (data ?? []) as SummaryRow[], queryError: null };
}

/** Nome do contato para dar contexto ao prompt — best-effort, segue com "Desconhecido" se faltar. */
async function fetchContactName(
  supabase: SupabaseClient,
  tenantId: string,
  contactId: string,
): Promise<string | null> {
  const { data } = await supabase
    .from("contacts")
    .select("name")
    .eq("id", contactId)
    .eq("tenant_id", tenantId)
    .maybeSingle();
  return (data as { name: string } | null)?.name ?? null;
}

function formatSummariesForPrompt(summaries: SummaryRow[]): string {
  return summaries
    .map((s, i) => {
      const start = new Date(s.period_start).toLocaleDateString("pt-BR");
      const end = new Date(s.period_end).toLocaleDateString("pt-BR");
      return `### Interação ${i + 1} (${start} - ${end})
Resumo: ${s.summary}
Fatos: ${s.key_facts.join(", ") || "nenhum"}
Sentimento: ${s.sentiment || "neutro"}
Tópicos: ${s.topics_discussed.join(", ") || "nenhum"}
Compromissos: ${s.commitments.join(", ") || "nenhum"}
Objeções: ${s.objections.join(", ") || "nenhuma"}`;
    })
    .join("\n\n");
}

/** Chama o gateway Lovable e devolve o texto bruto da resposta (sem parsear). */
async function callConsolidatorLLM(
  contactName: string | null,
  summaries: SummaryRow[],
): Promise<string> {
  const prompt = `Consolide o perfil do contato "${contactName || "Desconhecido"}" a partir destas ${summaries.length} interações:\n\n${formatSummariesForPrompt(summaries)}`;

  try {
    return await callLovableGateway(
      CONSOLIDATOR_SYSTEM_PROMPT,
      [{ role: "user", content: prompt }],
      AI_MODEL,
      {
        maxOutputTokens: CONSOLIDATOR_MAX_OUTPUT_TOKENS,
      },
    );
  } catch (e) {
    if (e instanceof LovableGatewayHttpError) {
      if (e.statusCode === 429)
        throw new Error("Muitas requisições à IA agora. Tentaremos de novo em instantes.");
      if (e.statusCode === 402) throw new Error("Créditos de IA esgotados.");
      throw new Error("A IA não conseguiu consolidar a memória desta vez.");
    }
    throw e;
  }
}

/**
 * Parseia e valida a resposta da LLM contra ContactMemory. Retorna null
 * (nunca lança) se o JSON estiver ausente, malformado ou faltando o campo
 * obrigatório `history_summary` — o caller trata isso como falha reportável.
 */
export function parseContactMemory(raw: string): ContactMemory | null {
  // A IA às vezes embrulha em ```json``` — remove cercas antes de parsear
  // (mesmo padrão de parseSummaryPayload em ./memory-summary.ts).
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

  const historySummary = typeof o.history_summary === "string" ? o.history_summary.trim() : "";
  if (!historySummary) return null;

  return {
    personality: toNullableString(o.personality),
    preferences: toStringArray(o.preferences),
    history_summary: historySummary,
    important_dates: toImportantDates(o.important_dates),
    relationship_notes: toNullableString(o.relationship_notes),
  };
}

function toNullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function toImportantDates(value: unknown): Array<{ date: string; note: string }> {
  if (!Array.isArray(value)) return [];
  const out: Array<{ date: string; note: string }> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const date = typeof o.date === "string" ? o.date.trim() : "";
    const note = typeof o.note === "string" ? o.note.trim() : "";
    if (!date || !note) continue;
    out.push({ date, note });
  }
  return out;
}
