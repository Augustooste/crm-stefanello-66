// messaging-webhook — ramo ManyChat (External Request), ponta a ponta até o
// enfileiramento da IA, com um "banco" em memória atrás do fetch mock.
import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
const handler = await captureHandler("../messaging-webhook/index.ts");

const CHANNEL_ID = "11111111-2222-4333-8444-555555555555";
const TOKEN = "chan-token-abc";
const SECRET = "mc-webhook-secret";
const SLUG = "manychat-whatsapp";
const SUB = "12345678901234567";

function val(raw: string | null): string {
  return (raw ?? "").replace(/^[a-z]+\./, "");
}

interface Db {
  channel: { id: string; tenant_id: string; type: string; provider_slug: string; status: string };
  secrets: Array<{ key: string; value: string }>;
  identities: Array<{ contact_id: string; identity_type: string; provider_slug: string; normalized_value: string }>;
  contacts: Array<{ id: string; phone: string | null; email: string | null; name: string }>;
  conversation: { id: string; deleted_at: string | null } | null;
  messages: Array<Record<string, unknown>>;
  events: Map<string, string>;
  channelPatches: Array<Record<string, unknown>>;
  conversationPatches: Array<Record<string, unknown>>;
  conversationInserts: number;
  aiCalls: number;
  suppressionChecks: number;
  systemEvents: Array<Record<string, unknown>>;
  failClaim: boolean;
}

function newDb(): Db {
  return {
    channel: { id: CHANNEL_ID, tenant_id: "tenant-1", type: "whatsapp", provider_slug: SLUG, status: "connected" },
    secrets: [{ key: "api_key", value: "mc-key" }, { key: "webhook_secret", value: SECRET }],
    identities: [],
    contacts: [],
    conversation: null,
    messages: [],
    events: new Map(),
    channelPatches: [],
    conversationPatches: [],
    conversationInserts: 0,
    aiCalls: 0,
    suppressionChecks: 0,
    systemEvents: [],
    failClaim: false,
  };
}

function router(db: Db): FetchMatcher {
  return (req) => {
    const p = req.pathname;
    const sp = new URL(req.url).searchParams;
    const body = (req.bodyJson ?? {}) as Record<string, unknown>;
    if (p === "/rest/v1/channels" && req.method === "GET") {
      const ok = val(sp.get("id")) === db.channel.id && val(sp.get("webhook_token")) === TOKEN;
      return jsonResponse(200, ok ? [db.channel] : []);
    }
    if (p === "/rest/v1/channels" && req.method === "PATCH") {
      db.channelPatches.push(body);
      return emptyResponse(200);
    }
    if (p === "/rest/v1/integration_secrets" && req.method === "GET") {
      return jsonResponse(200, val(sp.get("slug")) === SLUG ? db.secrets : []);
    }
    if (p === "/rest/v1/rpc/claim_messaging_webhook_event") {
      if (db.failClaim) return jsonResponse(500, { message: "db down", code: "XX000" });
      const ext = String(body.p_external_event_id);
      const state = db.events.get(ext);
      if (!state) {
        db.events.set(ext, "processing");
        return jsonResponse(200, [{ event_id: `ev-${ext}`, claim_state: "claimed", attempt: 1 }]);
      }
      return jsonResponse(200, [{ event_id: `ev-${ext}`, claim_state: state === "completed" ? "completed" : "busy", attempt: 1 }]);
    }
    if (p === "/rest/v1/messaging_webhook_events" && req.method === "PATCH") {
      const id = val(sp.get("id")).replace(/^ev-/, "");
      if (body.status === "completed") db.events.set(id, "completed");
      return emptyResponse(200);
    }
    if (p === "/rest/v1/rpc/bump_channel_webhook_failure") return jsonResponse(200, 1);
    if (p === "/rest/v1/contact_identities" && req.method === "GET") {
      const rows = db.identities.filter((i) =>
        i.identity_type === val(sp.get("identity_type")) &&
        i.provider_slug === val(sp.get("provider_slug")) &&
        i.normalized_value === val(sp.get("normalized_value"))
      );
      return jsonResponse(200, rows.map((r) => ({ contact_id: r.contact_id })));
    }
    if (p === "/rest/v1/contact_identities" && req.method === "POST") {
      db.identities.push(body as unknown as Db["identities"][number]);
      return jsonResponse(201, []);
    }
    if (p === "/rest/v1/contacts" && req.method === "GET") {
      const id = sp.get("id") ? val(sp.get("id")) : null;
      const phone = sp.get("phone") ? val(sp.get("phone")) : null;
      const found = db.contacts.find((c) => (id && c.id === id) || (phone && c.phone === phone));
      return jsonResponse(200, found ? [found] : []);
    }
    if (p === "/rest/v1/contacts" && req.method === "POST") {
      const id = `contact-${db.contacts.length + 1}`;
      db.contacts.push({ id, phone: (body.phone as string) ?? null, email: (body.email as string) ?? null, name: String(body.name) });
      return jsonResponse(201, { id });
    }
    if (p === "/rest/v1/contacts" && req.method === "PATCH") return emptyResponse(200);
    if (p === "/rest/v1/conversations" && req.method === "GET") {
      return jsonResponse(200, db.conversation ? [db.conversation] : []);
    }
    if (p === "/rest/v1/conversations" && req.method === "POST") {
      db.conversationInserts++;
      db.conversation = { id: "conv-1", deleted_at: null };
      return jsonResponse(201, { id: "conv-1" });
    }
    if (p === "/rest/v1/conversations" && req.method === "PATCH") {
      db.conversationPatches.push(body);
      return emptyResponse(200);
    }
    if (p === "/rest/v1/messages" && req.method === "GET") {
      const ext = val(sp.get("external_id"));
      const found = db.messages.find((m) => m.external_id === ext);
      return jsonResponse(200, found ? [{ id: found.id }] : []);
    }
    if (p === "/rest/v1/messages" && req.method === "POST") {
      const id = `msg-${db.messages.length + 1}`;
      db.messages.push({ ...body, id });
      return jsonResponse(201, { id });
    }
    if (p === "/rest/v1/nurture_enrollments" && req.method === "PATCH") return jsonResponse(200, []);
    if (p === "/rest/v1/messaging_phone_suppressions" && req.method === "GET") {
      db.suppressionChecks++;
      return jsonResponse(200, []);
    }
    if (p === "/rest/v1/rpc/enqueue_ai_response_job") {
      return jsonResponse(200, [{ job_id: "job-1", should_dispatch: true }]);
    }
    if (p === "/rest/v1/tenant_ai_features") return jsonResponse(200, { enabled: false });
    if (p === "/rest/v1/job_queue" && req.method === "PATCH") return emptyResponse(200);
    if (p === "/functions/v1/ai-respond") {
      db.aiCalls++;
      return jsonResponse(200, { ok: true });
    }
    if (p === "/rest/v1/system_events" && req.method === "POST") {
      db.systemEvents.push(body);
      return jsonResponse(201, []);
    }
    return undefined;
  };
}

