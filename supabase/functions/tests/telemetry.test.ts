// Testa captureEdgeError (supabase/functions/_shared/telemetry.ts): nunca
// lança, mesmo quando o INSERT falha (erro retornado pela API ou fetch
// rejeitando), e envia o payload esperado para /rest/v1/system_events.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import {
  BASE_ENV,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";

setEnv(BASE_ENV);

function newAdminClient() {
  return createClient(BASE_ENV.SUPABASE_URL, BASE_ENV.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

Deno.test("captureEdgeError", async (t) => {
  await t.step(
    "caminho feliz: faz POST em /rest/v1/system_events com o payload esperado",
    async () => {
      let captured: Record<string, unknown> | null = null;
      const router: FetchMatcher = (req) => {
        if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
          captured = req.bodyJson as Record<string, unknown>;
          return emptyResponse(201);
        }
        return undefined;
      };
      const uninstall = installFetchMock(router);
      try {
        const admin = newAdminClient();
        await captureEdgeError(admin, {
          severity: "error",
          source: "edge",
          operation: "test.op",
          tenantId: "tenant-1",
          conversationId: "conv-1",
          dealId: null,
          correlationId: "corr-1",
          errorCode: "boom_failed",
          message: "algo quebrou",
          stack: "Error: algo quebrou\n at x",
          context: { foo: "bar" },
        });

        if (!captured) throw new Error("nenhum POST capturado em /rest/v1/system_events");
        const body = captured as Record<string, unknown>;
        const errs: string[] = [];
        if (body.severity !== "error") errs.push(`severity=${body.severity}`);
        if (body.source !== "edge") errs.push(`source=${body.source}`);
        if (body.operation !== "test.op") errs.push(`operation=${body.operation}`);
        if (body.tenant_id !== "tenant-1") errs.push(`tenant_id=${body.tenant_id}`);
        if (body.conversation_id !== "conv-1") errs.push(`conversation_id=${body.conversation_id}`);
        if (body.deal_id !== null) errs.push(`deal_id=${body.deal_id}`);
        if (body.correlation_id !== "corr-1") errs.push(`correlation_id=${body.correlation_id}`);
        if (body.error_code !== "boom_failed") errs.push(`error_code=${body.error_code}`);
        if (body.message !== "algo quebrou") errs.push(`message=${body.message}`);
        if (errs.length > 0) throw new Error(errs.join("; "));
      } finally {
        uninstall();
      }
    },
  );

  await t.step("defaults: campos opcionais omitidos viram null/{} sem lançar", async () => {
    let captured: Record<string, unknown> | null = null;
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
        captured = req.bodyJson as Record<string, unknown>;
        return emptyResponse(201);
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      await captureEdgeError(admin, {
        severity: "warn",
        source: "edge",
        operation: "test.op.minimal",
        message: "aviso simples",
      });

      if (!captured) throw new Error("nenhum POST capturado");
      const body = captured as Record<string, unknown>;
      if (body.tenant_id !== null) throw new Error(`tenant_id=${body.tenant_id}`);
      if (body.conversation_id !== null) throw new Error(`conversation_id=${body.conversation_id}`);
      if (body.deal_id !== null) throw new Error(`deal_id=${body.deal_id}`);
      if (body.correlation_id !== null) throw new Error(`correlation_id=${body.correlation_id}`);
      if (body.error_code !== null) throw new Error(`error_code=${body.error_code}`);
      if (body.stack !== null) throw new Error(`stack=${body.stack}`);
      if (JSON.stringify(body.context) !== "{}") {
        throw new Error(`context=${JSON.stringify(body.context)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("INSERT retorna erro da API: não lança", async () => {
    const router: FetchMatcher = (req) => {
      if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
        return jsonResponse(500, { message: "db indisponível" });
      }
      return undefined;
    };
    const uninstall = installFetchMock(router);
    try {
      const admin = newAdminClient();
      // Não deve lançar mesmo com 500 na resposta.
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "test.op.fail",
        message: "não deveria propagar",
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
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "test.op.network",
        message: "não deveria propagar mesmo com fetch quebrado",
      });
    } finally {
      globalThis.fetch = original;
    }
  });
});
