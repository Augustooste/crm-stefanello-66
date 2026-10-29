// ManyChat: client HTTP (contrato do Swagger oficial) + normalizador inbound.
import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1";
import { type FetchMatcher, installFetchMock, jsonResponse } from "./_helpers.ts";
import {
  buildSendContentBody,
  MANYCHAT_MESSAGES,
  parseManyChatError,
  sendManyChatText,
  splitManyChatText,
  validateManyChatCredentials,
} from "../_shared/messaging/manychat-client.ts";
import { normalizeManyChatInbound } from "../_shared/messaging/manychat-inbound.ts";

const SEND_URL = "https://api.manychat.com/fb/sending/sendContent";
const INFO_URL = "https://api.manychat.com/fb/page/getInfo";
// 17 dígitos: acima de Number.MAX_SAFE_INTEGER.
const BIG_ID = "12345678901234567";

async function withFetch<T>(matcher: FetchMatcher, fn: () => Promise<T>): Promise<T> {
  const uninstall = installFetchMock(matcher);
  try {
    return await fn();
  } finally {
    uninstall();
  }
}

function send(surface: "whatsapp" | "instagram" | "messenger" = "whatsapp") {
  return sendManyChatText({ apiKey: "mc-key", subscriberId: BIG_ID, surface, text: "Olá!" });
}

Deno.test("sendManyChatText — request no contrato do Swagger", async () => {
  const seen: Array<{ auth: string | null; ct: string | null; body: string }> = [];
  const result = await withFetch((req) => {
    if (req.url === SEND_URL && req.method === "POST") {
      seen.push({
        auth: req.headers.get("authorization"),
        ct: req.headers.get("content-type"),
        body: req.bodyText,
      });
      return jsonResponse(200, { status: "success" });
    }
    return undefined;
  }, () => send("instagram"));
  assertEquals(result, { ok: true, external_id: null });
  assertEquals(seen.length, 1);
  const s = seen[0];
  assertEquals(s.auth, "Bearer mc-key");
  assertEquals(s.ct, "application/json");
  // ID de 17 dígitos sai byte a byte, como literal numérico.
  assert(s.body.startsWith(`{"subscriber_id":${BIG_ID},`), s.body);
  const parsed = JSON.parse(s.body) as { data: { version: string; content: { type?: string; messages: unknown[] } } };
  assertEquals(parsed.data.version, "v2");
  assertEquals(parsed.data.content.type, "instagram");
  assertEquals(parsed.data.content.messages, [{ type: "text", text: "Olá!" }]);
  assert(!s.body.includes("message_tag"), "nunca envia message_tag");
});

Deno.test("buildSendContentBody — Messenger omite content.type", () => {
  const body = JSON.parse(buildSendContentBody("42", "messenger", ["oi"])) as {
    data: { content: Record<string, unknown> };
  };
  assertEquals("type" in body.data.content, false);
});

Deno.test("sendManyChatText — erros HTTP mapeados", async (t) => {
  const cases: Array<[number, unknown, string, boolean]> = [
    [400, { status: "error", message: "x", code: 3011 }, MANYCHAT_MESSAGES.window24h, false],
    [400, { status: "error", message: "x", code: 3042 }, MANYCHAT_MESSAGES.channelRefused, false],
    [401, { status: "error", message: "unauthorized" }, MANYCHAT_MESSAGES.invalidKey, false],
    [403, { status: "error", message: "forbidden" }, MANYCHAT_MESSAGES.invalidKey, false],
    [404, { status: "error", message: "not found" }, MANYCHAT_MESSAGES.subscriberNotFound, false],
    [422, { status: "error", message: "bad" }, MANYCHAT_MESSAGES.refused, false],
    [500, { status: "error", message: "boom" }, MANYCHAT_MESSAGES.unavailable, true],
  ];
  for (const [status, body, error, retryable] of cases) {
    await t.step(`HTTP ${status}`, async () => {
      const r = await withFetch(() => jsonResponse(status, body), () => send());
      assertEquals(r.ok, false);
      if (!r.ok) {
        assertEquals(r.error, error);
        assertEquals(r.retryable ?? false, retryable);
      }
    });
  }
  await t.step("HTTP 429 usa Retry-After e é retryable", async () => {
    const r = await withFetch(
      () => jsonResponse(429, { status: "error", message: "rate" }, { "retry-after": "7" }),
      () => send(),
    );
    assertEquals(r, { ok: false, error: `${MANYCHAT_MESSAGES.rateLimited} Nova tentativa em 7s.`, retryable: true });
  });
  await t.step("200 com status=error não é sucesso", async () => {
    const r = await withFetch(() => jsonResponse(200, { status: "error", message: "?" }), () => send());
    assertEquals(r.ok, false);
  });
  await t.step("200 com JSON inválido não é sucesso", async () => {
    const r = await withFetch(() => new Response("<html>", { status: 200 }), () => send());
    assertEquals(r.ok, false);
  });
});

