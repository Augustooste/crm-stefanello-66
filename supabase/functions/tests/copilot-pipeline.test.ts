// Copiloto da liderança (Demo 6): fatos do pipeline saem do banco, contas e
// sinais saem do código, o modelo não consegue trocar cargo/estágio/valor,
// mostrar UUID nem inventar ERP, faturamento ou probabilidade.
// Cenário = tenant "Demo Palestra B2B" (Atlas + 4 fixtures).
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { executarAcao } from "../_shared/ai/copilot-actions.ts";
import {
  calcularMetricas,
  filtrarPorTermo,
  type LinhaNegocio,
  montarLinha,
  prioridadeDeAtencao,
  removerIdsInternos,
  termoInventado,
} from "../_shared/ai/pipeline-snapshot.ts";

setEnv({ ...BASE_ENV, LOVABLE_API_KEY: "lovable-key" });

function eq(a: unknown, e: unknown, msg = "eq") {
  if (JSON.stringify(a) !== JSON.stringify(e)) {
    throw new Error(`${msg}: esperado ${JSON.stringify(e)}, veio ${JSON.stringify(a)}`);
  }
}
function ok(c: unknown, msg: string) {
  if (!c) throw new Error(msg);
}

const AGORA = new Date("2026-09-23T21:00:00Z");
const dias = (n: number) => new Date(AGORA.getTime() + n * 86_400_000).toISOString();
const ATLAS_ID = "2ca3788d-3132-42e1-b446-a4b1e2f2c250";

const DEALS = [
  {
    id: ATLAS_ID,
    title: "Projeto de Automação Comercial B2B",
    value: "180000.00",
    status: "open",
    created_at: dias(-1),
    stage: { name: "Diagnóstico" },
    contact: { name: "Mariana Costa", job_title: "Diretora Comercial", company_id: "co-atlas" },
  },
  {
    id: "d-orion",
    title: "Eficiência Comercial e CRM",
    value: 250000,
    status: "open",
    created_at: dias(-40),
    stage: { name: "Proposta" },
    contact: { name: "Rafael Mendes", job_title: "Diretor Comercial", company_id: "co-orion" },
  },
  {
    id: "d-lumina",
    title: "Automação do Processo Comercial",
    value: 320000,
    status: "open",
    created_at: dias(-25),
    stage: { name: "Proposta" },
    contact: { name: "Beatriz Nunes", job_title: "Diretora de Operações", company_id: "co-lumina" },
  },
  {
    id: "d-novasul",
    title: "Estruturação Comercial",
    value: 90000,
    status: "open",
    created_at: dias(-35),
    stage: { name: "Qualificado" },
    contact: { name: "André Martins", job_title: "Gerente Comercial", company_id: "co-novasul" },
  },
];
const EMPRESAS = [
  { id: "co-atlas", name: "Atlas Industrial" },
  { id: "co-orion", name: "Orion Logística" },
  { id: "co-lumina", name: "Lumina Foods" },
  { id: "co-novasul", name: "NovaSul Serviços" },
];
const ATIVIDADES = [
  { deal_id: ATLAS_ID, type: "task", title: "Reunião de diagnóstico comercial com Mariana Costa", due_at: dias(2), completed_at: null, created_at: dias(-1) },
  {
    deal_id: ATLAS_ID, type: "note", title: "Reunião de diagnóstico comercial concluída", due_at: dias(0), completed_at: dias(0), created_at: dias(0),
    metadata: { kind: "meeting_result", meeting: { summary: "Dependência de atualizações manuais no CRM.", objections: ["Receio de mais trabalho para os vendedores."], priorities: ["Reduzir atividades administrativas."], nextSteps: ["Mapear o fluxo comercial atual."] } },
  },
  { deal_id: ATLAS_ID, type: "ai_log", title: "Proposta (simulação) — rascunho", due_at: dias(0), completed_at: dias(0), created_at: dias(0) },
  { deal_id: "d-orion", type: "call", title: "Ligação de apresentação da proposta", due_at: dias(-16), completed_at: dias(-16), created_at: dias(-16) },
  { deal_id: "d-lumina", type: "call", title: "Ligação de alinhamento", due_at: dias(-2), completed_at: dias(-2), created_at: dias(-2) },
  { deal_id: "d-lumina", type: "task", title: "Revisar escopo da proposta", due_at: dias(3), completed_at: null, created_at: dias(-2) },
];

