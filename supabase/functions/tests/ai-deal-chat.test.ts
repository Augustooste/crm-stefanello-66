// Testa o handler Deno.serve de ai-deal-chat/index.ts: auth, posse do deal
// por tenant (mesmo padrão de ai-qualification/index.ts) e a montagem do
// prompt com contexto real do negócio (clone de ai-playground/index.ts +
// bloco de contato/atividades/notas). Como esta function não expõe um
// `system_prompt_preview` como ai-playground (não é admin-only, não deveria
// vazar o prompt de sistema pra qualquer vendedor do tenant), o conteúdo do
// prompt é verificado interceptando o corpo enviado ao gateway Lovable.
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

const handler = await captureHandler("../ai-deal-chat/index.ts");

const DEAL_ID = "deal-1";
const TENANT_ID = "tenant-1";
const CONTACT_ID = "contact-1";

interface State {
  authOk: boolean;
  profile: { tenant_id: string } | null;
  deal: {
    id: string;
    tenant_id: string;
    title: string;
    value: number | null;
    status: string;
    stage_id: string;
    contact_id: string | null;
  } | null;
  tenant: { name: string; business_profile: Record<string, unknown> | null } | null;
  settings: { base_system_prompt: string | null } | null;
  stage: { name: string } | null;
  stageCfg: { system_prompt: string | null; enabled: boolean } | null;
  contact: {
    name: string;
    email: string | null;
    phone: string | null;
    tags: string[] | null;
    source: string | null;
  } | null;
  activities: Array<{
    type: string;
    title: string;
    due_at: string | null;
    completed_at: string | null;
  }>;
  notes: Array<{ content: string }>;
  aiStatus: number;
  aiBody: unknown;
  aiThrows: boolean;
  rateLimitAllowed: boolean;
  rateLimitRetryAfterSeconds: number;
  rateLimitRpcFails: boolean;
}

function defaultState(): State {
  return {
    authOk: true,
    profile: { tenant_id: TENANT_ID },
    deal: {
      id: DEAL_ID,
      tenant_id: TENANT_ID,
      title: "Plano anual Acme",
      value: 1200,
      status: "open",
      stage_id: "stage-1",
      contact_id: CONTACT_ID,
    },
    tenant: { name: "Acme", business_profile: {} },
    settings: null,
    stage: { name: "Qualificação" },
    stageCfg: null,
    contact: {
      name: "Maria Silva",
      email: "maria@x.com",
      phone: "11999990000",
      tags: ["vip"],
      source: "indicação",
    },
    activities: [
      {
        type: "call",
        title: "Ligação inicial",
        due_at: null,
        completed_at: "2026-07-01T10:00:00Z",
      },
    ],
    notes: [{ content: "Cliente pediu desconto." }],
    aiStatus: 200,
    aiBody: { choices: [{ message: { content: "Olá! Posso ajudar com o plano anual." } }] },
    aiThrows: false,
    rateLimitAllowed: true,
    rateLimitRetryAfterSeconds: 0,
    rateLimitRpcFails: false,
  };
}

function router(state: State, onGatewayRequest?: (req: MockRequest) => void): FetchMatcher {
  return (req) => {
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) return jsonResponse(401, { msg: "invalid token" });
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
      return jsonResponse(200, state.deal ? [state.deal] : []);
    }
    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit" && req.method === "POST") {
      if (state.rateLimitRpcFails) return jsonResponse(500, { message: "db indisponível" });
      return jsonResponse(200, {
        allowed: state.rateLimitAllowed,
        retryAfterSeconds: state.rateLimitRetryAfterSeconds,
      });
    }
    if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
      return jsonResponse(200, state.tenant ? [state.tenant] : []);
    }
    if (req.pathname === "/rest/v1/ai_settings" && req.method === "GET") {
      return jsonResponse(200, state.settings ? [state.settings] : []);
    }
    if (req.pathname === "/rest/v1/board_stages" && req.method === "GET") {
      return jsonResponse(200, state.stage ? [state.stage] : []);
    }
    if (req.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
      return jsonResponse(200, state.stageCfg ? [state.stageCfg] : []);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, state.contact ? [state.contact] : []);
    }
    if (req.pathname === "/rest/v1/activities" && req.method === "GET") {
      return jsonResponse(200, state.activities);
    }
    if (req.pathname === "/rest/v1/contact_notes" && req.method === "GET") {
      return jsonResponse(200, state.notes);
    }
    if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      onGatewayRequest?.(req);
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

const validBody = { deal_id: DEAL_ID, message: "Oi, quero saber mais sobre o plano." };

