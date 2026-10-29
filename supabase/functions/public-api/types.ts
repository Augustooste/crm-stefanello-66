// Contratos mínimos do acesso a dados. O cliente real do Supabase entra por cast
// em index.ts; os testes injetam um banco em memória com a mesma forma.
export type Row = Record<string, unknown>;

export interface DbResult {
  data: unknown;
  error: { message: string; code?: string } | null;
}

export interface QueryBuilder extends PromiseLike<DbResult> {
  select(columns?: string): QueryBuilder;
  insert(values: Row): QueryBuilder;
  eq(column: string, value: unknown): QueryBuilder;
  gt(column: string, value: unknown): QueryBuilder;
  is(column: string, value: null): QueryBuilder;
  order(column: string, options?: { ascending: boolean }): QueryBuilder;
  limit(count: number): QueryBuilder;
  maybeSingle(): PromiseLike<DbResult>;
  single(): PromiseLike<DbResult>;
}

export interface DbClient {
  from(table: string): QueryBuilder;
  rpc(fn: string, args: Row): PromiseLike<DbResult>;
}

export interface ApiContext {
  tenantId: string;
  keyId: string;
  scopes: string[];
}

export interface ApiDeps {
  db: DbClient;
  log: (event: Record<string, string | number>) => void;
  newRequestId: () => string;
}

export interface RouteInput {
  req: Request;
  ctx: ApiContext;
  deps: ApiDeps;
  requestId: string;
  params: Record<string, string>;
  url: URL;
}

export type RouteHandler = (input: RouteInput) => Promise<Response>;
