import { handleRequest } from "../public-api/handler.ts";
import {
  call, CONTACT_A, CONTACT_DELETED_A, CONTACT_MERGED_A, DEAL_A, DEAL_B, makeKit, TENANT_A,
} from "./public-api-test-kit.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: esperado ${expected}, veio ${actual}`);
}

Deno.test("chave do tenant A em deal do tenant B devolve 404", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call(`/v1/deals/${DEAL_B}`), deps);
  assertEquals(res.status, 404, "status");
  assertEquals((await res.json()).error.code, "not_found", "code");
});

Deno.test("deal do próprio tenant é devolvido", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call(`/v1/deals/${DEAL_A}`), deps);
  assertEquals(res.status, 200, "status");
  assertEquals((await res.json()).data.id, DEAL_A, "id");
});

Deno.test("toda consulta a dados de negócio contém filtro tenant_id", async () => {
  const { deps, queries } = await makeKit();
  await handleRequest(call("/v1/contacts"), deps);
  await handleRequest(call(`/v1/contacts/c0000000-0000-4000-8000-0000000000a1`), deps);
  await handleRequest(call("/v1/contacts", { method: "POST", body: JSON.stringify({ name: "Novo" }) }), deps);
  await handleRequest(call("/v1/deals"), deps);
  await handleRequest(call(`/v1/deals/${DEAL_A}`), deps);
  const business = queries.filter((q) => q.table !== "tenants");
  assertEquals(business.length > 4, true, "consultas capturadas");
  for (const q of business) {
    const scoped = q.op === "insert"
      ? q.inserted?.tenant_id === TENANT_A
      : q.filters.some((f) => f.column === "tenant_id" && f.op === "eq" && f.value === TENANT_A);
    assertEquals(scoped, true, `${q.op} em ${q.table} sem escopo`);
  }
});

Deno.test("contato apagado ou mesclado não aparece na lista", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call("/v1/contacts"), deps);
  assertEquals(res.status, 200, "status");
  const ids = (await res.json()).data.map((c: { id: string }) => c.id);
  assertEquals(ids.includes(CONTACT_A), true, "ativo listado");
  assertEquals(ids.includes(CONTACT_DELETED_A), false, "apagado fora");
  assertEquals(ids.includes(CONTACT_MERGED_A), false, "mesclado fora");
});

Deno.test("contato apagado ou mesclado por id responde 404", async () => {
  const { deps } = await makeKit();
  for (const id of [CONTACT_DELETED_A, CONTACT_MERGED_A]) {
    const res = await handleRequest(call(`/v1/contacts/${id}`), deps);
    assertEquals(res.status, 404, `status ${id}`);
  }
  const ok = await handleRequest(call(`/v1/contacts/${CONTACT_A}`), deps);
  assertEquals(ok.status, 200, "ativo");
});

Deno.test("limit=1000 é capado em 100 (pede 101 ao banco)", async () => {
  const kit = await makeKit();
  let seen = 0;
  const original = kit.deps.db.from;
  kit.deps.db.from = (table) => {
    const q = original(table);
    const lim = q.limit.bind(q);
    q.limit = (n) => (seen = n, lim(n));
    return q;
  };
  const res = await handleRequest(call("/v1/contacts?limit=1000"), kit.deps);
  assertEquals(res.status, 200, "status");
  assertEquals(seen, 101, "limit pedido ao banco");
});

Deno.test("cursor inválido responde 422", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call("/v1/contacts?cursor=abc"), deps);
  assertEquals(res.status, 422, "status");
});

Deno.test("POST /contacts valida nome e cria com 201", async () => {
  const { deps } = await makeKit();
  const bad = await handleRequest(call("/v1/contacts", { method: "POST", body: "{}" }), deps);
  assertEquals(bad.status, 422, "sem nome");
  const ok = await handleRequest(call("/v1/contacts", { method: "POST", body: JSON.stringify({ name: "Zé" }) }), deps);
  assertEquals(ok.status, 201, "criado");
});

Deno.test("v1 não publica won e lost: 404 para qualquer método e nada toca a RPC de transição", async () => {
  for (const kind of ["won", "lost"]) {
    for (const method of ["POST", "GET"]) {
      const { deps, rpcs, queries } = await makeKit();
      const res = await handleRequest(call(`/v1/deals/${DEAL_A}/${kind}`, { method }), deps);
      assertEquals(res.status, 404, `status ${method} ${kind}`);
      assertEquals((await res.json()).error.code, "not_found", `code ${method} ${kind}`);
      assertEquals(rpcs.some((r) => r.fn === "transition_deal_stage"), false, `sem RPC ${kind}`);
      assertEquals(queries.some((q) => q.table === "board_stages"), false, `sem etapas ${kind}`);
    }
  }
});
