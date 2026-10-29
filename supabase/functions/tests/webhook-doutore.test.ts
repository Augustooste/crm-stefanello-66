import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../webhook-doutore/index.ts");

interface TenantIntegrationRow {
  tenant_id: string;
  slug: string;
  webhook_token: string;
  status: string;
}

interface ContactRow {
  id: string;
  tenant_id: string;
  phone: string;
  name: string;
  email: string | null;
  custom_fields: Record<string, unknown>;
}

interface Calls {
  contactsGet: number;
  contactsPost: number;
  contactsPatch: number;
}

interface State {
  tenantIntegrations: TenantIntegrationRow[];
  webhookSecret: string | null;
  rateLimitAllowed: boolean;
  rateLimitRpcError: boolean;
  contacts: ContactRow[];
  calls: Calls;
  nextContactId: number;
}

const VALID_TOKEN = "tenant-1-webhook-token-abc123";
const VALID_SECRET = "doutore-secret-test-only";

function defaultState(): State {
  return {
    tenantIntegrations: [
      { tenant_id: "tenant-1", slug: "doutore", webhook_token: VALID_TOKEN, status: "active" },
    ],
    webhookSecret: VALID_SECRET,
    rateLimitAllowed: true,
    rateLimitRpcError: false,
    contacts: [],
    calls: { contactsGet: 0, contactsPost: 0, contactsPatch: 0 },
    nextContactId: 1,
  };
}

function eqParam(url: URL, key: string): string | undefined {
  const raw = url.searchParams.get(key);
  return raw?.startsWith("eq.") ? raw.slice(3) : undefined;
}

function router(state: State): FetchMatcher {
  return (req) => {
    const url = new URL(req.url);

    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") {
      const slug = eqParam(url, "slug");
      const token = eqParam(url, "webhook_token");
      const found = state.tenantIntegrations.find(
        (t) => t.slug === slug && t.webhook_token === token,
      );
      return jsonResponse(200, found ? [found] : []);
    }

    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
      return jsonResponse(
        200,
        state.webhookSecret ? [{ key: "webhook_secret", value: state.webhookSecret }] : [],
      );
    }

    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit" && req.method === "POST") {
      if (state.rateLimitRpcError) {
        return jsonResponse(500, { message: "rate limiter unavailable" });
      }
      return jsonResponse(200, {
        allowed: state.rateLimitAllowed,
        retryAfterSeconds: state.rateLimitAllowed ? 0 : 60,
      });
    }

    if (req.pathname === "/rest/v1/contacts") {
      if (req.method === "GET") {
        state.calls.contactsGet++;
        const tenantId = eqParam(url, "tenant_id");
        const phone = eqParam(url, "phone");
        const found = state.contacts.find((c) => c.tenant_id === tenantId && c.phone === phone);
        return jsonResponse(200, found ? [found] : []);
      }
      if (req.method === "POST") {
        state.calls.contactsPost++;
        const body = (req.bodyJson as Record<string, unknown>) ?? {};
        const created: ContactRow = {
          id: `contact-${state.nextContactId++}`,
          tenant_id: String(body.tenant_id),
          phone: String(body.phone),
          name: String(body.name),
          email: (body.email as string | null) ?? null,
          custom_fields: (body.custom_fields as Record<string, unknown>) ?? {},
        };
        state.contacts.push(created);
        return jsonResponse(201, { id: created.id, custom_fields: created.custom_fields });
      }
      if (req.method === "PATCH") {
        state.calls.contactsPatch++;
        const id = eqParam(url, "id");
        const patchBody = (req.bodyJson as Record<string, unknown>) ?? {};
        const target = state.contacts.find((c) => c.id === id);
        if (target) {
          if (typeof patchBody.name === "string") target.name = patchBody.name;
          if (typeof patchBody.email === "string") target.email = patchBody.email;
          if (patchBody.custom_fields && typeof patchBody.custom_fields === "object") {
            target.custom_fields = patchBody.custom_fields as Record<string, unknown>;
          }
        }
        return emptyResponse(200);
      }
    }

    return undefined;
  };
}

