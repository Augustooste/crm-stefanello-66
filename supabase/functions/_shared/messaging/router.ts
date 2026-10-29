export interface RouteCandidate {
  provider: string;
  destination: string;
  preference: number;
  estimatedCostMicros: number;
  engagementScore: number;
  available: boolean;
}

export interface RouteDecision {
  primary: RouteCandidate | null;
  fallbacks: RouteCandidate[];
}

export const DEFAULT_PROVIDER_COST_MICROS: Readonly<Record<string, number>> =
  Object.freeze({
    push: 0,
    discord: 0,
    telegram: 0,
    email: 1_000,
    resend: 1_000,
    sms: 50_000,
    "meta-cloud": 35_000,
    evolution: 5_000,
    zapi: 5_000,
    twilio: 50_000,
  });

export function estimateProviderCostMicros(
  provider: string,
  units = 1,
): number {
  return Math.max(0, DEFAULT_PROVIDER_COST_MICROS[provider] ?? 0) *
    Math.max(0, units);
}

/** Higher preference/engagement wins; cost is a bounded penalty. Stable provider tie-break makes retries deterministic. */
export function routeCommunication(
  candidates: readonly RouteCandidate[],
): RouteDecision {
  const ranked = candidates.filter((candidate) =>
    candidate.available && candidate.destination.trim()
  )
    .map((candidate) => ({
      candidate,
      score: candidate.preference * 1_000 + candidate.engagementScore * 100 -
        Math.min(candidate.estimatedCostMicros, 1_000_000) / 1_000,
    }))
    .sort((a, b) =>
      b.score - a.score ||
      a.candidate.provider.localeCompare(b.candidate.provider)
    )
    .map(({ candidate }) => candidate);
  return { primary: ranked[0] ?? null, fallbacks: ranked.slice(1) };
}

export async function sendWithFallback<T>(
  decision: RouteDecision,
  send: (candidate: RouteCandidate) => Promise<T & { ok: boolean }>,
): Promise<{ candidate: RouteCandidate; result: T & { ok: boolean } } | null> {
  for (
    const candidate of decision.primary
      ? [decision.primary, ...decision.fallbacks]
      : []
  ) {
    const result = await send(candidate);
    if (result.ok) return { candidate, result };
  }
  return null;
}
