// Testa o handler de supabase/functions/evolution-watchdog/index.ts: auth
// fail-closed (service role), a query real contra channels
// (type='whatsapp' AND provider_slug='evolution' AND status IN
// ('disconnected','error')), reconexão via evolution-client.ts (mockado por
// HTTP, sem rede real) e a persistência do resultado (connected/waiting_qr/
// status_message). Cobre também o critério de aceite de genericidade do PRD:
// nenhum nome de tenant/clínica/instância fixo no código-fonte.
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../evolution-watchdog/index.ts");

const EVO_BASE = "https://evo.example.com";

interface ChannelSeed {
  id: string;
  tenant_id: string;
  type: string;
  provider_slug: string;
  status: string;
  config: Record<string, unknown>;
  qr_code: string | null;
  qr_code_expires_at: string | null;
}

interface SecretSeed {
  tenant_id: string;
  slug: string;
  key: string;
  value: string;
}

interface MockState {
  channels: ChannelSeed[];
  secrets: SecretSeed[];
  channelUpdates: Array<{ id: string | null; body: Record<string, unknown> }>;
  reconnectResponses: Record<string, { ok: boolean; status?: number }>;
  qrResponses: Record<string, { qrcode?: string }>;
}

function defaultState(): MockState {
  return { channels: [], secrets: [], channelUpdates: [], reconnectResponses: {}, qrResponses: {} };
}

function stripOp(raw: string | null): string | null {
  return raw?.replace(/^[a-z]+\./, "") ?? null;
}

function req(opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  }
  return new Request("http://fn.local", { method: opts.method ?? "POST", headers });
}

function seedChannel(state: MockState, overrides: Partial<ChannelSeed> = {}): ChannelSeed {
  const channel: ChannelSeed = {
    id: "chan-1",
    tenant_id: "tenant-1",
    type: "whatsapp",
    provider_slug: "evolution",
    status: "disconnected",
    config: {},
    qr_code: null,
    qr_code_expires_at: null,
    ...overrides,
  };
  state.channels.push(channel);
  return channel;
}

/**
 * `channels.config` válido para reconexão -- api_url/instance_name são
 * metadado não sensível gravado pelo onboarding (integration-connect/
 * index.ts), MESMO contrato de messaging-channels-reconcile/runner.ts.
 */
function evolutionConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { api_url: EVO_BASE, instance_name: "instancia-qualquer", ...overrides };
}

/**
 * Segredos Evolution -- SÓ api_key/instance_token (segredo real). api_url/
 * instance_name NÃO vivem mais aqui -- contrato pós-onboarding é
 * channels.config para esses dois campos (ver evolutionConfig acima).
 */
function seedEvolutionSecrets(
  state: MockState,
  tenantId: string,
  overrides: Partial<Record<string, string>> = {},
): void {
  const defaults: Record<string, string> = {
    api_key: "global-key-123",
    instance_token: "instance-token-abc",
    ...overrides,
  };
  for (const [key, value] of Object.entries(defaults)) {
    if (value === undefined) continue;
    state.secrets.push({ tenant_id: tenantId, slug: "evolution", key, value });
  }
}

/**
 * Mock stateful cobrindo PostgREST (channels/integration_secrets) E a API
 * HTTP da Evolution (reconnect/qr) -- installFetchMock intercepta fetch
 * globalmente, e o cliente Evolution usa fetch puro, não PostgREST.
 */
