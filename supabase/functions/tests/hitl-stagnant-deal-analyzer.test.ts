// Testa hitl-stagnant-deal-analyzer: (1) a lógica pura (logic.ts, sem I/O) —
// resolução de config, guardrail de evidência, heurística de categoria/
// prioridade, montagem do insert — e (2) o handler HTTP — auth fail-closed,
// validação de corpo, guardrail "sem conversa real, sem avanço automático",
// dedupe de sugestão pendente por deal_id, rate limit compartilhado entre
// tenants, e o caminho feliz de ponta a ponta com o gateway de IA mockado.
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { daysAgoIso, req } from "./_hitl-test-helpers.ts";
import {
  buildStagnantDecisionInsert,
  categorizeAssessment,
  daysStagnant,
  DEFAULT_RATE_LIMIT,
  DEFAULT_STALE_DAYS,
  hasEnoughEvidence,
  MAX_RATE_LIMIT,
  MAX_STALE_DAYS,
  priorityFor,
  resolveRateLimit,
  resolveScanBatchSize,
  resolveStaleDays,
  SCAN_MULTIPLIER,
  type StagnantAssessment,
  type StagnantDealCandidate,
} from "../hitl-stagnant-deal-analyzer/logic.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

const handler = await captureHandler("../hitl-stagnant-deal-analyzer/index.ts");

const TENANT_ID = "tenant-1";

// -------------------- Lógica pura (logic.ts) --------------------

Deno.test("resolveStaleDays (regra pura, sem I/O)", async (t) => {
  await t.step("sem requested nem env => DEFAULT_STALE_DAYS", () => {
    if (resolveStaleDays(undefined, undefined) !== DEFAULT_STALE_DAYS) {
      throw new Error("esperado default");
    }
  });

  await t.step("requested válido vence env e default", () => {
    if (resolveStaleDays(5, "10") !== 5) throw new Error("esperado 5 (requested)");
  });

  await t.step("sem requested, usa env quando válido", () => {
    if (resolveStaleDays(undefined, "7") !== 7) throw new Error("esperado 7 (env)");
  });

  await t.step("requested inválido (<=0, NaN, não-número) cai pro fallback", () => {
    if (resolveStaleDays(0, "7") !== 7) throw new Error("esperado fallback env para 0");
    if (resolveStaleDays(-1, undefined) !== DEFAULT_STALE_DAYS) {
      throw new Error("esperado default para -1");
    }
    if (resolveStaleDays("abc", undefined) !== DEFAULT_STALE_DAYS) {
      throw new Error("esperado default para string");
    }
  });

  await t.step("capa em MAX_STALE_DAYS mesmo se requested for maior", () => {
    if (resolveStaleDays(9999, undefined) !== MAX_STALE_DAYS) {
      throw new Error("esperado cap em MAX_STALE_DAYS");
    }
  });
});

Deno.test("resolveRateLimit (regra pura, sem I/O)", async (t) => {
  await t.step("sem requested nem env => DEFAULT_RATE_LIMIT", () => {
    if (resolveRateLimit(undefined, undefined) !== DEFAULT_RATE_LIMIT) {
      throw new Error("esperado default");
    }
  });

  await t.step("requested válido vence env e default", () => {
    if (resolveRateLimit(3, "50") !== 3) throw new Error("esperado 3 (requested)");
  });

  await t.step("sem requested, usa env quando válido", () => {
    if (resolveRateLimit(undefined, "50") !== 50) throw new Error("esperado 50 (env)");
  });

  await t.step("capa em MAX_RATE_LIMIT mesmo se requested for maior", () => {
    if (resolveRateLimit(9999, undefined) !== MAX_RATE_LIMIT) {
      throw new Error("esperado cap em MAX_RATE_LIMIT");
    }
  });
});

Deno.test("resolveScanBatchSize (regra pura, sem I/O)", async (t) => {
  await t.step("multiplica o rate limit por SCAN_MULTIPLIER", () => {
    if (resolveScanBatchSize(10) !== 10 * SCAN_MULTIPLIER) {
      throw new Error("esperado rateLimit * SCAN_MULTIPLIER");
    }
  });

  await t.step("capa no teto mesmo com rate limit alto", () => {
    if (resolveScanBatchSize(MAX_RATE_LIMIT) > 200) {
      throw new Error("esperado capado em MAX_SCAN_BATCH");
    }
  });
});

