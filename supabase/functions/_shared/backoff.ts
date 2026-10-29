// Backoff exponencial com jitter para retry de envios (messaging-send).
//
// Puro: sem I/O e sem estado. Testado indiretamente pelos testes do
// messaging-send e diretamente em supabase/functions/tests/backoff_test.ts.
//
// Fórmula: base * 2^attempt, com jitter aleatório de +/- 25% e teto máximo.
// attempt é 0-indexado (0 = primeira retry, ou seja, após a 1ª falha).

export interface BackoffOptions {
  baseMs?: number;
  maxMs?: number;
  jitterPct?: number;
}

export function computeBackoffMs(attempt: number, opts: BackoffOptions = {}): number {
  const base = opts.baseMs ?? 500;
  const max = opts.maxMs ?? 5_000;
  const jitter = opts.jitterPct ?? 0.25;
  const raw = base * Math.pow(2, Math.max(0, attempt));
  const capped = Math.min(raw, max);
  const jitterDelta = capped * jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterDelta));
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