Deno.test("sendManyChatText — rede e timeout propagam como exceção", async () => {
  await withFetch(() => Promise.reject(new TypeError("error sending request: connection refused")), async () => {
    await assertRejects(() => send());
  });
  await withFetch(() => Promise.reject(new DOMException("Signal timed out.", "TimeoutError")), async () => {
    await assertRejects(() => send());
  });
});

Deno.test("sendManyChatText — recusa sem chamar a API", async () => {
  const r1 = await withFetch(() => undefined, () =>
    sendManyChatText({ apiKey: "k", subscriberId: "+5511999", surface: "whatsapp", text: "oi" }));
  assertEquals(r1, { ok: false, error: MANYCHAT_MESSAGES.invalidSubscriber });
  const r2 = await withFetch(() => undefined, () =>
    sendManyChatText({ apiKey: "", subscriberId: "1", surface: "whatsapp", text: "oi" }));
  assertEquals(r2, { ok: false, error: MANYCHAT_MESSAGES.missingKey });
});

Deno.test("splitManyChatText — respeita limite do Instagram", () => {
  const parts = splitManyChatText(`${"a ".repeat(700)}fim`, "instagram");
  assert(parts.length === 2);
  assert(parts.every((p) => p.length <= 1000));
});

Deno.test("parseManyChatError — Retry-After ausente", () => {
  assertEquals(parseManyChatError(429, ""), { error: MANYCHAT_MESSAGES.rateLimited, retryable: true });
});

Deno.test("validateManyChatCredentials", async (t) => {
  await t.step("200 success devolve página", async () => {
    let auth: string | null = null;
    const r = await withFetch((req) => {
      if (req.url === INFO_URL && req.method === "GET") {
        auth = req.headers.get("authorization");
        return jsonResponse(200, { status: "success", data: { id: 123, name: "Loja" } });
      }
      return undefined;
    }, () => validateManyChatCredentials(" mc-key "));
    assertEquals(r, { ok: true, page: { id: "123", name: "Loja" } });
    assertEquals(auth, "Bearer mc-key");
  });
  await t.step("401 = chave inválida", async () => {
    const r = await withFetch(() => jsonResponse(401, { status: "error" }), () => validateManyChatCredentials("x"));
    assertEquals(r, { ok: false, error: MANYCHAT_MESSAGES.invalidKey });
  });
  await t.step("429 = rate limit", async () => {
    const r = await withFetch(() => jsonResponse(429, {}), () => validateManyChatCredentials("x"));
    assertEquals(r, { ok: false, error: MANYCHAT_MESSAGES.rateLimited });
  });
  await t.step("5xx = indisponível", async () => {
    const r = await withFetch(() => jsonResponse(503, {}), () => validateManyChatCredentials("x"));
    assertEquals(r, { ok: false, error: MANYCHAT_MESSAGES.unavailable });
  });
  await t.step("timeout = erro de rede amigável", async () => {
    const r = await withFetch(
      () => Promise.reject(new DOMException("Signal timed out.", "TimeoutError")),
      () => validateManyChatCredentials("x"),
    );
    assertEquals(r, { ok: false, error: MANYCHAT_MESSAGES.network });
  });
});

// -------------------- normalizador --------------------