function linhas(): LinhaNegocio[] {
  return DEALS.map((d) =>
    montarLinha(
      d,
      EMPRESAS.find((e) => e.id === d.contact.company_id)?.name ?? null,
      ATIVIDADES.filter((a) => a.deal_id === d.id),
      [],
      AGORA,
    )
  );
}
const porEmpresa = (n: string) => linhas().find((l) => l.empresa === n)!;

// ---------------------------------------------------------------------------
// Fatos (1–5, 16)
// ---------------------------------------------------------------------------

Deno.test("fatos da Atlas saem do banco: empresa, contato, cargo, estágio, valor", () => {
  const a = porEmpresa("Atlas Industrial");
  eq(a.negocio, "Projeto de Automação Comercial B2B");
  eq(a.contato, "Mariana Costa");
  eq(a.cargo, "Diretora Comercial");
  eq(a.estagio, "Diagnóstico");
  eq(a.valor, 180000);
  eq(a.valor_formatado, "R$ 180.000");
});

Deno.test("deals.status não substitui o nome do estágio", () => {
  const a = porEmpresa("Atlas Industrial");
  ok(a.estagio !== "open" && a.estagio !== "Aberto", "status virou estágio");
  eq(a.situacao, "em aberto");
});

Deno.test("nenhum id interno na linha do negócio", () => {
  const txt = JSON.stringify(linhas());
  ok(!txt.includes(ATLAS_ID) && !/"id"\s*:/.test(txt), "id vazou para o snapshot");
  eq(removerIdsInternos(`negócio ${ATLAS_ID}`), "negócio [referência interna]");
});

// ---------------------------------------------------------------------------
// Busca, sinais, métricas (7–11)
// ---------------------------------------------------------------------------

Deno.test("busca por empresa encontra o negócio (Atlas Industrial ≠ título)", () => {
  const r = filtrarPorTermo(linhas(), "atlas industrial");
  eq(r.map((l) => l.negocio), ["Projeto de Automação Comercial B2B"]);
  eq(filtrarPorTermo(linhas(), "Mariana").length, 1);
  eq(filtrarPorTermo(linhas(), "orion logistica")[0].empresa, "Orion Logística");
});

Deno.test("sem próximo passo e última atividade calculados", () => {
  const orion = porEmpresa("Orion Logística");
  eq(orion.sinais, ["SEM_PROXIMO_PASSO", "SEM_ATIVIDADE_RECENTE"]);
  eq(orion.motivos, ["Sem próximo passo", "Sem atividade há 14+ dias"]);
  eq(orion.dias_sem_atividade, 16);
  ok(orion.evidencias.includes("Sem atividade registrada há 16 dias."), "evidência de dias");
  const nova = porEmpresa("NovaSul Serviços");
  eq(nova.sinais, ["SEM_PROXIMO_PASSO", "SEM_ATIVIDADE"]);
  const atlas = porEmpresa("Atlas Industrial");
  eq(atlas.sinais, []);
  eq(atlas.proximo_passo?.titulo, "Reunião de diagnóstico comercial com Mariana Costa");
  eq(atlas.dias_sem_atividade, 0);
});

Deno.test("ai_log (rascunho de sistema) não conta como atividade comercial", () => {
  const l = montarLinha(DEALS[0], "Atlas Industrial", [ATIVIDADES[2]], [], AGORA);
  ok(l.sinais.includes("SEM_ATIVIDADE"), "ai_log contou como atividade");
});

