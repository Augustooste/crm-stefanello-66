// Regressão do achado 05 · H8 do code review de 10/08
// (docs/code-review/10-code-review-e2e-2026-08-10.md):
//
// `buildDealQualificationContext` fazia 4 queries em Promise.all e ignorava o
// `error` de 3 delas. supabase-js não lança em erro do PostgREST — devolve
// `{ data: null, error }` — então um blip de rede/RLS em `stage_ai_config`
// virava `stage.goal = null` e `advancementCriteria = []`: a IA qualificava o
// negócio SEM critério nenhum e o snapshot gravado parecia legítimo.
//
// O contrato documentado de generateQualificationSnapshot é FAIL-CLOSED, e o
// padrão `if (x.error) throw` já existia em _shared/ai/pipeline-agent.ts:143.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { buildDealQualificationContext } from "../_shared/ai/qualification/context.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

interface MockState {
  /** Tabelas cuja query deve devolver { error } em vez de dado. */
  falhar: Set<string>;
}

function router(state: MockState): FetchMatcher {
  return (r) => {
    const tabela = r.pathname.replace("/rest/v1/", "");
    if (r.method !== "GET") return undefined;

    if (state.falhar.has(tabela)) {
      return jsonResponse(500, {
        message: `falha simulada em ${tabela}`,
        code: "57014",
      });
    }

    switch (tabela) {
      case "deals":
        return jsonResponse(200, {
          id: "deal-1",
          title: "Negócio 1",
          value: 1000,
          contact_id: "contact-1",
          tenant_id: "tenant-1",
          stage_id: "stage-1",
          created_at: new Date().toISOString(),
        });
      case "tenants":
        return jsonResponse(200, { id: "tenant-1", name: "Clínica X", niche: null });
      case "contacts":
        return jsonResponse(200, { name: "Maria", email: null, phone: "5511999999999" });
      case "board_stages":
        return jsonResponse(200, { name: "Qualificação" });
      case "stage_ai_config":
        return jsonResponse(200, {
          stage_goal: "Confirmar orçamento e urgência",
          advancement_criteria: ["orçamento confirmado", "urgência declarada"],
        });
      case "conversations":
        return jsonResponse(200, []);
      case "messages":
        return jsonResponse(200, []);
      default:
        return undefined;
    }
  };
}

async function esperaErro(fn: () => Promise<unknown>, trecho: string): Promise<void> {
  try {
    await fn();
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (!msg.includes(trecho)) {
      throw new Error(`esperava erro contendo "${trecho}", veio "${msg}"`);
    }
    return;
  }
  throw new Error(
    `esperava que buildDealQualificationContext lançasse ("${trecho}"), mas ele devolveu um contexto — a IA qualificaria com dado faltando`,
  );
}

Deno.test("buildDealQualificationContext: fail-closed em erro de query (05 · H8)", async (t) => {
  await t.step("erro em stage_ai_config lança em vez de qualificar sem critério", async () => {
    const state: MockState = { falhar: new Set(["stage_ai_config"]) };
    const uninstall = installFetchMock(router(state));
    try {
      await esperaErro(
        () => buildDealQualificationContext(newAdminClient(), "deal-1"),
        "configuração de IA do estágio",
      );
    } finally {
      uninstall();
    }
  });

  await t.step("erro em board_stages lança", async () => {
    const state: MockState = { falhar: new Set(["board_stages"]) };
    const uninstall = installFetchMock(router(state));
    try {
      await esperaErro(
        () => buildDealQualificationContext(newAdminClient(), "deal-1"),
        "estágio do deal",
      );
    } finally {
      uninstall();
    }
  });

  await t.step("erro em contacts lança", async () => {
    const state: MockState = { falhar: new Set(["contacts"]) };
    const uninstall = installFetchMock(router(state));
    try {
      await esperaErro(
        () => buildDealQualificationContext(newAdminClient(), "deal-1"),
        "contato do deal",
      );
    } finally {
      uninstall();
    }
  });

  // Controle positivo: sem ele, um `throw` cedo demais passaria nos 3 testes
  // acima e quebraria a qualificação inteira.
  await t.step("sem erro nenhum, devolve o contexto com goal e critérios", async () => {
    const state: MockState = { falhar: new Set() };
    const uninstall = installFetchMock(router(state));
    try {
      const ctx = await buildDealQualificationContext(newAdminClient(), "deal-1");
      if (ctx.stage.goal !== "Confirmar orçamento e urgência") {
        throw new Error(`esperava o goal do estágio, veio ${ctx.stage.goal}`);
      }
      if (ctx.stage.advancementCriteria.length !== 2) {
        throw new Error(
          `esperava 2 critérios de avanço, veio ${ctx.stage.advancementCriteria.length}`,
        );
      }
    } finally {
      uninstall();
    }
  });
});
