import { assertEquals, assertStringIncludes } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createMultichannelAdapter,
  PROVIDER_CAPABILITY_MATRIX,
} from "../_shared/messaging/multichannel-adapters.ts";
import { normalizeDeliveryReceipt } from "../_shared/messaging/normalizers.ts";
import {
  estimateProviderCostMicros,
  routeCommunication,
  sendWithFallback,
} from "../_shared/messaging/router.ts";

Deno.test("all new providers expose explicit capabilities", () => {
  assertEquals(Object.keys(PROVIDER_CAPABILITY_MATRIX).sort(), [
    "discord",
    "email",
    "push",
    "sms",
    "telegram",
  ]);
  assertEquals(PROVIDER_CAPABILITY_MATRIX.sms.media, false);
  assertEquals(PROVIDER_CAPABILITY_MATRIX.email.templates, true);
  assertEquals(PROVIDER_CAPABILITY_MATRIX.telegram.text, true);
});

Deno.test("missing secrets use an explicit sandbox adapter and never call transport", async () => {
  let calls = 0;
  const adapter = createMultichannelAdapter("telegram", {}, {
    request: () => {
      calls++;
      return Promise.resolve(new Response("{}"));
    },
  });
  const result = await adapter.send({ destination: "chat-1", content: "Olá" });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.external_id ?? "", "sandbox:telegram:chat-1:");
  }
  assertEquals(calls, 0);
});

Deno.test("Telegram and generic providers delegate through injectable HTTP transport", async () => {
  const requests: Array<{ url: string; body: string }> = [];
  const transport = {
    request(url: string, init: RequestInit) {
      requests.push({ url, body: String(init.body) });
      return Promise.resolve(Response.json({ result: { message_id: "m-1" } }));
    },
  };
  const telegram = createMultichannelAdapter(
    "telegram",
    { bot_token: "token" },
    transport,
  );
  assertEquals(await telegram.send({ destination: "42", content: "Oi" }), {
    ok: true,
    external_id: "m-1",
  });
  assertStringIncludes(requests[0].url, "/bottoken/sendMessage");
  assertStringIncludes(requests[0].body, '"chat_id":"42"');

  const sms = createMultichannelAdapter("sms", {
    api_url: "https://sms.test/send",
    api_key: "k",
  }, transport);
  assertEquals(
    (await sms.send({ destination: "+5511", content: "SMS" })).ok,
    true,
  );
  assertEquals(requests[1].url, "https://sms.test/send");
});

Deno.test("router balances preference, engagement and bounded cost with deterministic fallback", async () => {
  const decision = routeCommunication([
    {
      provider: "whatsapp",
      destination: "wa",
      preference: 3,
      engagementScore: 0.8,
      estimatedCostMicros: 50_000,
      available: true,
    },
    {
      provider: "push",
      destination: "device",
      preference: 3,
      engagementScore: 0.9,
      estimatedCostMicros: 0,
      available: true,
    },
    {
      provider: "email",
      destination: "",
      preference: 5,
      engagementScore: 1,
      estimatedCostMicros: 0,
      available: true,
    },
  ]);
  assertEquals(decision.primary?.provider, "push");
  assertEquals(decision.fallbacks.map((item) => item.provider), ["whatsapp"]);
  const attempts: string[] = [];
  const sent = await sendWithFallback(decision, (candidate) => {
    attempts.push(candidate.provider);
    return Promise.resolve({ ok: candidate.provider === "whatsapp" });
  });
  assertEquals(attempts, ["push", "whatsapp"]);
  assertEquals(sent?.candidate.provider, "whatsapp");
  assertEquals(estimateProviderCostMicros("sms", 2), 100_000);
});

Deno.test("delivery receipts normalize to canonical states", () => {
  assertEquals(
    normalizeDeliveryReceipt("sms", {
      message_id: "sms-1",
      status: "seen",
      timestamp: "2026-07-19T12:00:00Z",
    }),
    {
      provider: "sms",
      external_id: "sms-1",
      status: "read",
      timestamp: "2026-07-19T12:00:00.000Z",
      error: undefined,
    },
  );
  assertEquals(normalizeDeliveryReceipt("push", { status: "delivered" }), null);
});
