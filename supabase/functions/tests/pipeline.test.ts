// Testa direto as funções exportadas de pipeline.ts (loadOrCreateOpenDeal,
// loadStageAiConfig, buildSystemPrompt, loadRecentHistory, performHandoff,
// evaluateStageAdvancement) — 1 caso feliz + 1 caso de erro/borda por função.
// ai-respond.test.ts já cobre o encadeamento completo via mock do Deno.serve;
// este arquivo isola qual função quebrou quando algo falhar.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import {
  buildSystemPrompt,
  evaluateStageAdvancement,
  loadOrCreateOpenDeal,
  loadRecentHistory,
  loadStageAiConfig,
  performHandoff,
} from "../_shared/ai/pipeline.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const GATEWAY_URL = "https://ai.gateway.lovable.dev/v1/chat/completions";
function aiSuccessBody(content: string) {
  return { choices: [{ message: { content } }] };
}

const CONTACT = { id: "contact-1", name: "Fulano", phone: "5511999999999", email: null };

// -------------------- loadOrCreateOpenDeal --------------------

Deno.test("loadOrCreateOpenDeal", async (t) => {
  await t.step("deal aberto já existe: devolve os ids do deal existente", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
        return jsonResponse(200, { id: "deal-1", stage_id: "stage-1" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadOrCreateOpenDeal(newAdminClient(), "tenant-1", CONTACT);
      if (result.dealId !== "deal-1" || result.dealStageId !== "stage-1") {
        throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "sem deal aberto e sem board default: degrada para {dealId:null, dealStageId:null}",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
          return jsonResponse(200, null);
        }
        if (req.pathname === "/rest/v1/boards" && req.method === "GET") {
          return jsonResponse(200, null);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadOrCreateOpenDeal(newAdminClient(), "tenant-1", CONTACT);
        if (result.dealId !== null || result.dealStageId !== null) {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "sem deal aberto, com board+estágio: cria deal novo no primeiro estágio",
    async () => {
      let insertBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
          return jsonResponse(200, null);
        }
        if (req.pathname === "/rest/v1/boards" && req.method === "GET") {
          return jsonResponse(200, { id: "board-1" });
        }
        if (req.pathname === "/rest/v1/board_stages" && req.method === "GET") {
          return jsonResponse(200, { id: "stage-first" });
        }
        if (req.pathname === "/rest/v1/deals" && req.method === "POST") {
          insertBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(201, { id: "deal-novo" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadOrCreateOpenDeal(newAdminClient(), "tenant-1", CONTACT);
        if (result.dealId !== "deal-novo" || result.dealStageId !== "stage-first") {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
        if (!insertBody || (insertBody as Record<string, unknown>).stage_id !== "stage-first") {
          throw new Error(`insert deals sem stage_id correto: ${JSON.stringify(insertBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // Falha de LEITURA não é "não existe": se a consulta do deal aberto, do
  // board default ou do primeiro estágio falha (ex.: indisponibilidade
  // transitória do banco), criar um deal aqui duplicaria o deal do contato.
  // O contrato é não inserir nada e devolver a falha de forma explícita;
  // ai-respond segue o turno sem deal, como já faz com dealId null.
  const falhasDeLeitura: Array<{
    nome: string;
    falha: "open_deal_query" | "default_board_query" | "first_stage_query";
    falhaEm: string;
  }> = [
    { nome: "consulta do deal aberto", falha: "open_deal_query", falhaEm: "/rest/v1/deals" },
    { nome: "consulta do board default", falha: "default_board_query", falhaEm: "/rest/v1/boards" },
    {
      nome: "consulta do primeiro estágio",
      falha: "first_stage_query",
      falhaEm: "/rest/v1/board_stages",
    },
  ];
  for (const caso of falhasDeLeitura) {
    await t.step(`erro na ${caso.nome}: não insere deal e sinaliza ${caso.falha}`, async () => {
      const inserts: unknown[] = [];
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/deals" && req.method === "POST") {
          inserts.push(req.bodyJson);
          return jsonResponse(201, { id: "deal-duplicado" });
        }
        if (req.method !== "GET") return undefined;
        if (req.pathname === caso.falhaEm) {
          return jsonResponse(500, { message: "falha transitória", code: "XX000" });
        }
        if (req.pathname === "/rest/v1/deals") return jsonResponse(200, null);
        if (req.pathname === "/rest/v1/boards") return jsonResponse(200, { id: "board-1" });
        if (req.pathname === "/rest/v1/board_stages") {
          return jsonResponse(200, { id: "stage-first" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadOrCreateOpenDeal(newAdminClient(), "tenant-1", CONTACT);
        if (inserts.length !== 0) {
          throw new Error(`insert em deals após falha de leitura: ${JSON.stringify(inserts)}`);
        }
        if (
          result.dealId !== null ||
          result.dealStageId !== null ||
          result.lookupFailure !== caso.falha
        ) {
          throw new Error(`resultado inesperado: ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    });
  }

  await t.step("caminhos de sucesso não sinalizam falha (lookupFailure null)", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") return jsonResponse(200, null);
      if (req.pathname === "/rest/v1/boards" && req.method === "GET") return jsonResponse(200, null);
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadOrCreateOpenDeal(newAdminClient(), "tenant-1", CONTACT);
      if (result.lookupFailure !== null) {
        throw new Error(`lookupFailure inesperado: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});

// -------------------- loadStageAiConfig --------------------

Deno.test("loadStageAiConfig", async (t) => {
  await t.step(
    "dealStageId com config habilitada: devolve prompt/critérios/goal do estágio",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
          return jsonResponse(200, {
            system_prompt: "Foque em agendar a consulta.",
            enabled: true,
            advancement_criteria: ["Lead confirmou interesse"],
            handoff_keywords: ["cancelar"],
            stage_goal: "Agendar consulta",
          });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadStageAiConfig(newAdminClient(), "tenant-1", "stage-1");
        if (result.stagePrompt !== "Foque em agendar a consulta.") {
          throw new Error(`stagePrompt=${result.stagePrompt}`);
        }
        if (result.stageAdvancement.length !== 1) {
          throw new Error(`stageAdvancement=${JSON.stringify(result.stageAdvancement)}`);
        }
        if (result.stageGoal !== "Agendar consulta") {
          throw new Error(`stageGoal=${result.stageGoal}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "sem dealStageId (deal sem estágio ainda): devolve defaults neutros, sem consultar",
    async () => {
      const router: FetchMatcher = () => {
        throw new Error("não deveria consultar stage_ai_config sem dealStageId");
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadStageAiConfig(newAdminClient(), "tenant-1", null);
        if (
          result.stagePrompt !== "" ||
          result.stageAdvancement.length !== 0 ||
          result.stageGoal !== ""
        ) {
          throw new Error(`esperado defaults neutros, veio ${JSON.stringify(result)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- buildSystemPrompt --------------------

// buildAdaptiveContext (context-builder.ts) é chamado internamente por
// buildSystemPrompt — mockar deals/contacts/conversations vazios faz o
// bloco adaptativo degradar para "" (mesmo comportamento de
// context-builder.test.ts "sem deal e sem ai_memory").
const emptyAdaptiveContextRouter: FetchMatcher = (req) => {
  if (req.pathname === "/rest/v1/tenant_ai_features" && req.method === "GET") {
    return jsonResponse(200, { enabled: false });
  }
  if (req.pathname === "/rest/v1/deals" && req.method === "GET") return jsonResponse(200, null);
  if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
    return jsonResponse(200, { ai_memory: null });
  }
  if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
    return jsonResponse(200, null);
  }
  return undefined;
};

Deno.test("buildSystemPrompt", async (t) => {
  await t.step(
    "base + estágio com {{empresa}} resolvido: monta prompt final concatenado",
    async () => {
      const uninstall = installFetchMock(emptyAdaptiveContextRouter);
      try {
        const result = await buildSystemPrompt({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          contactId: "contact-1",
          conversationId: "conv-1",
          dealId: null,
          tenantName: "Clínica X",
          tenantBusinessProfile: null,
          baseSystemPrompt: "Você atende leads de {{empresa}}.",
          stagePrompt: "Nesta fase, ofereça agendamento em {{empresa}}.",
          currentMessageIsAudio: false,
        });
        if (!result.includes("Você atende leads de Clínica X.")) {
          throw new Error(`base não resolvida: ${result}`);
        }
        if (!result.includes("Nesta fase, ofereça agendamento em Clínica X.")) {
          throw new Error(`estágio não resolvido: ${result}`);
        }
        if (!result.includes("[TRANSFERIR_HUMANO]")) throw new Error(`sem scope guard: ${result}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step("baseSystemPrompt null: usa o template genérico de fallback", async () => {
    const uninstall = installFetchMock(emptyAdaptiveContextRouter);
    try {
      const result = await buildSystemPrompt({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        contactId: "contact-1",
        conversationId: "conv-1",
        dealId: null,
        tenantName: "Clínica Y",
        tenantBusinessProfile: null,
        baseSystemPrompt: null,
        stagePrompt: "",
        currentMessageIsAudio: false,
      });
      if (!result.includes("assistente virtual atenciosa") || !result.includes("Clínica Y")) {
        throw new Error(`fallback genérico não aplicado: ${result}`);
      }
    } finally {
      uninstall();
    }
  });

  // O caso NULL acima nunca acontece em produção: ai_settings.base_system_prompt é
  // `text not null default ''` (20260702220028). O valor real é string vazia — e
  // `"" ?? fallback` devolve "", não o fallback, o que apagava a persona inteira
  // (a seção vazia é descartada no join de buildSystemPrompt). Duas rotas chegam
  // no "": ensureAiSettings criando a linha antes do onboarding, e o admin salvando
  // o textarea vazio (AiAssistantTab não valida tamanho mínimo).
  await t.step("baseSystemPrompt vazio ou só espaços: usa o fallback, não some", async () => {
    for (const vazio of ["", "   \n  "]) {
      const uninstall = installFetchMock(emptyAdaptiveContextRouter);
      try {
        const result = await buildSystemPrompt({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          contactId: "contact-1",
          conversationId: "conv-1",
          dealId: null,
          tenantName: "Clínica Z",
          tenantBusinessProfile: null,
          baseSystemPrompt: vazio,
          stagePrompt: "",
          currentMessageIsAudio: false,
        });
        if (!result.includes("assistente virtual atenciosa") || !result.includes("Clínica Z")) {
          throw new Error(`persona sumiu com baseSystemPrompt=${JSON.stringify(vazio)}: ${result}`);
        }
      } finally {
        uninstall();
      }
    }
  });

  // Bug de produção (2026-08-04 21:21): lead mandou "teste 1820" como texto
  // puro (media_type IS NULL) e a IA respondeu "Não consigo ouvir áudios por
  // aqui ainda, você poderia escrever o que precisa?" — sem NENHUM guard
  // dizendo ao modelo o tipo da mensagem atual, ele generalizava de menções a
  // áudio mais antigas na mesma conversa.
  await t.step(
    "currentMessageIsAudio=false: guarda instrui a ignorar menções a áudio do histórico",
    async () => {
      const uninstall = installFetchMock(emptyAdaptiveContextRouter);
      try {
        const result = await buildSystemPrompt({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          contactId: "contact-1",
          conversationId: "conv-1",
          dealId: null,
          tenantName: "Clínica X",
          tenantBusinessProfile: null,
          baseSystemPrompt: "Você atende leads de {{empresa}}.",
          stagePrompt: "",
          currentMessageIsAudio: false,
        });
        if (!result.includes("foi digitada como texto, não é áudio")) {
          throw new Error(`guarda de texto ausente: ${result}`);
        }
        if (result.includes("veio de um ÁUDIO já transcrito")) {
          throw new Error(`guarda de áudio vazou com currentMessageIsAudio=false: ${result}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "currentMessageIsAudio=true: guarda avisa que a mensagem atual é áudio transcrito",
    async () => {
      const uninstall = installFetchMock(emptyAdaptiveContextRouter);
      try {
        const result = await buildSystemPrompt({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          contactId: "contact-1",
          conversationId: "conv-1",
          dealId: null,
          tenantName: "Clínica X",
          tenantBusinessProfile: null,
          baseSystemPrompt: "Você atende leads de {{empresa}}.",
          stagePrompt: "",
          currentMessageIsAudio: true,
        });
        if (!result.includes("veio de um ÁUDIO já transcrito")) {
          throw new Error(`guarda de áudio ausente: ${result}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // Bug de produção (2026-08-05, 11:38 UTC = 08:38 em Brasília): a IA abriu
  // a resposta com "Boa noite!" pra um lead sem `ai_memory` consolidada.
  // Antes desta correção, getTimeOfDay() só era chamada dentro do bloco
  // IMPLÍCITO de context-builder.ts (memória consolidada + sem deal
  // aberto) — contato sem memória (o caso deste teste, mesmo router de
  // emptyAdaptiveContextRouter que devolve ai_memory: null e nenhum deal)
  // nunca recebia o horário no prompt. `git stash` desta correção faz este
  // teste falhar (evidência colada no PR).
  await t.step(
    "sem deal e sem memória consolidada: horário do lead ainda entra no prompt",
    async () => {
      const uninstall = installFetchMock(emptyAdaptiveContextRouter);
      try {
        const result = await buildSystemPrompt({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          contactId: "contact-1",
          conversationId: "conv-1",
          dealId: null,
          tenantName: "Clínica X",
          tenantBusinessProfile: null,
          baseSystemPrompt: "Você atende leads de {{empresa}}.",
          stagePrompt: "",
          currentMessageIsAudio: false,
        });
        if (!result.includes("Horário atual do lead:")) {
          throw new Error(`horário ausente do prompt sem memória consolidada: ${result}`);
        }
        if (!result.includes("saudação")) {
          throw new Error(`instrução de alinhar saudação ao horário ausente: ${result}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- loadRecentHistory --------------------

Deno.test("loadRecentHistory", async (t) => {
  await t.step(
    "mensagens enviadas: rotula por remetente e devolve em ordem cronológica",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          // API devolve em ordem DESC (mais recente primeiro).
          return jsonResponse(200, [
            {
              sender: "ai",
              content: "Posso ajudar em algo mais?",
              created_at: "2026-01-01T00:02:00Z",
            },
            { sender: "contact", content: "Quero agendar", created_at: "2026-01-01T00:01:00Z" },
          ]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadRecentHistory(newAdminClient(), "conv-1", {
          historyLimit: 20,
          historyMaxChars: 4000,
        });
        if (result.length !== 2) throw new Error(`esperado 2 mensagens, veio ${result.length}`);
        if (result[0].role !== "user" || result[0].content !== "Quero agendar") {
          throw new Error(`primeira mensagem incorreta: ${JSON.stringify(result[0])}`);
        }
        if (result[1].role !== "assistant" || !result[1].content.includes("Posso ajudar")) {
          throw new Error(`segunda mensagem incorreta: ${JSON.stringify(result[1])}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("erro na query: nunca lança, devolve histórico vazio (fail-open)", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await loadRecentHistory(newAdminClient(), "conv-1", {
        historyLimit: 20,
        historyMaxChars: 4000,
      });
      if (result.length !== 0) throw new Error(`esperado [], veio ${JSON.stringify(result)}`);
    } finally {
      uninstall();
    }
  });

  // Parte do fix do incidente de 2026-08-04 21:21 (ver mediaGuard em
  // buildSystemPrompt): sem este rótulo, uma mensagem do lead vinda de áudio
  // transcrito era indistinguível de texto digitado no histórico.
  await t.step(
    "mensagem do lead com media_type de áudio: rotula com [Áudio transcrito]",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          return jsonResponse(200, [
            {
              sender: "contact",
              content: "quero saber o preço",
              created_at: "2026-01-01T00:02:00Z",
              media_type: "audio/ogg; codecs=opus",
            },
            {
              sender: "contact",
              content: "teste 1820",
              created_at: "2026-01-01T00:01:00Z",
              media_type: null,
            },
          ]);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await loadRecentHistory(newAdminClient(), "conv-1", {
          historyLimit: 20,
          historyMaxChars: 4000,
        });
        if (result[0].content !== "teste 1820") {
          throw new Error(`mensagem de texto não deveria ser rotulada: ${JSON.stringify(result[0])}`);
        }
        if (result[1].content !== "[Áudio transcrito] quero saber o preço") {
          throw new Error(`mensagem de áudio não rotulada: ${JSON.stringify(result[1])}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// -------------------- performHandoff --------------------

Deno.test("performHandoff", async (t) => {
  await t.step("com dealId: busca owner do deal e cria activity com owner_id", async () => {
    let activityBody: Record<string, unknown> | null = null;
    let conversationsPatchBody: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        conversationsPatchBody = req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
        return jsonResponse(200, { owner_id: "owner-1" });
      }
      if (req.pathname === "/rest/v1/activities" && req.method === "POST") {
        activityBody = req.bodyJson as Record<string, unknown>;
        // .insert(...).select("id").single() (Fase 3 — schema HITL): a
        // activity precisa existir e devolver o id ANTES do PATCH em
        // conversations, para handoff_activity_id ir na mesma chamada.
        return jsonResponse(201, { id: "activity-mock-1" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await performHandoff({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        dealId: "deal-1",
        contact: CONTACT,
        reason: "keyword_match",
        previousAwaitingHuman: true,
      });
      if (result.reason !== "keyword_match") throw new Error(`reason=${result.reason}`);
      if (!conversationsPatchBody) throw new Error("PATCH em conversations não foi capturado");
      const convBody = conversationsPatchBody as Record<string, unknown>;
      if (convBody.ai_active !== false) {
        throw new Error(`conversations PATCH incorreto: ${JSON.stringify(convBody)}`);
      }
      if (convBody.handoff_activity_id !== "activity-mock-1") {
        throw new Error(
          `conversations PATCH deveria linkar handoff_activity_id: ${JSON.stringify(convBody)}`,
        );
      }
      if (!activityBody) throw new Error("POST em activities não foi capturado");
      const actBody = activityBody as Record<string, unknown>;
      if (actBody.owner_id !== "owner-1") {
        throw new Error(`activities POST sem owner_id: ${JSON.stringify(actBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem dealId: pula query de deal, cria activity com owner_id=null", async () => {
    let activityBody: Record<string, unknown> | null = null;
    let conversationsPatchBody: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        conversationsPatchBody = req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
        throw new Error("não deveria consultar deals sem dealId");
      }
      if (req.pathname === "/rest/v1/activities" && req.method === "POST") {
        activityBody = req.bodyJson as Record<string, unknown>;
        return jsonResponse(201, { id: "activity-mock-2" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await performHandoff({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-2",
        dealId: null,
        contact: CONTACT,
        reason: "ia_incerta",
        previousAwaitingHuman: true,
      });
      if (result.reason !== "ia_incerta") throw new Error(`reason=${result.reason}`);
      if (!activityBody) throw new Error("POST em activities não foi capturado");
      const actBody = activityBody as Record<string, unknown>;
      if (actBody.owner_id !== null) {
        throw new Error(`owner_id deveria ser null: ${JSON.stringify(actBody)}`);
      }
      if (!conversationsPatchBody) throw new Error("PATCH em conversations não foi capturado");
      const convBody = conversationsPatchBody as Record<string, unknown>;
      if (convBody.handoff_activity_id !== "activity-mock-2") {
        throw new Error(
          `conversations PATCH deveria linkar handoff_activity_id: ${JSON.stringify(convBody)}`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "insert em activities falha: degrada com handoff_activity_id=null, não lança",
    async () => {
      let conversationsPatchBody: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          conversationsPatchBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
          return jsonResponse(200, { owner_id: "owner-1" });
        }
        if (req.pathname === "/rest/v1/activities" && req.method === "POST") {
          return jsonResponse(500, { message: "insert failed" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await performHandoff({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-3",
          dealId: "deal-1",
          contact: CONTACT,
          reason: "media_received",
          previousAwaitingHuman: true,
        });
        if (result.reason !== "media_received") throw new Error(`reason=${result.reason}`);
        if (!conversationsPatchBody) throw new Error("PATCH em conversations não foi capturado");
        const convBody = conversationsPatchBody as Record<string, unknown>;
        if (convBody.awaiting_human !== true) {
          throw new Error(
            `awaiting_human deveria continuar true mesmo com activity falhando: ${
              JSON.stringify(convBody)
            }`,
          );
        }
        if (convBody.handoff_activity_id !== null) {
          throw new Error(`handoff_activity_id deveria ser null: ${JSON.stringify(convBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "UPDATE em conversations falha: não lança, loga o erro e ainda retorna { reason }",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(500, { message: "update conversations failed" });
        }
        if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
          return jsonResponse(200, { owner_id: "owner-1" });
        }
        if (req.pathname === "/rest/v1/activities" && req.method === "POST") {
          return jsonResponse(201, { id: "activity-mock-4" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      const originalConsoleError = console.error;
      const errorCalls: unknown[][] = [];
      console.error = (...args: unknown[]) => {
        errorCalls.push(args);
      };
      try {
        const result = await performHandoff({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-4",
          dealId: "deal-1",
          contact: CONTACT,
          reason: "keyword_match",
          previousAwaitingHuman: true,
        });
        if (result.reason !== "keyword_match") {
          throw new Error(
            `deveria retornar { reason } normalmente mesmo com o UPDATE falhando: ${
              JSON.stringify(result)
            }`,
          );
        }
        const loggedUpdateFailure = errorCalls.some((args) =>
          args.some(
            (a) =>
              typeof a === "string" && a.includes("update conversations") && a.includes("handoff"),
          )
        );
        if (!loggedUpdateFailure) {
          throw new Error(
            `esperava console.error logando a falha do UPDATE em conversations: ${
              JSON.stringify(errorCalls)
            }`,
          );
        }
      } finally {
        console.error = originalConsoleError;
        uninstall();
      }
    },
  );

  await t.step(
    "previousAwaitingHuman=false: notifica admin (transição false→true, A3)",
    async () => {
      let notifiedRecipientsQuery = false;
      let resendCalled = false;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
          return jsonResponse(200, {
            channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
          });
        }
        if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
          return jsonResponse(200, {});
        }
        if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
          return jsonResponse(200, { owner_id: "owner-1" });
        }
        if (req.pathname === "/rest/v1/activities" && req.method === "POST") {
          return jsonResponse(201, { id: "activity-mock-5" });
        }
        if (req.pathname === "/rest/v1/hitl_handoff_sla_events" && req.method === "GET") {
          return jsonResponse(200, []); // sem cooldown ativo
        }
        if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
          notifiedRecipientsQuery = true;
          return jsonResponse(200, [{ address: "admin@acme.com" }]);
        }
        if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
          return jsonResponse(200, [
            { key: "api_key", value: "re_test" },
            { key: "from_domain", value: "acme.com" },
          ]);
        }
        if (req.url === "https://api.resend.com/emails" && req.method === "POST") {
          resendCalled = true;
          return jsonResponse(200, { id: "email-1" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const result = await performHandoff({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-5",
          dealId: "deal-1",
          contact: CONTACT,
          reason: "media_received",
          previousAwaitingHuman: false,
        });
        if (result.reason !== "media_received") throw new Error(`reason=${result.reason}`);
        if (!notifiedRecipientsQuery) {
          throw new Error("notifyAdminHandoff não consultou destinatários");
        }
        if (!resendCalled) throw new Error("notifyAdminHandoff não chamou o Resend");
      } finally {
        uninstall();
      }
    },
  );

  await t.step("previousAwaitingHuman=true: NÃO notifica admin de novo", async () => {
    // Flag síncrona em vez de throw-no-matcher: notifyAdminHandoff nunca
    // propaga exceção (by design), então um throw aqui seria sempre engolido
    // e o teste passaria mesmo se o `if (!previousAwaitingHuman)` fosse
    // removido — não pega regressão. Setar a flag e assertar
    // recipientsQueried===false DEPOIS do await pega a regressão de verdade.
    let recipientsQueried = false;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
        return jsonResponse(200, {
          channels: { tenant_id: "tenant-1", provider_slug: "zapi", type: "whatsapp" },
        });
      }
      if (req.pathname === "/rest/v1/conversations" && req.method === "PATCH") {
        return jsonResponse(200, {});
      }
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
        return jsonResponse(200, { owner_id: "owner-1" });
      }
      if (req.pathname === "/rest/v1/activities" && req.method === "POST") {
        return jsonResponse(201, { id: "activity-mock-6" });
      }
      if (req.pathname === "/rest/v1/weekly_report_recipients" && req.method === "GET") {
        recipientsQueried = true;
        return jsonResponse(200, []);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const result = await performHandoff({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-6",
        dealId: "deal-1",
        contact: CONTACT,
        reason: "media_received",
        previousAwaitingHuman: true,
      });
      if (result.reason !== "media_received") throw new Error(`reason=${result.reason}`);
      if (recipientsQueried) {
        throw new Error("não deveria notificar admin: previousAwaitingHuman já era true");
      }
    } finally {
      uninstall();
    }
  });
});

// -------------------- evaluateStageAdvancement --------------------

Deno.test("evaluateStageAdvancement", async (t) => {
  await t.step("sem critérios: retorna cedo e não chama o gateway", async () => {
    const uninstall = installFetchMock((req) => {
      if (req.url === GATEWAY_URL) throw new Error("gateway não deveria ser chamado");
      return undefined;
    });
    try {
      await evaluateStageAdvancement({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        dealId: "deal-1",
        dealStageId: "stage-1",
        stageAdvancement: [],
        stageGoal: "",
        effectiveModel: "google/gemini-2.5-flash",
        history: [],
        aiText: "ok",
      });
    } finally {
      uninstall();
    }
  });

  await t.step(
    "todos cumpridos: persiste critérios e delega à RPC a regra explícita habilitada",
    async () => {
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
      let evaluationsBody: unknown = null;
      let rpcBody: Record<string, unknown> | null = null;
      let directDealPatch = false;
      const router: FetchMatcher = (req) => {
        if (req.url === GATEWAY_URL) {
          return jsonResponse(
            200,
            aiSuccessBody(
              JSON.stringify({
                results: [
                  {
                    criterion: "Confirmou interesse",
                    met: true,
                    confidence: 0.95,
                    evidence: "lead confirmou interesse",
                  },
                ],
              }),
            ),
          );
        }
        if (req.pathname === "/rest/v1/deal_stage_evaluations" && req.method === "POST") {
          evaluationsBody = req.bodyJson;
          return jsonResponse(201, []);
        }
        if (req.pathname === "/rest/v1/stage_transitions" && req.method === "GET") {
          return jsonResponse(200, [
            {
              to_stage_id: "stage-manual",
              autonomy_mode: "manual",
              ai_priority: 0,
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              to_stage_id: "stage-assisted",
              autonomy_mode: "assisted",
              ai_priority: 100,
              created_at: "2026-01-02T00:00:00Z",
            },
          ]);
        }
        if (req.pathname === "/rest/v1/rpc/transition_deal_stage" && req.method === "POST") {
          rpcBody = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, { success: true, status: "queued" });
        }
        if (req.pathname === "/rest/v1/deals" && req.method === "PATCH") {
          directDealPatch = true;
          return jsonResponse(200, []);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        await evaluateStageAdvancement({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: "conv-1",
          dealId: "deal-1",
          dealStageId: "stage-1",
          stageAdvancement: ["Confirmou interesse"],
          stageGoal: "Agendar consulta",
          effectiveModel: "google/gemini-2.5-flash",
          history: [{ role: "user", content: "Quero agendar" }],
          aiText: "Vamos marcar o horário.",
          sourceEventId: "event-1",
          triggerEvent: "message.received",
          structuredSignals: { appointment: { scheduled: true } },
        });

        const evaluations = evaluationsBody as Array<Record<string, unknown>> | null;
        if (!evaluations || evaluations.length !== 1 || evaluations[0].status !== "met") {
          throw new Error(`avaliações não persistidas: ${JSON.stringify(evaluationsBody)}`);
        }
        const capturedRpc = rpcBody as Record<string, unknown> | null;
        if (!capturedRpc || capturedRpc.p_target_stage_id !== "stage-assisted") {
          throw new Error(`RPC não recebeu a regra ativa: ${JSON.stringify(rpcBody)}`);
        }
        if (
          capturedRpc.p_idempotency_key !==
            "pipeline:message.received:event-1:deal-1"
        ) {
          throw new Error(`idempotência incorreta: ${JSON.stringify(rpcBody)}`);
        }
        if (directDealPatch) throw new Error("pipeline não pode atualizar deals diretamente");
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "default manual: escolhe a prioridade zero e deixa a RPC registrar recomendação",
    async () => {
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
      let targetStage: unknown = null;
      const router: FetchMatcher = (req) => {
        if (req.url === GATEWAY_URL) {
          return jsonResponse(
            200,
            aiSuccessBody(
              JSON.stringify({
                results: [{ criterion: "Confirmou interesse", met: true, confidence: 0.9 }],
              }),
            ),
          );
        }
        if (req.pathname === "/rest/v1/deal_stage_evaluations" && req.method === "POST") {
          return jsonResponse(201, []);
        }
        if (req.pathname === "/rest/v1/stage_transitions" && req.method === "GET") {
          return jsonResponse(200, [
            {
              to_stage_id: "stage-later",
              autonomy_mode: "manual",
              ai_priority: 100,
              created_at: "2026-01-01T00:00:00Z",
            },
            {
              to_stage_id: "stage-next",
              autonomy_mode: "manual",
              ai_priority: 0,
              created_at: "2026-01-02T00:00:00Z",
            },
          ]);
        }
        if (req.pathname === "/rest/v1/rpc/transition_deal_stage" && req.method === "POST") {
          targetStage = (req.bodyJson as Record<string, unknown>).p_target_stage_id;
          return jsonResponse(200, { success: true, status: "recommended" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        await evaluateStageAdvancement({
          admin: newAdminClient(),
          tenantId: "tenant-1",
          conversationId: null,
          dealId: "deal-1",
          dealStageId: "stage-1",
          stageAdvancement: ["Confirmou interesse"],
          stageGoal: "Agendar consulta",
          effectiveModel: "google/gemini-2.5-flash",
          history: [],
          aiText: "Sinal estruturado",
          sourceEventId: "event-2",
          triggerEvent: "payment.approved",
        });
        if (targetStage !== "stage-next") {
          throw new Error(`default manual escolheu ${String(targetStage)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("critério parcial: persiste progresso e não chama transição", async () => {
    setEnv({ LOVABLE_API_KEY: "lovable-key" });
    let persistedRows = 0;
    let transitionCalled = false;
    const router: FetchMatcher = (req) => {
      if (req.url === GATEWAY_URL) {
        return jsonResponse(
          200,
          aiSuccessBody(
            JSON.stringify({
              results: [
                { criterion: "Confirmou interesse", met: true, confidence: 0.9 },
                { criterion: "Informou orçamento", met: false, confidence: 0.7 },
              ],
            }),
          ),
        );
      }
      if (req.pathname === "/rest/v1/deal_stage_evaluations" && req.method === "POST") {
        persistedRows = (req.bodyJson as unknown[]).length;
        return jsonResponse(201, []);
      }
      if (req.pathname === "/rest/v1/rpc/transition_deal_stage") transitionCalled = true;
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      await evaluateStageAdvancement({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        dealId: "deal-1",
        dealStageId: "stage-1",
        stageAdvancement: ["Confirmou interesse", "Informou orçamento"],
        stageGoal: "Agendar consulta",
        effectiveModel: "google/gemini-2.5-flash",
        history: [{ role: "user", content: "Quero agendar" }],
        aiText: "Vamos marcar o horário.",
      });
      if (persistedRows !== 2) throw new Error(`esperava 2 critérios, recebeu ${persistedRows}`);
      if (transitionCalled) throw new Error("critério parcial não pode pedir transição");
    } finally {
      uninstall();
    }
  });

  await t.step("falha da RPC de transição fica observável em ai_failure_logs", async () => {
    setEnv({ LOVABLE_API_KEY: "lovable-key" });
    let failureLog: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.url === GATEWAY_URL) {
        return jsonResponse(
          200,
          aiSuccessBody(
            JSON.stringify({
              results: [
                {
                  criterion: "Confirmou interesse",
                  met: true,
                  confidence: 0.99,
                  evidence: "confirmação sintética",
                },
              ],
            }),
          ),
        );
      }
      if (req.pathname === "/rest/v1/deal_stage_evaluations" && req.method === "POST") {
        return jsonResponse(201, []);
      }
      if (req.pathname === "/rest/v1/stage_transitions" && req.method === "GET") {
        return jsonResponse(200, [
          {
            to_stage_id: "stage-2",
            autonomy_mode: "autonomous",
            ai_priority: 0,
            created_at: "2026-07-28T00:00:00Z",
          },
        ]);
      }
      if (req.pathname === "/rest/v1/rpc/transition_deal_stage" && req.method === "POST") {
        return jsonResponse(500, {
          code: "XX000",
          message: "falha sintética da RPC",
        });
      }
      if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
        failureLog = req.bodyJson as Record<string, unknown>;
        return jsonResponse(201, {});
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      await evaluateStageAdvancement({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        dealId: "deal-1",
        dealStageId: "stage-1",
        stageAdvancement: ["Confirmou interesse"],
        stageGoal: "Avançar o negócio",
        effectiveModel: "google/gemini-2.5-flash",
        history: [{ role: "user", content: "Tenho interesse" }],
        aiText: "Interesse confirmado.",
        sourceEventId: "event-audit-1",
        triggerEvent: "message.received",
      });

      const captured = failureLog as Record<string, unknown> | null;
      if (!captured) {
        throw new Error("erro da RPC não gerou linha em ai_failure_logs");
      }
      if (captured.route !== "ai-respond.advancement") {
        throw new Error(`route inesperada: ${String(captured.route)}`);
      }
      if (captured.tenant_id !== "tenant-1") {
        throw new Error(`tenant_id inesperado: ${String(captured.tenant_id)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem chave do gateway: não persiste nem tenta transição", async () => {
    Deno.env.delete("LOVABLE_API_KEY");
    let databaseCalled = false;
    const uninstall = installFetchMock((req) => {
      if (req.url === GATEWAY_URL) throw new Error("gateway não deveria ser chamado");
      if (req.pathname.startsWith("/rest/v1/")) databaseCalled = true;
      return undefined;
    });
    try {
      await evaluateStageAdvancement({
        admin: newAdminClient(),
        tenantId: "tenant-1",
        conversationId: "conv-1",
        dealId: "deal-1",
        dealStageId: "stage-1",
        stageAdvancement: ["Confirmou interesse"],
        stageGoal: "Agendar consulta",
        effectiveModel: "google/gemini-2.5-flash",
        history: [],
        aiText: "ok",
      });
      if (databaseCalled) throw new Error("sem avaliação não deveria consultar o banco");
    } finally {
      uninstall();
    }
  });
});

// -------------------- critérios de ENTRADA do estágio de destino --------------------
//
// Par distinto de advancement_criteria: aqueles perguntam "o lead terminou o que
// tinha no estágio de origem?"; estes perguntam "o lead pode ser admitido no
// destino?". Um card barrado na entrada FICA onde está.

/** Router base: avanço da origem sempre cumprido, para isolar o portão de entrada. */
function entryRouter(
  opts: {
    entryCriteria?: unknown;
    stageConfigStatus?: number;
    onRpc: (body: Record<string, unknown>) => void;
    gatewayReplies: string[];
  },
): FetchMatcher {
  let gatewayCall = 0;
  return (req) => {
    if (req.url === GATEWAY_URL) {
      const body = opts.gatewayReplies[Math.min(gatewayCall, opts.gatewayReplies.length - 1)];
      gatewayCall += 1;
      return jsonResponse(200, aiSuccessBody(body));
    }
    if (req.pathname === "/rest/v1/deal_stage_evaluations" && req.method === "POST") {
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/stage_transitions" && req.method === "GET") {
      return jsonResponse(200, [
        { to_stage_id: "stage-destino", autonomy_mode: "autonomous", ai_priority: 0 },
      ]);
    }
    if (req.pathname === "/rest/v1/stage_ai_config" && req.method === "GET") {
      if (opts.stageConfigStatus && opts.stageConfigStatus >= 400) {
        return jsonResponse(opts.stageConfigStatus, { message: "boom" });
      }
      return jsonResponse(200, {
        entry_criteria: opts.entryCriteria ?? [],
        stage_goal: "Objetivo do destino",
      });
    }
    if (req.pathname === "/rest/v1/rpc/transition_deal_stage" && req.method === "POST") {
      opts.onRpc(req.bodyJson as Record<string, unknown>);
      return jsonResponse(200, { success: true, status: "moved" });
    }
    return undefined;
  };
}

const CUMPRIDO = JSON.stringify({
  results: [{ criterion: "Confirmou interesse", met: true, confidence: 0.95, evidence: "sim" }],
});
const NAO_CUMPRIDO = JSON.stringify({
  results: [{ criterion: "Tem orçamento aprovado", met: false, confidence: 0.9, evidence: "não" }],
});

async function rodarAvanco(router: FetchMatcher): Promise<void> {
  setEnv({ LOVABLE_API_KEY: "lovable-key" });
  const uninstall = installFetchMock(router);
  try {
    await evaluateStageAdvancement({
      admin: newAdminClient(),
      tenantId: "tenant-1",
      conversationId: "conv-1",
      dealId: "deal-1",
      dealStageId: "stage-origem",
      stageAdvancement: ["Confirmou interesse"],
      stageGoal: "Qualificar",
      effectiveModel: "google/gemini-2.5-flash",
      history: [{ role: "user", content: "tenho interesse" }],
      aiText: "ótimo",
    });
  } finally {
    uninstall();
  }
}

Deno.test("critérios de entrada do estágio de destino", async (t) => {
  await t.step("destino SEM critérios de entrada: avança, como antes da feature", async () => {
    let moveu = false;
    await rodarAvanco(
      entryRouter({ entryCriteria: [], onRpc: () => (moveu = true), gatewayReplies: [CUMPRIDO] }),
    );
    if (!moveu) throw new Error("lista vazia não pode barrar: a feature tem que ser inerte");
  });

  await t.step("destino com critérios CUMPRIDOS: avança", async () => {
    let moveu = false;
    await rodarAvanco(entryRouter({
      entryCriteria: ["Tem orçamento aprovado"],
      onRpc: () => (moveu = true),
      gatewayReplies: [CUMPRIDO, CUMPRIDO],
    }));
    if (!moveu) throw new Error("critérios de entrada cumpridos deveriam admitir o card");
  });

  await t.step("destino com critérios NÃO cumpridos: card fica onde está", async () => {
    let moveu = false;
    await rodarAvanco(entryRouter({
      entryCriteria: ["Tem orçamento aprovado"],
      onRpc: () => (moveu = true),
      gatewayReplies: [CUMPRIDO, NAO_CUMPRIDO],
    }));
    if (moveu) {
      throw new Error("barrado na entrada NÃO pode mover — é o ponto inteiro da feature");
    }
  });

  await t.step("falha ao ler a config do destino: avança (fail-open)", async () => {
    // Query instável não pode virar bloqueio silencioso do funil: sem esta
    // feature o comportamento era avançar, e é para lá que se cai na dúvida.
    let moveu = false;
    await rodarAvanco(entryRouter({
      stageConfigStatus: 500,
      onRpc: () => (moveu = true),
      gatewayReplies: [CUMPRIDO],
    }));
    if (!moveu) throw new Error("erro de leitura não pode barrar o card");
  });
});
