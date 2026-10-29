// ManyChat de saída: resposta automática da IA (dispatchAiSend), resposta
// manual (messaging-send) e conexão (integration-connect).
import { assert, assertEquals } from "jsr:@std/assert@1";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";
import { dispatchAiSend } from "../_shared/ai/send-dispatch.ts";
import { MANYCHAT_MISSING_IDENTITY_ERROR } from "../_shared/messaging/contact-identity.ts";

setEnv(BASE_ENV);

const SEND_URL = "https://api.manychat.com/fb/sending/sendContent";
const INFO_URL = "https://api.manychat.com/fb/page/getInfo";
const SUB = "12345678901234567";
const PHONE = "+5511988887777";

function admin() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

function val(raw: string | null): string {
  return (raw ?? "").replace(/^[a-z]+\./, "");
}

/** contact_identities com filtro real por slug: prova que só o slug exato vale. */
function identities(req: MockRequest, rows: Array<{ provider_slug: string; external_id: string }>) {
  const slugs = val(new URL(req.url).searchParams.get("provider_slug")).replace(/[()]/g, "").split(",");
  return jsonResponse(200, rows.filter((r) => slugs.includes(r.provider_slug)));
}

// -------------------- IA --------------------

Deno.test("dispatchAiSend — ManyChat", async (t) => {
  function aiParams() {
    return {
      admin: admin(),
      tenantId: "tenant-1",
      conversationId: "conv-1",
      contactId: "contact-1",
      dealId: null,
      aiMessageId: "msg-ai-1",
      aiText: "Claro! O plano custa R$ 99.",
      providerSlug: "manychat-instagram",
      contactPhone: PHONE,
      contactEmail: null,
      subject: null,
      previousAwaitingHuman: false,
    };
  }

  await t.step("identidade provider_user existente: envia ao subscriber_id e marca sent", async () => {
    const sent: string[] = [];
    let msgPatch: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/contact_identities") {
        return identities(req, [
          { provider_slug: "manychat-instagram", external_id: SUB },
          { provider_slug: "manychat-whatsapp", external_id: "999" },
        ]);
      }
      if (req.pathname === "/rest/v1/integration_secrets") {
        return jsonResponse(200, [{ key: "api_key", value: "mc-key" }, { key: "webhook_secret", value: "s" }]);
      }
      if (req.url === SEND_URL) {
        sent.push(req.bodyText);
        return jsonResponse(200, { status: "success" });
      }
      if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
        msgPatch ??= req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") return jsonResponse(200, {});
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      assertEquals(await dispatchAiSend(aiParams()), true);
    } finally {
      uninstall();
    }
    assertEquals(sent.length, 1);
    assert(sent[0].startsWith(`{"subscriber_id":${SUB},`), sent[0]);
    assert(!sent[0].includes("5511988887777"), "telefone nunca vira destino");
    assertEquals((msgPatch as Record<string, unknown> | null)?.status, "sent");
    assertEquals((msgPatch as Record<string, unknown> | null)?.external_id, null);
  });

  await t.step("sem provider_user: falha clara + handoff, sem chamar o ManyChat", async () => {
    let manychatCalls = 0;
    const patches: Array<Record<string, unknown>> = [];
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/contact_identities") {
        // Só existe identidade de OUTRA superfície: não serve.
        return identities(req, [{ provider_slug: "manychat-whatsapp", external_id: SUB }]);
      }
      if (req.url.startsWith("https://api.manychat.com")) {
        manychatCalls++;
        return jsonResponse(200, { status: "success" });
      }
      if (req.method === "PATCH") {
        patches.push(req.bodyJson as Record<string, unknown>);
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/ai_failure_logs") return jsonResponse(201, {});
      if (req.pathname === "/rest/v1/hitl_handoff_sla_events") return jsonResponse(200, []);
      if (req.pathname === "/rest/v1/weekly_report_recipients") return jsonResponse(200, []);
      if (req.pathname === "/rest/v1/integration_secrets") return jsonResponse(200, []);
      return jsonResponse(200, []);
    };
    const uninstall = installFetchMock(router);
    try {
      assertEquals(await dispatchAiSend(aiParams()), false);
    } finally {
      uninstall();
    }
    assertEquals(manychatCalls, 0);
    assert(patches.some((p) => p.status === "failed" && p.send_error === MANYCHAT_MISSING_IDENTITY_ERROR));
    assert(patches.some((p) => p.awaiting_human === true), "handoff para humano");
  });
});

