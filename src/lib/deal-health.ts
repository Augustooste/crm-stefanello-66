import { isBefore, isSameDay, startOfDay } from "date-fns";

/**
 * Indicadores de saúde do kanban — funções puras sobre dados já carregados
 * (deals + activities), sem chamada de rede. Adaptado 1:1 de
 * clientes/pedro/medflow-v0/features/boards/utils.ts, trocando
 * `deal.nextActivity` (pré-computado no medflow) por uma seleção própria
 * sobre a lista de activities do deal (ver `getNextActivityDueAt`).
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export type ActivityStatus = "yellow" | "red" | "green" | "gray";

export interface ActivityForHealth {
  dueAt: string | Date | null;
  completedAt: string | Date | null;
}

/**
 * Deal "apodrecendo": sem mudança de estágio há mais de 10 dias.
 * `stageEnteredAt` vem de `deals.stage_entered_at`.
 */
export function isDealRotting(stageEnteredAt: string | Date, now: Date = new Date()): boolean {
  const diffMs = now.getTime() - new Date(stageEnteredAt).getTime();
  return diffMs / MS_PER_DAY > 10;
}

/**
 * Seleciona a atividade não concluída mais próxima (menor due_at) entre as
 * activities do deal. Não filtra por `due_at >= now()` — uma atividade
 * vencida (due_at no passado) precisa continuar aparecendo aqui para que
 * `getActivityStatus` consiga classificá-la como atrasada ("red").
 */
export function getNextActivityDueAt(activities: readonly ActivityForHealth[]): Date | null {
  const pendingDueDates = activities
    .filter((a) => a.dueAt != null && a.completedAt == null)
    .map((a) => new Date(a.dueAt as string | Date));
  if (pendingDueDates.length === 0) return null;
  return pendingDueDates.reduce((earliest, d) => (d < earliest ? d : earliest));
}

/**
 * Classifica o status de atividade do card:
 * - sem próxima atividade → yellow
 * - atividade com due_at em dia anterior a hoje → red (atrasada)
 * - atividade com due_at hoje → green
 * - atividade com due_at em dia futuro → gray
 */
export function getActivityStatus(
  nextActivityDueAt: string | Date | null,
  now: Date = new Date(),
): ActivityStatus {
  if (nextActivityDueAt == null) return "yellow";
  const due = new Date(nextActivityDueAt);
  if (isSameDay(due, now)) return "green";
  if (isBefore(startOfDay(due), startOfDay(now))) return "red";
  return "gray";
}

/**
 * Rótulo/variante PT-BR de `ActivityStatus` — compartilhado entre o card do
 * kanban (DraggableCard) e a linha da tabela (PipelineTable) em
 * src/routes/_app.pipeline.tsx, para não duplicar o mapeamento em cada
 * superfície que exibe o mesmo sinal de saúde.
 */
export const ACTIVITY_STATUS_LABEL: Record<ActivityStatus, string> = {
  yellow: "Sem atividade agendada",
  red: "Atividade atrasada",
  green: "Atividade hoje",
  gray: "Próxima atividade agendada",
};

export const ACTIVITY_STATUS_VARIANT: Record<
  ActivityStatus,
  "warning" | "destructive" | "success" | "neutral"
> = {
  yellow: "warning",
  red: "destructive",
  green: "success",
  gray: "neutral",
};
