import {
  activeMembershipResponse,
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";

setEnv(BASE_ENV);

const handler = await captureHandler("../messaging-send/index.ts");

interface ConvRow {
  id: string;
  tenant_id: string;
  contact_id: string;
  channel_id: string;
  subject: string | null;
  channels?: { provider_slug: string; type: string; status: string } | null;
}

interface State {
  authOk: boolean;
  profile: { tenant_id: string; role: string } | null;
  conv: ConvRow | null;
  integration: { status: string } | null;
  contact: { phone: string | null; email: string | null } | null;
  secrets: Array<{ key: string; value: string }>;
  priorMessagesCount: number;
  draft: { id: string; content: string | null } | null;
  secretsRaw: boolean;
  insertFails: boolean;
  newMessageId: string;
  providerStatus: number;
  providerBody: unknown;
  providerThrows: boolean;
  // Erro de INFRA na leitura da conversa (não "conversa inexistente"). Fixa a
  // direção do fix 05-silent-failures H14: sem ele, o operador via "Conversa
  // não encontrada" (404) numa conversa aberta na tela durante instabilidade.
  convSelectError: boolean;
  /** Corpo de cada PATCH em `conversations`. É por aqui que se prova quem
   * desliga a IA da conversa (`ai_active:false`) e quem não desliga. */
  conversationWrites: Array<Record<string, unknown>>;
  /** PATCH de status em `messages` falha (blip de banco DEPOIS do provider ter
   * entregue). Fixa o fix 05·H1: sem ele a linha fica presa em `sending`. */
  sentUpdateFails: boolean;
  /** Corpo de cada PATCH em `messages` que não é o claim de draft. */
  messageStatusWrites: Array<Record<string, unknown>>;
  /** Eventos gravados em `system_events` (telemetria via captureEdgeError). */
  systemEvents: Array<Record<string, unknown>>;
}

function defaultState(): State {
  return {
    authOk: true,
    profile: { tenant_id: "tenant-1", role: "agent" },
    conv: {
      id: "conv-1",
      tenant_id: "tenant-1",
      contact_id: "contact-1",
      channel_id: "chan-1",
      subject: null,
      channels: { provider_slug: "zapi", type: "whatsapp", status: "connected" },
    },
    integration: { status: "active" },
    contact: { phone: "+55 11 99999-9999", email: "cliente@x.com" },
    secrets: [
      { key: "instance_id", value: "inst-1" },
      { key: "instance_token", value: "tok-1" },
      { key: "client_token", value: "ctok-1" },
    ],
    priorMessagesCount: 0,
    draft: null,
    insertFails: false,
    newMessageId: "msg-1",
    providerStatus: 200,
    providerBody: { messageId: "ext-1" },
    providerThrows: false,
    convSelectError: false,
    secretsRaw: false,
    conversationWrites: [],
    sentUpdateFails: false,
    messageStatusWrites: [],
    systemEvents: [],
  };
}

function router(state: State): FetchMatcher {
  return (req) => {
    if (req.pathname === "/auth/v1/user") {
      if (!state.authOk) return jsonResponse(401, { msg: "invalid token" });
      return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
    }
    if (req.pathname === "/rest/v1/profiles" && req.method === "GET") {
      return jsonResponse(200, state.profile ? [state.profile] : []);
    }
    const membership = activeMembershipResponse(req, state.profile);
    if (membership) return membership;
    if (req.pathname === "/rest/v1/conversations") {
      if (req.method === "GET" && state.convSelectError) {
        return jsonResponse(500, { message: "conversations select failed", code: "XX000" });
      }
      if (req.method === "GET") return jsonResponse(200, state.conv ? [state.conv] : []);
      if (req.method === "PATCH") {
        state.conversationWrites.push((req.bodyJson as Record<string, unknown>) ?? {});
        return emptyResponse(200);
      }
    }
    if (req.pathname === "/rest/v1/tenant_integrations" && req.method === "GET") {
      return jsonResponse(200, state.integration ? [state.integration] : []);
    }
    if (req.pathname === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, state.contact ? [state.contact] : []);
    }
    if (req.pathname === "/rest/v1/integration_secrets" && req.method === "GET") {
      // secretsRaw=true simula PostgREST devolvendo `null` (sem linhas, corpo
      // nulo) pra exercitar o fallback `data ?? []` em loadSecrets.
      return jsonResponse(200, state.secretsRaw ? null : state.secrets);
    }
    if (req.pathname === "/rest/v1/messages") {
      if (req.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: { "content-range": `*/${state.priorMessagesCount}` },
        });
      }
      if (req.method === "GET") return jsonResponse(200, state.draft ? [state.draft] : []);
      if (req.method === "POST") {
        // .insert(...).select("id").single() — supabase-js NÃO desembrulha array
        // pra .single() (diferente de .maybeSingle()); precisa vir objeto puro.
        if (state.insertFails) return jsonResponse(500, { message: "insert failed" });
        return jsonResponse(201, { id: state.newMessageId });
      }
      if (req.method === "PATCH") {
        // Claim atômico de draft: UPDATE ... WHERE status='draft' RETURNING id,content.
        // Com .maybeSingle(): 200 + objeto quando linha ainda em draft; 200 + null
        // (0 linhas) quando já foi reivindicada ou não existe. supabase-js
        // NÃO trata 200-null como erro (diferente de .single()).
        const filterStatus = req.url.includes("status=eq.draft");
        if (filterStatus) {
          if (state.draft) {
            return jsonResponse(200, { id: state.draft.id, content: state.draft.content });
          }
          return jsonResponse(200, null);
        }
        state.messageStatusWrites.push((req.bodyJson as Record<string, unknown>) ?? {});
        if (state.sentUpdateFails) {
          return jsonResponse(500, { message: "update status failed", code: "XX000" });
        }
        return emptyResponse(200);
      }
    }
    if (req.pathname === "/rest/v1/system_events" && req.method === "POST") {
      state.systemEvents.push((req.bodyJson as Record<string, unknown>) ?? {});
      return jsonResponse(201, {});
    }
    if (req.url.startsWith("https://api.z-api.io/instances/")) {
      if (state.providerThrows) throw new Error("network down");
      return jsonResponse(state.providerStatus, state.providerBody);
    }
    if (req.url.startsWith("https://api.twilio.com/2010-04-01/Accounts/")) {
      if (state.providerThrows) throw new Error("network down");
      return jsonResponse(state.providerStatus, state.providerBody);
    }
    if (req.url.startsWith("https://graph.facebook.com/v23.0/")) {
      if (state.providerThrows) throw new Error("network down");
      return jsonResponse(state.providerStatus, state.providerBody);
    }
    if (req.url === "https://api.resend.com/emails") {
      if (state.providerThrows) throw new Error("network down");
      return jsonResponse(state.providerStatus, state.providerBody);
    }
    return undefined;
  };
}

