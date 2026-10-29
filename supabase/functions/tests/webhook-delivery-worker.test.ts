import { assert, assertEquals, assertNotEquals } from "jsr:@std/assert@1";
import {
  type DeliveryRow,
  runWebhookDeliveryWorker,
  type WebhookWorkerDb,
  validateWebhookUrl,
} from "../webhook-delivery-worker/runner.ts";
import { verifyWebhook } from "../_shared/webhooks/sign.ts";
import { validatePublicHttpsUrl } from "../_shared/validate-http-url.ts";

const SECRET = "whsec_current";
const PREVIOUS = "whsec_previous";
const WORKER = "test-worker";
const allowAll = () => Promise.resolve({ ok: true });

interface FakeEndpoint {
  url: string;
  active: boolean;
  disabledReason: string | null;
  previous: string | null;
}
interface FakeDelivery extends DeliveryRow {
  retryAt: Date | null;
  lastError: string | null;
  responseStatus: number | null;
  excerpt: string | null;
}

// Modela as RPCs reais: claim incrementa attempts; fail decide dead_letter por attempts >= max_attempts.
class FakeDb implements WebhookWorkerDb {
  endpoints = new Map<string, FakeEndpoint>();
  deliveries = new Map<string, FakeDelivery>();
  log: string[] = [];
  faults = new Set<string>(); // "loadEndpoint" | "getSecrets" | "fail:<id>" | "complete:<id>" | "disable"
  events = new Map<string, { id: string; event_type: string; tenant_id: string; occurred_at: string; payload: unknown }>();

  addEndpoint(id: string, url: string, previous: string | null = null) {
    this.endpoints.set(id, { url, active: true, disabledReason: null, previous });
  }
  addDelivery(id: string, endpointId: string, eventType = "deal.won", maxAttempts = 8) {
    const eventId = crypto.randomUUID();
    this.events.set(eventId, {
      id: eventId,
      event_type: eventType,
      tenant_id: "tenant-1",
      occurred_at: "2026-10-20T12:00:00Z",
      payload: { hello: "world" },
    });
    this.deliveries.set(id, {
      id,
      tenant_id: "tenant-1",
      endpoint_id: endpointId,
      event_id: eventId,
      event_type: eventType,
      status: "pending",
      attempts: 0,
      max_attempts: maxAttempts,
      retryAt: null,
      lastError: null,
      responseStatus: null,
      excerpt: null,
    });
  }
  claim(limit: number, _worker: string): Promise<DeliveryRow[]> {
    const rows: DeliveryRow[] = [];
    for (const d of this.deliveries.values()) {
      if (rows.length >= limit) break;
      if (d.status !== "pending" || !this.endpoints.get(d.endpoint_id)?.active) continue;
      d.status = "processing";
      d.attempts += 1;
      rows.push({ ...d });
    }
    return Promise.resolve(rows);
  }
  loadEndpoint(id: string) {
    if (this.faults.has("loadEndpoint")) return Promise.reject(new Error("db caiu"));
    const e = this.endpoints.get(id);
    return Promise.resolve(e ? { id, url: e.url, active: e.active } : null);
  }
  loadEvent(id: string) {
    return Promise.resolve(this.events.get(id) ?? null);
  }
  getSecrets(endpointId: string) {
    if (this.faults.has("getSecrets")) return Promise.reject(new Error("rpc caiu"));
    return Promise.resolve({ current: SECRET, previous: this.endpoints.get(endpointId)?.previous ?? null });
  }
  complete(id: string, _worker: string, status: number, excerpt: string | null) {
    if (this.faults.has(`complete:${id}`)) return Promise.reject(new Error("lease perdido"));
    if (excerpt?.includes("\u0000")) return Promise.reject(new Error("invalid byte sequence: 0x00"));
    this.log.push(`complete:${id}`);
    const d = this.deliveries.get(id)!;
    d.status = "delivered";
    d.responseStatus = status;
    d.excerpt = excerpt;
    return Promise.resolve();
  }
  fail(id: string, _worker: string, error: string, status: number | null, excerpt: string | null, retryAt: Date) {
    if (this.faults.has(`fail:${id}`)) return Promise.reject(new Error("lease perdido"));
    if (excerpt?.includes("\u0000")) return Promise.reject(new Error("invalid byte sequence: 0x00"));
    this.log.push(`fail:${id}`);
    const d = this.deliveries.get(id)!;
    d.status = d.attempts >= d.max_attempts ? "dead_letter" : "pending";
    d.lastError = error;
    d.responseStatus = status;
    d.excerpt = excerpt;
    d.retryAt = retryAt;
    return Promise.resolve();
  }
  deadLetter(id: string, _worker: string, error: string) {
    const d = this.deliveries.get(id)!;
    d.status = "dead_letter";
    d.lastError = error;
    return Promise.resolve();
  }
  disableEndpoint(id: string, reason: string) {
    if (this.faults.has("disable")) return Promise.reject(new Error("update falhou"));
    const e = this.endpoints.get(id)!;
    e.active = false;
    e.disabledReason = reason;
    return Promise.resolve();
  }
}

