// Testa generateQualificationSnapshot (supabase/functions/_shared/ai/qualification.ts):
// contexto do deal (deals/contacts/conversations/messages do aceleraflow),
// dimensões configuráveis por nicho (niche_templates.qualification_dimensions,
// NUNCA um conjunto fixo de 4 chaves) e fail-closed nos pré-checks.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { generateQualificationSnapshot } from "../_shared/ai/qualification.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const AI_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";

interface DealRow {
  id: string;
  title: string;
  value: number | null;
  contact_id: string | null;
  tenant_id: string;
  stage_id: string;
  created_at: string;
}

interface State {
  deal: DealRow | null;
  tenant: { id: string; name: string; niche: string | null } | null;
  contact: { name: string | null; email: string | null; phone: string | null } | null;
  stage: { name: string } | null;
  stageConfig: { stage_goal: string | null; advancement_criteria: unknown } | null;
  nicheTemplate: { qualification_dimensions: unknown } | null;
  conversationIds: string[];
  messages: Array<{ sender: string; content: string | null; created_at: string }>;
  aiStatus: number;
  aiBody: unknown;
  insertStatus: number;
  insertedSnapshot: { id: string; generated_at: string } | null;
  insertCapturedBody: Record<string, unknown> | null;
  conversationsFail: boolean;
  messagesFail: boolean;
}

function defaultState(): State {
  return {
    deal: {
      id: "deal-1",
      title: "Consultoria jurídica — Fulano",
      value: 15000,
      contact_id: "contact-1",
      tenant_id: "tenant-1",
      stage_id: "stage-1",
      created_at: "2026-06-01T10:00:00.000Z",
    },
    tenant: { id: "tenant-1", name: "Advocacia Exemplo", niche: "advocacia" },
    contact: { name: "Fulano de Tal", email: "fulano@example.com", phone: "+5511999990000" },
    stage: { name: "Diagnóstico" },
    stageConfig: { stage_goal: "Entender o caso", advancement_criteria: ["Caso documentado"] },
    nicheTemplate: {
      qualification_dimensions: [
        { key: "urgencia", label: "Urgência do caso" },
        { key: "orcamento_disponivel", label: "Orçamento disponível" },
        { key: "decisor", label: "Decisor identificado" },
      ],
    },
    conversationIds: ["conv-1", "conv-2"],
    messages: [
      {
        sender: "contact",
        content: "Preciso de ajuda com um processo urgente",
        created_at: "2026-06-01T10:05:00.000Z",
      },
      {
        sender: "ai",
        content: "Claro, pode me contar mais?",
        created_at: "2026-06-01T10:06:00.000Z",
      },
      {
        sender: "contact",
        content: "É sobre uma rescisão trabalhista",
        created_at: "2026-06-02T09:00:00.000Z",
      },
    ],
    aiStatus: 200,
    aiBody: {
      choices: [
        {
          message: {
            content: JSON.stringify({
              executiveSummary:
                "Lead com caso trabalhista urgente, ainda sem orçamento confirmado.",
              dimensions: [
                { key: "urgencia", status: "confirmado", notes: "Processo com prazo apertado." },
                { key: "decisor", status: "confirmado", notes: "Fala diretamente com o decisor." },
                {
                  key: "chave_inventada",
                  status: "confirmado",
                  notes: "Não deveria aparecer no resultado.",
                },
              ],
              pendingPoints: [
                {
                  point: "Confirmar orçamento disponível",
                  context: "Ainda não mencionado",
                  priority: "high",
                },
              ],
              recommendedApproach: {
                opening: "Reforçar a urgência do prazo processual.",
                keyQuestions: ["Qual o valor que pretende investir?"],
                objectionsToAnticipate: ["Pode achar caro"],
                suggestedNextStep: "Agendar reunião com o decisor.",
              },
              alerts: [{ type: "opportunity", message: "Decisor já identificado e engajado." }],
              confidence: 0.72,
            }),
          },
        },
      ],
    },
    insertStatus: 201,
    insertedSnapshot: { id: "snapshot-1", generated_at: "2026-06-02T12:00:00.000Z" },
    insertCapturedBody: null,
    conversationsFail: false,
    messagesFail: false,
  };
}

