// Testa checkRateLimit (supabase/functions/_shared/ai/rate-limiter.ts):
// wrapper fino sobre a RPC check_and_record_rate_limit. Casos: allowed=true
// passa, allowed=false retorna retryAfterMs correto, erro de RPC nega
// (política fail-closed documentada no arquivo).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { BASE_ENV, type FetchMatcher, installFetchMock, jsonResponse, setEnv } from "./_helpers.ts";
import { checkRateLimit } from "../_shared/ai/rate-limiter.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

const RPC_PATH = "/rest/v1/rpc/check_and_record_rate_limit";

Deno.test("checkRateLimit", async (t) => {
  await t.step(
    "allowed=true: chama a RPC com p_key/p_max_calls/p_window_seconds corretos e passa",
    async () => {
      let captured: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === RPC_PATH && req.method === "POST") {
          captured = req.bodyJson as Record<string, unknown>;
          return jsonResponse(200, { allowed: true, retryAfterSeconds: 0 });
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        const result = await checkRateLimit(admin, "conv-1", 5, 60_000);

        if (result.allowed !== true) throw new Error(`allowed=${result.allowed}`);
        if (result.retryAfterMs !== undefined) {
          throw new Error(`retryAfterMs=${result.retryAfterMs}`);
        }

        if (!captured) throw new Error("nenhum POST capturado na RPC");
        const body = captured as Record<string, unknown>;
        if (body.p_key !== "ai-agent:conv-1") throw new Error(`p_key=${body.p_key}`);
        if (body.p_max_calls !== 5) throw new Error(`p_max_calls=${body.p_max_calls}`);
        if (body.p_window_seconds !== 60) {
          throw new Error(`p_window_seconds=${body.p_window_seconds}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("allowed=false: converte retryAfterSeconds da RPC em retryAfterMs", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === RPC_PATH && req.method === "POST") {
        return jsonResponse(200, { allowed: false, retryAfterSeconds: 12 });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await checkRateLimit(admin, "conv-2", 5, 60_000);

      if (result.allowed !== false) throw new Error(`allowed=${result.allowed}`);
      if (result.retryAfterMs !== 12_000) throw new Error(`retryAfterMs=${result.retryAfterMs}`);
      if (result.rpcFailed !== undefined) {
        throw new Error(
          `rpcFailed=${result.rpcFailed}, esperado undefined (rate-limit legítimo, não falha de RPC)`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step("erro de RPC: nega por segurança (fail-closed), não lança", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === RPC_PATH && req.method === "POST") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      const result = await checkRateLimit(admin, "conv-3", 5, 60_000);

      if (result.allowed !== false) {
        throw new Error(`allowed=${result.allowed}, esperado false (fail-closed)`);
      }
      if (result.retryAfterMs !== 60_000) throw new Error(`retryAfterMs=${result.retryAfterMs}`);
      if (result.rpcFailed !== true) {
        throw new Error(
          `rpcFailed=${result.rpcFailed}, esperado true (falha de RPC, não rate-limit legítimo)`,
        );
      }
    } finally {
      uninstall();
    }
  });

  await t.step("usa defaults (maxCalls=5, windowMs=60000) quando não informados", async () => {
    let captured: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === RPC_PATH && req.method === "POST") {
        captured = req.bodyJson as Record<string, unknown>;
        return jsonResponse(200, { allowed: true, retryAfterSeconds: 0 });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      await checkRateLimit(admin, "conv-4");

      if (!captured) throw new Error("nenhum POST capturado na RPC");
      const body = captured as Record<string, unknown>;
      if (body.p_max_calls !== 5) throw new Error(`p_max_calls=${body.p_max_calls}`);
      if (body.p_window_seconds !== 60) {
        throw new Error(`p_window_seconds=${body.p_window_seconds}`);
      }
    } finally {
      uninstall();
    }
  });
});
