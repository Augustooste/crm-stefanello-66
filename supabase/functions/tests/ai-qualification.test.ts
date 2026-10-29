// Testa o handler Deno.serve de ai-qualification/index.ts: auth, posse do
// deal por tenant e — foco deste teste — o rate limit por deal (MEDIUM da
// auditoria: sem teto, um clique repetido do vendedor vira custo de IA sem
// controle). generateQualificationSnapshot em si já é coberta por
// qualification.test.ts; aqui mocka-se as mesmas rotas REST para exercitar
// o handler ponta a ponta.
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

const handler = await captureHandler("../ai-qualification/index.ts");

const DEAL_ID = "deal-1";
const TENANT_ID = "tenant-1";

interface State {
  authOk: boolean;
  profile: { tenant_id: string } | null;
  deal: { tenant_id: string } | null;
  rateLimitAllowed: boolean;
  rateLimitRetryAfterSeconds: number;
  rateLimitRpcFails: boolean;
  insertedSnapshot: { id: string; generated_at: string } | null;
  aiFailureLogsInsertCount: number;
}

function defaultState(): State {
  return {
    authOk: true,
    profile: { tenant_id: TENANT_ID },
    deal: { tenant_id: TENANT_ID },
    rateLimitAllowed: true,
    rateLimitRetryAfterSeconds: 0,
    rateLimitRpcFails: false,
    insertedSnapshot: { id: "snapshot-1", generated_at: "2026-07-09T12:00:00.000Z" },
    aiFailureLogsInsertCount: 0,
  };
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
    const membership = activeMembershipResponse(req, state.profile);
    if (membership) return membership;
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
    // Demais rotas usadas por generateQualificationSnapshot só são
    // exercitadas no caminho "allowed" — mocks mínimos o bastante para o
    // fluxo completar sem lançar.
    if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
      return jsonResponse(200, [{ id: TENANT_ID, name: "Tenant", niche: null }]);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, []);
    }
    if (req.pathname === "/rest/v1/board_stages" && req.method === "GET") {
      return jsonResponse(200, []);
    }
    if (req.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
      return jsonResponse(200, []);
    }
    if (req.pathname === "/rest/v1/niche_templates" && req.method === "GET") {
      return jsonResponse(200, []);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
      return jsonResponse(200, []);
    }
    if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
      return jsonResponse(200, []);
    }
    if (req.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      return jsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify({
                executiveSummary: "Resumo.",
                dimensions: [],
                pendingPoints: [],
                recommendedApproach: {
                  opening: "Abertura.",
                  keyQuestions: [],
                  objectionsToAnticipate: [],
                  suggestedNextStep: "Ligar.",
                },
                alerts: [],
                confidence: 0.5,
              }),
            },
          },
        ],
      });
    }
    if (req.pathname === "/rest/v1/deal_qualification_snapshots" && req.method === "POST") {
      return jsonResponse(201, state.insertedSnapshot);
    }
    if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
      state.aiFailureLogsInsertCount++;
      return jsonResponse(201, {});
    }
    return undefined;
  };
}

function req(body: unknown = { dealId: DEAL_ID }): Request {
  return new Request("http://fn.local", {
    method: "POST",
    headers: { Authorization: "Bearer token-123", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test("ai-qualification rate limit", async (t) => {
  await t.step("bloqueado retorna 429 com retryAfterSeconds, não chama a IA", async () => {
    const state = defaultState();
    state.rateLimitAllowed = false;
    state.rateLimitRetryAfterSeconds = 42;
    let aiCalled = false;
    const uninstall = installFetchMock((r) => {
      if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
      return router(state)(r);
    });
    try {
      const res = await handler(req());
      const body = (await res.json()) as { error: string; retryAfterSeconds: number };
      if (res.status !== 429) throw new Error(`status=${res.status}`);
      if (body.retryAfterSeconds !== 42) {
        throw new Error(`retryAfterSeconds=${body.retryAfterSeconds}`);
      }
      if (aiCalled) throw new Error("não deveria chamar a IA quando rate limited");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "RPC do rate limit falhou (infra, não limite legítimo): reporta falha e retorna 500, não 429",
    async () => {
      const state = defaultState();
      state.rateLimitRpcFails = true;
      let aiCalled = false;
      const uninstall = installFetchMock((r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return router(state)(r);
      });
      try {
        const res = await handler(req());
        const body = (await res.json()) as { error: string; retryAfterSeconds?: number };
        if (res.status !== 500) throw new Error(`status=${res.status}`);
        if (body.retryAfterSeconds !== undefined) {
          throw new Error("resposta de falha de RPC não deveria trazer retryAfterSeconds");
        }
        if (aiCalled) throw new Error("não deveria chamar a IA quando a RPC falhou");
        if (state.aiFailureLogsInsertCount !== 1) {
          throw new Error(
            `esperado 1 insert em ai_failure_logs, veio ${state.aiFailureLogsInsertCount}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("permitido segue o fluxo normal e retorna o snapshot", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req());
      const body = (await res.json()) as { snapshot?: { id: string } };
      if (res.status !== 200) throw new Error(`status=${res.status}`);
      if (body.snapshot?.id !== "snapshot-1") {
        throw new Error(`snapshot inesperado: ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("deal de outro tenant retorna 404 antes de checar rate limit", async () => {
    const state = defaultState();
    state.deal = { tenant_id: "outro-tenant" };
    let rateLimitCalled = false;
    const uninstall = installFetchMock((r) => {
      if (r.pathname === "/rest/v1/rpc/check_and_record_rate_limit") rateLimitCalled = true;
      return router(state)(r);
    });
    try {
      const res = await handler(req());
      if (res.status !== 404) throw new Error(`status=${res.status}`);
      if (rateLimitCalled) {
        throw new Error("rate limit não deveria ser checado antes da posse do deal");
      }
    } finally {
      uninstall();
    }
  });
});
