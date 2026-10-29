/**
 * Deal briefing determinístico — resumo rápido pré-ligação sem chamada de
 * LLM (ver PRD Fase 1, riscos/armadilhas item 8: NUNCA virar gaveta para IA
 * "provisória" aqui, isso é Fase 5). Função pura sobre dados já carregados
 * (deal, activities, deal_followups).
 */

const MS_PER_DAY = 1000 * 60 * 60 * 24;

export interface DealBriefingActivity {
  completedAt: string | Date | null;
}

export type DealFollowupStatus = "pending" | "completed" | "cancelled";

export interface DealBriefingFollowup {
  scheduledAt: string | Date;
  status: DealFollowupStatus;
}

export interface DealBriefingInput {
  createdAt: string | Date;
  stageEnteredAt: string | Date;
  activities: readonly DealBriefingActivity[];
  followups: readonly DealBriefingFollowup[];
}

export interface DealBriefing {
  /** Dias desde a criação do deal. */
  idadeDias: number;
  /** Dias desde a última mudança de estágio. */
  diasNoEstagioAtual: number;
  /** Data da interação concluída mais recente (activities.completed_at), ou null se nenhuma atividade foi concluída ainda. */
  ultimaInteracao: Date | null;
  /** Data do próximo follow-up pendente (menor scheduled_at com status='pending'), ou null se não há follow-up agendado. */
  proximoFollowup: Date | null;
}

function daysSince(date: string | Date, now: Date): number {
  const diffMs = now.getTime() - new Date(date).getTime();
  return Math.max(0, Math.floor(diffMs / MS_PER_DAY));
}

export function buildDealBriefing(input: DealBriefingInput, now: Date = new Date()): DealBriefing {
  const idadeDias = daysSince(input.createdAt, now);
  const diasNoEstagioAtual = daysSince(input.stageEnteredAt, now);

  // Última interação = a mais recente entre as atividades já concluídas
  // (completed_at). Atividades pendentes/futuras ainda não aconteceram,
  // então não contam como interação.
  const completedDates = input.activities
    .filter((a) => a.completedAt != null)
    .map((a) => new Date(a.completedAt as string | Date));
  const ultimaInteracao =
    completedDates.length > 0
      ? completedDates.reduce((latest, d) => (d > latest ? d : latest))
      : null;

  // Próximo follow-up = o pendente com scheduled_at mais próximo. Um
  // follow-up pendente já vencido continua sendo o "próximo" até ser
  // concluído ou cancelado.
  const pendingDates = input.followups
    .filter((f) => f.status === "pending")
    .map((f) => new Date(f.scheduledAt));
  const proximoFollowup =
    pendingDates.length > 0
      ? pendingDates.reduce((earliest, d) => (d < earliest ? d : earliest))
      : null;

  return { idadeDias, diasNoEstagioAtual, ultimaInteracao, proximoFollowup };
}
