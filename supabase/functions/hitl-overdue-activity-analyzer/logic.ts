// Lógica pura do hitl-overdue-activity-analyzer — SEM chamada LLM, SEM I/O.
// Regra do PRD (docs/PRD-CRM-IA-MULTINICHO.md:1645 e 1674): uma atividade com
// due_at < now() e completed_at IS NULL vira no máximo 1 decisão pendente em
// hitl_decisions, priorizada só por quanto tempo está atrasada — sem
// necessidade de avaliação por IA (é regra determinística).
//
// Separado de index.ts (que tem `Deno.serve` no escopo do módulo) para poder
// ser importado direto pelos testes: `deno test` roda sem `--allow-net`, e um
// import estático de um módulo que chama `Deno.serve(...)` no topo dispararia
// esse `Deno.serve` de verdade (tentando abrir um listener) e quebraria com
// PermissionDenied. `captureHandler` (supabase/functions/tests/_helpers.ts)
// só evita isso porque troca `Deno.serve` por um stub ANTES do import
// dinâmico — uma importação estática deste arquivo aqui não passa por esse
// stub. Mesma separação que o projeto já usa em `_shared/ai/pipeline.ts`
// (lógica) vs. `ai-respond/index.ts` (wrapper HTTP).

import { formatDaysLabel, MS_PER_DAY } from "../_shared/hitl/format.ts";

export const OVERDUE_CRITICAL_DAYS = 7;
export const OVERDUE_HIGH_DAYS = 2;

export type OverduePriority = "critical" | "high" | "medium";

// Union literal completo da constraint real (migration Fase 3):
// `check (category in ('follow_up','deadline','opportunity','risk','routine'))`.
// NÃO reexportar o `DecisionCategory` do arquivo irmão
// (hitl-stagnant-deal-analyzer/logic.ts): aquele tipo só cobre
// 'opportunity' | 'risk' (as 2 categorias que ESSE analisador usa), e não
// inclui 'deadline' — o valor que ESTE analisador sempre usa
// (buildOverdueDecisionInsert abaixo). Importar o tipo do irmão quebraria a
// checagem de tipo aqui.
export type DecisionCategory = "follow_up" | "deadline" | "opportunity" | "risk" | "routine";

export interface OverdueActivity {
  id: string;
  tenant_id: string;
  title: string;
  due_at: string;
  deal_id: string | null;
  contact_id: string | null;
}

export interface HitlDecisionInsert {
  tenant_id: string;
  type: string;
  category: DecisionCategory;
  priority: OverduePriority;
  title: string;
  description: string;
  activity_id: string;
  deal_id: string | null;
  contact_id: string | null;
  suggested_action: { action: string };
  auto_generated: boolean;
}

/**
 * Dias (fracionários) de atraso — positivo por definição para qualquer linha
 * que já passou pelo filtro `due_at < now()` da query.
 */
export function daysOverdue(dueAt: string, now: Date): number {
  return (now.getTime() - new Date(dueAt).getTime()) / MS_PER_DAY;
}

/**
 * >7 dias de atraso = critical; >2 dias = high; caso contrário = medium.
 * Limites exclusivos (">"): exatamente 7 dias ainda é `high`, exatamente 2
 * dias ainda é `medium`.
 */
export function calculateOverduePriority(dueAt: string, now: Date): OverduePriority {
  const days = daysOverdue(dueAt, now);
  if (days > OVERDUE_CRITICAL_DAYS) return "critical";
  if (days > OVERDUE_HIGH_DAYS) return "high";
  return "medium";
}

/** Monta o payload de INSERT em hitl_decisions para uma atividade vencida. */
export function buildOverdueDecisionInsert(
  activity: OverdueActivity,
  now: Date,
): HitlDecisionInsert {
  const priority = calculateOverduePriority(activity.due_at, now);
  const daysLabel = formatDaysLabel(Math.floor(daysOverdue(activity.due_at, now)));

  return {
    tenant_id: activity.tenant_id,
    type: "overdue_activity",
    category: "deadline",
    priority,
    title: `Atividade atrasada: "${activity.title}"`,
    description:
      `Vencida há ${daysLabel} (venceu em ${activity.due_at}). Reagende ou marque como concluída.`,
    activity_id: activity.id,
    deal_id: activity.deal_id,
    contact_id: activity.contact_id,
    suggested_action: { action: "reschedule_or_complete" },
    auto_generated: true,
  };
}