Deno.test("hasEnoughEvidence (guardrail 'sem conversa real, sem avanço automático')", async (t) => {
  await t.step("sem nenhuma conversa vinculada => false", () => {
    if (hasEnoughEvidence([])) throw new Error("esperado false sem conversas");
  });

  await t.step("conversa com menos de 3 mensagens no total => false", () => {
    const evidence = [{ conversationId: "c1", totalMessages: 2, contactMessages: 1 }];
    if (hasEnoughEvidence(evidence)) throw new Error("esperado false com só 2 mensagens");
  });

  await t.step(">=3 mensagens mas ZERO do contato (só IA/agente falando) => false", () => {
    const evidence = [{ conversationId: "c1", totalMessages: 5, contactMessages: 0 }];
    if (hasEnoughEvidence(evidence)) {
      throw new Error(
        "esperado false sem nenhuma mensagem do contato (engajamento não confirmado)",
      );
    }
  });

  await t.step(">=3 mensagens no total E >=1 do contato => true", () => {
    const evidence = [{ conversationId: "c1", totalMessages: 3, contactMessages: 1 }];
    if (!hasEnoughEvidence(evidence)) throw new Error("esperado true (evidência suficiente)");
  });

  await t.step("basta UMA conversa qualificar entre várias vinculadas", () => {
    const evidence = [
      { conversationId: "c1", totalMessages: 1, contactMessages: 0 },
      { conversationId: "c2", totalMessages: 4, contactMessages: 2 },
    ];
    if (!hasEnoughEvidence(evidence)) throw new Error("esperado true (c2 qualifica)");
  });
});

Deno.test("categorizeAssessment / priorityFor (heurística de categoria)", async (t) => {
  await t.step('"advance" => opportunity', () => {
    if (categorizeAssessment("advance") !== "opportunity") throw new Error("esperado opportunity");
  });

  await t.step('"stalled" => risk', () => {
    if (categorizeAssessment("stalled") !== "risk") throw new Error("esperado risk");
  });

  await t.step("risk com >=14 dias parado => high", () => {
    if (priorityFor("risk", 20) !== "high") throw new Error("esperado high");
    if (priorityFor("risk", 14) !== "high") {
      throw new Error("esperado high no limite exato de 14 dias");
    }
  });

  await t.step("risk com <14 dias parado => medium", () => {
    if (priorityFor("risk", 13.9) !== "medium") throw new Error("esperado medium");
  });

  await t.step("opportunity é sempre medium, independente dos dias", () => {
    if (priorityFor("opportunity", 100) !== "medium") {
      throw new Error("esperado medium mesmo com muitos dias");
    }
  });
});

Deno.test("daysStagnant calcula fração de dias corretamente", () => {
  const now = new Date("2026-07-10T12:00:00.000Z");
  const stageEnteredAt = new Date(now.getTime() - 36 * 60 * 60 * 1000).toISOString();
  const days = daysStagnant(stageEnteredAt, now);
  if (Math.abs(days - 1.5) > 1e-9) throw new Error(`esperado 1.5, obtido ${days}`);
});

