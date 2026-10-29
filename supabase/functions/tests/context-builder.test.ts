// Testa buildAdaptiveContext (supabase/functions/_shared/ai/context-builder.ts):
// prioridade explícito (deal aberto) > implícito (ai_memory + horário/canal) >
// vazio. Mocka /rest/v1/deals, /rest/v1/contacts e /rest/v1/conversations —
// nunca toca banco real (mesmo padrão de rate-limiter.test.ts/telemetry.test.ts).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { buildAdaptiveContext } from "../_shared/ai/context-builder.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const TENANT_ID = "tenant-1";
const CONTACT_ID = "contact-1";
const CONVERSATION_ID = "conv-1";

interface State {
  deal: Record<string, unknown> | null;
  contact: Record<string, unknown> | null;
  conversation: Record<string, unknown> | null;
}

function baseState(): State {
  return { deal: null, contact: null, conversation: null };
}

function router(state: State): FetchMatcher {
  return (req) => {
    if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
      return jsonResponse(200, state.deal ? [state.deal] : []);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, state.contact ? [state.contact] : []);
    }
    if (req.pathname === "/rest/v1/conversations" && req.method === "GET") {
      return jsonResponse(200, state.conversation ? [state.conversation] : []);
    }
    return undefined;
  };
}

Deno.test("buildAdaptiveContext", async (t) => {
  await t.step("deal explícito: prioriza dados do deal, nem consulta ai_memory", async () => {
    const state = baseState();
    state.deal = {
      id: "deal-1",
      title: "Implantação CRM — Clínica X",
      value: 4500,
      board_stages: { name: "Negociação" },
    };
    // Sem state.contact/state.conversation: se o código consultasse
    // ai_memory/canal por engano, viraria bloco vazio/diferente e o teste
    // abaixo pegaria a divergência.
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await buildAdaptiveContext(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (!result.includes("sinal explícito")) throw new Error(`bloco não é explícito: ${result}`);
      if (!result.includes("Implantação CRM — Clínica X")) {
        throw new Error(`sem título do deal: ${result}`);
      }
      if (!result.includes("Negociação")) throw new Error(`sem estágio: ${result}`);
      if (!result.includes("4.500") && !result.includes("4500")) {
        throw new Error(`sem valor do deal: ${result}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem deal, com ai_memory: usa perfil consolidado + canal", async () => {
    const state = baseState();
    state.deal = null;
    state.contact = {
      ai_memory: {
        personality: "Direto, gosta de respostas objetivas",
        preferences: ["prefere WhatsApp de manhã"],
        history_summary: "Cliente há 3 meses, já fechou 1 negócio.",
        important_dates: [{ date: "2026-08-10", note: "aniversário" }],
        relationship_notes: "Indicado por outro cliente VIP.",
        last_consolidated_at: "2026-07-01T10:00:00.000Z",
      },
    };
    state.conversation = { channels: { type: "whatsapp" } };
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await buildAdaptiveContext(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (!result.includes("sinal implícito")) throw new Error(`bloco não é implícito: ${result}`);
      if (!result.includes("Direto, gosta de respostas objetivas")) {
        throw new Error(`sem personalidade: ${result}`);
      }
      if (!result.includes("Cliente há 3 meses")) throw new Error(`sem histórico: ${result}`);
      if (!result.includes("Indicado por outro cliente VIP")) {
        throw new Error(`sem relacionamento: ${result}`);
      }
      if (!result.includes("aniversário")) throw new Error(`sem datas importantes: ${result}`);
      if (!result.includes("whatsapp")) throw new Error(`sem canal: ${result}`);
      // Horário NÃO é mais montado aqui — buildAdaptiveContext só cobre o
      // bloco explícito/implícito/vazio. getTimeOfDay() agora é chamada
      // direto em pipeline.ts (buildSystemPrompt) pra entrar no prompt em
      // TODO turno, não só quando há memória consolidada; ver
      // pipeline.test.ts "sem deal e sem memória consolidada: horário do
      // lead ainda entra no prompt".
    } finally {
      uninstall();
    }
  });

  await t.step(
    "sem deal e sem ai_memory: retorna string vazia (nunca null/undefined)",
    async () => {
      const state = baseState();
      state.deal = null;
      state.contact = { ai_memory: null };
      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        const result = await buildAdaptiveContext(admin, {
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
        });

        if (result !== "") throw new Error(`esperado "", recebido: ${JSON.stringify(result)}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "ai_memory como objeto vazio ({}) conta como ausente: retorna string vazia",
    async () => {
      const state = baseState();
      state.deal = null;
      state.contact = { ai_memory: {} };
      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        const result = await buildAdaptiveContext(admin, {
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
        });

        if (result !== "") throw new Error(`esperado "", recebido: ${JSON.stringify(result)}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step("dealId explícito: filtra a busca por esse id específico", async () => {
    const state = baseState();
    state.deal = {
      id: "deal-42",
      title: "Deal específico passado pelo caller",
      value: null,
      board_stages: { name: "Qualificação" },
    };
    let capturedIdFilter: string | null = null;
    const uninstall = installFetchMock((req) => {
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
        capturedIdFilter = new URL(req.url).searchParams.get("id");
        return jsonResponse(200, state.deal ? [state.deal] : []);
      }
      return undefined;
    });
    try {
      const admin = newAdminClient();
      const result = await buildAdaptiveContext(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        dealId: "deal-42",
      });

      if (capturedIdFilter !== "eq.deal-42") throw new Error(`filtro id=${capturedIdFilter}`);
      if (!result.includes("Deal específico passado pelo caller")) {
        throw new Error(`sem título do deal: ${result}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("erro na query de deals não lança: degrada para o próximo sinal", async () => {
    const state = baseState();
    state.contact = { ai_memory: null };
    const uninstall = installFetchMock((req) => {
      if (req.pathname === "/rest/v1/deals" && req.method === "GET") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
        return jsonResponse(200, state.contact ? [state.contact] : []);
      }
      return undefined;
    });
    try {
      const admin = newAdminClient();
      const result = await buildAdaptiveContext(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (result !== "") {
        throw new Error(`esperado "" (fail-open), recebido: ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });
});
