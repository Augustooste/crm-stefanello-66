// Ligações IA via ElevenLabs: payload do outbound-call, classificação de
// resposta (aceita / recusada / incerta), mapeamento conversa -> eventos v1,
// poller (duplicado não reaplica, erro isolado) e resolução por tenant.
// Nenhuma ligação real: fetch mockado.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { installFetchMock, jsonResponse } from "./_helpers.ts";
import {
  conversationToEvents,
  dynamicVariables,
  type ElevenLabsConversation,
  ElevenLabsVoiceProvider,
} from "../_shared/voice/elevenlabs.ts";
import { pollElevenLabsCalls } from "../_shared/voice/poller.ts";
import { resolveProviderForTenant } from "../_shared/voice/provider.ts";
import { type CallsDeps, handleVoiceCalls } from "../_shared/voice/handlers.ts";
import type { CreateCallRequest, VoiceEvent } from "../_shared/voice/contract.ts";

const OUTBOUND = "https://api.elevenlabs.io/v1/convai/twilio/outbound-call";
const CONV = "conv_123";
const REF = {
  callId: "33333333-3333-4333-8333-333333333333",
  tenantId: "t1",
  conversationId: CONV,
};
const CFG = { apiKey: "xi-secret-key", agentId: "agent_x", phoneNumberId: "phnum_x" };

const REQ: CreateCallRequest = {
  call_id: REF.callId,
  tenant_id: "t1",
  contact_id: "c1",
  phone: "+5545999999999",
  agent_ref: "default",
  context: {
    contact: { first_name: "Ana" },
    deal: { title: "Plano anual", stage: "Qualificação" },
    objective: "Reativar o plano",
    recent_messages: [{ from: "contact", text: "Tenho interesse", at: "2026-09-28T10:00:00Z" }],
  },
  callback_url: "https://x/functions/v1/voice-call-webhook",
  idempotency_key: "chave-0001",
};

Deno.test("ElevenLabs createCall", async (t) => {
  await t.step("envia agente, número, destino e só o contexto mínimo", async () => {
    let sent: { headers: Headers; body: Record<string, unknown> } | null = null;
    const uninstall = installFetchMock((req) => {
      if (req.url !== OUTBOUND) return undefined;
      sent = { headers: req.headers, body: req.bodyJson as Record<string, unknown> };
      return jsonResponse(200, {
        success: true,
        message: "ok",
        conversation_id: CONV,
        callSid: "CA1",
      });
    });
    try {
      const r = await new ElevenLabsVoiceProvider(CFG).createCall(REQ);
      assertEquals(r, {
        kind: "accepted",
        provider: "elevenlabs",
        providerCallId: CONV,
        simulation: false,
      });
      const s = sent as unknown as { headers: Headers; body: Record<string, unknown> };
      assertEquals(s.headers.get("xi-api-key"), CFG.apiKey);
      assertEquals(s.body.agent_id, "agent_x");
      assertEquals(s.body.agent_phone_number_id, "phnum_x");
      assertEquals(s.body.to_number, "+5545999999999");
      assertEquals(s.body.conversation_initiation_client_data, {
        dynamic_variables: dynamicVariables(REQ.context),
      });
      assertEquals(
        Object.keys(dynamicVariables(REQ.context)).sort(),
        ["deal_stage", "deal_title", "first_name", "objective", "recent_messages"],
      );
    } finally {
      uninstall();
    }
  });

  const cases: Array<[string, () => Response, string]> = [
    ["HTTP 422 = recusada", () => jsonResponse(422, { detail: [] }), "rejected"],
    [
      "200 com success=false = recusada",
      () => jsonResponse(200, { success: false, message: "sem saldo" }),
      "rejected",
    ],
    ["HTTP 503 = incerta", () => jsonResponse(503, {}), "uncertain"],
    [
      "success sem conversation_id = incerta",
      () => jsonResponse(200, { success: true, conversation_id: null }),
      "uncertain",
    ],
  ];
  for (const [name, res, kind] of cases) {
    await t.step(name, async () => {
      const uninstall = installFetchMock((req) => (req.url === OUTBOUND ? res() : undefined));
      try {
        assertEquals((await new ElevenLabsVoiceProvider(CFG).createCall(REQ)).kind, kind);
      } finally {
        uninstall();
      }
    });
  }

  await t.step("timeout = incerta, uma única tentativa, chave fora do erro", async () => {
    let calls = 0;
    const uninstall = installFetchMock((req) => {
      if (req.url !== OUTBOUND) return undefined;
      calls++;
      throw new DOMException("Signal timed out.", "TimeoutError");
    });
    try {
      const r = await new ElevenLabsVoiceProvider(CFG).createCall(REQ);
      assertEquals(r.kind, "uncertain");
      assertEquals(calls, 1);
      assert(!JSON.stringify(r).includes(CFG.apiKey));
    } finally {
      uninstall();
    }
  });
});

