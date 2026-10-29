import { handleRequest } from "../public-api/handler.ts";
import { call, makeKit, TENANT_A, TENANT_B, TOKEN_A } from "./public-api-test-kit.ts";

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: esperado ${expected}, veio ${actual}`);
}
const post = (path: string, body: unknown) =>
  call(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) });

// ---- M2: teto de corpo
Deno.test("Content-Length acima de 64 KB responde 413 payload_too_large", async () => {
  const { deps } = await makeKit();
  const req = call("/v1/contacts", { method: "POST", body: "{}", headers: { "content-length": "70000" } });
  const res = await handleRequest(req, deps);
  assertEquals(res.status, 413, "status");
  assertEquals((await res.json()).error.code, "payload_too_large", "code");
});

Deno.test("corpo lido acima de 64 KB responde 413", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(post("/v1/contacts", { name: "x", notes: "a".repeat(70000) }), deps);
  assertEquals(res.status, 413, "status");
});

// ---- M3: limit inválido
for (const bad of ["abc", "0", "-5", "1.5"]) {
  Deno.test(`limit=${bad} responde 422 validation_error`, async () => {
    const { deps } = await makeKit();
    const res = await handleRequest(call(`/v1/deals?limit=${bad}`), deps);
    assertEquals(res.status, 422, "status");
    assertEquals((await res.json()).error.code, "validation_error", "code");
  });
}

// ---- M4: SQLSTATE
for (const code of ["23514", "22023", "23502", "22P02"]) {
  Deno.test(`SQLSTATE ${code} vira 422 e é logado sem corpo`, async () => {
    const { deps, logs } = await makeKit({ tableError: { table: "contacts", code } });
    const res = await handleRequest(call("/v1/contacts"), deps);
    assertEquals(res.status, 422, "status");
    assertEquals(logs.some((l) => l.sqlstate === code), true, "sqlstate no log");
    const text = JSON.stringify(logs) + await res.text();
    assertEquals(text.includes("falha interna secreta"), false, "mensagem do banco não vaza");
    assertEquals(text.includes(TOKEN_A), false, "token");
  });
}

Deno.test("SQLSTATE P0002 vira 404; outros e sem código viram 503", async () => {
  const get = async (code?: string) => {
    const { deps } = await makeKit({ tableError: { table: "contacts", code } });
    return (await handleRequest(call("/v1/contacts"), deps)).status;
  };
  assertEquals(await get("P0002"), 404, "P0002");
  assertEquals(await get("40001"), 503, "outro");
  assertEquals(await get(undefined), 503, "sem código");
});

// ---- M5: contatos
Deno.test("POST contacts valida email, telefone, nome e tags", async () => {
  const { deps } = await makeKit();
  const bad = [
    { name: "A", email: "sem-arroba" },
    { name: "A", phone: "123" },
    { name: "A", phone: "11999998888" },
    { name: "A", phone: "5511999998888" },
    { name: "A", phone: "+123" },
    { name: "A", phone: "1".repeat(16) },
    { name: "A".repeat(201) },
    { name: "A", tags: ["x".repeat(51)] },
    { name: "A", tags: [1] },
  ];
  for (const b of bad) {
    const res = await handleRequest(post("/v1/contacts", b), deps);
    assertEquals(res.status, 422, JSON.stringify(b).slice(0, 40));
  }
});

Deno.test("POST contacts normaliza telefone para +dígitos e email para minúsculas", async () => {
  const { deps, queries } = await makeKit();
  const res = await handleRequest(post("/v1/contacts", { name: "Ana", phone: "+55 (11) 99999-8888", email: " Ana@X.com " }), deps);
  assertEquals(res.status, 201, "status");
  const inserted = queries.find((q) => q.op === "insert")!.inserted!;
  assertEquals(inserted.phone, "+5511999998888", "telefone");
  assertEquals(inserted.email, "ana@x.com", "email");
});

// ---- M7: cabeçalhos
Deno.test("405 traz Allow", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(call("/v1/contacts", { method: "DELETE" }), deps);
  assertEquals(res.status, 405, "status");
  assertEquals(res.headers.get("Allow"), "GET, POST", "Allow");
});

Deno.test("erros expõem Retry-After via Access-Control-Expose-Headers", async () => {
  const { deps } = await makeKit({ rateLimit: { allowed: false, retryAfterSeconds: 5 } });
  const res = await handleRequest(call("/v1/me"), deps);
  assertEquals(String(res.headers.get("Access-Control-Expose-Headers")).includes("Retry-After"), true, "expose");
});

// ---- M9: mass assignment e OPTIONS
Deno.test("POST contacts ignora tenant_id e campos internos do corpo", async () => {
  const { deps, queries } = await makeKit();
  const res = await handleRequest(
    post("/v1/contacts", { name: "Ana", tenant_id: TENANT_B, id: "forjado", ai_paused: true, created_at: "2000-01-01" }),
    deps,
  );
  assertEquals(res.status, 201, "status");
  const inserted = queries.find((q) => q.op === "insert")!.inserted!;
  assertEquals(inserted.tenant_id, TENANT_A, "tenant da chave");
  assertEquals(inserted.id, undefined, "id");
  assertEquals(inserted.ai_paused, undefined, "ai_paused");
  assertEquals(inserted.created_at, undefined, "created_at");
});

Deno.test("OPTIONS responde 200 com CORS, sem exigir chave nem tocar o banco", async () => {
  const { deps, rpcs, queries } = await makeKit();
  const res = await handleRequest(new Request("https://x/functions/v1/public-api/v1/me", { method: "OPTIONS" }), deps);
  assertEquals(res.status, 200, "status");
  assertEquals(res.headers.get("Access-Control-Allow-Origin"), "*", "CORS");
  assertEquals(rpcs.length + queries.length, 0, "sem acesso a dados");
});

// ---- Round 2: leitura limitada do corpo
function streamOf(totalBytes: number, chunk: number, state: { pulled: number; cancelled: boolean }) {
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (state.pulled >= totalBytes) return controller.close();
      state.pulled += chunk;
      controller.enqueue(new Uint8Array(chunk).fill(97));
    },
    cancel() {
      state.cancelled = true;
    },
  });
}

Deno.test("corpo em partes de 10 MB sem Content-Length: 413 e leitura cancelada cedo", async () => {
  const { deps } = await makeKit();
  const state = { pulled: 0, cancelled: false };
  const req = new Request("https://x/functions/v1/public-api/v1/contacts", {
    method: "POST",
    headers: { "X-Api-Key": TOKEN_A },
    body: streamOf(10 * 1024 * 1024, 16 * 1024, state),
    // duplex é exigido pelo runtime para corpo em stream
    duplex: "half",
  } as RequestInit);
  assertEquals(req.headers.get("content-length"), null, "sem Content-Length");
  const res = await handleRequest(req, deps);
  assertEquals(res.status, 413, "status");
  assertEquals((await res.json()).error.code, "payload_too_large", "code");
  assertEquals(state.cancelled, true, "stream cancelado");
  assertEquals(state.pulled < 1024 * 1024, true, `leu pouco (${state.pulled} bytes de 10 MB)`);
});

Deno.test("Content-Length mentiroso (menor que o corpo real) responde 413", async () => {
  const { deps } = await makeKit();
  const body = JSON.stringify({ name: "x", notes: "a".repeat(70000) });
  const res = await handleRequest(
    call("/v1/contacts", { method: "POST", body, headers: { "content-length": "10" } }),
    deps,
  );
  assertEquals(res.status, 413, "status");
});

Deno.test("corpo pequeno válido continua funcionando", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(post("/v1/contacts", { name: "Ana", phone: "+55 11 99999-8888" }), deps);
  assertEquals(res.status, 201, "status");
});

Deno.test("JSON inválido continua 422", async () => {
  const { deps } = await makeKit();
  const res = await handleRequest(post("/v1/contacts", "{nao-e-json"), deps);
  assertEquals(res.status, 422, "status");
});
