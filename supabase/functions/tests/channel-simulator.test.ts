import { assert, assertEquals } from "jsr:@std/assert@1";
import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  emptyResponse,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
const CHANNEL = "11111111-1111-4111-8111-111111111111";
const CLIENT = "22222222-2222-4222-8222-222222222222";

async function exercise(options: {
  auth?: boolean;
  role?: string;
  inactiveMember?: boolean;
  tenant?: string;
  provider?: string;
  allowed?: boolean;
  enabled?: boolean;
  body?: Record<string, unknown>;
}) {
  const writes: Array<{ path: string; body: Record<string, unknown> }> = [];
  const handler = await captureHandler("../channel-simulator/index.ts");
  const restore = installFetchMock((req) => {
    if (new URL(req.url).origin !== BASE_ENV.SUPABASE_URL) {
      throw new Error(`Fetch externo proibido: ${req.url}`);
    }
    const query = new URL(req.url).searchParams;
    const table = req.pathname.replace("/rest/v1/", "");
    if (req.pathname === "/auth/v1/user") {
      return options.auth === false
        ? jsonResponse(401, { message: "JWT inválido" })
        : jsonResponse(200, { id: "user-1" });
    }
    if (table === "tenant_memberships" && options.inactiveMember) {
      return jsonResponse(200, [{ tenant_id: "tenant-a", user_id: "user-1", role_id: "role-1", status: "revoked", revoked_at: "2026-10-15T00:00:00Z" }]);
    }
    const profile = { tenant_id: "tenant-a", role: options.role ?? "agent" };
    const membership = activeMembershipResponse(req, profile);
    if (membership) return membership;
    if (table === "profiles") return jsonResponse(200, [profile]);
    if (table === "channels") {
      assertEquals(query.get("tenant_id"), "eq.tenant-a");
      assertEquals(query.get("provider_slug"), "eq.simulator");
      assertEquals(query.get("type"), "eq.simulator");
      return jsonResponse(200, [{
        id: CHANNEL, tenant_id: options.tenant ?? "tenant-a", type: "simulator",
        provider_slug: options.provider ?? "simulator", status: "connected",
      }]);
    }
    if (table === "tenant_ai_features") return jsonResponse(200, [{ enabled: options.enabled ?? true }]);
    if (table === "tenant_integrations") return jsonResponse(200, [{ status: "active" }]);
    if (table === "rpc/check_and_record_rate_limit") {
      return jsonResponse(200, [{ allowed: options.allowed ?? true, retry_after_ms: 60000 }]);
    }
    if (req.method === "GET" && table === "contact_identities") return jsonResponse(200, []);
    if (req.method === "GET" && table === "contacts") return jsonResponse(200, [{ id: "contact-1", name: "Cliente simulado" }]);
    if (req.method === "GET" && table === "conversations") return jsonResponse(200, []);
    if (req.method === "GET" && table === "messages") return jsonResponse(200, []);
    if (req.pathname.startsWith("/storage/v1/object/sign/simulator-media/")) {
      return jsonResponse(200, { signedURL: "/object/sign/simulator-media/tenant-a/simulator/anexo?token=teste" });
    }
    if (req.method !== "GET") {
      const body = req.bodyJson as Record<string, unknown>;
      writes.push({ path: req.pathname, body });
      if (table === "contacts") return jsonResponse(201, { id: "contact-1" });
      if (table === "conversations") return jsonResponse(201, { id: "conversation-1" });
      if (table === "messages") return jsonResponse(201, { id: "message-1" });
      if (table === "rpc/enqueue_ai_response_job") {
        return jsonResponse(200, [{ job_id: "job-1", should_dispatch: true }]);
      }
      if (req.pathname === "/functions/v1/ai-respond") return jsonResponse(200, { ok: true });
      if (table === "nurture_enrollments") return jsonResponse(200, []);
      return emptyResponse();
    }
    throw new Error(`Consulta não prevista: ${req.method} ${req.pathname}`);
  });
  try {
    const response = await handler(new Request("http://edge.local/channel-simulator", {
      method: "POST",
      headers: { Authorization: "Bearer usuario", "Content-Type": "application/json" },
      body: JSON.stringify({ action: "send", channel_id: CHANNEL, client_id: CLIENT, content: "Olá", ...options.body }),
    }));
    return { response, body: await response.json(), writes };
  } finally {
    restore();
  }
}

