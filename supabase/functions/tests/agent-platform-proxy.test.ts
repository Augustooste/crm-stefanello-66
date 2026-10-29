import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";

import { AgentPlatformConfigError, normalizeBaseUrl } from "../_shared/agent-platform/client.ts";

// Host fictício de teste: não existe mais default no código, e cravar um host
// de provedor real aqui devolveria pela porta dos fundos o acoplamento que a
// remoção do default acabou de tirar.
const BASE = "https://provider.test";
import {
  ActionResolveError,
  AGENT_PLATFORM_ACTIONS,
  resolveAction,
} from "../_shared/agent-platform/actions.ts";
import { buildTrainingCallbackUrl } from "../_shared/agent-platform/callback.ts";

setEnv(BASE_ENV);

// O código não tem mais base URL padrão (config ausente = erro explícito),
// então o ambiente de teste precisa declarar a dele.
Deno.env.set("AGENT_PLATFORM_API_BASE_URL", "https://provider.test");

const handler = await captureHandler("../agent-platform-proxy/index.ts");

interface RemoteCall {
  method: string;
  url: string;
  authorization: string | null;
  body: unknown;
}

interface State {
  authOk: boolean;
  /** Status que `/auth/v1/user` devolve quando `authOk` é false. 401/403 = sessão
   * inválida; 5xx = GoTrue instável, que NÃO pode virar "Não autenticado.". */
  authFailStatus: number;
  profile: { tenant_id: string; role: string } | null;
  secrets: Array<{ key: string; value: string }>;
  tenantIntegration: { slug: string; status: string } | null;
  agentLinks: string[];
  channelLinks: string[];
  /** Faz a escrita em agent_platform_agent_links responder erro do PostgREST
   * (RLS negada). supabase-js não lança — vira `{ error }` no destructure. */
  linkWriteError: boolean;
  /** Respostas do provedor, consumidas em ordem. Sobra = repete a última. */
  remote: Array<{ status: number; body: unknown }>;
  remoteCalls: RemoteCall[];
  writes: Array<{ path: string; body: unknown }>;
}

function defaultState(overrides: Partial<State> = {}): State {
  return {
    authOk: true,
    authFailStatus: 401,
    profile: { tenant_id: "tenant-1", role: "admin" },
    secrets: [
      { key: "api_token", value: "gm-token" },
      { key: "workspace_id", value: "ws-1" },
    ],
    tenantIntegration: { slug: "agent-platform", status: "active" },
    agentLinks: ["agent-1"],
    channelLinks: ["channel-1"],
    linkWriteError: false,
    remote: [{ status: 200, body: { ok: true } }],
    remoteCalls: [],
    writes: [],
    ...overrides,
  };
}

function nextRemote(state: State): { status: number; body: unknown } {
  return state.remote.length > 1
    ? state.remote.shift()!
    : (state.remote[0] ?? { status: 200, body: null });
}

function router(state: State): FetchMatcher {
  return (req: MockRequest) => {
    if (req.url.startsWith(BASE)) {
      state.remoteCalls.push({
        method: req.method,
        url: req.url,
        authorization: req.headers.get("authorization"),
        body: req.bodyJson,
      });
      const next = nextRemote(state);
      return jsonResponse(next.status, next.body);
    }
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) {
        return jsonResponse(state.authFailStatus, { msg: "invalid token" });
      }
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    const membership = activeMembershipResponse(req, state.profile);
    if (membership) return membership;
    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
      return jsonResponse(200, state.secrets);
    }
    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") {
      return jsonResponse(200, state.tenantIntegration ? [state.tenantIntegration] : []);
    }
    if (req.pathname === "/rest/v1/agent_platform_agent_links") {
      if (req.method === "GET") {
        const match = state.agentLinks.some((id) => req.url.includes(encodeURIComponent(id)));
        return jsonResponse(200, match ? [{ id: "link-1" }] : []);
      }
      state.writes.push({ path: req.pathname, body: req.bodyJson });
      if (state.linkWriteError) {
        return jsonResponse(403, {
          message: "permission denied for table agent_platform_agent_links",
          code: "42501",
        });
      }
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/agent_platform_channel_links") {
      if (req.method === "GET") {
        const match = state.channelLinks.some((id) => req.url.includes(encodeURIComponent(id)));
        return jsonResponse(200, match ? [{ id: "link-c1" }] : []);
      }
      state.writes.push({ path: req.pathname, body: req.bodyJson });
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/agent_platform_audit_log" && req.method === "POST") {
      state.writes.push({ path: req.pathname, body: req.bodyJson });
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
      state.writes.push({ path: req.pathname, body: req.bodyJson });
      return jsonResponse(201, []);
    }
    return undefined;
  };
}

