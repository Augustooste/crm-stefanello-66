// rate-limiter.ts — token-bucket simples (60 req/min default) para a API
// Feegow (Fase 6, Sub-feature 2). Porta o comportamento de
// medflow-v0 lib/feegow/rate-limiter.ts (fonte de verdade, somente
// leitura), mas em estilo funcional/closure -- não classe -- para casar com
// a convenção real deste diretório (ver _shared/messaging/evolution-client.ts
// e provider-send.ts: nenhum outro módulo de _shared usa `class`).

export interface RateLimiterConfig {
  maxRequests: number;
  windowMs: number;
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimiterConfig = {
  maxRequests: 60,
  windowMs: 60_000,
};

export interface RateLimiter {
  /** Resolve quando 1 token estiver disponível (espera com backoff passivo se preciso). */
  acquire(): Promise<void>;
}

/** Cria um rate limiter independente -- 1 por client (1 por tenant/credencial), nunca global entre tenants (cada clínica tem sua própria conta/limite na Feegow). */
export function createRateLimiter(config: Partial<RateLimiterConfig> = {}): RateLimiter {
  const cfg: RateLimiterConfig = { ...DEFAULT_RATE_LIMIT_CONFIG, ...config };
  const refillRate = cfg.maxRequests / cfg.windowMs; // tokens por ms
  let tokens = cfg.maxRequests;
  let lastRefill = Date.now();

  function refill(): void {
    const now = Date.now();
    const elapsed = now - lastRefill;
    if (elapsed > 0) {
      tokens = Math.min(cfg.maxRequests, tokens + elapsed * refillRate);
      lastRefill = now;
    }
  }

  return {
    async acquire(): Promise<void> {
      while (true) {
        refill();
        if (tokens >= 1) {
          tokens -= 1;
          return;
        }
        const waitMs = (1 - tokens) / refillRate;
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    },
  };
}