function router(state: State): FetchMatcher {
  return (req) => {
    if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
      return jsonResponse(200, state.deal ? [state.deal] : []);
    }
    if (req.pathname === "/rest/v1/tenants" && req.method === "GET") {
      return jsonResponse(200, state.tenant ? [state.tenant] : []);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, state.contact ? [state.contact] : []);
    }
    if (req.pathname === "/rest/v1/board_stages" && req.method === "GET") {
      return jsonResponse(200, state.stage ? [state.stage] : []);
    }
    if (req.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
      return jsonResponse(200, state.stageConfig ? [state.stageConfig] : []);
    }
    if (req.pathname === "/rest/v1/niche_templates" && req.method === "GET") {
      return jsonResponse(200, state.nicheTemplate ? [state.nicheTemplate] : []);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
      if (state.conversationsFail) {
        return jsonResponse(500, { message: "conversations query failed" });
      }
      return jsonResponse(
        200,
        state.conversationIds.map((id) => ({ id })),
      );
    }
    if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
      if (state.messagesFail) {
        return jsonResponse(500, { message: "messages query failed" });
      }
      return jsonResponse(200, state.messages);
    }
    if (req.pathname === "/rest/v1/deal_qualification_snapshots" && req.method === "POST") {
      const bodyArr = Array.isArray(req.bodyJson) ? req.bodyJson : [req.bodyJson];
      state.insertCapturedBody = bodyArr[0] as Record<string, unknown>;
      if (state.insertStatus >= 400) {
        return jsonResponse(state.insertStatus, { message: "insert failed" });
      }
      // .select("id, generated_at").single() — objeto puro (Accept: vnd.pgrst.object+json).
      return jsonResponse(state.insertStatus, state.insertedSnapshot);
    }
    if (req.url === AI_URL) {
      return jsonResponse(state.aiStatus, state.aiBody);
    }
    return undefined;
  };
}

