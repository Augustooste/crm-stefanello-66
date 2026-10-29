// Contrato entre supabase/config.toml e o comportamento REAL dos handlers.
//
// `verify_jwt = false` no config.toml significa "o gateway deixa passar sem
// token" — nunca "qualquer um pode executar". Toda function nessa condição
// precisa autorizar por conta própria dentro do handler. Este teste lê o
// config.toml (fonte da verdade, e arquivo que o Supabase regrava em
// reconexão) e prova, por function, que a porta está fechada.
//
// A guarda no fim reprova o cenário que motivou o arquivo: alguém acrescenta
// um bloco `verify_jwt = false` novo e ninguém escreve o teste de autorização.
import {
  BASE_ENV,
  captureHandler,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";
import { deriveCallbackKey } from "../_shared/agent-platform/callback.ts";

setEnv(BASE_ENV);
Deno.env.set("AGENT_PLATFORM_API_BASE_URL", "https://provider.test");

const SERVICE_ROLE = BASE_ENV.SUPABASE_SERVICE_ROLE_KEY;
const CALLBACK_SECRET_FIXTURE = "segredo-inventado-do-contrato";
const TENANT = "tenant-1";

// ---------------------------------------------------------------- config.toml

interface BlocoFunction {
  nome: string;
  verifyJwt: boolean | null;
}

function lerBlocos(toml: string): BlocoFunction[] {
  const blocos: BlocoFunction[] = [];
  let atual: BlocoFunction | null = null;
  for (const linha of toml.split("\n")) {
    const semComentario = linha.replace(/#.*$/, "");
    const cabecalho = semComentario.match(/^\s*\[([^\]]+)\]\s*$/);
    if (cabecalho) {
      const secao = cabecalho[1].trim();
      if (secao.startsWith("functions.")) {
        atual = { nome: secao.slice("functions.".length), verifyJwt: null };
        blocos.push(atual);
      } else {
        atual = null;
      }
      continue;
    }
    if (!atual) continue;
    const flag = semComentario.match(/^\s*verify_jwt\s*=\s*(true|false)\s*$/);
    if (flag) atual.verifyJwt = flag[1] === "true";
  }
  return blocos;
}

const CONFIG = await Deno.readTextFile(
  new URL("../../config.toml", import.meta.url),
);
const BLOCOS = lerBlocos(CONFIG);

function flagDe(nome: string): boolean | null {
  return BLOCOS.find((b) => b.nome === nome)?.verifyJwt ?? null;
}

function assertEquals(atual: unknown, esperado: unknown, msg: string): void {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${esperado}, veio ${atual}`);
}

/** Router permissivo: qualquer escrita no PostgREST responde OK. O que este
 * arquivo mede é a porta de entrada, não a persistência. */
function routerPermissivo(registro: string[]): FetchMatcher {
  return (req: MockRequest) => {
    registro.push(`${req.method} ${req.pathname}`);
    if (req.pathname.startsWith("/rest/v1/rpc/")) return jsonResponse(200, []);
    if (req.pathname.startsWith("/rest/v1/")) return jsonResponse(200, []);
    if (req.pathname.startsWith("/auth/v1/")) return jsonResponse(401, { message: "invalid" });
    return jsonResponse(200, {});
  };
}

async function comMock<T>(fn: (registro: string[]) => T | Promise<T>): Promise<T> {
  const registro: string[] = [];
  const uninstall = installFetchMock(routerPermissivo(registro));
  try {
    return await fn(registro);
  } finally {
    uninstall();
  }
}

// -------------------------------------------- functions com verify_jwt = false

const COBERTAS_SEM_JWT = new Set([
  "domain-event-dispatcher",
  "contact-enrichment-dispatcher",
  "agent-platform-training-callback",
  "pipeline-agent",
  "voice-call-webhook",
  "public-api",
  "webhook-delivery-worker",
  "inbound-webhook",
]);

Deno.test("config.toml declara verify_jwt em todo bloco de function", () => {
  const semFlag = BLOCOS.filter((b) => b.verifyJwt === null).map((b) => b.nome);
  assertEquals(semFlag.join(","), "", "blocos sem verify_jwt");
  if (BLOCOS.length === 0) throw new Error("nenhum bloco [functions.*] encontrado");
});

Deno.test("domain-event-dispatcher: verify_jwt=false, autoriza por service role", async (t) => {
  assertEquals(flagDe("domain-event-dispatcher"), false, "flag no config.toml");
  const handler = await captureHandler("../domain-event-dispatcher/index.ts");

  await t.step("sem Authorization responde 401", async () => {
    const res = await comMock(() =>
      handler(new Request("http://fn.local/", { method: "POST", body: "{}" }))
    );
    assertEquals(res.status, 401, "status");
  });

  await t.step("bearer diferente do service role responde 401", async () => {
    const res = await comMock(() =>
      handler(
        new Request("http://fn.local/", {
          method: "POST",
          headers: { authorization: "Bearer token-de-usuario" },
          body: "{}",
        }),
      )
    );
    assertEquals(res.status, 401, "status");
  });

  await t.step("bearer do service role é aceito", async () => {
    const res = await comMock(() =>
      handler(
        new Request("http://fn.local/", {
          method: "POST",
          headers: { authorization: `Bearer ${SERVICE_ROLE}` },
          body: "{}",
        }),
      )
    );
    assertEquals(res.status, 200, "status");
  });

  await t.step("preflight OPTIONS não exige credencial", async () => {
    const res = await comMock(() => handler(new Request("http://fn.local/", { method: "OPTIONS" })));
    assertEquals(res.status, 200, "status");
  });

  await t.step("método não-POST responde 405 antes de qualquer trabalho", async () => {
    const res = await comMock(async (registro) => {
      const r = await handler(new Request("http://fn.local/", { method: "GET" }));
      assertEquals(registro.length, 0, "nenhuma chamada de rede");
      return r;
    });
    assertEquals(res.status, 405, "status");
  });
});

Deno.test("contact-enrichment-dispatcher: verify_jwt=false, autoriza somente por service role", async (t) => {
  assertEquals(flagDe("contact-enrichment-dispatcher"), false, "flag no config.toml");
  const handler = await captureHandler("../contact-enrichment-dispatcher/index.ts");
  const recusados = [
    { nome: "sem Authorization", authorization: null },
    { nome: "bearer de usuário", authorization: "Bearer token-de-usuario" },
    { nome: "bearer anon", authorization: `Bearer ${BASE_ENV.SUPABASE_ANON_KEY}` },
    { nome: "service role incorreto", authorization: `Bearer ${SERVICE_ROLE}-incorreto` },
  ];

  for (const { nome, authorization } of recusados) {
    await t.step(`${nome} responde 401 sem executar o worker`, async () => {
      await comMock(async (registro) => {
        const headers = new Headers();
        if (authorization) headers.set("authorization", authorization);
        const res = await handler(
          new Request("http://fn.local/", { method: "POST", headers, body: "{}" }),
        );
        assertEquals(res.status, 401, "status");
        assertEquals(registro.length, 0, "nenhuma chamada de rede");
      });
    });
  }

  await t.step("service role correto atravessa a guarda e executa o lote vazio", async () => {
    const registro: string[] = [];
    const router = routerPermissivo(registro);
    const uninstall = installFetchMock((req) => {
      // Sem contato elegível, a RPC retorna null, não um array de registros.
      if (req.pathname === "/rest/v1/rpc/claim_contact_enrichment") {
        registro.push(`${req.method} ${req.pathname}`);
        return jsonResponse(200, null);
      }
      return router(req);
    });
    try {
      const res = await handler(
        new Request("http://fn.local/", {
          method: "POST",
          headers: { authorization: `Bearer ${SERVICE_ROLE}` },
          body: "{}",
        }),
      );
      assertEquals(res.status, 200, "status");
      assertEquals(
        registro.includes("POST /rest/v1/rpc/claim_contact_enrichment"),
        true,
        "worker alcançou o claim protegido",
      );
      assertEquals((await res.json()).processed, 0, "nenhum contato no lote");
    } finally {
      uninstall();
    }
  });
});

Deno.test("pipeline-agent: verify_jwt=false, autoriza por service role", async (t) => {
  assertEquals(flagDe("pipeline-agent"), false, "flag no config.toml");
  const handler = await captureHandler("../pipeline-agent/index.ts");

  await t.step("sem Authorization responde 401", async () => {
    const res = await comMock(() =>
      handler(new Request("http://fn.local/", { method: "POST", body: "{}" }))
    );
    assertEquals(res.status, 401, "status");
  });

  await t.step("bearer inválido responde 401", async () => {
    const res = await comMock(() =>
      handler(
        new Request("http://fn.local/", {
          method: "POST",
          headers: { authorization: "Bearer anon-key" },
          body: "{}",
        }),
      )
    );
    assertEquals(res.status, 401, "status");
  });

  await t.step("método não-POST responde 405", async () => {
    const res = await comMock(() => handler(new Request("http://fn.local/", { method: "GET" })));
    assertEquals(res.status, 405, "status");
  });
});

Deno.test("agent-platform-training-callback: verify_jwt=false, autoriza por chave do tenant", async (t) => {
  assertEquals(flagDe("agent-platform-training-callback"), false, "flag no config.toml");
  Deno.env.set("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET", CALLBACK_SECRET_FIXTURE);
  const handler = await captureHandler("../agent-platform-training-callback/index.ts");
  const chaveValida = await deriveCallbackKey(CALLBACK_SECRET_FIXTURE, TENANT);

  const chamar = (query: string) =>
    comMock(() =>
      handler(
        new Request(`http://fn.local/${query}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ status: "success" }),
        }),
      )
    );

  await t.step("sem chave na URL responde 401", async () => {
    assertEquals((await chamar(`?t=${TENANT}`)).status, 401, "status");
  });

  await t.step("chave de outro tenant não vale para este", async () => {
    const chaveOutro = await deriveCallbackKey(CALLBACK_SECRET_FIXTURE, "tenant-2");
    assertEquals((await chamar(`?t=${TENANT}&k=${chaveOutro}`)).status, 401, "status");
  });

  await t.step("chave correta é aceita", async () => {
    assertEquals((await chamar(`?t=${TENANT}&k=${chaveValida}`)).status, 200, "status");
  });

  await t.step("segredo ausente desabilita a rota (404), não abre", async () => {
    Deno.env.delete("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET");
    assertEquals((await chamar(`?t=${TENANT}&k=${chaveValida}`)).status, 404, "status");
    Deno.env.set("AGENT_PLATFORM_TRAINING_CALLBACK_SECRET", CALLBACK_SECRET_FIXTURE);
  });
});

