import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

// Host fictício: o código não tem mais default de provedor.
const AGENT_PLATFORM_DEFAULT_BASE_URL = "https://provider.test";

setEnv(BASE_ENV);

// O código não tem mais base URL padrão (config ausente = erro explícito),
// então o ambiente de teste precisa declarar a dele.
Deno.env.set("AGENT_PLATFORM_API_BASE_URL", "https://provider.test");

const handler = await captureHandler("../integration-connect/index.ts");
const { formatBrasiliaTime } = await import("../integration-connect/index.ts");

interface Catalog {
  slug: string;
  available: boolean;
  required_secrets?: Array<{ key: string; optional?: boolean }>;
}

interface ProviderMock {
  status: number;
  body?: unknown;
  rawBody?: string;
  throwMsg?: string;
  /** Qual das duas mensagens de deadline lançar — ver providerResponse. */
  throwTimeout?: "reason" | "fetch";
  /** No Deno a falha de rede do fetch (DNS, conexão recusada, TLS) rejeita com
   * TypeError, não com Error — é o caso que a ordem antiga do catch classificava
   * como "caractere inválido no campo". */
  throwTypeError?: string;
}

interface EvolutionStatusMock {
  status: number;
  body?: unknown;
}

interface EvolutionReconnectMock {
  status: number;
}

interface EvolutionQrMock {
  status: number;
  body?: unknown;
}

interface State {
  authOk: boolean;
  profile: { tenant_id: string; role: string } | null;
  catalog: Catalog | null;
  existingSecrets: Array<{ key: string; value: string }>;
  secretsFetchError: boolean;
  existingWebhookToken: string | null;
  existingChannelId: string | null;
  insertedChannelId: string;
  existingChannelWebhookToken: string | null;
  channelWrites: Array<{ method: string; body: Record<string, unknown> }>;
  tenantIntegrationWrites: Array<Record<string, unknown>>;
  providerRequests: Array<{ url: string; authorization: string | null }>;
  systemEventsInsertBodies: Array<Record<string, unknown>>;
  zapi: ProviderMock;
  twilio: ProviderMock;
  resend: ProviderMock;
  elevenlabs: ProviderMock;
  llamacloud: ProviderMock;
  metaCloud: ProviderMock;
  feegow: ProviderMock;
  apify: ProviderMock;
  agentPlatform: ProviderMock;
  evolutionStatus: EvolutionStatusMock;
  evolutionReconnect: EvolutionReconnectMock;
  evolutionQr: EvolutionQrMock;
  /** Faz o UPDATE de `channels` falhar. Existe para o teste de regressão do
   * webhook_token: sem ele não há como exercitar o ramo de erro. */
  channelUpdateFails: boolean;
  /** Status atual do canal, lido pelo caminho de reconnect. */
  existingChannelStatus: string | null;
  zappazSession: ProviderMock;
  zappazWebhook: ProviderMock;
  /** Corpo de cada POST de registro de webhook na Zappaz — é onde a callbackUrl
   * (e portanto o token) trafega. */
  zappazWebhookBodies: Array<Record<string, unknown>>;
  aiSettings: { voice_reply_mode: string; voice_id: string | null; voice_model: string | null } | null;
}

const CATALOGS: Record<string, Catalog> = {
  zapi: {
    slug: "zapi",
    available: true,
    required_secrets: [{ key: "instance_id" }, { key: "instance_token" }, { key: "client_token" }],
  },
  twilio: {
    slug: "twilio",
    available: true,
    required_secrets: [{ key: "account_sid" }, { key: "auth_token" }, { key: "whatsapp_number" }],
  },
  resend: {
    slug: "resend",
    available: true,
    required_secrets: [{ key: "api_key" }, { key: "from_domain" }],
  },
  elevenlabs: {
    slug: "elevenlabs",
    available: true,
    required_secrets: [{ key: "api_key" }],
  },
  llamacloud: {
    slug: "llamacloud",
    available: true,
    required_secrets: [{ key: "api_key" }],
  },
  "meta-cloud": {
    slug: "meta-cloud",
    available: true,
    required_secrets: [{ key: "access_token" }, { key: "phone_number_id" }],
  },
  evolution: {
    slug: "evolution",
    available: true,
    required_secrets: [
      { key: "api_url" },
      { key: "instance_name" },
      { key: "api_key" },
      { key: "instance_token", optional: true },
    ],
  },
  doutore: {
    slug: "doutore",
    available: true,
    required_secrets: [],
  },
  "meta-ads": {
    slug: "meta-ads",
    available: true,
    required_secrets: [{ key: "access_token" }, { key: "app_secret" }],
  },
  feegow: {
    slug: "feegow",
    available: true,
    required_secrets: [{ key: "clinic_id" }, { key: "access_token" }],
  },
  apify: {
    slug: "apify",
    available: true,
    required_secrets: [{ key: "api_token" }],
  },
  "agent-platform": {
    slug: "agent-platform",
    available: true,
    required_secrets: [{ key: "api_token" }, { key: "workspace_id" }],
  },
};

const VALUES: Record<string, Record<string, string>> = {
  zapi: { instance_id: "inst-1", instance_token: "tok-1", client_token: "ct-1" },
  twilio: { account_sid: "AC123", auth_token: "auth-tok", whatsapp_number: "+551199999999" },
  resend: { api_key: "re_123", from_domain: "acme.com" },
  elevenlabs: { api_key: "el_123" },
  llamacloud: { api_key: "llx_123" },
  "meta-cloud": { access_token: "meta-tok", phone_number_id: "551199999999" },
  evolution: {
    api_url: "https://evo.example.com",
    instance_name: "inst-evo",
    api_key: "evo-key-123",
    instance_token: "instance-token-123",
  },
  doutore: {},
  "meta-ads": { access_token: "meta-ads-tok", app_secret: "shh-secret" },
  feegow: { clinic_id: "clinic-1", access_token: "feegow-tok" },
  apify: { api_token: "apify_api_testtoken" },
  "agent-platform": { api_token: "gm-tok", workspace_id: "ws-1" },
};

