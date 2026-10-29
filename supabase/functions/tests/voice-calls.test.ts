// Ligações IA: webhook assinado (fail-closed, replay, duplicado, tenant) e
// criação/cancelamento (idempotência, provedor indisponível, timeout, mock).
// Nenhuma ligação real: provedores falsos + fetch mockado. A máquina de estados
// em si (fora de ordem, final vence, sem mexer em funil) é testada em pgTAP:
// supabase/tests/database/voice_calls_foundation.sql.
import { assert, assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import { installFetchMock } from "./_helpers.ts";
import {
  type ApplyResult,
  type CallsDeps,
  dialablePhone,
  handleVoiceCalls,
  handleVoiceWebhook,
} from "../_shared/voice/handlers.ts";
import {
  CONTRACT_VERSION,
  parseVoiceEvent,
  SIGNATURE_HEADER,
  signPayload,
  TENANT_HEADER,
  TIMESTAMP_HEADER,
  type VoiceEvent,
} from "../_shared/voice/contract.ts";
import {
  HttpVoiceServiceProvider,
  MockVoiceProvider,
  resolveVoiceProvider,
  type VoiceProvider,
} from "../_shared/voice/provider.ts";

const SECRET = "segredo-voz-teste";
const TENANT = "11111111-1111-4111-8111-111111111111";
const OTHER_TENANT = "22222222-2222-4222-8222-222222222222";
const CALL = "33333333-3333-4333-8333-333333333333";
const NOW_MS = Date.parse("2026-09-25T20:00:00Z");

function event(overrides: Partial<VoiceEvent> = {}): VoiceEvent {
  return {
    version: CONTRACT_VERSION,
    event_id: "evt-00000001",
    type: "call.ringing",
    call_id: CALL,
    tenant_id: TENANT,
    provider_call_id: "prov-1",
    occurred_at: "2026-09-25T19:59:59Z",
    ...overrides,
  };
}

async function signedReq(
  body: unknown,
  opts: { tenant?: string; ts?: number; secret?: string; signature?: string | null } = {},
): Promise<Request> {
  const raw = JSON.stringify(body);
  const tenant = opts.tenant ?? TENANT;
  const ts = String(opts.ts ?? Math.floor(NOW_MS / 1000));
  const headers: Record<string, string> = { [TIMESTAMP_HEADER]: ts, [TENANT_HEADER]: tenant };
  if (opts.signature !== null) {
    headers[SIGNATURE_HEADER] = opts.signature ??
      await signPayload(opts.secret ?? SECRET, tenant, ts, raw);
  }
  return new Request("http://local/voice-call-webhook", { method: "POST", headers, body: raw });
}

/** Aplicador falso com dedupe por event_id (o real é apply_voice_call_event). */
function fakeApplier() {
  const seen = new Set<string>();
  const applied: VoiceEvent[] = [];
  const apply = (e: VoiceEvent): Promise<ApplyResult> => {
    if (e.call_id !== CALL || e.tenant_id !== TENANT) {
      return Promise.resolve({ result: "not_found" });
    }
    if (seen.has(e.event_id)) return Promise.resolve({ result: "duplicate" });
    seen.add(e.event_id);
    applied.push(e);
    return Promise.resolve({ result: "applied", status: "ringing" });
  };
  return { apply, applied };
}

function webhook(req: Request, apply = fakeApplier().apply, secret: string | undefined = SECRET) {
  return handleVoiceWebhook(req, { secret, applyEvent: apply, nowMs: () => NOW_MS });
}

Deno.test("voice-call-webhook", async (t) => {
  await t.step("evento assinado válido é aplicado", async () => {
    const { apply, applied } = fakeApplier();
    const res = await webhook(await signedReq(event()), apply);
    assertEquals(res.status, 200);
    assertEquals(applied.length, 1);
  });

  await t.step("sem assinatura: 401 e nada aplicado", async () => {
    const { apply, applied } = fakeApplier();
    const res = await webhook(await signedReq(event(), { signature: null }), apply);
    assertEquals(res.status, 401);
    assertEquals(applied.length, 0);
  });

  await t.step("assinatura com outro segredo: 401", async () => {
    const res = await webhook(await signedReq(event(), { secret: "outro" }));
    assertEquals(res.status, 401);
  });

  await t.step("corpo alterado depois de assinado: 401", async () => {
    const good = await signedReq(event());
    const tampered = new Request(good.url, {
      method: "POST",
      headers: good.headers,
      body: JSON.stringify(event({ type: "call.completed" })),
    });
    assertEquals((await webhook(tampered)).status, 401);
  });

  await t.step("timestamp fora da janela (replay antigo): 401", async () => {
    const res = await webhook(await signedReq(event(), { ts: Math.floor(NOW_MS / 1000) - 600 }));
    assertEquals(res.status, 401);
  });

  await t.step("segredo não configurado: fail-closed (404), nada aplicado", async () => {
    const { apply, applied } = fakeApplier();
    const res = await webhook(await signedReq(event()), apply, "");
    assertEquals(res.status, 404);
    assertEquals(applied.length, 0);
  });

  await t.step("assinado para um tenant, corpo de outro: 401", async () => {
    const res = await webhook(
      await signedReq(event({ tenant_id: OTHER_TENANT }), { tenant: TENANT }),
    );
    assertEquals(res.status, 401);
  });

  await t.step("conhecer o call_id não basta: chave de outro tenant não entra", async () => {
    // Tenant B assina corretamente com a PRÓPRIA chave, mas o call é do tenant A.
    const res = await webhook(
      await signedReq(event({ tenant_id: OTHER_TENANT }), { tenant: OTHER_TENANT }),
    );
    assertEquals(res.status, 404);
  });

  await t.step("evento duplicado: 200 sem reaplicar", async () => {
    const { apply, applied } = fakeApplier();
    assertEquals((await webhook(await signedReq(event()), apply)).status, 200);
    const again = await webhook(await signedReq(event()), apply);
    assertEquals(again.status, 200);
    assertEquals((await again.json()).result, "duplicate");
    assertEquals(applied.length, 1);
  });

  await t.step("provider_call_id divergente: 409", async () => {
    const res = await webhook(
      await signedReq(event()),
      () => Promise.resolve({ result: "mismatch" }),
    );
    assertEquals(res.status, 409);
  });

  await t.step("evento malformado assinado: 400", async () => {
    const res = await webhook(await signedReq({ ...event(), type: "call.teleport" }));
    assertEquals(res.status, 400);
  });

  await t.step("log não carrega transcript", async () => {
    const lines: string[] = [];
    const original = console.log;
    console.log = (...args: unknown[]) => lines.push(JSON.stringify(args));
    try {
      await webhook(
        await signedReq(event({
          type: "call.transcript.updated",
          sequence: 1,
          data: { transcript: "CPF 123.456.789-00" },
        })),
      );
    } finally {
      console.log = original;
    }
    assert(lines.length > 0);
    assert(!lines.join("\n").includes("123.456"), "transcript vazou no log");
  });
});

Deno.test("contrato: transcript/summary exigem sequence", () => {
  assertEquals(parseVoiceEvent(event({ type: "call.summary.ready" })), null);
  assert(parseVoiceEvent(event({ type: "call.summary.ready", sequence: 1 })));
});

Deno.test("dialablePhone: celular BR sem nono dígito ganha o 9", () => {
  assertEquals(dialablePhone("+554599022026"), "+5545999022026");
  assertEquals(dialablePhone("+5545999022026"), "+5545999022026");
  assertEquals(dialablePhone("+551150284421"), "+551150284421"); // fixo
  assertEquals(dialablePhone("+14155550100"), "+14155550100");
});

// ─── voice-calls ────────────────────────────────────────────────────────────

const CALL_ROW = {
  id: CALL,
  tenant_id: TENANT,
  contact_id: "44444444-4444-4444-8444-444444444444",
  phone: "+5511988887777",
  agent_ref: "default",
  idempotency_key: "chave-0001",
  status: "queued",
  provider_call_id: null,
};
const CONTEXT = {
  contact: { first_name: "Ana" },
  deal: null,
  objective: "Reativar",
  recent_messages: [],
};

function callsDeps(
  overrides: Partial<CallsDeps> & { providerImpl?: VoiceProvider } = {},
) {
  const updates: Array<{ from: string; patch: Record<string, unknown> }> = [];
  const events: VoiceEvent[] = [];
  const rpcCalls: string[] = [];
  const deps: CallsDeps = {
    getUserId: () => Promise.resolve("user-1"),
    userRpc: (fn) => {
      rpcCalls.push(fn);
      return Promise.resolve({
        data: { existing: false, call: CALL_ROW, context: CONTEXT },
        error: null,
      });
    },
    updateCall: (_id, from, patch) => {
      updates.push({ from, patch });
      return Promise.resolve();
    },
    applyEvent: (e) => {
      events.push(e);
      return Promise.resolve({ result: "applied", status: "completed" });
    },
    loadProvider: () =>
      Promise.resolve({
        tenantId: TENANT,
        provider: { ok: true, provider: overrides.providerImpl ?? new MockVoiceProvider() },
      }),
    callbackUrl: "https://x.supabase.co/functions/v1/voice-call-webhook",
    ...overrides,
  };
  return { deps, updates, events, rpcCalls };
}

const createReq = (body: Record<string, unknown> = {}) =>
  new Request("http://local/voice-calls", {
    method: "POST",
    body: JSON.stringify({
      action: "create",
      contact_id: CALL_ROW.contact_id,
      objective: "Reativar",
      idempotency_key: "chave-0001",
      ...body,
    }),
  });

Deno.test("voice-calls", async (t) => {
  await t.step("sem login: 401", async () => {
    const { deps } = callsDeps({ getUserId: () => Promise.resolve(null) });
    assertEquals((await handleVoiceCalls(createReq(), deps)).status, 401);
  });

  await t.step("sem provedor configurado: 503 e nenhuma linha criada", async () => {
    const { deps, rpcCalls } = callsDeps({
      loadProvider: () =>
        Promise.resolve({ tenantId: TENANT, provider: resolveVoiceProvider(() => undefined) }),
    });
    const res = await handleVoiceCalls(createReq(), deps);
    assertEquals(res.status, 503);
    assertStringIncludes((await res.json()).error, "não configuradas");
    assertEquals(rpcCalls.length, 0);
  });

  await t.step("RBAC negado no SQL vira 403", async () => {
    const { deps } = callsDeps({
      userRpc: () =>
        Promise.resolve({ data: null, error: { code: "42501", message: "Sem permissão" } }),
    });
    assertEquals((await handleVoiceCalls(createReq(), deps)).status, 403);
  });

  await t.step("mock: created → ringing → answered → completed pelo mesmo aplicador", async () => {
    const { deps, updates, events } = callsDeps();
    const res = await handleVoiceCalls(createReq(), deps);
    assertEquals(res.status, 200);
    assertEquals((await res.json()).simulation, true);
    assertEquals(updates[0].patch.provider, "mock");
    assertEquals(updates[0].patch.is_simulation, true);
    assertEquals(events.map((e) => e.type).slice(0, 4), [
      "call.created",
      "call.ringing",
      "call.answered",
      "call.completed",
    ]);
  });

  await t.step("mock no_answer simula falha sem atender", () => {
    const evs = new MockVoiceProvider("no_answer").simulateEvents({
      call_id: CALL,
      tenant_id: TENANT,
    });
    assertEquals(evs.at(-1)?.type, "call.failed");
    assertEquals(evs.at(-1)?.data?.reason, "no_answer");
    assert(!evs.some((e) => e.type === "call.answered"));
  });

  await t.step("eventos do mock passam pelo webhook real com assinatura", async () => {
    const { apply, applied } = fakeApplier();
    const evs = new MockVoiceProvider().simulateEvents(
      { call_id: CALL, tenant_id: TENANT },
      NOW_MS,
    );
    for (const e of evs) assertEquals((await webhook(await signedReq(e), apply)).status, 200);
    assertEquals(applied.length, evs.length);
  });

  await t.step(
    "mesma idempotency_key: devolve a ligação existente sem chamar o provedor",
    async () => {
      let providerCalls = 0;
      const counting: VoiceProvider = {
        name: "conta",
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
      };
      const { deps } = callsDeps({
        providerImpl: counting,
        userRpc: () =>
          Promise.resolve({
            data: { existing: true, call: { ...CALL_ROW, status: "ringing" } },
            error: null,
          }),
      });
      const res = await handleVoiceCalls(createReq(), deps);
      assertEquals(res.status, 200);
      assertEquals((await res.json()).existing, true);
      assertEquals(providerCalls, 0);
    },
  );

  await t.step("Voice Service indisponível (503): ligação vira failed", async () => {
    const uninstall = installFetchMock(() => new Response("down", { status: 503 }));
    try {
      const { deps, updates } = callsDeps({
        providerImpl: new HttpVoiceServiceProvider("https://voice.example.com", SECRET),
      });
      const res = await handleVoiceCalls(createReq(), deps);
      assertEquals(res.status, 502);
      assertEquals(updates[0].patch.status, "failed");
      assertEquals(updates[0].from, "queued");
    } finally {
      uninstall();
    }
  });

  await t.step("timeout: fica initiating com erro, 1 única requisição, sem retry", async () => {
    let requests = 0;
    const uninstall = installFetchMock(() => {
      requests++;
      throw new DOMException("Signal timed out.", "TimeoutError");
    });
    try {
      const { deps, updates } = callsDeps({
        providerImpl: new HttpVoiceServiceProvider("https://voice.example.com", SECRET),
      });
      const res = await handleVoiceCalls(createReq(), deps);
      assertEquals(res.status, 202);
      assertEquals(requests, 1);
      assertEquals(updates[0].patch.status, "initiating");
      assertEquals(updates[0].patch.error_code, "provider_uncertain");
    } finally {
      uninstall();
    }
  });

  await t.step("pedido ao Voice Service é assinado e leva só o contexto mínimo", async () => {
    let captured: { headers: Headers; body: Record<string, unknown> } | null = null;
    const uninstall = installFetchMock((req) => {
      captured = { headers: req.headers, body: req.bodyJson as Record<string, unknown> };
      return new Response(JSON.stringify({ provider: "twilio", provider_call_id: "CA123" }), {
        status: 200,
      });
    });
    try {
      const { deps, updates } = callsDeps({
        providerImpl: new HttpVoiceServiceProvider("https://voice.example.com", SECRET),
      });
      assertEquals((await handleVoiceCalls(createReq(), deps)).status, 200);
      const c = captured as unknown as { headers: Headers; body: Record<string, unknown> };
      const raw = JSON.stringify(c.body);
      const expected = await signPayload(SECRET, TENANT, c.headers.get(TIMESTAMP_HEADER)!, raw);
      assertEquals(c.headers.get(SIGNATURE_HEADER), expected);
      assertEquals(Object.keys(c.body.context as object).sort(), [
        "contact",
        "deal",
        "objective",
        "recent_messages",
      ]);
      assertEquals(updates[0].patch.provider_call_id, "CA123");
    } finally {
      uninstall();
    }
  });

  await t.step("cancelamento remoto vira evento call.failed/cancelled", async () => {
    const { deps, events } = callsDeps({
      userRpc: () =>
        Promise.resolve({
          data: {
            action: "cancel_remote",
            call: { ...CALL_ROW, status: "ringing", provider_call_id: "mock-x" },
          },
          error: null,
        }),
    });
    const res = await handleVoiceCalls(
      new Request("http://local", {
        method: "POST",
        body: JSON.stringify({ action: "cancel", call_id: CALL }),
      }),
      deps,
    );
    assertEquals(res.status, 200);
    assertEquals(events[0].type, "call.failed");
    assertEquals(events[0].data?.reason, "cancelled");
  });

  await t.step("status informa se Ligações IA estão configuradas (sem criar nada)", async () => {
    const statusReq = () =>
      new Request("http://local", { method: "POST", body: JSON.stringify({ action: "status" }) });
    const off = callsDeps({
      loadProvider: () =>
        Promise.resolve({ tenantId: TENANT, provider: resolveVoiceProvider(() => undefined) }),
    });
    assertEquals(await (await handleVoiceCalls(statusReq(), off.deps)).json(), {
      configured: false,
      simulation: false,
    });
    const on = callsDeps();
    assertEquals(await (await handleVoiceCalls(statusReq(), on.deps)).json(), {
      configured: true,
      simulation: true,
    });
    assertEquals(on.rpcCalls.length, 0);
  });

  await t.step("mock só com VOICE_PROVIDER=mock explícito", () => {
    assertEquals(resolveVoiceProvider(() => undefined).ok, false);
    const env: Record<string, string> = {
      VOICE_PROVIDER: "voice-service",
      VOICE_SERVICE_URL: "http://inseguro",
    };
    assertEquals(resolveVoiceProvider((k) => env[k]).ok, false);
    const mock = resolveVoiceProvider((k) =>
      ({ VOICE_PROVIDER: "mock" } as Record<string, string>)[k]
    );
    assert(mock.ok && mock.provider.name === "mock");
  });
});
