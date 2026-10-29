// Testa reportAIFailure (supabase/functions/_shared/ai/failure-log.ts): nunca
// lança, mesmo quando o INSERT falha (erro retornado pela API ou fetch
// rejeitando), e envia o payload esperado para /rest/v1/ai_failure_logs.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { reportAIFailure } from "../_shared/ai/failure-log.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("reportAIFailure", async (t) => {
  await t.step(
    "caminho feliz: faz POST em /rest/v1/ai_failure_logs com o payload esperado",
    async () => {
      let captured: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
          captured = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await reportAIFailure(admin, {
          tenantId: "tenant-1",
          route: "ai-respond",
          provider: "openai",
          model: "gpt-4o-mini",
          statusCode: 429,
          errorCode: "rate_limited",
          errorMessage: "limite de requisições excedido",
          context: { attempt: 2 },
        });

        if (!captured) throw new Error("nenhum POST capturado em /rest/v1/ai_failure_logs");
        const body = captured as Record<string, unknown>;
        const errs: string[] = [];
        if (body.tenant_id !== "tenant-1") errs.push(`tenant_id=${body.tenant_id}`);
        if (body.route !== "ai-respond") errs.push(`route=${body.route}`);
        if (body.provider !== "openai") errs.push(`provider=${body.provider}`);
        if (body.model !== "gpt-4o-mini") errs.push(`model=${body.model}`);
        if (body.status_code !== 429) errs.push(`status_code=${body.status_code}`);
        if (body.error_code !== "rate_limited") errs.push(`error_code=${body.error_code}`);
        if (body.error_message !== "limite de requisições excedido") {
          errs.push(`error_message=${body.error_message}`);
        }
        if (JSON.stringify(body.context) !== JSON.stringify({ attempt: 2 })) {
          errs.push(`context=${JSON.stringify(body.context)}`);
        }
        if (errs.length > 0) throw new Error(errs.join("; "));
      } finally {
        uninstall();
      }
    },
  );

  await t.step("defaults: campos opcionais omitidos viram null/{} sem lançar", async () => {
    let captured: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
        captured = req.bodyJson as Record<string, unknown>;
        return emptyResponse(201);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      await reportAIFailure(admin, {
        tenantId: "tenant-2",
        route: "ai-insights",
        errorCode: "unknown_error",
        errorMessage: "falha desconhecida",
      });

      if (!captured) throw new Error("nenhum POST capturado");
      const body = captured as Record<string, unknown>;
      if (body.provider !== null) throw new Error(`provider=${body.provider}`);
      if (body.model !== null) throw new Error(`model=${body.model}`);
      if (body.status_code !== null) throw new Error(`status_code=${body.status_code}`);
      if (JSON.stringify(body.context) !== "{}") {
        throw new Error(`context=${JSON.stringify(body.context)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("INSERT retorna erro da API: não lança", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/ai_failure_logs" && req.method === "POST") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      // Não deve lançar mesmo com 500 na resposta.
      await reportAIFailure(admin, {
        tenantId: "tenant-3",
        route: "ai-respond",
        errorCode: "boom_failed",
        errorMessage: "não deveria propagar",
      });
    } finally {
      uninstall();
    }
  });

  await t.step("fetch rejeita (rede/banco fora do ar): não lança", async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (() => {
      throw new Error("network down");
    }) as typeof fetch;
    try {
      const admin = newAdminClient();
      await reportAIFailure(admin, {
        tenantId: "tenant-4",
        route: "ai-respond",
        errorCode: "network_error",
        errorMessage: "não deveria propagar mesmo com fetch quebrado",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