Deno.test("ai-deal-chat", async (t) => {
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

  await t.step("deal_id ausente retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ message: "oi" }));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "deal_id obrigatório.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("message ausente/vazia retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ deal_id: DEAL_ID, message: "   " }));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Mensagem obrigatória.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("deal inexistente retorna 404", async () => {
    const state = defaultState();
    state.deal = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 404 || body.error !== "Negócio não encontrado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("deal de outro tenant retorna 404 (não revela existência)", async () => {
    const state = defaultState();
    state.deal!.tenant_id = "outro-tenant";
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 404 || body.error !== "Negócio não encontrado.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
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

  await t.step(
    "caminho feliz: injeta contato, valor, atividades e notas no prompt de sistema",
    async () => {
      const state = defaultState();
      let systemPrompt = "";
      let userMessage = "";
      const uninstall = installFetchMock(
        router(state, (gwReq) => {
          const payload = gwReq.bodyJson as {
            messages: Array<{ role: string; content: string }>;
          };
          systemPrompt = payload.messages.find((m) => m.role === "system")?.content ?? "";
          userMessage = payload.messages.find((m) => m.role === "user")?.content ?? "";
        }),
      );
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        if (res.status !== 200 || body.reply !== "Olá! Posso ajudar com o plano anual.") {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
        if (userMessage !== validBody.message) {
          throw new Error(`mensagem do usuário não repassada: ${userMessage}`);
        }
        const mustInclude = [
          "Plano anual Acme",
          "R$",
          "1.200,00",
          "Qualificação",
          "Maria Silva",
          "maria@x.com",
          "vip",
          "indicação",
          "Ligação inicial",
          "concluída",
          "Cliente pediu desconto.",
        ];
        for (const needle of mustInclude) {
          if (!systemPrompt.includes(needle)) {
            throw new Error(`prompt não contém "${needle}": ${systemPrompt}`);
          }
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("deal sem contact_id: contexto sem seção de contato, não quebra", async () => {
    const state = defaultState();
    state.deal!.contact_id = null;
    let systemPrompt = "";
    const uninstall = installFetchMock(
      router(state, (gwReq) => {
        const payload = gwReq.bodyJson as { messages: Array<{ role: string; content: string }> };
        systemPrompt = payload.messages.find((m) => m.role === "system")?.content ?? "";
      }),
    );
    try {
      const res = await handler(req(validBody));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (systemPrompt.includes("Maria Silva") || systemPrompt.includes("Contato:")) {
        throw new Error(`não deveria conter dados de contato: ${systemPrompt}`);
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
    let systemPrompt = "";
    const uninstall = installFetchMock(
      router(state, (gwReq) => {
        const payload = gwReq.bodyJson as { messages: Array<{ role: string; content: string }> };
        systemPrompt = payload.messages.find((m) => m.role === "system")?.content ?? "";
      }),
    );
    try {
      const res = await handler(req(validBody));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (!systemPrompt.includes("Regra do estágio clínicas")) {
        throw new Error(`prompt inesperado: ${systemPrompt}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("stage desabilitado NÃO adiciona system_prompt do estágio", async () => {
    const state = defaultState();
    state.stageCfg = { system_prompt: "Não deveria aparecer", enabled: false };
    let systemPrompt = "";
    const uninstall = installFetchMock(
      router(state, (gwReq) => {
        const payload = gwReq.bodyJson as { messages: Array<{ role: string; content: string }> };
        systemPrompt = payload.messages.find((m) => m.role === "system")?.content ?? "";
      }),
    );
    try {
      const res = await handler(req(validBody));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (systemPrompt.includes("Não deveria aparecer")) {
        throw new Error(`prompt não deveria conter regra do estágio desabilitado: ${systemPrompt}`);
      }
    } finally {
      uninstall();
    }
  });

  // Rate limit por deal — mesmo padrão de ai-qualification.test.ts: sem
  // teto, um chat de "Enter=envio" martela a function e drena créditos de IA
  // compartilhados do tenant.
  await t.step(
    "rate limit bloqueado retorna 429 com retryAfterSeconds, não chama a IA",
    async () => {
      const state = defaultState();
      state.rateLimitAllowed = false;
      state.rateLimitRetryAfterSeconds = 30;
      let aiCalled = false;
      const uninstall = installFetchMock((r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return router(state)(r);
      });
      try {
        const res = await handler(req(validBody));
        const body = (await res.json()) as { error: string; retryAfterSeconds: number };
        if (res.status !== 429) throw new Error(`esperado 429, veio ${res.status}`);
        if (body.retryAfterSeconds !== 30) {
          throw new Error(`retryAfterSeconds=${body.retryAfterSeconds}`);
        }
        if (aiCalled) throw new Error("não deveria chamar a IA quando rate limited");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "RPC do rate limit falhou (infra, não limite legítimo): fail-closed retorna 500",
    async () => {
      const state = defaultState();
      state.rateLimitRpcFails = true;
      let aiCalled = false;
      const uninstall = installFetchMock((r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return router(state)(r);
      });
      try {
        const res = await handler(req(validBody));
        const body = (await res.json()) as { error: string; retryAfterSeconds?: number };
        if (res.status !== 500) throw new Error(`esperado 500, veio ${res.status}`);
        if (body.retryAfterSeconds !== undefined) {
          throw new Error("resposta de falha de RPC não deveria trazer retryAfterSeconds");
        }
        if (aiCalled) throw new Error("não deveria chamar a IA quando a RPC falhou");
      } finally {
        uninstall();
      }
    },
  );

  await t.step("deal de outro tenant retorna 404 antes de checar rate limit", async () => {
    const state = defaultState();
    state.deal!.tenant_id = "outro-tenant";
    let rateLimitCalled = false;
    const uninstall = installFetchMock((r) => {
      if (r.pathname === "/rest/v1/rpc/check_and_record_rate_limit") rateLimitCalled = true;
      return router(state)(r);
    });
    try {
      const res = await handler(req(validBody));
      if (res.status !== 404) throw new Error(`esperado 404, veio ${res.status}`);
      if (rateLimitCalled) {
        throw new Error("rate limit não deveria ser checado antes da posse do deal");
      }
    } finally {
      uninstall();
    }
  });
});
