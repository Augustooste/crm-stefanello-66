/**
 * Orçamento único do turno de IA.
 *
 * O pior caso aceita áudio de entrada, faz duas chamadas sequenciais ao
 * gateway, sintetiza a resposta e envia a mídia. O lock precisa cobrir esse
 * caminho inteiro; os callers precisam sobreviver ao lock mais a limpeza.
 */
export const AI_STT_TOTAL_BUDGET_MS = 30_000;
export const AI_GATEWAY_TIMEOUT_MS = 25_000;
export const AI_TTS_TOTAL_BUDGET_MS = 15_000;
export const AI_MEDIA_SEND_TIMEOUT_MS = 15_000;

export const AI_RESPONSE_LOCK_TTL_MS = 130_000;
export const AI_RESPONSE_CALLER_TIMEOUT_MS = 145_000;
export const SUPABASE_EDGE_REQUEST_IDLE_TIMEOUT_MS = 150_000;

/** Reserva para fechar o claim, persistir o resultado e liberar o lock. */
export const AI_RESPONSE_CLEANUP_BUDGET_MS = 5_000;
/** Meta faz upload + envio da mídia: até duas chamadas sequenciais de 15 s. */
export const AI_SEND_OPERATION_BUDGET_MS = AI_MEDIA_SEND_TIMEOUT_MS * 2;
/** Meta também resolve o media_id antes do download + STT. */
export const AI_TRANSCRIPTION_OPERATION_BUDGET_MS = AI_STT_TOTAL_BUDGET_MS + 10_000;

export interface AiResponseBudget {
  deadlineAt: number;
  now: () => number;
}

export function createAiResponseBudget(now: () => number = Date.now): AiResponseBudget {
  return {
    deadlineAt: now() + AI_RESPONSE_CALLER_TIMEOUT_MS - AI_RESPONSE_CLEANUP_BUDGET_MS,
    now,
  };
}

export class AiResponseDeadlineError extends Error {
  constructor() {
    super("Tempo disponível para a resposta da IA esgotado.");
    this.name = "AiResponseDeadlineError";
  }
}

export function requireAiResponseTime(budget: AiResponseBudget | undefined, costMs: number): void {
  if (budget && budget.now() + costMs > budget.deadlineAt) {
    throw new AiResponseDeadlineError();
  }
}

export function limitAiResponseWait(
  requestedMs: number,
  budget: AiResponseBudget | undefined,
  reservedMs: number,
): number {
  if (!budget) return requestedMs;
  return Math.min(requestedMs, Math.max(0, budget.deadlineAt - budget.now() - reservedMs));
}