Deno.test("conversationToEvents", async (t) => {
  const done: ElevenLabsConversation = {
    status: "done",
    metadata: { start_time_unix_secs: 1790000000, call_duration_secs: 95 },
    transcript: [
      { role: "agent", message: "Oi Ana!", time_in_call_secs: 0 },
      { role: "user", message: "Oi, pode falar", time_in_call_secs: 2 },
    ],
    analysis: {
      transcript_summary: "Lead quer proposta.",
      data_collection_results: { outcome: { value: "interested" } },
    },
  };

  await t.step("done com conversa: completed + transcript + summary, ids estáveis", () => {
    const ev = conversationToEvents(done, REF);
    assertEquals(ev.map((e) => e.type), [
      "call.answered",
      "call.completed",
      "call.transcript.updated",
      "call.summary.ready",
    ]);
    assertEquals(ev[1].data, { duration_seconds: 95, outcome: "interested" });
    assertEquals(ev[2].data?.transcript, "Agente: Oi Ana!\nLead: Oi, pode falar");
    assertEquals(ev.map((e) => e.event_id), conversationToEvents(done, REF).map((e) => e.event_id));
  });

  await t.step("resultado fora da lista vira no_decision (não usa call_successful)", () => {
    const ev = conversationToEvents(
      { ...done, analysis: { transcript_summary: "x", data_collection_results: {} } },
      REF,
    );
    assertEquals(ev[1].data?.outcome, "no_decision");
  });

  await t.step("pedido de retorno leva callback_at; data inválida é descartada", () => {
    const withCallback = (value: unknown) =>
      conversationToEvents({
        ...done,
        analysis: {
          data_collection_results: {
            outcome: { value: "callback_requested" },
            callback_at: { value },
          },
        },
      }, REF)[1].data;
    assertEquals(withCallback("2026-09-30T16:30:00-03:00")?.callback_at, "2026-09-30T16:30:00-03:00");
    assertEquals(withCallback("daqui a dois dias")?.callback_at, undefined);
    assertEquals(withCallback(null)?.callback_at, undefined);
  });

  await t.step("done sem fala do lead = não atendeu", () => {
    const ev = conversationToEvents(
      { ...done, transcript: [{ role: "agent", message: "Alô?" }] },
      REF,
    );
    assertEquals(ev.length, 1);
    assertEquals(ev[0].type, "call.failed");
    assertEquals(ev[0].data?.reason, "no_answer");
  });

  await t.step("initiated/in-progress/processing/failed", () => {
    assertEquals(conversationToEvents({ status: "initiated" }, REF)[0].type, "call.ringing");
    assertEquals(conversationToEvents({ status: "in-progress" }, REF)[0].type, "call.answered");
    assertEquals(conversationToEvents({ status: "processing" }, REF), []);
    const f = conversationToEvents({
      status: "failed",
      metadata: { termination_reason: "busy line" },
    }, REF);
    assertEquals(f[0].data?.reason, "failed");
  });
});