function defaultState(): State {
  return {
    authOk: true,
    profile: { tenant_id: "tenant-1", role: "admin" },
    catalog: CATALOGS.zapi,
    existingSecrets: [],
    secretsFetchError: false,
    existingWebhookToken: null,
    existingChannelId: null,
    insertedChannelId: "ch-new-1",
    existingChannelWebhookToken: null,
    channelWrites: [],
    tenantIntegrationWrites: [],
    providerRequests: [],
    systemEventsInsertBodies: [],
    zapi: { status: 200, body: { connected: true } },
    twilio: { status: 200, body: {} },
    resend: { status: 200, body: { data: [{ name: "acme.com", status: "verified" }] } },
    elevenlabs: { status: 200, body: {} },
    llamacloud: { status: 200, body: { projects: [] } },
    metaCloud: { status: 200, body: {} },
    feegow: { status: 200, body: { success: true, content: [] } },
    apify: {
      status: 200,
      body: { data: { plan: { enabledPlatformFeatures: ["ACTORS_PUBLIC_ALL"] } } },
    },
    agentPlatform: { status: 200, body: [{ id: "ws-1", name: "Workspace" }] },
    evolutionStatus: { status: 200, body: { data: { Connected: true } } },
    evolutionReconnect: { status: 200 },
    evolutionQr: { status: 200, body: { data: {} } },
    channelUpdateFails: false,
    existingChannelStatus: null,
    zappazSession: { status: 200, body: { id: "sess-1" } },
    zappazWebhook: { status: 200, body: { ok: true } },
    zappazWebhookBodies: [],
    aiSettings: null,
  };
}

function providerResponse(mock: ProviderMock): Response {
  // As duas mensagens que um deadline produz na prática, ambas com name
  // "TimeoutError": o `reason` do próprio AbortSignal.timeout ("Signal timed
  // out.", que NÃO contém o substring "timeout" procurado por isNetworkError) e
  // a que o fetch do Deno 2.9 rejeita (contém). Medidas, não supostas — só o
  // ramo por `name` cobre as duas.
  if (mock.throwTimeout) {
    throw new DOMException(
      mock.throwTimeout === "reason"
        ? "Signal timed out."
        : "The operation was aborted due to timeout",
      "TimeoutError",
    );
  }
  if (mock.throwTypeError) throw new TypeError(mock.throwTypeError);
  if (mock.throwMsg) throw new Error(mock.throwMsg);
  if (mock.rawBody !== undefined) return new Response(mock.rawBody, { status: mock.status });
  return jsonResponse(mock.status, mock.body ?? {});
}

function router(state: State): FetchMatcher {
  return (req) => {
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) return jsonResponse(401, { msg: "invalid token" });
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
      // Sink de telemetria (captureEdgeError via reportError). Sem esta rota o
      // mock respondia 501 e o rastro que este PR adiciona não era exercitado.
      state.systemEventsInsertBodies.push((req.bodyJson as Record<string, unknown>) ?? {});
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/integrations" && req.method === "GET") {
      return jsonResponse(200, state.catalog ? [state.catalog] : []);
    }
    if (req.pathname === "/rest/v1/integration_secrets") {
      if (req.method === "GET") {
        if (state.secretsFetchError) return jsonResponse(500, { message: "boom" });
        return jsonResponse(200, state.existingSecrets);
      }
      return emptyResponse(200);
    }
    if (req.pathname === "/rest/v1/tenant_integrations") {
      if (req.method === "GET") {
        if (req.url.includes("slug=eq.elevenlabs")) {
          return jsonResponse(200, [{ status: "active" }]);
        }
        return jsonResponse(
          200,
          state.existingWebhookToken ? [{ webhook_token: state.existingWebhookToken }] : [],
        );
      }
      state.tenantIntegrationWrites.push((req.bodyJson as Record<string, unknown>) ?? {});
      return emptyResponse(200);
    }
    if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
      return jsonResponse(200, state.aiSettings ? [state.aiSettings] : []);
    }
    if (req.pathname === "/rest/v1/channels") {
      if (req.method === "GET") {
        return jsonResponse(
          200,
          state.existingChannelId
            ? [{
              id: state.existingChannelId,
              webhook_token: state.existingChannelWebhookToken,
              status: state.existingChannelStatus,
              config: {},
            }]
            : [],
        );
      }
      state.channelWrites.push({
        method: req.method,
        body: (req.bodyJson as Record<string, unknown>) ?? {},
      });
      if (state.channelUpdateFails && req.method === "PATCH") {
        return jsonResponse(500, { message: "canal indisponível para escrita" });
      }
      // POST com `.select("id")` retorna a linha criada no PostgREST real — o mock
      // devolvia corpo vazio, o que fazia o handler achar que o insert não criou
      // canal. Devolve um id sintético para refletir o comportamento real.
      if (req.method === "POST") {
        return jsonResponse(200, { id: state.insertedChannelId });
      }
      return emptyResponse(200);
    }
    if (req.pathname === "/rest/v1/channel_status_events" && req.method === "POST") {
      return jsonResponse(201, []);
    }
    if (req.url.includes("api.zappaz.io")) {
      state.providerRequests.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
      });
      if (req.pathname.endsWith("/webhook")) {
        state.zappazWebhookBodies.push((req.bodyJson as Record<string, unknown>) ?? {});
        return providerResponse(state.zappazWebhook);
      }
      return providerResponse(state.zappazSession);
    }
    if (req.url.includes("api.z-api.io")) return providerResponse(state.zapi);
    if (req.url.includes("api.twilio.com")) return providerResponse(state.twilio);
    if (req.url.includes("api.resend.com")) return providerResponse(state.resend);
    if (req.url.includes("api.elevenlabs.io")) return providerResponse(state.elevenlabs);
    if (req.url.startsWith(AGENT_PLATFORM_DEFAULT_BASE_URL)) {
      return providerResponse(state.agentPlatform);
    }
    if (req.url.includes("llamaindex.ai")) {
      state.providerRequests.push({
        url: req.url,
        authorization: req.headers.get("authorization"),
      });
      return providerResponse(state.llamacloud);
    }
    if (req.url.includes("graph.facebook.com")) return providerResponse(state.metaCloud);
    if (req.url.includes("api.feegow.com")) return providerResponse(state.feegow);
    if (req.url.includes("api.apify.com")) return providerResponse(state.apify);
    if (req.pathname.endsWith("/instance/status") && req.method === "GET") {
      return jsonResponse(state.evolutionStatus.status, state.evolutionStatus.body ?? {});
    }
    if (req.pathname.endsWith("/instance/reconnect") && req.method === "POST") {
      return new Response("{}", { status: state.evolutionReconnect.status });
    }
    if (req.pathname.endsWith("/instance/qr") && req.method === "GET") {
      return jsonResponse(state.evolutionQr.status, state.evolutionQr.body ?? {});
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

function connectBody(slug: string, values?: Record<string, string>): Record<string, unknown> {
  return values === undefined ? { action: "connect", slug } : { action: "connect", slug, values };
}

async function runConnect(
  state: State,
  slug: string,
  values?: Record<string, string>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  // Garante que o catálogo bate com o slug testado, a menos que o teste já
  // tenha customizado um catálogo daquele mesmo slug (ex.: required_secrets parcial).
  if (!state.catalog || state.catalog.slug !== slug) state.catalog = CATALOGS[slug];
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(req(connectBody(slug, values)));
    const body = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body };
  } finally {
    uninstall();
  }
}

