// Testa evaluateTakeoverGate (supabase/functions/_shared/ai/takeover-gate.ts):
// operador ativo bloqueia, humano já respondeu bloqueia (mesmo com operador
// inativo), e nenhum dos dois libera o takeover.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { evaluateTakeoverGate } from "../_shared/ai/takeover-gate.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("evaluateTakeoverGate", async (t) => {
  await t.step(
    "operador ativo (lastOperatorMessageAt recente): allowed=false, reason=operator_active",
    async () => {
      const admin = newAdminClient();
      const recente = new Date(Date.now() - 2 * 60_000).toISOString(); // 2min atrás
      const result = await evaluateTakeoverGate(admin, "conv-1", null, 15, recente);
      if (result.allowed !== false || result.reason !== "operator_active") {
        throw new Error(
          `esperado {allowed:false,reason:operator_active}, recebido ${JSON.stringify(result)}`,
        );
      }
    },
  );

  await t.step(
    "operador inativo mas humano já respondeu: allowed=false, reason=human_responded",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          const url = new URL(req.url);
          if (url.searchParams.get("sender") === "eq.agent") {
            return jsonResponse(200, { id: "msg-1" });
          }
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const antigo = new Date(Date.now() - 60 * 60_000).toISOString(); // 60min atrás
        const result = await evaluateTakeoverGate(admin, "conv-2", null, 15, antigo);
        if (result.allowed !== false || result.reason !== "human_responded") {
          throw new Error(
            `esperado {allowed:false,reason:human_responded}, recebido ${JSON.stringify(result)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("operador inativo e ninguém respondeu: allowed=true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(200, null);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const antigo = new Date(Date.now() - 60 * 60_000).toISOString(); // 60min atrás
      const result = await evaluateTakeoverGate(admin, "conv-3", null, 15, antigo);
      if (result.allowed !== true) {
        throw new Error(`esperado {allowed:true}, recebido ${JSON.stringify(result)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "erro de query ao checar humano (fail-closed): allowed=false, reason=human_responded",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          return jsonResponse(500, { message: "db indisponível" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const antigo = new Date(Date.now() - 60 * 60_000).toISOString();
        const result = await evaluateTakeoverGate(admin, "conv-4", null, 15, antigo);
        if (result.allowed !== false || result.reason !== "human_responded") {
          throw new Error(
            `esperado {allowed:false,reason:human_responded} (fail-closed), recebido ${
              JSON.stringify(result)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro de query ao checar operador (fail-safe): allowed=false, reason=operator_active",
    async () => {
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          const url = new URL(req.url);
          if (url.searchParams.get("select") === "created_at") {
            return jsonResponse(500, { message: "db indisponível" });
          }
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const result = await evaluateTakeoverGate(admin, "conv-6", null, 15);
        if (result.allowed !== false || result.reason !== "operator_active") {
          throw new Error(
            `esperado {allowed:false,reason:operator_active} (fail-safe), recebido ${
              JSON.stringify(result)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "sem lastOperatorMessageAt (query própria): usa última mensagem sender='agent' para decidir inatividade",
    async () => {
      const recente = new Date(Date.now() - 2 * 60_000).toISOString();
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          const url = new URL(req.url);
          const selectParam = url.searchParams.get("select");
          if (selectParam === "created_at") {
            return jsonResponse(200, { created_at: recente });
          }
          // segunda query: hasHumanResponded (select=id) — não deveria nem
          // ser chamada, pois o operador está ativo (retorno antecipado).
          return jsonResponse(200, null);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const result = await evaluateTakeoverGate(admin, "conv-5", null, 15);
        if (result.allowed !== false || result.reason !== "operator_active") {
          throw new Error(
            `esperado {allowed:false,reason:operator_active}, recebido ${JSON.stringify(result)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "humano respondeu ANTES da reativação explícita da IA: allowed=true",
    async () => {
      const resumedAt = new Date(Date.now() - 10 * 60_000).toISOString();
      let gtFilter: string | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          const url = new URL(req.url);
          gtFilter = url.searchParams.get("created_at");
          // Servidor filtra por created_at>resumedAt: nenhuma resposta humana
          // posterior à reativação → nada retorna.
          return jsonResponse(200, null);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const result = await evaluateTakeoverGate(
          admin,
          "conv-resumed",
          null,
          15,
          undefined,
          resumedAt,
        );
        if (result.allowed !== true) {
          throw new Error(`esperado {allowed:true}, recebido ${JSON.stringify(result)}`);
        }
        if (gtFilter !== `gt.${resumedAt}`) {
          throw new Error(`corte de reativação não foi aplicado na query: ${gtFilter}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "humano respondeu DEPOIS da reativação: continua bloqueado (human_responded)",
    async () => {
      const resumedAt = new Date(Date.now() - 60 * 60_000).toISOString();
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
          const url = new URL(req.url);
          if (url.searchParams.get("select") === "created_at") {
            // Última mensagem do atendente: antiga o bastante para o operador
            // não contar como ativo, mas posterior à reativação.
            return jsonResponse(200, {
              created_at: new Date(Date.now() - 40 * 60_000).toISOString(),
            });
          }
          return jsonResponse(200, { id: "msg-agent" });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const result = await evaluateTakeoverGate(
          admin,
          "conv-resumed-2",
          null,
          15,
          undefined,
          resumedAt,
        );
        if (result.allowed !== false || result.reason !== "human_responded") {
          throw new Error(
            `esperado {allowed:false,reason:human_responded}, recebido ${JSON.stringify(result)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );
});
