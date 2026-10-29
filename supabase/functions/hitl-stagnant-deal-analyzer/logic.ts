// Lógica pura do hitl-stagnant-deal-analyzer — SEM chamada LLM, SEM I/O
// (nem `Deno.env.get`: quem lê env é index.ts, que repassa o valor bruto pra
// cá). Separado de index.ts pelo mesmo motivo de
// hitl-overdue-activity-analyzer/logic.ts: `deno test` roda sem `--allow-net`,
// e um import estático de um módulo com `Deno.serve(...)` no topo dispararia
// esse `Deno.serve` de verdade e quebraria com PermissionDenied —
// `captureHandler` só evita isso porque troca `Deno.serve` por um stub ANTES
// do import dinâmico, o que não cobre um import estático direto como o que os
// testes de lógica pura fazem aqui.
//
// Regra do PRD (docs/PRD-CRM-IA-MULTINICHO.md:1644,1670-1673): deal
// `status='open'` sem atualização de `stage_entered_at` há mais de N dias,
// com evidência mínima de conversa real vinculada, ganha uma sugestão de
// avanço/ação via LLM em `hitl_decisions` — guardrail "sem conversa real, sem
// avanço automático": sem evidência, a IA NUNCA é chamada para este deal.

import { formatDaysLabel, MS_PER_DAY } from "../_shared/hitl/format.ts";

export const DEFAULT_STALE_DAYS = 3;
export const MAX_STALE_DAYS = 90;

export const DEFAULT_RATE_LIMIT = 20;
export const MAX_RATE_LIMIT = 100;

// Evidência mínima do guardrail "sem conversa real, sem avanço automático":
// 3 mensagens no TOTAL numa mesma conversa presume uma troca real (ida e
// volta), não só 1 mensagem automática de saudação sem resposta nenhuma; E
// pelo menos 1 mensagem do próprio contato (sender='contact') garante
// engajamento genuíno de duas vias — uma conversa com 3 mensagens todas de
// sender='ai'/'agent' e zero resposta do lead não é evidência de nada, é só
// a IA falando sozinha.
export const MIN_EVIDENCE_MESSAGES = 3;

// Quantos deals candidatos escanear (no total, entre todos os tenants
// ativos) além do orçamento de avaliações por LLM (`limit`): muitos
// candidatos vão falhar o guardrail de evidência antes de chegar na IA, então
// escaneamos mais do que o rate limit pra ter chance de preenchê-lo só com
// deals que realmente qualificam. Capado (MAX_SCAN_BATCH) pra nunca escanear
// ilimitado mesmo se o backlog de deals parados for grande.
export const SCAN_MULTIPLIER = 5;
export const MAX_SCAN_BATCH = 200;

/**
 * `staleDays` efetivo: body.staleDays > env (HITL_STAGNANT_DEAL_DAYS) >
 * DEFAULT_STALE_DAYS, sempre capado em MAX_STALE_DAYS — inclusive o valor
 * vindo de env (senão um operador podia setar HITL_STAGNANT_DEAL_DAYS=9999
 * e furar o teto de segurança). `envRaw` já vem lido por index.ts
 * (Deno.env.get) — este módulo não toca env diretamente.
 */
export function resolveStaleDays(requested: unknown, envRaw: string | undefined): number {
  const envParsed = Number(envRaw);
  const envFallback = Number.isFinite(envParsed) && envParsed > 0
    ? Math.min(Math.floor(envParsed), MAX_STALE_DAYS)
    : DEFAULT_STALE_DAYS;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return envFallback;
  }
  // Math.floor(requested) >= 1: requested fracionário entre 0 e 1 (ex.: 0.5)
  // passa o check "> 0" mas Math.floor vira 0, o que marcaria TODO deal como
  // parado. Volta ao fallback nesse caso.
  const floored = Math.floor(requested);
  if (floored < 1) return envFallback;
  return Math.min(floored, MAX_STALE_DAYS);
}

/**
 * Rate limit efetivo (quantos deals podem ser avaliados por LLM nesta
 * execução): mesma precedência e mesmos caps de resolveStaleDays (inclusive
 * env não pode furar MAX_RATE_LIMIT, e requested fracionário < 1 cai no
 * fallback). Teto de segurança independente do que for pedido, mesmo
 * raciocínio defensivo de ai-memory-consolidate/index.ts (resolveLimit).
 */
export function resolveRateLimit(requested: unknown, envRaw: string | undefined): number {
  const envParsed = Number(envRaw);
  const envFallback = Number.isFinite(envParsed) && envParsed > 0
    ? Math.min(Math.floor(envParsed), MAX_RATE_LIMIT)
    : DEFAULT_RATE_LIMIT;
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) {
    return envFallback;
  }
  const floored = Math.floor(requested);
  if (floored < 1) return envFallback;
  return Math.min(floored, MAX_RATE_LIMIT);
}

