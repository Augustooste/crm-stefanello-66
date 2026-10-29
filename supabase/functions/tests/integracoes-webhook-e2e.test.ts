// Smoke fim a fim de integração + webhook, com "banco" falso compartilhado.
//
// Os testes por function (integration-connect.test.ts, messaging-webhook.test.ts)
// provam cada handler contra um mock desenhado sob medida para ele. O que
// nenhum dos dois prova é a JUNÇÃO: o token que o connect grava em
// `tenant_integrations` é o mesmo que o webhook exige na URL, e o segredo
// gravado em `integration_secrets` é o mesmo 2º fator que o webhook confere no
// header. Uma troca de nome de coluna ou de chave de segredo passa verde nos
// dois arquivos e quebra a operação do cliente.
//
// Por isso aqui o mock NÃO é roteado por caso: é uma tabelinha em memória com
// filtro genérico de PostgREST (eq./is.null), escrita pelo connect e lida pelo
// webhook. Nada é injetado à mão entre os dois passos.
import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  type MockRequest,
  setEnv,
} from "./_helpers.ts";
/** Payload de inbound da Z-API (formato plano: messageId/phone/text.message). */
function zapiTexto(texto: string, messageId = "msg-e2e-1"): Record<string, unknown> {
  return { messageId, phone: "5511999990001", text: { message: texto } };
}

/** Mesma origem, porém enviado POR NÓS: a IA e o inbox precisam ignorar. */
function zapiEco(texto: string, messageId = "msg-e2e-echo"): Record<string, unknown> {
  return { messageId, phone: "5511999990001", fromMe: true, text: { message: texto } };
}

setEnv(BASE_ENV);

const connectHandler = await captureHandler("../integration-connect/index.ts");
const webhookHandler = await captureHandler("../messaging-webhook/index.ts");

const TENANT = "tenant-1";
const SLUG = "zapi";
// Credenciais fictícias do provedor, só existem dentro deste arquivo.
const VALORES_ZAPI = {
  instance_id: "inst-e2e",
  instance_token: "token-de-instancia-ficticio",
  client_token: "client-token-ficticio",
};

