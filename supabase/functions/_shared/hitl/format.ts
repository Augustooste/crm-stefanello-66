// Utilitário puro compartilhado entre os analisadores HITL (Fase 3 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md). Extraído de
// hitl-stagnant-deal-analyzer/logic.ts e hitl-overdue-activity-analyzer/logic.ts
// (corpo idêntico byte-a-byte nos dois) — SEM I/O, seguro para import estático
// em teste (mesmo raciocínio de "por que separado de index.ts" documentado
// nos logic.ts irmãos).
//
// Deliberadamente NÃO inclui daysStagnant/daysOverdue: são funções de 1 linha
// já importadas pelos testes existentes com esses nomes específicos — extrair
// e reexportar como alias só trocaria uma duplicação pequena por uma indireção
// sem ganho real.

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** Rótulo humano de dias (PT-BR): "menos de 1 dia", "1 dia", "N dias". */
export function formatDaysLabel(wholeDays: number): string {
  if (wholeDays <= 0) return "menos de 1 dia";
  return `${wholeDays} dia${wholeDays === 1 ? "" : "s"}`;
}
