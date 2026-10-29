// Atraso até a próxima tentativa de entrega (segundos): 1min, 5min, 30min, 2h, 6h, 24h (teto).
export const BACKOFF_STEPS_SECONDS = [60, 300, 1800, 7200, 21600, 86400] as const;
export const MAX_JITTER_RATIO = 0.1;

/** `attempt` = nº da tentativa que acabou de falhar (1-based). `jitter` em [-0.1, 0.1], injetável p/ teste. */
export function nextAttemptDelaySeconds(
  attempt: number,
  jitter: number = (Math.random() * 2 - 1) * MAX_JITTER_RATIO,
): number {
  const safe = Number.isInteger(attempt) && attempt >= 1 ? attempt : 1; // NaN/negativo/fracionário -> 1
  const idx = Math.min(safe, BACKOFF_STEPS_SECONDS.length) - 1;
  const clamped = Math.min(Math.max(jitter, -MAX_JITTER_RATIO), MAX_JITTER_RATIO);
  return Math.round(BACKOFF_STEPS_SECONDS[idx] * (1 + clamped));
}
