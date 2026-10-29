import { createFileRoute } from "@tanstack/react-router";

import { runEdgeHealthCheck } from "@/lib/monitoring/edge-health-check";

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
} as const;

const JSON_HEADERS = {
  "Content-Type": "application/json",
  // Cache curto: evita que o endpoint público vire amplificador de tráfego
  // contra as Edge Functions.
  "Cache-Control": "public, max-age=30",
  ...CORS_HEADERS,
};

/**
 * Healthcheck público das Edge Functions. Sem autenticação (por pedido) e sem
 * dado sensível: só nome da function, status, código HTTP e latência. Usa
 * OPTIONS (preflight CORS) para não executar nenhum job de verdade.
 */
export const Route = createFileRoute("/api/public/edge-health")({
  server: {
    handlers: {
      OPTIONS: async () => new Response(null, { status: 204, headers: CORS_HEADERS }),
      GET: async () => {
        const baseUrl = process.env.SUPABASE_URL;
        if (!baseUrl) {
          return new Response(JSON.stringify({ error: "healthcheck indisponível" }), {
            status: 503,
            headers: JSON_HEADERS,
          });
        }
        try {
          const report = await runEdgeHealthCheck(baseUrl.replace(/\/+$/, ""));
          return new Response(JSON.stringify(report), {
            status: report.overall === "down" ? 503 : 200,
            headers: JSON_HEADERS,
          });
        } catch {
          return new Response(JSON.stringify({ error: "healthcheck indisponível" }), {
            status: 500,
            headers: JSON_HEADERS,
          });
        }
      },
    },
  },
});
