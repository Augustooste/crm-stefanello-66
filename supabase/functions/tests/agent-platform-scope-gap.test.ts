// Fronteira de posse do agent-platform-proxy: as rotas em que o id validado
// localmente NUNCA chega ao provedor.
//
// O teste anti-drift NÃO tem lista de nomes: recalcula a verdade a partir das
// próprias specs e compara com a flag `scopeGap`. Ação nova que nasça com o
// mesmo buraco quebra aqui em vez de passar no review.

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

import { type ActionSpec, AGENT_PLATFORM_ACTIONS } from "../_shared/agent-platform/actions.ts";

// Host fictício: o código não tem mais default de provedor.
const BASE = "https://provider.test";

setEnv(BASE_ENV);

// O código não tem mais base URL padrão (config ausente = erro explícito),
// então o ambiente de teste precisa declarar a dele.
Deno.env.set("AGENT_PLATFORM_API_BASE_URL", "https://provider.test");

const handler = await captureHandler("../agent-platform-proxy/index.ts");

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: esperado ${expected}, veio ${actual}`);
}

// --- verdade derivada das specs ---------------------------------------------

/** Ids cuja posse o proxy verifica em `assertResourceOwnership`. */
const OWNERSHIP_IDS = ["agentId", "channelId"] as const;
const MUTATING = new Set(["post", "put", "delete"]);

/** Params que o spec realmente entrega ao provedor: placeholders do path
 * (resolvidos pelo mapa `aliases`) mais a allowlist de query. */
function paramsReachingProvider(spec: ActionSpec): Set<string> {
  const fromPath = [...spec.path.matchAll(/\{([^}]+)\}/g)]
    .map((match) => spec.aliases?.[match[1]] ?? match[1]);
  return new Set<string>([...fromPath, ...(spec.query ?? [])]);
}

/** Um id opaco é qualquer chave `*Id`/`*id` que aponta para recurso do provedor e
 * que o proxy NÃO sabe verificar — só `agentId`/`channelId` têm tabela de vínculo,
 * e `workspaceId` é injetado pelo servidor. */
function isOpaqueId(key: string): boolean {
  return /id$/i.test(key) && key !== "workspaceId" &&
    !OWNERSHIP_IDS.includes(key as (typeof OWNERSHIP_IDS)[number]);
}

function hasScopeGap(spec: ActionSpec): boolean {
  const reaching = paramsReachingProvider(spec);

  // A rota é escopada quando o que chega ao provedor carrega ou o workspace
  // (injetado pelo servidor) ou um id cuja posse foi de fato verificada. Aí o
  // provedor resolve o recurso DENTRO desse escopo e não há fronteira a furar —
  // é o caso de `/v2/agent/{agentId}/transfer-rules/{transfer-rule-id}`.
  const escopado = reaching.has("workspaceId") || OWNERSHIP_IDS.some((id) => reaching.has(id));
  if (escopado) return false;

  // (a) sem escopo, e ainda assim um id opaco viaja para o provedor: quem
  // manda o id manda no recurso. `/v2/training/{trainingId}` é o formato.
  //
  // A derivação olha o que CHEGA ao provedor, não o que está em `required`.
  // Versão anterior deste teste partia de `required.includes("agentId")` e por
  // isso deixava passar o pior caso: uma ação nova que simplesmente NÃO pedisse
  // `agentId` (ex.: `training.get` com `required: ["trainingId"]`) nascia sem
  // flag e sem checagem — o gap que o teste existe para pegar.
  if ([...reaching, ...(spec.required ?? [])].some(isOpaqueId)) return true;

  // (b) sem escopo e sem id: ainda assim escreve no workspace remoto
  // compartilhado (ex.: `mcp.connect`, troca de código OAuth).
  return MUTATING.has(spec.method);
}

Deno.test("agent-platform: flag scopeGap bate com a verdade calculada das specs", () => {
  const faltando: string[] = [];
  const sobrando: string[] = [];
  for (const [name, spec] of Object.entries(AGENT_PLATFORM_ACTIONS)) {
    const esperado = hasScopeGap(spec);
    if (esperado && spec.scopeGap !== true) faltando.push(name);
    if (!esperado && spec.scopeGap === true) sobrando.push(name);
  }
  assertEquals(faltando.join(",") || "-", "-", "specs sem scopeGap:true que deveriam ter");
  assertEquals(sobrando.join(",") || "-", "-", "specs com scopeGap:true indevido");

  const marcadas = Object.values(AGENT_PLATFORM_ACTIONS).filter((s) => s.scopeGap === true).length;
  assertEquals(marcadas > 0, true, "a flag existe em pelo menos uma ação");
});

Deno.test("agent-platform: a regra discrimina (controle negativo + positivo)", () => {
  // Sonda negativa sozinha não prova nada: se `hasScopeGap` retornasse `true`
  // para tudo, o teste acima passaria igual. Os dois controles fixam que a regra
  // separa os casos — e o primeiro é o drift que a versão anterior deixou passar.
  const driftSemAgentId: ActionSpec = {
    method: "get",
    path: "/v2/training/{trainingId}",
    required: ["trainingId"],
    ownership: "agent",
  };
  assertEquals(hasScopeGap(driftSemAgentId), true, "id opaco sem escopo tem que ser pego");

  const escopadoPeloAgente: ActionSpec = {
    method: "put",
    path: "/v2/agent/{agentId}/transfer-rules/{transfer-rule-id}",
    aliases: { "transfer-rule-id": "transferRuleId" },
    required: ["agentId", "transferRuleId"],
    ownership: "agent",
  };
  assertEquals(
    hasScopeGap(escopadoPeloAgente),
    false,
    "id aninhado sob agentId verificado é seguro",
  );

  const leituraDoProprioToken: ActionSpec = {
    method: "get",
    path: "/v2/workspaces",
    ownership: "none",
    retryable: true,
  };
  assertEquals(hasScopeGap(leituraDoProprioToken), false, "listar o próprio workspace não é gap");
});

Deno.test("agent-platform: agentId sem placeholder é o formato clássico do gap", () => {
  // Âncora legível: se alguém "corrigir" a rota do contrato, o teste acima passa
  // a exigir a remoção da flag — este step diz por que ela existia.
  assertEquals(AGENT_PLATFORM_ACTIONS["training.update"].scopeGap, true, "training.update");
  assertEquals(AGENT_PLATFORM_ACTIONS["mcp.delete"].scopeGap, true, "mcp.delete");
  assertEquals(AGENT_PLATFORM_ACTIONS["customField.update"].scopeGap, true, "customField.update");
  assertEquals(AGENT_PLATFORM_ACTIONS["agent.get"].scopeGap, undefined, "agent.get tem fronteira");
  assertEquals(
    AGENT_PLATFORM_ACTIONS["workspaces.list"].scopeGap,
    undefined,
    "listagem pura do próprio token não é gap",
  );
});

// --- comportamento no proxy --------------------------------------------------

interface State {
  secrets: Array<{ key: string; value: string }>;
  agentLinks: string[];
  remoteCalls: number;
  writes: Array<{ path: string; body: unknown }>;
}

function defaultState(overrides: Partial<State> = {}): State {
  return {
    secrets: [
      { key: "api_token", value: "gm-token" },
      { key: "workspace_id", value: "ws-1" },
    ],
    agentLinks: ["agent-1"],
    remoteCalls: 0,
    writes: [],
    ...overrides,
  };
}

function router(state: State): FetchMatcher {
  return (req: MockRequest) => {
    if (req.url.startsWith(BASE)) {
      state.remoteCalls += 1;
      return jsonResponse(200, { ok: true });
    }
    if (req.pathname === "/auth/v1/user") {
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    const profile = { tenant_id: "tenant-1", role: "admin" };
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, [profile]);
    }
    const membership = activeMembershipResponse(req, profile);
    if (membership) return membership;
    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
      return jsonResponse(200, state.secrets);
    }
    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") {
      return jsonResponse(200, [{ slug: "agent-platform", status: "active" }]);
    }
    if (req.pathname === "/rest/v1/agent_platform_agent_links") {
      if (req.method === "GET") {
        const match = state.agentLinks.some((id) => req.url.includes(encodeURIComponent(id)));
        return jsonResponse(200, match ? [{ id: "link-1" }] : []);
      }
      state.writes.push({ path: req.pathname, body: req.bodyJson });
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/agent_platform_channel_links") {
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

async function call(
  state: State,
  body: unknown,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(
      new Request("http://fn.local", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer token-123" },
        body: JSON.stringify(body),
      }),
    );
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

function withGlobalToken<T>(fn: () => Promise<T>): Promise<T> {
  Deno.env.set("AGENT_PLATFORM_API_TOKEN", "token-global");
  Deno.env.set("AGENT_PLATFORM_WORKSPACE_ID", "ws-global");
  return fn().finally(() => {
    Deno.env.delete("AGENT_PLATFORM_API_TOKEN");
    Deno.env.delete("AGENT_PLATFORM_WORKSPACE_ID");
  });
}

Deno.test("agent-platform-proxy: scopeGap sob token global", async (t) => {
  await t.step("nega mesmo com vínculo de posse válido", async () => {
    await withGlobalToken(async () => {
      // O vínculo do agentId existe: sem o gate, a mutação sairia escopada só
      // pelo trainingId — que pode ser de outro tenant do token compartilhado.
      const state = defaultState({ secrets: [], agentLinks: ["agent-1"] });
      const res = await call(state, {
        action: "training.update",
        params: { agentId: "agent-1", trainingId: "training-da-vitima" },
        body: { text: "novo" },
      });
      const error = res.json.error as Record<string, unknown>;
      assertEquals(res.status, 200, "envelope em 200");
      assertEquals(error.code, "FORBIDDEN", "code");
      assertEquals(String(error.message).includes("Integrações"), true, "mensagem PT-BR orienta");
      assertEquals(state.remoteCalls, 0, "não deve chamar o provedor");
      assertEquals(auditEntries(state)[0]?.status, "denied", "auditoria denied");
      assertEquals(auditEntries(state)[0]?.error_code, "FORBIDDEN", "auditoria error_code");
    });
  });

  await t.step("nega rota sem fronteira nenhuma (customField.update)", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({ secrets: [] });
      const res = await call(state, {
        action: "customField.update",
        params: { customfieldId: "cf-de-outro" },
        body: { name: "x" },
      });
      assertEquals((res.json.error as Record<string, unknown>).code, "FORBIDDEN", "code");
      assertEquals(state.remoteCalls, 0, "não deve chamar o provedor");
    });
  });

  await t.step("ação com fronteira real continua passando", async () => {
    await withGlobalToken(async () => {
      const state = defaultState({ secrets: [], agentLinks: ["agent-1"] });
      const res = await call(state, { action: "agent.get", params: { agentId: "agent-1" } });
      assertEquals(res.json.error, undefined, "sem erro");
      assertEquals(state.remoteCalls, 1, "chamou o provedor");
    });
  });
});

Deno.test("agent-platform-proxy: scopeGap com token do próprio tenant segue normal", async (t) => {
  await t.step("training.update chega ao provedor", async () => {
    const state = defaultState();
    const res = await call(state, {
      action: "training.update",
      params: { agentId: "agent-1", trainingId: "training-1" },
      body: { text: "novo" },
    });
    assertEquals(res.json.error, undefined, "sem erro");
    assertEquals(state.remoteCalls, 1, "chamou o provedor");
    assertEquals(auditEntries(state)[0]?.status, "ok", "auditoria ok");
  });

  await t.step("trust-on-first-use ainda vincula agente novo", async () => {
    const state = defaultState({ agentLinks: [] });
    const res = await call(state, {
      action: "mcp.tools.list",
      params: { agentId: "agent-novo", mcpId: "mcp-1" },
    });
    assertEquals(res.json.error, undefined, "sem erro");
    assertEquals(state.remoteCalls, 1, "chamou o provedor");
    const vinculo = state.writes.some((w) => w.path === "/rest/v1/agent_platform_agent_links");
    assertEquals(vinculo, true, "gravou o vínculo sob demanda");
  });
});