// -------------------- envio manual --------------------

Deno.test("messaging-send — operador responde conversa ManyChat", async () => {
  const handler = await captureHandler("../messaging-send/index.ts");
  const profile = { tenant_id: "tenant-1", role: "agent" };
  const sent: string[] = [];
  const msgPatches: Array<Record<string, unknown>> = [];
  const router: FetchMatcher = (req) => {
    if (req.pathname === "/auth/v1/user") return jsonResponse(200, { id: "user-1", aud: "authenticated" });
    if (req.pathname === "/rest/v1/profiles") return jsonResponse(200, [profile]);
    const membership = activeMembershipResponse(req, profile);
    if (membership) return membership;
    if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
      return jsonResponse(200, [{
        id: "conv-1",
        tenant_id: "tenant-1",
        contact_id: "contact-1",
        channel_id: "ch-1",
        subject: null,
        channels: { provider_slug: "manychat-whatsapp", type: "whatsapp", status: "connected" },
      }]);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") return emptyResponse(200);
    if (req.pathname === "/rest/v1/tenant_integrations") return jsonResponse(200, [{ status: "active" }]);
    if (req.pathname === "/rest/v1/contacts") return jsonResponse(200, [{ phone: PHONE, email: null }]);
    if (req.pathname === "/rest/v1/contact_identities") {
      return identities(req, [{ provider_slug: "manychat-whatsapp", external_id: SUB }]);
    }
    if (req.pathname === "/rest/v1/messages" && req.method === "POST") return jsonResponse(201, { id: "msg-1" });
    if (req.pathname === "/rest/v1/messages" && req.method === "PATCH") {
      msgPatches.push(req.bodyJson as Record<string, unknown>);
      return emptyResponse(200);
    }
    if (req.pathname === "/rest/v1/integration_secrets") return jsonResponse(200, [{ key: "api_key", value: "mc-key" }]);
    if (req.url === SEND_URL) {
      sent.push(req.bodyText);
      return jsonResponse(200, { status: "success" });
    }
    if (req.pathname === "/rest/v1/communication_usage_events") return jsonResponse(201, []);
    return undefined;
  };
  const uninstall = installFetchMock(router);
  try {
    const res = await handler(new Request("http://fn.local/functions/v1/messaging-send", {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify({ conversation_id: "conv-1", content: "Oi, aqui é a Ana da loja" }),
    }));
    const body = await res.json() as { ok: boolean };
    assertEquals(body.ok, true);
  } finally {
    uninstall();
  }
  assertEquals(sent.length, 1);
  const parsed = JSON.parse(sent[0]) as { data: { content: { type: string } } };
  assertEquals(parsed.data.content.type, "whatsapp");
  assert(sent[0].startsWith(`{"subscriber_id":${SUB},`));
  assert(msgPatches.some((p) => p.status === "sent"));
});

// -------------------- conexão --------------------

interface ConnectState {
  existingSecrets: Array<{ key: string; value: string }>;
  secretWrites: Array<Array<Record<string, unknown>>>;
  tiWrites: Array<Record<string, unknown>>;
  channelInserts: Array<Record<string, unknown>>;
  infoStatus: number;
}