Deno.test("voice-call-webhook: verify_jwt=false, autoriza por assinatura HMAC do tenant", async (t) => {
  assertEquals(flagDe("voice-call-webhook"), false, "flag no config.toml");
  const { signPayload, SIGNATURE_HEADER, TENANT_HEADER, TIMESTAMP_HEADER } = await import(
    "../_shared/voice/contract.ts"
  );
  const secret = "segredo-voz-contrato";
  const tenant = "11111111-1111-4111-8111-111111111111";
  const body = "{}";
  Deno.env.set("VOICE_SERVICE_SECRET", secret);
  const handler = await captureHandler("../voice-call-webhook/index.ts");
  const ts = String(Math.floor(Date.now() / 1000));
  const chamar = (headers: Record<string, string>) =>
    comMock(() => handler(new Request("http://fn.local/", { method: "POST", headers, body })));

  await t.step("sem assinatura responde 401", async () => {
    assertEquals((await chamar({ [TIMESTAMP_HEADER]: ts, [TENANT_HEADER]: tenant })).status, 401, "status");
  });

  await t.step("assinatura de outro tenant não vale para este", async () => {
    const outro = "22222222-2222-4222-8222-222222222222";
    const sig = await signPayload(secret, outro, ts, body);
    const res = await chamar({ [TIMESTAMP_HEADER]: ts, [TENANT_HEADER]: tenant, [SIGNATURE_HEADER]: sig });
    assertEquals(res.status, 401, "status");
  });

  await t.step("assinatura válida passa da autorização (corpo vazio vira 400, não 401)", async () => {
    const sig = await signPayload(secret, tenant, ts, body);
    const res = await chamar({ [TIMESTAMP_HEADER]: ts, [TENANT_HEADER]: tenant, [SIGNATURE_HEADER]: sig });
    assertEquals(res.status, 400, "status");
  });

  await t.step("segredo ausente desabilita a rota (404), não abre", async () => {
    Deno.env.delete("VOICE_SERVICE_SECRET");
    const sig = await signPayload(secret, tenant, ts, body);
    const res = await chamar({ [TIMESTAMP_HEADER]: ts, [TENANT_HEADER]: tenant, [SIGNATURE_HEADER]: sig });
    assertEquals(res.status, 404, "status");
  });
});