Deno.test("buildStagnantDecisionInsert monta o payload correto", async (t) => {
  const candidate: StagnantDealCandidate = {
    id: "deal-1",
    tenant_id: TENANT_ID,
    contact_id: "contact-1",
    title: "Proposta ACME",
  };

  await t.step('assessment "advance" => category opportunity, priority medium', () => {
    const assessment: StagnantAssessment = {
      confidence: 0.8,
      assessment: "advance",
      reasoning: "Lead pediu proposta formal.",
      suggestedAction: "send_proposal",
    };
    const payload = buildStagnantDecisionInsert(candidate, assessment, 5);
    if (payload.type !== "stagnant_deal") throw new Error(`type inesperado: ${payload.type}`);
    if (payload.category !== "opportunity") {
      throw new Error(`category inesperado: ${payload.category}`);
    }
    if (payload.priority !== "medium") throw new Error(`priority inesperado: ${payload.priority}`);
    if (payload.deal_id !== "deal-1") throw new Error("deal_id inesperado");
    if (payload.contact_id !== "contact-1") throw new Error("contact_id inesperado");
    if (payload.auto_generated !== true) throw new Error("auto_generated deveria ser true");
    if (payload.suggested_action.action !== "send_proposal") throw new Error("action inesperada");
    if (payload.suggested_action.confidence !== 0.8) throw new Error("confidence inesperada");
    if (payload.suggested_action.days_stagnant !== 5) throw new Error("days_stagnant inesperado");
    if (!payload.title.includes("5 dias")) throw new Error(`title inesperado: ${payload.title}`);
  });

  await t.step('assessment "stalled" com muitos dias => category risk, priority high', () => {
    const assessment: StagnantAssessment = {
      confidence: 0.6,
      assessment: "stalled",
      reasoning: "Lead parou de responder há 2 semanas.",
      suggestedAction: "follow_up_call",
    };
    const payload = buildStagnantDecisionInsert(candidate, assessment, 20);
    if (payload.category !== "risk") throw new Error(`category inesperado: ${payload.category}`);
    if (payload.priority !== "high") throw new Error(`priority inesperado: ${payload.priority}`);
  });

  await t.step("deal sem título usa fallback 'sem título' no title da decisão", () => {
    const noTitleCandidate: StagnantDealCandidate = { ...candidate, title: null };
    const assessment: StagnantAssessment = {
      confidence: 0.5,
      assessment: "stalled",
      reasoning: "",
      suggestedAction: "review_manually",
    };
    const payload = buildStagnantDecisionInsert(noTitleCandidate, assessment, 1);
    if (!payload.title.includes("sem título")) {
      throw new Error(`title inesperado: ${payload.title}`);
    }
  });
});

// -------------------- Handler HTTP (index.ts) --------------------

function dealRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "deal-1",
    tenant_id: TENANT_ID,
    contact_id: "contact-1",
    stage_id: "stage-1",
    stage_entered_at: daysAgoIso(10),
    title: "Proposta ACME",
    ...overrides,
  };
}

/** Monta o roteador padrão do caminho feliz — cada teste sobrescreve só o
 * que precisa via `overrides`. */
function buildRouter(overrides: {
  deals?: unknown[];
  messageCounts?: Record<string, { total: number; contact: number }>;
  pendingDecisionExists?: boolean;
  aiResponse?: unknown;
  onInsert?: (payload: Record<string, unknown>) => void;
} = {}): FetchMatcher {
  const deals = overrides.deals ?? [dealRow()];
  const messageCounts = overrides.messageCounts ?? { "conv-1": { total: 3, contact: 1 } };

  return (r) => {
    if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
      return jsonResponse(200, [{ id: TENANT_ID }]);
    }
    if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
      return jsonResponse(200, deals);
    }
    if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
      return jsonResponse(200, Object.keys(messageCounts).map((id) => ({ id })));
    }
    if (r.pathname === "/rest/v1/messages" && r.method === "HEAD") {
      const sp = new URL(r.url).searchParams;
      const conversationFilter = sp.get("conversation_id") ?? "";
      const convId = conversationFilter.replace("eq.", "");
      const counts = messageCounts[convId] ?? { total: 0, contact: 0 };
      const isContactFilter = sp.get("sender") === "eq.contact";
      const count = isContactFilter ? counts.contact : counts.total;
      return new Response(null, { status: 200, headers: { "content-range": `*/${count}` } });
    }
    if (r.pathname === "/rest/v1/messages" && r.method === "GET") {
      // Transcript: qualquer histórico não-vazio já é suficiente pros testes
      // do handler (o conteúdo exato é validado em ai-respond, não aqui).
      return jsonResponse(200, [{
        sender: "contact",
        content: "Quero saber o preço.",
        created_at: daysAgoIso(1),
      }]);
    }
    if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "GET") {
      return jsonResponse(200, overrides.pendingDecisionExists ? [{ id: "existing-pending" }] : []);
    }
    if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "POST") {
      overrides.onInsert?.(r.bodyJson as Record<string, unknown>);
      return new Response(null, { status: 201 });
    }
    if (r.pathname === "/rest/v1/ai_settings" && r.method === "GET") {
      return jsonResponse(200, [{ model: "default" }]);
    }
    if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
      return jsonResponse(200, {
        choices: [
          {
            message: {
              content: JSON.stringify(
                overrides.aiResponse ?? {
                  confidence: 0.75,
                  assessment: "advance",
                  reasoning: "Lead demonstrou interesse concreto.",
                  suggestedAction: "send_proposal",
                },
              ),
            },
          },
        ],
      });
    }
    return undefined;
  };
}

