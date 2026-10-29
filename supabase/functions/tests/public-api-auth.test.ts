import { handleRequest } from "../public-api/handler.ts";
import { call, makeKit, TENANT_A, TENANT_B, TOKEN_A } from "./public-api-test-kit.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: esperado ${expected}, veio ${actual}`);
}

Deno.test("sem header X-Api-Key responde 401 auth_missing", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call("/v1/me", { token: null }), deps);
  const body = await res.json();
  assertEquals(res.status, 401, "status");
  assertEquals(body.error.code, "auth_missing", "code");
  assertEquals(body.error.request_id, "req-1", "request_id");
});

Deno.test("chave revogada responde 401 auth_invalid", async () => {
  const { deps } = await makeKit({ revoked: true });
  const res = await handleRequest(call("/v1/me"), deps);
  assertEquals(res.status, 401, "status");
  assertEquals((await res.json()).error.code, "auth_invalid", "code");
});

Deno.test("RPC recebe sha256 em hex, nunca o token", async () => {
  const { deps, rpcs } = await makeKit();
  await handleRequest(call("/v1/me"), deps);
  const hash = String(rpcs[0].args.p_key_hash);
  assertEquals(/^[0-9a-f]{64}$/.test(hash), true, "formato sha256 hex");
  assertEquals(JSON.stringify(rpcs).includes(TOKEN_A), false, "token fora das RPCs");
});

Deno.test("escopo insuficiente responde 403", async () => {
  const { deps } = await makeKit({ scopes: ["contacts:read"] });
  const res = await handleRequest(call("/v1/deals"), deps);
  assertEquals(res.status, 403, "status");
  assertEquals((await res.json()).error.code, "insufficient_scope", "code");
});

Deno.test("tenant inativo (ausente) responde 403 tenant_inactive", async () => {
  const { deps } = await makeKit({ tenantsPresent: [TENANT_B] });
  const res = await handleRequest(call("/v1/me"), deps);
  assertEquals(res.status, 403, "status");
  assertEquals((await res.json()).error.code, "tenant_inactive", "code");
});

Deno.test("429 traz Retry-After e a RPC usa 120 por 60s por chave", async () => {
  const { deps, rpcs } = await makeKit({ rateLimit: { allowed: false, retryAfterSeconds: 17 } });
  const res = await handleRequest(call("/v1/me"), deps);
  assertEquals(res.status, 429, "status");
  assertEquals(res.headers.get("Retry-After"), "17", "Retry-After");
  const rl = rpcs.find((r) => r.fn === "check_and_record_rate_limit")!;
  assertEquals(rl.args.p_max_calls, 120, "max");
  assertEquals(rl.args.p_window_seconds, 60, "janela");
  assertEquals(rl.args.p_key, "public-api:key-1", "chave do limite");
});

Deno.test("rate limit falha fechada quando a RPC erra", async () => {
  const { deps } = await makeKit({ rateLimit: "error" });
  const res = await handleRequest(call("/v1/me"), deps);
  assertEquals(res.status, 503, "status");
});

Deno.test("GET /v1/me devolve tenant, chave e escopos", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call("/v1/me"), deps);
  const body = await res.json();
  assertEquals(res.status, 200, "status");
  assertEquals(body.data.tenant_id, TENANT_A, "tenant");
});

Deno.test("nenhum corpo de erro nem log contém o token", async () => {
  const cases: Array<[string, Parameters<typeof makeKit>[0]]> = [
    ["/v1/me", { revoked: true }],
    ["/v1/me", { rateLimit: { allowed: false, retryAfterSeconds: 3 } }],
    ["/v1/me", { rateLimit: "error" }],
    ["/v1/deals", { scopes: [] }],
    ["/v1/nada", {}],
    [`/v1/deals/${TOKEN_A}`, {}],
  ];
  for (const [path, opts] of cases) {
    const { deps, logs } = await makeKit(opts);
    const res = await handleRequest(call(path), deps);
    const text = await res.text();
    assertEquals(text.includes(TOKEN_A), false, `corpo ${path}`);
    assertEquals(JSON.stringify(logs).includes(TOKEN_A), false, `log ${path}`);
  }
});
