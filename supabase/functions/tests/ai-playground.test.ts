import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

const handler = await captureHandler("../ai-playground/index.ts");

interface State {
  authOk: boolean;
  /** Teto de uso: `undefined` = liberado (default do mock). */
  rateLimitAllowed?: boolean;
  rateLimitRpcFails?: boolean;
  /** Quantas vezes o gateway pago foi chamado — o teto tem que zerar isso. */
  gatewayCalls?: number;
  /** Eventos gravados em system_events — a telemetria do fail-closed precisa
   * ser assertada, não presumida. */
  systemEvents?: Record<string, unknown>[];
  profile: { tenant_id: string; role: string } | null;
  tenant: { name: string; business_profile: Record<string, unknown> | null } | null;
  settings: { base_system_prompt: string | null } | null;
  stageCfg: { system_prompt: string | null; enabled: boolean } | null;
  aiStatus: number;
  aiBody: unknown;
  aiThrows: boolean;
}

function defaultState(): State {
  return {
    authOk: true,
    rateLimitAllowed: true,
    rateLimitRpcFails: false,
    gatewayCalls: 0,
    systemEvents: [],
    profile: { tenant_id: "tenant-1", role: "admin" },
    tenant: { name: "Acme", business_profile: {} },
    settings: null,
    stageCfg: null,
    aiStatus: 200,
    aiBody: { choices: [{ message: { content: "Olá! Como posso ajudar?" } }] },
    aiThrows: false,
  };
}

function router(state: State): FetchMatcher {
  return (req) => {
    // Sem esta rota o catch-all de _helpers responde 501 e a telemetria do
    // fail-closed falha calada — o teste passava assim mesmo, porque olhava só
    // o status HTTP da resposta ao cliente.
    if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
      state.systemEvents?.push((req.bodyJson ?? {}) as Record<string, unknown>);
      return jsonResponse(201, []);
    }
    // Rate limit: o default do mock libera. Testes que exercitam o teto
    // sobrescrevem `rateLimitAllowed`/`rateLimitRpcFails` no state.
    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit") {
      if (state.rateLimitRpcFails) return jsonResponse(500, { message: "db indisponível" });
      return jsonResponse(200, {
        allowed: state.rateLimitAllowed ?? true,
        retryAfterSeconds: (state.rateLimitAllowed ?? true) ? 0 : 30,
      });
    }
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) return jsonResponse(401, { msg: "invalid token" });
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    const membership = activeMembershipResponse(req, state.profile);
    if (membership) return membership;
    if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
      return jsonResponse(200, state.tenant ? [state.tenant] : []);
    }
    if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
      return jsonResponse(200, state.settings ? [state.settings] : []);
    }
    if (req.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
      return jsonResponse(200, state.stageCfg ? [state.stageCfg] : []);
    }
    if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      state.gatewayCalls = (state.gatewayCalls ?? 0) + 1;
      if (state.aiThrows) throw new Error("network down");
      return jsonResponse(state.aiStatus, state.aiBody);
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

const validBody = { messages: [{ role: "user", content: "oi" }] };

const BODY_OK = { stage_id: null, messages: [{ role: "user", content: "oi" }] };