Deno.test("pollElevenLabsCalls", async (t) => {
  const conv = (status: string, extra: Record<string, unknown> = {}) =>
    jsonResponse(200, { status, ...extra });

  await t.step("repetir a consulta não reaplica (ledger responde duplicate)", async () => {
    const seen = new Set<string>();
    const applied: VoiceEvent[] = [];
    const uninstall = installFetchMock((req) =>
      req.url.endsWith(`/conversations/${CONV}`) ? conv("in-progress") : undefined
    );
    try {
      const deps = {
        listActiveCalls: () =>
          Promise.resolve([{ id: REF.callId, tenant_id: "t1", provider_call_id: CONV }]),
        loadApiKey: () => Promise.resolve("k"),
        applyEvent: (e: VoiceEvent) => {
          if (seen.has(e.event_id)) return Promise.resolve({ result: "duplicate" });
          seen.add(e.event_id);
          applied.push(e);
          return Promise.resolve({ result: "applied", status: "answered" });
        },
      };
      const first = await pollElevenLabsCalls(deps);
      const second = await pollElevenLabsCalls(deps);
      assertEquals(first.applied, 1);
      assertEquals(second.applied, 0);
      assertEquals(applied.length, 1);
    } finally {
      uninstall();
    }
  });

  await t.step("erro numa ligação não derruba as outras; chave não vaza", async () => {
    const uninstall = installFetchMock((req) => {
      if (req.url.endsWith("/conversations/conv_ruim")) {
        return jsonResponse(500, { detail: "xi-api-key: k-secreta" });
      }
      if (req.url.endsWith("/conversations/conv_boa")) return conv("initiated");
      return undefined;
    });
    try {
      const s = await pollElevenLabsCalls({
        listActiveCalls: () =>
          Promise.resolve([
            { id: "a", tenant_id: "t1", provider_call_id: "conv_ruim" },
            { id: "b", tenant_id: "t1", provider_call_id: "conv_boa" },
          ]),
        loadApiKey: () => Promise.resolve("k-secreta"),
        applyEvent: () => Promise.resolve({ result: "applied" }),
      });
      assertEquals(s.errors.length, 1);
      assertEquals(s.applied, 1);
      assert(!s.errors[0].includes("k-secreta"), s.errors[0]);
    } finally {
      uninstall();
    }
  });

  await t.step("sem ligação ativa: nenhuma chamada externa", async () => {
    let calls = 0;
    const uninstall = installFetchMock(() => {
      calls++;
      return undefined;
    });
    try {
      const s = await pollElevenLabsCalls({
        listActiveCalls: () => Promise.resolve([]),
        loadApiKey: () => Promise.resolve("k"),
        applyEvent: () => Promise.resolve({ result: "applied" }),
      });
      assertEquals(s.polled, 0);
      assertEquals(calls, 0);
    } finally {
      uninstall();
    }
  });
});

Deno.test("resolveProviderForTenant", async (t) => {
  const noEnv = () => undefined;
  await t.step("falta agente ou número = não configurado", async () => {
    const r = await resolveProviderForTenant(noEnv, {
      apiKey: "k",
      agentId: null,
      phoneNumberId: "p",
    });
    assertEquals(r.ok, false);
    if (!r.ok) assertStringIncludes(r.error, "não configuradas");
  });
  await t.step("tudo configurado = ElevenLabs", async () => {
    const r = await resolveProviderForTenant(noEnv, {
      apiKey: "k",
      agentId: "a",
      phoneNumberId: "p",
    });
    assert(r.ok && r.provider.name === "elevenlabs");
  });
  await t.step("VOICE_PROVIDER=mock continua sendo override", async () => {
    const r = await resolveProviderForTenant(
      (n) => (n === "VOICE_PROVIDER" ? "mock" : undefined),
      null,
    );
    assert(r.ok && r.provider.name === "mock");
  });
});

Deno.test("voice-calls: tenant da ligação diferente do tenant da credencial não disca", async () => {
  let providerCalls = 0;
  const updates: Array<Record<string, unknown>> = [];
  const deps: CallsDeps = {
    getUserId: () => Promise.resolve("u1"),
    userRpc: () =>
      Promise.resolve({
        data: {
          existing: false,
          call: {
            id: REF.callId,
            tenant_id: "tenant-B",
            contact_id: "c1",
            phone: "+5545999999999",
            agent_ref: "default",
            idempotency_key: "chave-0001",
            status: "queued",
            provider_call_id: null,
          },
          context: REQ.context,
        },
        error: null,
      }),
    updateCall: (_id, _from, patch) => {
      updates.push(patch);
      return Promise.resolve();
    },
    applyEvent: () => Promise.resolve({ result: "applied" }),
    loadProvider: () =>
      Promise.resolve({
        tenantId: "tenant-A",
        provider: {
          ok: true,
          provider: {
            name: "fake",
            createCall: () => {
              providerCalls++;
              return Promise.resolve({
                kind: "accepted",
                provider: "x",
                providerCallId: "p",
                simulation: false,
              });
            },
            cancelCall: () => Promise.resolve({ ok: true }),
            getCall: () => Promise.resolve(null),
          },
        },
      }),
    callbackUrl: "https://x",
  };
  const res = await handleVoiceCalls(
    new Request("http://local", {
      method: "POST",
      body: JSON.stringify({
        action: "create",
        contact_id: "c1",
        objective: "x",
        idempotency_key: "chave-0001",
      }),
    }),
    deps,
  );
  assertEquals(res.status, 409);
  assertEquals(providerCalls, 0);
  assertEquals(updates[0].error_code, "tenant_mismatch");
});
