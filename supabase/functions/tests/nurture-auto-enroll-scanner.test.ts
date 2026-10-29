// Testa nurture-auto-enroll-scanner: a formatação pura de logic.ts e o fluxo
// I/O de index.ts (auth fail-closed igual a hitl-sla-monitor, chamada da RPC
// enroll_stagnant_and_periodic_nurture via mock de fetch, e a garantia de que
// erro da RPC é logado via console.error — nunca engolido em silêncio).
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import { formatEnrollSummary, parseEnrollCounts } from "../nurture-auto-enroll-scanner/logic.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../nurture-auto-enroll-scanner/index.ts");

function req(opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) {
    headers.set("Authorization", opts.auth ?? `Bearer ${BASE_ENV.SUPABASE_SERVICE_ROLE_KEY}`);
  }
  return new Request("http://fn.local", { method: opts.method ?? "POST", headers });
}

interface RpcState {
  rpcResult?: unknown;
  rpcError?: { message: string };
  /** Eventos que a function gravou em system_events via captureEdgeError. */
  telemetria: Record<string, unknown>[];
}

function router(state: RpcState): FetchMatcher {
  return (r) => {
    if (r.pathname === "/rest/v1/rpc/enroll_stagnant_and_periodic_nurture" && r.method === "POST") {
      if (state.rpcError) return jsonResponse(500, { message: state.rpcError.message });
      return jsonResponse(200, state.rpcResult ?? { stagnant: 0, periodic: 0 });
    }
    // Sem esta rota o INSERT de captureEdgeError falha contra o mock e o
    // próprio sink loga um console.error extra — o que quebraria a asserção
    // de "exatamente 1 console.error" por um motivo que não é o testado.
    // Cobrindo a rota, o teste passa a verificar também QUE o evento foi
    // emitido, não só que a mensagem foi para o console.
    if (r.pathname === "/rest/v1/system_events" && r.method === "POST") {
      state.telemetria.push((r.bodyJson ?? {}) as Record<string, unknown>);
      return jsonResponse(201, {});
    }
    return undefined;
  };
}

/**
 * Captura chamadas de `console.error`/`console.log` sem depender de lib
 * externa de spy — mesmo espírito manual do harness de fetch mock.
 */
function captureConsole(): { errors: unknown[][]; logs: unknown[][]; restore: () => void } {
  const originalError = console.error;
  const originalLog = console.log;
  const errors: unknown[][] = [];
  const logs: unknown[][] = [];
  console.error = (...args: unknown[]) => {
    errors.push(args);
  };
  console.log = (...args: unknown[]) => {
    logs.push(args);
  };
  return {
    errors,
    logs,
    restore: () => {
      console.error = originalError;
      console.log = originalLog;
    },
  };
}

Deno.test("nurture-auto-enroll-scanner/logic.ts", async (t) => {
  await t.step("parseEnrollCounts: extrai stagnant/periodic de um jsonb válido", () => {
    const result = parseEnrollCounts({ stagnant: 3, periodic: 1 });
    if (result.stagnant !== 3 || result.periodic !== 1) {
      throw new Error(`inesperado: ${JSON.stringify(result)}`);
    }
  });

  await t.step("parseEnrollCounts: campos ausentes/inválidos viram 0 (fail-safe de log)", () => {
    const cases: unknown[] = [{}, null, undefined, "string", { stagnant: "3", periodic: NaN }];
    for (const c of cases) {
      const result = parseEnrollCounts(c);
      if (result.stagnant !== 0 || result.periodic !== 0) {
        throw new Error(`esperado {0,0} para ${JSON.stringify(c)}, veio ${JSON.stringify(result)}`);
      }
    }
  });

  await t.step("formatEnrollSummary: formata contagem legível com total", () => {
    const summary = formatEnrollSummary({ stagnant: 3, periodic: 1 });
    if (summary !== "stagnant: 3, periodic: 1 (total: 4)") {
      throw new Error(`inesperado: ${summary}`);
    }
  });

  await t.step("formatEnrollSummary: total zero quando não há enrollments", () => {
    const summary = formatEnrollSummary({ stagnant: 0, periodic: 0 });
    if (summary !== "stagnant: 0, periodic: 0 (total: 0)") {
      throw new Error(`inesperado: ${summary}`);
    }
  });
});