Deno.test("public-api: verify_jwt=false, autoriza por X-Api-Key validada no banco", async (t) => {
  assertEquals(flagDe("public-api"), false, "flag no config.toml");
  const handler = await captureHandler("../public-api/index.ts");
  const chamar = (path: string, headers: Record<string, string>) =>
    comMock(async (registro) => {
      const res = await handler(
        new Request(`http://fn.local/functions/v1/public-api${path}`, { headers }),
      );
      return { status: res.status, registro };
    });

  await t.step("sem X-Api-Key responde 401 sem tocar no banco", async () => {
    const { status, registro } = await chamar("/v1/me", {});
    assertEquals(status, 401, "status");
    assertEquals(registro.length, 0, "nenhuma chamada de rede");
  });

  await t.step("JWT anon no Authorization não substitui a chave (401)", async () => {
    const { status } = await chamar("/v1/me", { authorization: `Bearer ${BASE_ENV.SUPABASE_ANON_KEY}` });
    assertEquals(status, 401, "status");
  });

  // Chave desconhecida ou revogada (RPC authenticate_api_key vazia) é coberta em
  // public-api-auth.test.ts com banco injetado: o client deste index.ts nasce no
  // import e guarda o fetch real, então o mock deste arquivo não o alcança.

  await t.step("spec pública responde sem chave e sem banco", async () => {
    const { status, registro } = await chamar("/v1/openapi.json", {});
    assertEquals(status, 200, "status");
    assertEquals(registro.length, 0, "nenhuma chamada de rede");
  });
});