Deno.test("próximo passo vencido vira sinal com data", () => {
  const l = montarLinha(DEALS[1], "Orion Logística", [
    { deal_id: "d-orion", type: "task", title: "Retomar contato", due_at: dias(-3), completed_at: null, created_at: dias(-10) },
  ], [], AGORA);
  ok(l.sinais.includes("PROXIMO_PASSO_VENCIDO"), "vencido não detectado");
});

Deno.test("métricas: soma, maior oportunidade, sem próximo passo — no código", () => {
  const m = calcularMetricas(linhas());
  eq(m.quantidade, 4);
  eq(m.valor_total, "R$ 840.000");
  eq(m.maior_oportunidade, { negocio: "Automação do Processo Comercial", empresa: "Lumina Foods", valor: "R$ 320.000", estagio: "Proposta" });
  eq(m.sem_proximo_passo, ["Eficiência Comercial e CRM", "Estruturação Comercial"]);
  eq(m.por_estagio.find((e) => e.estagio === "Proposta"), { estagio: "Proposta", quantidade: 2, valor: "R$ 570.000" });
});

Deno.test("prioridade de atenção: mais sinais, depois valor; sem sinal fica fora", () => {
  eq(prioridadeDeAtencao(linhas()).map((l) => l.empresa), ["Orion Logística", "NovaSul Serviços"]);
});

// ---------------------------------------------------------------------------
// Barreira anti-invenção (12–14, 17)
// ---------------------------------------------------------------------------

Deno.test("ERP / faturamento / percentual sem fonte são barrados", () => {
  const dados = JSON.stringify(linhas());
  eq(termoInventado("A Atlas provavelmente usa SAP.", "Qual ERP a Atlas usa?\n" + dados), "sap");
  eq(termoInventado("O faturamento é de R$ 50 milhões.", "fale da Atlas\n" + dados), "faturamento");
  eq(termoInventado("Chance de 70% de fechar.", "Qual a probabilidade?\n" + dados), "percentual:70%");
  eq(termoInventado("Essa informação não está registrada no CRM.", "Qual ERP?\n" + dados), null);
  eq(termoInventado("Não há registro do ERP no CRM.", "Qual ERP a Atlas usa?\n" + dados), null);
});

// ---------------------------------------------------------------------------
// Ação + handler (15, 17)
// ---------------------------------------------------------------------------

function db(seen: MockRequest[]): FetchMatcher {
  return (r) => {
    seen.push(r);
    if (r.pathname === "/rest/v1/deals") return jsonResponse(200, DEALS);
    if (r.pathname === "/rest/v1/activities") return jsonResponse(200, ATIVIDADES);
    if (r.pathname === "/rest/v1/deal_followups") return jsonResponse(200, []);
    if (r.pathname === "/rest/v1/crm_companies") return jsonResponse(200, EMPRESAS);
    return undefined;
  };
}

Deno.test("analisar_pipeline: toda leitura filtra o tenant do usuário", async () => {
  const seen: MockRequest[] = [];
  const un = installFetchMock(db(seen));
  try {
    const admin = createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
      auth: { persistSession: false },
    });
    const r = await executarAcao(admin, { tenantId: "tenant-demo", userId: "u", role: "admin" }, {
      acao: "analisar_pipeline",
      parametros: {},
    });
    for (const p of ["/rest/v1/deals", "/rest/v1/activities", "/rest/v1/deal_followups", "/rest/v1/crm_companies"]) {
      const req = seen.find((x) => x.pathname === p);
      ok(req, `não consultou ${p}`);
      ok(req!.url.includes("tenant_id=eq.tenant-demo"), `${p} sem filtro de tenant`);
    }
    const d = r.dados as { metricas: { valor_total: string } };
    eq(d.metricas.valor_total, "R$ 840.000");
    ok(!JSON.stringify(r.dados).includes(ATLAS_ID), "UUID nos dados do redator");
  } finally {
    un();
  }
});

const handler = await captureHandler("../ai-copilot/index.ts");

