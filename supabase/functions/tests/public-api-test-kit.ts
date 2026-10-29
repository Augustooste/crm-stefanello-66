// Banco em memória para a API pública: grava cada consulta (tabela, operação,
// filtros) para que os testes inspecionem o escopo de tenant.
import { sha256Hex } from "../public-api/auth.ts";
import type { ApiDeps, DbClient, DbResult, QueryBuilder, Row } from "../public-api/types.ts";

export interface QueryLog {
  table: string;
  op: "select" | "insert";
  columns?: string;
  filters: Array<{ column: string; op: "eq" | "gt" | "is"; value: unknown }>;
  inserted?: Row;
}

export interface RpcLog {
  fn: string;
  args: Row;
}

export const TENANT_A = "aaaaaaaa-0000-4000-8000-00000000000a";
export const TENANT_B = "bbbbbbbb-0000-4000-8000-00000000000b";
export const TOKEN_A = "acf_live_TOKEN_SECRETO_DO_TENANT_A_0123456789";
export const DEAL_A = "d0000000-0000-4000-8000-0000000000a1";
export const DEAL_B = "d0000000-0000-4000-8000-0000000000b1";
export const BOARD_A = "b0000000-0000-4000-8000-0000000000a1";
export const STAGE_OPEN_A = "50000000-0000-4000-8000-0000000000a1";
export const CONTACT_A = "c0000000-0000-4000-8000-0000000000a1";
export const CONTACT_DELETED_A = "c0000000-0000-4000-8000-0000000000a2";
export const CONTACT_MERGED_A = "c0000000-0000-4000-8000-0000000000a3";

// Colunas reais (src/integrations/supabase/types.ts e DDL): consulta a coluna
// inexistente devolve 42703, como o PostgREST.
const SCHEMA: Record<string, readonly string[]> = {
  tenants: ["id", "name", "created_at", "updated_at"],
  contacts: [
    "id", "tenant_id", "name", "email", "phone", "source", "tags", "notes", "status", "owner_id",
    "deleted_at", "merged_into_id", "created_at", "updated_at",
  ],
  deals: [
    "id", "tenant_id", "title", "value", "status", "contact_id", "board_id", "stage_id",
    "lost_reason", "owner_id", "closed_at", "created_at", "updated_at",
  ],
  boards: ["id", "tenant_id", "name", "position", "created_at", "updated_at"],
};

function unknownColumn(table: string, log: QueryLog): string | null {
  const known = SCHEMA[table];
  if (!known) return null;
  const selected = (log.columns ?? "").split(",").map((c) => c.trim()).filter((c) => c && c !== "*");
  const used = [...selected, ...log.filters.map((f) => f.column), ...Object.keys(log.inserted ?? {})];
  return used.find((c) => !known.includes(c)) ?? null;
}

export interface KitOptions {
  scopes?: string[];
  revoked?: boolean;
  tenantsPresent?: string[];
  rateLimit?: { allowed: boolean; retryAfterSeconds: number } | "error";
  /** Faz as consultas à tabela devolverem erro de banco com este SQLSTATE. */
  tableError?: { table: string; code?: string };
}