function req(body?: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token-123");
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function call(
  state: State,
  body: unknown,
): Promise<{ status: number; json: Record<string, never> & Record<string, unknown> }> {
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(req(body));
    const text = await res.text();
    return { status: res.status, json: text ? JSON.parse(text) : {} };
  } finally {
    uninstall();
  }
}

function auditEntries(state: State): Array<Record<string, unknown>> {
  return state.writes
    .filter((w) => w.path === "/rest/v1/agent_platform_audit_log")
    .map((w) => w.body as Record<string, unknown>);
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: esperado ${expected}, veio ${actual}`);
}

Deno.test("agent-platform: normalizeBaseUrl impede /v2 duplicado", () => {
  for (const vazio of [undefined, "", "   "]) {
    let erro: unknown;
    try {
      normalizeBaseUrl(vazio);
    } catch (e) {
      erro = e;
    }
    // Sem base configurada NÃO existe destino padrão: escolher um sozinho já
    // mandou token de tenant para o host de um provedor que ninguém pediu.
    assertEquals(
      erro instanceof AgentPlatformConfigError,
      true,
      `base vazia (${JSON.stringify(vazio)}) deveria lançar erro de configuração`,
    );
  }
  assertEquals(
    normalizeBaseUrl(`${BASE}/v2`),
    BASE,
    "sufixo /v2 removido",
  );
  assertEquals(
    normalizeBaseUrl(`${BASE}/v2/`),
    BASE,
    "sufixo /v2/ removido",
  );
  assertEquals(
    normalizeBaseUrl("https://staging.agent-platform.ai/"),
    "https://staging.agent-platform.ai",
    "barra final removida",
  );
});

Deno.test("agent-platform: resolveAction", async (t) => {
  await t.step("injeta workspaceId do servidor", () => {
    const { path } = resolveAction(AGENT_PLATFORM_ACTIONS["agents.list"], {}, "ws-9");
    assertEquals(path, "/v2/workspace/ws-9/agents", "path");
  });

  await t.step("sem workspace configurado, falha", () => {
    let threw = false;
    try {
      resolveAction(AGENT_PLATFORM_ACTIONS["agents.list"], {}, null);
    } catch (e) {
      threw = e instanceof ActionResolveError;
    }
    assertEquals(threw, true, "deveria lançar ActionResolveError");
  });

  await t.step("trainings.list exige type (obrigatório no contrato)", () => {
    let threw = false;
    try {
      resolveAction(AGENT_PLATFORM_ACTIONS["trainings.list"], { agentId: "a1" }, "ws-1");
    } catch (e) {
      threw = e instanceof ActionResolveError;
    }
    assertEquals(threw, true, "type ausente deveria falhar");
    const ok = resolveAction(
      AGENT_PLATFORM_ACTIONS["trainings.list"],
      { agentId: "a1", type: "TEXT", page: 1, foo: "bar" },
      "ws-1",
    );
    assertEquals(ok.path, "/v2/agent/a1/trainings", "path");
    assertEquals(ok.query.type, "TEXT", "type na query");
    assertEquals(ok.query.page, 1, "page na query");
    assertEquals("foo" in ok.query, false, "param fora da allowlist não vaza");
  });

  await t.step("alias de placeholder ({id} → agentId)", () => {
    const { path } = resolveAction(
      AGENT_PLATFORM_ACTIONS["agent.behaviorHistory.list"],
      { agentId: "a1", page: 0, pageSize: 20 },
      "ws-1",
    );
    assertEquals(path, "/v2/agent/a1/list-behavior-history", "path com alias");
  });

  await t.step("id com caractere de path traversal é rejeitado", () => {
    let threw = false;
    try {
      resolveAction(
        AGENT_PLATFORM_ACTIONS["agent.get"],
        { agentId: "../../v2/workspaces" },
        "ws-1",
      );
    } catch (e) {
      threw = e instanceof ActionResolveError;
    }
    assertEquals(threw, true, "id inválido deveria falhar");
  });

  await t.step("retry é por operação: GET mutante do MCP não é retentável", () => {
    assertEquals(AGENT_PLATFORM_ACTIONS["mcp.tools.sync"].retryable, undefined, "sync-tools");
    assertEquals(AGENT_PLATFORM_ACTIONS["mcp.tool.activate"].retryable, undefined, "tool active");
    assertEquals(
      AGENT_PLATFORM_ACTIONS["mcp.tool.deactivate"].retryable,
      undefined,
      "tool inactive",
    );
    assertEquals(AGENT_PLATFORM_ACTIONS["agents.list"].retryable, true, "leitura pura");
  });
});

Deno.test("agent-platform-proxy: autenticação e permissão", async (t) => {
  await t.step("sem sessão válida → AUTHENTICATION_FAILED", async () => {
    const state = defaultState({ authOk: false });
    const res = await call(state, { action: "agents.list" });
    assertEquals(res.status, 200, "status");
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "AUTHENTICATION_FAILED",
      "code",
    );
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });

  await t.step("usuário não-admin → FORBIDDEN", async () => {
    const state = defaultState({ profile: { tenant_id: "tenant-1", role: "agent" } });
    const res = await call(state, { action: "agents.list" });
    assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });

  await t.step("sem credencial do tenant → pede conexão", async () => {
    const state = defaultState({ secrets: [], tenantIntegration: null });
    const res = await call(state, { action: "agents.list" });
    const error = res.json.error as Record<string, unknown>;
    assertEquals(error.code, "AUTHENTICATION_FAILED", "code");
    assertEquals(
      String(error.message).includes("Configurações"),
      true,
      "mensagem orienta conectar",
    );
  });

  await t.step("action desconhecida → UNSUPPORTED_BY_PUBLIC_API", async () => {
    const state = defaultState();
    const res = await call(state, { action: "agents.nuke" });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "UNSUPPORTED_BY_PUBLIC_API",
      "code",
    );
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });

  await t.step("método não-POST → 405", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "GET" }));
      assertEquals(res.status, 405, "status");
    } finally {
      uninstall();
    }
  });
});

Deno.test("agent-platform-proxy: multi-tenancy", async (t) => {
  await t.step("agente sem vínculo e token global → FORBIDDEN e auditoria denied", async () => {
    Deno.env.set("AGENT_PLATFORM_API_TOKEN", "token-global");
    Deno.env.set("AGENT_PLATFORM_WORKSPACE_ID", "ws-global");
    try {
      const state = defaultState({ secrets: [], agentLinks: [] });
      const res = await call(state, { action: "agent.get", params: { agentId: "agent-de-outro" } });
      assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
      assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
      assertEquals(auditEntries(state)[0]?.status, "denied", "auditoria");
    } finally {
      Deno.env.delete("AGENT_PLATFORM_API_TOKEN");
      Deno.env.delete("AGENT_PLATFORM_WORKSPACE_ID");
    }
  });

  await t.step("agente sem vínculo e credencial do tenant → vincula e segue", async () => {
    const state = defaultState({
      agentLinks: [],
      remote: [{ status: 200, body: { id: "agent-novo", name: "Novo" } }],
    });
    const res = await call(state, { action: "agent.get", params: { agentId: "agent-novo" } });
    assertEquals(res.json.error, undefined, "sem erro");
    assertEquals(state.remoteCalls.length, 1, "chamou o provedor");
    const linkWrites = state.writes.filter((w) => w.path === "/rest/v1/agent_platform_agent_links");
    assertEquals(linkWrites.length > 0, true, "gravou o vínculo");
  });

  await t.step("agentId do corpo também é verificado (channel.update)", async () => {
    Deno.env.set("AGENT_PLATFORM_API_TOKEN", "token-global");
    Deno.env.set("AGENT_PLATFORM_WORKSPACE_ID", "ws-global");
    try {
      const state = defaultState({ secrets: [], agentLinks: [], channelLinks: ["channel-1"] });
      const res = await call(state, {
        action: "channel.update",
        params: { channelId: "channel-1" },
        body: { name: "Canal", agentId: "agent-de-outro" },
      });
      assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
      assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
    } finally {
      Deno.env.delete("AGENT_PLATFORM_API_TOKEN");
      Deno.env.delete("AGENT_PLATFORM_WORKSPACE_ID");
    }
  });
});

Deno.test("agent-platform-proxy: chamada ao provedor", async (t) => {
  await t.step("agents.list monta URL sem /v2 duplicado e envia Bearer", async () => {
    Deno.env.set("AGENT_PLATFORM_API_BASE_URL", `${BASE}/v2`);
    try {
      const state = defaultState({
        remote: [{ status: 200, body: [{ id: "agent-1", name: "Ana" }] }],
      });
      const res = await call(state, { action: "agents.list", params: { page: 1, pageSize: 25 } });
      assertEquals(res.json.error, undefined, "sem erro");
      const remote = state.remoteCalls[0];
      assertEquals(
        remote.url,
        `${BASE}/v2/workspace/ws-1/agents?page=1&pageSize=25`,
        "URL",
      );
      assertEquals(remote.authorization, "Bearer gm-token", "authorization");
      assertEquals(remote.method, "GET", "método");
      assertEquals(auditEntries(state)[0]?.status, "ok", "auditoria ok");
    } finally {
      // Restaura, não apaga: sem base configurada o `normalizeBaseUrl` agora
      // LANÇA, então um delete aqui derrubava todos os testes seguintes.
      Deno.env.set("AGENT_PLATFORM_API_BASE_URL", BASE);
    }
  });

  await t.step("agents.list sincroniza vínculos com a resposta remota", async () => {
    const state = defaultState({
      remote: [{ status: 200, body: [{ id: "agent-7", name: "Bia" }] }],
    });
    await call(state, { action: "agents.list" });
    const write = state.writes.find((w) => w.path === "/rest/v1/agent_platform_agent_links");
    const rows = write?.body as Array<Record<string, unknown>>;
    assertEquals(rows[0].platform_agent_id, "agent-7", "id sincronizado");
    assertEquals(rows[0].platform_workspace_id, "ws-1", "workspace do servidor");
  });

  await t.step("sync bloqueado por RLS → leitura vale, mas avisa e registra", async () => {
    const state = defaultState({
      remote: [{ status: 200, body: [{ id: "agent-7", name: "Bia" }] }],
      linkWriteError: true,
    });
    const res = await call(state, { action: "agents.list" });
    assertEquals(res.status, 200, "status");
    assertEquals(res.json.error, undefined, "leitura não é invalidada");
    assertEquals(Array.isArray(res.json.data), true, "data preservado");
    assertEquals(
      String(res.json.syncWarning).includes("vínculos"),
      true,
      "syncWarning em PT-BR no envelope",
    );
    const evento = state.writes
      .filter((w) => w.path === "/rest/v1/system_events")
      .map((w) => w.body as Record<string, unknown>)
      .find((b) => b.operation === "agent-platform.sync_links.agent_links.upsert");
    assertEquals(evento?.severity, "warn", "system_events com severity warn");
    assertEquals(
      String(evento?.message).includes("permission denied"),
      true,
      "message do PostgREST",
    );
    assertEquals(auditEntries(state)[0]?.status, "ok", "auditoria segue ok");
  });

  await t.step("401 do provedor → AUTHENTICATION_FAILED", async () => {
    const state = defaultState({ remote: [{ status: 401, body: { error: "invalid token" } }] });
    const res = await call(state, { action: "agents.list" });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "AUTHENTICATION_FAILED",
      "code",
    );
    assertEquals(auditEntries(state)[0]?.status, "error", "auditoria error");
  });

  await t.step("403 com menção a crédito → INSUFFICIENT_CREDITS", async () => {
    const state = defaultState({
      remote: [{ status: 403, body: { error: "workspace without credits" } }],
    });
    const res = await call(state, { action: "agents.list" });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "INSUFFICIENT_CREDITS",
      "code",
    );
  });

  await t.step("400 do provedor → VALIDATION_ERROR sem vazar corpo cru", async () => {
    const state = defaultState({
      remote: [{ status: 400, body: { error: "name is required (token gm-token)" } }],
    });
    const res = await call(state, { action: "agents.create", body: { name: "" } });
    const error = res.json.error as Record<string, unknown>;
    assertEquals(error.code, "VALIDATION_ERROR", "code");
    assertEquals(String(error.message).includes("gm-token"), false, "não vaza credencial");
  });

  await t.step("429 em leitura retentável tenta de novo", async () => {
    const state = defaultState({
      remote: [
        { status: 429, body: { error: "slow down" } },
        { status: 200, body: [] },
      ],
    });
    const res = await call(state, { action: "agents.list" });
    assertEquals(res.json.error, undefined, "sucesso após retry");
    assertEquals(state.remoteCalls.length, 2, "duas tentativas");
  });

  await t.step("GET mutante do MCP não é retentado em 500", async () => {
    const state = defaultState({
      agentLinks: ["agent-1"],
      remote: [
        { status: 500, body: { error: "boom" } },
        { status: 200, body: { success: true } },
      ],
    });
    const res = await call(state, {
      action: "mcp.tools.sync",
      params: { agentId: "agent-1", mcpId: "mcp-1" },
    });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "REMOTE_SERVER_ERROR",
      "code",
    );
    assertEquals(state.remoteCalls.length, 1, "uma única tentativa");
  });

  await t.step("callbackUrl do cliente é descartada e a assinada é injetada", async () => {
    Deno.env.set("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET", "segredo-teste");
    try {
      const state = defaultState({ remote: [{ status: 200, body: { success: true } }] });
      await call(state, {
        action: "trainings.create",
        params: { agentId: "agent-1" },
        body: { type: "TEXT", text: "conteúdo", callbackUrl: "https://evil.example/exfil" },
      });
      const sent = state.remoteCalls[0].body as Record<string, unknown>;
      const expected = await buildTrainingCallbackUrl(
        BASE_ENV.SUPABASE_URL,
        "segredo-teste",
        "tenant-1",
      );
      assertEquals(sent.callbackUrl, expected, "callbackUrl assinada pelo servidor");
      assertEquals(sent.text, "conteúdo", "corpo preservado");
    } finally {
      Deno.env.delete("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET");
    }
  });

  await t.step("sem segredo configurado, treinamento vai sem callbackUrl", async () => {
    const state = defaultState({ remote: [{ status: 200, body: { success: true } }] });
    await call(state, {
      action: "trainings.create",
      params: { agentId: "agent-1" },
      body: { type: "TEXT", text: "x", callbackUrl: "https://evil.example/exfil" },
    });
    const sent = state.remoteCalls[0].body as Record<string, unknown>;
    assertEquals("callbackUrl" in sent, false, "nenhuma callbackUrl enviada");
  });

  await t.step("param obrigatório ausente → VALIDATION_ERROR", async () => {
    const state = defaultState();
    const res = await call(state, { action: "trainings.list", params: { agentId: "agent-1" } });
    assertEquals((res.json.error as Record<string, unknown>).code, "VALIDATION_ERROR", "code");
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });
});

Deno.test("agent-platform-proxy: regressões do review de 2026-08-03", async (t) => {
  const withGlobalToken = async (fn: () => Promise<void>): Promise<void> => {
    Deno.env.set("AGENT_PLATFORM_API_TOKEN", "token-global");
    Deno.env.set("AGENT_PLATFORM_WORKSPACE_ID", "ws-global");
    try {
      await fn();
    } finally {
      Deno.env.delete("AGENT_PLATFORM_API_TOKEN");
      Deno.env.delete("AGENT_PLATFORM_WORKSPACE_ID");
    }
  };

  // C1 — o guard antigo era `typeof params.agentId === "string"`. Como
  // ActionParams admite number, mandar o id como número pulava a checagem de
  // posse inteira e o `String(raw)` do resolveAction ressuscitava o valor para o
  // path da chamada remota: 200, provedor chamado, zero auditoria.
  await t.step("agentId numérico NÃO pula a checagem de posse", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({ secrets: [], agentLinks: [] });
      const res = await call(state, { action: "agent.get", params: { agentId: 123456 } });
      assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
      assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
      assertEquals(auditEntries(state)[0]?.status, "denied", "auditoria denied");
    });
  });

  await t.step("channelId booleano NÃO pula a checagem de posse", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({ secrets: [], channelLinks: [] });
      const res = await call(state, { action: "channel.delete", params: { channelId: true } });
      assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
      assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
    });
  });

  await t.step("agentId do corpo como número também é verificado", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({ secrets: [], agentLinks: [], channelLinks: ["channel-1"] });
      const res = await call(state, {
        action: "channel.update",
        params: { channelId: "channel-1" },
        body: { name: "Canal", agentId: 42 },
      });
      assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
      assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
    });
  });

  await t.step("id como objeto é recusado como VALIDATION_ERROR", async () => {
    const state = defaultState();
    const res = await call(state, { action: "agent.get", params: { agentId: { $ne: null } } });
    assertEquals((res.json.error as Record<string, unknown>).code, "VALIDATION_ERROR", "code");
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });

  // H1 — a linha em tenant_integrations sobrevive ao "desconectar"/"esquecer";
  // só o api_token some. Sem comparar o status, o tenant voltava a cair no token
  // global e a revogação virava no-op.
  await t.step("integração desabilitada não cai no token global", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({
        secrets: [],
        tenantIntegration: { slug: "agent-platform", status: "disabled" },
      });
      const res = await call(state, { action: "agents.list", params: { page: 1, pageSize: 10 } });
      assertEquals(
        (res.json.error as Record<string, unknown>).code,
        "AUTHENTICATION_FAILED",
        "code",
      );
      assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
    });
  });

  // H1 (segunda metade) — `disconnect` grava status:"disabled" mas NÃO apaga o
  // integration_secrets; só o `forget` apaga. Checar o status depois do token
  // deixava "desconectar" como no-op: o proxy seguia com o api_token antigo.
  await t.step("desconectado com api_token ainda no banco não passa", async () => {
    const state = defaultState({
      tenantIntegration: { slug: "agent-platform", status: "disabled" },
    });
    const res = await call(state, { action: "agent.get", params: { agentId: "agent-1" } });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "AUTHENTICATION_FAILED",
      "code",
    );
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });

  await t.step("sem linha em tenant_integrations não passa nem com token do tenant", async () => {
    const state = defaultState({ tenantIntegration: null });
    const res = await call(state, { action: "agent.get", params: { agentId: "agent-1" } });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "AUTHENTICATION_FAILED",
      "code",
    );
    assertEquals(state.remoteCalls.length, 0, "não deve chamar o provedor");
  });

  await t.step("integração ativa continua caindo no token global", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({
        secrets: [],
        remote: [{ status: 200, body: { data: [] } }],
      });
      const res = await call(state, { action: "agents.list", params: { page: 1, pageSize: 10 } });
      assertEquals(res.json.error, undefined, "sem erro");
      assertEquals(state.remoteCalls.length, 1, "chamou o provedor");
    });
  });

  // H2 — em modo env o agents.list devolve o workspace COMPARTILHADO. Gravar
  // vínculo a partir dele fabricava exatamente as linhas que a checagem de posse
  // consulta para barrar: depois do primeiro "Sincronizar", um tenant editaria
  // agente de outro.
  await t.step("modo env não grava vínculo a partir do agents.list", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({
        secrets: [],
        remote: [{ status: 200, body: [{ id: "agent-de-outro", name: "Alheio" }] }],
      });
      const res = await call(state, { action: "agents.list", params: { page: 1, pageSize: 10 } });
      assertEquals(res.json.error, undefined, "leitura segue funcionando");
      const linkWrites = state.writes.filter((w) =>
        w.path === "/rest/v1/agent_platform_agent_links"
      );
      assertEquals(linkWrites.length, 0, "nenhum vínculo gravado em modo env");
      assertEquals(res.json.syncWarning, undefined, "não sincronizar não é falha");
    });
  });

  await t.step("credencial do tenant continua gravando vínculo no agents.list", async () => {
    const state = defaultState({
      remote: [{ status: 200, body: [{ id: "agent-1", name: "Meu" }] }],
    });
    await call(state, { action: "agents.list", params: { page: 1, pageSize: 10 } });
    const linkWrites = state.writes.filter((w) => w.path === "/rest/v1/agent_platform_agent_links");
    assertEquals(linkWrites.length, 1, "gravou o vínculo");
  });

  // H4 — 5xx do GoTrue não é sessão inválida. "Não autenticado." é terminal (o
  // cliente não repete) e a causa real não ia para lugar nenhum.
  await t.step("GoTrue instável vira erro retentável, não 'Não autenticado.'", async () => {
    const state = defaultState({ authOk: false, authFailStatus: 500 });
    const res = await call(state, { action: "agents.list", params: { page: 1, pageSize: 10 } });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "REMOTE_SERVER_ERROR",
      "code retentável",
    );
    const events = state.writes
      .filter((w) => w.path === "/rest/v1/system_events")
      .map((w) => w.body as Record<string, unknown>);
    assertEquals(events.length > 0, true, "gravou evento em system_events");
    assertEquals(events[0]?.operation, "agent-platform.proxy.auth", "operation do evento");
  });

  await t.step("JWT inválido continua sendo AUTHENTICATION_FAILED", async () => {
    const state = defaultState({ authOk: false, authFailStatus: 401 });
    const res = await call(state, { action: "agents.list", params: { page: 1, pageSize: 10 } });
    assertEquals(
      (res.json.error as Record<string, unknown>).code,
      "AUTHENTICATION_FAILED",
      "code",
    );
  });
});
