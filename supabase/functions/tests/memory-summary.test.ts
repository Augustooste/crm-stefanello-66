// Testa generateConversationSummary (_shared/ai/memory-summary.ts): só gera
// resumo quando há mensagens novas suficientes, grava o shape esperado em
// ai_conversation_summaries, e nunca lança — resposta malformada da LLM vira
// `{ success: false, error }` em vez de INSERT com lixo.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";
import { generateConversationSummary } from "../_shared/ai/memory-summary.ts";

setEnv(BASE_ENV);
setEnv({ LOVABLE_API_KEY: "lovable-key" });

const TENANT_ID = "tenant-1";
const CONTACT_ID = "contact-1";
const CONVERSATION_ID = "conv-1";
const DEAL_ID = "deal-1";

interface MessageRow {
  content: string | null;
  sender: string;
  direction: string;
  created_at: string;
}

interface State {
  lastPeriodEnd: string | null;
  messages: MessageRow[];
  gatewayBody: unknown;
  gatewayStatus: number;
  gatewayCalled: boolean;
  insertCalled: boolean;
  insertCaptured: Record<string, unknown> | null;
  insertFails: boolean;
}

function baseState(overrides: Partial<State> = {}): State {
  return {
    lastPeriodEnd: null,
    messages: [],
    gatewayBody: { choices: [{ message: { content: "" } }] },
    gatewayStatus: 200,
    gatewayCalled: false,
    insertCalled: false,
    insertCaptured: null,
    insertFails: false,
    ...overrides,
  };
}

function makeMessages(count: number): MessageRow[] {
  return Array.from({ length: count }, (_, i) => ({
    content: `mensagem ${i + 1}`,
    sender: i % 2 === 0 ? "contact" : "ai",
    direction: i % 2 === 0 ? "in" : "out",
    created_at: `2026-07-0${i + 1}T10:00:00.000Z`,
  }));
}