function req(
  body: unknown,
  opts: { token?: string | null; secret?: string | null; method?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.secret !== null) {
    headers.set("x-doutore-webhook-secret", opts.secret ?? VALID_SECRET);
  }
  headers.set("x-forwarded-for", "198.51.100.10");
  const method = opts.method ?? "POST";
  const tokenParam = opts.token === null
    ? ""
    : `?token=${encodeURIComponent(opts.token ?? VALID_TOKEN)}`;
  return new Request(`http://fn.local/${tokenParam}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function run(
  state: State,
  body: unknown,
  opts: { token?: string | null; secret?: string | null; method?: string } = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(req(body, opts));
    const parsedBody = (await res.json()) as Record<string, unknown>;
    return { status: res.status, body: parsedBody };
  } finally {
    uninstall();
  }
}

const FULL_PAYLOAD = {
  nome: "Maria Silva",
  telefone: "+5511988887777",
  email: "maria@example.com",
  genero: "feminino",
  data_interesse: "2026-08-01",
};

Deno.test("webhook-doutore", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "OPTIONS", token: null }));
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

  await t.step("token ausente (sem ?token= na URL) retorna 401", async () => {
    const state = defaultState();
    const { status, body } = await run(state, FULL_PAYLOAD, { token: null });
    if (status !== 401) throw new Error(`esperado 401, veio ${status} ${JSON.stringify(body)}`);
    if (state.calls.contactsGet !== 0 || state.calls.contactsPost !== 0) {
      throw new Error("não deveria ter tocado contacts sem token");
    }
  });

  await t.step("token errado (não bate com nenhum tenant_integrations) retorna 401", async () => {
    const state = defaultState();
    const { status, body } = await run(state, FULL_PAYLOAD, {
      token: "token-completamente-errado",
    });
    if (status !== 401) throw new Error(`esperado 401, veio ${status} ${JSON.stringify(body)}`);
    if (state.calls.contactsGet !== 0 || state.calls.contactsPost !== 0) {
      throw new Error("não deveria ter tocado contacts com token inválido");
    }
  });

  await t.step(
    "token existe mas integração está 'disabled' (não 'active') retorna 401",
    async () => {
      const state = defaultState();
      state.tenantIntegrations[0].status = "disabled";
      const { status, body } = await run(state, FULL_PAYLOAD);
      if (status !== 401) throw new Error(`esperado 401, veio ${status} ${JSON.stringify(body)}`);
    },
  );

  await t.step("segredo ausente ou incorreto retorna 401 antes de tocar contacts", async () => {
    for (const secret of [null, "segredo-incorreto"]) {
      const state = defaultState();
      const { status } = await run(state, FULL_PAYLOAD, { secret });
      if (status !== 401) throw new Error(`esperado 401 para secret=${secret}, veio ${status}`);
      if (state.calls.contactsGet !== 0 || state.calls.contactsPost !== 0) {
        throw new Error("não deveria ter tocado contacts com segredo inválido");
      }
    }
  });

  await t.step("segredo esperado ausente no Vault falha fechado", async () => {
    const state = defaultState();
    state.webhookSecret = null;
    const { status } = await run(state, FULL_PAYLOAD);
    if (status !== 401) throw new Error(`esperado 401, veio ${status}`);
  });

  await t.step("rate limit excedido retorna 429 antes de tocar contacts", async () => {
    const state = defaultState();
    state.rateLimitAllowed = false;
    const { status } = await run(state, FULL_PAYLOAD);
    if (status !== 429) throw new Error(`esperado 429, veio ${status}`);
    if (state.calls.contactsGet !== 0 || state.calls.contactsPost !== 0) {
      throw new Error("não deveria ter tocado contacts após rate limit");
    }
  });

  await t.step(
    "token válido mas payload sem 'nome' retorna 400 com mensagem de campo faltando",
    async () => {
      const state = defaultState();
      const { status, body } = await run(state, {
        telefone: "+5511988887777",
      });
      if (status !== 400) throw new Error(`esperado 400, veio ${status} ${JSON.stringify(body)}`);
      if (!String(body.error ?? "").includes("nome")) {
        throw new Error(`esperava mensagem citando 'nome', veio ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "token válido mas payload sem 'telefone' retorna 400 com mensagem de campo faltando",
    async () => {
      const state = defaultState();
      const { status, body } = await run(state, {
        nome: "Maria Silva",
      });
      if (status !== 400) throw new Error(`esperado 400, veio ${status} ${JSON.stringify(body)}`);
      if (!String(body.error ?? "").includes("telefone")) {
        throw new Error(`esperava mensagem citando 'telefone', veio ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("corpo inválido (JSON quebrado) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request(`http://fn.local/?token=${VALID_TOKEN}`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-doutore-webhook-secret": VALID_SECRET,
            "x-forwarded-for": "198.51.100.10",
          },
          body: "{not-json",
        }),
      );
      const body = await res.json();
      if (res.status !== 400) {
        throw new Error(`esperado 400, veio ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "token válido + payload completo cria contato novo com source='doutore'",
    async () => {
      const state = defaultState();
      const { status, body } = await run(state, FULL_PAYLOAD);
      if (status !== 200 || body.ok !== true || body.created !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
      if (state.contacts.length !== 1) {
        throw new Error(`esperava 1 contato criado, veio ${state.contacts.length}`);
      }
      const created = state.contacts[0];
      if (created.name !== "Maria Silva" || created.phone !== "+5511988887777") {
        throw new Error(`contato criado com dados errados: ${JSON.stringify(created)}`);
      }
      if (
        created.custom_fields.genero !== "feminino" ||
        created.custom_fields.data_interesse !== "2026-08-01"
      ) {
        throw new Error(
          `custom_fields não genericizou campos clínicos: ${JSON.stringify(created.custom_fields)}`,
        );
      }
      if ("nome" in created.custom_fields || "telefone" in created.custom_fields) {
        throw new Error("campos de primeira classe vazaram para custom_fields");
      }
    },
  );

  await t.step(
    "mesmo telefone enviado duas vezes preserva dados existentes (só mescla chaves ausentes)",
    async () => {
      const state = defaultState();
      const first = await run(state, FULL_PAYLOAD);
      if (first.status !== 200 || first.body.created !== true) {
        throw new Error(`primeira submissão falhou: ${JSON.stringify(first)}`);
      }

      // Segunda submissão tenta sobrescrever data_interesse (chave JÁ preenchida)
      // e adiciona uma chave nova (observacoes). Contrato: só mescla chaves AUSENTES,
      // então data_interesse permanece 2026-08-01 e observacoes é adicionada.
      const second = await run(state, {
        ...FULL_PAYLOAD,
        data_interesse: "2026-09-15",
        observacoes: "trazido em segunda submissão",
      });
      if (second.status !== 200 || second.body.ok !== true || second.body.created !== false) {
        throw new Error(`segunda submissão inesperada: ${JSON.stringify(second)}`);
      }
      if (second.body.contact_id !== first.body.contact_id) {
        throw new Error("segunda submissão criou um contato diferente em vez de atualizar");
      }

      if (state.contacts.length !== 1) {
        throw new Error(`esperava apenas 1 linha em contacts, veio ${state.contacts.length}`);
      }
      if (state.calls.contactsPost !== 1) {
        throw new Error(
          `esperava exatamente 1 POST (só a primeira criação), veio ${state.calls.contactsPost}`,
        );
      }
      if (state.calls.contactsPatch < 1) {
        throw new Error(`esperava pelo menos 1 PATCH, veio ${state.calls.contactsPatch}`);
      }
      // Chave preexistente NÃO deve ter sido sobrescrita.
      if (state.contacts[0].custom_fields.data_interesse !== "2026-08-01") {
        throw new Error(
          `PATCH sobrescreveu chave já preenchida: ${
            JSON.stringify(state.contacts[0].custom_fields)
          }`,
        );
      }
      // Chave nova DEVE ter sido adicionada.
      if (state.contacts[0].custom_fields.observacoes !== "trazido em segunda submissão") {
        throw new Error(
          `PATCH não adicionou chave nova ausente: ${
            JSON.stringify(state.contacts[0].custom_fields)
          }`,
        );
      }
      // Nome preexistente DEVE ter sido preservado.
      if (state.contacts[0].name !== "Maria Silva") {
        throw new Error(`PATCH sobrescreveu name preenchido: ${state.contacts[0].name}`);
      }
    },
  );

  await t.step("resolve o tenant correto entre múltiplos tokens cadastrados", async () => {
    const state = defaultState();
    state.tenantIntegrations.push({
      tenant_id: "tenant-2",
      slug: "doutore",
      webhook_token: "outro-token-tenant-2",
      status: "active",
    });
    const { status, body } = await run(state, FULL_PAYLOAD, { token: "outro-token-tenant-2" });
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
    if (state.contacts[0]?.tenant_id !== "tenant-2") {
      throw new Error(`esperava contato no tenant-2, veio ${JSON.stringify(state.contacts[0])}`);
    }
  });
});
