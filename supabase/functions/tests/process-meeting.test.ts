// Resultado da reunião: grava a reunião no negócio certo sem tocar em
// negócio/contato, é idempotente e o follow-up é só rascunho, sem número,
// tecnologia ou compromisso inventado. Cenário = Demo 4 (Atlas Industrial).
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
  draftRejectReason,
  type FollowupContext,
  type MeetingInput,
  parseMeetingInput,
  templateDraft,
} from "../_shared/meeting-result.ts";

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

const MEETING = {
  meetingId: "demo4-atlas-diagnostico",
  title: "Reunião de diagnóstico comercial",
  seller: "Lucas",
  participants: ["Lucas", "Mariana Costa"],
  summary:
    "A Atlas Industrial relatou dependência de atualizações manuais no CRM, com registros que podem ocorrer no fim do dia ou no dia seguinte.",
  painPoints: ["Atualização das oportunidades no CRM depende dos vendedores."],
  objections: ["Receio de adicionar tecnologia que gere mais trabalho para os vendedores."],
  priorities: ["Reduzir atividades administrativas.", "Aumentar a confiabilidade do pipeline."],
  nextSteps: [
    "Mapear o fluxo comercial atual, identificar tarefas automatizáveis e estimar economia de tempo.",
  ],
};
const CTX: FollowupContext = {
  contactName: "Mariana Costa",
  companyName: "Atlas Industrial",
  meeting: MEETING as MeetingInput,
};

// ---------------------------------------------------------------------------
// Contrato
// ---------------------------------------------------------------------------

Deno.test("contrato: aceita a reunião e ignora empresa/valor/estágio vindos de fora", () => {
  const r = parseMeetingInput({ ...MEETING, value: 999, stage: "Proposta", company: "X" });
  assert(r.ok, "recusou payload válido");
  if (r.ok) assert(!("value" in r.meeting) && !("stage" in r.meeting), "vazou campo do CRM");
});

Deno.test("contrato: sem meetingId, summary ou nextSteps é recusado", () => {
  assert(!parseMeetingInput({ ...MEETING, meetingId: "" }).ok, "meetingId");
  assert(!parseMeetingInput({ ...MEETING, summary: " " }).ok, "summary");
  assert(!parseMeetingInput({ ...MEETING, nextSteps: [] }).ok, "nextSteps");
});

// ---------------------------------------------------------------------------
// Follow-up: guardrail anti-alucinação
// ---------------------------------------------------------------------------

Deno.test("follow-up modelo: fiel à reunião e passa no próprio guardrail", () => {
  const d = templateDraft(CTX, new Date("2026-09-23T18:00:00Z"));
  assertEquals(d.subject, "Próximos passos — Atlas Industrial");
  assert(d.email.startsWith("Mariana,"), "saudação");
  assert(d.email.includes("reduzir atividades administrativas"), "prioridade 1");
  assert(d.email.includes("aumentar a confiabilidade do pipeline"), "prioridade 2");
  assert(d.email.includes("receio de adicionar tecnologia"), "objeção");
  assert(d.email.includes("mapear o fluxo comercial atual"), "próximo passo");
  assertEquals(draftRejectReason(`${d.subject}\n${d.email}\n${d.whatsapp}`, CTX), null);
});

Deno.test("ALUCINAÇÃO: tecnologia inventada (Salesforce, Outlook) é recusada", () => {
  assertEquals(
    draftRejectReason("Como falamos sobre Salesforce, seguimos.", CTX),
    "tecnologia:salesforce",
  );
  assertEquals(draftRejectReason("Integramos com o Outlook.", CTX), "tecnologia:outlook");
});

Deno.test("ALUCINAÇÃO: número inventado (30 horas por semana) é recusado", () => {
  assertEquals(draftRejectReason("Economizaremos 30 horas por semana.", CTX), "numero:30");
  assert(draftRejectReason("Economia de horas do time.", CTX)?.startsWith("compromisso"), "horas");
  assertEquals(draftRejectReason("Custo de R$ 5 mil.", CTX), "valor");
});

Deno.test("ALUCINAÇÃO: reunião, data, prazo e proposta não combinados são recusados", () => {
  assert(
    draftRejectReason("Na nossa próxima reunião terça-feira revisamos.", CTX),
    "dia da semana",
  );
  assert(draftRejectReason("Vou enviar a proposta até sexta.", CTX), "proposta");
  assert(draftRejectReason("Podemos agendar uma call?", CTX), "agendar");
  assert(draftRejectReason("Consigo um desconto especial.", CTX), "desconto");
  // Runtime 23/09: IA escreveu "nossa reunião ... hoje" sem data na reunião.
  assertEquals(
    draftRejectReason("Agradeço pela nossa reunião de diagnóstico comercial hoje.", CTX),
    "compromisso:hoje",
  );
  // "marcou" não é o mês "março".
  assertEquals(draftRejectReason("A conversa marcou pontos importantes.", CTX), null);
});

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

const handler = await captureHandler("../process-meeting/index.ts");
const DEAL_ID = "22222222-2222-4222-8222-222222222222";
const TENANT = "tenant-demo";

