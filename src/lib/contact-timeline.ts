/**
 * Merge client-side de eventos de fontes heterogêneas (notas, atividades,
 * follow-ups, mudanças de estágio de deal e mensagens) em uma única timeline
 * cronológica para o contact cockpit.
 *
 * PRD: docs/PRD-CRM-IA-MULTINICHO.md, seção "Fase 1", "Contact cockpit".
 * Função pura: recebe dados já buscados (e já resolvidos -- nomes de estágio,
 * tipo de canal etc.) e apenas mescla + ordena + pagina. Nenhuma chamada de
 * rede aqui, propositalmente, para manter 100% testável sem mocks.
 */

export type TimelineEventKind =
  "note" | "activity" | "followup" | "stage_change" | "message" | "call";

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  /** ISO 8601 -- momento em que o evento efetivamente aconteceu. */
  timestamp: string;
  title: string;
  description: string | null;
  /** Id da linha de origem quando a UI precisa abrir detalhes (hoje: ligação IA). */
  refId?: string;
}

export interface ContactNoteSource {
  id: string;
  content: string;
  created_at: string;
}

export interface ActivityTimelineSource {
  id: string;
  title: string;
  type: string;
  due_at: string | null;
  completed_at: string | null;
  created_at: string;
}

export interface FollowupTimelineSource {
  id: string;
  description: string | null;
  scheduled_at: string;
  completed_at: string | null;
  status: string;
}

export interface StageChangeTimelineSource {
  id: string;
  deal_title: string | null;
  from_stage_name: string | null;
  to_stage_name: string | null;
  created_at: string;
}

export interface MessageTimelineSource {
  id: string;
  content: string | null;
  created_at: string;
  channel_type: string | null;
}

export interface CallTimelineSource {
  id: string;
  status: string;
  created_at: string;
  ended_at: string | null;
  duration_seconds: number | null;
  outcome: string | null;
  is_simulation: boolean;
}

export interface ContactTimelineSources {
  notes?: ContactNoteSource[];
  activities?: ActivityTimelineSource[];
  followups?: FollowupTimelineSource[];
  stageChanges?: StageChangeTimelineSource[];
  messages?: MessageTimelineSource[];
  calls?: CallTimelineSource[];
}

function noteEvents(notes: ContactNoteSource[]): TimelineEvent[] {
  return notes.map((n) => ({
    id: `note-${n.id}`,
    kind: "note",
    timestamp: n.created_at,
    title: "Nota adicionada",
    description: n.content,
  }));
}

function activityEvents(activities: ActivityTimelineSource[]): TimelineEvent[] {
  return activities.map((a) => {
    const timestamp = a.completed_at ?? a.due_at ?? a.created_at;
    const title = a.completed_at ? `Atividade concluída: ${a.title}` : `Atividade: ${a.title}`;
    return { id: `activity-${a.id}`, kind: "activity", timestamp, title, description: a.type };
  });
}

function followupEvents(followups: FollowupTimelineSource[]): TimelineEvent[] {
  return followups.map((f) => {
    const timestamp = f.completed_at ?? f.scheduled_at;
    const title =
      f.status === "completed"
        ? "Retorno concluído"
        : f.status === "cancelled"
          ? "Retorno cancelado"
          : "Retorno agendado";
    return {
      id: `followup-${f.id}`,
      kind: "followup",
      timestamp,
      title,
      description: f.description,
    };
  });
}

function stageChangeEvents(stageChanges: StageChangeTimelineSource[]): TimelineEvent[] {
  return stageChanges.map((s) => {
    const title = s.deal_title
      ? `Negócio "${s.deal_title}" mudou de estágio`
      : "Negócio mudou de estágio";
    const description =
      s.from_stage_name && s.to_stage_name
        ? `${s.from_stage_name} → ${s.to_stage_name}`
        : (s.to_stage_name ?? null);
    return {
      id: `stage-${s.id}`,
      kind: "stage_change",
      timestamp: s.created_at,
      title,
      description,
    };
  });
}

function messageEvents(messages: MessageTimelineSource[]): TimelineEvent[] {
  return messages.map((m) => ({
    id: `message-${m.id}`,
    kind: "message",
    timestamp: m.created_at,
    title: m.channel_type ? `Mensagem (${m.channel_type})` : "Mensagem",
    description: m.content,
  }));
}

export const CALL_STATUS_LABEL: Record<string, string> = {
  queued: "Na fila",
  initiating: "Iniciando",
  ringing: "Chamando",
  answered: "Em andamento",
  completed: "Concluída",
  failed: "Falhou",
  busy: "Ocupado",
  no_answer: "Não atendeu",
  cancelled: "Cancelada",
};

export const CALL_OUTCOME_LABEL: Record<string, string> = {
  interested: "interessado",
  not_interested: "sem interesse",
  callback_requested: "pediu retorno",
  voicemail: "caixa postal",
  wrong_number: "número errado",
  no_decision: "sem decisão",
};

export function formatCallDuration(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}

function callEvents(calls: CallTimelineSource[]): TimelineEvent[] {
  return calls.map((c) => {
    const parts: string[] = [];
    if (c.status === "completed") {
      if (c.duration_seconds !== null)
        parts.push(`Duração: ${formatCallDuration(c.duration_seconds)}`);
      if (c.outcome) parts.push(`Resultado: ${CALL_OUTCOME_LABEL[c.outcome] ?? c.outcome}`);
    } else {
      parts.push(CALL_STATUS_LABEL[c.status] ?? c.status);
    }
    return {
      id: `call-${c.id}`,
      kind: "call",
      timestamp: c.ended_at ?? c.created_at,
      title: c.is_simulation ? "Ligação IA (simulação)" : "Ligação IA",
      description: parts.join(" · "),
      refId: c.id,
    };
  });
}

/**
 * Mescla todas as fontes e ordena por timestamp decrescente (mais recente
 * primeiro -- mesma convenção já usada nas abas de conversas/atividades desta
 * página). Empates de timestamp mantêm a ordem de inserção (Array.sort é
 * estável), o que dá um resultado determinístico e testável.
 */
function hasValidTimestamp(event: TimelineEvent): boolean {
  return !Number.isNaN(new Date(event.timestamp).getTime());
}

export function buildContactTimeline(sources: ContactTimelineSources): TimelineEvent[] {
  const events: TimelineEvent[] = [
    ...noteEvents(sources.notes ?? []),
    ...activityEvents(sources.activities ?? []),
    ...followupEvents(sources.followups ?? []),
    ...stageChangeEvents(sources.stageChanges ?? []),
    ...messageEvents(sources.messages ?? []),
    ...callEvents(sources.calls ?? []),
  ];

  // Defensivo: um registro com data ausente/corrompida (não deveria acontecer
  // -- as colunas de origem são not-null no schema -- mas dados legados/teste
  // podem violar isso) é descartado em vez de quebrar a ordenação/render com
  // um "Invalid time value".
  return events
    .filter(hasValidTimestamp)
    .sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());
}

export interface PaginatedTimeline {
  items: TimelineEvent[];
  hasMore: boolean;
}

/** Corta a timeline já ordenada nos primeiros `limit` itens ("carregar mais" incrementa `limit`). */
export function paginateTimeline(events: TimelineEvent[], limit: number): PaginatedTimeline {
  const safeLimit = Math.max(0, limit);
  return { items: events.slice(0, safeLimit), hasMore: events.length > safeLimit };
}