Deno.test("webhook-delivery-worker: verify_jwt=false, autoriza somente por service role", async (t) => {
  assertEquals(flagDe("webhook-delivery-worker"), false, "flag no config.toml");
  const handler = await captureHandler("../webhook-delivery-worker/index.ts");
  const recusados = [
    { nome: "sem Authorization", authorization: null },
    { nome: "bearer anon", authorization: `Bearer ${BASE_ENV.SUPABASE_ANON_KEY}` },
    { nome: "service role incorreto", authorization: `Bearer ${SERVICE_ROLE}-incorreto` },
  ];

  for (const { nome, authorization } of recusados) {
    await t.step(`${nome} responde 401 sem reivindicar entregas`, async () => {
      await comMock(async (registro) => {
        const headers = new Headers();
        if (authorization) headers.set("authorization", authorization);
        const res = await handler(new Request("http://fn.local/", { method: "POST", headers }));
        assertEquals(res.status, 401, "status");
        assertEquals(registro.length, 0, "nenhuma chamada de rede");
      });
    });
  }

  await t.step("service role correto chega ao claim e processa lote vazio", async () => {
    await comMock(async (registro) => {
      const res = await handler(
        new Request("http://fn.local/", {
          method: "POST",
          headers: { authorization: `Bearer ${SERVICE_ROLE}` },
        }),
      );
      assertEquals(res.status, 200, "status");
      assertEquals(registro.includes("POST /rest/v1/rpc/claim_webhook_deliveries"), true, "claim");
    });
  });

  await t.step("método não-POST responde 405", async () => {
    const res = await comMock(() => handler(new Request("http://fn.local/", { method: "GET" })));
    assertEquals(res.status, 405, "status");
  });
});

