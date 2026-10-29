// Testa o handler de supabase/functions/hitl-sla-monitor/index.ts: auth
// fail-closed (service role), a query real contra hitl_handoff_sla_events
// (resolved_at/sla_alerted_at IS NULL + cutoff configurável), a resolução
// dinâmica de owner_id (com e sem deal vinculado) e a idempotência do
// watchdog (rodar 2x não duplica o alerta — critério de aceite do PRD).
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { req } from "./_hitl-test-helpers.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../hitl-sla-monitor/index.ts");

interface EventSeed {
  id: string;
  tenant_id: string;
  conversation_id: string;
  activity_id: string | null;
  awaiting_human_since: string;
  resolved_at: string | null;
  sla_alerted_at: string | null;
}

interface ConversationSeed {
  id: string;
  contact_id: string | null;
}

interface DealSeed {
  id: string;
  tenant_id: string;
  contact_id: string;
  owner_id: string | null;
  updated_at: string;
}

interface AdminSeed {
  id: string;
  tenant_id: string;
  created_at: string;
}

interface MockState {
  events: EventSeed[];
  conversations: ConversationSeed[];
  deals: DealSeed[];
  admins: AdminSeed[];
  decisionInserts: Record<string, unknown>[];
  slaUpdates: Array<{ id: string | null; body: Record<string, unknown> }>;
  failInsert?: boolean;
  failConversations?: boolean;
}

function defaultState(): MockState {
  return {
    events: [],
    conversations: [],
    deals: [],
    admins: [],
    decisionInserts: [],
    slaUpdates: [],
  };
}

function stripOp(raw: string | null): string | null {
  return raw?.replace(/^[a-z]+\./, "") ?? null;
}

/**
 * Mock stateful de PostgREST: filtra `state.events` pelos MESMOS parâmetros
 * que a query real do handler manda (resolved_at=is.null,
 * sla_alerted_at=is.null, awaiting_human_since=lt.<cutoff>) — isto é o que
 * valida a query final, não só a forma da resposta.
 */
function router(state: MockState): FetchMatcher {
  return (r) => {
    const sp = new URL(r.url).searchParams;

    if (r.pathname === "/rest/v1/hitl_handoff_sla_events" && r.method === "GET") {
      const resolvedFilter = sp.get("resolved_at");
      const alertedFilter = sp.get("sla_alerted_at");
      const cutoffRaw = stripOp(sp.get("awaiting_human_since"));
      if (resolvedFilter !== "is.null" || alertedFilter !== "is.null" || !cutoffRaw) {
        throw new Error(`query inesperada: ${r.url}`);
      }
      const cutoff = new Date(cutoffRaw);
      const rows = state.events.filter(
        (e) =>
          e.resolved_at === null && e.sla_alerted_at === null &&
          new Date(e.awaiting_human_since) < cutoff,
      );
      return jsonResponse(
        200,
        rows.map(({ id, tenant_id, conversation_id, activity_id, awaiting_human_since }) => ({
          id,
          tenant_id,
          conversation_id,
          activity_id,
          awaiting_human_since,
        })),
      );
    }

    if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
      if (state.failConversations) {
        return jsonResponse(500, { message: "select conversations falhou (simulado)" });
      }
      const id = stripOp(sp.get("id"));
      const conv = state.conversations.find((c) => c.id === id);
      return jsonResponse(200, conv ? { contact_id: conv.contact_id } : null);
    }

    if (r.pathname === "/rest/v1/deals" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const contactId = stripOp(sp.get("contact_id"));
      const top = state.deals
        .filter((d) => d.tenant_id === tenantId && d.contact_id === contactId)
        .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0];
      return jsonResponse(200, top ? { id: top.id, owner_id: top.owner_id } : null);
    }

    if (r.pathname === "/rest/v1/profiles" && r.method === "GET") {
      const tenantId = stripOp(sp.get("tenant_id"));
      const role = stripOp(sp.get("role"));
      const top = state.admins
        .filter((a) => a.tenant_id === tenantId && role === "admin")
        .sort((a, b) => new Date(a.created_at).getTime() - new Date(b.created_at).getTime())[0];
      return jsonResponse(200, top ? { id: top.id } : null);
    }

    if (r.pathname === "/rest/v1/hitl_decisions" && r.method === "POST") {
      if (state.failInsert) return jsonResponse(500, { message: "insert falhou" });
      state.decisionInserts.push(r.bodyJson as Record<string, unknown>);
      return new Response("", { status: 201 });
    }

    if (r.pathname === "/rest/v1/hitl_handoff_sla_events" && r.method === "PATCH") {
      const id = stripOp(sp.get("id"));
      const body = r.bodyJson as Record<string, unknown>;
      state.slaUpdates.push({ id, body });
      const ev = state.events.find((e) => e.id === id);
      if (ev) ev.sla_alerted_at = String(body.sla_alerted_at);
      return new Response("", { status: 200 });
    }

    return undefined;
  };
}

