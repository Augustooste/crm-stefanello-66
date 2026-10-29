/**
 * Lista estática das Edge Functions verificadas pelo healthcheck público
 * (/api/public/edge-health). Mantida à parte da rota para poder ser testada e
 * revisada sem tocar no handler. Nenhum segredo aqui — só nomes públicos.
 */
export const EDGE_FUNCTIONS: readonly string[] = [
  "ai-deal-chat",
  "ai-insights",
  "ai-memory-consolidate",
  "ai-playground",
  "ai-qualification",
  "ai-respond",
  "brand-extract",
  "domain-event-dispatcher",
  "evolution-watchdog",
  "feegow-sync",
  "hitl-overdue-activity-analyzer",
  "hitl-sla-monitor",
  "hitl-stagnant-deal-analyzer",
  "integration-connect",
  "lead-form-submit",
  "messaging-channels-reconcile",
  "messaging-send",
  "messaging-webhook",
  "meta-ads-leadgen",
  "nurture-auto-enroll-scanner",
  "nurture-runner",
  "prepare-meeting",
  "template-schedule-runner",
  "weekly-digest-generator",
];

export type EdgeFunctionStatus = "ok" | "degraded" | "down";

export type EdgeFunctionHealth = {
  name: string;
  status: EdgeFunctionStatus;
  http_status: number | null;
  latency_ms: number;
};

export type EdgeHealthReport = {
  checked_at: string;
  overall: EdgeFunctionStatus;
  functions: EdgeFunctionHealth[];
};

/** Timeout curto: o healthcheck não deve segurar a requisição do chamador. */
export const EDGE_HEALTH_TIMEOUT_MS = 3000;
const CONCURRENCY = 6;

function classify(httpStatus: number): EdgeFunctionStatus {
  // OPTIONS (preflight CORS) não executa o job. 2xx/4xx significam "a function
  // está no ar e respondeu"; só 5xx e falha de rede indicam indisponibilidade.
  if (httpStatus >= 500) return "down";
  if (httpStatus >= 400) return "degraded";
  return "ok";
}

async function checkOne(baseUrl: string, name: string): Promise<EdgeFunctionHealth> {
  const started = Date.now();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EDGE_HEALTH_TIMEOUT_MS);
  try {
    const res = await fetch(`${baseUrl}/functions/v1/${name}`, {
      method: "OPTIONS",
      signal: controller.signal,
    });
    return {
      name,
      status: classify(res.status),
      http_status: res.status,
      latency_ms: Date.now() - started,
    };
  } catch {
    // Nunca propagamos o erro cru: poderia carregar URL/credencial no texto.
    return { name, status: "down", http_status: null, latency_ms: Date.now() - started };
  } finally {
    clearTimeout(timer);
  }
}

/** Executa os checks com concorrência limitada e monta o relatório. */
export async function runEdgeHealthCheck(
  baseUrl: string,
  names: readonly string[] = EDGE_FUNCTIONS,
): Promise<EdgeHealthReport> {
  const results: EdgeFunctionHealth[] = [];
  const queue = [...names];

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      for (;;) {
        const next = queue.shift();
        if (!next) return;
        results.push(await checkOne(baseUrl, next));
      }
    }),
  );

  results.sort((a, b) => a.name.localeCompare(b.name));

  const overall: EdgeFunctionStatus = results.some((r) => r.status === "down")
    ? "down"
    : results.some((r) => r.status === "degraded")
      ? "degraded"
      : "ok";

  return { checked_at: new Date().toISOString(), overall, functions: results };
}