function assertEquals(atual: unknown, esperado: unknown, msg: string): void {
  if (atual !== esperado) throw new Error(`${msg}: esperado ${esperado}, veio ${atual}`);
}
function assertOk(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

// ------------------------------------------------------------- banco falso

type Linha = Record<string, unknown>;

/** PostgREST manda operador junto do valor ("eq.zapi", "is.null"). */
function casa(linha: Linha, chave: string, bruto: string): boolean {
  if (bruto === "is.null") return linha[chave] === null || linha[chave] === undefined;
  if (bruto === "not.is.null") return linha[chave] !== null && linha[chave] !== undefined;
  const valor = bruto.replace(/^[a-z]+\./, "");
  return String(linha[chave] ?? "") === valor;
}

const IGNORADOS = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

class BancoFalso {
  tabelas = new Map<string, Linha[]>();
  chamadas: string[] = [];
  proximoId = 1;

  linhas(tabela: string): Linha[] {
    if (!this.tabelas.has(tabela)) this.tabelas.set(tabela, []);
    return this.tabelas.get(tabela)!;
  }

  selecionar(tabela: string, params: URLSearchParams): Linha[] {
    return this.linhas(tabela).filter((linha) =>
      [...params.entries()].every(([chave, valor]) =>
        IGNORADOS.has(chave) || casa(linha, chave, valor)
      )
    );
  }

  inserir(tabela: string, corpo: Linha | Linha[]): Linha[] {
    const novos = (Array.isArray(corpo) ? corpo : [corpo]).map((linha) => ({
      id: `${tabela}-${this.proximoId++}`,
      ...linha,
    }));
    this.linhas(tabela).push(...novos);
    return novos;
  }

  atualizar(tabela: string, params: URLSearchParams, patch: Linha): Linha[] {
    const alvos = this.selecionar(tabela, params);
    for (const linha of alvos) Object.assign(linha, patch);
    return alvos;
  }
}

/** Roteador único: PostgREST genérico + provedores externos. */
function router(db: BancoFalso): FetchMatcher {
  return (req: MockRequest) => {
    const url = new URL(req.url);
    const p = req.pathname;
    const params = url.searchParams;
    db.chamadas.push(`${req.method} ${p}`);

    // --- Auth: o connect chama /auth/v1/user com o JWT do admin.
    if (p === "/auth/v1/user") {
      return jsonResponse(200, { id: "user-1", email: "admin@acme.test", aud: "authenticated" });
    }

    // --- Provedores externos (teste de conexão do connect).
    if (req.url.includes("api.z-api.io")) return jsonResponse(200, { connected: true });

    // --- Disparo de IA: não é o objeto deste teste, só não pode explodir.
    if (p === "/functions/v1/ai-respond") return jsonResponse(200, {});

    if (!p.startsWith("/rest/v1/")) return undefined;

    // --- RPCs usadas pelo caminho do webhook.
    if (p.startsWith("/rest/v1/rpc/")) {
      const nome = p.replace("/rest/v1/rpc/", "");
      if (nome === "claim_messaging_webhook_event") {
        const corpo = (req.bodyJson ?? {}) as Linha;
        const externo = String(corpo.p_external_event_id ?? "");
        const eventos = db.linhas("messaging_webhook_events");
        const atual = eventos.find((e) => e.external_event_id === externo);
        if (!atual) {
          const [novo] = db.inserir("messaging_webhook_events", {
            external_event_id: externo,
            status: "processing",
          });
          return jsonResponse(200, [
            { event_id: novo.id, claim_state: "claimed", attempt: 1 },
          ]);
        }
        return jsonResponse(200, [
          {
            event_id: atual.id,
            claim_state: atual.status === "completed" ? "completed" : "busy",
            attempt: 1,
          },
        ]);
      }
      if (nome === "bump_channel_webhook_failure") return jsonResponse(200, 1);
      if (nome === "enqueue_ai_response_job") {
        return jsonResponse(200, [{ job_id: "job-1", should_dispatch: false }]);
      }
      return jsonResponse(200, []);
    }

    const tabela = p.replace("/rest/v1/", "");

    if (req.method === "GET") {
      const linhas = db.selecionar(tabela, params);
      // `.single()` no PostgREST responde objeto; o supabase-js aceita ambos
      // quando o Accept é o de objeto — devolver array é o formato seguro
      // para `.maybeSingle()`/`.limit(1)`, usados nestes caminhos.
      return jsonResponse(200, linhas);
    }

    if (req.method === "POST") {
      const corpo = (req.bodyJson ?? {}) as Linha | Linha[];
      const conflito = params.get("on_conflict");
      if (conflito) {
        // upsert: substitui a linha existente que casa pelas colunas do conflito.
        const chaves = conflito.split(",");
        const entrada = Array.isArray(corpo) ? corpo : [corpo];
        const resultado: Linha[] = [];
        for (const linha of entrada) {
          const existente = db.linhas(tabela).find((atual) =>
            chaves.every((chave) => String(atual[chave] ?? "") === String(linha[chave] ?? ""))
          );
          if (existente) {
            Object.assign(existente, linha);
            resultado.push(existente);
          } else {
            resultado.push(...db.inserir(tabela, linha));
          }
        }
        return jsonResponse(201, resultado.length === 1 ? resultado[0] : resultado);
      }
      const criados = db.inserir(tabela, corpo);
      return jsonResponse(201, criados.length === 1 ? criados[0] : criados);
    }

    if (req.method === "PATCH") {
      const alterados = db.atualizar(tabela, params, (req.bodyJson ?? {}) as Linha);
      return jsonResponse(200, alterados);
    }

    if (req.method === "DELETE") return emptyResponse(200);
    return emptyResponse(200);
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function bancoSemeado(): BancoFalso {
  const db = new BancoFalso();
  db.linhas("profiles").push({ id: "user-1", tenant_id: TENANT, role: "admin" });
  db.linhas("integrations").push({
    slug: SLUG,
    available: true,
    required_secrets: [
      { key: "instance_id" },
      { key: "instance_token" },
      { key: "client_token" },
    ],
  });
  return db;
}

async function conectar(db: BancoFalso): Promise<Record<string, unknown>> {
  const uninstall = installFetchMock(router(db));
  try {
    const res = await connectHandler(
      new Request("http://fn.local", {
        method: "POST",
        headers: { "content-type": "application/json", Authorization: "Bearer jwt-do-admin" },
        body: JSON.stringify({ action: "connect", slug: SLUG, values: VALORES_ZAPI }),
      }),
    );
    return await res.json() as Record<string, unknown>;
  } finally {
    uninstall();
  }
}

async function receberInbound(
  db: BancoFalso,
  corpo: unknown,
  opcoes: { token?: string; clientToken?: string } = {},
): Promise<Response> {
  const integracao = db.linhas("tenant_integrations")[0];
  const token = opcoes.token ?? String(integracao?.webhook_token ?? "");
  const clientToken = opcoes.clientToken ??
    String(
      db.linhas("integration_secrets").find((s) => s.key === "client_token")?.value ?? "",
    );
  const uninstall = installFetchMock(router(db));
  try {
    const res = await webhookHandler(
      new Request(
        `http://fn.local/functions/v1/messaging-webhook/${SLUG}?token=${encodeURIComponent(token)}`,
        {
          method: "POST",
          headers: { "content-type": "application/json", "Client-Token": clientToken },
          body: JSON.stringify(corpo),
        },
      ),
    );
    await flush();
    return res;
  } finally {
    uninstall();
  }
}

// -------------------------------------------------------------------- testes

Deno.test("integração + webhook fim a fim (dados mockados)", async (t) => {
  const db = bancoSemeado();

  await t.step("admin conecta a integração e o teste de conexão passa", async () => {
    const corpo = await conectar(db);
    assertEquals(corpo.error, undefined, `connect devolveu erro: ${JSON.stringify(corpo)}`);
    const integracao = db.linhas("tenant_integrations")[0];
    assertOk(!!integracao, "connect não gravou tenant_integrations");
    assertEquals(integracao.tenant_id, TENANT, "tenant da integração");
    assertEquals(integracao.slug, SLUG, "slug da integração");
    assertOk(
      typeof integracao.webhook_token === "string" && integracao.webhook_token.length >= 16,
      "webhook_token ausente ou curto demais para servir de credencial",
    );
  });

  await t.step("segredos ficam no banco, nunca no envelope de resposta", async () => {
    const segredos = db.linhas("integration_secrets");
    const chaves = segredos.map((s) => s.key).sort().join(",");
    assertEquals(chaves, "client_token,instance_id,instance_token", "chaves gravadas");
    const corpo = JSON.stringify(await conectar(db));
    for (const valor of Object.values(VALORES_ZAPI)) {
      assertOk(!corpo.includes(valor), `valor de segredo vazou na resposta do connect`);
    }
  });

  await t.step("inbound com o token gravado cria contato, conversa e mensagem", async () => {
    const res = await receberInbound(db, zapiTexto("Oi, quero saber o preço"));
    assertEquals(res.status, 200, "status do webhook");
    assertEquals(db.linhas("contacts").length, 1, "contatos criados");
    assertEquals(db.linhas("conversations").length, 1, "conversas criadas");
    assertEquals(db.linhas("messages").length, 1, "mensagens criadas");
    const mensagem = db.linhas("messages")[0];
    assertEquals(mensagem.tenant_id, TENANT, "tenant da mensagem");
    // O enum do banco grava "in"/"out", não "inbound"/"outbound".
    assertEquals(mensagem.direction, "in", "direção da mensagem");
  });

  await t.step("reentrega do MESMO evento não duplica mensagem (idempotência)", async () => {
    const antes = db.linhas("messages").length;
    const res = await receberInbound(db, zapiTexto("Oi, quero saber o preço"));
    assertEquals(res.status, 200, "status do webhook");
    assertEquals(db.linhas("messages").length, antes, "nenhuma mensagem nova na reentrega");
  });

  await t.step("token errado é recusado sem tocar no banco", async () => {
    const antes = db.linhas("messages").length;
    const res = await receberInbound(db, zapiTexto("tentativa", "msg-e2e-negativo"), {
      token: "token-invalido",
    });
    assertOk(res.status === 401 || res.status === 403, `esperado 401/403, veio ${res.status}`);
    assertEquals(db.linhas("messages").length, antes, "nada gravado com token inválido");
  });

  await t.step("2º fator errado (Client-Token) é recusado", async () => {
    const antes = db.linhas("messages").length;
    const res = await receberInbound(db, zapiTexto("tentativa", "msg-e2e-negativo"), {
      clientToken: "client-token-errado",
    });
    assertOk(res.status >= 400, `esperado recusa, veio ${res.status}`);
    assertEquals(db.linhas("messages").length, antes, "nada gravado com 2º fator inválido");
  });

  await t.step("eco da própria saída não vira mensagem de contato", async () => {
    const contatosAntes = db.linhas("contacts").length;
    const res = await receberInbound(db, zapiEco("resposta enviada pelo atendente"));
    assertEquals(res.status, 200, "status do webhook");
    const deContato = db.linhas("messages").filter((m) => m.direction === "in").length;
    assertEquals(deContato, 1, "eco não pode contar como mensagem recebida");
    assertEquals(db.linhas("contacts").length, contatosAntes, "eco não cria contato");
  });
});
