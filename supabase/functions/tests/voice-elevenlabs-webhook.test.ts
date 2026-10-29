// Webhook pós-chamada da ElevenLabs no voice-call-webhook: assinatura
// (t=,v0= sobre "<t>.<corpo cru>", como o SDK oficial), janela de 30 min,
// segredo do tenant da ligação, event_id igual ao do poller e falha de
// discagem. Sem rede e sem banco: dependências falsas.
import { assertEquals } from "jsr:@std/assert@1";
import { handleElevenLabsWebhook } from "../_shared/voice/elevenlabs-webhook.ts";
import { hmacHex, type VoiceEvent } from "../_shared/voice/contract.ts";
import { conversationToEvents } from "../_shared/voice/elevenlabs.ts";

const SECRET = "wsec_teste";
const NOW = 1_790_000_000;
const CALL = {
  id: "33333333-3333-4333-8333-333333333333",
  tenant_id: "11111111-1111-4111-8111-111111111111",
  provider_call_id: "conv_abc",
};
const DONE = {
  type: "post_call_transcription",
  event_timestamp: NOW,
  data: {
    agent_id: "agent_x",
    conversation_id: "conv_abc",
    status: "done",
    metadata: { start_time_unix_secs: NOW - 60, call_duration_secs: 57 },
    transcript: [
      { role: "agent", message: "Oi, Felipe?" },
      { role: "user", message: "Amanhã às 14h." },
    ],
    analysis: {
      transcript_summary: "Pediu retorno.",
      data_collection_results: {
        outcome: { value: "callback_requested" },
        callback_at: { value: "2026-09-29T14:00:00-03:00" },
      },
    },
  },
};

async function send(
  body: unknown,
  opts: {
    secret?: string;
    t?: number;
    header?: string;
    known?: boolean;
    tenantSecret?: string | null;
  } = {},
) {
  const raw = JSON.stringify(body);
  const t = opts.t ?? NOW;
  const header = opts.header ??
    `t=${t},v0=${await hmacHex(opts.secret ?? SECRET, `${t}.${raw}`)}`;
  const applied: VoiceEvent[] = [];
  const res = await handleElevenLabsWebhook(
    new Request("https://x/voice-call-webhook", {
      method: "POST",
      headers: { "elevenlabs-signature": header },
      body: raw,
    }),
    {
      findCall: (id) =>
        Promise.resolve(opts.known === false || id !== CALL.provider_call_id ? null : CALL),
      loadSecret: () =>
        Promise.resolve(opts.tenantSecret === undefined ? SECRET : opts.tenantSecret),
      applyEvent: (e) => {
        applied.push(e);
        return Promise.resolve({ result: "applied" });
      },
      nowMs: () => NOW * 1000,
    },
  );
  return { status: res.status, body: await res.json(), applied };
}

Deno.test("ElevenLabs webhook", async (t) => {
  await t.step("assinado certo: mesmos eventos (e ids) que o poller", async () => {
    const r = await send(DONE);
    assertEquals(r.status, 200);
    const poller = conversationToEvents(DONE.data as never, {
      callId: CALL.id,
      tenantId: CALL.tenant_id,
      conversationId: CALL.provider_call_id,
    });
    assertEquals(r.applied.map((e) => e.event_id), poller.map((e) => e.event_id));
    assertEquals(r.applied[1].data?.callback_at, "2026-09-29T14:00:00-03:00");
  });

  await t.step("assinatura com outro segredo: 401 e nada gravado", async () => {
    const r = await send(DONE, { secret: "outro" });
    assertEquals([r.status, r.applied.length], [401, 0]);
  });

  await t.step("corpo alterado depois de assinar: 401", async () => {
    const raw = JSON.stringify(DONE);
    const sig = await hmacHex(SECRET, `${NOW}.${raw}`);
    const tampered = { ...DONE, data: { ...DONE.data, status: "failed" } };
    const r = await send(tampered, { header: `t=${NOW},v0=${sig}` });
    assertEquals([r.status, r.applied.length], [401, 0]);
  });

  await t.step("sem cabeçalho válido ou fora da janela de 30 min: 401", async () => {
    assertEquals((await send(DONE, { header: "v0=abc" })).status, 401);
    assertEquals((await send(DONE, { t: NOW - 31 * 60 })).status, 401);
  });

  await t.step("conversa que não é do CRM: 200 sem efeito (não derruba o webhook)", async () => {
    const r = await send(DONE, { known: false });
    assertEquals([r.status, r.body.result, r.applied.length], [200, "unknown_conversation", 0]);
  });

  await t.step("tenant sem segredo configurado: 404 e nada gravado", async () => {
    const r = await send(DONE, { tenantSecret: null });
    assertEquals([r.status, r.applied.length], [404, 0]);
  });

  await t.step("falha de discagem vira call.failed com o id do poller", async () => {
    const r = await send({
      type: "call_initiation_failure",
      event_timestamp: NOW,
      data: { agent_id: "agent_x", conversation_id: "conv_abc", failure_reason: "no-answer" },
    });
    assertEquals(r.status, 200);
    assertEquals(r.applied[0].event_id, "el-conv_abc-failed");
    assertEquals(r.applied[0].data?.reason, "no_answer");
  });

  await t.step("tipo sem interesse (áudio): 200 ignorado", async () => {
    const r = await send({ type: "post_call_audio", data: { conversation_id: "conv_abc" } });
    assertEquals([r.status, r.body.result, r.applied.length], [200, "ignored_type", 0]);
  });
});