/** Ver comentário de SCAN_MULTIPLIER/MAX_SCAN_BATCH acima. */
export function resolveScanBatchSize(rateLimit: number): number {
  return Math.min(rateLimit * SCAN_MULTIPLIER, MAX_SCAN_BATCH);
}

export interface ConversationEvidence {
  conversationId: string;
  totalMessages: number;
  contactMessages: number;
}

/**
 * Guardrail de evidência ("sem conversa real, sem avanço automático"): true
 * só se PELO MENOS UMA conversa vinculada ao deal tiver >= minMessages
 * mensagens no total E >= 1 mensagem do contato. Ver MIN_EVIDENCE_MESSAGES
 * acima para a justificativa dos dois números.
 */
export function hasEnoughEvidence(
  evidence: ConversationEvidence[],
  minMessages: number = MIN_EVIDENCE_MESSAGES,
): boolean {
  return evidence.some((c) => c.totalMessages >= minMessages && c.contactMessages >= 1);
}

export type StagnantDealAssessment = "advance" | "stalled";
export type DecisionCategory = "opportunity" | "risk";
export type DecisionPriority = "high" | "medium";

/**
 * Heurística simples e documentada (pedida explicitamente pela tarefa desta
 * fase): a IA classifica o sinal dominante da conversa em "advance"
 * (evidência de que o lead está pronto para seguir — falta só uma ação) ou
 * "stalled" (esfriamento/objeção não resolvida/parou de responder). O schema
 * `hitl_decisions.category` (migration Fase 3) não tem uma categoria
 * "estagnado" dedicada — só 'follow_up' | 'deadline' | 'opportunity' | 'risk'
 * | 'routine' — então mapeamos 1:1: "risk" é semanticamente o mais próximo
 * de "está esfriando, aja antes de perder o deal", e "opportunity" de "há uma
 * ação clara de avanço disponível agora".
 */
export function categorizeAssessment(assessment: StagnantDealAssessment): DecisionCategory {
  return assessment === "advance" ? "opportunity" : "risk";
}

/**
 * Heurística simples e documentada: risco de PERDER o deal é sempre
 * priorizado sobre uma oportunidade de avanço (perder é mais caro que
 * atrasar um avanço); dentro de "risk", quanto mais dias parado, maior a
 * prioridade. Nunca "critical" aqui — esse nível fica reservado ao watchdog
 * de SLA (hitl-sla-monitor), que trata um handoff humano sem resposta, mais
 * urgente que um deal parado.
 */
export function priorityFor(
  category: DecisionCategory,
  daysStagnantValue: number,
): DecisionPriority {
  if (category === "risk") return daysStagnantValue >= 14 ? "high" : "medium";
  return "medium";
}

/** Dias (fracionários) desde `stage_entered_at` — positivo por definição
 * para qualquer linha que já passou pelo filtro `stage_entered_at < now() -
 * interval` da query. `now` é injetado (não `new Date()` interno) para
 * testabilidade determinística, mesmo padrão de daysOverdue em
 * hitl-overdue-activity-analyzer/logic.ts. */
export function daysStagnant(stageEnteredAt: string, now: Date): number {
  return (now.getTime() - new Date(stageEnteredAt).getTime()) / MS_PER_DAY;
}

export interface StagnantDealCandidate {
  id: string;
  tenant_id: string;
  contact_id: string | null;
  title: string | null;
}

export interface StagnantAssessment {
  confidence: number;
  assessment: StagnantDealAssessment;
  reasoning: string;
  suggestedAction: string;
}

export interface HitlDecisionInsert {
  tenant_id: string;
  type: string;
  category: DecisionCategory;
  priority: DecisionPriority;
  title: string;
  description: string;
  reasoning: string;
  deal_id: string;
  contact_id: string | null;
  suggested_action: {
    action: string;
    assessment: StagnantDealAssessment;
    confidence: number;
    days_stagnant: number;
  };
  auto_generated: boolean;
}

/** Monta o payload de INSERT em hitl_decisions para um deal parado já
 * avaliado pela IA. Função pura — categoria/prioridade vêm das heurísticas
 * acima, nada de I/O. */
export function buildStagnantDecisionInsert(
  deal: StagnantDealCandidate,
  assessment: StagnantAssessment,
  daysStagnantValue: number,
): HitlDecisionInsert {
  const category = categorizeAssessment(assessment.assessment);
  const priority = priorityFor(category, daysStagnantValue);
  const daysLabel = formatDaysLabel(Math.floor(daysStagnantValue));

  return {
    tenant_id: deal.tenant_id,
    type: "stagnant_deal",
    category,
    priority,
    title: `Deal parado há ${daysLabel}: ${deal.title || "sem título"}`,
    description: assessment.reasoning || "Sem evidência adicional fornecida pela IA.",
    reasoning: assessment.reasoning,
    deal_id: deal.id,
    contact_id: deal.contact_id,
    suggested_action: {
      action: assessment.suggestedAction,
      assessment: assessment.assessment,
      confidence: assessment.confidence,
      days_stagnant: Math.floor(daysStagnantValue),
    },
    auto_generated: true,
  };
}
