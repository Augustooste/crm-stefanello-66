import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  ensureContactIdentity,
  normalizeContactIdentity,
  resolveContactIdentity,
} from "../_shared/messaging/contact-identity.ts";

type IdentityRow = {
  tenant_id: string;
  contact_id: string;
  identity_type: string;
  provider_slug: string;
  normalized_value: string;
};

function fakeAdmin(seed: IdentityRow[] = []) {
  const identities = [...seed];
  const filters: Array<{ table: string; column: string; value: unknown }> = [];
  const from = (table: string) => {
    const localFilters: Record<string, unknown> = {};
    const builder: Record<string, unknown> = {};
    builder.select = () => builder;
    builder.eq = (column: string, value: unknown) => {
      filters.push({ table, column, value });
      localFilters[column] = value;
      return builder;
    };
    builder.ilike = builder.eq;
    builder.is = () => builder;
    builder.order = () => builder;
    builder.limit = () => builder;
    builder.maybeSingle = () => {
      if (table === "contact_identities") {
        const found = identities.find((row) =>
          Object.entries(localFilters).every(([key, value]) =>
            row[key as keyof IdentityRow] === value
          )
        );
        return Promise.resolve({
          data: found ? { contact_id: found.contact_id } : null,
          error: null,
        });
      }
      const contactId = localFilters.id as string | undefined;
      return Promise.resolve({
        data: contactId ? { id: contactId } : null,
        error: null,
      });
    };
    builder.insert = (row: IdentityRow) => {
      const duplicate = identities.find((item) =>
        item.tenant_id === row.tenant_id &&
        item.identity_type === row.identity_type &&
        item.provider_slug === row.provider_slug &&
        item.normalized_value === row.normalized_value
      );
      if (duplicate) return Promise.resolve({ error: { code: "23505" } });
      identities.push(row);
      return Promise.resolve({ error: null });
    };
    return builder;
  };
  return { client: { from } as never, identities, filters };
}

Deno.test("identity sync is idempotent and never reassigns a conflict", async () => {
  const db = fakeAdmin();
  const params = {
    tenantId: "tenant-a",
    contactId: "contact-1",
    type: "phone" as const,
    rawValue: "+55 (11) 99999-0000",
  };
  assertEquals(await ensureContactIdentity(db.client, params), "created");
  assertEquals(await ensureContactIdentity(db.client, params), "existing");
  assertEquals(
    await ensureContactIdentity(db.client, {
      ...params,
      contactId: "contact-2",
    }),
    "conflict",
  );
  assertEquals(db.identities.length, 1);
  assertEquals(db.identities[0].contact_id, "contact-1");
});

Deno.test("same normalized identity is isolated by tenant", async () => {
  const db = fakeAdmin();
  const common = { type: "email" as const, rawValue: " Ada@Example.COM " };
  assertEquals(
    await ensureContactIdentity(db.client, {
      ...common,
      tenantId: "tenant-a",
      contactId: "contact-a",
    }),
    "created",
  );
  assertEquals(
    await ensureContactIdentity(db.client, {
      ...common,
      tenantId: "tenant-b",
      contactId: "contact-b",
    }),
    "created",
  );
  assertEquals(db.identities.map((row) => row.tenant_id), [
    "tenant-a",
    "tenant-b",
  ]);
});

Deno.test("resolver applies tenant filter and returns canonical identity", async () => {
  const db = fakeAdmin([{
    tenant_id: "tenant-a",
    contact_id: "contact-a",
    identity_type: "phone",
    provider_slug: "generic",
    normalized_value: "+5511999990000",
  }]);
  assertEquals(
    await resolveContactIdentity(
      db.client,
      "tenant-a",
      "phone",
      "55 11 99999-0000",
    ),
    {
      contactId: "contact-a",
      source: "identity",
    },
  );
  assertEquals(
    db.filters.some((filter) =>
      filter.table === "contact_identities" && filter.column === "tenant_id" &&
      filter.value === "tenant-a"
    ),
    true,
  );
  assertEquals(
    normalizeContactIdentity("email", " Ada@Example.COM "),
    "ada@example.com",
  );
});

// Backstop legado de e-mail: o valor cai num filtro ILIKE. Sem escape, um
// `rawValue` com curingas ("%") vira pattern match e casa com qualquer contato
// do tenant (vazamento intra-tenant). O escape torna a busca uma comparação
// literal case-insensitive.
Deno.test("resolveContactIdentity escapa curingas de ILIKE no backstop de e-mail", async () => {
  const db = fakeAdmin(); // sem identity semeado: cai no backstop legado de contacts
  await resolveContactIdentity(db.client, "tenant-a", "email", "%@x.com");
  const emailFilter = db.filters.find(
    (filter) => filter.table === "contacts" && filter.column === "email",
  );
  assertEquals(emailFilter?.value, "\\%@x.com");
});

// H11 (docs/code-review/05-silent-failures.md): a query do meio — a que
// confirma se o contato apontado pelo identity ainda está ativo — descartava
// o `error`. Erro de banco virava "contato apagado", o fluxo caía no backstop
// e daí na criação de um contato DUPLICADO, sem uma linha de log. As duas
// queries vizinhas sempre logaram; só esta ficou muda.
Deno.test("resolveContactIdentity loga quando a leitura do contato ativo falha", async () => {
  const dbError = { message: "db indisponível", code: "57P03" };
  const admin = {
    from: (table: string) => {
      const builder: Record<string, unknown> = {};
      for (const method of ["select", "eq", "ilike", "is", "order", "limit"]) {
        builder[method] = () => builder;
      }
      builder.maybeSingle = () =>
        table === "contact_identities"
          ? Promise.resolve({ data: { contact_id: "contact-a" }, error: null })
          : Promise.resolve({ data: null, error: dbError });
      return builder;
    },
  } as never;

  const logged: string[] = [];
  const originalError = console.error;
  console.error = (...args: unknown[]) => {
    logged.push(args.map((arg) => JSON.stringify(arg) ?? String(arg)).join(" "));
  };
  try {
    const result = await resolveContactIdentity(admin, "tenant-a", "phone", "55 11 99999-0000");
    assertEquals(result, { contactId: null, source: "none" });
    assertEquals(
      logged.some((line) => line.includes("falha ao ler contacts do identity resolvido")),
      true,
      `erro da query do meio não foi logado: ${JSON.stringify(logged)}`,
    );
  } finally {
    console.error = originalError;
  }
});
