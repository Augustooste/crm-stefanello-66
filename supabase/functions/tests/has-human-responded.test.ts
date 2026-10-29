// Testa hasHumanResponded (supabase/functions/_shared/ai/has-human-responded.ts):
// true quando existe mensagem sender='agent' na conversa, false quando não
// existe, e fail-closed (true) quando a query falha.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { hasHumanResponded } from "../_shared/ai/has-human-responded.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("hasHumanResponded", async (t) => {
  await t.step("humano respondeu (existe mensagem sender='agent'): retorna true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        const url = new URL(req.url);
        if (
          url.searchParams.get("conversation_id") === "eq.conv-1" &&
          url.searchParams.get("sender") === "eq.agent"
        ) {
          return jsonResponse(200, { id: "msg-1" });
        }
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await hasHumanResponded(admin, "conv-1");
      if (result !== true) throw new Error(`esperado true, recebido ${result}`);
    } finally {
      uninstall();
    }
  });

  await t.step("ninguém respondeu (nenhuma mensagem sender='agent'): retorna false", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(200, null);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await hasHumanResponded(admin, "conv-2");
      if (result !== false) throw new Error(`esperado false, recebido ${result}`);
    } finally {
      uninstall();
    }
  });

  await t.step("erro de query: fail-closed, retorna true", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/messages" && req.method === "GET") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await hasHumanResponded(admin, "conv-3");
      if (result !== true) throw new Error(`esperado true (fail-closed), recebido ${result}`);
    } finally {
      uninstall();
    }
  });
});