Deno.test("simulador recusa JWT inválido sem criar mensagens", async () => {
  const result = await exercise({ auth: false });
  assertEquals(result.response.status, 401);
  assertEquals(result.writes.length, 0);
});

Deno.test("simulador não injeta em canal alheio mesmo com tenant forjado no body", async () => {
  const result = await exercise({ tenant: "tenant-b", body: { tenant_id: "tenant-b" } });
  assertEquals(result.response.status, 404);
  assertEquals(result.writes.length, 0);
});

Deno.test("simulador recusa canal de provedor real", async () => {
  const result = await exercise({ provider: "zapi" });
  assertEquals(result.response.status, 404);
  assertEquals(result.writes.length, 0);
});

Deno.test("simulador exige administrador para criar canal", async () => {
  const result = await exercise({ body: { action: "create" } });
  assertEquals(result.response.status, 403);
  assertEquals(result.writes.length, 0);
});

Deno.test("simulador respeita opt-in e limite antes de persistir", async () => {
  const disabled = await exercise({ enabled: false });
  assertEquals(disabled.response.status, 403);
  assertEquals(disabled.writes.length, 0);
  const limited = await exercise({ allowed: false });
  assertEquals(limited.response.status, 429);
  assertEquals(limited.writes.length, 0);
});

Deno.test("simulador usa persistência comum e invoca ai-respond pela fila durável", async () => {
  const result = await exercise({ body: { tenant_id: "tenant-b" } });
  assertEquals(result.response.status, 200);
  assertEquals(result.body.conversation_id, "conversation-1");
  const inbound = result.writes.find((call) => call.path === "/rest/v1/messages")!;
  assertEquals(inbound.body.tenant_id, "tenant-a");
  assertEquals(inbound.body.direction, "in");
  assertEquals(inbound.body.sender, "contact");
  assertEquals(inbound.body.content, "Olá");
  assert(result.writes.some((call) => call.path === "/rest/v1/contact_identities"));
  const enqueue = result.writes.find((call) => call.path === "/rest/v1/rpc/enqueue_ai_response_job")!;
  assertEquals(enqueue.body, { p_tenant_id: "tenant-a", p_message_id: "message-1" });
  assert(result.writes.some((call) => call.path === "/rest/v1/nurture_enrollments"));
  assertEquals(result.writes.find((call) => call.path === "/functions/v1/ai-respond")?.body, { message_id: "message-1" });
});

Deno.test("simulador rejeita mídia interna e storage de outro tenant", async () => {
  for (const media of [
    { url: "http://169.254.169.254/latest/meta-data", type: "audio/mpeg" },
    { storage_path: `tenant-b/simulator/${CHANNEL}/audio.mp3`, type: "audio/mpeg" },
  ]) {
    const result = await exercise({ body: { media } });
    assertEquals(result.response.status, 400);
    assertEquals(result.writes.length, 0);
  }
});

Deno.test("simulador recusa membership revogada", async () => {
  const result = await exercise({ inactiveMember: true });
  assertEquals(result.response.status, 403);
  assertEquals(result.writes.length, 0);
});

Deno.test("simulador persiste imagem e áudio de URL/storage no pipeline comum", async () => {
  for (const media of [
    { url: "https://203.0.113.10/foto.png", type: "image/png" },
    { url: "https://203.0.113.10/voz.mp3", type: "audio/mpeg" },
    { storage_path: `tenant-a/simulator/${CHANNEL}/voz.mp3`, type: "audio/mpeg" },
    { storage_path: `tenant-a/simulator/${CHANNEL}/foto.png`, type: "image/png" },
  ]) {
    const result = await exercise({ body: { content: "", media } });
    assertEquals(result.response.status, 200);
    const inbound = result.writes.find((call) => call.path === "/rest/v1/messages")!;
    assertEquals(inbound.body.media_type, media.type);
    assert(typeof inbound.body.media_url === "string" && inbound.body.media_url.length > 0);
    assert(result.writes.some((call) => call.path === "/functions/v1/ai-respond"));
  }
});