interface RouterOpts {
  dealVisible: boolean;
  seen: MockRequest[];
  existingKey?: boolean;
  storedMeeting?: boolean;
  storedDraft?: unknown;
  aiContent?: string;
}

function router(o: RouterOpts): FetchMatcher {
  return (req) => {
    o.seen.push(req);
    if (req.pathname === "/auth/v1/user")
      return jsonResponse(200, { id: "user-1", aud: "authenticated" });
    if (req.pathname === "/rest/v1/profiles") return jsonResponse(200, [{ tenant_id: TENANT }]);
    if (req.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(200, [
        { tenant_id: TENANT, user_id: "user-1", role_id: "r1", status: "active", revoked_at: null },
      ]);
    }
    if (req.pathname === "/rest/v1/roles") return jsonResponse(200, [{ role_key: "seller" }]);
    if (req.pathname === "/rest/v1/deals") {
      return jsonResponse(
        200,
        o.dealVisible ? [{ id: DEAL_ID, contact_id: "c-mariana", owner_id: null }] : [],
      );
    }
    if (req.pathname === "/rest/v1/activities") {
      if (req.method === "POST") return jsonResponse(201, [{ id: "act-new" }]);
      if (req.method === "PATCH") return jsonResponse(200, []);
      if (req.url.includes("idempotency_key"))
        return jsonResponse(200, o.existingKey ? [{ id: "act-old" }] : []);
      return jsonResponse(
        200,
        o.storedMeeting
          ? [
              {
                id: "act-old",
                metadata: {
                  kind: "meeting_result",
                  idempotency_key: "k",
                  meeting: MEETING,
                  followup_draft: o.storedDraft ?? null,
                },
              },
            ]
          : [],
      );
    }
    if (req.pathname === "/rest/v1/contacts")
      return jsonResponse(200, [{ name: "Mariana Costa", company_id: "co-atlas" }]);
    if (req.pathname === "/rest/v1/crm_companies")
      return jsonResponse(200, [{ name: "Atlas Industrial" }]);
    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit")
      return jsonResponse(200, { allowed: true, retryAfterSeconds: 0 });
    if (req.pathname === "/rest/v1/system_events") return jsonResponse(201, {});
    if (req.url.includes("ai.gateway.lovable.dev"))
      return jsonResponse(200, { choices: [{ message: { content: o.aiContent ?? "{}" } }] });
    return undefined;
  };
}