function connectRouter(s: ConnectState): FetchMatcher {
  return (req) => {
    if (req.pathname === "/auth/v1/user") return jsonResponse(200, { id: "user-1", aud: "authenticated" });
    if (req.pathname === "/rest/v1/profiles") return jsonResponse(200, [{ tenant_id: "tenant-1", role: "admin" }]);
    if (req.pathname === "/rest/v1/integrations") {
      return jsonResponse(200, [{ slug: "manychat-messenger", available: true, required_secrets: [{ key: "api_key" }] }]);
    }
    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") return jsonResponse(200, s.existingSecrets);
    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "POST") {
      s.secretWrites.push(req.bodyJson as Array<Record<string, unknown>>);
      return jsonResponse(201, []);
    }
    if (req.url === INFO_URL) {
      return s.infoStatus === 200
        ? jsonResponse(200, { status: "success", data: { id: 777, name: "Loja da Ana" } })
        : jsonResponse(s.infoStatus, { status: "error", message: "unauthorized" });
    }
    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") return jsonResponse(200, []);
    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "POST") {
      s.tiWrites.push(req.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/channels" && req.method === "GET") return jsonResponse(200, []);
    if (req.pathname === "/rest/v1/channels" && req.method === "POST") {
      s.channelInserts.push(req.bodyJson as Record<string, unknown>);
      return jsonResponse(201, { id: "ch-new" });
    }
    if (req.pathname === "/rest/v1/system_events") return jsonResponse(201, []);
    return undefined;
  };
}

async function connect(s: ConnectState, body: Record<string, unknown>) {
  const handler = await captureHandler("../integration-connect/index.ts");
  const uninstall = installFetchMock(connectRouter(s));
  try {
    const res = await handler(new Request("http://fn.local/functions/v1/integration-connect", {
      method: "POST",
      headers: { Authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify(body),
    }));
    return await res.json() as { ok: boolean; error?: string; webhook_secret?: string };
  } finally {
    uninstall();
  }
}

function freshConnect(): ConnectState {
  return { existingSecrets: [], secretWrites: [], tiWrites: [], channelInserts: [], infoStatus: 200 };
}

Deno.test("integration-connect — ManyChat", async (t) => {
  await t.step("chave válida: grava segredos, canal messenger com token e devolve o secret uma vez", async () => {
    const s = freshConnect();
    const r = await connect(s, { action: "connect", slug: "manychat-messenger", values: { api_key: "mc-key" } });
    assertEquals(r.ok, true);
    assert(r.webhook_secret && r.webhook_secret.length >= 32);
    const keys = s.secretWrites[0].map((row) => row.key).sort();
    assertEquals(keys, ["api_key", "webhook_secret"]);
    assertEquals(s.channelInserts[0].type, "messenger");
    assertEquals(s.channelInserts[0].provider_slug, "manychat-messenger");
    assert(typeof s.channelInserts[0].webhook_token === "string");
    const config = s.tiWrites.find((w) => w.status === "active")?.config as Record<string, unknown>;
    assertEquals(config.manychat_page_name, "Loja da Ana");
    assert(!JSON.stringify(config).includes("mc-key"), "chave fora do config");
  });

  await t.step("reconexão preserva o secret e não o devolve", async () => {
    const s = freshConnect();
    s.existingSecrets = [{ key: "api_key", value: "old" }, { key: "webhook_secret", value: "keep-me" }];
    const r = await connect(s, { action: "connect", slug: "manychat-messenger", values: { api_key: "mc-key" } });
    assertEquals(r.ok, true);
    assertEquals(r.webhook_secret, undefined);
    assertEquals(s.secretWrites[0].find((row) => row.key === "webhook_secret")?.value, "keep-me");
  });

  await t.step("chave inválida: não grava nem ativa", async () => {
    const s = freshConnect();
    s.infoStatus = 401;
    const r = await connect(s, { action: "connect", slug: "manychat-messenger", values: { api_key: "bad" } });
    assertEquals(r.ok, false);
    assert(r.error?.includes("inválida"));
    assertEquals(s.secretWrites.length, 0);
    assert(!s.tiWrites.some((w) => w.status === "active"));
  });

  await t.step("rotate_webhook_secret gera um novo", async () => {
    const s = freshConnect();
    const r = await connect(s, { action: "rotate_webhook_secret", slug: "manychat-messenger" });
    assertEquals(r.ok, true);
    assertEquals(s.secretWrites[0][0].key, "webhook_secret");
    assertEquals(s.secretWrites[0][0].value, r.webhook_secret);
  });
});