function handlerRouter(plano: string, redacao: string, bodies: Record<string, unknown>[]): FetchMatcher {
  const base = db([]);
  return (req) => {
    if (req.pathname === "/auth/v1/user") return jsonResponse(200, { id: "user-1", aud: "authenticated" });
    if (req.pathname === "/rest/v1/profiles") return jsonResponse(200, { tenant_id: "tenant-demo" });
    if (req.pathname === "/rest/v1/tenant_memberships") {
      return jsonResponse(200, { tenant_id: "tenant-demo", user_id: "user-1", role_id: "r", status: "active", revoked_at: null });
    }
    if (req.pathname === "/rest/v1/roles") return jsonResponse(200, { role_key: "admin" });
    if (req.pathname === "/rest/v1/rpc/check_and_record_rate_limit") return jsonResponse(200, { allowed: true, retryAfterSeconds: 0 });
    if (req.pathname === "/rest/v1/system_events") return jsonResponse(201, []);
    if (req.url.includes("/v1/chat/completions")) {
      bodies.push((req.bodyJson ?? {}) as Record<string, unknown>);
      return jsonResponse(200, { choices: [{ message: { content: bodies.length === 1 ? plano : redacao } }] });
    }
    return base(req);
  };
}

async function perguntar(pergunta: string, plano: string, redacao: string) {
  const bodies: Record<string, unknown>[] = [];
  const un = installFetchMock(handlerRouter(plano, redacao, bodies));
  try {
    const res = await handler(new Request("https://edge.local/ai-copilot", {
      method: "POST",
      headers: { "content-type": "application/json", Authorization: "Bearer tok" },
      body: JSON.stringify({ messages: [{ role: "user", content: pergunta }] }),
    }));
    return { status: res.status, body: await res.json(), bodies };
  } finally {
    un();
  }
}

Deno.test("handler: modelo inventa SAP → resposta trocada pela recusa honesta", async () => {
  const r = await perguntar(
    "Qual ERP a Atlas Industrial utiliza?",
    '{"acao":"buscar_negocios","parametros":{"termo":"Atlas Industrial"}}',
    "A Atlas usa SAP, segundo o histórico.",
  );
  eq(r.status, 200);
  ok(!/sap/i.test(r.body.reply) && r.body.reply.includes("não está registrada no CRM"), r.body.reply);
});

Deno.test("handler: modelo inventa probabilidade → sem percentual na tela", async () => {
  const r = await perguntar(
    "Qual a probabilidade de a Atlas fechar?",
    '{"acao":"buscar_negocios","parametros":{"termo":"Atlas"}}',
    "A Atlas tem 80% de chance de fechar.",
  );
  ok(!r.body.reply.includes("80%"), r.body.reply);
});

Deno.test("handler: UUID escrito pelo modelo nunca chega à tela", async () => {
  const r = await perguntar(
    "Quais precisam de atenção?",
    '{"acao":"analisar_pipeline","parametros":{}}',
    `Veja o negócio ${ATLAS_ID}.`,
  );
  ok(!r.body.reply.includes(ATLAS_ID), r.body.reply);
});

Deno.test("handler: redator recebe fatos estruturados (cargo, estágio, métricas), sem id", async () => {
  const r = await perguntar(
    "Quais oportunidades precisam mais da minha atenção?",
    '{"acao":"analisar_pipeline","parametros":{}}',
    "ok",
  );
  const msgs = (r.bodies[1].messages as Array<{ content: string }>);
  const insumo = msgs[msgs.length - 1].content;
  ok(insumo.includes('"cargo":"Diretora Comercial"'), "cargo não chegou");
  ok(insumo.includes('"estagio":"Diagnóstico"'), "estágio não chegou");
  ok(insumo.includes('"valor_total":"R$ 840.000"'), "total não calculado no código");
  ok(!insumo.includes(ATLAS_ID), "UUID foi para o modelo");
  const sistema = msgs[0].content;
  ok(sistema.includes("probabilidade de fechamento"), "prompt sem regra de probabilidade");
});