function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;

    if (r.pathname === "/rest/v1/channels" && r.method === "GET") {
      const type = stripOp(sp.get("type"));
      const providerSlug = stripOp(sp.get("provider_slug"));
      const statusFilter = sp.get("status");
      if (type !== "whatsapp" || providerSlug !== "evolution" || !statusFilter?.startsWith("in.")) {
        throw new Error(`query inesperada em channels: ${r.url}`);
      }
      const allowedStatuses = statusFilter.slice(4, -1).split(",");
      const rows = state.channels.filter(
        (c) =>
          c.type === "whatsapp" &&
          c.provider_slug === "evolution" &&
          allowedStatuses.includes(c.status),
      );
      return jsonResponse(
        200,
        rows.map(({ id, tenant_id, config }) => ({ id, tenant_id, config })),
      );
    }

    if (r.pathname === "/rest/v1/channels" && r.method === "PATCH") {
      const id = stripOp(sp.get("id"));
      const body = r.bodyJson as Record<string, unknown>;
      state.channelUpdates.push({ id, body });
      const channel = state.channels.find((c) => c.id === id);
      if (channel) {
        if (typeof body.status === "string") channel.status = body.status;
        if ("config" in body) channel.config = body.config as Record<string, unknown>;
        if ("qr_code" in body) channel.qr_code = body.qr_code as string | null;
        if ("qr_code_expires_at" in body) {
          channel.qr_code_expires_at = body.qr_code_expires_at as string | null;
        }
      }
      return new Response("", { status: 200 });
    }

    if (r.pathname === "/rest/v1/integration_secrets" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const slug = stripOp(sp.get("slug"));
      const rows = state.secrets.filter((s) => s.tenant_id === tenantId && s.slug === slug);
      return jsonResponse(
        200,
        rows.map(({ key, value }) => ({ key, value })),
      );
    }

    // Sem instance_token nos segredos, o cliente descobre o token da instância
    // pelo nome (GET /instance/all com a chave global) -- endpoint global.
    if (r.pathname === "/instance/all" && r.method === "GET") {
      const names = new Set(
        state.channels
          .map((c) => c.config.instance_name)
          .filter((n): n is string => typeof n === "string"),
      );
      return jsonResponse(200, {
        data: [...names].map((name) => ({ name, token: "instance-token-abc" })),
      });
    }

    if (r.pathname.endsWith("/instance/reconnect") && r.method === "POST") {
      const base = r.url.replace("/instance/reconnect", "");
      const cfg = state.reconnectResponses[base] ?? { ok: true };
      return new Response("{}", { status: cfg.status ?? (cfg.ok ? 200 : 500) });
    }

    if (r.pathname.endsWith("/instance/qr") && r.method === "GET") {
      const base = r.url.split("/instance/qr")[0];
      const cfg = state.qrResponses[base];
      if (!cfg) return jsonResponse(200, { data: {} });
      return jsonResponse(200, { data: { qrcode: cfg.qrcode } });
    }

    return undefined;
  };
}