function mcReq(
  body: unknown,
  opts: { token?: string | null; secret?: string | null; channelId?: string; raw?: string } = {},
): Request {
  const token = opts.token === undefined ? TOKEN : opts.token;
  const url = `http://fn.local/functions/v1/messaging-webhook/${SLUG}/${opts.channelId ?? CHANNEL_ID}${
    token ? `?token=${token}` : ""
  }`;
  const headers: Record<string, string> = { "content-type": "application/json" };
  const secret = opts.secret === undefined ? SECRET : opts.secret;
  if (secret) headers["x-webhook-secret"] = secret;
  return new Request(url, { method: "POST", headers, body: opts.raw ?? JSON.stringify(body) });
}

const PAYLOAD = {
  subscriber_id: SUB,
  channel: "whatsapp",
  text: "Quero saber o preço",
  first_name: "Ana",
  last_name: "Souza",
  occurred_at: "2026-09-29T10:00:00Z",
};

async function run(db: Db, req: Request): Promise<Response> {
  const uninstall = installFetchMock(router(db));
  try {
    const res = await handler(req);
    await res.text().catch(() => "");
    return res;
  } finally {
    uninstall();
  }
}

Deno.test("ManyChat webhook — autenticação fail-closed", async (t) => {
  const cases: Array<[string, Parameters<typeof mcReq>[1], number]> = [
    ["token ausente", { token: null }, 401],
    ["token errado", { token: "outro" }, 401],
    ["secret ausente", { secret: null }, 401],
    ["secret errado", { secret: "errado" }, 401],
    ["channel_id errado", { channelId: "99999999-2222-4333-8444-555555555555" }, 401],
  ];
  for (const [name, opts, status] of cases) {
    await t.step(name, async () => {
      const db = newDb();
      const res = await run(db, mcReq(PAYLOAD, opts));
      assertEquals(res.status, status);
      assertEquals(db.messages.length, 0);
      assertEquals(db.channelPatches.length, 0, "saúde não muda antes da autenticação");
    });
  }
  await t.step("canal sem webhook_secret gravado rejeita", async () => {
    const db = newDb();
    db.secrets = [{ key: "api_key", value: "mc-key" }];
    assertEquals((await run(db, mcReq(PAYLOAD))).status, 401);
  });
});