Deno.test("integration-connect", async (t) => {
  // ---- validação estrutural / auth ----

  await t.step("mensagem de teste usa explicitamente o horário de Brasília", () => {
    const instant = new Date("2026-09-17T15:34:32.000Z");
    if (formatBrasiliaTime(instant) !== "12:34:32") {
      throw new Error(`horário inesperado: ${formatBrasiliaTime(instant)}`);
    }
  });

  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (await res.text()) throw new Error("esperado corpo vazio");
    } finally {
      uninstall();
    }
  });

  await t.step("método não-POST retorna 405", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "GET" }));
      if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("sem usuário autenticado retorna 401", async () => {
    const state = defaultState();
    state.authOk = false;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(connectBody("zapi", VALUES.zapi)));
      const body = await res.json();
      if (res.status !== 401 || body.error !== "Não autenticado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem perfil retorna 403 'Perfil não encontrado'", async () => {
    const state = defaultState();
    state.profile = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(connectBody("zapi", VALUES.zapi)));
      const body = await res.json();
      if (res.status !== 403 || body.error !== "Perfil não encontrado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("perfil não-admin retorna 403 'Apenas administradores'", async () => {
    const state = defaultState();
    state.profile = { tenant_id: "tenant-1", role: "vendedor" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(connectBody("zapi", VALUES.zapi)));
      const body = await res.json();
      if (res.status !== 403 || body.error !== "Apenas administradores.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("corpo inválido (JSON quebrado) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request("http://fn.local", {
          method: "POST",
          headers: { Authorization: "Bearer x", "content-type": "application/json" },
          body: "{not-json",
        }),
      );
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Corpo inválido.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("action e slug ausentes retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({}));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "action e slug são obrigatórios.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("slug não encontrado no catálogo retorna 404", async () => {
    const state = defaultState();
    state.catalog = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ action: "connect", slug: "inexistente" }));
      const body = await res.json();
      if (res.status !== 404 || body.error !== "Integração não encontrada.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("integração ainda não disponível retorna 400", async () => {
    const state = defaultState();
    state.catalog = { ...CATALOGS.zapi, available: false };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(connectBody("zapi", VALUES.zapi)));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Integração ainda não disponível.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  // A ação 'test' JÁ é implementada (revalida credenciais persistidas). O teste
  // antes assertava o default "Ação inválida" — asserção stale que passou a falhar
  // quando a ação foi construída. Agora cobre o comportamento real: sem segredos
  // gravados, devolve 200 com ok:false e mensagem acionável.
  await t.step("ação 'test' sem credenciais salvas devolve erro amigável", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ action: "test", slug: "zapi" }));
      const body = await res.json();
      if (
        res.status !== 200 ||
        body.ok !== false ||
        !String(body.error).includes("Nada configurado")
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("teste manual envia áudio com voz salva mesmo quando o modo automático está off", async () => {
    const state = defaultState();
    state.catalog = CATALOGS.zapi;
    state.existingChannelId = "channel-zapi-1";
    state.existingChannelStatus = "connected";
    state.existingSecrets = [
      ...Object.entries(VALUES.zapi).map(([key, value]) => ({ key, value })),
      { key: "api_key", value: "eleven-key" },
    ];
    state.aiSettings = {
      voice_reply_mode: "off",
      voice_id: "voz-salva",
      voice_model: "eleven_multilingual_v2",
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ action: "test_messaging", slug: "zapi", phone: "5511999998888" }));
      const body = await res.json();
      const steps = body.steps as Array<{ step: string; state: string }>;
      const audio = steps.find((step) => step.step === "audio");
      if (res.status !== 200 || body.ok !== true || audio?.state !== "ok") {
        throw new Error(`esperava áudio enviado, veio ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "usa SUPABASE_PUBLISHABLE_KEY quando SUPABASE_ANON_KEY não está definida",
    async () => {
      Deno.env.delete("SUPABASE_ANON_KEY");
      setEnv({ SUPABASE_PUBLISHABLE_KEY: "publishable-key" });
      const uninstall = installFetchMock(router(defaultState()));
      try {
        const res = await handler(req(connectBody("zapi", VALUES.zapi)));
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
        Deno.env.delete("SUPABASE_PUBLISHABLE_KEY");
        setEnv(BASE_ENV);
      }
    },
  );

  // ---- connect: validação de campos / merge de segredos ----

  // 200 + {ok:false}, não 400: `functions.invoke` descarta o corpo em resposta
  // não-2xx, então um 400 fazia a lista de campos faltando sumir da tela e o
  // admin via só "Edge Function returned a non-2xx status code".
  await t.step(
    "connect com campos obrigatórios faltando retorna 200 {ok:false} 'Preencha:'",
    async () => {
      const state = defaultState();
      const { status, body } = await runConnect(state, "zapi");
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha: instance_id, instance_token, client_token"
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "connect reconecta usando segredos já salvos (values vazio, merge com existingRows)",
    async () => {
      const state = defaultState();
      state.catalog = CATALOGS.twilio;
      state.existingSecrets = Object.entries(VALUES.twilio).map(([key, value]) => ({ key, value }));
      state.existingWebhookToken = "webhook-existente";
      state.existingChannelId = "chan-1";
      const { status, body } = await runConnect(state, "twilio", {});
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "connect novo (sem segredos existentes) persiste, minta webhook_token e cria canal",
    async () => {
      const state = defaultState();
      const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  // Antes o erro de leitura caía num fallback vazio: no melhor caso o admin
  // recebia "Preencha: ..." por uma falha de infra; no pior, um reconnect com
  // `values` parcial sobrescrevia segredos salvos. Agora é fail-closed.
  await t.step(
    "erro ao buscar segredos existentes aborta o connect com mensagem de instabilidade",
    async () => {
      const state = defaultState();
      state.secretsFetchError = true;
      const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
      if (status !== 200 || body.ok !== false || !String(body.error).includes("Instabilidade")) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      // Prova que o rastro em system_events realmente é gravado (o console.error
      // sozinho some com o isolate). Vale por todos os call-sites: é o mesmo
      // helper `reportError` em todos eles.
      const ev = state.systemEventsInsertBodies;
      if (ev.length !== 1 || ev[0].operation !== "integration-connect.connect.ler_segredos") {
        throw new Error(`telemetria inesperada: ${JSON.stringify(ev)}`);
      }
    },
  );

  await t.step(
    "connect com integração de e-mail (resend) cria canal do tipo email sem exclusividade whatsapp",
    async () => {
      const state = defaultState();
      const { status, body } = await runConnect(state, "resend", VALUES.resend);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "connect com integração sem canal associado (elevenlabs) não sincroniza channels",
    async () => {
      const state = defaultState();
      const { status, body } = await runConnect(state, "elevenlabs", VALUES.elevenlabs);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "connect meta-cloud com canal existente atualiza (não insere); múltiplos provedores de WhatsApp coexistem",
    async () => {
      const state = defaultState();
      state.existingChannelId = "chan-2";
      const { status, body } = await runConnect(state, "meta-cloud", VALUES["meta-cloud"]);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "connect com slug disponível no catálogo mas sem handler de teste retorna 'Integração não suportada'",
    async () => {
      const state = defaultState();
      state.catalog = { slug: "outra-integracao", available: true, required_secrets: [] };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req(connectBody("outra-integracao", {})));
        const body = await res.json();
        if (res.status !== 200 || body.ok !== false || body.error !== "Integração não suportada.") {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // ---- disconnect / forget ----

  await t.step("disconnect desativa integração e canal, retorna ok", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ action: "disconnect", slug: "zapi" }));
      const body = await res.json();
      if (res.status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "forget apaga segredos, zera config da integração e do canal, retorna ok",
    async () => {
      const uninstall = installFetchMock(router(defaultState()));
      try {
        const res = await handler(req({ action: "forget", slug: "zapi" }));
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // ---- testZapi ----

  await t.step(
    "zapi: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = { slug: "zapi", available: true, required_secrets: [{ key: "instance_id" }] };
      const { status, body } = await runConnect(state, "zapi", { instance_id: "only-one" });
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("zapi: status 401 do provedor retorna client token inválido", async () => {
    const state = defaultState();
    state.zapi = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "Client Token da conta inválido — confira em Segurança > Token da conta no painel Z-API."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: status 404 do provedor retorna instance id/token inválido", async () => {
    const state = defaultState();
    state.zapi = { status: 404, body: {} };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "Instance ID ou Instance Token inválido — confira no topo da instância e na aba Segurança do painel Z-API."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.zapi = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: corpo 'instance not found' retorna instance id/token inválido", async () => {
    const state = defaultState();
    state.zapi = { status: 200, body: { message: "Instance not found" } };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      !String(body.error).includes("Instance ID ou Instance Token inválido")
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: corpo com 'token' + 'invalid' retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.zapi = { status: 200, body: { message: "Invalid Token provided" } };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      !String(body.error).includes("Credenciais inválidas")
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: connected:false retorna instância desconectada", async () => {
    const state = defaultState();
    state.zapi = { status: 200, body: { connected: false } };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "A instância existe mas está desconectada — leia o QR Code no painel da Z-API e tente de novo."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: campo error no corpo retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.zapi = { status: 200, body: { error: "algo deu errado" } };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      !String(body.error).includes("Credenciais inválidas")
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: resposta não-JSON cai no fallback e segue como conectado", async () => {
    const state = defaultState();
    state.zapi = { status: 200, rawBody: "not-json{" };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: falha de rede (timeout) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.zapi = { status: 200, throwMsg: "connection timeout" };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: deadline estourado retorna mensagem de rede, não credenciais", async () => {
    const state = defaultState();
    state.zapi = { status: 200, throwTimeout: "reason" };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: falha inesperada (não-rede) retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.zapi = { status: 200, throwMsg: "boom inesperado" };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (
      status !== 200 ||
      body.ok !== false ||
      !String(body.error).includes("Credenciais inválidas")
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("zapi: caminho feliz conecta com sucesso", async () => {
    const state = defaultState();
    state.zapi = { status: 200, body: { connected: true } };
    const { status, body } = await runConnect(state, "zapi", VALUES.zapi);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testTwilio ----

  await t.step(
    "twilio: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = {
        slug: "twilio",
        available: true,
        required_secrets: [{ key: "account_sid" }],
      };
      const { status, body } = await runConnect(state, "twilio", { account_sid: "AC1" });
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("twilio: status 401 do provedor retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.twilio = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "twilio", VALUES.twilio);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "Credenciais inválidas — confira o Account SID e o Auth Token no console da Twilio."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("twilio: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.twilio = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "twilio", VALUES.twilio);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("twilio: falha de rede (dns) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.twilio = { status: 200, throwMsg: "dns lookup failed" };
    const { status, body } = await runConnect(state, "twilio", VALUES.twilio);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("twilio: falha inesperada (não-rede) retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.twilio = { status: 200, throwMsg: "boom inesperado" };
    const { status, body } = await runConnect(state, "twilio", VALUES.twilio);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "Credenciais inválidas — confira o Account SID e o Auth Token no console da Twilio."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("twilio: caminho feliz conecta com sucesso", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "twilio", VALUES.twilio);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testResend ----

  await t.step(
    "resend: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = { slug: "resend", available: true, required_secrets: [{ key: "api_key" }] };
      const { status, body } = await runConnect(state, "resend", { api_key: "re_1" });
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("resend: status 401 do provedor retorna API key inválida", async () => {
    const state = defaultState();
    state.resend = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "resend", VALUES.resend);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "API Key inválida — gere uma nova em API Keys no painel do Resend."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("resend: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.resend = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "resend", VALUES.resend);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "resend: resposta não-JSON cai no fallback (domains vazio) e retorna domínio não verificado",
    async () => {
      const state = defaultState();
      state.resend = { status: 200, rawBody: "not-json{" };
      const { status, body } = await runConnect(state, "resend", VALUES.resend);
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !==
          "O domínio informado não está verificado no Resend — verifique-o em Domains e tente de novo."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("resend: domínio encontrado mas não verificado retorna aviso", async () => {
    const state = defaultState();
    state.resend = { status: 200, body: { data: [{ name: "acme.com", status: "pending" }] } };
    const { status, body } = await runConnect(state, "resend", VALUES.resend);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "O domínio informado não está verificado no Resend — verifique-o em Domains e tente de novo."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("resend: falha de rede (failed to fetch) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.resend = { status: 200, throwMsg: "failed to fetch" };
    const { status, body } = await runConnect(state, "resend", VALUES.resend);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("resend: falha inesperada (não-rede) retorna API key inválida", async () => {
    const state = defaultState();
    state.resend = { status: 200, throwMsg: "boom inesperado" };
    const { status, body } = await runConnect(state, "resend", VALUES.resend);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "API Key inválida — gere uma nova em API Keys no painel do Resend."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("resend: domínio verificado conecta com sucesso", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "resend", VALUES.resend);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testElevenLabs ----

  await t.step(
    "elevenlabs: sem required_secrets no catálogo (fallback []) retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = { slug: "elevenlabs", available: true, required_secrets: undefined };
      const { status, body } = await runConnect(state, "elevenlabs", {});
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("elevenlabs: status 401 do provedor retorna API key inválida", async () => {
    const state = defaultState();
    state.elevenlabs = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "elevenlabs", VALUES.elevenlabs);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "API Key inválida — gere uma nova em API Keys no painel da ElevenLabs, com permissão de Text to Speech habilitada."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("elevenlabs: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.elevenlabs = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "elevenlabs", VALUES.elevenlabs);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("elevenlabs: falha de rede (network) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.elevenlabs = { status: 200, throwMsg: "network error occurred" };
    const { status, body } = await runConnect(state, "elevenlabs", VALUES.elevenlabs);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("elevenlabs: falha inesperada (não-rede) retorna API key inválida", async () => {
    const state = defaultState();
    state.elevenlabs = { status: 200, throwMsg: "boom inesperado" };
    const { status, body } = await runConnect(state, "elevenlabs", VALUES.elevenlabs);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "API Key inválida — gere uma nova em API Keys no painel da ElevenLabs, com permissão de Text to Speech habilitada."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("elevenlabs: caminho feliz conecta com sucesso (sem canal associado)", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "elevenlabs", VALUES.elevenlabs);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testLlamaCloud ----

  await t.step(
    "llamacloud: região desconhecida cai na detecção automática (NA primeiro)",
    async () => {
      // O LlamaCloud não expõe a região na UI dele, então o formulário não pede
      // mais esse campo: valor estranho é ignorado e a região é descoberta.
      const state = defaultState();
      const { status, body } = await runConnect(state, "llamacloud", {
        api_key: "llx_123",
        region: "ap",
      });
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      const providerRequest = state.providerRequests.at(-1);
      if (providerRequest?.url !== "https://api.cloud.llamaindex.ai/api/v1/projects") {
        throw new Error(`deveria ter detectado NA: ${JSON.stringify(providerRequest)}`);
      }
      const activeWrite = state.tenantIntegrationWrites.find((write) => write.status === "active");
      const config = activeWrite?.config as Record<string, unknown> | undefined;
      if (config?.region !== "na") {
        throw new Error(`região detectada não persistida: ${JSON.stringify(activeWrite)}`);
      }
    },
  );

  await t.step("llamacloud: 401 em todas as regiões identifica chave inválida", async () => {
    const state = defaultState();
    state.llamacloud = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "llamacloud", { api_key: "llx_123" });
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "API Key inválida ou sem permissão no LlamaCloud."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    // Tentou as duas regiões antes de desistir.
    if (state.providerRequests.filter((r) => r.url.includes("llamaindex.ai")).length !== 2) {
      throw new Error(`deveria varrer as duas regiões: ${JSON.stringify(state.providerRequests)}`);
    }
  });

  await t.step("llamacloud: caminho feliz detecta e persiste a região", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "llamacloud", VALUES.llamacloud);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    const providerRequest = state.providerRequests.at(-1);
    if (
      providerRequest?.url !== "https://api.cloud.llamaindex.ai/api/v1/projects" ||
      providerRequest.authorization !== "Bearer llx_123"
    ) {
      throw new Error(`request LlamaCloud incorreto: ${JSON.stringify(providerRequest)}`);
    }
    const activeWrite = state.tenantIntegrationWrites.find((write) => write.status === "active");
    const config = activeWrite?.config as Record<string, unknown> | undefined;
    if (
      config?.region !== "na" ||
      config.base_url !== "https://api.cloud.llamaindex.ai"
    ) {
      throw new Error(`config regional não persistido: ${JSON.stringify(activeWrite)}`);
    }
  });

  // ---- testMetaCloud ----

  await t.step(
    "meta-cloud: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = {
        slug: "meta-cloud",
        available: true,
        required_secrets: [{ key: "access_token" }],
      };
      const { status, body } = await runConnect(state, "meta-cloud", { access_token: "tok" });
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("meta-cloud: status 401 do provedor retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.metaCloud = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "meta-cloud", VALUES["meta-cloud"]);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "Credenciais inválidas — confira o Access Token e o Phone Number ID no painel do app da Meta."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("meta-cloud: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.metaCloud = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "meta-cloud", VALUES["meta-cloud"]);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("meta-cloud: falha de rede (econn) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.metaCloud = { status: 200, throwMsg: "ECONNRESET" };
    const { status, body } = await runConnect(state, "meta-cloud", VALUES["meta-cloud"]);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "meta-cloud: falha inesperada (não-rede) retorna credenciais inválidas",
    async () => {
      const state = defaultState();
      state.metaCloud = { status: 200, throwMsg: "boom inesperado" };
      const { status, body } = await runConnect(state, "meta-cloud", VALUES["meta-cloud"]);
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !==
          "Credenciais inválidas — confira o Access Token e o Phone Number ID no painel do app da Meta."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("meta-cloud: caminho feliz conecta com sucesso", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "meta-cloud", VALUES["meta-cloud"]);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testDoutore (sem required_secrets -- nada a validar) ----

  await t.step("doutore: caminho feliz conecta com sucesso sem nenhuma credencial", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "doutore", VALUES.doutore);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testMetaAds ----

  await t.step(
    "meta-ads: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = {
        slug: "meta-ads",
        available: true,
        required_secrets: [{ key: "access_token" }],
      };
      const { status, body } = await runConnect(state, "meta-ads", { access_token: "tok" });
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("meta-ads: status 401 do provedor retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.metaCloud = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "meta-ads", VALUES["meta-ads"]);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Credenciais inválidas — confira o Access Token no Meta Business Suite."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("meta-ads: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.metaCloud = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "meta-ads", VALUES["meta-ads"]);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // testMetaAds não tem ramo `instanceof TypeError`: depende só de isNetworkError
  // para não classificar um deadline estourado como credencial inválida.
  await t.step("meta-ads: deadline estourado retorna mensagem de rede", async () => {
    const state = defaultState();
    state.metaCloud = { status: 200, throwTimeout: "fetch" };
    const { status, body } = await runConnect(state, "meta-ads", VALUES["meta-ads"]);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("meta-ads: caminho feliz conecta com sucesso", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "meta-ads", VALUES["meta-ads"]);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testFeegow ----

  await t.step(
    "feegow: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = {
        slug: "feegow",
        available: true,
        required_secrets: [{ key: "clinic_id" }],
      };
      const { status, body } = await runConnect(state, "feegow", { clinic_id: "clinic-1" });
      if (
        status !== 200 ||
        body.ok !== false ||
        body.error !== "Preencha todos os campos obrigatórios."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("feegow: status 401 do provedor retorna credenciais inválidas", async () => {
    const state = defaultState();
    state.feegow = { status: 401, body: { message: "invalid token" } };
    const { status, body } = await runConnect(state, "feegow", VALUES.feegow);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !==
        "Credenciais inválidas — confira o ID da clínica e o Access Token no painel do Feegow."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("feegow: erro HTTP genérico (500) retorna mensagem de rede", async () => {
    const state = defaultState();
    state.feegow = { status: 500, body: {} };
    const { status, body } = await runConnect(state, "feegow", VALUES.feegow);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("feegow: caminho feliz conecta com sucesso", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "feegow", VALUES.feegow);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testApify ----

  await t.step("apify: status 401 retorna token inválido", async () => {
    const state = defaultState();
    state.apify = { status: 401, body: {} };
    const { status, body } = await runConnect(state, "apify", VALUES.apify);
    if (status !== 200 || body.ok !== false || !String(body.error).includes("API token inválido")) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("apify: plano sem ACTORS_PUBLIC_ALL (Creator) é barrado no connect", async () => {
    const state = defaultState();
    state.apify = {
      status: 200,
      body: { data: { plan: { enabledPlatformFeatures: ["ACTORS_PUBLIC_DEVELOPER"] } } },
    };
    const { status, body } = await runConnect(state, "apify", VALUES.apify);
    if (status !== 200 || body.ok !== false || !String(body.error).includes("Store")) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("apify: token válido com Store access conecta", async () => {
    const state = defaultState();
    const { status, body } = await runConnect(state, "apify", VALUES.apify);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- testEvolution + resolução de status/QR/webhook_token do canal ----

  await t.step(
    "evolution: campos obrigatórios faltando internamente retorna erro genérico",
    async () => {
      const state = defaultState();
      state.catalog = {
        slug: "evolution",
        available: true,
        required_secrets: [{ key: "api_url" }, { key: "instance_name" }],
      };
      const { status, body } = await runConnect(state, "evolution", {
        api_url: "https://evo.example.com",
      });
      if (status !== 200 || body.ok !== false || body.error !== "Preencha: instance_name") {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "evolution: checkEvolutionInstanceStatus retorna erro -- teste falha com mensagem e não escreve em channels",
    async () => {
      const state = defaultState();
      state.evolutionStatus = { status: 500, body: {} };
      const { status, body } = await runConnect(state, "evolution", VALUES.evolution);
      if (status !== 200 || body.ok !== false) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      if (!String(body.error ?? "").length) {
        throw new Error("esperava mensagem de erro presente");
      }
      if (state.channelWrites.length !== 0) {
        throw new Error("não deveria ter escrito em channels quando o teste de credenciais falha");
      }
    },
  );

  await t.step(
    "evolution: instância já conectada -- canal novo sincroniza 'connected' e recebe webhook_token mintado",
    async () => {
      const state = defaultState();
      state.evolutionStatus = { status: 200, body: { data: { Connected: true } } };
      const { status, body } = await runConnect(state, "evolution", VALUES.evolution);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      const write = state.channelWrites.at(-1);
      if (!write || write.method !== "POST" || write.body.status !== "connected") {
        throw new Error(`esperava insert com status 'connected', veio ${JSON.stringify(write)}`);
      }
      if (typeof write.body.webhook_token !== "string" || write.body.webhook_token.length === 0) {
        throw new Error(
          `esperava webhook_token mintado no insert, veio ${JSON.stringify(write.body)}`,
        );
      }
    },
  );

  await t.step(
    "evolution: canal existente sem webhook_token recebe um novo; com token existente, preserva",
    async () => {
      const state = defaultState();
      state.evolutionStatus = { status: 200, body: { data: { Connected: true } } };
      state.existingChannelId = "chan-evo-1";
      state.existingChannelWebhookToken = "webhook-evo-existente";
      const { status, body } = await runConnect(state, "evolution", VALUES.evolution);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      const write = state.channelWrites.at(-1);
      if (!write || write.method !== "PATCH" || write.body.status !== "connected") {
        throw new Error(`esperava update com status 'connected', veio ${JSON.stringify(write)}`);
      }
      if ("webhook_token" in write.body) {
        throw new Error(
          `esperava webhook_token PRESERVADO (sem re-mint), veio patch com a chave: ${
            JSON.stringify(write.body)
          }`,
        );
      }
    },
  );

  await t.step(
    "evolution: instância desconectada + reconnect com QR novo -- canal fica 'waiting_qr' com QR protegido",
    async () => {
      const state = defaultState();
      state.evolutionStatus = { status: 200, body: { data: { Connected: false } } };
      state.evolutionReconnect = { status: 200 };
      state.evolutionQr = { status: 200, body: { data: { qrcode: "QR-BASE64-XYZ" } } };
      const { status, body } = await runConnect(state, "evolution", VALUES.evolution);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      const write = state.channelWrites.at(-1);
      if (!write || write.body.status !== "waiting_qr") {
        throw new Error(`esperava canal 'waiting_qr', veio ${JSON.stringify(write)}`);
      }
      if (write.body.qr_code !== "QR-BASE64-XYZ") {
        throw new Error(
          `esperava qr_code protegido preenchido, veio ${JSON.stringify(write.body)}`,
        );
      }
      if (typeof write.body.qr_code_expires_at !== "string") {
        throw new Error(`esperava expiração do QR, veio ${JSON.stringify(write.body)}`);
      }
      const config = write.body.config as Record<string, unknown> | undefined;
      if (config && "qr_code" in config) {
        throw new Error(`QR code não pode vazar em config: ${JSON.stringify(config)}`);
      }
    },
  );

  await t.step(
    "evolution: desconectado + reconnect ok sem QR (sessão restabelecida) -- canal fica 'connecting'",
    async () => {
      const state = defaultState();
      state.evolutionStatus = { status: 200, body: { data: { Connected: false } } };
      state.evolutionReconnect = { status: 200 };
      state.evolutionQr = { status: 200, body: { data: {} } };
      const { status, body } = await runConnect(state, "evolution", VALUES.evolution);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      const write = state.channelWrites.at(-1);
      if (!write || write.body.status !== "connecting") {
        throw new Error(`esperava canal 'connecting', veio ${JSON.stringify(write)}`);
      }
    },
  );

  await t.step(
    "evolution: desconectado + reconnect recusado pelo servidor -- canal fica 'disconnected'",
    async () => {
      const state = defaultState();
      state.evolutionStatus = { status: 200, body: { data: { Connected: false } } };
      state.evolutionReconnect = { status: 500 };
      const { status, body } = await runConnect(state, "evolution", VALUES.evolution);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      const write = state.channelWrites.at(-1);
      if (!write || write.body.status !== "disconnected") {
        throw new Error(`esperava canal 'disconnected', veio ${JSON.stringify(write)}`);
      }
    },
  );
});

Deno.test("integration-connect: testAgentPlatform", async (t) => {
  const errorOf = (body: Record<string, unknown>): string => String(body.error ?? "");

  await t.step("credencial válida com workspace na conta → ok", async () => {
    const state = defaultState();
    const { status } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
    if (status !== 200) throw new Error(`esperava 200, veio ${status}`);
    const write = state.tenantIntegrationWrites.at(-1);
    if (write?.status !== "active") {
      throw new Error(`esperava status active, veio ${JSON.stringify(write)}`);
    }
  });

  await t.step("401 do provedor → pede token novo", async () => {
    const state = defaultState();
    state.agentPlatform = { status: 401, body: { message: "unauthorized" } };
    const { body } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
    if (!errorOf(body).includes("Token inválido")) {
      throw new Error(`esperava badToken, veio ${errorOf(body)}`);
    }
  });

  await t.step("workspace fora da conta → lista os disponíveis", async () => {
    const state = defaultState();
    state.agentPlatform = { status: 200, body: [{ id: "ws-outro", name: "Outro" }] };
    const { body } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
    if (!errorOf(body).includes("Outro (ws-outro)")) {
      throw new Error(`esperava lista de workspaces, veio ${errorOf(body)}`);
    }
  });

  await t.step("conta sem workspace nenhum → mensagem própria", async () => {
    const state = defaultState();
    state.agentPlatform = { status: 200, body: [] };
    const { body } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
    if (!errorOf(body).includes("não há workspace acessível")) {
      throw new Error(`esperava aviso de conta vazia, veio ${errorOf(body)}`);
    }
  });

  // H3 — 200 com HTML/corpo vazio faz o `r.json()` lançar SyntaxError. A ordem
  // antiga do catch mandava isso para o `badToken`, ou seja: o usuário rotacionava
  // uma chave que estava boa por causa de uma indisposição do provedor.
  await t.step("200 com corpo não-JSON não vira 'token inválido'", async () => {
    const state = defaultState();
    state.agentPlatform = { status: 200, rawBody: "<html>502 Bad Gateway</html>" };
    const { body } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
    const msg = errorOf(body);
    if (msg.includes("Token inválido")) {
      throw new Error("resposta malformada foi classificada como token inválido");
    }
    if (!msg.includes("formato inesperado")) {
      throw new Error(`esperava aviso de formato inesperado, veio ${msg}`);
    }
  });

  // H3 (segunda metade) — no Deno a falha de rede rejeita com TypeError. Testar
  // TypeError antes de isNetworkError reportava provedor fora do ar como
  // "caractere inválido no campo", e mandava o usuário reeditar um token correto.
  await t.step("falha de rede (TypeError) não vira 'caractere inválido'", async () => {
    const state = defaultState();
    state.agentPlatform = {
      status: 0,
      throwTypeError: "error sending request for url (dns error)",
    };
    const { body } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
    const msg = errorOf(body);
    if (msg.includes("caractere inválido")) {
      throw new Error("erro de rede foi classificado como caractere inválido");
    }
    if (!msg.includes("Não conseguimos falar com o provedor")) {
      throw new Error(`esperava mensagem de rede, veio ${msg}`);
    }
  });

  await t.step("deadline estourado continua sendo erro de rede", async () => {
    for (const variant of ["reason", "fetch"] as const) {
      const state = defaultState();
      state.agentPlatform = { status: 0, throwTimeout: variant };
      const { body } = await runConnect(state, "agent-platform", VALUES["agent-platform"]);
      if (!errorOf(body).includes("Não conseguimos falar com o provedor")) {
        throw new Error(`variante ${variant}: veio ${errorOf(body)}`);
      }
    }
  });

  await t.step("campo obrigatório vazio nem chega ao provedor", async () => {
    const state = defaultState();
    const { body } = await runConnect(state, "agent-platform", { api_token: "", workspace_id: "" });
    if (!errorOf(body)) throw new Error("esperava erro de validação");
    if (state.providerRequests.length > 0) throw new Error("não deveria chamar o provedor");
  });
});

// Regressão do CRITICAL `05 · C1` (code review de 2026-08-10, corrigido em #254):
// no reconnect da Zappaz o UPDATE que grava o webhook_token tinha o `{ error }`
// descartado, e três linhas depois o mesmo token era registrado no provedor. Com
// a escrita falhando, a Zappaz passava a postar com um token inexistente no
// banco: todo o inbound rejeitado e a UI mostrando "conectado".
Deno.test("integration-connect: reconnect da Zappaz e o webhook_token", async (t) => {
  function reconnectState(): State {
    const state = defaultState();
    state.existingChannelId = "ch-zappaz-1";
    // null força o mint de um token novo — é o único caminho que grava.
    state.existingChannelWebhookToken = null;
    state.existingChannelStatus = "error";
    state.existingSecrets = [
      { key: "api_key", value: "zp-key-123" },
      { key: "session_id", value: "sess-1" },
    ];
    return state;
  }

  function webhookCalls(state: State): Array<{ url: string }> {
    return state.providerRequests.filter((r) => r.url.includes("api.zappaz.io/api/v1/session"))
      .filter((r) => r.url.endsWith("/webhook"));
  }

  async function runReconnect(state: State): Promise<Record<string, unknown>> {
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ action: "reconnect", slug: "zappaz" }));
      return (await res.json()) as Record<string, unknown>;
    } finally {
      uninstall();
    }
  }

  await t.step("falha ao gravar o token aborta ANTES de registrar na Zappaz", async () => {
    const state = reconnectState();
    state.channelUpdateFails = true;

    const body = await runReconnect(state);

    if (body.ok !== false) throw new Error(`esperava ok:false, veio ${JSON.stringify(body)}`);
    // A asserção que segura a regressão: token não gravado => provedor não é tocado.
    if (webhookCalls(state).length !== 0) {
      throw new Error("registrou o webhook na Zappaz com um token que não foi gravado no banco");
    }
    const evento = state.systemEventsInsertBodies.find((e) =>
      String(e.operation ?? "").includes("webhook_token")
    );
    if (!evento) {
      throw new Error(
        `falha silenciosa: nenhum system_event de webhook_token. Eventos: ${
          JSON.stringify(state.systemEventsInsertBodies.map((e) => e.operation))
        }`,
      );
    }
  });

  await t.step("token gravado é exatamente o registrado no provedor", async () => {
    const state = reconnectState();

    const body = await runReconnect(state);

    if (body.ok !== true) throw new Error(`esperava ok:true, veio ${JSON.stringify(body)}`);
    const escrito = state.channelWrites
      .map((w) => w.body.webhook_token)
      .find((t) => typeof t === "string") as string | undefined;
    if (!escrito) throw new Error("nenhum webhook_token gravado em channels");
    const chamadas = webhookCalls(state);
    if (chamadas.length !== 1) {
      throw new Error(`esperava 1 registro de webhook, veio ${chamadas.length}`);
    }
    // O corpo do POST carrega a callbackUrl; a URL da chamada é só o endpoint.
    // O token vive na callbackUrl, então a checagem real é sobre o que foi
    // enviado no body — capturado pelo mock em bodyJson.
    if (!state.zappazWebhookBodies.some((b) => String(b.url ?? "").includes(escrito))) {
      throw new Error(
        `a callbackUrl registrada não usa o token gravado (${escrito}): ${
          JSON.stringify(state.zappazWebhookBodies)
        }`,
      );
    }
  });
});
