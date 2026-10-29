import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

const handler = await captureHandler("../ai-insights/index.ts");

interface FailureInsert {
  tenant_id: string;
  request_id: string | null;
  error_message: string | null;
}

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
  cached: { insights: unknown; created_at: string } | null;
  report: unknown;
  aiStatus: number;
  aiBody: unknown;
  aiThrows: boolean;
  insertStatus: number;
  insertBody: unknown;
  failures: FailureInsert[];
}

function defaultState(): State {
  return {
    authOk: true,
    rateLimitAllowed: true,
    rateLimitRpcFails: false,
    gatewayCalls: 0,
    systemEvents: [],
    profile: { tenant_id: "tenant-1", role: "admin" },
    cached: null,
    report: { total_leads: 10 },
    aiStatus: 200,
    aiBody: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              insights: [
                { severidade: "alta", diagnostico: "diag", sugestao: "sug", link: "/pipeline" },
              ],
            }),
          },
        },
      ],
    },
    aiThrows: false,
    insertStatus: 201,
    insertBody: null,
    failures: [],
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
      if (!state.authOk) {
        return jsonResponse(401, { msg: "invalid token" });
      }
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    const membership = activeMembershipResponse(req, state.profile);
    if (membership) return membership;
    if (req.pathname === "/rest/v1/ai_insights" && req.method === "GET") {
      return jsonResponse(200, state.cached ? [state.cached] : []);
    }
    if (req.pathname === "/rest/v1/ai_insights" && req.method === "POST") {
      if (state.insertStatus >= 400) {
        return jsonResponse(state.insertStatus, state.insertBody ?? { message: "insert failed" });
      }
      return emptyResponse(state.insertStatus);
    }
    if (req.pathname === "/rest/v1/ai_insights_write_failures" && req.method === "POST") {
      const body = req.bodyJson;
      const row = (Array.isArray(body) ? body[0] : body) as Record<string, unknown> | undefined;
      state.failures.push({
        tenant_id: String(row?.tenant_id ?? ""),
        request_id: (row?.request_id as string | null | undefined) ?? null,
        error_message: (row?.error_message as string | null | undefined) ?? null,
      });
      return emptyResponse(201);
    }

    if (req.pathname === "/rest/v1/rpc/dashboard_report" && req.method === "POST") {
      if (state.report === undefined) return jsonResponse(500, { message: "rpc failed" });
      return jsonResponse(200, state.report);
    }
    if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      state.gatewayCalls = (state.gatewayCalls ?? 0) + 1;
      if (state.aiThrows) throw new Error("network down");
      return jsonResponse(state.aiStatus, state.aiBody);
    }
    return undefined;
  };
}

function req(
  body?: unknown,
  opts: { method?: string; auth?: string | null; requestId?: string } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token-123");
  if (opts.requestId) headers.set("x-request-id", opts.requestId);
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

/** Captura eventos de `console.log` — usada para asserar os logs estruturados. */
function captureLogs<T>(fn: () => T | Promise<T>): { result: Promise<T>; drain: () => string[] } {
  const lines: string[] = [];
  const original = console.log;
  console.log = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" "));
  };
  const result = Promise.resolve(fn()).finally(() => {
    console.log = original;
  });
  return { result, drain: () => lines };
}

function findWriteEvent(lines: string[]): Record<string, unknown> {
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object" && parsed.event === "ai_insights.write") {
        return parsed;
      }
    } catch {
      // linha não-JSON — ignore
    }
  }
  throw new Error(`nenhum evento ai_insights.write nos logs: ${JSON.stringify(lines)}`);
}

const validBody = { from: "2026-01-01T00:00:00.000Z", to: "2026-02-01T00:00:00.000Z" };

// `force: true` pula o cache — o teto passou a rodar DEPOIS do cache hit, e
// cache hit não pode consumir cota.
const BODY_OK = {
  from: "2026-07-01T00:00:00.000Z",
  to: "2026-08-01T00:00:00.000Z",
  force: true,
};

