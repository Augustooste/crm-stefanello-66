// Testes do handler do copiloto. Foco no que o teste do catálogo de ações não
// alcança: o portão de custo (rate limit) e a identidade do prompt — que é
// exatamente a regressão que a função existe para corrigir.
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";

setEnv({ ...BASE_ENV, LOVABLE_API_KEY: "lovable-key" });

const handler = await captureHandler("../ai-copilot/index.ts");

interface State {
  authOk: boolean;
  role: string;
  rateLimitAllowed: boolean;
  rateLimitRpcFails: boolean;
  /** system_events recusando o INSERT — o banco que caiu é o mesmo. */
  systemEventsFails?: boolean;
  /** Corpos enviados ao gateway, na ordem: [planejador, redator]. */
  gatewayBodies: Record<string, unknown>[];
  planoJson: string;
  /** Keys mandadas à RPC — sem assertar isto, trocar a key por uma constante
   * (todo mundo no mesmo balde) mantém a suíte verde. */
  rateLimitKeys: string[];
}

function defaultState(): State {
  return {
    authOk: true,
    role: "admin",
    rateLimitAllowed: true,
    rateLimitRpcFails: false,
    gatewayBodies: [],
    planoJson: '{"acao":"responder","parametros":{}}',
    rateLimitKeys: [],
  };
}

function router(state: State): FetchMatcher {
  return (req: MockRequest) => {
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) return jsonResponse(401, { msg: "invalid token" });
      return jsonResponse(200, { id: "user-1", email: "op@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles") {
      return jsonResponse(200, { tenant_id: "tenant-1" });
    }
    if (req.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(200, {
        tenant_id: "tenant-1",
        user_id: "user-1",
        role_id: "role-1",
        status: "active",
        revoked_at: null,
      });
    }
    if (req.pathname === "/rest/v1/roles") {
      return jsonResponse(200, { role_key: state.role });
    }
    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit") {
      state.rateLimitKeys.push(String((req.bodyJson as { p_key?: string })?.p_key ?? ""));
      if (state.rateLimitRpcFails) return jsonResponse(500, { message: "db indisponível" });
      return jsonResponse(200, {
        allowed: state.rateLimitAllowed,
        retryAfterSeconds: state.rateLimitAllowed ? 0 : 30,
      });
    }
    if (req.url.includes("/v1/chat/completions")) {
      const body = (req.bodyJson ?? {}) as Record<string, unknown>;
      state.gatewayBodies.push(body);
      const conteudo = state.gatewayBodies.length === 1
        ? state.planoJson
        : "Nenhuma consulta foi necessária.";
      return jsonResponse(200, { choices: [{ message: { content: conteudo } }] });
    }
    if (req.pathname === "/rest/v1/system_events") {
      if (state.systemEventsFails) return jsonResponse(500, { message: "db indisponível" });
      return jsonResponse(201, []);
    }
    return jsonResponse(200, []);
  };
}

function requisicao(texto = "quais os negócios de maior valor?") {
  return new Request("https://edge.local/ai-copilot", {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: "Bearer tok" },
    body: JSON.stringify({ messages: [{ role: "user", content: texto }] }),
  });
}

Deno.test("ai-copilot: portão de custo", async (t) => {
  await t.step("limite estourado devolve 429 e não chama o gateway", async () => {
    const state = defaultState();
    state.rateLimitAllowed = false;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(requisicao());
      if (res.status !== 429) throw new Error(`esperava 429, veio ${res.status}`);
      // O ponto do rate limit é não gastar crédito. Se o gateway foi chamado,
      // o teto está no lugar errado.
      if (state.gatewayBodies.length !== 0) {
        throw new Error(`gastou ${state.gatewayBodies.length} chamada(s) de IA mesmo limitado`);
      }
      const corpo = await res.json();
      if (!(typeof corpo.retryAfterSeconds === "number" && corpo.retryAfterSeconds > 0)) {
        throw new Error(`429 com retryAfterSeconds inútil: ${corpo.retryAfterSeconds}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("RPC do rate limit fora do ar nega (fail-closed), não libera", async () => {
    const state = defaultState();
    state.rateLimitRpcFails = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(requisicao());
      if (res.status !== 500) throw new Error(`esperava 500, veio ${res.status}`);
      if (state.gatewayBodies.length !== 0) {
        throw new Error("liberou IA com o rate limiter quebrado");
      }
    } finally {
      uninstall();
    }
  });

  // Cenário real de "banco fora do ar": a RPC do limiter falha E a telemetria
  // não consegue gravar, porque é o mesmo Postgres. A function não pode
  // quebrar, e o rastro tem que sobrar no log de runtime — que no Lovable é o
  // canal que sobrevive ao banco.
  await t.step("banco fora do ar: limiter e telemetria falham juntos, sem quebrar", async () => {
    const state = defaultState();
    state.rateLimitRpcFails = true;
    state.systemEventsFails = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(requisicao());
      if (res.status !== 500) throw new Error(`esperava 500, veio ${res.status}`);
      if (state.gatewayBodies.length !== 0) throw new Error("gastou IA com tudo fora do ar");
    } finally {
      uninstall();
    }
  });

  await t.step("dentro do limite responde 200 e usa os dois turnos", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(requisicao());
      if (res.status !== 200) throw new Error(`esperava 200, veio ${res.status}`);
      if (state.gatewayBodies.length !== 2) {
        throw new Error(`esperava 2 turnos, veio ${state.gatewayBodies.length}`);
      }
      // A key tem que ser por usuário: constante compartilhada faria um
      // usuário em loop derrubar o copiloto de todos os tenants.
      if (!state.rateLimitKeys.some((k) => k.includes("user-1"))) {
        throw new Error(`key do rate limit não é por usuário: ${state.rateLimitKeys.join(",")}`);
      }
    } finally {
      uninstall();
    }
  });
});

Deno.test("ai-copilot: fala como operador, não como agente de lead", async () => {
  const state = defaultState();
  const uninstall = installFetchMock(router(state));
  try {
    await handler(requisicao());
    const [planejador, redator] = state.gatewayBodies;
    const sistema = (b: Record<string, unknown>) =>
      String((b.messages as Array<{ role: string; content: string }>)[0].content);

    if (!sistema(planejador).includes("Ações disponíveis:")) {
      throw new Error("1º turno não recebeu o catálogo de ações");
    }
    if (!sistema(redator).includes("Você NÃO fala com o cliente final")) {
      throw new Error("2º turno não recebeu o prompt de operador");
    }
    // A regressão original: o painel respondia com a persona de qualificação de
    // lead. Nenhum dos turnos pode carregar esse vocabulário.
    for (const [nome, corpo] of [["planejador", planejador], ["redator", redator]] as const) {
      const texto = sistema(corpo).toLowerCase();
      if (texto.includes("atende leads")) {
        throw new Error(`${nome} recebeu prompt de atendimento ao lead`);
      }
      if (texto.includes("como conheceu")) {
        throw new Error(`${nome} recebeu prompt de qualificação`);
      }
    }
  } finally {
    uninstall();
  }
});