interface Hit {
  headers: Headers;
  body: string;
}
function receiver(handler: (req: Request, n: number) => Response | Promise<Response>) {
  const hits: Hit[] = [];
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    hits.push({ headers: req.headers, body: await req.text() });
    return handler(req, hits.length);
  });
  return { hits, url: `http://127.0.0.1:${server.addr.port}/hook`, stop: () => server.shutdown() };
}
const run = (db: FakeDb, opts: { timeoutMs?: number; validateUrl?: typeof validatePublicHttpsUrl } = {}) =>
  runWebhookDeliveryWorker(db, WORKER, { validateUrl: allowAll, ...opts });

Deno.test("200: entrega concluida, headers e assinatura verificavel", async () => {
  const r = receiver(() => new Response("ok", { status: 200 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  const res = await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d1")!.status, "delivered");
  assertEquals(res.delivered, 1);
  const h = r.hits[0];
  assertEquals(h.headers.get("content-type"), "application/json");
  assertEquals(h.headers.get("user-agent"), "Aceleraflow-Webhooks/1");
  assertEquals(h.headers.get("x-aceleraflow-event"), "deal.won");
  assertEquals(h.headers.get("x-aceleraflow-delivery"), "d1");
  const env = JSON.parse(h.body);
  assertEquals(env.type, "deal.won");
  assertEquals(env.api_version, "2026-10-20");
  assertEquals(env.data, { hello: "world" });
  assert(await verifyWebhook(SECRET, h.headers.get("x-aceleraflow-signature")!, h.body));
});

Deno.test("segredo anterior valido: dois v1 no header, ambos verificam", async () => {
  const r = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url, PREVIOUS);
  db.addDelivery("d1", "ep1");
  await run(db);
  await r.stop();
  const sig = r.hits[0].headers.get("x-aceleraflow-signature")!;
  assertEquals(sig.match(/v1=/g)?.length, 2);
  assert(await verifyWebhook(SECRET, sig, r.hits[0].body));
  assert(await verifyWebhook(PREVIOUS, sig, r.hits[0].body));
});

Deno.test("500 duas vezes e depois 200: 3 tentativas, X-Aceleraflow-Delivery fixo", async () => {
  const r = receiver((_req, n) => new Response("x", { status: n < 3 ? 500 : 200 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  for (let i = 0; i < 3; i++) await run(db);
  await r.stop();
  const d = db.deliveries.get("d1")!;
  assertEquals(d.status, "delivered");
  assertEquals(d.attempts, 3);
  assertEquals(r.hits.length, 3);
  assertEquals(new Set(r.hits.map((h) => h.headers.get("x-aceleraflow-delivery"))).size, 1);
});

Deno.test("sempre 500: dead_letter na ultima tentativa, com retry agendado antes", async () => {
  const r = receiver(() => new Response("boom", { status: 500 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1", "deal.won", 8);
  for (let i = 1; i <= 8; i++) {
    await run(db);
    const expected = i < 8 ? "pending" : "dead_letter";
    assertEquals(db.deliveries.get("d1")!.status, expected, `tentativa ${i}`);
  }
  await r.stop();
  assertEquals(r.hits.length, 8);
  assertEquals(db.deliveries.get("d1")!.responseStatus, 500);
  assertNotEquals(db.deliveries.get("d1")!.retryAt, null);
});

Deno.test("410: endpoint desativado com disabled_reason gone", async () => {
  const r = receiver(() => new Response("gone", { status: 410 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  await run(db);
  await r.stop();
  const e = db.endpoints.get("ep1")!;
  assertEquals(e.active, false);
  assertEquals(e.disabledReason, "gone");
  assertEquals(db.deliveries.get("d1")!.responseStatus, 410);
});

Deno.test("URL http e 127.0.0.1: bloqueada no envio, sem abrir conexao", async () => {
  const r = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  const res = await runWebhookDeliveryWorker(db, WORKER, { validateUrl: validatePublicHttpsUrl });
  await r.stop();
  assertEquals(r.hits.length, 0);
  assertEquals(res.failed, 1);
  const d = db.deliveries.get("d1")!;
  assertEquals(d.status, "pending");
  assert(d.lastError?.startsWith("url bloqueada"));
});

Deno.test("302 para 169.254.169.254: redirect nao seguido, conta como falha", async () => {
  const trap = receiver(() => new Response("metadata"));
  const r = receiver(() => new Response(null, { status: 302, headers: { location: trap.url } }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  await run(db);
  await r.stop();
  await trap.stop();
  assertEquals(trap.hits.length, 0);
  const d = db.deliveries.get("d1")!;
  assertEquals(d.status, "pending");
  assertEquals(d.responseStatus, 302);
});

Deno.test("corpo de 10 MB: excerpt truncado em 2 KB", async () => {
  const chunk = new Uint8Array(64 * 1024).fill(97);
  const r = receiver(() => {
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(c) {
        if (sent >= 10 * 1024 * 1024) return c.close();
        sent += chunk.length;
        c.enqueue(chunk);
      },
    });
    return new Response(body, { status: 200 });
  });
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  await run(db);
  await r.stop();
  const d = db.deliveries.get("d1")!;
  assertEquals(d.status, "delivered");
  assertEquals(d.excerpt?.length, 2048);
});

Deno.test("endpoint travado nao impede o outro no mesmo ciclo", async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => (release = resolve));
  const hang = receiver(async () => {
    await gate;
    return new Response(null);
  });
  const fast = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.addEndpoint("slow", hang.url);
  db.addEndpoint("fast", fast.url);
  db.addDelivery("d-slow", "slow");
  db.addDelivery("d-fast", "fast");
  const res = await run(db, { timeoutMs: 300 });
  release();
  await hang.stop();
  await fast.stop();
  assertEquals(db.deliveries.get("d-fast")!.status, "delivered");
  assertEquals(db.deliveries.get("d-slow")!.status, "pending");
  assertEquals(db.deliveries.get("d-slow")!.lastError, "timeout");
  assertEquals(res.delivered, 1);
  assertEquals(res.failed, 1);
  // o lento foi adicionado primeiro: uma implementacao sequencial registraria o lento antes.
  assertEquals(db.log, ["complete:d-fast", "fail:d-slow"]);
});

Deno.test("webhook.test e entregue normalmente", async () => {
  const r = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1", "webhook.test");
  await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d1")!.status, "delivered");
  assertEquals(JSON.parse(r.hits[0].body).type, "webhook.test");
});

Deno.test("primeira falha agenda retry em cerca de 60 s", async () => {
  const r = receiver(() => new Response("x", { status: 500 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  const before = Date.now();
  await run(db);
  await r.stop();
  const delta = (db.deliveries.get("d1")!.retryAt!.getTime() - before) / 1000;
  assert(delta >= 53 && delta <= 67, `retry em ${delta}s`);
});

Deno.test("excerpt com byte NUL e saneado: 200 continua entregue (Postgres rejeita 0x00)", async () => {
  const r = receiver(() => new Response("a\u0000b", { status: 200 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  const res = await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d1")!.status, "delivered");
  assertEquals(db.deliveries.get("d1")!.excerpt, "ab");
  assertEquals(res.errored, 0);
});

Deno.test("excerpt com NUL em resposta 500 tambem e saneado no fail", async () => {
  const r = receiver(() => new Response("x\u0000y", { status: 500 }));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d1")!.excerpt, "xy");
  assertEquals(db.deliveries.get("d1")!.status, "pending");
});

Deno.test("410: falha ao desativar nao impede o registro da falha", async () => {
  const r = receiver(() => new Response("gone", { status: 410 }));
  const db = new FakeDb();
  db.faults.add("disable");
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d1")!.responseStatus, 410);
  assertEquals(db.deliveries.get("d1")!.status, "pending");
});

Deno.test("410: fail com lease perdido nao impede a desativacao do endpoint", async () => {
  const r = receiver(() => new Response("gone", { status: 410 }));
  const db = new FakeDb();
  db.faults.add("fail:d1");
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  const res = await run(db);
  await r.stop();
  assertEquals(db.endpoints.get("ep1")!.active, false);
  assertEquals(res.errored, 1);
});

Deno.test("excecao em loadEndpoint ou getSecrets vira registro de falha", async () => {
  for (const fault of ["loadEndpoint", "getSecrets"]) {
    const db = new FakeDb();
    db.faults.add(fault);
    db.addEndpoint("ep1", "https://example.com/hook");
    db.addDelivery("d1", "ep1");
    const res = await run(db);
    const d = db.deliveries.get("d1")!;
    assertEquals(d.status, "pending", fault);
    assert(d.lastError?.startsWith("erro interno"), fault);
    assertEquals(res.failed, 1, fault);
  }
});

Deno.test("lease perdido em uma entrega nao derruba o lote", async () => {
  const r = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.faults.add("complete:d1");
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  db.addDelivery("d2", "ep1");
  const res = await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d2")!.status, "delivered");
  assertEquals(res.delivered, 1);
  assertEquals(res.errored, 1);
});

Deno.test("payload acima de 256 KB vai direto para dead_letter sem enviar", async () => {
  const r = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  const ev = [...db.events.values()][0];
  ev.payload = { blob: "x".repeat(257 * 1024) };
  await run(db);
  await r.stop();
  assertEquals(r.hits.length, 0);
  const d = db.deliveries.get("d1")!;
  assertEquals(d.status, "dead_letter");
  assertEquals(d.lastError, "payload muito grande");
});

Deno.test("payload perto do limite (abaixo de 256 KB) e enviado", async () => {
  const r = receiver(() => new Response("ok"));
  const db = new FakeDb();
  db.addEndpoint("ep1", r.url);
  db.addDelivery("d1", "ep1");
  [...db.events.values()][0].payload = { blob: "x".repeat(200 * 1024) };
  await run(db);
  await r.stop();
  assertEquals(db.deliveries.get("d1")!.status, "delivered");
});

Deno.test("validateWebhookUrl falha fechado com DNS lento (não estoura o lease)", async () => {
  const lento = () => new Promise<string[]>((resolve) => setTimeout(() => resolve(["93.184.216.34"]), 200));
  const r = await validateWebhookUrl("https://lento.example.com/h", { resolveDns: lento, dnsTimeoutMs: 20 });
  assertEquals(r.ok, false);
});