Deno.test("ai-playground", async (t) => {
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
      const res = await handler(req(validBody));
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("sem perfil retorna 403", async () => {
    const state = defaultState();
    state.profile = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 403) throw new Error(`esperado 403, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("perfil não-admin retorna 403", async () => {
    const state = defaultState();
    state.profile = { tenant_id: "tenant-1", role: "vendedor" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 403) throw new Error(`esperado 403, veio ${res.status}`);
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

  await t.step("messages ausente vira lista vazia (não quebra)", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({}));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("tenant não encontrado retorna 404", async () => {
    const state = defaultState();
    state.tenant = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 404 || body.error !== "Tenant não encontrado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem LOVABLE_API_KEY retorna 500", async () => {
    Deno.env.delete("LOVABLE_API_KEY");
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 500 || body.error !== "IA indisponível no momento.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });

  await t.step("IA retorna 429 propaga 429", async () => {
    const state = defaultState();
    state.aiStatus = 429;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 429) throw new Error(`esperado 429, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("IA retorna 402 propaga 402", async () => {
    const state = defaultState();
    state.aiStatus = 402;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 402) throw new Error(`esperado 402, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("IA retorna outro erro HTTP vira 500 genérico", async () => {
    const state = defaultState();
    state.aiStatus = 503;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 500 || body.error !== "A IA não conseguiu responder desta vez.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("falha de rede na chamada à IA retorna 500 no catch", async () => {
    const state = defaultState();
    state.aiThrows = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 500 || !String(body.error).includes("Não conseguimos falar com a IA")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resposta vazia da IA retorna 500", async () => {
    const state = defaultState();
    state.aiBody = { choices: [{ message: { content: "   " } }] };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 500 || body.error !== "A IA retornou uma resposta vazia.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("caminho feliz sem stage: usa DEFAULT_BASE_PROMPT com {{empresa}}", async () => {
    const state = defaultState();
    state.settings = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 200 || !body.system_prompt_preview.includes("Acme")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("stage habilitado adiciona system_prompt do estágio", async () => {
    const state = defaultState();
    state.settings = { base_system_prompt: "Base {{empresa}}" };
    state.stageCfg = { system_prompt: "Regra do estágio {{segmento}}", enabled: true };
    state.tenant = { name: "Acme", business_profile: { segment: "clínicas" } };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ ...validBody, stage_id: "stage-1" }));
      const body = await res.json();
      if (
        res.status !== 200 ||
        !body.system_prompt_preview.includes("Regra do estágio clínicas")
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("stage desabilitado NÃO adiciona system_prompt do estágio", async () => {
    const state = defaultState();
    state.stageCfg = { system_prompt: "Não deveria aparecer", enabled: false };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ ...validBody, stage_id: "stage-1" }));
      const body = await res.json();
      if (res.status !== 200 || body.system_prompt_preview.includes("Não deveria aparecer")) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "buildVars: aliases PT resolvem a partir de chaves EN + hours formata dias",
    async () => {
      const state = defaultState();
      state.settings = {
        base_system_prompt:
          "{{empresa}} em {{cidade}}, atendida por {{equipe}}, oferece {{servicos}} na faixa {{faixa_preco}}. Horário: {{horarios}}.",
      };
      state.tenant = {
        name: "Acme",
        business_profile: {
          city: "São Paulo",
          team: "equipe A",
          offerings: ["corte", "barba"],
          price_range: "R$50-100",
          hours: {
            mon: { enabled: true, open: "09:00", close: "18:00" },
            tue: { enabled: false, open: "09:00", close: "18:00" },
          },
        },
      };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        const preview = body.system_prompt_preview as string;
        if (
          res.status !== 200 ||
          !preview.includes("São Paulo") ||
          !preview.includes("equipe A") ||
          !preview.includes("corte, barba") ||
          !preview.includes("R$50-100") ||
          !preview.includes("seg 09:00-18:00")
        ) {
          throw new Error(`inesperado preview: ${preview}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "business_profile com objeto aninhado achata valores e sem hours não injeta horário",
    async () => {
      const state = defaultState();
      state.settings = {
        base_system_prompt: "{{empresa}} - {{atendente_responsavel}} - {{nome_assistente}}",
      };
      state.tenant = {
        name: "Acme",
        business_profile: {
          human_handoff_owner: "Maria",
          assistant_name: { first: "Ana", last: "IA" },
          count: 42,
        },
      };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        const preview = body.system_prompt_preview as string;
        if (res.status !== 200 || !preview.includes("Maria") || !preview.includes("Ana, IA")) {
          throw new Error(`inesperado preview: ${preview}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "renderTemplate: string vazia retorna vazio, variável não resolvida derruba a frase, e valor null no business_profile é ignorado",
    async () => {
      const state = defaultState();
      state.settings = {
        base_system_prompt: "Frase com {{variavel_inexistente}} deveria sumir. {{empresa}} fica.",
      };
      state.tenant = {
        name: "Acme",
        business_profile: { segment: null, city: "SP" },
      };
      state.stageCfg = { system_prompt: "", enabled: true };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req({ ...validBody, stage_id: "stage-1" }));
        const body = await res.json();
        const preview = body.system_prompt_preview as string;
        if (
          res.status !== 200 ||
          preview.includes("deveria sumir") ||
          !preview.includes("Acme fica")
        ) {
          throw new Error(`inesperado preview: ${preview}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("base_system_prompt vazio (string falsy) não quebra renderTemplate", async () => {
    const state = defaultState();
    state.settings = { base_system_prompt: "" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (typeof body.system_prompt_preview !== "string") {
        throw new Error(`preview inesperado: ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("business_profile null usa objeto vazio sem quebrar", async () => {
    const state = defaultState();
    state.tenant = { name: "Acme", business_profile: null };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  // O teto existe para não gastar crédito. Um 429 que já chamou o gateway
  // custou dinheiro e não protegeu nada — por isso a asserção é sobre
  // `gatewayCalls`, não só sobre o status.
  await t.step("limite estourado devolve 429 sem chamar o gateway", async () => {
    const state = defaultState();
    state.rateLimitAllowed = false;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(BODY_OK));
      if (res.status !== 429) throw new Error(`esperava 429, veio ${res.status}`);
      if ((state.gatewayCalls ?? 0) !== 0) {
        throw new Error(`gastou ${state.gatewayCalls} chamada(s) de IA mesmo limitado`);
      }
      const corpo = await res.json();
      if (typeof corpo.retryAfterSeconds !== "number") throw new Error("429 sem retryAfterSeconds");
    } finally {
      uninstall();
    }
  });

  await t.step("RPC do limiter fora do ar nega em vez de liberar", async () => {
    const state = defaultState();
    state.rateLimitRpcFails = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(BODY_OK));
      if (res.status !== 500) throw new Error(`esperava 500, veio ${res.status}`);
      if ((state.gatewayCalls ?? 0) !== 0) {
        throw new Error("liberou IA com o rate limiter quebrado");
      }
      const evento = (state.systemEvents ?? []).find((e) =>
        String(e.operation ?? "").endsWith(".rate_limit")
      );
      if (!evento) throw new Error("falha do limiter não deixou rastro em system_events");
    } finally {
      uninstall();
    }
  });
});
