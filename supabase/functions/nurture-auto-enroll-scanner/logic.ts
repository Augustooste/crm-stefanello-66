// Lógica pura do nurture-auto-enroll-scanner (Fase 4 do PRD —
// docs/PRD-CRM-IA-MULTINICHO.md, user story D — auto-enrollment). SEM I/O
// (nem `Deno.env.get`), mesmo motivo documentado nos `logic.ts` irmãos dos
// analisadores HITL da Fase 3: `deno test` roda sem `--allow-net`, e este
// módulo precisa ser importável estaticamente pelos testes sem disparar
// `Deno.serve`.
//
// A lógica de enrollment em si (idempotência via índice único parcial,
// guardrails de `stagnant_days`/`periodic_days`, DISTINCT ON pra não
// duplicar candidatos dentro do mesmo INSERT) já está inteira em SQL, na RPC
// `enroll_stagnant_and_periodic_nurture()`
// (supabase/migrations/20260710140000_fase4_nurture_schema.sql). Este
// arquivo NÃO reimplementa nada disso — só formata o jsonb que a RPC
// devolve (`{ stagnant: number, periodic: number }`) num resumo de log
// legível para o index.ts.

export interface NurtureEnrollCounts {
  stagnant: number;
  periodic: number;
}

/**
 * Normaliza o retorno bruto da RPC (jsonb -> `unknown` no client) para o
 * shape esperado. Nunca lança: campo ausente ou não-numérico vira 0, para
 * `formatEnrollSummary` sempre poder rodar mesmo se o shape da RPC mudar sem
 * aviso — este é um fail-safe de log, não de negócio (a regra de negócio já
 * rodou dentro da própria RPC antes deste código ver o resultado).
 */
export function parseEnrollCounts(raw: unknown): NurtureEnrollCounts {
  const obj = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  const stagnant = typeof obj.stagnant === "number" && Number.isFinite(obj.stagnant) ? obj.stagnant : 0;
  const periodic = typeof obj.periodic === "number" && Number.isFinite(obj.periodic) ? obj.periodic : 0;
  return { stagnant, periodic };
}

/** Resumo legível para log: "stagnant: 3, periodic: 1 (total: 4)". */
export function formatEnrollSummary(counts: NurtureEnrollCounts): string {
  const total = counts.stagnant + counts.periodic;
  return `stagnant: ${counts.stagnant}, periodic: ${counts.periodic} (total: ${total})`;
}