Deno.test("ai-insights", async (t) => {
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

  await t.step("sem perfil retorna 403 'Perfil não encontrado'", async () => {
    const state = defaultState();
    state.profile = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
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
      const res = await handler(req(validBody));
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

  await t.step("período inválido (from/to ausentes) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({}));
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Período inválido.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("período inválido (to <= from) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req({ from: validBody.to, to: validBody.from }));
      if (res.status !== 400) throw new Error(`esperado 400, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("cache hit retorna insights cacheados sem chamar IA", async () => {
    const state = defaultState();
    state.cached = { insights: [{ diagnostico: "cache" }], created_at: "2026-01-15T00:00:00.000Z" };
    state.aiThrows = true; // provaria que a IA não é chamada nesse caminho
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 200 || body.cached !== true) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("force=true ignora cache e chama a IA mesmo com cache disponível", async () => {
    const state = defaultState();
    state.cached = { insights: [{ diagnostico: "cache" }], created_at: "2026-01-15T00:00:00.000Z" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req({ ...validBody, force: true }));
      const body = await res.json();
      if (res.status !== 200 || body.cached !== false) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("RPC sem relatório retorna 500", async () => {
    const state = defaultState();
    state.report = undefined;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 500) throw new Error(`esperado 500, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("sem LOVABLE_API_KEY retorna 500 'IA indisponível'", async () => {
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

  await t.step("insights não-parseáveis retornam 500", async () => {
    const state = defaultState();
    state.aiBody = { choices: [{ message: { content: "isso não é json" } }] };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (
        res.status !== 500 || body.error !== "A IA retornou uma análise inválida. Tente novamente."
      ) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("caminho feliz: gera insights, grava cache e retorna 200", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 200 || body.cached !== false || !Array.isArray(body.insights)) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("parseInsights filtra itens inválidos e limita a MAX_INSIGHTS", async () => {
    const state = defaultState();
    const validItem = { severidade: "alta", diagnostico: "d", sugestao: "s", link: null };
    state.aiBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              insights: [
                "não é objeto",
                { severidade: "invalida", diagnostico: "d", sugestao: "s" },
                { severidade: "alta", diagnostico: "", sugestao: "s" },
                { severidade: "alta", diagnostico: "d", sugestao: "" },
                validItem,
                validItem,
                validItem,
                validItem,
                validItem,
                validItem,
              ],
            }),
          },
        },
      ],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 200 || body.insights.length !== 5) {
        throw new Error(`inesperado: ${res.status} insights=${JSON.stringify(body.insights)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("insights com envelope array puro (sem wrapper) também é aceito", async () => {
    const state = defaultState();
    state.aiBody = {
      choices: [
        {
          message: {
            content:
              '```json\n[{"severidade":"baixa","diagnostico":"d","sugestao":"s","link":null}]\n```',
          },
        },
      ],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      const body = await res.json();
      if (res.status !== 200 || body.insights.length !== 1) {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("escrita bem-sucedida emite log estruturado ai_insights.write", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const capture = captureLogs(() => handler(req(validBody, { requestId: "req-abc-123" })));
      const res = await capture.result;
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const evt = findWriteEvent(capture.drain());
      const errs: string[] = [];
      if (evt.tenant_id !== "tenant-1") errs.push(`tenant_id=${evt.tenant_id}`);
      if (evt.user_id !== "user-1") errs.push(`user_id=${evt.user_id}`);
      if (evt.request_id !== "req-abc-123") errs.push(`request_id=${evt.request_id}`);
      if (evt.period_from !== validBody.from) errs.push(`period_from=${evt.period_from}`);
      if (evt.period_to !== validBody.to) errs.push(`period_to=${evt.period_to}`);
      if (evt.insight_count !== 1) errs.push(`insight_count=${evt.insight_count}`);
      if (evt.status !== "ok") errs.push(`status=${evt.status}`);
      if (evt.error_code !== null) errs.push(`error_code=${evt.error_code}`);
      if (typeof evt.duration_ms !== "number") errs.push(`duration_ms=${evt.duration_ms}`);
      if (typeof evt.generated_at !== "string") errs.push(`generated_at=${evt.generated_at}`);
      if (typeof evt.model !== "string" || !String(evt.model)) errs.push(`model=${evt.model}`);
      // Regressão anti-PII: o array de insights não pode vazar no log.
      if ("insights" in evt) errs.push("log não deve conter insights");
      if (errs.length) throw new Error(`evento inválido: ${errs.join("; ")}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "falha no insert emite log com status=error e error_code=insert_failed",
    async () => {
      const state = defaultState();
      state.insertStatus = 500;
      state.insertBody = { message: "boom" };
      const uninstall = installFetchMock(router(state));
      try {
        const capture = captureLogs(() => handler(req(validBody)));
        const res = await capture.result;
        // Insert é best-effort — resposta ao usuário continua 200.
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        const evt = findWriteEvent(capture.drain());
        if (evt.status !== "error") throw new Error(`status=${evt.status}`);
        if (evt.error_code !== "insert_failed") throw new Error(`error_code=${evt.error_code}`);
        if (typeof evt.error_message !== "string" || !evt.error_message) {
          throw new Error(`error_message=${JSON.stringify(evt.error_message)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("falha no insert também grava linha em ai_insights_write_failures", async () => {
    const state = defaultState();
    state.insertStatus = 500;
    state.insertBody = { message: "boom" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody, { requestId: "req-xyz-9" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.failures.length !== 1) {
        throw new Error(`esperado 1 falha registrada, veio ${state.failures.length}`);
      }
      const [f] = state.failures;
      if (f.tenant_id !== "tenant-1") throw new Error(`tenant_id=${f.tenant_id}`);
      if (f.request_id !== "req-xyz-9") throw new Error(`request_id=${f.request_id}`);
      if (typeof f.error_message !== "string" || !f.error_message) {
        throw new Error(`error_message=${JSON.stringify(f.error_message)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("caminho feliz NÃO grava linha em ai_insights_write_failures", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req(validBody));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.failures.length !== 0) {
        throw new Error(`não deveria registrar falha: ${JSON.stringify(state.failures)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("cache hit NÃO emite ai_insights.write", async () => {
    const state = defaultState();
    state.cached = { insights: [{ diagnostico: "cache" }], created_at: "2026-01-15T00:00:00.000Z" };
    const uninstall = installFetchMock(router(state));
    try {
      const capture = captureLogs(() => handler(req(validBody)));
      const res = await capture.result;
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      const write = capture.drain().find((l) => {
        try {
          return JSON.parse(l).event === "ai_insights.write";
        } catch {
          return false;
        }
      });
      if (write) throw new Error(`cache-hit não deveria logar write: ${write}`);
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