function post(body: unknown) {
  return new Request("http://localhost/process-meeting", {
    method: "POST",
    headers: { Authorization: "Bearer user-jwt", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

/** Nenhuma escrita em deals/contacts/companies: valor, estágio, contato e
 * cargo não têm como mudar. */
function assertCrmUntouched(seen: MockRequest[]) {
  const writes = seen.filter(
    (r) =>
      r.method !== "GET" &&
      r.method !== "HEAD" &&
      ["/rest/v1/deals", "/rest/v1/contacts", "/rest/v1/crm_companies"].includes(r.pathname),
  );
  assertEquals(writes.length, 0, "escreveu em negócio/contato/empresa");
}

Deno.test("handler ingest: grava a reunião no negócio certo, sem tocar no CRM", async () => {
  const seen: MockRequest[] = [];
  const uninstall = installFetchMock(router({ dealVisible: true, seen }));
  try {
    const res = await handler(
      post({ action: "ingest", dealId: DEAL_ID, meeting: { ...MEETING, value: 1, stage: "X" } }),
    );
    assertEquals(res.status, 201);
    assertEquals((await res.json()).duplicate, false);
    const dealReq = seen.find((r) => r.pathname === "/rest/v1/deals")!;
    assert(dealReq.url.includes(`tenant_id=eq.${TENANT}`), "deals sem filtro de tenant");
    assertEquals(dealReq.headers.get("authorization"), "Bearer user-jwt");
    const ins = seen.find((r) => r.pathname === "/rest/v1/activities" && r.method === "POST")!;
    const row = ins.bodyJson as Record<string, unknown> & {
      metadata: { meeting: Record<string, unknown>; idempotency_key: string };
    };
    assertEquals(row.deal_id, DEAL_ID);
    assertEquals(row.tenant_id, TENANT);
    assertEquals(row.contact_id, "c-mariana");
    assertEquals(row.title, "Reunião de diagnóstico comercial concluída");
    assertEquals(row.metadata.meeting.summary, MEETING.summary);
    assertEquals(row.metadata.meeting.objections, MEETING.objections);
    assertEquals(row.metadata.meeting.priorities, MEETING.priorities);
    assertEquals(row.metadata.meeting.nextSteps, MEETING.nextSteps);
    assertEquals(row.metadata.idempotency_key, `meeting:${DEAL_ID}:${MEETING.meetingId}`);
    assert(!("value" in row.metadata.meeting), "valor externo foi gravado");
    assertCrmUntouched(seen);
    assert(!seen.some((r) => r.url.includes("ai.gateway")), "ingest chamou IA");
  } finally {
    uninstall();
  }
});

Deno.test("handler ingest: organização errada → 404 e nada é gravado", async () => {
  const seen: MockRequest[] = [];
  const uninstall = installFetchMock(router({ dealVisible: false, seen }));
  try {
    const res = await handler(post({ action: "ingest", dealId: DEAL_ID, meeting: MEETING }));
    assertEquals(res.status, 404);
    await res.body?.cancel();
    assert(!seen.some((r) => r.pathname === "/rest/v1/activities"), "tocou em activities");
  } finally {
    uninstall();
  }
});

Deno.test("handler ingest: mesma reunião 2x é idempotente (não insere de novo)", async () => {
  const seen: MockRequest[] = [];
  const uninstall = installFetchMock(router({ dealVisible: true, seen, existingKey: true }));
  try {
    const res = await handler(post({ action: "ingest", dealId: DEAL_ID, meeting: MEETING }));
    assertEquals(res.status, 200);
    assertEquals(await res.json(), { activityId: "act-old", duplicate: true });
    const lookup = seen.find((r) => r.url.includes("idempotency_key"))!;
    assert(lookup.url.includes(`deal_id=eq.${DEAL_ID}`), "busca sem deal_id");
    assert(lookup.url.includes(`tenant_id=eq.${TENANT}`), "busca sem tenant_id");
    assert(!seen.some((r) => r.method === "POST" && r.pathname === "/rest/v1/activities"), "dup");
  } finally {
    uninstall();
  }
});

Deno.test("handler followup: IA inventa Salesforce → rascunho vira modelo fiel", async () => {
  const seen: MockRequest[] = [];
  const ai = JSON.stringify({
    subject: "Próximos passos — Atlas Industrial",
    email: "Mariana, como falamos sobre Salesforce, economizaremos 30 horas por semana.",
    whatsapp: "Mariana, até terça-feira!",
  });
  const uninstall = installFetchMock(
    router({ dealVisible: true, seen, storedMeeting: true, aiContent: ai }),
  );
  try {
    const res = await handler(post({ action: "followup", dealId: DEAL_ID }));
    assertEquals(res.status, 200);
    const body = await res.json();
    assertEquals(body.draft.source, "template");
    assert(String(body.rejected).startsWith("numero") || String(body.rejected).startsWith("tec"), "motivo");
    assert(!/salesforce|30|ter[cç]a/i.test(body.draft.email + body.draft.whatsapp), "vazou");
    const patch = seen.find((r) => r.method === "PATCH" && r.pathname === "/rest/v1/activities")!;
    const upd = patch.bodyJson as Record<string, unknown>;
    assertEquals(Object.keys(upd), ["metadata"], "update mexeu além de metadata");
    assertCrmUntouched(seen);
    // Rascunho nunca é enviado: nenhuma chamada a canal de mensagem/e-mail.
    assert(
      !seen.some((r) => /messaging-send|resend|sendgrid|graph\.facebook|smtp/i.test(r.url)),
      "tentou enviar",
    );
  } finally {
    uninstall();
  }
});

Deno.test("handler followup: rascunho IA fiel é aceito e persistido", async () => {
  const seen: MockRequest[] = [];
  const ai = JSON.stringify({
    subject: "Próximos passos — Atlas Industrial",
    email:
      "Mariana, obrigado pela conversa. Entendi que reduzir atividades administrativas e aumentar a confiabilidade do pipeline são prioridades. Como combinamos, vamos mapear o fluxo comercial atual.\n\nAbraço,\nLucas",
    whatsapp: "Mariana, obrigado pela conversa! Próximo passo: mapear o fluxo comercial atual.",
  });
  const uninstall = installFetchMock(
    router({ dealVisible: true, seen, storedMeeting: true, aiContent: ai }),
  );
  try {
    const res = await handler(post({ action: "followup", dealId: DEAL_ID }));
    const body = await res.json();
    assertEquals(body.draft.source, "ai");
    assertEquals(body.rejected, null);
  } finally {
    uninstall();
  }
});

Deno.test("handler followup: rascunho já persistido volta sem chamar IA", async () => {
  const seen: MockRequest[] = [];
  const stored = { subject: "s", email: "e", whatsapp: "w", source: "ai", generatedAt: "t" };
  const uninstall = installFetchMock(
    router({ dealVisible: true, seen, storedMeeting: true, storedDraft: stored }),
  );
  try {
    const res = await handler(post({ action: "followup", dealId: DEAL_ID }));
    assertEquals((await res.json()).draft, stored);
    assert(!seen.some((r) => r.url.includes("ai.gateway")), "chamou IA de novo");
  } finally {
    uninstall();
  }
});

Deno.test("handler: action desconhecida (ex.: send) é recusada", async () => {
  const uninstall = installFetchMock(router({ dealVisible: true, seen: [] }));
  try {
    const res = await handler(post({ action: "send", dealId: DEAL_ID }));
    assertEquals(res.status, 400);
    await res.body?.cancel();
  } finally {
    uninstall();
  }
});