Deno.test("nurture-auto-enroll-scanner/index.ts", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const res = await handler(req({ method: "OPTIONS" }));
    if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
    if (await res.text()) throw new Error("esperado corpo vazio");
  });

  await t.step("método não-POST retorna 405", async () => {
    const res = await handler(req({ method: "GET" }));
    if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
  });

  await t.step("sem Authorization retorna 401", async () => {
    const res = await handler(req({ auth: null }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("bearer diferente do service role retorna 401", async () => {
    const res = await handler(req({ auth: "Bearer errado" }));
    if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
  });

  await t.step("RPC sucesso: responde 200 com counts + summary, sem console.error", async () => {
    const state: RpcState = { rpcResult: { stagnant: 3, periodic: 1 }, telemetria: [] };
    const uninstall = installFetchMock(router(state));
    const console_ = captureConsole();
    try {
      const res = await handler(req());
      const body = await res.json();
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (body.stagnant !== 3 || body.periodic !== 1) {
        throw new Error(`inesperado: ${JSON.stringify(body)}`);
      }
      if (body.summary !== "stagnant: 3, periodic: 1 (total: 4)") {
        throw new Error(`summary inesperado: ${body.summary}`);
      }
      if (console_.errors.length !== 0) {
        throw new Error("não deveria logar console.error em caso de sucesso");
      }
      if (console_.logs.length !== 1) {
        throw new Error("esperado exatamente 1 console.log de resumo");
      }
    } finally {
      console_.restore();
      uninstall();
    }
  });

  await t.step("RPC erro: loga console.error (nunca engole) e responde 500", async () => {
    const state: RpcState = { rpcError: { message: "RPC falhou (simulado)" }, telemetria: [] };
    const uninstall = installFetchMock(router(state));
    const console_ = captureConsole();
    try {
      const res = await handler(req());
      const body = await res.json();
      if (res.status !== 500) throw new Error(`esperado 500, veio ${res.status}`);
      // Body sanitizado: mensagem genérica, NUNCA o error.message cru do
      // Postgres (detalhe fica só no console.error, asserido abaixo).
      if (String(body.error).includes("RPC falhou")) {
        throw new Error(`body vazou detalhe cru do Postgres: ${JSON.stringify(body)}`);
      }
      if (!String(body.error).includes("auto-enrollment")) {
        throw new Error(`mensagem genérica esperada, veio: ${JSON.stringify(body)}`);
      }
      if (console_.errors.length !== 1) {
        throw new Error(`esperado exatamente 1 console.error, veio ${console_.errors.length}`);
      }
      const loggedMessage = console_.errors[0].join(" ");
      if (!loggedMessage.includes("RPC falhou")) {
        throw new Error(`console.error não incluiu a mensagem de erro: ${loggedMessage}`);
      }
      // console.error sozinho não basta: o log do Deno Deploy não é
      // consultável nem correlacionável. O que torna esta falha investigável
      // depois é a linha em system_events.
      if (state.telemetria.length !== 1) {
        throw new Error(
          `esperado exatamente 1 evento em system_events, veio ${state.telemetria.length}`,
        );
      }
      const evento = state.telemetria[0];
      if (evento.operation !== "nurture.auto_enroll_scanner" || evento.severity !== "error") {
        throw new Error(`evento inesperado: ${JSON.stringify(evento)}`);
      }
      if (!String(evento.message).includes("RPC falhou")) {
        throw new Error(`evento não carregou a mensagem original: ${JSON.stringify(evento)}`);
      }
    } finally {
      console_.restore();
      uninstall();
    }
  });
});