export async function makeKit(options: KitOptions = {}) {
  const keyHash = await sha256Hex(TOKEN_A);
  const queries: QueryLog[] = [];
  const rpcs: RpcLog[] = [];
  const logs: Array<Record<string, string | number>> = [];
  const tables = new Map<string, Row[]>();
  tables.set("tenants", (options.tenantsPresent ?? [TENANT_A, TENANT_B]).map((id) => ({ id })));
  tables.set("contacts", [
    { id: CONTACT_A, tenant_id: TENANT_A, name: "Ana", deleted_at: null, merged_into_id: null },
    { id: CONTACT_DELETED_A, tenant_id: TENANT_A, name: "Apagado", deleted_at: "2026-10-01T00:00:00Z", merged_into_id: null },
    { id: CONTACT_MERGED_A, tenant_id: TENANT_A, name: "Mesclado", deleted_at: null, merged_into_id: CONTACT_A },
    { id: "c0000000-0000-4000-8000-0000000000b1", tenant_id: TENANT_B, name: "Bia", deleted_at: null, merged_into_id: null },
  ]);
  tables.set("deals", [
    { id: DEAL_A, tenant_id: TENANT_A, board_id: BOARD_A, stage_id: STAGE_OPEN_A, title: "A", status: "open" },
    { id: DEAL_B, tenant_id: TENANT_B, board_id: "b0000000-0000-4000-8000-0000000000b1", stage_id: "x", title: "B" },
  ]);
  function builder(table: string): QueryBuilder {
    const log: QueryLog = { table, op: "select", filters: [] };
    queries.push(log);
    let limit = Infinity;
    let single = false;
    let insertedRow: Row | null = null;
    const run = (): DbResult => {
      const rows = tables.get(table) ?? [];
      if (options.tableError?.table === table) {
        return { data: null, error: { message: "falha interna secreta", code: options.tableError.code } };
      }
      const missing = unknownColumn(table, log);
      if (missing) {
        return { data: null, error: { message: `column ${table}.${missing} does not exist`, code: "42703" } };
      }
      if (log.op === "insert") {
        insertedRow = { id: `new-${rows.length + 1}`, ...log.inserted! };
        rows.push(insertedRow);
        tables.set(table, rows);
        return { data: insertedRow, error: null };
      }
      const hit = rows.filter((r) =>
        log.filters.every((f) =>
          f.op === "eq"
            ? r[f.column] === f.value
            : f.op === "is"
            ? (r[f.column] ?? null) === f.value
            : String(r[f.column]) > String(f.value)
        )
      ).slice(0, limit);
      return { data: single ? (hit[0] ?? null) : hit, error: null };
    };
    const self: QueryBuilder = {
      select: (columns) => (log.columns = columns, self),
      insert: (values) => {
        log.op = "insert";
        log.inserted = values;
        return self;
      },
      eq: (column, value) => (log.filters.push({ column, op: "eq", value }), self),
      gt: (column, value) => (log.filters.push({ column, op: "gt", value }), self),
      is: (column, value) => (log.filters.push({ column, op: "is", value }), self),
      order: () => self,
      limit: (n) => (limit = n, self),
      maybeSingle: () => (single = true, Promise.resolve(run())),
      single: () => (single = true, Promise.resolve(run())),
      then: (ok, bad) => Promise.resolve(run()).then(ok, bad),
    };
    return self;
  }

  const db: DbClient = {
    from: builder,
    rpc: (fn, args) => {
      rpcs.push({ fn, args });
      if (fn === "authenticate_api_key") {
        const ok = args.p_key_hash === keyHash && !options.revoked;
        return Promise.resolve({
          data: ok ? [{ key_id: "key-1", tenant_id: TENANT_A, scopes: options.scopes ?? ["deals:read", "deals:write", "contacts:read", "contacts:write"] }] : [],
          error: null,
        });
      }
      if (fn === "check_and_record_rate_limit") {
        const rl = options.rateLimit ?? { allowed: true, retryAfterSeconds: 0 };
        return Promise.resolve(rl === "error" ? { data: null, error: { message: "boom" } } : { data: rl, error: null });
      }
      return Promise.resolve({ data: null, error: { message: "rpc desconhecida" } });
    },
  };

  const deps: ApiDeps = { db, log: (e) => logs.push(e), newRequestId: () => "req-1" };
  return { deps, queries, rpcs, logs, tables };
}

export function call(path: string, init: RequestInit & { token?: string | null } = {}): Request {
  const { token = TOKEN_A, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("X-Api-Key", token);
  return new Request(`https://x.supabase.co/functions/v1/public-api${path}`, { ...rest, headers });
}