Deno.test("evolution-watchdog", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const res = await handler(req({ method: "OPTIONS" }));
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (await res.text()) throw new Error("esperado corpo vazio");
  });

  await t.step("método não-POST retorna 405", async () => {
    const res = await handler(req({ method: "GET" }));
    if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
  });

  await t.step("sem Authorization retorna 401", async () => {
    const res = await handler(req({ auth: null }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const res = await handler(req({ auth: "Bearer errado" }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step(
    "canal evolution desconectado reconecta com sucesso -> status='connected'",
    async () => {
      const state = defaultState();
      const channel = seedChannel(state, { status: "disconnected", config: evolutionConfig() });
      seedEvolutionSecrets(state, channel.tenant_id);
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.scanned !== 1 || body.reconnected !== 1) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (channel.status !== "connected") {
          throw new Error(`status final inesperado: ${channel.status}`);
        }
        const update = state.channelUpdates.find((u) => u.id === channel.id);
        if (!update || update.body.status !== "connected" || update.body.status_message !== null) {
          throw new Error(`update inesperado: ${JSON.stringify(update)}`);
        }
        if (!update.body.last_connected_at) {
          throw new Error("last_connected_at deveria ter sido preenchido");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "reconexão retorna QR pendente -> status='waiting_qr' + QR isolado da config",
    async () => {
      const state = defaultState();
      const channel = seedChannel(state, {
        status: "error",
        config: evolutionConfig({ some_existing_key: "preserva-me" }),
      });
      seedEvolutionSecrets(state, channel.tenant_id);
      state.qrResponses[EVO_BASE] = { qrcode: "data:image/png;base64,QRCODEFAKE" };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (body.scanned !== 1 || body.waitingQr !== 1) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (channel.status !== "waiting_qr") {
          throw new Error(`status final inesperado: ${channel.status}`);
        }
        if (channel.qr_code !== "data:image/png;base64,QRCODEFAKE") {
          throw new Error(`QR code não persistido na coluna protegida: ${JSON.stringify(channel)}`);
        }
        if (!channel.qr_code_expires_at || Date.parse(channel.qr_code_expires_at) <= Date.now()) {
          throw new Error(`expiração do QR inválida: ${channel.qr_code_expires_at}`);
        }
        if ("qr_code" in channel.config) {
          throw new Error(`QR code não pode vazar em config: ${JSON.stringify(channel.config)}`);
        }
        if (channel.config.some_existing_key !== "preserva-me") {
          throw new Error("config existente não deveria ser sobrescrito, só mesclado");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "falha na reconexão -> status_message atualizado, status permanece de erro",
    async () => {
      const state = defaultState();
      const channel = seedChannel(state, { status: "error", config: evolutionConfig() });
      seedEvolutionSecrets(state, channel.tenant_id);
      state.reconnectResponses[EVO_BASE] = { ok: false, status: 500 };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (body.scanned !== 1 || body.stillDown !== 1) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (channel.status !== "error") {
          throw new Error(`status não deveria mudar, veio ${channel.status}`);
        }
        const update = state.channelUpdates.find((u) => u.id === channel.id);
        if (
          !update ||
          typeof update.body.status_message !== "string" ||
          !update.body.status_message
        ) {
          throw new Error(`status_message deveria ter sido preenchido: ${JSON.stringify(update)}`);
        }
        if ("status" in update.body) {
          throw new Error("update de falha não deveria tocar a coluna status");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("canal evolution já conectado NÃO é tocado", async () => {
    const state = defaultState();
    const channel = seedChannel(state, { status: "connected" });
    seedEvolutionSecrets(state, channel.tenant_id);
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req());
      const body = await res.json();
      if (body.scanned !== 0) {
        throw new Error(`canal conectado não deveria ser escaneado: ${JSON.stringify(body)}`);
      }
      if (state.channelUpdates.length !== 0) {
        throw new Error("canal conectado não deveria ser atualizado");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("canal de OUTRO provider (zapi) nunca é considerado pelo watchdog", async () => {
    const state = defaultState();
    seedChannel(state, { id: "chan-zapi", provider_slug: "zapi", status: "disconnected" });
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req());
      const body = await res.json();
      if (body.scanned !== 0) {
        throw new Error(`canal zapi não deveria ser escaneado: ${JSON.stringify(body)}`);
      }
      if (state.channelUpdates.length !== 0) {
        throw new Error("canal zapi não deveria ser atualizado");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "genericidade: canal com tenant/instance_name arbitrários (não hardcoded) é monitorado normalmente",
    async () => {
      const state = defaultState();
      const channel = seedChannel(state, {
        id: "chan-arbitrario-xyz789",
        tenant_id: "tenant-completamente-aleatorio-9f2c",
        status: "disconnected",
        config: evolutionConfig({ instance_name: "instancia-nunca-antes-vista-ab12" }),
      });
      seedEvolutionSecrets(state, channel.tenant_id);
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (body.scanned !== 1 || body.reconnected !== 1) {
          throw new Error(
            `canal arbitrário deveria ser reconectado normalmente: ${JSON.stringify(body)}`,
          );
        }
        if (channel.status !== "connected") {
          throw new Error(`status final inesperado: ${channel.status}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro isolado por canal: falha em um canal não impede o processamento dos demais",
    async () => {
      const state = defaultState();
      const semCredenciais = seedChannel(state, {
        id: "chan-sem-cred",
        tenant_id: "tenant-a",
        status: "error",
      });
      const comCredenciais = seedChannel(state, {
        id: "chan-ok",
        tenant_id: "tenant-b",
        status: "disconnected",
        config: evolutionConfig(),
      });
      seedEvolutionSecrets(state, comCredenciais.tenant_id);
      // tenant-a propositalmente sem config nem secrets -- credentialsFromChannel falha.
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (res.status !== 200) {
          throw new Error(`esperado 200 mesmo com canal sem credenciais, veio ${res.status}`);
        }
        if (body.scanned !== 2 || body.reconnected !== 1 || body.stillDown !== 1) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (semCredenciais.status !== "error") {
          throw new Error("canal sem credenciais não deveria mudar de status");
        }
        if (comCredenciais.status !== "connected") {
          throw new Error("segundo canal deveria reconectar normalmente");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "contrato pós-onboarding: api_url/instance_name vêm de channels.config, NÃO precisam estar em integration_secrets",
    async () => {
      const state = defaultState();
      const channel = seedChannel(state, { status: "disconnected", config: evolutionConfig() });
      // Secrets contém SÓ api_key -- sem api_url/instance_name -- provando que o
      // watchdog lê esses dois campos de channel.config, não de integration_secrets.
      state.secrets.push({
        tenant_id: channel.tenant_id,
        slug: "evolution",
        key: "api_key",
        value: "global-key-123",
      });
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (body.scanned !== 1 || body.reconnected !== 1) {
          throw new Error(
            `canal deveria reconectar usando api_url/instance_name do config: ${
              JSON.stringify(body)
            }`,
          );
        }
        if (channel.status !== "connected") {
          throw new Error(`status final inesperado: ${channel.status}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "api_url/instance_name em integration_secrets (legado) NÃO bastam sem channels.config -- contrato mudou",
    async () => {
      const state = defaultState();
      // config vazio de propósito -- reproduz o cenário pré-onboarding em que
      // api_url/instance_name só existiam em integration_secrets (contrato antigo).
      const channel = seedChannel(state, { status: "error", config: {} });
      state.secrets.push(
        { tenant_id: channel.tenant_id, slug: "evolution", key: "api_url", value: EVO_BASE },
        {
          tenant_id: channel.tenant_id,
          slug: "evolution",
          key: "instance_name",
          value: "instancia-legado",
        },
        {
          tenant_id: channel.tenant_id,
          slug: "evolution",
          key: "api_key",
          value: "global-key-123",
        },
      );
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (body.scanned !== 1 || body.stillDown !== 1) {
          throw new Error(
            `canal sem api_url/instance_name em config deveria falhar: ${JSON.stringify(body)}`,
          );
        }
        const update = state.channelUpdates.find((u) => u.id === channel.id);
        if (
          !update ||
          typeof update.body.status_message !== "string" ||
          !update.body.status_message.includes("channels.config")
        ) {
          throw new Error(
            `status_message deveria citar channels.config: ${JSON.stringify(update)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "nenhum nome de tenant/clínica/instância hardcoded no código-fonte (runner + index)",
    async () => {
      const runnerSource = await Deno.readTextFile(
        new URL("../evolution-watchdog/runner.ts", import.meta.url),
      );
      const indexSource = await Deno.readTextFile(
        new URL("../evolution-watchdog/index.ts", import.meta.url),
      );
      // Remove comentários de linha/bloco antes de escanear: os cabeçalhos
      // documentam DE PROPÓSITO o anti-padrão do medflow-v0 (citando o nome da
      // constante/instâncias) como decisão registrada -- só código real
      // (declaração/uso) conta como regressão aqui.
      const stripComments = (src: string) =>
        src.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
      const combined = `${stripComments(runnerSource)}\n${stripComments(indexSource)}`;
      if (/\bTARGET_INSTANCES\b/.test(combined)) {
        throw new Error(
          "TARGET_INSTANCES (anti-padrão hardcoded do medflow-v0) encontrado em código real",
        );
      }
      if (/cel-clinica|cel-enfermagem|cel-kelly|cel-felipe|cel-novo/.test(combined)) {
        throw new Error("nome de instância hardcoded do medflow-v0 encontrado em código real");
      }
      if (!combined.includes("provider_slug") || !combined.includes("evolution")) {
        throw new Error(
          "filtro dinâmico por provider_slug='evolution' não encontrado -- verificar regressão",
        );
      }
    },
  );
});