Deno.test("normalizeManyChatInbound — campos planos", async () => {
  const r = await normalizeManyChatInbound({
    subscriber_id: BIG_ID,
    event_id: "evt-1",
    channel: "whatsapp",
    text: "Quero um orçamento",
    first_name: "Ana",
    last_name: "Silva",
    phone: "+55 (11) 98888-7777",
    email: "Ana@Example.com",
    occurred_at: "2026-09-29T10:00:00Z",
    extra: "ignorado",
  }, "manychat-whatsapp");
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.message.provider, "manychat-whatsapp");
  assertEquals(r.message.from, BIG_ID);
  assertEquals(r.message.external_id, `manychat:whatsapp:${BIG_ID}:evt-1`);
  assertEquals(r.message.content, "Quero um orçamento");
  assertEquals(r.message.senderName, "Ana Silva");
  assertEquals(r.message.contactPhone, "+5511988887777");
  assertEquals(r.message.contactEmail, "ana@example.com");
  assertEquals(r.message.timestamp, "2026-09-29T10:00:00.000Z");
  assertEquals(r.message.fromMe, false);
  assertEquals(r.eventType, "message.received");
});

Deno.test("normalizeManyChatInbound — Full Contact Data preserva ID de 17 dígitos via key", async () => {
  const raw = `{"contact":{"id":${BIG_ID},"key":"user:${BIG_ID}","name":"Bia","last_input_text":"oi","last_interaction":"2026-09-29T10:00:00+00:00"}}`;
  const r = await normalizeManyChatInbound(JSON.parse(raw), "manychat-instagram");
  assert(r.ok);
  if (!r.ok) return;
  assertEquals(r.message.from, BIG_ID);
  assertEquals(r.message.content, "oi");
  assertEquals(r.message.senderName, "Bia");
  assert(r.message.external_id.startsWith("manychat:instagram:"));
});

Deno.test("normalizeManyChatInbound — Instagram/Messenger não confiam em telefone/e-mail", async () => {
  for (const slug of ["manychat-instagram", "manychat-messenger"] as const) {
    const r = await normalizeManyChatInbound(
      { subscriber_id: "1", event_id: "e", phone: "+5511988887777", email: "a@b.com" },
      slug,
    );
    assert(r.ok);
    if (!r.ok) continue;
    assertEquals(r.message.contactPhone, undefined);
    assertEquals(r.message.contactEmail, undefined);
  }
});

Deno.test("normalizeManyChatInbound — idempotência sem event_id", async () => {
  const base = { subscriber_id: "99", text: "sim", occurred_at: "2026-09-29T10:00:00Z" };
  const a = await normalizeManyChatInbound(base, "manychat-messenger");
  const retry = await normalizeManyChatInbound({ ...base }, "manychat-messenger");
  const later = await normalizeManyChatInbound(
    { ...base, occurred_at: "2026-09-29T10:05:00Z" },
    "manychat-messenger",
  );
  assert(a.ok && retry.ok && later.ok);
  if (!a.ok || !retry.ok || !later.ok) return;
  assertEquals(a.message.external_id, retry.message.external_id, "retry = mesma chave");
  assert(a.message.external_id !== later.message.external_id, "mesmo texto, outro momento = outra chave");
});

Deno.test("normalizeManyChatInbound — rejeições", async (t) => {
  const cases: Array<[string, unknown, string]> = [
    ["payload não-objeto", [], "invalid_payload"],
    ["subscriber_id ausente", { text: "oi", event_id: "e" }, "missing_subscriber_id"],
    ["subscriber_id não numérico", { subscriber_id: "abc", event_id: "e" }, "invalid_subscriber_id"],
    ["subscriber_id número sem precisão", { subscriber_id: 12345678901234567, event_id: "e" }, "missing_subscriber_id"],
    ["sem event_id nem occurred_at", { subscriber_id: "1", text: "oi" }, "missing_idempotency_key"],
    ["occurred_at inválido", { subscriber_id: "1", occurred_at: "ontem" }, "invalid_occurred_at"],
    ["canal divergente", { subscriber_id: "1", event_id: "e", channel: "instagram" }, "channel_mismatch"],
  ];
  for (const [name, payload, code] of cases) {
    await t.step(name, async () => {
      const r = await normalizeManyChatInbound(payload, "manychat-whatsapp");
      assertEquals(r.ok, false);
      if (!r.ok) assertEquals(r.code, code);
    });
  }
});

Deno.test("normalizeManyChatInbound — texto vazio vira marcador", async () => {
  const r = await normalizeManyChatInbound({ subscriber_id: "1", event_id: "e" }, "manychat-whatsapp");
  assert(r.ok);
  if (r.ok) assertEquals(r.message.content, "[interação no ManyChat sem texto]");
});