Deno.test("ManyChat webhook — payload inválido", async (t) => {
  await t.step("JSON quebrado → 400", async () => {
    const db = newDb();
    assertEquals((await run(db, mcReq(null, { raw: "{nope" }))).status, 400);
  });
  await t.step("subscriber_id ausente → 422 e nada gravado", async () => {
    const db = newDb();
    const res = await run(db, mcReq({ text: "oi", event_id: "e1" }));
    assertEquals(res.status, 422);
    assertEquals(db.messages.length, 0);
    assertEquals(db.channelPatches.length, 0);
  });
  await t.step("corpo acima de 64 KB → 413", async () => {
    const db = newDb();
    const res = await run(db, mcReq({ ...PAYLOAD, text: "x".repeat(70_000) }));
    assertEquals(res.status, 413);
  });
});

Deno.test("ManyChat webhook — mensagem válida vira contato, conversa, mensagem e IA", async () => {
  const db = newDb();
  const res = await run(db, mcReq(PAYLOAD));
  assertEquals(res.status, 200);
  assertEquals(db.contacts.length, 1);
  assertEquals(db.contacts[0].phone, null, "subscriber_id não vira telefone");
  assertEquals(db.contacts[0].name, "Ana Souza");
  const identity = db.identities.find((i) => i.identity_type === "provider_user");
  if (!identity) throw new Error("identidade provider_user não criada");
  assertEquals(identity.provider_slug, SLUG);
  assertEquals(identity.normalized_value, SUB);
  assertEquals(db.conversationInserts, 1);
  assertEquals(db.messages.length, 1);
  assertEquals(db.messages[0].content, "Quero saber o preço");
  assertEquals(db.messages[0].direction, "in");
  assertEquals(db.messages[0].sender, "contact");
  assert(String(db.messages[0].external_id).startsWith("manychat:whatsapp:"));
  assert(db.channelPatches.some((p) => p.webhook_health === "ok"));
  assertEquals(db.aiCalls, 1, "IA disparada");
  assertEquals(db.suppressionChecks, 0, "sem telefone real não consulta supressão");
});

Deno.test("ManyChat webhook — idempotência", async (t) => {
  await t.step("retry do mesmo request não duplica", async () => {
    const db = newDb();
    assertEquals((await run(db, mcReq(PAYLOAD))).status, 200);
    assertEquals((await run(db, mcReq(PAYLOAD))).status, 200);
    assertEquals(db.messages.length, 1);
    assertEquals(db.aiCalls, 1);
  });
  await t.step("mesmo texto em outro momento vira outra mensagem", async () => {
    const db = newDb();
    await run(db, mcReq(PAYLOAD));
    await run(db, mcReq({ ...PAYLOAD, occurred_at: "2026-09-29T10:07:00Z" }));
    assertEquals(db.messages.length, 2);
    assertEquals(db.conversationInserts, 1, "conversa reaproveitada");
  });
});

Deno.test("ManyChat webhook — resolução de contato", async (t) => {
  await t.step("subscriber_id já conhecido reaproveita o contato", async () => {
    const db = newDb();
    db.contacts.push({ id: "c-old", phone: null, email: null, name: "Ana" });
    db.identities.push({ contact_id: "c-old", identity_type: "provider_user", provider_slug: SLUG, normalized_value: SUB });
    await run(db, mcReq(PAYLOAD));
    assertEquals(db.contacts.length, 1);
  });
  await t.step("contato existente pelo telefone ganha o subscriber_id sem duplicar", async () => {
    const db = newDb();
    db.contacts.push({ id: "c-phone", phone: "+5511988887777", email: null, name: "Ana" });
    await run(db, mcReq({ ...PAYLOAD, phone: "+55 11 98888-7777" }));
    assertEquals(db.contacts.length, 1);
    const identity = db.identities.find((i) => i.identity_type === "provider_user");
    assertEquals(identity?.contact_id, "c-phone");
    assert(db.suppressionChecks > 0, "telefone real passa pela supressão");
  });
  await t.step("conversa soft-deletada ressuscita", async () => {
    const db = newDb();
    db.conversation = { id: "conv-1", deleted_at: "2026-09-01T00:00:00Z" };
    await run(db, mcReq(PAYLOAD));
    assert(db.conversationPatches.some((p) => p.deleted_at === null));
  });
});

Deno.test("ManyChat webhook — falha interna mantém retry e não vaza PII/segredo", async () => {
  const db = newDb();
  db.failClaim = true;
  const res = await run(db, mcReq({ ...PAYLOAD, phone: "+5511988887777", email: "ana@x.com" }));
  assertEquals(res.status, 503);
  const dump = JSON.stringify(db.systemEvents);
  assert(!dump.includes(SECRET));
  assert(!dump.includes("988887777"));
  assert(!dump.includes("ana@x.com"));
  assert(!dump.includes("Quero saber o preço"), "conteúdo da conversa fora da telemetria");
});
