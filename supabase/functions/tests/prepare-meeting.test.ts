// Preparar reunião: fatos do CRM são determinísticos e a IA não consegue
// trocar cargo, inventar ERP nem vazar id. Cenário = Demo 2 (Atlas Industrial).
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";
import {
  type ActivityRow,
  buildMeetingFacts,
  type ContactRow,
  parseGenerated,
  sanitizeGenerated,
} from "../_shared/meeting-prep.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

function assertEquals(actual: unknown, expected: unknown, msg?: string) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${msg ?? "assertEquals"}: esperado ${e}, veio ${a}`);
}
function assert(cond: unknown, msg: string) {
  if (!cond) throw new Error(msg);
}
const nbsp = (s: string) => s.replace(/ /g, " ");

const NOW = new Date("2026-09-23T15:00:00Z");
const DEAL = {
  title: "Projeto de Automação Comercial B2B",
  value: "180000.00",
  status: "open",
  owner_id: null,
};
const MARIANA: ContactRow = {
  name: "Mariana Costa",
  job_title: "Diretora Comercial",
  email: "mariana.costa@example.com",
  phone: "48999990000",
  description: "Empresa B2B fictícia com 12 vendedores e processo comercial consultivo.",
  notes:
    "Hipóteses para diagnóstico (a validar na reunião): atualização manual do CRM, follow-ups inconsistentes.",
  address_city: "Florianópolis",
};
const ACTIVITIES: ActivityRow[] = [
  {
    type: "task",
    title: "Ligar para confirmar agenda",
    due_at: "2026-09-20T13:00:00Z",
    completed_at: "2026-09-20T13:05:00Z",
  },
  {
    type: "task",
    title: "Reunião de diagnóstico comercial com Mariana Costa",
    due_at: "2026-09-25T13:00:00Z",
    completed_at: null,
  },
  { type: "task", title: "Enviar proposta", due_at: "2026-10-02T13:00:00Z", completed_at: null },
  {
    type: "note",
    title: "Objetivo da reunião: mapear o processo comercial atual.",
    due_at: "2026-09-23T13:00:00Z",
    completed_at: null,
  },
];

function facts(overrides: Partial<Parameters<typeof buildMeetingFacts>[0]> = {}) {
  return buildMeetingFacts({
    deal: DEAL,
    stageName: "Diagnóstico",
    ownerName: "Demo Palestra B2B",
    contact: MARIANA,
    company: { name: "Atlas Industrial", industry: "Soluções industriais B2B" },
    activities: ACTIVITIES,
    now: NOW,
    ...overrides,
  });
}

Deno.test("cargo vem de contacts.job_title", () => {
  assertEquals(facts().contact?.title, "Diretora Comercial");
});

Deno.test("estágio usa board_stages.name, nunca deals.status", () => {
  const f = facts();
  assertEquals(f.deal.stageName, "Diagnóstico");
  assert(!JSON.stringify(f).includes('"open"'), "status técnico vazou para os fatos");
});

Deno.test("valor mantém o valor do negócio (R$ 180.000)", () => {
  const f = facts();
  assertEquals(f.deal.value, 180000);
  assertEquals(nbsp(f.deal.valueLabel), "R$ 180.000");
});

Deno.test("reunião certa: próxima aberta com 'reunião' no título, em horário de Brasília", () => {
  const f = facts();
  assertEquals(f.meeting?.title, "Reunião de diagnóstico comercial com Mariana Costa");
  assertEquals(f.meeting?.dateLabel, "25/09/2026");
  assertEquals(f.meeting?.timeLabel, "10:00");
  assertEquals(f.objective, "mapear o processo comercial atual.");
});

Deno.test("notas entram no contexto e hipóteses registradas ficam separadas dos fatos", () => {
  const f = facts();
  assertEquals(f.knownContext, [MARIANA.description]);
  assertEquals(f.recordedHypotheses, [MARIANA.notes]);
});

Deno.test("sem cargo: não inventa cargo e sinaliza 'não informado'", () => {
  const f = facts({ contact: { ...MARIANA, name: "João Teste", job_title: null } });
  assertEquals(f.contact?.title, null);
  assert(
    f.attentionPoints.some((p) => p.includes("Cargo de João Teste não informado")),
    "faltou aviso de cargo",
  );
  const { briefing } = sanitizeGenerated(
    {
      summary: "João Teste é Gerente de Compras.",
      hypotheses: [],
      suggestedQuestions: ["Como o diretor decide?"],
      attentionPoints: [],
    },
    f,
  );
  assertEquals(briefing.summary, null);
  assertEquals(briefing.suggestedQuestions, []);
});

Deno.test(
  "ALUCINAÇÃO: IA diz 'Gerente Comercial' — texto descartado, fato continua Diretora Comercial",
  () => {
    const f = facts();
    const gen = parseGenerated(
      JSON.stringify({
        summary: "Mariana Costa é Gerente Comercial da Atlas Industrial.",
        hypotheses: [
          { text: "Pode existir atualização manual do CRM.", reason: "Hipótese registrada." },
        ],
        suggestedQuestions: ["Como o time registra hoje as interações no CRM?"],
        attentionPoints: [],
      }),
    )!;
    const { briefing, rejected } = sanitizeGenerated(gen, f);
    assertEquals(briefing.summary, null);
    assertEquals(rejected, ["cargo:gerente"]);
    assertEquals(briefing.hypotheses.length, 1);
    assertEquals(f.contact?.title, "Diretora Comercial");
  },
);

Deno.test("ALUCINAÇÃO: 'ERP legado' sem fonte é rejeitado em qualquer seção", () => {
  const { briefing, rejected } = sanitizeGenerated(
    {
      summary: "Atlas Industrial avalia automação comercial.",
      hypotheses: [{ text: "Integração com ERP legado pode ser um risco.", reason: "inferência" }],
      suggestedQuestions: ["Vocês usam SAP ou TOTVS?", "Como funciona o follow-up após reuniões?"],
      attentionPoints: ["Risco: sistema legado."],
    },
    facts(),
  );
  assertEquals(briefing.hypotheses, []);
  assertEquals(briefing.suggestedQuestions, ["Como funciona o follow-up após reuniões?"]);
  assertEquals(briefing.attentionPoints, []);
  assertEquals(rejected.length, 3);
});

Deno.test("ERP é aceito quando está nas fontes do CRM", () => {
  const f = facts({ contact: { ...MARIANA, description: "Usa ERP próprio há 10 anos." } });
  const { briefing } = sanitizeGenerated(
    {
      summary: null,
      hypotheses: [],
      suggestedQuestions: ["Como o ERP conversa com o CRM?"],
      attentionPoints: [],
    },
    f,
  );
  assertEquals(briefing.suggestedQuestions.length, 1);
});

Deno.test("id técnico nunca chega ao briefing", () => {
  const f = facts();
  assert(!/[0-9a-f]{8}-[0-9a-f]{4}-/i.test(JSON.stringify(f)), "fatos com uuid");
  const { briefing } = sanitizeGenerated(
    {
      summary: "Negócio 701661ff-9171-420f-8b3f-6e209caac952 em diagnóstico.",
      hypotheses: [],
      suggestedQuestions: [],
      attentionPoints: [],
    },
    f,
  );
  assertEquals(briefing.summary, null);
});

Deno.test("parseGenerated aceita cerca markdown e rejeita lixo", () => {
  assert(
    parseGenerated(
      '```json\n{"summary":"ok","hypotheses":[],"suggestedQuestions":[],"attentionPoints":[]}\n```',
    )?.summary === "ok",
    "cerca",
  );
  assertEquals(parseGenerated("não é json"), null);
});

// ---------------------------------------------------------------------------
// Handler: isolamento por tenant e contato certo
// ---------------------------------------------------------------------------

const handler = await captureHandler("../prepare-meeting/index.ts");
const DEAL_ID = "11111111-1111-4111-8111-111111111111";
const TENANT = "tenant-demo";

function router(opts: {
  dealVisible: boolean;
  seen: MockRequest[];
  aiContent: string;
}): FetchMatcher {
  return (req) => {
    opts.seen.push(req);
    if (req.pathname === "/auth/v1/user")
      return jsonResponse(200, { id: "user-1", aud: "authenticated" });
    if (req.pathname === "/rest/v1/profiles") {
      return jsonResponse(
        200,
        req.url.includes("select=tenant_id") ? [{ tenant_id: TENANT }] : [{ name: "Vendedor" }],
      );
    }
    if (req.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(200, [
        { tenant_id: TENANT, user_id: "user-1", role_id: "r1", status: "active", revoked_at: null },
      ]);
    }
    if (req.pathname === "/rest/v1/roles") return jsonResponse(200, [{ role_key: "seller" }]);
    if (req.pathname === "/rest/v1/deals") {
      return jsonResponse(
        200,
        opts.dealVisible
          ? [{ ...DEAL, board_id: "b1", stage_id: "s1", contact_id: "c-mariana-atlas" }]
          : [],
      );
    }
    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit") {
      return jsonResponse(200, { allowed: true, retryAfterSeconds: 0 });
    }
    if (req.pathname === "/rest/v1/board_stages")
      return jsonResponse(200, [{ name: "Diagnóstico" }]);
    if (req.pathname === "/rest/v1/contacts")
      return jsonResponse(200, [{ ...MARIANA, company_id: "co-atlas" }]);
    if (req.pathname === "/rest/v1/crm_companies")
      return jsonResponse(200, [{ name: "Atlas Industrial", industry: null }]);
    if (req.pathname === "/rest/v1/activities") return jsonResponse(200, ACTIVITIES);
    if (req.pathname === "/rest/v1/system_events") return jsonResponse(201, {});
    if (req.url.includes("ai.gateway.lovable.dev")) {
      return jsonResponse(200, { choices: [{ message: { content: opts.aiContent } }] });
    }
    return undefined;
  };
}

function post(body: unknown) {
  return new Request("http://localhost/prepare-meeting", {
    method: "POST",
    headers: { Authorization: "Bearer user-jwt", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

Deno.test(
  "handler: negócio de outra organização devolve 404 e a query filtra tenant_id",
  async () => {
    const seen: MockRequest[] = [];
    const uninstall = installFetchMock(router({ dealVisible: false, seen, aiContent: "{}" }));
    try {
      const res = await handler(post({ dealId: DEAL_ID }));
      assertEquals(res.status, 404);
      await res.body?.cancel();
      const dealReq = seen.find((r) => r.pathname === "/rest/v1/deals")!;
      assert(dealReq.url.includes(`tenant_id=eq.${TENANT}`), "deals sem filtro de tenant");
      assertEquals(dealReq.headers.get("authorization"), "Bearer user-jwt");
      assert(!seen.some((r) => r.url.includes("ai.gateway")), "chamou IA sem negócio");
    } finally {
      uninstall();
    }
  },
);

Deno.test("handler: contato lido pelo contact_id do negócio; fatos não vêm da IA", async () => {
  const seen: MockRequest[] = [];
  const ai = JSON.stringify({
    summary: "Mariana Costa, Gerente Comercial, usa ERP legado.",
    hypotheses: [{ text: "Pode haver atualização manual do CRM.", reason: "hipótese registrada" }],
    suggestedQuestions: ["Quanto trabalho manual existe na atualização das oportunidades?"],
    attentionPoints: [],
  });
  const uninstall = installFetchMock(router({ dealVisible: true, seen, aiContent: ai }));
  try {
    const res = await handler(post({ dealId: DEAL_ID }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.facts.contact.title, "Diretora Comercial");
    assertEquals(body.facts.company.name, "Atlas Industrial");
    assertEquals(body.generated.summary, null);
    assertEquals(body.generated.suggestedQuestions.length, 1);
    const contactReq = seen.find((r) => r.pathname === "/rest/v1/contacts")!;
    assert(contactReq.url.includes("id=eq.c-mariana-atlas"), "contato não veio pelo contact_id");
    assert(contactReq.url.includes(`tenant_id=eq.${TENANT}`), "contacts sem filtro de tenant");
    // board_stages não tem coluna tenant_id (erro real em produção, 23/09).
    const stageReq = seen.find((r) => r.pathname === "/rest/v1/board_stages")!;
    assert(!stageReq.url.includes("tenant_id="), "board_stages não tem tenant_id");
    assert(stageReq.url.includes("board_id=eq.b1"), "estágio sem escopo de board");
  } finally {
    uninstall();
  }
});

Deno.test("handler: dealId que não é uuid é recusado", async () => {
  const uninstall = installFetchMock(router({ dealVisible: true, seen: [], aiContent: "{}" }));
  try {
    const res = await handler(post({ dealId: "Atlas Industrial" }));
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    uninstall();
  }
});