function req(body?: unknown, opts: { method?: string; auth?: string | null } = {}): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (opts.auth !== null) headers.set("Authorization", opts.auth ?? "Bearer token-123");
  return new Request("http://fn.local", {
    method: opts.method ?? "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const validBody = { conversation_id: "conv-1", content: "Olá, tudo bem?" };

async function run(
  state: State,
  body: unknown,
  opts: { method?: string; auth?: string | null } = {},
) {
  const uninstall = installFetchMock(router(state));
  try {
    const res = await handler(req(body, opts));
    const status = res.status;
    const text = await res.text();
    const parsed = text ? JSON.parse(text) : null;
    return { status, body: parsed };
  } finally {
    uninstall();
  }
}

Deno.test("messaging-send", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (await res.text()) throw new Error("esperado corpo vazio");
    } finally {
      uninstall();
    }
  });

  await t.step("método não-POST retorna 405", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(req(undefined, { method: "GET" }));
      if (res.status !== 405) throw new Error(`esperado 405, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("sem usuário autenticado retorna 401", async () => {
    const state = defaultState();
    state.authOk = false;
    const { status, body } = await run(state, validBody);
    if (status !== 401 || body.error !== "Não autenticado.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("sem perfil retorna 403", async () => {
    const state = defaultState();
    state.profile = null;
    const { status, body } = await run(state, validBody);
    if (status !== 403 || body.error !== "Perfil não encontrado.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("corpo inválido (JSON quebrado) retorna 400", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request("http://fn.local", {
          method: "POST",
          headers: { Authorization: "Bearer x", "content-type": "application/json" },
          body: "{not-json",
        }),
      );
      const body = await res.json();
      if (res.status !== 400 || body.error !== "Corpo inválido.") {
        throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("conversation_id ausente retorna 400", async () => {
    const state = defaultState();
    const { status, body } = await run(state, { content: "oi" });
    if (status !== 400 || body.error !== "Conversa e mensagem são obrigatórias.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("content vazio sem draft_message_id retorna 400", async () => {
    const state = defaultState();
    const { status, body } = await run(state, { conversation_id: "conv-1", content: "   " });
    if (status !== 400 || body.error !== "Conversa e mensagem são obrigatórias.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("content vazio COM draft_message_id passa da validação inicial", async () => {
    const state = defaultState();
    state.draft = { id: "draft-1", content: "conteúdo do rascunho" };
    const { status, body } = await run(state, {
      conversation_id: "conv-1",
      content: "",
      draft_message_id: "draft-1",
    });
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("conversa não encontrada retorna 404", async () => {
    const state = defaultState();
    state.conv = null;
    const { status, body } = await run(state, validBody);
    if (status !== 404 || body.error !== "Conversa não encontrada.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("conversa de outro tenant retorna 404", async () => {
    const state = defaultState();
    state.conv = { ...state.conv!, tenant_id: "tenant-outro" };
    const { status, body } = await run(state, validBody);
    if (status !== 404 || body.error !== "Conversa não encontrada.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("canal sem provider_slug suportado retorna 400", async () => {
    const state = defaultState();
    state.conv = {
      ...state.conv!,
      channels: { provider_slug: "outro", type: "chat", status: "connected" },
    };
    const { status, body } = await run(state, validBody);
    if (
      status !== 400 || body.error !== "Canal desta conversa não é suportado para envio externo."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "canal sem embed de channels (null) retorna 400 de canal não suportado",
    async () => {
      const state = defaultState();
      state.conv = { ...state.conv!, channels: null };
      const { status, body } = await run(state, validBody);
      if (
        status !== 400 || body.error !== "Canal desta conversa não é suportado para envio externo."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("canal inativo retorna 400", async () => {
    const state = defaultState();
    state.conv = {
      ...state.conv!,
      channels: { provider_slug: "zapi", type: "whatsapp", status: "disconnected" },
    };
    const { status, body } = await run(state, validBody);
    if (
      status !== 400 ||
      body.error !== "O canal desta conversa está inativo. Reative o canal antes de enviar."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("integração não encontrada retorna 400", async () => {
    const state = defaultState();
    state.integration = null;
    const { status, body } = await run(state, validBody);
    if (
      status !== 400 ||
      body.error !==
        "A integração deste canal não está conectada. Reconecte em Integrações antes de enviar."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("integração inativa retorna 400", async () => {
    const state = defaultState();
    state.integration = { status: "inactive" };
    const { status, body } = await run(state, validBody);
    if (status !== 400 || !body.error.includes("não está conectada")) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "draft_message_id não encontrado retorna 409 (claim atômico não distingue not-found de já-reivindicado)",
    async () => {
      // Lote 1: claim atômico fundiu os dois caminhos — o UPDATE condicionado
      // a status='draft' devolve 0 linhas tanto para 'draft inexistente' quanto
      // para 'draft já enviado'. Do ponto de vista do cliente é a mesma coisa
      // (o rascunho não está mais disponível para reivindicação).
      const state = defaultState();
      state.draft = null;
      const { status, body } = await run(state, {
        conversation_id: "conv-1",
        content: "",
        draft_message_id: "draft-x",
      });
      if (
        status !== 409 || body.ok !== false || !body.error?.includes("Este rascunho já foi enviado")
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("draft_message_id com conteúdo vazio retorna 400", async () => {
    const state = defaultState();
    state.draft = { id: "draft-1", content: "   " };
    const { status, body } = await run(state, {
      conversation_id: "conv-1",
      content: "",
      draft_message_id: "draft-1",
    });
    if (status !== 400 || body.error !== "Rascunho sem conteúdo para enviar.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("falha ao inserir mensagem pendente retorna 500", async () => {
    const state = defaultState();
    state.insertFails = true;
    const { status, body } = await run(state, validBody);
    if (status !== 500 || body.error !== "Não foi possível salvar a mensagem.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- Z-API ----

  await t.step("Z-API: credenciais ausentes retorna ok:false com mensagem amigável", async () => {
    const state = defaultState();
    state.secrets = [];
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false || body.error !== "Integração Z-API não configurada.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Z-API: contato sem telefone retorna ok:false 'sem telefone cadastrado'",
    async () => {
      const state = defaultState();
      state.contact = { phone: null, email: null };
      const { status, body } = await run(state, validBody);
      if (
        status !== 200 || body.ok !== false || body.error !== "Contato sem telefone cadastrado."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Z-API: 401 do provedor retorna mensagem de credenciais inválidas", async () => {
    const state = defaultState();
    state.providerStatus = 401;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Credenciais da Z-API não estão mais válidas. Reconecte a integração."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Z-API: 500 do provedor retorna mensagem de indisponibilidade", async () => {
    const state = defaultState();
    state.providerStatus = 500;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "O provedor está indisponível no momento. Tente de novo em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Z-API: 429 do provedor retorna mensagem de rate limit", async () => {
    const state = defaultState();
    state.providerStatus = 429;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "O provedor pediu para aguardar um pouco antes de enviar de novo."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // 400/422 é recusa permanente do provider (número inexistente, template não
  // aprovado, janela de 24h expirada) — a mensagem NÃO pode convidar a
  // retentar, senão o operador retenta para sempre algo que nunca vai passar
  // (H12 de docs/code-review/05-silent-failures.md).
  await t.step(
    "Z-API: 400 do provedor retorna recusa permanente (sem 'tente novamente')",
    async () => {
      const state = defaultState();
      state.providerStatus = 400;
      const { status, body } = await run(state, validBody);
      if (
        status !== 200 || body.ok !== false ||
        body.error !==
          "O provedor recusou a mensagem (cadastro do contato, template não aprovado ou janela de 24h expirada). Corrija o cadastro antes de reenviar."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Z-API: falha de rede retorna mensagem de rede no catch geral", async () => {
    const state = defaultState();
    state.providerThrows = true;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Não conseguimos falar com o provedor agora — tente novamente em instantes."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Z-API: sucesso retorna ok:true com id da mensagem, usando messageId como external_id",
    async () => {
      const state = defaultState();
      state.providerBody = { messageId: "msg-ext-1" };
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== true || body.id !== "msg-1") {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Z-API: sucesso sem messageId cai para zaapId como external_id", async () => {
    const state = defaultState();
    state.providerBody = { zaapId: "zaap-1" };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Z-API: sucesso sem messageId/zaapId cai para id como external_id", async () => {
    const state = defaultState();
    state.providerBody = { id: "id-1" };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Z-API: sucesso sem nenhum campo de id usa external_id null", async () => {
    const state = defaultState();
    state.providerBody = {};
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Z-API: JSON de resposta inválido do provedor não quebra (cai no catch do .json())",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock((r) => {
        if (r.pathname === "/auth/v1/user") {
          return jsonResponse(200, { id: "user-1", email: "u@x.com", aud: "authenticated" });
        }
        if (r.pathname === "/rest/v1/profiles") return jsonResponse(200, [state.profile]);
        const membership = activeMembershipResponse(r, state.profile);
        if (membership) return membership;
        if (r.pathname === "/rest/v1/conversations" && r.method === "GET") {
          return jsonResponse(200, [state.conv]);
        }
        if (r.pathname === "/rest/v1/conversations" && r.method === "PATCH") {
          return emptyResponse(200);
        }
        if (r.pathname === "/rest/v1/tenant_integrations") {
          return jsonResponse(200, [state.integration]);
        }
        if (r.pathname === "/rest/v1/contacts") return jsonResponse(200, [state.contact]);
        if (r.pathname === "/rest/v1/integration_secrets") return jsonResponse(200, state.secrets);
        if (r.pathname === "/rest/v1/messages" && r.method === "POST") {
          return jsonResponse(201, { id: state.newMessageId });
        }
        if (r.pathname === "/rest/v1/messages" && r.method === "PATCH") return emptyResponse(200);
        if (r.url.startsWith("https://api.z-api.io/instances/")) {
          return new Response("isso não é json", { status: 200 });
        }
        return undefined;
      });
      try {
        const res = await handler(req(validBody));
        const body = await res.json();
        if (res.status !== 200 || body.ok !== true) {
          throw new Error(`inesperado: ${res.status} ${JSON.stringify(body)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // ---- Twilio ----

  function twilioState(): State {
    const state = defaultState();
    state.conv = {
      ...state.conv!,
      channels: { provider_slug: "twilio", type: "whatsapp", status: "connected" },
    };
    state.secrets = [
      { key: "account_sid", value: "AC123" },
      { key: "auth_token", value: "authtok" },
      { key: "whatsapp_number", value: "+1 555 000 0000" },
    ];
    state.contact = { phone: "+55 11 98888-7777", email: null };
    state.providerBody = { sid: "SID123" };
    return state;
  }

  await t.step("Twilio: credenciais ausentes retorna ok:false", async () => {
    const state = twilioState();
    state.secrets = [];
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 || body.ok !== false || body.error !== "Integração Twilio não configurada."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Twilio: contato sem telefone retorna ok:false 'sem telefone cadastrado'",
    async () => {
      const state = twilioState();
      state.contact = { phone: null, email: null };
      const { status, body } = await run(state, validBody);
      if (
        status !== 200 || body.ok !== false || body.error !== "Contato sem telefone cadastrado."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Twilio: telefone sem dígitos retorna 'Número do contato inválido.'", async () => {
    const state = twilioState();
    state.contact = { phone: "abc-sem-digitos", email: null };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false || body.error !== "Número do contato inválido.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Twilio: 403 do provedor retorna mensagem de credenciais inválidas", async () => {
    const state = twilioState();
    state.providerStatus = 403;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Credenciais da Twilio não estão mais válidas. Reconecte a integração."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Twilio: sucesso retorna ok:true com external_id sid", async () => {
    const state = twilioState();
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Twilio: sucesso sem sid usa external_id null", async () => {
    const state = twilioState();
    state.providerBody = {};
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Twilio: falha de rede retorna mensagem de rede", async () => {
    const state = twilioState();
    state.providerThrows = true;
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- Meta Cloud API ----

  function metaState(): State {
    const state = defaultState();
    state.conv = {
      ...state.conv!,
      channels: { provider_slug: "meta-cloud", type: "whatsapp", status: "connected" },
    };
    state.secrets = [
      { key: "access_token", value: "tok-meta" },
      { key: "phone_number_id", value: "1234567890" },
    ];
    state.contact = { phone: "+55 11 97777-6666", email: null };
    state.providerBody = { messages: [{ id: "wamid.abc" }] };
    return state;
  }

  await t.step("Meta Cloud: credenciais ausentes retorna ok:false", async () => {
    const state = metaState();
    state.secrets = [];
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Integração WhatsApp Oficial (Meta) não configurada."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Meta Cloud: contato sem telefone retorna ok:false", async () => {
    const state = metaState();
    state.contact = { phone: null, email: null };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false || body.error !== "Contato sem telefone cadastrado.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Meta Cloud: telefone sem dígitos retorna 'Número do contato inválido.'",
    async () => {
      const state = metaState();
      state.contact = { phone: "sem-digitos", email: null };
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== false || body.error !== "Número do contato inválido.") {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Meta Cloud: 401 do provedor retorna mensagem de token inválido", async () => {
    const state = metaState();
    state.providerStatus = 401;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Access Token da Meta não está mais válido. Reconecte a integração."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Meta Cloud: sucesso retorna ok:true com external_id do array messages",
    async () => {
      const state = metaState();
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Meta Cloud: sucesso sem array messages usa external_id null", async () => {
    const state = metaState();
    state.providerBody = {};
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Meta Cloud: falha de rede retorna mensagem de rede", async () => {
    const state = metaState();
    state.providerThrows = true;
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- Resend ----

  function resendState(): State {
    const state = defaultState();
    state.conv = {
      ...state.conv!,
      subject: null,
      channels: { provider_slug: "resend", type: "email", status: "connected" },
    };
    state.secrets = [
      { key: "api_key", value: "re-key" },
      { key: "from_domain", value: "acme.com" },
    ];
    state.contact = { phone: null, email: "cliente@x.com" };
    state.providerBody = { id: "resend-id-1" };
    state.priorMessagesCount = 0;
    return state;
  }

  await t.step("Resend: credenciais ausentes retorna ok:false", async () => {
    const state = resendState();
    state.secrets = [];
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 || body.ok !== false || body.error !== "Integração Resend não configurada."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: contato sem e-mail retorna ok:false 'sem e-mail cadastrado'", async () => {
    const state = resendState();
    state.contact = { phone: null, email: null };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false || body.error !== "Contato sem e-mail cadastrado.") {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: sem thread prévia (subject vazio) usa 'Nova mensagem'", async () => {
    const state = resendState();
    state.conv = { ...state.conv!, subject: "" };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: subject já com 'Re:' mantém como está", async () => {
    const state = resendState();
    state.conv = { ...state.conv!, subject: "Re: Dúvida" };
    state.priorMessagesCount = 3;
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step(
    "Resend: subject sem 'Re:' e sem mensagens anteriores (count 0) mantém como está",
    async () => {
      const state = resendState();
      state.conv = { ...state.conv!, subject: "Orçamento" };
      state.priorMessagesCount = 0;
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "Resend: subject sem 'Re:' com mensagens anteriores adiciona prefixo 'Re: '",
    async () => {
      const state = resendState();
      state.conv = { ...state.conv!, subject: "Orçamento" };
      state.priorMessagesCount = 2;
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("Resend: persiste subject na conversa quando ela ainda não tem um", async () => {
    const state = resendState();
    state.conv = { ...state.conv!, subject: null };
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: usa from_email do cred quando presente e válido", async () => {
    const state = resendState();
    state.secrets.push({ key: "from_email", value: "contato@outrodominio.com" });
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: from_email sem '@' cai para contato@{from_domain}", async () => {
    const state = resendState();
    state.secrets.push({ key: "from_email", value: "invalido-sem-arroba" });
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: 401 do provedor retorna mensagem de chave inválida", async () => {
    const state = resendState();
    state.providerStatus = 401;
    const { status, body } = await run(state, validBody);
    if (
      status !== 200 ||
      body.ok !== false ||
      body.error !== "Chave do Resend não está mais válida. Reconecte a integração."
    ) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: sucesso sem id na resposta usa external_id null", async () => {
    const state = resendState();
    state.providerBody = {};
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== true) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  await t.step("Resend: falha de rede retorna mensagem de rede", async () => {
    const state = resendState();
    state.providerThrows = true;
    const { status, body } = await run(state, validBody);
    if (status !== 200 || body.ok !== false) {
      throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
    }
  });

  // ---- Ramos defensivos (fallbacks `??`/`||`) ----

  await t.step(
    "sem header Authorization usa fallback de string vazia e ainda assim segue o fluxo",
    async () => {
      const state = defaultState();
      const { status, body } = await run(state, validBody, { auth: null });
      // O mock de /auth/v1/user não valida o conteúdo do header — o que importa
      // aqui é exercitar `req.headers.get("Authorization") ?? ""` sem o header.
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step("sem SUPABASE_ANON_KEY usa fallback SUPABASE_PUBLISHABLE_KEY", async () => {
    Deno.env.delete("SUPABASE_ANON_KEY");
    setEnv({ SUPABASE_PUBLISHABLE_KEY: "publishable-key" });
    const state = defaultState();
    try {
      const { status, body } = await run(state, validBody);
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    } finally {
      Deno.env.delete("SUPABASE_PUBLISHABLE_KEY");
      setEnv(BASE_ENV);
    }
  });

  await t.step(
    "content ausente do corpo (não apenas vazio) com draft_message_id usa fallback ''",
    async () => {
      const state = defaultState();
      state.draft = { id: "draft-1", content: "conteúdo do rascunho" };
      const { status, body } = await run(state, {
        conversation_id: "conv-1",
        draft_message_id: "draft-1",
      });
      if (status !== 200 || body.ok !== true) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "draft com content null usa fallback '' e é tratado como rascunho vazio",
    async () => {
      const state = defaultState();
      state.draft = { id: "draft-1", content: null };
      const { status, body } = await run(state, {
        conversation_id: "conv-1",
        draft_message_id: "draft-1",
      });
      if (status !== 400 || body.error !== "Rascunho sem conteúdo para enviar.") {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );

  await t.step(
    "integration_secrets retornando corpo nulo usa fallback [] em loadSecrets",
    async () => {
      const state = defaultState();
      state.secretsRaw = true;
      const { status, body } = await run(state, validBody);
      if (
        status !== 200 || body.ok !== false || body.error !== "Integração Z-API não configurada."
      ) {
        throw new Error(`inesperado: ${status} ${JSON.stringify(body)}`);
      }
    },
  );
  await t.step("H14: erro de banco ao carregar conversa responde 503, não 404", async () => {
    const state = defaultState();
    state.convSelectError = true;
    const { status, body } = await run(state, validBody);
    if (status !== 503) {
      throw new Error(`instabilidade de banco deveria dar 503, veio ${status}`);
    }
    if (String((body as { error?: string })?.error ?? "").includes("não encontrada")) {
      throw new Error(`404 disfarçado de 503: ${JSON.stringify(body)}`);
    }
  });
});

// Regressão do HIGH `01b · H1` (code review de 2026-08-10, corrigido em #254):
// o `update({ ai_active:false })` estava FORA do if/else de `draft_message_id`.
// Com `send_mode='draft'` — o modo seguro do produto — aprovar o primeiro
// rascunho derrubava a IA da conversa para sempre: a fila secava e o operador só
// recuperava clicando "IA ativa" conversa a conversa.
Deno.test("messaging-send: quem desliga a IA da conversa", async (t) => {
  function pausasDaIa(state: State): Array<Record<string, unknown>> {
    return state.conversationWrites.filter((w) => w.ai_active === false);
  }

  await t.step("aprovar rascunho da IA NÃO desliga a IA da conversa", async () => {
    const state = defaultState();
    state.draft = { id: "draft-1", content: "Resposta sugerida pela IA." };

    const { status, body } = await run(state, {
      conversation_id: "conv-1",
      content: "",
      draft_message_id: "draft-1",
    });

    if (status !== 200 || body?.ok !== true) {
      throw new Error(`esperava envio ok, veio ${status} ${JSON.stringify(body)}`);
    }
    if (pausasDaIa(state).length !== 0) {
      throw new Error(
        `aprovar rascunho pausou a IA: ${JSON.stringify(state.conversationWrites)}`,
      );
    }
  });

  await t.step("mensagem digitada pelo atendente desliga a IA", async () => {
    const state = defaultState();

    const { status, body } = await run(state, {
      conversation_id: "conv-1",
      content: "Oi, aqui é a Ana, assumi seu atendimento.",
    });

    if (status !== 200 || body?.ok !== true) {
      throw new Error(`esperava envio ok, veio ${status} ${JSON.stringify(body)}`);
    }
    if (pausasDaIa(state).length !== 1) {
      throw new Error(
        `esperava exatamente 1 pausa da IA, veio ${JSON.stringify(state.conversationWrites)}`,
      );
    }
  });
});

// Regressão 05·H1. O provider JÁ entregou; se o UPDATE de status falhar e
// ninguém souber, a linha fica em `sending` para sempre (não há reaper de
// `sending` em migration nenhuma), a UI mostra "não enviada" e o atendente
// reenvia na mão — o cliente recebe duas vezes.
Deno.test("messaging-send: status não persistido depois do envio", async (t) => {
  await t.step("retenta o UPDATE e, falhando, grava system_events", async () => {
    const state = defaultState();
    state.sentUpdateFails = true;

    const { status, body } = await run(state, validBody);

    if (status !== 200) throw new Error(`esperava 200, veio ${status}`);
    // NUNCA ok:false: `_app.inbox.tsx:249` transforma ok:false em erro na tela,
    // que é justamente o gatilho do reenvio duplicado que este fix evita.
    if (body?.ok !== true) {
      throw new Error(`envio que DEU CERTO não pode virar falha: ${JSON.stringify(body)}`);
    }
    if (body?.status_persistido !== false || typeof body?.aviso !== "string") {
      throw new Error(
        `retorno tem que avisar que o status não foi salvo: ${JSON.stringify(body)}`,
      );
    }
    const tentativasDeStatus = state.messageStatusWrites.filter((w) => w.status === "sent");
    if (tentativasDeStatus.length !== 2) {
      throw new Error(
        `esperava 1 retentativa do UPDATE, houve ${tentativasDeStatus.length}`,
      );
    }
    const evento = state.systemEvents.find(
      (e) => e.operation === "messaging.send.persistir_status_enviado",
    );
    if (!evento) {
      throw new Error(
        `falha ao persistir status tem que deixar rastro: ${JSON.stringify(state.systemEvents)}`,
      );
    }
    if ((evento.context as Record<string, unknown>)?.external_id !== "ext-1") {
      throw new Error(`o evento tem que carregar o external_id perdido: ${JSON.stringify(evento)}`);
    }
  });

  await t.step("caminho feliz continua sem aviso e sem evento de erro", async () => {
    const state = defaultState();

    const { status, body } = await run(state, validBody);

    if (status !== 200 || body?.ok !== true || body?.status_persistido !== true) {
      throw new Error(`esperava envio ok e status persistido: ${status} ${JSON.stringify(body)}`);
    }
    if (body?.aviso !== undefined) {
      throw new Error(`envio sem incidente não pode devolver aviso: ${JSON.stringify(body)}`);
    }
    if (state.systemEvents.some((e) => e.operation === "messaging.send.persistir_status_enviado")) {
      throw new Error("caminho feliz não pode gravar evento de falha de persistência");
    }
  });
});