Deno.test("hitl-stagnant-deal-analyzer (handler)", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const res = await handler(req(undefined, { method: "OPTIONS" }));
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (await res.text()) throw new Error("esperado corpo vazio");
  });

  await t.step("método não-POST retorna 405", async () => {
    const res = await handler(req(undefined, { method: "GET" }));
    if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
  });

  await t.step("sem Authorization retorna 401", async () => {
    const res = await handler(req(undefined, { auth: null }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const res = await handler(req(undefined, { auth: "Bearer errado" }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("corpo presente e inválido (JSON quebrado) retorna 400", async () => {
    const res = await handler(
      new Request("http://fn.local", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`,
          "content-type": "application/json",
        },
        body: "{not-json",
      }),
    );
    const body = await res.json();
    if (res.status !== 400 || body.error !== "Corpo inválido.") {
      throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("tenantId de tipo errado retorna 400", async () => {
    const res = await handler(req({ tenantId: 123 }));
    const body = await res.json();
    if (res.status !== 400 || body.error !== "tenantId inválido.") {
      throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("sem tenants ativos: não consulta deals e devolve summary zerado", async () => {
    let sawDealsQuery = false;
    const router: FetchMatcher = (r) => {
      if (r.pathname === "/rest/v1/tenants" && r.method === "GET") return jsonResponse(200, []);
      if (r.pathname === "/rest/v1/deals") sawDealsQuery = true;
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const res = await handler(req(undefined));
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.scanned !== 0 || body.evaluated !== 0 || body.created !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (sawDealsQuery) throw new Error("não deveria consultar deals sem tenants ativos");
    } finally {
      uninstall();
    }
  });

  await t.step("erro na query de deals retorna 500", async () => {
    const router: FetchMatcher = (r) => {
      if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
        return jsonResponse(200, [{ id: TENANT_ID }]);
      }
      if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
        return jsonResponse(500, { code: "XX000", message: "timeout", details: null, hint: null });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const res = await handler(req({ tenantId: TENANT_ID }));
      if (res.status !== 500) throw new Error(`esperado 500, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "query de deals filtra status=open, stage_entered_at < cutoff e tenant_id in (ativos)",
    async () => {
      let checked = false;
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
          return jsonResponse(200, [{ id: TENANT_ID }]);
        }
        if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
          const sp = new URL(r.url).searchParams;
          if (sp.get("status") !== "eq.open") {
            throw new Error(`status inesperado: ${sp.get("status")}`);
          }
          const stageEnteredFilters = sp.getAll("stage_entered_at");
          if (!stageEnteredFilters.some((f) => f.startsWith("lt."))) {
            throw new Error(
              `stage_entered_at lt.* ausente: ${JSON.stringify(stageEnteredFilters)}`,
            );
          }
          const tenantFilter = sp.get("tenant_id") ?? "";
          if (!tenantFilter.startsWith("in.") || !tenantFilter.includes(TENANT_ID)) {
            throw new Error(`tenant_id inesperado: ${tenantFilter}`);
          }
          checked = true;
          return jsonResponse(200, []);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID, staleDays: 5 }));
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (!checked) throw new Error("query de deals não foi verificada");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "guardrail: deal sem contact_id nunca chama a IA nem consulta conversations",
    async () => {
      let aiCalled = false;
      let sawConversationsQuery = false;
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
          return jsonResponse(200, [{ id: TENANT_ID }]);
        }
        if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
          return jsonResponse(200, [dealRow({ contact_id: null })]);
        }
        if (r.pathname === "/rest/v1/conversations") sawConversationsQuery = true;
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.skippedNoEvidence !== 1 || body.evaluated !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (aiCalled) throw new Error("a IA não deveria ter sido chamada");
        if (sawConversationsQuery) {
          throw new Error("não deveria consultar conversations sem contact_id");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "guardrail: conversa com menos de 3 mensagens não chama a IA (skippedNoEvidence)",
    async () => {
      let aiCalled = false;
      const router = buildRouter({ messageCounts: { "conv-1": { total: 2, contact: 1 } } });
      const wrapped: FetchMatcher = (r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return router(r);
      };
      const uninstall = installFetchMock(wrapped);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.skippedNoEvidence !== 1 || body.evaluated !== 0 || body.created !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (aiCalled) throw new Error("a IA não deveria ter sido chamada sem evidência suficiente");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "guardrail: 3+ mensagens mas todas da IA/agente (0 do contato) não chama a IA",
    async () => {
      let aiCalled = false;
      const router = buildRouter({ messageCounts: { "conv-1": { total: 5, contact: 0 } } });
      const wrapped: FetchMatcher = (r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return router(r);
      };
      const uninstall = installFetchMock(wrapped);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (body.skippedNoEvidence !== 1) throw new Error(`inesperado: ${JSON.stringify(body)}`);
        if (aiCalled) throw new Error("a IA não deveria ter sido chamada sem resposta do contato");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "caminho feliz: evidência suficiente => avalia por IA e cria hitl_decisions",
    async () => {
      let insertedPayload: Record<string, unknown> | undefined;
      const router = buildRouter({
        onInsert: (payload) => {
          insertedPayload = payload;
        },
      });
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.scanned !== 1 || body.evaluated !== 1 || body.created !== 1 || body.failed !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (!insertedPayload) throw new Error("insert em hitl_decisions não foi disparado");
        if (insertedPayload.type !== "stagnant_deal") {
          throw new Error(`type inesperado: ${insertedPayload.type}`);
        }
        if (insertedPayload.category !== "opportunity") {
          throw new Error(`category inesperado: ${insertedPayload.category}`);
        }
        if (insertedPayload.deal_id !== "deal-1") throw new Error("deal_id inesperado");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "dedupe: já existe sugestão pendente para o deal => não chama IA nem duplica insert",
    async () => {
      let aiCalled = false;
      let insertCalled = false;
      const router = buildRouter({
        pendingDecisionExists: true,
        onInsert: () => {
          insertCalled = true;
        },
      });
      const wrapped: FetchMatcher = (r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCalled = true;
        return router(r);
      };
      const uninstall = installFetchMock(wrapped);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (body.skippedAlreadyPending !== 1 || body.evaluated !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (aiCalled) {
          throw new Error("a IA não deveria ter sido chamada com pendência já existente");
        }
        if (insertCalled) throw new Error("não deveria inserir com pendência já existente");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "rate limit: com limit=1 e 2 deals qualificando, só o 1º é avaliado (2º => skippedRateLimit)",
    async () => {
      const deals = [
        dealRow({ id: "deal-a", stage_entered_at: daysAgoIso(20) }),
        dealRow({ id: "deal-b", stage_entered_at: daysAgoIso(15) }),
      ];
      let aiCallCount = 0;
      const router = buildRouter({ deals });
      const wrapped: FetchMatcher = (r) => {
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") aiCallCount++;
        return router(r);
      };
      const uninstall = installFetchMock(wrapped);
      try {
        const res = await handler(req({ tenantId: TENANT_ID, limit: 1 }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.scanned !== 2 || body.evaluated !== 1 || body.skippedRateLimit !== 1) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
        if (aiCallCount !== 1) {
          throw new Error(`IA deveria ter sido chamada 1x, veio ${aiCallCount}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "resposta da IA malformada (não-JSON) conta como failed, sem inserir decisão",
    async () => {
      const router: FetchMatcher = (r) => {
        if (r.pathname === "/rest/v1/tenants" && r.method === "GET") {
          return jsonResponse(200, [{ id: TENANT_ID }]);
        }
        if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
          return jsonResponse(200, [dealRow()]);
        }
        if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
          return jsonResponse(200, [{ id: "conv-1" }]);
        }
        if (r.pathname === "/rest/v1/messages" && r.method === "HEAD") {
          return new Response(null, { status: 200, headers: { "content-range": "*/3" } });
        }
        if (r.pathname === "/rest/v1/messages" && r.method === "GET") {
          return jsonResponse(200, [{
            sender: "contact",
            content: "oi",
            created_at: daysAgoIso(1),
          }]);
        }
        if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "GET") {
          return jsonResponse(200, []);
        }
        if (r.pathname === "/rest/v1/ai_settings" && r.method === "GET") {
          return jsonResponse(200, [{ model: "default" }]);
        }
        if (r.url === "https://ai.gateway.lovable.dev/v1/chat/completions") {
          return jsonResponse(200, { choices: [{ message: { content: "não é json" } }] });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const res = await handler(req({ tenantId: TENANT_ID }));
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.evaluated !== 1 || body.failed !== 1 || body.created !== 0) {
          throw new Error(`inesperado: ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});