Deno.test("inbound-webhook: verify_jwt=false, autoriza por assinatura/token da regra", async (t) => {
  assertEquals(flagDe("inbound-webhook"), false, "flag no config.toml");
  const handler = await captureHandler("../inbound-webhook/index.ts");
  const RULE = "11111111-0000-4000-8000-000000000001";
  const post = (path: string, headers: Record<string, string> = {}) =>
    comMock(async (registro) => {
      const res = await handler(
        new Request(`http://fn.local/functions/v1/inbound-webhook/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ id: "evt_1" }),
        }),
      );
      return { status: res.status, body: await res.text(), registro };
    });

  await t.step("rule_id que não é uuid responde 401 sem tocar no banco", async () => {
    const { status, body, registro } = await post("nao-e-uuid");
    assertEquals(status, 401, "status");
    assertEquals(body, '{"error":"unauthorized"}', "corpo");
    assertEquals(registro.length, 0, "nenhuma chamada de rede");
  });

  await t.step("regra inexistente sem assinatura: 401 e nada além da leitura da regra", async () => {
    const { status, body, registro } = await post(RULE);
    assertEquals(status, 401, "status");
    assertEquals(body, '{"error":"unauthorized"}', "corpo");
    assertEquals(registro.join(","), "POST /rest/v1/rpc/get_inbound_rule_auth", "chamadas");
  });

  await t.step("JWT service role no Authorization não substitui a assinatura (401)", async () => {
    const { status, registro } = await post(RULE, { authorization: `Bearer ${SERVICE_ROLE}` });
    assertEquals(status, 401, "status");
    assertEquals(registro.some((c) => c.includes("process_inbound_event")), false, "sem processamento");
  });

  await t.step("método não-POST responde 405", async () => {
    const res = await comMock(() => handler(new Request(`http://fn.local/inbound-webhook/${RULE}`)));
    assertEquals(res.status, 405, "status");
  });
});

Deno.test("agent-platform-proxy: verify_jwt=true e o handler revalida o token", async (t) => {
  assertEquals(flagDe("agent-platform-proxy"), true, "flag no config.toml");
  const handler = await captureHandler("../agent-platform-proxy/index.ts");

  // Este handler não usa status HTTP para erro esperado: `functions.invoke`
  // descarta o corpo em não-2xx, então a recusa vem em 200 + envelope de erro
  // (ver `errorEnvelope` no index.ts). O que se prova aqui é que nada sem
  // sessão válida atravessa até o provedor.
  const semSessao = async (headers: Record<string, string>) =>
    await comMock(async (registro) => {
      const res = await handler(
        new Request("http://fn.local/", {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify({ action: "listAgents" }),
        }),
      );
      const chamouProvedor = registro.some((c) => c.includes("provider.test"));
      assertEquals(chamouProvedor, false, "nenhuma chamada ao provedor");
      return { status: res.status, body: await res.json() as { error?: { code?: string } } };
    });

  await t.step("sem Authorization não chega ao provedor e devolve erro", async () => {
    const { body } = await semSessao({});
    assertEquals(typeof body.error?.code === "string", true, "envelope de erro presente");
  });

  await t.step("token inválido é recusado mesmo com o gateway tendo deixado passar", async () => {
    const { body } = await semSessao({ authorization: "Bearer jwt-falso" });
    assertEquals(typeof body.error?.code === "string", true, "envelope de erro presente");
  });
});

Deno.test("guarda: toda function com verify_jwt=false tem teste de autorização aqui", () => {
  const semJwt = BLOCOS.filter((b) => b.verifyJwt === false).map((b) => b.nome);
  const descobertas = semJwt.filter((nome) => !COBERTAS_SEM_JWT.has(nome));
  if (descobertas.length > 0) {
    throw new Error(
      `functions com verify_jwt=false sem cobertura de autorização neste arquivo: ` +
        `${descobertas.join(", ")}. Escreva o teste e acrescente em COBERTAS_SEM_JWT.`,
    );
  }
  const obsoletas = [...COBERTAS_SEM_JWT].filter((nome) => !semJwt.includes(nome));
  if (obsoletas.length > 0) {
    throw new Error(
      `COBERTAS_SEM_JWT lista function que não é mais pública: ${obsoletas.join(", ")}.`,
    );
  }
});
