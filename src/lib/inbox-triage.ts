/**
 * Indicadores de triagem da inbox — funções puras sobre dados já carregados
 * (conversations), sem chamada de rede. Espelha o padrão de `deal-health.ts`
 * (portado de clientes/pedro/medflow-v0/features/inbox), adaptado ao modelo
 * de dados do aceleraflow: `conversations.awaiting_human` (handoff IA→humano)
 * e `conversations.last_message.sender` (`"contact" | "agent" | "ai"`) em vez
 * do `Activity`/`AISuggestion` do medflow.
 */
import { isSameDay } from "date-fns";

const MS_PER_HOUR = 1000 * 60 * 60;
const MS_PER_DAY = MS_PER_HOUR * 24;

export const OVERDUE_THRESHOLD_HOURS = 24;
export const COLD_THRESHOLD_DAYS = 7;

/**
 * Shape mínimo aceito pelas funções abaixo — não acopla ao `ConversationRow`
 * privado de `src/routes/_app.inbox.tsx` (props estruturais, não nominais).
 */
export interface ConversationForTriage {
  status: string;
  awaiting_human: boolean;
  awaiting_human_since: string | Date | null;
  last_message_at: string | Date | null;
  last_message: { sender: string } | null;
}

/**
 * Conversa "atrasada": a última mensagem foi do cliente
 * (`last_message.sender === "contact"`), a conversa segue aberta
 * (`status !== "closed"`) e já se passaram mais de `thresholdHours` desde
 * `last_message_at`. Sem `last_message_at`/`last_message` (conversa sem
 * mensagens ainda) não é atrasada — não há o que responder.
 */
export function isConversationOverdue(
  conv: ConversationForTriage,
  nowMs: number,
  thresholdHours: number = OVERDUE_THRESHOLD_HOURS,
): boolean {
  if (conv.status === "closed") return false;
  if (conv.last_message?.sender !== "contact") return false;
  if (!conv.last_message_at) return false;
  const diffMs = nowMs - new Date(conv.last_message_at).getTime();
  return diffMs / MS_PER_HOUR > thresholdHours;
}

/**
 * Conversa com atividade "hoje": houve mensagem (qualquer direção) no mesmo
 * dia-calendário de `now`. Usado pelo card "Hoje" — recorte sobre a MESMA
 * lista de conversas da Lista (não sobre `activities.due_at`), pra que o
 * clique no card leve a um filtro coerente com o que a Lista já mostra.
 */
export function isConversationToday(conv: ConversationForTriage, now: Date): boolean {
  if (!conv.last_message_at) return false;
  return isSameDay(new Date(conv.last_message_at), now);
}

/**
 * Conversa "fria": nenhuma mensagem (de qualquer direção) há mais de
 * `thresholdDays`, e a conversa segue aberta. Independe de direção — pode se
 * sobrepor a "atrasada" (eixos diferentes: urgência de resposta vs. saúde do
 * relacionamento), igual medflow permite overdueActivities e STALLED-deal
 * referenciarem o mesmo deal.
 */
export function isConversationCold(
  conv: ConversationForTriage,
  nowMs: number,
  thresholdDays: number = COLD_THRESHOLD_DAYS,
): boolean {
  if (conv.status === "closed") return false;
  if (!conv.last_message_at) return false;
  const diffMs = nowMs - new Date(conv.last_message_at).getTime();
  return diffMs / MS_PER_DAY > thresholdDays;
}

/**
 * Fila de foco: banda 1 = aguardando humano (awaiting_human=true), ordenada
 * pela mais antiga espera primeiro (awaiting_human_since asc); banda 2 =
 * atrasadas (>24h sem resposta) que NÃO estão na banda 1, ordenadas pela
 * mensagem mais antiga primeiro (last_message_at asc). Nunca duplica: uma
 * conversa aparece em, no máximo, uma banda.
 */
export function buildFocusQueue<T extends ConversationForTriage & { id: string }>(
  awaitingHumanConvs: readonly T[],
  overdueConvs: readonly T[],
): T[] {
  const band1Ids = new Set(awaitingHumanConvs.map((c) => c.id));
  const band1 = [...awaitingHumanConvs].sort((a, b) => {
    const at = a.awaiting_human_since ? new Date(a.awaiting_human_since).getTime() : 0;
    const bt = b.awaiting_human_since ? new Date(b.awaiting_human_since).getTime() : 0;
    return at - bt;
  });
  const band2 = overdueConvs
    .filter((c) => !band1Ids.has(c.id))
    .sort((a, b) => {
      const at = a.last_message_at ? new Date(a.last_message_at).getTime() : 0;
      const bt = b.last_message_at ? new Date(b.last_message_at).getTime() : 0;
      return at - bt;
    });
  return [...band1, ...band2];
}
