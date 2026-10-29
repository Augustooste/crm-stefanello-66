import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  createEvolutionAdapter,
  createMetaCloudAdapter,
} from "../_shared/messaging/channel-adapter.ts";
import {
  normalizeEvolutionInbound,
  normalizeMetaCloudInbound,
  normalizeWhatsAppOutbound,
} from "../_shared/messaging/normalizers.ts";
import type { EvolutionInboundPayload } from "../_shared/messaging/evolution-client.ts";

Deno.test("normalizes Meta Cloud text into the canonical inbound contract", () => {
  const result = normalizeMetaCloudInbound({
    entry: [{
      changes: [{
        value: {
          metadata: { display_phone_number: "+55 (11) 3000-4000" },
          contacts: [{ profile: { name: "Ada" } }],
          messages: [{
            id: "wamid.1",
            from: "5511987654321",
            timestamp: "1700000000",
            type: "text",
            text: { body: "Olá" },
          }],
        },
      }],
    }],
  });
  assertEquals(result, {
    provider: "meta-cloud",
    external_id: "wamid.1",
    from: "+5511987654321",
    to: "+551130004000",
    content: "Olá",
    timestamp: "2023-11-14T22:13:20.000Z",
    fromMe: false,
    senderName: "Ada",
  });
});

Deno.test("ignores Meta Cloud delivery status payloads", () => {
  assertEquals(
    normalizeMetaCloudInbound({
      entry: [{ changes: [{ value: { statuses: [{}] } }] }],
    }),
    null,
  );
});

Deno.test("normalizes Meta Cloud audio with a durable media reference", () => {
  const result = normalizeMetaCloudInbound({
    entry: [{
      changes: [{
        value: {
          metadata: { display_phone_number: "551130004000" },
          messages: [{
            id: "wamid.audio.1",
            from: "5511987654321",
            timestamp: "1700000000",
            type: "audio",
            audio: {
              id: "987654321",
              mime_type: "audio/ogg; codecs=opus",
              voice: true,
            },
          }],
        },
      }],
    }],
  });

  assertEquals(result?.media, {
    url: "meta-media:987654321",
    type: "audio/ogg; codecs=opus",
  });
  assertEquals(result?.content, "[audio recebida — abra no WhatsApp para ver]");
});

Deno.test("normalizes Evolution outbound and inbound messages", async () => {
  const payload: EvolutionInboundPayload = {
    event: "Message",
    instanceId: "i1",
    instanceName: "main",
    instanceToken: "secret",
    data: {
      Info: {
        ID: "evo-1",
        IsFromMe: false,
        IsGroup: false,
        Chat: "5511987654321@s.whatsapp.net",
        Sender: "5511987654321@s.whatsapp.net",
        PushName: "Grace",
        Timestamp: "2026-07-19T12:00:00.000Z",
        Type: "text",
      },
      Message: { conversation: "Oi" },
    },
  };
  assertEquals(normalizeEvolutionInbound(payload)?.from, "+5511987654321");

  let delegated: unknown;
  const adapter = createEvolutionAdapter((destination, content) => {
    delegated = { destination, content };
    return Promise.resolve({ ok: true, external_id: "sent-1" });
  });
  assertEquals(
    await adapter.send({
      destination: "+55 (11) 98765-4321",
      content: "sem trim ",
    }),
    {
      ok: true,
      external_id: "sent-1",
    },
  );
  assertEquals(delegated, {
    destination: "+5511987654321",
    content: "sem trim ",
  });
});

Deno.test("adapter exposes capabilities and rejects an invalid destination without delegation", async () => {
  let calls = 0;
  const adapter = createMetaCloudAdapter(() => {
    calls++;
    return Promise.resolve({ ok: true, external_id: null });
  });
  assertEquals(adapter.capabilities.templates, false);
  assertEquals(await adapter.send({ destination: "invalid", content: "x" }), {
    ok: false,
    error: "Número do contato inválido.",
  });
  assertEquals(calls, 0);
  assertEquals(normalizeWhatsAppOutbound("5511 9999-0000", " x "), {
    destination: "+551199990000",
    content: " x ",
  });
});
