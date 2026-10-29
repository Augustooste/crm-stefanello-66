import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";

import { buildTrainingCallbackUrl, deriveCallbackKey } from "../_shared/agent-platform/callback.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../agent-platform-training-callback/index.ts");

// Fixture, não credencial: valor inventado que só existe dentro deste teste.
// O nome deixa isso explícito para scanner de segredo e para quem lê o diff —
// `SECRET_FIXTURE_DO_TESTE = "..."` cru é a forma que dispara alarme falso.
const SECRET_FIXTURE_DO_TESTE = "valor-inventado-para-teste";
const TENANT = "tenant-1";

interface State {
  writes: Array<Record<string, unknown>>;
  upsertStatus: number;
  upsertError: unknown;
}

function router(state: State): FetchMatcher {
  return (req: MockRequest) => {
    if (req.pathname === "/rest/v1/agent_platform_training_events" && req.method === "POST") {
      if (state.upsertError) return jsonResponse(state.upsertStatus, state.upsertError);
      state.writes.push(req.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }
    if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
      return jsonResponse(201, []);
    }
    return undefined;
  };
}

function callbackRequest(
  key: string,
  body: string,
  opts: { tenant?: string; method?: string } = {},
): Request {
  const tenant = opts.tenant ?? TENANT;
  const url = `http://fn.local/?t=${encodeURIComponent(tenant)}&k=${key}`;
  return new Request(url, {
    method: opts.method ?? "POST",
    headers: { "content-type": "application/json" },
    body: opts.method === "GET" ? undefined : body,
  });
}

async function run(
  state: State,
  key: string,
  body: string,
  opts: { tenant?: string; method?: string } = {},
): Promise<Response> {
  const uninstall = installFetchMock(router(state));
  try {
    return await handler(callbackRequest(key, body, opts));
  } finally {
    uninstall();
  }
}

function state(): State {
  return { writes: [], upsertStatus: 500, upsertError: null };
}

function assertEquals(actual: unknown, expected: unknown, msg: string): void {
  if (actual !== expected) throw new Error(`${msg}: esperado ${expected}, veio ${actual}`);
}

Deno.test("agent-platform-training-callback", async (t) => {
  await t.step("sem segredo configurado responde 404 (rota desabilitada)", async () => {
    Deno.env.delete("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET");
    const res = await run(state(), "qualquer", "{}");
    assertEquals(res.status, 404, "status");
  });

  Deno.env.set("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET", SECRET_FIXTURE_DO_TESTE);

  await t.step("chave ausente responde 401", async () => {
    const uninstall = installFetchMock(router(state()));
    try {
      const res = await handler(
        new Request("http://fn.local/?t=tenant-1", { method: "POST", body: "{}" }),
      );
      assertEquals(res.status, 401, "status");
    } finally {
      uninstall();
    }
  });

  await t.step("chave errada responde 401 e não grava nada", async () => {
    const s = state();
    const res = await run(s, "f".repeat(64), "{}");
    assertEquals(res.status, 401, "status");
    assertEquals(s.writes.length, 0, "nenhuma escrita");
  });

  await t.step("chave de outro tenant não vale para este", async () => {
    const outroTenant = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, "tenant-2");
    const s = state();
    const res = await run(s, outroTenant, "{}");
    assertEquals(res.status, 401, "status");
    assertEquals(s.writes.length, 0, "nenhuma escrita");
  });

  await t.step("método não-POST responde 405", async () => {
    const key = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    const res = await run(state(), key, "", { method: "GET" });
    assertEquals(res.status, 405, "status");
  });

  await t.step("callback de sucesso grava evento com status success", async () => {
    const key = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    const s = state();
    const res = await run(
      s,
      key,
      JSON.stringify({ status: "success", trainingId: "tr-1", agentId: "ag-1" }),
    );
    assertEquals(res.status, 200, "status");
    const row = s.writes[0];
    assertEquals(row.tenant_id, TENANT, "tenant");
    assertEquals(row.status, "success", "status do evento");
    assertEquals(row.platform_training_id, "tr-1", "training id");
    assertEquals(row.platform_agent_id, "ag-1", "agent id");
    assertEquals(typeof row.dedupe_key === "string" && row.dedupe_key.length === 64, true, "hash");
  });

  await t.step("callback de erro grava status error com mensagem", async () => {
    const key = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    const s = state();
    await run(s, key, JSON.stringify({ error: "site fora do ar", trainingId: "tr-2" }));
    assertEquals(s.writes[0].status, "error", "status do evento");
    assertEquals(s.writes[0].message, "site fora do ar", "mensagem");
  });

  await t.step("payload de formato desconhecido não quebra: status unknown", async () => {
    const key = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    const s = state();
    const res = await run(s, key, "isto não é json");
    assertEquals(res.status, 200, "status");
    assertEquals(s.writes[0].status, "unknown", "status do evento");
  });

  await t.step("reenvio idêntico gera a MESMA dedupe_key (idempotente)", async () => {
    const key = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    const body = JSON.stringify({ status: "success", trainingId: "tr-3" });
    const s = state();
    await run(s, key, body);
    await run(s, key, body);
    assertEquals(s.writes.length, 2, "duas chamadas");
    assertEquals(s.writes[0].dedupe_key, s.writes[1].dedupe_key, "mesma chave de dedupe");
  });

  await t.step("falha de escrita responde 500 para o provedor retentar", async () => {
    const key = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    const s = state();
    s.upsertError = { message: "db down" };
    const res = await run(s, key, JSON.stringify({ status: "success" }));
    assertEquals(res.status, 500, "status");
  });

  await t.step("URL assinada tem o formato esperado", async () => {
    const url = await buildTrainingCallbackUrl(
      BASE_ENV.SUPABASE_URL,
      SECRET_FIXTURE_DO_TESTE,
      TENANT,
    );
    const expectedKey = await deriveCallbackKey(SECRET_FIXTURE_DO_TESTE, TENANT);
    assertEquals(
      url,
      `${BASE_ENV.SUPABASE_URL}/functions/v1/agent-platform-training-callback?t=${TENANT}&k=${expectedKey}`,
      "url",
    );
  });

  await t.step("sem segredo, buildTrainingCallbackUrl devolve null", async () => {
    const url = await buildTrainingCallbackUrl(BASE_ENV.SUPABASE_URL, "  ", TENANT);
    assertEquals(url, null, "url");
  });
});
