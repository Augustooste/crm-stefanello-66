// Helpers compartilhados pelos testes dos 3 analisadores HITL da Fase 3
// (hitl-stagnant-deal-analyzer, hitl-overdue-activity-analyzer,
// hitl-sla-monitor) — extraídos por eram corpo idêntico duplicado nos 3
// arquivos de teste. Deliberadamente um arquivo NOVO, não uma edição de
// ./_helpers.ts: aquele arquivo está congelado ("NÃO editar a partir de
// subagentes") após validar o comportamento real do supabase-js no piloto
// (ai-insights) — mexer nele reabriria essa validação. Este arquivo só
// importa de lá (BASE_ENV), nunca edita.
import { BASE_ENV } from "./_helpers.ts";

export const DAY_MS = 24 * 60 * 60 * 1000;

export function daysAgoIso(days: number): string {
  return new Date(Date.now() - days * DAY_MS).toISOString();
}

/**
 * Mesma assinatura usada nos 3 arquivos de teste: `body` é opcional (a
 * variante do hitl-sla-monitor.test.ts nunca manda corpo), `opts.auth = null`
 * omite o header Authorization por completo (caso "sem Authorization retorna
 * 401"), e por padrão preenche o bearer do service role
 * (BASE_ENV.SUPABASE_SERVICE_ROLE_KEY).
 */
export function req(body?: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  }
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