Deno.test("generateQualificationSnapshot", async (t) => {
  await t.step("gera snapshot com dimensões custom do nicho (3, não as 4 default)", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const snapshot = await generateQualificationSnapshot(admin, "deal-1");

      if (snapshot.dimensions.length !== 3) {
        throw new Error(`esperado 3 dimensões, veio ${snapshot.dimensions.length}`);
      }
      const keys = snapshot.dimensions.map((d) => d.key).sort();
      if (
        JSON.stringify(keys) !==
          JSON.stringify(["decisor", "orcamento_disponivel", "urgencia"].sort())
      ) {
        throw new Error(`chaves inesperadas: ${JSON.stringify(keys)}`);
      }
      // "chave_inventada" da IA não deve vazar para o resultado.
      if (snapshot.dimensions.some((d) => d.key === "chave_inventada")) {
        throw new Error("chave não configurada vazou para o resultado");
      }
      // Dimensão configurada mas omitida pela IA (orcamento_disponivel) cai no default.
      const orcamento = snapshot.dimensions.find((d) => d.key === "orcamento_disponivel");
      if (!orcamento || orcamento.status !== "desconhecido") {
        throw new Error(
          `orcamento_disponivel deveria ser 'desconhecido', veio ${JSON.stringify(orcamento)}`,
        );
      }
      const urgencia = snapshot.dimensions.find((d) => d.key === "urgencia");
      if (!urgencia || urgencia.status !== "confirmado") {
        throw new Error(`urgencia deveria vir 'confirmado', veio ${JSON.stringify(urgencia)}`);
      }

      if (snapshot.basedOnMessages !== 3) {
        throw new Error(`basedOnMessages=${snapshot.basedOnMessages}`);
      }
      if (snapshot.id !== "snapshot-1") throw new Error(`id=${snapshot.id}`);
      if (snapshot.tenantId !== "tenant-1") throw new Error(`tenantId=${snapshot.tenantId}`);
      if (snapshot.confidence !== 0.72) throw new Error(`confidence=${snapshot.confidence}`);

      if (!state.insertCapturedBody) throw new Error("INSERT não capturado");
      if (state.insertCapturedBody.tenant_id !== "tenant-1") {
        throw new Error(`tenant_id gravado=${state.insertCapturedBody.tenant_id}`);
      }
      if (state.insertCapturedBody.deal_id !== "deal-1") {
        throw new Error(`deal_id gravado=${state.insertCapturedBody.deal_id}`);
      }
      if (state.insertCapturedBody.based_on_messages !== 3) {
        throw new Error(`based_on_messages gravado=${state.insertCapturedBody.based_on_messages}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("tenant sem nicho cai nas 4 dimensões default", async () => {
    const state = defaultState();
    state.tenant = { id: "tenant-1", name: "Genérica LTDA", niche: null };
    state.aiBody = {
      choices: [
        {
          message: {
            content: JSON.stringify({
              executiveSummary: "Resumo genérico.",
              dimensions: [],
              pendingPoints: [],
              recommendedApproach: {
                opening: "Abertura genérica.",
                keyQuestions: [],
                objectionsToAnticipate: [],
                suggestedNextStep: "Ligar para o lead.",
              },
              alerts: [],
              confidence: 0.5,
            }),
          },
        },
      ],
    };
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const snapshot = await generateQualificationSnapshot(admin, "deal-1");
      const keys = snapshot.dimensions.map((d) => d.key).sort();
      if (
        JSON.stringify(keys) !==
          JSON.stringify(["authority", "need", "resource", "timeline"].sort())
      ) {
        throw new Error(`esperado default de 4 dimensões, veio ${JSON.stringify(keys)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("deal não encontrado lança erro claro", async () => {
    const state = defaultState();
    state.deal = null;
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      let thrown: Error | null = null;
      try {
        await generateQualificationSnapshot(admin, "deal-inexistente");
      } catch (e) {
        thrown = e as Error;
      }
      if (!thrown) throw new Error("esperava lançar, não lançou");
      if (thrown.message !== "Deal não encontrado.") {
        throw new Error(`mensagem inesperada: ${thrown.message}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("tenant do deal não encontrado lança erro claro", async () => {
    const state = defaultState();
    state.tenant = null;
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      let thrown: Error | null = null;
      try {
        await generateQualificationSnapshot(admin, "deal-1");
      } catch (e) {
        thrown = e as Error;
      }
      if (!thrown) throw new Error("esperava lançar, não lançou");
      if (thrown.message !== "Tenant do deal não encontrado.") {
        throw new Error(`mensagem inesperada: ${thrown.message}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resposta da IA malformada (JSON quebrado) lança erro claro", async () => {
    const state = defaultState();
    state.aiBody = { choices: [{ message: { content: "isto não é json {" } }] };
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      let thrown: Error | null = null;
      try {
        await generateQualificationSnapshot(admin, "deal-1");
      } catch (e) {
        thrown = e as Error;
      }
      if (!thrown) throw new Error("esperava lançar, não lançou");
      if (thrown.message !== "A IA retornou uma qualificação em formato inválido.") {
        throw new Error(`mensagem inesperada: ${thrown.message}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "erro ao buscar conversas do contato lança erro (fail-closed, não mascara com snapshot vazio)",
    async () => {
      const state = defaultState();
      state.conversationsFail = true;
      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        let thrown: Error | null = null;
        try {
          await generateQualificationSnapshot(admin, "deal-1");
        } catch (e) {
          thrown = e as Error;
        }
        if (!thrown) throw new Error("esperava lançar, não lançou");
        if (!thrown.message.startsWith("Falha ao buscar conversas do contato")) {
          throw new Error(`mensagem inesperada: ${thrown.message}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro ao buscar mensagens do contato lança erro (fail-closed, não mascara com basedOnMessages:0)",
    async () => {
      const state = defaultState();
      state.messagesFail = true;
      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        let thrown: Error | null = null;
        try {
          await generateQualificationSnapshot(admin, "deal-1");
        } catch (e) {
          thrown = e as Error;
        }
        if (!thrown) throw new Error("esperava lançar, não lançou");
        if (!thrown.message.startsWith("Falha ao buscar mensagens do contato")) {
          throw new Error(`mensagem inesperada: ${thrown.message}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("falha no INSERT lança erro claro", async () => {
    const state = defaultState();
    state.insertStatus = 500;
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      let thrown: Error | null = null;
      try {
        await generateQualificationSnapshot(admin, "deal-1");
      } catch (e) {
        thrown = e as Error;
      }
      if (!thrown) throw new Error("esperava lançar, não lançou");
      if (!thrown.message.startsWith("Falha ao gravar snapshot de qualificação")) {
        throw new Error(`mensagem inesperada: ${thrown.message}`);
      }
    } finally {
      uninstall();
    }
  });
});
