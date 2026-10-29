import type { SupabaseClient } from "@supabase/supabase-js";
import { vi, type Mock } from "vitest";
import type { Database } from "@/integrations/supabase/types";

export interface QueryResult<T = unknown> {
  data: T | null;
  error: { message: string } | null;
  count?: number;
}

const CHAIN_METHODS = [
  "select",
  "insert",
  "update",
  "upsert",
  "delete",
  "eq",
  "neq",
  "gt",
  "gte",
  "lt",
  "lte",
  "like",
  "ilike",
  "is",
  "in",
  "contains",
  "containedBy",
  "order",
  "limit",
  "range",
  "filter",
  "match",
  "or",
  "not",
] as const;

export type QueryBuilderMock<T = unknown> = Record<(typeof CHAIN_METHODS)[number], Mock> & {
  single: Mock;
  maybeSingle: Mock;
  then: <TResult1 = QueryResult<T>, TResult2 = never>(
    onfulfilled?: ((value: QueryResult<T>) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) => Promise<TResult1 | TResult2>;
  catch: <TResult = never>(
    onrejected?: ((reason: unknown) => TResult | PromiseLike<TResult>) | null,
  ) => Promise<QueryResult<T> | TResult>;
};

/**
 * Tipo real de `supabase.from` (via SupabaseClient<Database> -- sem importar
 * o client de verdade, que lança se faltar env var). Desde que o schema
 * ganhou a primeira View (deal_owner_leaderboard, Fase 4 PR-B), o overload de
 * View resolvido por `Parameters`/`ReturnType` de `.from` passa a exigir o
 * retorno como `PostgrestQueryBuilder` real -- uma classe com membro PRIVADO
 * (`cloneRequestState`), que nenhum objeto plano consegue satisfazer
 * estruturalmente (regra de nominal typing do TS p/ membros private). Não dá
 * pra "consertar o shape" do mock -- é preciso o escape hatch abaixo.
 */
type SupabaseFrom = SupabaseClient<Database>["from"];

/**
 * Cast de teste para `vi.mocked(supabase.from).mockImplementation(fn)`: os
 * mocks deste arquivo (QueryBuilderMock) nunca implementam de fato
 * PostgrestQueryBuilder -- e não tem como, ver comentário de SupabaseFrom
 * acima. Runtime não muda em nada (mock nunca faz request real); é só o tipo
 * que precisa do `as unknown as` (mesmo padrão já usado em auth.test.tsx/
 * _app.assistente.test.tsx para outros mocks de supabase/react-query).
 */
export function asFromMock(fn: (table: string, ...rest: never[]) => unknown): SupabaseFrom {
  return fn as unknown as SupabaseFrom;
}

/**
 * Query builder encadeável do Supabase (from().select().eq()...). Cada método
 * de filtro retorna o próprio builder; é "then-able" para suportar `await`
 * direto sem chamar `.single()`, como o código real faz.
 */
export function createQueryBuilder<T = unknown>(result: QueryResult<T>): QueryBuilderMock<T> {
  const builder = {} as QueryBuilderMock<T>;
  for (const method of CHAIN_METHODS) {
    builder[method] = vi.fn(() => builder);
  }
  builder.single = vi.fn(() => Promise.resolve(result));
  builder.maybeSingle = vi.fn(() => Promise.resolve(result));
  builder.then = ((onfulfilled, onrejected) =>
    Promise.resolve(result).then(onfulfilled, onrejected)) as QueryBuilderMock<T>["then"];
  builder.catch = ((onrejected) =>
    Promise.resolve(result).catch(onrejected)) as QueryBuilderMock<T>["catch"];
  return builder;
}

/**
 * Mock de `supabase.from` que devolve um resultado por chamada, na ordem em
 * que `.from(...)` é invocado — útil quando o componente dispara várias
 * queries em paralelo (Promise.all) e cada uma precisa de um valor distinto.
 */
export function createFromQueue(results: QueryResult[]): Mock {
  let index = 0;
  return vi.fn(() => {
    const result = results[Math.min(index, results.length - 1)] ?? { data: null, error: null };
    index += 1;
    return createQueryBuilder(result);
  });
}

/** Mock de `supabase.from` que resolve pelo nome da tabela, ignorando a ordem das chamadas. */
export function createFromByTable(resultsByTable: Record<string, QueryResult>): Mock {
  return vi.fn((table: string) =>
    createQueryBuilder(resultsByTable[table] ?? { data: null, error: null }),
  );
}

/** Builder que nunca resolve — usado para exercitar estados de loading nos testes. */
export function createPendingQueryBuilder<T = unknown>(): QueryBuilderMock<T> {
  const builder = createQueryBuilder<T>({ data: null, error: null });
  builder.then = (() => new Promise(() => {})) as QueryBuilderMock<T>["then"];
  builder.single = vi.fn(() => new Promise(() => {}));
  builder.maybeSingle = vi.fn(() => new Promise(() => {}));
  return builder;
}

export function ok<T>(data: T, extra: Partial<QueryResult<T>> = {}): QueryResult<T> {
  return { data, error: null, ...extra };
}

export function fail(message: string): QueryResult<never> {
  return { data: null, error: { message } };
}
