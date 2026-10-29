import type { DbClient, DbResult, Row } from "./types.ts";

const CONTACT_COLUMNS = "id,name,email,phone,source,tags,notes,created_at,updated_at";
const DEAL_COLUMNS =
  "id,title,value,status,contact_id,board_id,stage_id,lost_reason,created_at,updated_at";

export class DbError extends Error {
  constructor(message: string, readonly sqlstate: string | null = null) {
    super(message);
  }
}

function unwrap(result: DbResult): unknown {
  if (result.error) throw new DbError(result.error.message, result.error.code ?? null);
  return result.data;
}

function rowOrNull(data: unknown): Row | null {
  return data && typeof data === "object" ? (data as Row) : null;
}

function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

export interface PageQuery {
  limit: number;
  after: string | null;
}

/**
 * ÚNICO caminho de acesso a dados da API pública: todo filtro e todo insert
 * carregam o tenant_id da chave. Rota nenhuma recebe o client cru.
 */
export function tenantScoped(db: DbClient, tenantId: string) {
  const scopedSelect = (table: string, columns: string) =>
    db.from(table).select(columns).eq("tenant_id", tenantId);

  // Mesmo filtro da UI e das RPCs de contato: apagado (soft delete) e mesclado não existem.
  const liveContacts = () =>
    scopedSelect("contacts", CONTACT_COLUMNS).is("deleted_at", null).is("merged_into_id", null);

  async function page(table: string, columns: string, query: PageQuery): Promise<Row[]> {
    let q = table === "contacts" ? liveContacts() : scopedSelect(table, columns);
    if (query.after) q = q.gt("id", query.after);
    return rows(unwrap(await q.order("id", { ascending: true }).limit(query.limit)));
  }

  async function byId(table: string, columns: string, id: string): Promise<Row | null> {
    const q = table === "contacts" ? liveContacts() : scopedSelect(table, columns);
    return rowOrNull(unwrap(await q.eq("id", id).maybeSingle()));
  }

  return {
    /** tenants não tem coluna tenant_id: o próprio id é o escopo. */
    async tenantExists(): Promise<boolean> {
      const result = await db.from("tenants").select("id").eq("id", tenantId).maybeSingle();
      return rowOrNull(unwrap(result)) !== null;
    },
    contacts: {
      list: (query: PageQuery) => page("contacts", CONTACT_COLUMNS, query),
      get: (id: string) => byId("contacts", CONTACT_COLUMNS, id),
      async create(values: Row): Promise<Row> {
        const created = unwrap(
          await db.from("contacts").insert({ ...values, tenant_id: tenantId })
            .select(CONTACT_COLUMNS).single(),
        );
        return created as Row;
      },
    },
    deals: {
      list: (query: PageQuery) => page("deals", DEAL_COLUMNS, query),
      get: (id: string) => byId("deals", DEAL_COLUMNS, id),
    },
  };
}

export type TenantScoped = ReturnType<typeof tenantScoped>;
