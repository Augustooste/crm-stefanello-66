import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../ai-response-worker/index.ts");

interface JobRow {
  id: string;
  tenant_id: string;
  payload: { message_id: string };
  attempts: number;
  max_attempts: number;
}

interface State {
  jobs: JobRow[];
  claimCalls: Array<Record<string, unknown>>;
  aiCalls: Array<Record<string, unknown>>;
  jobPatches: Array<Record<string, unknown>>;
  aiStatus: number;
  aiBody: unknown;
  aiThrows: boolean;
}

function defaultState(): State {
  return {
    jobs: [
      {
        id: "job-1",
        tenant_id: "tenant-1",
        payload: { message_id: "message-1" },
        attempts: 1,
        max_attempts: 3,
      },
    ],
    claimCalls: [],
    aiCalls: [],
    jobPatches: [],
    aiStatus: 200,
    aiBody: { ok: true, sent: true },
    aiThrows: false,
  };
}

function router(state: State): FetchMatcher {
  return (req) => {
    if (req.pathname === "/rest/v1/rpc/claim_jobs" && req.method === "POST") {
      state.claimCalls.push(req.bodyJson as Record<string, unknown>);
      const claimed = state.jobs;
      state.jobs = [];
      return jsonResponse(200, claimed);
    }
    if (req.pathname === "/functions/v1/ai-respond" && req.method === "POST") {
      state.aiCalls.push(req.bodyJson as Record<string, unknown>);
      if (req.headers.get("Authorization") !== `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`) {
        throw new Error("worker chamou ai-respond sem service role");
      }
      if (state.aiThrows) throw new Error("network down");
      return jsonResponse(state.aiStatus, state.aiBody);
    }
    if (req.pathname === "/rest/v1/job_queue" && req.method === "PATCH") {
      state.jobPatches.push(req.bodyJson as Record<string, unknown>);
      return emptyResponse(200);
    }
    if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
      return jsonResponse(201, []);
    }
    return undefined;
  };
}

function workerRequest(auth = `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`): Request {
  return new Request("http://fn.local/functions/v1/ai-response-worker", {
    method: "POST",
    headers: { Authorization: auth, "content-type": "application/json" },
    body: JSON.stringify({ limit: 10 }),
  });
}

async function run(state: State): Promise<{ status: number; body: Record<string, unknown> }> {
  const uninstall = installFetchMock(router(state));
  try {
    const response = await handler(workerRequest());
    return {
      status: response.status,
      body: (await response.json()) as Record<string, unknown>,
    };
  } finally {
    uninstall();
  }
}

Deno.test("ai-response-worker", async (t) => {
  await t.step("auth fail-closed", async () => {
    const response = await handler(workerRequest("Bearer errado"));
    if (response.status !== 401) throw new Error(`esperado 401, veio ${response.status}`);
  });

  await t.step("claim_jobs filtra ai_respond e sucesso conclui job", async () => {
    const state = defaultState();
    const { status, body } = await run(state);
    if (status !== 200 || body.succeeded !== 1) throw new Error(JSON.stringify(body));
    if (JSON.stringify(state.claimCalls[0]?.p_job_types) !== JSON.stringify(["ai_respond"])) {
      throw new Error(`filtro de job_type ausente: ${JSON.stringify(state.claimCalls[0])}`);
    }
    if (state.aiCalls.length !== 1) throw new Error(`aiCalls=${state.aiCalls.length}`);
    if (state.jobPatches.at(-1)?.status !== "success") {
      throw new Error(`job não concluído: ${JSON.stringify(state.jobPatches)}`);
    }
  });

  await t.step("erro transitório volta a pending com backoff", async () => {
    const state = defaultState();
    state.aiStatus = 503;
    state.aiBody = { error: "indisponível" };
    const { body } = await run(state);
    if (body.retried !== 1) throw new Error(JSON.stringify(body));
    const patch = state.jobPatches.at(-1);
    if (patch?.status !== "pending" || typeof patch.scheduled_for !== "string") {
      throw new Error(`retry sem backoff: ${JSON.stringify(patch)}`);
    }
  });

  await t.step("teto de tentativas termina failed", async () => {
    const state = defaultState();
    state.jobs[0].attempts = 3;
    state.aiThrows = true;
    const { body } = await run(state);
    if (body.failed !== 1) throw new Error(JSON.stringify(body));
    if (state.jobPatches.at(-1)?.status !== "failed") {
      throw new Error(`job deveria falhar: ${JSON.stringify(state.jobPatches)}`);
    }
  });

  await t.step("resposta retryable 200 não conclui job", async () => {
    const state = defaultState();
    state.aiBody = { ok: false, reason: "message_already_processing" };
    const { body } = await run(state);
    if (body.retried !== 1 || state.jobPatches.at(-1)?.status !== "pending") {
      throw new Error(
        `claim busy foi perdido: ${JSON.stringify({ body, patches: state.jobPatches })}`,
      );
    }
  });

  // Regressão do `12 · H1`: `ai_settings_unavailable` nasceu no fix 05·H2 e as
  // DUAS cópias da lista de razões retryable (webhook e worker) não souberam.
  // Um blip no SELECT de ai_settings marcava o job como sucesso e o lead ficava
  // sem resposta, sem awaiting_human e sem retentativa.
  await t.step("ai_settings_unavailable é retryable, não conclui o job", async () => {
    const state = defaultState();
    state.aiBody = { ok: false, reason: "ai_settings_unavailable" };
    const { body } = await run(state);
    if (body.retried !== 1 || state.jobPatches.at(-1)?.status !== "pending") {
      throw new Error(
        `falha transitória de ai_settings virou sucesso: ${
          JSON.stringify({ body, patches: state.jobPatches })
        }`,
      );
    }
  });

  await t.step("duas execuções concorrentes processam a claim uma vez", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const [first, second] = await Promise.all([
        handler(workerRequest()),
        handler(workerRequest()),
      ]);
      if (first.status !== 200 || second.status !== 200) throw new Error("workers falharam");
      if (state.aiCalls.length !== 1) {
        throw new Error(`job duplicado: aiCalls=${state.aiCalls.length}`);
      }
    } finally {
      uninstall();
    }
  });
});