function router(state: State): FetchMatcher {
  return (req: MockRequest) => {
    const u = new URL(req.url);

    if (u.pathname === "/rest/v1/ai_conversation_summaries") {
      if (req.method === "GET") {
        return jsonResponse(200, state.lastPeriodEnd ? [{ period_end: state.lastPeriodEnd }] : []);
      }
      if (req.method === "POST") {
        state.insertCalled = true;
        state.insertCaptured = req.bodyJson as Record<string, unknown>;
        if (state.insertFails) return jsonResponse(500, { message: "insert falhou" });
        return emptyResponse(201);
      }
    }

    if (u.pathname === "/rest/v1/messages" && req.method === "GET") {
      return jsonResponse(200, state.messages);
    }

    if (u.pathname === "/v1/chat/completions") {
      state.gatewayCalled = true;
      return jsonResponse(state.gatewayStatus, state.gatewayBody);
    }

    return undefined;
  };
}

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("generateConversationSummary", async (t) => {
  await t.step("menos de 5 mensagens novas: não chama a IA nem grava resumo", async () => {
    const state = baseState({ messages: makeMessages(4) });
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await generateConversationSummary(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (!result.success) throw new Error(`esperado success=true, veio error=${result.error}`);
      if (state.gatewayCalled) throw new Error("gateway da IA não deveria ter sido chamado");
      if (state.insertCalled) throw new Error("INSERT não deveria ter sido chamado");
    } finally {
      uninstall();
    }
  });

  await t.step(">=5 mensagens novas: gera e grava o resumo com o shape esperado", async () => {
    const messages = makeMessages(5);
    const gatewaySummary = {
      summary: "Lead perguntou sobre preço e prazo de entrega.",
      key_facts: ["quer entrega até sexta"],
      sentiment: "positive",
      topics_discussed: ["preço", "prazo"],
      open_questions: ["forma de pagamento"],
      commitments: ["atendente vai enviar proposta"],
      objections: ["achou caro"],
    };
    const state = baseState({
      messages,
      gatewayBody: { choices: [{ message: { content: JSON.stringify(gatewaySummary) } }] },
    });
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await generateConversationSummary(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
        dealId: DEAL_ID,
      });

      if (!result.success) throw new Error(`esperado success=true, veio error=${result.error}`);
      if (!state.gatewayCalled) throw new Error("gateway da IA deveria ter sido chamado");
      if (!state.insertCalled || !state.insertCaptured) {
        throw new Error("INSERT deveria ter sido chamado");
      }

      const body = state.insertCaptured;
      const errs: string[] = [];
      if (body.tenant_id !== TENANT_ID) errs.push(`tenant_id=${body.tenant_id}`);
      if (body.contact_id !== CONTACT_ID) errs.push(`contact_id=${body.contact_id}`);
      if (body.conversation_id !== CONVERSATION_ID) {
        errs.push(`conversation_id=${body.conversation_id}`);
      }
      if (body.deal_id !== DEAL_ID) errs.push(`deal_id=${body.deal_id}`);
      if (body.summary !== gatewaySummary.summary) errs.push(`summary=${body.summary}`);
      if (JSON.stringify(body.key_facts) !== JSON.stringify(gatewaySummary.key_facts)) {
        errs.push(`key_facts=${JSON.stringify(body.key_facts)}`);
      }
      if (body.sentiment !== "positive") errs.push(`sentiment=${body.sentiment}`);
      if (body.messages_covered !== 5) errs.push(`messages_covered=${body.messages_covered}`);
      if (body.period_start !== messages[0].created_at) {
        errs.push(`period_start=${body.period_start}`);
      }
      if (body.period_end !== messages[4].created_at) errs.push(`period_end=${body.period_end}`);
      if (errs.length > 0) throw new Error(errs.join("; "));
    } finally {
      uninstall();
    }
  });

  await t.step("resposta da IA sem deal_id: grava deal_id null", async () => {
    const messages = makeMessages(5);
    const gatewaySummary = {
      summary: "Resumo sem negócio associado.",
      key_facts: [],
      sentiment: "neutral",
      topics_discussed: [],
      open_questions: [],
      commitments: [],
      objections: [],
    };
    const state = baseState({
      messages,
      gatewayBody: { choices: [{ message: { content: JSON.stringify(gatewaySummary) } }] },
    });
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await generateConversationSummary(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (!result.success) throw new Error(`esperado success=true, veio error=${result.error}`);
      if (state.insertCaptured?.deal_id !== null) {
        throw new Error(`deal_id=${state.insertCaptured?.deal_id}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "resposta malformada da IA (JSON inválido): não quebra, retorna erro, não grava",
    async () => {
      const state = baseState({
        messages: makeMessages(5),
        gatewayBody: { choices: [{ message: { content: "isto não é json" } }] },
      });
      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        const result = await generateConversationSummary(admin, {
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
        });

        if (result.success) throw new Error("esperado success=false para resposta malformada");
        if (!result.error) throw new Error("esperado error preenchido");
        if (state.insertCalled) {
          throw new Error("INSERT não deveria ter sido chamado com resposta malformada");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "resposta malformada da IA (falta campo summary): não quebra, retorna erro, não grava",
    async () => {
      const state = baseState({
        messages: makeMessages(5),
        gatewayBody: { choices: [{ message: { content: JSON.stringify({ key_facts: ["x"] }) } }] },
      });
      const uninstall = installFetchMock(router(state));
      try {
        const admin = newAdminClient();
        const result = await generateConversationSummary(admin, {
          tenantId: TENANT_ID,
          contactId: CONTACT_ID,
          conversationId: CONVERSATION_ID,
        });

        if (result.success) throw new Error("esperado success=false quando falta summary");
        if (state.insertCalled) throw new Error("INSERT não deveria ter sido chamado sem summary");
      } finally {
        uninstall();
      }
    },
  );

  await t.step("INSERT falha na API: retorna success=false com o erro da API", async () => {
    const state = baseState({
      messages: makeMessages(5),
      gatewayBody: {
        choices: [
          {
            message: {
              content: JSON.stringify({
                summary: "ok",
                key_facts: [],
                sentiment: "neutral",
                topics_discussed: [],
                open_questions: [],
                commitments: [],
                objections: [],
              }),
            },
          },
        ],
      },
      insertFails: true,
    });
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await generateConversationSummary(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (result.success) throw new Error("esperado success=false quando o INSERT falha");
      if (!result.error) throw new Error("esperado error preenchido");
    } finally {
      uninstall();
    }
  });

  await t.step("LOVABLE_API_KEY ausente: retorna erro sem chamar o gateway", async () => {
    Deno.env.delete("LOVABLE_API_KEY");
    const state = baseState({ messages: makeMessages(5) });
    const uninstall = installFetchMock(router(state));
    try {
      const admin = newAdminClient();
      const result = await generateConversationSummary(admin, {
        tenantId: TENANT_ID,
        contactId: CONTACT_ID,
        conversationId: CONVERSATION_ID,
      });

      if (result.success) throw new Error("esperado success=false sem LOVABLE_API_KEY");
      if (state.gatewayCalled) throw new Error("gateway não deveria ter sido chamado sem chave");
    } finally {
      uninstall();
      setEnv({ LOVABLE_API_KEY: "lovable-key" });
    }
  });
});