/**
 * Captura chamadas de `console.error` sem depender de lib externa de
 * spy/stub (mesmo espírito manual de installFetchMock acima) — usado só pelo
 * teste de falha de query dentro de resolveOwnerId (ver
 * "erro na query conversations..." abaixo).
 */
function captureConsoleError(): { calls: unknown[][]; restore: () => void } {
  const original = console.error;
  const calls: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    calls.push(args);
  };
  return {
    calls,
    restore: () => {
      console.error = original;
    },
  };
}

const HOUR_AGO = new Date(Date.now() - 60 * 60 * 1000).toISOString();

function seedBreachedEvent(state: MockState, overrides: Partial<EventSeed> = {}): void {
  state.events.push({
    id: "evt-1",
    tenant_id: "tenant-1",
    conversation_id: "conv-1",
    activity_id: null,
    awaiting_human_since: HOUR_AGO,
    resolved_at: null,
    sla_alerted_at: null,
    ...overrides,
  });
}

Deno.test("hitl-sla-monitor", async (t) => {
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

  await t.step("sem eventos estourados: scanned=0 alerted=0, nenhuma decision criada", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(req());
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.scanned !== 0 || body.alerted !== 0) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (state.decisionInserts.length !== 0) throw new Error("não deveria criar hitl_decisions");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "resolve owner via deals.owner_id quando há deal vinculado ao contato da conversa",
    async () => {
      const state = defaultState();
      seedBreachedEvent(state);
      state.conversations.push({ id: "conv-1", contact_id: "contact-1" });
      state.deals.push({
        id: "deal-1",
        tenant_id: "tenant-1",
        contact_id: "contact-1",
        owner_id: "owner-1",
        updated_at: "2026-07-01T00:00:00Z",
      });
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.scanned !== 1 || body.alerted !== 1) {
          throw new Error(
            `inesperado: ${JSON.stringify(body)}`,
          );
        }

        if (state.decisionInserts.length !== 1) throw new Error("esperava 1 hitl_decisions criada");
        const decision = state.decisionInserts[0];
        if (decision.tenant_id !== "tenant-1") {
          throw new Error(
            `tenant_id inesperado: ${decision.tenant_id}`,
          );
        }
        if (
          decision.category !== "deadline" || decision.priority !== "critical" ||
          decision.type !== "sla_breach"
        ) {
          throw new Error(`categoria/prioridade/tipo inesperados: ${JSON.stringify(decision)}`);
        }
        if (decision.deal_id !== "deal-1" || decision.contact_id !== "contact-1") {
          throw new Error(`deal_id/contact_id inesperados: ${JSON.stringify(decision)}`);
        }
        const suggestedAction = decision.suggested_action as Record<string, unknown>;
        if (suggestedAction.owner_id !== "owner-1") {
          throw new Error(`owner_id esperado 'owner-1', veio ${JSON.stringify(suggestedAction)}`);
        }

        if (state.slaUpdates.length !== 1 || state.slaUpdates[0].id !== "evt-1") {
          throw new Error(
            `sla_alerted_at não foi marcado corretamente: ${JSON.stringify(state.slaUpdates)}`,
          );
        }
        if (!state.slaUpdates[0].body.sla_alerted_at) {
          throw new Error(
            "sla_alerted_at deveria ter um timestamp",
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "sem deal vinculado ao contato: cai para o admin mais antigo do tenant",
    async () => {
      const state = defaultState();
      seedBreachedEvent(state, { id: "evt-2", tenant_id: "tenant-2", conversation_id: "conv-2" });
      state.conversations.push({ id: "conv-2", contact_id: "contact-2" });
      // Sem deal para este contato -- só admins de outro tenant, para garantir
      // que o filtro por tenant_id também é respeitado.
      state.admins.push(
        { id: "admin-newer", tenant_id: "tenant-2", created_at: "2026-02-01T00:00:00Z" },
        { id: "admin-oldest", tenant_id: "tenant-2", created_at: "2026-01-01T00:00:00Z" },
        { id: "admin-other-tenant", tenant_id: "tenant-x", created_at: "2025-01-01T00:00:00Z" },
      );
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.alerted !== 1) throw new Error(`inesperado: ${JSON.stringify(body)}`);

        const decision = state.decisionInserts[0];
        if (decision.deal_id !== null) {
          throw new Error(
            `deal_id deveria ser null, veio ${decision.deal_id}`,
          );
        }
        // conversations.contact_id é NOT NULL no schema real -- mesmo sem deal
        // vinculado, o contact_id da conversa deve chegar na decision.
        if (decision.contact_id !== "contact-2") {
          throw new Error(
            `contact_id deveria vir da conversa mesmo sem deal, veio ${decision.contact_id}`,
          );
        }
        const suggestedAction = decision.suggested_action as Record<string, unknown>;
        if (suggestedAction.owner_id !== "admin-oldest") {
          throw new Error(
            `fallback deveria ser o admin mais antigo do tenant, veio ${
              JSON.stringify(suggestedAction)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "deal vinculado mas sem owner_id também cai para o admin mais antigo do tenant",
    async () => {
      const state = defaultState();
      seedBreachedEvent(state, { id: "evt-3", tenant_id: "tenant-3", conversation_id: "conv-3" });
      state.conversations.push({ id: "conv-3", contact_id: "contact-3" });
      state.deals.push({
        id: "deal-3",
        tenant_id: "tenant-3",
        contact_id: "contact-3",
        owner_id: null,
        updated_at: "2026-07-01T00:00:00Z",
      });
      state.admins.push({
        id: "admin-3",
        tenant_id: "tenant-3",
        created_at: "2026-01-01T00:00:00Z",
      });
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (body.alerted !== 1) throw new Error(`inesperado: ${JSON.stringify(body)}`);
        const decision = state.decisionInserts[0];
        if (decision.deal_id !== "deal-3") {
          throw new Error(
            `deal_id esperado 'deal-3', veio ${decision.deal_id}`,
          );
        }
        const suggestedAction = decision.suggested_action as Record<string, unknown>;
        if (suggestedAction.owner_id !== "admin-3") {
          throw new Error(
            `owner_id esperado fallback 'admin-3', veio ${JSON.stringify(suggestedAction)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "idempotência: rodar o watchdog 2x seguidas não duplica o alerta do mesmo evento",
    async () => {
      const state = defaultState();
      seedBreachedEvent(state);
      state.conversations.push({ id: "conv-1", contact_id: "contact-1" });
      state.deals.push({
        id: "deal-1",
        tenant_id: "tenant-1",
        contact_id: "contact-1",
        owner_id: "owner-1",
        updated_at: "2026-07-01T00:00:00Z",
      });
      const uninstall = installFetchMock(router(state));
      try {
        const firstRun = await (await handler(req())).json();
        if (firstRun.scanned !== 1 || firstRun.alerted !== 1) {
          throw new Error(`1ª execução inesperada: ${JSON.stringify(firstRun)}`);
        }
        if (state.decisionInserts.length !== 1) {
          throw new Error(
            "1ª execução deveria criar exatamente 1 decision",
          );
        }

        // 2ª execução: o mock reflete o mesmo estado real do banco -- o evento
        // já tem sla_alerted_at preenchido pela 1ª execução, então a query
        // real (sla_alerted_at IS NULL) não deve mais retorná-lo.
        const secondRun = await (await handler(req())).json();
        if (secondRun.scanned !== 0 || secondRun.alerted !== 0) {
          throw new Error(
            `2ª execução deveria ignorar o evento já alertado: ${JSON.stringify(secondRun)}`,
          );
        }
        if (state.decisionInserts.length !== 1) {
          throw new Error(
            `esperava continuar com 1 decision só, veio ${state.decisionInserts.length}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("threshold configurável via HITL_SLA_BREACH_MINUTES", async () => {
    const state = defaultState();
    const tenMinutesAgo = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    seedBreachedEvent(state, { awaiting_human_since: tenMinutesAgo });
    state.conversations.push({ id: "conv-1", contact_id: "contact-1" });
    state.deals.push({
      id: "deal-1",
      tenant_id: "tenant-1",
      contact_id: "contact-1",
      owner_id: "owner-1",
      updated_at: "2026-07-01T00:00:00Z",
    });
    const uninstall = installFetchMock(router(state));
    try {
      // Threshold default (30min): evento de 10min atrás NÃO deveria estourar.
      const defaultRun = await (await handler(req())).json();
      if (defaultRun.scanned !== 0) {
        throw new Error(
          `threshold default deveria ignorar evento de 10min, veio ${JSON.stringify(defaultRun)}`,
        );
      }

      // Threshold custom (5min): o mesmo evento de 10min atrás já estourou.
      setEnv({ HITL_SLA_BREACH_MINUTES: "5" });
      const customRun = await (await handler(req())).json();
      if (customRun.scanned !== 1 || customRun.alerted !== 1) {
        throw new Error(
          `threshold custom deveria capturar o evento, veio ${JSON.stringify(customRun)}`,
        );
      }
    } finally {
      Deno.env.delete("HITL_SLA_BREACH_MINUTES");
      uninstall();
    }
  });

  await t.step(
    "erro ao inserir hitl_decisions é reportado em errors e NÃO marca sla_alerted_at",
    async () => {
      const state = defaultState();
      seedBreachedEvent(state);
      state.conversations.push({ id: "conv-1", contact_id: "contact-1" });
      state.failInsert = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(req());
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (body.alerted !== 0) throw new Error(`inesperado: ${JSON.stringify(body)}`);
        if (!Array.isArray(body.errors) || body.errors.length !== 1) {
          throw new Error(`errors inesperado: ${JSON.stringify(body.errors)}`);
        }
        if (state.slaUpdates.length !== 0) {
          throw new Error(
            "não deveria marcar sla_alerted_at quando o insert falha",
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro na query conversations dentro de resolveOwnerId é logado e não trava o alerta",
    async () => {
      const state = defaultState();
      seedBreachedEvent(state, { id: "evt-4", tenant_id: "tenant-4", conversation_id: "conv-4" });
      state.admins.push({
        id: "admin-4",
        tenant_id: "tenant-4",
        created_at: "2026-01-01T00:00:00Z",
      });
      state.failConversations = true;
      const uninstall = installFetchMock(router(state));
      const errorLog = captureConsoleError();
      try {
        const res = await handler(req());
        const body = await res.json();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        // Mesmo com a query de conversations falhando, o watchdog não pode
        // travar: cai no fallback (admin mais antigo do tenant) igual ao
        // caso "sem deal vinculado" — preferir alertar com dados incompletos
        // a nunca alertar.
        if (body.alerted !== 1) {
          throw new Error(
            `esperava alerted=1 mesmo com falha na query conversations: ${JSON.stringify(body)}`,
          );
        }

        const loggedConversationsError = errorLog.calls.some((call) =>
          typeof call[0] === "string" && call[0].includes("conversations")
        );
        if (!loggedConversationsError) {
          throw new Error(
            `esperava console.error citando a falha da query conversations, veio ${
              JSON.stringify(errorLog.calls)
            }`,
          );
        }

        const decision = state.decisionInserts[0];
        if (decision.contact_id !== null) {
          throw new Error(
            `contact_id deveria ser null (conversa não resolvida), veio ${decision.contact_id}`,
          );
        }
        if (decision.deal_id !== null) {
          throw new Error(
            `deal_id deveria ser null (conversa não resolvida), veio ${decision.deal_id}`,
          );
        }
        const suggestedAction = decision.suggested_action as Record<string, unknown>;
        if (suggestedAction.owner_id !== "admin-4") {
          throw new Error(
            `fallback deveria ser o admin mais antigo do tenant, veio ${
              JSON.stringify(suggestedAction)
            }`,
          );
        }
      } finally {
        errorLog.restore();
        uninstall();
      }
    },
  );

  await t.step("nenhum valor hardcoded de telefone/contato no código-fonte", async () => {
    const source = await Deno.readTextFile(
      new URL("../hitl-sla-monitor/index.ts", import.meta.url),
    );
    // Sequência isolada de 10-13 dígitos = formato plausível de telefone
    // (BR com/sem DDI). Lookaround evita falso positivo em timestamps de
    // migration citados em comentário (14 dígitos, ex. 20260710120000).
    const phoneLikeDigits = /(?<!\d)\d{10,13}(?!\d)/.test(source);
    if (phoneLikeDigits) {
      throw new Error("sequência de dígitos parecida com telefone encontrada no código-fonte");
    }
    if (/\bPHONE\b/i.test(source)) {
      throw new Error("menção a PHONE encontrada -- possível env var de contato fixo");
    }
    if (!source.includes("owner_id")) {
      throw new Error("resolução de owner_id não encontrada -- verificar regressão");
    }
  });
});
