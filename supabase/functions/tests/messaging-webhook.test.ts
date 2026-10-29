import {
  BASE_ENV,
  captureHandler,
  emptyResponse,
  type FetchMatcher,
  installFetchMock,
  jsonResponse,
  setEnv,
} from "./_helpers.ts";
import {
  zappazAudio,
  zappazOutboundEcho,
  zappazProtocolEvent,
  zappazText,
} from "./_fixtures/inbound-payloads.ts";
import { cifrarMidiaWhatsApp, oggFalso } from "./_fixtures/whatsapp-media.ts";

/** Áudio cifrado com a mesma mediaKey da fixture `zappazAudio()`. */
const AUDIO_CIFRADO_FIXTURE = await cifrarMidiaWhatsApp(oggFalso(1200));

setEnv(BASE_ENV);

const handler = await captureHandler("../messaging-webhook/index.ts");

// ------- Estado do mock (controla as respostas do "banco" via fetch) -------

type Secret = { key: string; value: string };
type ChannelType = "whatsapp" | "email";

interface State {
  // webhook_token: opcional -- quando ausente, o router valida contra
  // DEFAULT_TENANT_INTEGRATION_TOKEN (o token usado por padrão em webhookUrl()).
  tenantIntegration: {
    tenant_id: string;
    slug: string;
    status: string;
    webhook_token?: string;
  } | null;
  // tenant_id/provider_slug/status: só usados pela query de autenticação NOVA
  // (channel_id+webhook_token, Fase 5) -- opcionais pra não exigir todo teste
  // legado a preenchê-los (a query antiga só lê id/type). webhook_token: idem
  // tenantIntegration acima, default DEFAULT_CHANNEL_WEBHOOK_TOKEN quando ausente.
  channel: {
    id: string;
    type: ChannelType;
    tenant_id?: string;
    provider_slug?: string;
    status?: string;
    webhook_token?: string;
  } | null;
  secrets: Secret[];
  // Simula falha de INFRAESTRUTURA na query de integration_secrets (timeout,
  // blip de conexão) -- diferente de "sem credencial configurada" (data
  // vazio, sem erro). Usado para provar que twilio/resend fecham o acesso
  // (401) em erro real de query, em vez de tratar como signing não configurado.
  secretsQueryError: boolean;
  // Erro de INFRA na resolução legada do canal. Fixa a DIREÇÃO do default do
  // handler: sem isto, inverter "503 por padrão / 200 só na allowlist" mantinha
  // a suíte verde e ressuscitava a perda silenciosa de inbound.
  channelQueryError: { code: string } | null;
  existingMessage:
    | {
      id: string;
      sender?: string;
      direction?: string;
      conversations?: { contact_id: string | null } | null;
    }
    | null;
  // Falha do PATCH de cancelamento: "error" devolve 400 (ramo `if (error)`),
  // "throw" derruba o fetch (o `catch`, que antes só fazia console.error).
  nurtureCancelMode: "ok" | "vazio" | "error" | "throw";
  existingContact: { id: string } | null;
  contactInsertError: boolean;
  contactInsertMissingId: boolean;
  existingConversation: { id: string; deleted_at?: string | null } | null;
  conversationInsertError: boolean;
  messageInsertMode: "ok" | "conflict" | "error";
  aiRespondStatus: number;
  aiRespondBody: unknown;
  aiRespondThrows: boolean;
  durableQueueEnabled: boolean;
  suppressionUpsertError: boolean;
  suppressionPatchError: boolean;
  suppressionExisting: boolean;
  suppressionSelectError: boolean;
  // Retorno da RPC bump_channel_webhook_failure (contador de falhas consecutivas
  // do canal, já incrementado). `null` = a RPC falha (erro de infra/função
  // ausente) -- que é o comportamento de hoje para todos os testes legados, onde
  // essa rota nem existia no mock e caía no 501 do catch-all.
  bumpFailureResult: number | null;
  // Erros de INFRA (não "linha ausente") nas leituras que decidiam regra de
  // negócio lendo `data == null`. Cada flag fixa a direção de um fix do review
  // 05-silent-failures: sem ela, reverter o fix mantém a suíte verde.
  channelAuthQueryError: boolean;
  tenantIntegrationQueryError: boolean;
  // string = código do erro devolvido pela consulta de dedupe. "PGRST116"
  // (múltiplas linhas) significa "a duplicata existe" e NÃO pode pedir retry:
  // o erro é determinístico e estouraria o teto, derrubando o canal do tenant.
  messageDedupeSelectError: string | null;
  conversationSelectError: boolean;
  webhookEvents: Map<
    string,
    { id: string; status: "processing" | "failed" | "completed"; attempt: number }
  >;
  calls: {
    messagesInsertBodies: Array<Record<string, unknown>>;
    contactsInsertBodies: Array<Record<string, unknown>>;
    conversationsInsertBodies: Array<Record<string, unknown>>;
    conversationsPatchBodies: Array<Record<string, unknown>>;
    aiRespondBodies: Array<Record<string, unknown>>;
    suppressionUpsertBodies: Array<Record<string, unknown>>;
    suppressionPatchCalls: Array<{ body: Record<string, unknown>; search: URLSearchParams }>;
    suppressionSelectCalls: Array<URLSearchParams>;
    systemEventsInsertBodies: Array<Record<string, unknown>>;
    cdnDownloads: number;
    storageUploads: string[];
    nurtureCancels: Array<{ body: Record<string, unknown>; search: URLSearchParams }>;
    // UPDATEs em `channels`: saúde do webhook ('ok' + zeramento do contador no
    // sucesso, 'broken' quando o teto de falhas consecutivas estoura).
    channelsPatchCalls: Array<{ body: Record<string, unknown>; search: URLSearchParams }>;
    // Chamadas à RPC bump_channel_webhook_failure (só no catch, e só com canal
    // resolvido -- falha de resolução de canal nunca conta para o teto).
    bumpFailureCalls: Array<Record<string, unknown>>;
    webhookClaimBodies: Array<Record<string, unknown>>;
    webhookEventPatchBodies: Array<Record<string, unknown>>;
    aiJobEnqueueBodies: Array<Record<string, unknown>>;
    aiJobPatchBodies: Array<Record<string, unknown>>;
    // Quantas vezes o handler leu integration_secrets. O guard `if (!ch)` tem que
    // rodar ANTES de qualquer leitura de 2º fator; contar as leituras é o que
    // torna o teste sensível à POSIÇÃO do guard, não só à existência dele.
    secretsSelectCount: number;
  };
}

function defaultState(): State {
  return {
    tenantIntegration: { tenant_id: "tenant-1", slug: "zapi", status: "active" },
    channel: { id: "chan-1", type: "whatsapp" },
    secrets: zapiSecrets(),
    secretsQueryError: false,
    channelQueryError: null,
    existingMessage: null,
    existingContact: null,
    contactInsertError: false,
    contactInsertMissingId: false,
    existingConversation: null,
    conversationInsertError: false,
    messageInsertMode: "ok",
    aiRespondStatus: 200,
    aiRespondBody: {},
    aiRespondThrows: false,
    durableQueueEnabled: false,
    suppressionUpsertError: false,
    suppressionPatchError: false,
    suppressionExisting: false,
    suppressionSelectError: false,
    bumpFailureResult: null,
    channelAuthQueryError: false,
    tenantIntegrationQueryError: false,
    messageDedupeSelectError: null,
    nurtureCancelMode: "ok",
    conversationSelectError: false,
    webhookEvents: new Map(),
    calls: {
      messagesInsertBodies: [],
      contactsInsertBodies: [],
      conversationsInsertBodies: [],
      conversationsPatchBodies: [],
      aiRespondBodies: [],
      suppressionUpsertBodies: [],
      suppressionPatchCalls: [],
      suppressionSelectCalls: [],
      systemEventsInsertBodies: [],
      cdnDownloads: 0,
      storageUploads: [],
      nurtureCancels: [],
      channelsPatchCalls: [],
      bumpFailureCalls: [],
      webhookClaimBodies: [],
      webhookEventPatchBodies: [],
      aiJobEnqueueBodies: [],
      aiJobPatchBodies: [],
      secretsSelectCount: 0,
    },
  };
}

// Default dos tokens esperados quando o teste não seeda um valor explícito
// -- casam com o token default de webhookUrl() ("tok-abc") e com o token usado
// pelos testes de canal novo da Fase 5 ("chan-webhook-tok").
const DEFAULT_TENANT_INTEGRATION_TOKEN = "tok-abc";
const DEFAULT_CHANNEL_WEBHOOK_TOKEN = "chan-webhook-tok";

// Client-Token: 2º fator OBRIGATÓRIO do webhook Z-API (finding L, fail-closed
// -- ver messaging-webhook/index.ts). Seedado por padrão em defaultState() e
// enviado por padrão em jsonReq() (abaixo) pra manter os ~30 call-sites de
// zapi (happy-path + opt-out/opt-in + ai-respond) verdes sem precisar
// repetir state.secrets/header em cada um; inofensivo pros outros providers
// (resend/telegram/evolution/meta-cloud não leem esse header, e evolution já
// sobrescreve state.secrets com seu próprio instance_token). Os negativos de
// Client-Token ausente/errado (perto da seção Z-API abaixo) constroem a
// Request manualmente, sem passar por esse default.
const ZAPI_CLIENT_TOKEN = "zapi-client-token-abc";
const zapiSecrets = () => [{ key: "client_token", value: ZAPI_CLIENT_TOKEN }];

// PostgREST manda o operador junto do valor (ex.: "eq.twilio", "in.(a,b)").
// Extrai só o valor para comparação -- mesmo padrão de evolution-watchdog.test.ts.
function stripOp(raw: string | null): string | null {
  return raw?.replace(/^[a-z]+\./, "") ?? null;
}

function router(state: State): FetchMatcher {
  return (req) => {
    const p = req.pathname;
    const sp = new URL(req.url).searchParams;

    // CDN do WhatsApp: devolve o mesmo áudio cifrado com a mediaKey da fixture,
    // para o re-hospedamento rodar de ponta a ponta no teste (baixa, decifra,
    // sobe, assina) em vez de morrer no primeiro fetch.
    if (p.endsWith(".enc")) {
      state.calls.cdnDownloads += 1;
      return new Response(AUDIO_CIFRADO_FIXTURE.buffer, {
        status: 200,
        headers: { "content-length": String(AUDIO_CIFRADO_FIXTURE.byteLength) },
      });
    }
    // Encerramento do acompanhamento automático quando o contato responde.
    if (p === "/rest/v1/nurture_enrollments" && req.method === "PATCH") {
      state.calls.nurtureCancels.push({
        body: (req.bodyJson ?? {}) as Record<string, unknown>,
        search: sp,
      });
      if (state.nurtureCancelMode === "throw") {
        throw new TypeError("error sending request for url (nurture_enrollments)");
      }
      if (state.nurtureCancelMode === "error") {
        return jsonResponse(400, { message: "cancelamento recusado", code: "PGRST116" });
      }
      if (state.nurtureCancelMode === "vazio") return jsonResponse(200, []);
      return jsonResponse(200, [{ id: "enr-1" }]);
    }
    // Storage: upload e assinatura do objeto re-hospedado.
    if (p.startsWith("/storage/v1/object/sign/") && req.method === "POST") {
      const caminho = p.replace("/storage/v1/object/sign/", "");
      return jsonResponse(200, { signedURL: `/object/sign/${caminho}?token=fixture` });
    }
    if (p.startsWith("/storage/v1/object/") && req.method === "POST") {
      state.calls.storageUploads.push(p.replace("/storage/v1/object/", ""));
      return jsonResponse(200, { Key: p.replace("/storage/v1/object/", "") });
    }

    if (p === "/rest/v1/tenant_integrations" && req.method === "GET") {
      // Filtro real: só devolve a linha se slug+webhook_token da query baterem
      // com o que foi seedado -- exercita de fato o `.eq(...)` da produção
      // (achado de review: antes o mock ignorava os params e sempre devolvia
      // o estado bruto, então um teste de "token inválido" nunca provava que
      // o filtro real existe, só que `state.tenantIntegration = null` funciona).
      if (state.tenantIntegrationQueryError) {
        return jsonResponse(500, { message: "tenant_integrations select failed", code: "XX000" });
      }
      const slug = stripOp(sp.get("slug"));
      const token = stripOp(sp.get("webhook_token"));
      const ti = state.tenantIntegration;
      const matches = !!ti &&
        slug === ti.slug &&
        token === (ti.webhook_token ?? DEFAULT_TENANT_INTEGRATION_TOKEN);
      return jsonResponse(200, matches && ti ? [ti] : []);
    }
    if (p === "/rest/v1/channels" && req.method === "GET") {
      const ch = state.channel;
      if (sp.has("id")) {
        // Caminho novo (channel_id + webhook_token, Fase 5).
        if (state.channelAuthQueryError) {
          return jsonResponse(500, { message: "channels auth select failed", code: "XX000" });
        }
        const id = stripOp(sp.get("id"));
        const token = stripOp(sp.get("webhook_token"));
        const matches = !!ch && id === ch.id &&
          token === (ch.webhook_token ?? DEFAULT_CHANNEL_WEBHOOK_TOKEN);
        return jsonResponse(200, matches && ch ? [ch] : []);
      }
      // Erro de INFRA na query legada (não "sem linha encontrada") — só aqui, o
      // caminho por id acima já retornou.
      if (state.channelQueryError) {
        return jsonResponse(500, {
          message: "channels select failed",
          code: state.channelQueryError.code,
        });
      }
      // Caminho legado (tenant_id + provider_slug + status=connected),
      // resolvido a partir do tenant/slug já autenticados via tenant_integrations.
      const tenantId = stripOp(sp.get("tenant_id"));
      const providerSlug = stripOp(sp.get("provider_slug"));
      const status = stripOp(sp.get("status"));
      const expectedTenantId = state.tenantIntegration?.tenant_id ?? null;
      const expectedSlug = state.tenantIntegration?.slug ?? null;
      const matches = !!ch &&
        tenantId === expectedTenantId &&
        providerSlug === expectedSlug &&
        status === "connected";
      return jsonResponse(200, matches && ch ? [ch] : []);
    }
    if (p === "/rest/v1/channels" && req.method === "PATCH") {
      // Saúde do webhook: 'ok' + webhook_consecutive_failures:0 no sucesso,
      // 'broken' quando o teto estoura. Antes esta rota não existia no mock e
      // caía no catch-all 501 -- o reset nunca era exercitado E todo inbound
      // bem-sucedido gravava um system_event falso de "reset_saude_canal".
      state.calls.channelsPatchCalls.push({
        body: req.bodyJson as Record<string, unknown>,
        search: new URL(req.url).searchParams,
      });
      return emptyResponse(200);
    }
    if (p === "/rest/v1/rpc/bump_channel_webhook_failure" && req.method === "POST") {
      state.calls.bumpFailureCalls.push(req.bodyJson as Record<string, unknown>);
      if (state.bumpFailureResult === null) {
        return jsonResponse(500, { message: "rpc indisponível", code: "XX000" });
      }
      // Função escalar do PostgREST devolve o valor CRU (ex.: `5`), não um
      // envelope -- envelopar aqui faria Number(bumped) virar NaN e o teste
      // acusaria bug de fronteira que não existe.
      return jsonResponse(200, state.bumpFailureResult);
    }
    if (p === "/rest/v1/rpc/claim_messaging_webhook_event" && req.method === "POST") {
      const body = req.bodyJson as Record<string, unknown>;
      state.calls.webhookClaimBodies.push(body);
      const externalId = String(body.p_external_event_id ?? "");
      const current = state.webhookEvents.get(externalId);
      if (!current) {
        const created = {
          id: `event-${externalId || "anonymous"}`,
          status: "processing" as const,
          attempt: 1,
        };
        state.webhookEvents.set(externalId, created);
        return jsonResponse(200, [
          { event_id: created.id, claim_state: "claimed", attempt: created.attempt },
        ]);
      }
      if (current.status === "failed") {
        current.status = "processing";
        current.attempt += 1;
        return jsonResponse(200, [
          { event_id: current.id, claim_state: "reclaimed", attempt: current.attempt },
        ]);
      }
      return jsonResponse(200, [
        {
          event_id: current.id,
          claim_state: current.status === "completed" ? "completed" : "busy",
          attempt: current.attempt,
        },
      ]);
    }
    if (p === "/rest/v1/rpc/enqueue_ai_response_job" && req.method === "POST") {
      state.calls.aiJobEnqueueBodies.push(req.bodyJson as Record<string, unknown>);
      return jsonResponse(200, [{ job_id: "job-ai-1", should_dispatch: true }]);
    }
    if (p === "/rest/v1/tenant_ai_features" && req.method === "GET") {
      return jsonResponse(200, { enabled: state.durableQueueEnabled });
    }
    if (p === "/rest/v1/job_queue" && req.method === "PATCH") {
      state.calls.aiJobPatchBodies.push(req.bodyJson as Record<string, unknown>);
      return emptyResponse(200);
    }
    if (p === "/rest/v1/messaging_webhook_events" && req.method === "PATCH") {
      const body = req.bodyJson as Record<string, unknown>;
      state.calls.webhookEventPatchBodies.push(body);
      const id = stripOp(sp.get("id"));
      const event = [...state.webhookEvents.values()].find((candidate) => candidate.id === id);
      if (event && body.status === "failed") event.status = "failed";
      if (event && (body.status === "completed" || body.processed === true)) {
        event.status = "completed";
      }
      return emptyResponse(200);
    }
    if (p === "/rest/v1/integration_secrets" && req.method === "GET") {
      state.calls.secretsSelectCount++;
      // Simula erro de INFRAESTRUTURA na query (não "sem linha encontrada").
      if (state.secretsQueryError) {
        return jsonResponse(500, { message: "connection reset by peer", code: "XX000" });
      }
      // Válido se bater com o tenant/slug resolvido pelo caminho legado
      // (tenant_integrations) OU pelo caminho novo (channel) -- qual dos dois
      // está ativo depende de qual autenticou a request atual; ambos são
      // checados porque este mock não rastreia "qual caminho rodou agora".
      const tenantId = stripOp(sp.get("tenant_id"));
      const slug = stripOp(sp.get("slug"));
      const ti = state.tenantIntegration;
      const ch = state.channel;
      const matchesTi = !!ti && tenantId === ti.tenant_id && slug === ti.slug;
      const matchesCh = !!ch && tenantId === (ch.tenant_id ?? null) &&
        slug === (ch.provider_slug ?? null);
      if (!matchesTi && !matchesCh) return jsonResponse(200, []);
      return jsonResponse(200, state.secrets);
    }
    if (p === "/rest/v1/messages" && req.method === "GET") {
      if (state.messageDedupeSelectError) {
        return jsonResponse(500, {
          message: "messages dedupe select failed",
          code: state.messageDedupeSelectError,
        });
      }
      return jsonResponse(200, state.existingMessage ? [state.existingMessage] : []);
    }
    if (p === "/rest/v1/messages" && req.method === "POST") {
      state.calls.messagesInsertBodies.push(req.bodyJson as Record<string, unknown>);
      if (state.messageInsertMode === "conflict") {
        return jsonResponse(409, {
          message: "duplicate key value violates unique constraint",
          code: "23505",
        });
      }
      if (state.messageInsertMode === "error") {
        return jsonResponse(500, { message: "insert failed", code: "XX000" });
      }
      // .select("id").single() em POST => Accept: application/vnd.pgrst.object+json,
      // sem unwrap no client — o "servidor" precisa devolver o objeto puro, não array.
      return jsonResponse(201, { id: "msg-new-1" });
    }
    if (p === "/rest/v1/contacts" && req.method === "GET") {
      return jsonResponse(200, state.existingContact ? [state.existingContact] : []);
    }
    if (p === "/rest/v1/contacts" && req.method === "POST") {
      state.calls.contactsInsertBodies.push(req.bodyJson as Record<string, unknown>);
      if (state.contactInsertError) {
        return jsonResponse(500, { message: "contact insert failed", code: "XX000" });
      }
      if (state.contactInsertMissingId) {
        return jsonResponse(201, {});
      }
      return jsonResponse(201, { id: "contact-new-1" });
    }
    if (p === "/rest/v1/conversations" && req.method === "GET") {
      if (state.conversationSelectError) {
        return jsonResponse(500, { message: "conversations select failed", code: "XX000" });
      }
      return jsonResponse(200, state.existingConversation ? [state.existingConversation] : []);
    }
    if (p === "/rest/v1/conversations" && req.method === "POST") {
      state.calls.conversationsInsertBodies.push(req.bodyJson as Record<string, unknown>);
      if (state.conversationInsertError) {
        return jsonResponse(500, { message: "conversation insert failed", code: "XX000" });
      }
      return jsonResponse(201, { id: "conv-new-1" });
    }
    if (p === "/rest/v1/conversations" && req.method === "PATCH") {
      state.calls.conversationsPatchBodies.push(req.bodyJson as Record<string, unknown>);
      return emptyResponse(200);
    }
    if (p === "/functions/v1/ai-respond" && req.method === "POST") {
      // Este disparo roda em runInBackground (EdgeRuntime.waitUntil): ninguém
      // espera a resposta, então sem deadline ele pendura o isolate do webhook.
      // Asserção no router, não em step próprio, pra valer em todo teste que
      // chega no ai-respond. Só a presença do signal — AbortSignal não expõe o
      // valor do timeout.
      if (!(req.signal instanceof AbortSignal)) {
        throw new Error("fetch do ai-respond sem AbortSignal: deadline removido");
      }
      state.calls.aiRespondBodies.push(req.bodyJson as Record<string, unknown>);
      if (state.aiRespondThrows) throw new Error("network down");
      return jsonResponse(state.aiRespondStatus, state.aiRespondBody);
    }
    if (p === "/rest/v1/messaging_phone_suppressions" && req.method === "POST") {
      // .upsert(...) do caminho de opt-out por keyword.
      state.calls.suppressionUpsertBodies.push(req.bodyJson as Record<string, unknown>);
      if (state.suppressionUpsertError) {
        return jsonResponse(500, { message: "upsert failed", code: "XX000" });
      }
      // Espelha o efeito real no DB: a linha passa a existir com
      // reactivated_at=null, então isPhoneSuppressed (GET com is.null) volta true.
      state.suppressionExisting = true;
      return jsonResponse(201, []);
    }
    if (p === "/rest/v1/messaging_phone_suppressions" && req.method === "GET") {
      // isPhoneSuppressed (_shared/messaging/conversation.ts) -- checagem de
      // supressão durável antes de disparar a IA.
      const search = new URL(req.url).searchParams;
      state.calls.suppressionSelectCalls.push(search);
      if (state.suppressionSelectError) {
        return jsonResponse(500, { message: "select failed", code: "XX000" });
      }
      return jsonResponse(200, state.suppressionExisting ? [{ id: "sup-1" }] : []);
    }
    if (p === "/rest/v1/messaging_phone_suppressions" && req.method === "PATCH") {
      // .update(...) do caminho de opt-in por keyword.
      const search = new URL(req.url).searchParams;
      state.calls.suppressionPatchCalls.push({
        body: req.bodyJson as Record<string, unknown>,
        search,
      });
      if (state.suppressionPatchError) {
        return jsonResponse(500, { message: "update failed", code: "XX000" });
      }
      // Espelha o efeito real no DB: reactivated_at deixa de ser null, então
      // isPhoneSuppressed (GET com is.null) volta a não encontrar a linha.
      state.suppressionExisting = false;
      return jsonResponse(200, []);
    }
    if (p === "/rest/v1/system_events" && req.method === "POST") {
      // Sink de telemetria (captureEdgeError). Registrado para o teste de
      // regressão do CRITICAL: no caminho "canal não conectado" NENHUMA linha
      // pode ser escrita aqui (é escrita controlada por quem tem só o token da
      // URL, antes de qualquer 2º fator).
      state.calls.systemEventsInsertBodies.push(req.bodyJson as Record<string, unknown>);
      return jsonResponse(201, []);
    }
    return undefined;
  };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 8; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function webhookUrl(slug: string, params: Record<string, string> = { token: "tok-abc" }): string {
  const qs = new URLSearchParams(params);
  const suffix = qs.toString();
  return `http://fn.local/functions/v1/messaging-webhook/${slug}${suffix ? `?${suffix}` : ""}`;
}

function jsonReq(
  slug: string,
  body: unknown,
  params?: Record<string, string>,
  extraHeaders: Record<string, string> = {},
): Request {
  return new Request(webhookUrl(slug, params), {
    method: "POST",
    // Client-Token vai por padrão em toda request (ver comentário de
    // ZAPI_CLIENT_TOKEN acima) -- extraHeaders pode sobrescrever se um teste
    // precisar de um valor diferente.
    headers: {
      "content-type": "application/json",
      "Client-Token": ZAPI_CLIENT_TOKEN,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

function formReq(
  slug: string,
  form: URLSearchParams,
  extraHeaders: Record<string, string> = {},
  params?: Record<string, string>,
): Request {
  return new Request(webhookUrl(slug, params), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...extraHeaders },
    body: form.toString(),
  });
}

// ------- Réplicas dos algoritmos de assinatura (usadas só pra gerar valores de teste) -------

async function computeTwilioSignature(
  authToken: string,
  fullUrl: string,
  form: URLSearchParams,
): Promise<string> {
  const keys: string[] = [];
  form.forEach((_v, k) => {
    if (!keys.includes(k)) keys.push(k);
  });
  keys.sort();
  const params = keys.map((k) => k + (form.get(k) ?? ""));
  const data = fullUrl + params.join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  return btoa(String.fromCharCode(...new Uint8Array(sig)));
}

async function computeSvixSignature(
  signingSecret: string,
  svixId: string,
  svixTs: string,
  body: string,
): Promise<string> {
  const secret = signingSecret.startsWith("whsec_") ? signingSecret.slice(6) : signingSecret;
  let keyBytes: Uint8Array<ArrayBuffer>;
  try {
    keyBytes = Uint8Array.from(atob(secret), (c) => c.charCodeAt(0));
  } catch {
    keyBytes = new TextEncoder().encode(secret);
  }
  const toSign = `${svixId}.${svixTs}.${body}`;
  const key = await crypto.subtle.importKey(
    "raw",
    keyBytes,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(toSign));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return `v1,${b64}`;
}

Deno.test("messaging-webhook", async (t) => {
  await t.step("OPTIONS responde CORS sem corpo", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(new Request(webhookUrl("zapi"), { method: "OPTIONS" }));
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (await res.text()) throw new Error("esperado corpo vazio");
    } finally {
      uninstall();
    }
  });

  await t.step("sem token retorna 401", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request("http://fn.local/functions/v1/messaging-webhook/zapi", {
          method: "POST",
          body: "{}",
        }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("sem slug (path raiz) retorna 401", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request("http://fn.local/?token=tok-abc", { method: "POST", body: "{}" }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("tenant_integration não encontrado retorna 401", async () => {
    const state = defaultState();
    state.tenantIntegration = null;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        jsonReq("zapi", { messageId: "m1", phone: "5511999999999", text: { message: "oi" } }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("tenant_integration com status inativo retorna 401", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "zapi", status: "inactive" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(jsonReq("zapi", { messageId: "m1", phone: "5511999999999" }));
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("verificação GET da Meta com verify_token correto retorna o challenge", async () => {
    const state = defaultState();
    // Precisa bater com o slug da URL ("meta-cloud") agora que o mock valida
    // de fato slug+webhook_token na query de tenant_integrations -- antes
    // passava "por sorte" com o tenantIntegration default (slug "zapi").
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        new Request(
          webhookUrl("meta-cloud", {
            token: "tok-abc",
            "hub.mode": "subscribe",
            "hub.verify_token": "tok-abc",
            "hub.challenge": "desafio-123",
          }),
          { method: "GET" },
        ),
      );
      const body = await res.text();
      if (res.status !== 200 || body !== "desafio-123") {
        throw new Error(`inesperado: ${res.status} ${body}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("verificação GET da Meta com verify_token incorreto retorna 401", async () => {
    const uninstall = installFetchMock(router(defaultState()));
    try {
      const res = await handler(
        new Request(
          webhookUrl("meta-cloud", {
            token: "tok-abc",
            "hub.mode": "subscribe",
            "hub.verify_token": "errado",
            "hub.challenge": "desafio-123",
          }),
          { method: "GET" },
        ),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "canal não encontrado: erro é logado e ainda responde 200 sem persistir",
    async () => {
      const state = defaultState();
      state.channel = null;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", { messageId: "m1", phone: "5511999999999", text: { message: "oi" } }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria ter persistido");
        }
        // Regressão do CRITICAL: o guard `if (!ch)` tem que ficar FORA do try. Se
        // voltar para dentro, a exceção cai no catch e grava system_events com
        // corpo escolhido pelo remetente — só com o token da URL, sem 2º fator e
        // sem rate limit. Sem esta asserção, mover o guard mantém a suíte verde.
        if (state.calls.systemEventsInsertBodies.length !== 0) {
          throw new Error("não deveria ter escrito telemetria antes do 2º fator");
        }
        // A asserção acima só pega o guard REMOVIDO. Se alguém o MOVER para depois
        // do 2º fator, ela continua verde (o Client-Token bate) e o invariante de
        // segurança quebra sem ninguém ver. Este step usa Z-API, que lê
        // integration_secrets para validar o Client-Token: zero leituras prova que
        // o guard rodou ANTES, não só que rodou.
        if (state.calls.secretsSelectCount !== 0) {
          throw new Error("guard deve rodar ANTES de qualquer leitura de 2º fator");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro transitório ao resolver canal responde 503 (provider reentrega, inbound não se perde)",
    async () => {
      const state = defaultState();
      // Rede caída chega SEM code — é o caso que fixa a direção do default.
      state.channelQueryError = { code: "" };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", { messageId: "m1", phone: "5511999999999", text: { message: "oi" } }),
        );
        await res.text();
        if (res.status !== 503) throw new Error(`esperado 503, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria ter persistido");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "erro permanente (42703) ao resolver canal responde 200: 5xx infinito faria o provider desabilitar a assinatura",
    async () => {
      const state = defaultState();
      state.channelQueryError = { code: "42703" };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", { messageId: "m1", phone: "5511999999999", text: { message: "oi" } }),
        );
        await res.text();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria ter persistido");
        }
        // O 200 aqui não é "tudo certo": o rastro da causa real fica no
        // system_event de resolver_canal, não no log de "canal não conectado".
        if (state.calls.systemEventsInsertBodies.length === 0) {
          throw new Error("erro permanente tem que deixar rastro em system_events");
        }
      } finally {
        uninstall();
      }
    },
  );

  // ------- Z-API -------

  await t.step(
    "zapi: mensagem de texto cria contato+conversa+mensagem e dispara ai-respond",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m1",
            phone: "5511999999999",
            fromMe: false,
            text: { message: "Olá" },
            senderName: "Fulano",
          }),
        );
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.contactsInsertBodies.length !== 1) {
          throw new Error("esperava 1 insert de contato");
        }
        if (state.calls.conversationsInsertBodies.length !== 1) {
          throw new Error("esperava 1 insert de conversa");
        }
        if (state.calls.messagesInsertBodies.length !== 1) {
          throw new Error("esperava 1 insert de mensagem");
        }
        const msgBody = state.calls.messagesInsertBodies[0];
        if (
          msgBody.content !== "Olá" ||
          msgBody.sender !== "contact" ||
          msgBody.direction !== "in"
        ) {
          throw new Error(`corpo inesperado: ${JSON.stringify(msgBody)}`);
        }
        if (
          state.calls.aiRespondBodies.length !== 1 ||
          state.calls.aiRespondBodies[0].message_id !== "msg-new-1"
        ) {
          throw new Error(
            `ai-respond não disparado corretamente: ${JSON.stringify(state.calls.aiRespondBodies)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "zapi: payload JSON malformado não normaliza, responde 200 sem persistir",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          new Request(webhookUrl("zapi"), {
            method: "POST",
            headers: { "content-type": "application/json", "Client-Token": ZAPI_CLIENT_TOKEN },
            body: "{not-json",
          }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria ter persistido");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "fila durável ligada deixa o job pending para o worker e não dispara direto",
    async () => {
      const state = defaultState();
      state.durableQueueEnabled = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-queue-enabled",
            phone: "5511999999999",
            fromMe: false,
            text: { message: "Olá pela fila" },
          }),
        );
        await flush();
        await res.text();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (state.calls.aiJobEnqueueBodies.length !== 1) {
          throw new Error("fila ligada deve persistir exatamente um job");
        }
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("fila ligada não pode disparar ai-respond no webhook");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("zapi: sem messageId não normaliza (external_id ausente)", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        jsonReq("zapi", { phone: "5511999999999", text: { message: "oi" } }),
      );
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error("não deveria ter persistido");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: imagem com mimeType informado é preservado", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-img-1",
          phone: "5511999999999",
          image: { imageUrl: "https://x/img.png", caption: "legenda", mimeType: "image/png" },
        }),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_type !== "image/png" || msgBody.content !== "legenda") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: imagem sem mimeType usa fallback image/jpeg", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-img-2",
          phone: "5511999999999",
          image: { imageUrl: "https://x/img" },
        }),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_type !== "image/jpeg") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: áudio sem mimeType usa fallback audio/ogg", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-audio-1",
          phone: "5511999999999",
          audio: { audioUrl: "https://x/audio" },
        }),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_type !== "audio/ogg" || msgBody.media_url !== "https://x/audio") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: vídeo com caption e mimeType informado", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-video-1",
          phone: "5511999999999",
          video: { videoUrl: "https://x/video.mp4", caption: "olha isso", mimeType: "video/mp4" },
        }),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "olha isso" || msgBody.media_type !== "video/mp4") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: documento sem mimeType usa fallback application/octet-stream", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-doc-1",
          phone: "5511999999999",
          document: { documentUrl: "https://x/doc.pdf", caption: "contrato" },
        }),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_type !== "application/octet-stream" || msgBody.content !== "contrato") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: sem tipo suportado usa '[mensagem não suportada]'", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(jsonReq("zapi", { messageId: "m-unk-1", phone: "5511999999999" }));
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "[mensagem não suportada]") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: fromMe=true inverte from/to e não dispara ai-respond", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-out-1",
          phone: "5511999999999",
          connectedPhone: "5511888888888",
          fromMe: true,
          text: { message: "resposta do agente" },
        }),
      );
      await flush();
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.sender !== "agent" || msgBody.direction !== "out") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.phone !== "+5511999999999") {
        throw new Error(`telefone inesperado: ${JSON.stringify(contactBody)}`);
      }
      if (state.calls.aiRespondBodies.length !== 0) {
        throw new Error("não deveria disparar ai-respond pra mensagem própria");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: telefone com formatação normaliza pra E.164 puro", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-fmt-1",
          phone: "+55 (11) 99999-9999",
          text: { message: "oi" },
        }),
      );
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.phone !== "+5511999999999") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: contato já existente é reaproveitado", async () => {
    const state = defaultState();
    state.existingContact = { id: "contact-existing" };
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-existing-c",
          phone: "5511999999999",
          text: { message: "oi" },
        }),
      );
      if (state.calls.contactsInsertBodies.length !== 0) {
        throw new Error("não deveria inserir contato novo");
      }
      if (state.calls.messagesInsertBodies.length !== 1) {
        throw new Error("deveria persistir a mensagem mesmo assim");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: conversa aberta existente é reaproveitada", async () => {
    const state = defaultState();
    state.existingConversation = { id: "conv-existing" };
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("zapi", {
          messageId: "m-existing-conv",
          phone: "5511999999999",
          text: { message: "oi" },
        }),
      );
      if (state.calls.conversationsInsertBodies.length !== 0) {
        throw new Error("não deveria inserir conversa nova");
      }
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.conversation_id !== "conv-existing") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "zapi: conversa soft-deletada ressuscita (deleted_at volta a null) no inbound",
    async () => {
      const state = defaultState();
      state.existingConversation = { id: "conv-deleted", deleted_at: "2026-07-19T12:00:00Z" };
      const uninstall = installFetchMock(router(state));
      try {
        await handler(
          jsonReq("zapi", {
            messageId: "m-resurrect",
            phone: "5511999999999",
            text: { message: "voltei" },
          }),
        );
        if (state.calls.conversationsInsertBodies.length !== 0) {
          throw new Error("não deveria criar conversa nova — a soft-deletada é reaproveitada");
        }
        if (state.calls.conversationsPatchBodies.length !== 1) {
          throw new Error(
            `esperava 1 PATCH de conversa (limpar deleted_at), veio ${state.calls.conversationsPatchBodies.length}`,
          );
        }
        const patch = state.calls.conversationsPatchBodies[0];
        if (patch.deleted_at !== null || !("deleted_at" in patch)) {
          throw new Error(`esperava deleted_at:null no PATCH, veio ${JSON.stringify(patch)}`);
        }
        const msgBody = state.calls.messagesInsertBodies[0];
        if (msgBody.conversation_id !== "conv-deleted") {
          throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "zapi: mensagem duplicada (dedupe por external_id) não persiste nem dispara IA",
    async () => {
      const state = defaultState();
      state.existingMessage = { id: "already-there" };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", { messageId: "m-dup", phone: "5511999999999", text: { message: "oi" } }),
        );
        await flush();
        if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
        if (state.calls.contactsInsertBodies.length !== 0) {
          throw new Error("não deveria inserir contato");
        }
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria inserir mensagem");
        }
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("não deveria disparar ai-respond");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("zapi: contactIdentifier vazio (telefone ausente) não persiste", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        jsonReq("zapi", { messageId: "m-no-phone", phone: "", text: { message: "oi" } }),
      );
      if (res.status !== 200) throw new Error(`esperado 200, veio ${res.status}`);
      if (state.calls.contactsInsertBodies.length !== 0) {
        throw new Error("não deveria inserir contato");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: erro ao inserir contato é logado e responde 200", async () => {
    const state = defaultState();
    state.contactInsertError = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        jsonReq("zapi", { messageId: "m-cerr", phone: "5511999999999", text: { message: "oi" } }),
      );
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error("não deveria chegar a inserir mensagem");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: erro ao inserir conversa é logado e responde 200", async () => {
    const state = defaultState();
    state.conversationInsertError = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        jsonReq("zapi", { messageId: "m-coverr", phone: "5511999999999", text: { message: "oi" } }),
      );
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error("não deveria chegar a inserir mensagem");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "zapi: conflito 23505 ao inserir mensagem é tratado sem lançar, responde 200",
    async () => {
      const state = defaultState();
      state.messageInsertMode = "conflict";
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-conflict",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("não deveria disparar ai-respond em conflito");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("zapi: erro genérico ao inserir mensagem é logado e responde 200", async () => {
    const state = defaultState();
    state.messageInsertMode = "error";
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        jsonReq("zapi", { messageId: "m-generr", phone: "5511999999999", text: { message: "oi" } }),
      );
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
    } finally {
      uninstall();
    }
  });

  // Fail-closed (finding L): o Client-Token é 2º fator obrigatório -- sem ele
  // (ou com o valor errado) o request é rejeitado ANTES de normalizar/persistir,
  // mesmo padrão de twilio (x-twilio-signature) e resend (svix-signature) acima.
  await t.step("zapi: sem Client-Token (2º fator ausente) retorna 401 (fail-closed)", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        new Request(webhookUrl("zapi"), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            messageId: "m-no-client-token",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("zapi: Client-Token incorreto (não bate com o seedado) retorna 401", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        new Request(webhookUrl("zapi"), {
          method: "POST",
          headers: { "content-type": "application/json", "Client-Token": "token-errado" },
          body: JSON.stringify({
            messageId: "m-wrong-client-token",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  // ------- Twilio -------

  const twilioForm = (extra: Record<string, string> = {}) =>
    new URLSearchParams({
      MessageSid: "SM123",
      From: "whatsapp:+5511999999999",
      To: "whatsapp:+5511888888888",
      Body: "Oi via Twilio",
      NumMedia: "0",
      ProfileName: "Fulano Twilio",
      ...extra,
    });

  // Fail-closed: todo request twilio legítimo agora exige assinatura válida —
  // helper assina o form com o auth_token padrão usado nos mocks.
  const TWILIO_AUTH_TOKEN = "secret-token";
  const twilioSecrets = () => [{ key: "auth_token", value: TWILIO_AUTH_TOKEN }];
  const signedTwilioReq = async (form: URLSearchParams): Promise<Request> => {
    const url = webhookUrl("twilio");
    const signature = await computeTwilioSignature(TWILIO_AUTH_TOKEN, url, form);
    return new Request(url, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        "x-twilio-signature": signature,
      },
      body: form.toString(),
    });
  };

  await t.step("twilio: sem credenciais configuradas retorna 401 (fail-closed)", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(formReq("twilio", twilioForm()));
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "twilio: credenciais configuradas sem header de assinatura retorna 401",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
      state.secrets = [{ key: "auth_token", value: "secret-token" }];
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(formReq("twilio", twilioForm()));
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
      } finally {
        uninstall();
      }
    },
  );

  await t.step("twilio: assinatura inválida retorna 401", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = [{ key: "auth_token", value: "secret-token" }];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        formReq("twilio", twilioForm(), { "x-twilio-signature": "assinatura-errada==" }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: assinatura válida processa e persiste a mensagem", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = [{ key: "auth_token", value: "secret-token" }];
    const uninstall = installFetchMock(router(state));
    try {
      const form = twilioForm();
      const url = webhookUrl("twilio");
      const signature = await computeTwilioSignature("secret-token", url, form);
      const res = await handler(
        new Request(url, {
          method: "POST",
          headers: {
            "content-type": "application/x-www-form-urlencoded",
            "x-twilio-signature": signature,
          },
          body: form.toString(),
        }),
      );
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 1) {
        throw new Error("deveria ter persistido a mensagem");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: sem MessageSid nem SmsSid não normaliza", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = twilioSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const form = twilioForm({ MessageSid: "" });
      form.delete("MessageSid");
      const res = await handler(await signedTwilioReq(form));
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: SmsSid é aceito como external_id quando MessageSid falta", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = twilioSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const form = twilioForm();
      form.delete("MessageSid");
      form.set("SmsSid", "SM-sms-1");
      await handler(await signedTwilioReq(form));
      if (state.calls.messagesInsertBodies.length !== 1) {
        throw new Error("deveria persistir usando SmsSid");
      }
      if (state.calls.messagesInsertBodies[0].external_id !== "SM-sms-1") {
        throw new Error(`inesperado: ${JSON.stringify(state.calls.messagesInsertBodies[0])}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: mídia com NumMedia>0 e MediaUrl0 inclui mídia", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = twilioSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const form = twilioForm({
        NumMedia: "1",
        MediaUrl0: "https://x/media.jpg",
        MediaContentType0: "image/jpeg",
      });
      await handler(await signedTwilioReq(form));
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_url !== "https://x/media.jpg" || msgBody.media_type !== "image/jpeg") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: NumMedia>0 sem MediaUrl0 não inclui mídia", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = twilioSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const form = twilioForm({ NumMedia: "1" });
      await handler(await signedTwilioReq(form));
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_url !== null || msgBody.media_type !== null) {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: strip do prefixo whatsapp: nos números from/to", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = twilioSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(await signedTwilioReq(twilioForm()));
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.phone !== "+5511999999999") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("twilio: sem ProfileName usa o telefone como nome do contato", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
    state.secrets = twilioSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const form = twilioForm();
      form.delete("ProfileName");
      await handler(await signedTwilioReq(form));
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.name !== "+5511999999999") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "twilio: erro na query de integration_secrets retorna 401 (fail-closed, não trata como signing ausente)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "twilio", status: "active" };
      state.secretsQueryError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(formReq("twilio", twilioForm()));
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
      } finally {
        uninstall();
      }
    },
  );

  // ------- Resend -------

  const resendPayload = (overrides: Record<string, unknown> = {}) => ({
    type: "email.received",
    data: {
      email_id: "email-1",
      from: '"Fulano da Silva" <fulano@ex.com>',
      to: "contato@empresa.com",
      subject: "Assunto",
      text: "Corpo em texto puro",
      created_at: "2026-01-10T00:00:00.000Z",
      ...overrides,
    },
  });

  // Fail-closed: todo request resend legítimo agora exige assinatura Svix
  // válida — helper assina o corpo com o signing secret padrão dos mocks.
  const RESEND_SIGNING_SECRET = "whsec_c2VjcmV0";
  const resendSecrets = () => [{ key: "webhook_signing_secret", value: RESEND_SIGNING_SECRET }];
  const signedResendReq = async (payload: unknown): Promise<Request> => {
    const body = JSON.stringify(payload);
    const svixId = "msg-signed";
    // Lote 3: verifySvix agora rejeita timestamps fora da janela de ±300s.
    // Assina com o "agora" para não falhar por drift; o svix-timestamp é
    // texto no header, independente do timestamp de payload (Meta/Resend).
    const svixTs = Math.floor(Date.now() / 1000).toString();
    const signature = await computeSvixSignature(RESEND_SIGNING_SECRET, svixId, svixTs, body);
    return new Request(webhookUrl("resend"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "svix-id": svixId,
        "svix-timestamp": svixTs,
        "svix-signature": signature,
      },
      body,
    });
  };

  await t.step(
    "resend: e-mail recebido com corpo texto persiste como contato de e-mail",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
      state.channel = { id: "chan-email", type: "email" };
      state.secrets = resendSecrets();
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(await signedResendReq(resendPayload()));
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        const contactBody = state.calls.contactsInsertBodies[0];
        if (contactBody.email !== "fulano@ex.com" || contactBody.name !== "Fulano da Silva") {
          throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
        }
        const msgBody = state.calls.messagesInsertBodies[0];
        if (msgBody.content !== "Corpo em texto puro") {
          throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
        }
        if (state.calls.aiRespondBodies.length !== 1) {
          throw new Error("deveria disparar ai-respond");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("resend: sem signing secret retorna 401 (fail-closed)", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(jsonReq("resend", resendPayload({ email_id: "email-nosig" })));
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("resend: signing secret configurado sem headers svix retorna 401", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = [{ key: "webhook_signing_secret", value: "whsec_c2VjcmV0" }];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(jsonReq("resend", resendPayload()));
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "resend: erro na query de integration_secrets retorna 401 (fail-closed, não trata como signing ausente)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
      state.channel = { id: "chan-email", type: "email" };
      state.secretsQueryError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(jsonReq("resend", resendPayload()));
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
      } finally {
        uninstall();
      }
    },
  );

  await t.step("resend: assinatura svix inválida retorna 401", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = [{ key: "webhook_signing_secret", value: "whsec_c2VjcmV0" }];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        new Request(webhookUrl("resend"), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "svix-id": "msg-1",
            "svix-timestamp": "1700000000",
            "svix-signature": "v1,assinatura-errada",
          },
          body: JSON.stringify(resendPayload()),
        }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "resend: assinatura svix válida (com prefixo whsec_) processa normalmente",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
      state.channel = { id: "chan-email", type: "email" };
      state.secrets = [{ key: "webhook_signing_secret", value: "whsec_c2VjcmV0" }];
      const uninstall = installFetchMock(router(state));
      try {
        const body = JSON.stringify(resendPayload({ email_id: "email-signed" }));
        const svixId = "msg-1";
        const svixTs = Math.floor(Date.now() / 1000).toString();
        const signature = await computeSvixSignature("whsec_c2VjcmV0", svixId, svixTs, body);
        const res = await handler(
          new Request(webhookUrl("resend"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "svix-id": svixId,
              "svix-timestamp": svixTs,
              "svix-signature": signature,
            },
            body,
          }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.messagesInsertBodies.length !== 1) {
          throw new Error("deveria ter persistido");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "resend: assinatura svix válida com secret não-base64 (fallback TextEncoder)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
      state.channel = { id: "chan-email", type: "email" };
      const rawSecret = "segredo-nao-base64!!";
      state.secrets = [{ key: "webhook_signing_secret", value: rawSecret }];
      const uninstall = installFetchMock(router(state));
      try {
        const body = JSON.stringify(resendPayload({ email_id: "email-plain-secret" }));
        const svixId = "msg-2";
        const svixTs = Math.floor(Date.now() / 1000).toString();
        const signature = await computeSvixSignature(rawSecret, svixId, svixTs, body);
        const res = await handler(
          new Request(webhookUrl("resend"), {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "svix-id": svixId,
              "svix-timestamp": svixTs,
              "svix-signature": signature,
            },
            body,
          }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("resend: type não-inbound não normaliza", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(await signedResendReq({ type: "email.sent", data: { email_id: "x" } }));
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("resend: sem external_id não normaliza", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq({ type: "email.received", data: { from: "a@x.com", to: "b@x.com" } }),
      );
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("resend: formato 'flat' sem wrapper data usa o payload direto", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq({
          email_id: "email-flat",
          from: "flat@ex.com",
          to: "dest@ex.com",
          text: "corpo flat",
        }),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "corpo flat") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.email !== "flat@ex.com") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resend: sem texto usa html stripado como conteúdo", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq(
          resendPayload({
            email_id: "email-html",
            text: undefined,
            html: "<p>Olá  <b>mundo</b></p>",
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "Olá mundo") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resend: sem texto nem html usa '[e-mail sem corpo]'", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq(resendPayload({ email_id: "email-empty", text: undefined })),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "[e-mail sem corpo]") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resend: attachment sem url não inclui mídia", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq(
          resendPayload({
            email_id: "email-att-no-url",
            attachments: [{ content_type: "application/pdf" }],
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.media_url !== null) throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
    } finally {
      uninstall();
    }
  });

  await t.step("resend: attachment com url inclui mídia com mime fallback", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq(
          resendPayload({ email_id: "email-att", attachments: [{ url: "https://x/anexo.pdf" }] }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (
        msgBody.media_url !== "https://x/anexo.pdf" ||
        msgBody.media_type !== "application/octet-stream"
      ) {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resend: from sem nome (só e-mail) não extrai senderName", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedResendReq(resendPayload({ email_id: "email-noname", from: "semnome@ex.com" })),
      );
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.name !== "semnome@ex.com") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resend: contato de e-mail já existente é reaproveitado", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    state.existingContact = { id: "contact-email-existing" };
    const uninstall = installFetchMock(router(state));
    try {
      await handler(await signedResendReq(resendPayload({ email_id: "email-existing-contact" })));
      if (state.calls.contactsInsertBodies.length !== 0) {
        throw new Error("não deveria inserir contato novo");
      }
      if (state.calls.messagesInsertBodies.length !== 1) {
        throw new Error("deveria persistir a mensagem mesmo assim");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("resend: erro ao inserir contato de e-mail é logado e responde 200", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    state.contactInsertError = true;
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        await signedResendReq(resendPayload({ email_id: "email-contact-error" })),
      );
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error("não deveria chegar a inserir mensagem");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "resend: contato inserido sem id retorna sem persistir mensagem (defensivo)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
      state.channel = { id: "chan-email", type: "email" };
      state.secrets = resendSecrets();
      state.contactInsertMissingId = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          await signedResendReq(resendPayload({ email_id: "email-contact-no-id" })),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria persistir mensagem sem contactId");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("resend: conversa existente com subject atualiza via PATCH", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "resend", status: "active" };
    state.channel = { id: "chan-email", type: "email" };
    state.secrets = resendSecrets();
    state.existingConversation = { id: "conv-email-existing" };
    const uninstall = installFetchMock(router(state));
    try {
      await handler(await signedResendReq(resendPayload({ email_id: "email-subject-update" })));
      if (state.calls.conversationsPatchBodies.length !== 1) {
        throw new Error("esperava 1 PATCH de conversa");
      }
      if (state.calls.conversationsPatchBodies[0].subject !== "Assunto") {
        throw new Error(`inesperado: ${JSON.stringify(state.calls.conversationsPatchBodies[0])}`);
      }
    } finally {
      uninstall();
    }
  });

  // ------- Opt-out/opt-in por palavra-chave (user story H, Fase 4 PR-B) -------

  function zapiTextPayload(text: string, extra: Record<string, unknown> = {}) {
    return {
      messageId: `wamid-keyword-${text}`,
      phone: "5511999990000",
      fromMe: false,
      text: { message: text },
      ...extra,
    };
  }

  await t.step("keyword opt-out: mensagem 'parar' cria supressão e NÃO dispara a IA", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(jsonReq("zapi", zapiTextPayload("parar")));
      await flush();
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") {
        throw new Error(`inesperado: ${res.status} ${text}`);
      }
      if (state.calls.messagesInsertBodies.length !== 1) {
        throw new Error("mensagem de opt-out ainda deve ser persistida normalmente");
      }
      if (state.calls.suppressionUpsertBodies.length !== 1) {
        throw new Error("esperava 1 upsert em messaging_phone_suppressions");
      }
      const body = state.calls.suppressionUpsertBodies[0];
      if (
        body.tenant_id !== "tenant-1" ||
        body.phone !== "+5511999990000" ||
        body.scope !== "phone" ||
        body.source !== "keyword" ||
        body.reactivated_at !== null
      ) {
        throw new Error(`upsert inesperado: ${JSON.stringify(body)}`);
      }
      if (state.calls.aiRespondBodies.length !== 0) {
        throw new Error("IA não deveria ser disparada para a própria mensagem de opt-out");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("keyword opt-out: 'Sair!' (maiúscula + pontuação) também bate", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(jsonReq("zapi", zapiTextPayload("Sair!")));
      await flush();
      if (state.calls.suppressionUpsertBodies.length !== 1) {
        throw new Error("esperava 1 upsert em messaging_phone_suppressions para 'Sair!'");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "keyword opt-out: frase contendo 'parar' como substring NÃO é falso-positivo",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock(router(state));
      try {
        await handler(jsonReq("zapi", zapiTextPayload("não vou parar de comprar com vocês")));
        await flush();
        if (state.calls.suppressionUpsertBodies.length !== 0) {
          throw new Error("substring 'parar' dentro de frase não deveria acionar opt-out");
        }
        if (state.calls.aiRespondBodies.length !== 1) {
          throw new Error("mensagem normal deveria disparar a IA normalmente");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("keyword opt-in: mensagem 'voltar' reativa supressão existente", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(jsonReq("zapi", zapiTextPayload("voltar")));
      await flush();
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") {
        throw new Error(`inesperado: ${res.status} ${text}`);
      }
      if (state.calls.suppressionUpsertBodies.length !== 0) {
        throw new Error("opt-in não deve fazer upsert (só update condicional)");
      }
      if (state.calls.suppressionPatchCalls.length !== 1) {
        throw new Error("esperava 1 PATCH em messaging_phone_suppressions");
      }
      const { body, search } = state.calls.suppressionPatchCalls[0];
      if (typeof body.reactivated_at !== "string") {
        throw new Error(`PATCH deveria gravar reactivated_at: ${JSON.stringify(body)}`);
      }
      if (
        search.get("tenant_id") !== "eq.tenant-1" ||
        search.get("phone") !== "eq.+5511999990000" ||
        search.get("scope") !== "eq.phone" ||
        search.get("reactivated_at") !== "is.null"
      ) {
        throw new Error(`filtro do PATCH inesperado: ${search.toString()}`);
      }
      // Opt-in não é opt-out -- a IA segue o comportamento normal.
      if (state.calls.aiRespondBodies.length !== 1) {
        throw new Error("opt-in não deveria suprimir a resposta normal da IA");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("keyword: mensagem normal não aciona checagem de supressão", async () => {
    const state = defaultState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(jsonReq("zapi", zapiTextPayload("Oi, tudo bem?")));
      await flush();
      if (
        state.calls.suppressionUpsertBodies.length !== 0 ||
        state.calls.suppressionPatchCalls.length !== 0
      ) {
        throw new Error("mensagem normal não deveria tocar messaging_phone_suppressions");
      }
      if (state.calls.aiRespondBodies.length !== 1) {
        throw new Error("mensagem normal deveria disparar a IA normalmente");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("keyword: canal email não checa supressão (tabela é phone-scoped)", async () => {
    const state = defaultState();
    state.tenantIntegration = {
      tenant_id: "tenant-1",
      slug: "resend",
      status: "active",
    };
    state.channel = { id: "chan-email", type: "email" };
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq("resend", resendPayload({ email_id: "email-keyword-noop", text: "parar" })),
      );
      await flush();
      if (
        state.calls.suppressionUpsertBodies.length !== 0 ||
        state.calls.suppressionPatchCalls.length !== 0
      ) {
        throw new Error("canal email não deveria tocar messaging_phone_suppressions");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "keyword: falha na checagem de supressão NÃO impede o fluxo normal do webhook",
    async () => {
      const state = defaultState();
      state.suppressionUpsertError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(jsonReq("zapi", zapiTextPayload("parar")));
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(
            `webhook deveria responder 200/ok mesmo com falha na checagem: ${res.status} ${text}`,
          );
        }
        if (state.calls.messagesInsertBodies.length !== 1) {
          throw new Error("mensagem deveria ser persistida mesmo com falha na checagem de opt-out");
        }
        // Regressão 05·H3. A falha continua isolada (webhook responde ok, a
        // mensagem é persistida), mas o que ERA um console.error mudo passa a:
        // (1) gravar system_events e (2) pular a IA nesta mensagem — quem
        // escreveu "parar" não pode ser respondido pela IA só porque o
        // upsert de supressão falhou (LGPD).
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error(
            "IA não pode responder quem pediu opt-out, mesmo com a gravação da supressão falhando",
          );
        }
        const evento = state.calls.systemEventsInsertBodies.find(
          (e) => e.operation === "messaging-webhook.opt_out_por_palavra_chave",
        );
        if (!evento) {
          throw new Error(
            `falha de opt-out tem que deixar rastro em system_events: ${
              JSON.stringify(state.calls.systemEventsInsertBodies)
            }`,
          );
        }
        if ((evento.context as Record<string, unknown>)?.supressao_nao_persistida !== true) {
          throw new Error(
            `o evento tem que dizer que a supressão não ficou durável: ${JSON.stringify(evento)}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  // ------- Supressão durável (telefone já suprimido de opt-out anterior) -------

  await t.step(
    "supressão durável: telefone já suprimido NÃO dispara a IA numa mensagem normal",
    async () => {
      const state = defaultState();
      state.suppressionExisting = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(jsonReq("zapi", zapiTextPayload("Oi, tudo bem?")));
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.messagesInsertBodies.length !== 1) {
          throw new Error("mensagem deveria ser persistida mesmo com telefone suprimido");
        }
        if (state.calls.suppressionSelectCalls.length !== 1) {
          throw new Error("esperava 1 checagem de supressão durável");
        }
        const search = state.calls.suppressionSelectCalls[0];
        if (
          search.get("tenant_id") !== "eq.tenant-1" ||
          search.get("phone") !== "eq.+5511999990000" ||
          search.get("scope") !== "eq.phone" ||
          search.get("reactivated_at") !== "is.null"
        ) {
          throw new Error(`filtro da checagem de supressão inesperado: ${search.toString()}`);
        }
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("IA não deveria disparar para telefone já suprimido");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "supressão durável: após reativar via 'voltar', a PRÓXIMA mensagem normal dispara a IA de novo",
    async () => {
      const state = defaultState();
      state.suppressionExisting = true;
      const uninstall = installFetchMock(router(state));
      try {
        await handler(jsonReq("zapi", zapiTextPayload("voltar")));
        await flush();
        const afterOptIn = state.calls.aiRespondBodies.length;
        if (afterOptIn !== 1) {
          throw new Error("opt-in não deveria suprimir a resposta à própria mensagem 'voltar'");
        }
        // A reativação (PATCH) já rodou dentro do handler acima -- o mock
        // reflete isso desativando suppressionExisting, como o DB real faria.
        await handler(jsonReq("zapi", zapiTextPayload("Oi de novo")));
        await flush();
        const afterSecondMessage = state.calls.aiRespondBodies.length;
        if (afterSecondMessage !== 2) {
          throw new Error(
            `mensagem normal após reativação deveria disparar a IA: ${afterSecondMessage}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "supressão durável: falha na checagem NÃO impede a IA de responder (fail-open) nem quebra o webhook",
    async () => {
      const state = defaultState();
      state.suppressionSelectError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(jsonReq("zapi", zapiTextPayload("Oi, tudo bem?")));
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(
            `webhook deveria responder 200/ok mesmo com falha na checagem: ${res.status} ${text}`,
          );
        }
        if (state.calls.messagesInsertBodies.length !== 1) {
          throw new Error("mensagem deveria ser persistida mesmo com falha na checagem");
        }
        // Prova que o fail-open é resultado de erro CAPTURADO na checagem (não
        // de a checagem nunca ter rodado) -- sem isso, remover a checagem
        // inteira do código passaria neste teste do mesmo jeito.
        if (state.calls.suppressionSelectCalls.length !== 1) {
          throw new Error("esperava 1 tentativa de checagem de supressão, mesmo falhando");
        }
        if (state.calls.aiRespondBodies.length !== 1) {
          throw new Error("IA deveria disparar normalmente quando a checagem de supressão falha");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "supressão durável: mensagem de opt-out ('parar') não dispara a checagem durável (skipAiForOptOut já cobre)",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock(router(state));
      try {
        await handler(jsonReq("zapi", zapiTextPayload("parar")));
        await flush();
        if (state.calls.suppressionSelectCalls.length !== 0) {
          throw new Error(
            "mensagem de opt-out não deveria checar supressão durável (skipAiForOptOut já bloqueia)",
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "supressão durável: canal email não checa supressão durável (tabela é phone-scoped)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = {
        tenant_id: "tenant-1",
        slug: "resend",
        status: "active",
      };
      state.channel = { id: "chan-email", type: "email" };
      state.secrets = resendSecrets();
      const uninstall = installFetchMock(router(state));
      try {
        await handler(
          await signedResendReq(resendPayload({ email_id: "email-suppression-noop", text: "Oi" })),
        );
        await flush();
        if (state.calls.suppressionSelectCalls.length !== 0) {
          throw new Error("canal email não deveria checar supressão durável");
        }
        if (state.calls.aiRespondBodies.length !== 1) {
          throw new Error("e-mail normal deveria disparar a IA normalmente");
        }
      } finally {
        uninstall();
      }
    },
  );

  // ------- Meta Cloud API -------

  // Lote 3: verifyMetaSignature agora é fail-closed — todo POST meta-cloud
  // legítimo exige `app_secret` em integration_secrets + header
  // `x-hub-signature-256=sha256=<hmac(body)>`. Helper assina o corpo e
  // devolve a Request pronta pra ser passada ao handler.
  const META_APP_SECRET = "meta-app-secret";
  const metaSecrets = () => [{ key: "app_secret", value: META_APP_SECRET }];
  async function computeMetaSignature(secret: string, body: string): Promise<string> {
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    return `sha256=${hex}`;
  }
  const signedMetaReq = async (payload: unknown): Promise<Request> => {
    const body = JSON.stringify(payload);
    const signature = await computeMetaSignature(META_APP_SECRET, body);
    return new Request(webhookUrl("meta-cloud"), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-hub-signature-256": signature,
      },
      body,
    });
  };

  const metaPayload = (message: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
    entry: [
      {
        changes: [
          {
            value: {
              metadata: { display_phone_number: "5511900000000" },
              contacts: [{ profile: { name: "Contato Meta" } }],
              messages: [message],
              ...extra,
            },
          },
        ],
      },
    ],
  });

  await t.step("meta-cloud: mensagem de texto persiste normalmente", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-1",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "text",
            text: { body: "Oi via Meta" },
          }),
        ),
      );
      await flush();
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "Oi via Meta") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.phone !== "+5511999999999" || contactBody.name !== "Contato Meta") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
      if (state.calls.aiRespondBodies.length !== 1) throw new Error("deveria disparar ai-respond");
    } finally {
      uninstall();
    }
  });

  await t.step(
    "meta-cloud: resposta a campanha cai na conversa da campanha e aciona a IA",
    async () => {
      // A conversa foi aberta pelo template-schedule-runner ao enviar o modelo
      // (findOrCreateConversation, ai_active=true). A resposta do lead precisa
      // reaproveitá-la -- histórico da campanha junto -- e enfileirar a IA.
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
      state.secrets = metaSecrets();
      state.existingConversation = { id: "conv-campanha" };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          await signedMetaReq(
            metaPayload({
              id: "wamid-resposta-campanha",
              from: "5511999999999",
              timestamp: "1700000000",
              type: "text",
              text: { body: "Quero sim, me conta mais" },
            }),
          ),
        );
        await flush();
        if (res.status !== 200) throw new Error(`inesperado: ${res.status}`);
        if (state.calls.conversationsInsertBodies.length !== 0) {
          throw new Error("não deveria abrir conversa nova");
        }
        const msgBody = state.calls.messagesInsertBodies[0];
        if (msgBody.conversation_id !== "conv-campanha" || msgBody.sender !== "contact") {
          throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
        }
        if (state.calls.aiJobEnqueueBodies.length !== 1) {
          throw new Error("resposta do lead deveria enfileirar a IA");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("meta-cloud: áudio persiste media_id e MIME para transcrição", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-audio-1",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "audio",
            audio: {
              id: "meta-media-id-1",
              mime_type: "audio/ogg",
              voice: true,
            },
          }),
        ),
      );
      await res.text();
      if (res.status !== 200) throw new Error(`inesperado: ${res.status}`);
      const msgBody = state.calls.messagesInsertBodies[0];
      if (
        msgBody.media_url !== "meta-media:meta-media-id-1" ||
        msgBody.media_type !== "audio/ogg"
      ) {
        throw new Error(`mídia Meta não persistida: ${JSON.stringify(msgBody)}`);
      }
      if (state.calls.aiRespondBodies.length !== 1) {
        throw new Error("áudio Meta deveria enfileirar/disparar ai-respond");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: sem contacts/profile usa o telefone como nome do contato", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq({
          entry: [
            {
              changes: [
                {
                  value: {
                    metadata: { display_phone_number: "5511900000000" },
                    messages: [
                      {
                        id: "wamid-noprofile",
                        from: "5511999999999",
                        timestamp: "1700000000",
                        type: "text",
                        text: { body: "sem perfil" },
                      },
                    ],
                  },
                },
              ],
            },
          ],
        }),
      );
      const contactBody = state.calls.contactsInsertBodies[0];
      if (contactBody.name !== "+5511999999999") {
        throw new Error(`inesperado: ${JSON.stringify(contactBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: evento sem messages (status/read receipt) não normaliza", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq({
          entry: [
            {
              changes: [{ value: { metadata: {}, statuses: [{ id: "s1", status: "delivered" }] } }],
            },
          ],
        }),
      );
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: payload sem value (entry/change ausente) não normaliza", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(await signedMetaReq({ entry: [] }));
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: mensagem sem id não normaliza", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({ from: "5511999999999", type: "text", text: { body: "sem id" } }),
        ),
      );
      if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: tipo button usa o texto do botão", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-btn",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "button",
            button: { text: "Confirmar" },
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "Confirmar") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: tipo interactive com button_reply usa o título", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-int-btn",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "interactive",
            interactive: { button_reply: { title: "Sim" } },
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "Sim") throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: tipo interactive com list_reply usa o título", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-int-list",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "interactive",
            interactive: { list_reply: { title: "Opção 2" } },
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "Opção 2") throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: tipo não suportado com caption usa a caption", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-img",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "image",
            image: { caption: "foto do produto" },
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "foto do produto") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: tipo não suportado sem caption usa fallback genérico", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-sticker",
            from: "5511999999999",
            timestamp: "1700000000",
            type: "sticker",
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "[sticker recebida — abra no WhatsApp para ver]") {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("meta-cloud: timestamp inválido usa o horário atual como fallback", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "meta-cloud", status: "active" };
    state.secrets = metaSecrets();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        await signedMetaReq(
          metaPayload({
            id: "wamid-badts",
            from: "5511999999999",
            timestamp: "not-a-number",
            type: "text",
            text: { body: "oi" },
          }),
        ),
      );
      const msgBody = state.calls.messagesInsertBodies[0];
      if (
        typeof msgBody.created_at !== "string" ||
        Number.isNaN(Date.parse(msgBody.created_at as string))
      ) {
        throw new Error(`inesperado: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  // ------- Fire-and-forget do ai-respond -------

  await t.step(
    "ai-respond: falha no fetch é engolida e não afeta a resposta ao provider",
    async () => {
      const state = defaultState();
      state.aiRespondThrows = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-ai-fail",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        await flush();
        if (state.calls.aiRespondBodies.length !== 1) {
          throw new Error("esperava 1 tentativa de ai-respond");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "ai-respond: status de erro (fetch resolve) também não afeta a resposta",
    async () => {
      const state = defaultState();
      state.aiRespondStatus = 500;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-ai-500",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  // ------- Fase 5: autenticação por canal (channel_id + webhook_token) -------

  const CHANNEL_ID = "11111111-1111-1111-1111-111111111111";
  const EVOLUTION_CHANNEL_ID = "22222222-2222-2222-2222-222222222222";

  await t.step(
    "canal novo (channel_id+webhook_token): autentica e persiste sem depender de tenant_integrations",
    async () => {
      const state = defaultState();
      // Prova que o caminho novo não consulta tenant_integrations em nenhum momento.
      state.tenantIntegration = null;
      state.channel = {
        id: CHANNEL_ID,
        type: "whatsapp",
        tenant_id: "tenant-1",
        provider_slug: "zapi",
        status: "connected",
      };
      const uninstall = installFetchMock(router(state));
      try {
        const body = {
          messageId: "m-chan-1",
          phone: "5511999999999",
          fromMe: false,
          text: { message: "Olá via canal" },
        };
        const res = await handler(jsonReq(CHANNEL_ID, body, { token: "chan-webhook-tok" }));
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.messagesInsertBodies.length !== 1) {
          throw new Error(`esperava 1 mensagem, veio ${state.calls.messagesInsertBodies.length}`);
        }
        if (state.calls.messagesInsertBodies[0]?.content !== "Olá via canal") {
          throw new Error(
            `conteúdo inesperado: ${JSON.stringify(state.calls.messagesInsertBodies[0])}`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "canal novo: webhook_token inválido (canal não encontrado) retorna 401",
    async () => {
      const state = defaultState();
      state.channel = null;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq(CHANNEL_ID, { messageId: "m-x" }, { token: "tok-errado" }),
        );
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria ter persistido");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "canal novo: canal EXISTE mas token da request não bate com o webhook_token seedado -> 401 (exercita o filtro real, não só 'canal null')",
    async () => {
      const state = defaultState();
      // Canal de verdade presente no estado -- diferente do teste acima, aqui
      // o mock só deve negar por causa do filtro .eq("webhook_token", token)
      // realmente aplicado na query, não porque o canal não existe.
      state.channel = {
        id: CHANNEL_ID,
        type: "whatsapp",
        tenant_id: "tenant-1",
        provider_slug: "zapi",
        status: "connected",
        webhook_token: "token-certo-do-canal",
      };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq(CHANNEL_ID, { messageId: "m-y" }, { token: "token-errado" }),
        );
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não deveria ter persistido");
        }
      } finally {
        uninstall();
      }
    },
  );

  // ------- Evolution (WhatsApp self-hosted, provider novo da Fase 5) -------

  function evolutionTextPayload(overrides?: Record<string, unknown>): Record<string, unknown> {
    return {
      event: "Message",
      instanceId: "test-instance-id",
      instanceName: "test-instance",
      instanceToken: "instance-tok-abc",
      data: {
        Info: {
          ID: "evo-msg-1",
          IsFromMe: false,
          IsGroup: false,
          Chat: "5511999999999",
          Sender: "5511999999999@s.whatsapp.net",
          PushName: "Paciente Teste",
          Timestamp: new Date().toISOString(),
          Type: "text",
        },
        Message: { conversation: "Olá doutor, boa tarde!" },
      },
      ...overrides,
    };
  }

  function evolutionState(): State {
    const state = defaultState();
    state.channel = {
      id: EVOLUTION_CHANNEL_ID,
      type: "whatsapp",
      tenant_id: "tenant-1",
      provider_slug: "evolution",
      status: "connected",
    };
    state.secrets = [{ key: "instance_token", value: "instance-tok-abc" }];
    return state;
  }

  await t.step("evolution: mensagem de texto normaliza e persiste via canal", async () => {
    const state = evolutionState();
    const uninstall = installFetchMock(router(state));
    try {
      const req = jsonReq(EVOLUTION_CHANNEL_ID, evolutionTextPayload(), {
        token: "chan-webhook-tok",
      });
      const res = await handler(req);
      const text = await res.text();
      if (res.status !== 200 || text !== "ok") throw new Error(`inesperado: ${res.status} ${text}`);
      await flush();
      if (state.calls.messagesInsertBodies.length !== 1) {
        throw new Error(`esperava 1 mensagem, veio ${state.calls.messagesInsertBodies.length}`);
      }
      const msgBody = state.calls.messagesInsertBodies[0];
      if (msgBody.content !== "Olá doutor, boa tarde!") {
        throw new Error(`conteúdo inesperado: ${JSON.stringify(msgBody)}`);
      }
      if (state.calls.contactsInsertBodies[0]?.phone !== "+5511999999999") {
        throw new Error(
          `telefone inesperado: ${JSON.stringify(state.calls.contactsInsertBodies[0])}`,
        );
      }
      if (state.calls.aiRespondBodies.length !== 1) {
        throw new Error("esperava disparo de ai-respond");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("evolution: token de instância inválido retorna 401 e nunca processa", async () => {
    const state = evolutionState();
    const uninstall = installFetchMock(router(state));
    try {
      const payload = evolutionTextPayload({ instanceToken: "token-errado" });
      const req = jsonReq(EVOLUTION_CHANNEL_ID, payload, { token: "chan-webhook-tok" });
      const res = await handler(req);
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error("não deveria ter persistido");
      }
    } finally {
      uninstall();
    }
  });

  await t.step(
    "evolution: sem credencial de instância cadastrada retorna 401 (fail-closed)",
    async () => {
      const state = evolutionState();
      state.secrets = [];
      const uninstall = installFetchMock(router(state));
      try {
        const req = jsonReq(EVOLUTION_CHANNEL_ID, evolutionTextPayload(), {
          token: "chan-webhook-tok",
        });
        const res = await handler(req);
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      } finally {
        uninstall();
      }
    },
  );

  // ---- Canais genéricos multichannel (telegram/discord/sms/email/push): 2º fator
  // webhook_secret (fail-closed). O branch dispatcha os 5 slugs igual via includes(),
  // então "telegram" é representativo. Sem segredo, sem header, header errado ou erro
  // de infra na query => 401 ANTES de tocar DB (metering) ou disparar ai-respond.
  await t.step(
    "multichannel: sem webhook_secret configurado retorna 401 (fail-closed)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "telegram", status: "active" };
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(jsonReq("telegram", { message: { id: "m1", from: "u1" } }));
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.messagesInsertBodies.length !== 0) throw new Error("não deveria persistir");
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("não deveria disparar ai-respond");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "multichannel: webhook_secret configurado sem header x-webhook-secret retorna 401",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "telegram", status: "active" };
      state.secrets = [{ key: "webhook_secret", value: "s3kr3t" }];
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(jsonReq("telegram", { message: { id: "m1", from: "u1" } }));
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("não deveria disparar ai-respond");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step("multichannel: x-webhook-secret incorreto retorna 401", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "telegram", status: "active" };
    state.secrets = [{ key: "webhook_secret", value: "s3kr3t" }];
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(
        new Request(webhookUrl("telegram"), {
          method: "POST",
          headers: { "content-type": "application/json", "x-webhook-secret": "errado" },
          body: JSON.stringify({ message: { id: "m1", from: "u1" } }),
        }),
      );
      if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
    } finally {
      uninstall();
    }
  });

  await t.step(
    "multichannel: erro de infra na query de integration_secrets retorna 401 (fail-closed)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "telegram", status: "active" };
      state.secretsQueryError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          new Request(webhookUrl("telegram"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-webhook-secret": "s3kr3t" },
            body: JSON.stringify({ message: { id: "m1", from: "u1" } }),
          }),
        );
        if (res.status !== 401) throw new Error(`esperado 401, veio ${res.status}`);
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "multichannel: x-webhook-secret correto abre o gate (payload vazio => 200, sem persistir)",
    async () => {
      const state = defaultState();
      state.tenantIntegration = { tenant_id: "tenant-1", slug: "telegram", status: "active" };
      state.secrets = [{ key: "webhook_secret", value: "s3kr3t" }];
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          new Request(webhookUrl("telegram"), {
            method: "POST",
            headers: { "content-type": "application/json", "x-webhook-secret": "s3kr3t" },
            body: JSON.stringify({}),
          }),
        );
        // payload sem external_id/from => genericInbound retorna null => não persiste.
        // O ponto do teste: segredo válido NÃO leva a 401 (o gate abriu).
        if (res.status === 401) throw new Error("segredo válido não deveria dar 401");
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("payload vazio não deveria persistir");
        }
      } finally {
        uninstall();
      }
    },
  );

  // ------- Saúde do webhook: reset no sucesso e teto de falhas consecutivas -------
  // MAX_CONSECUTIVE_WEBHOOK_FAILURES = 5, e a decisão é `consecutiveFailures <=
  // MAX`. O `<=` vs `<` é a diferença entre "o provider desabilita a assinatura
  // do webhook do tenant" (5xx demais) e "mensagem do cliente perdida em
  // silêncio" (200 cedo demais) -- por isso os dois lados da fronteira, 5 e 6.
  //
  // Para exercitar o catch é preciso que o canal RESOLVA (ch?.id não nulo) e o
  // processamento seguinte quebre: contactInsertError faz o insert de contato
  // devolver 500 e persistInbound lança (`if (error) throw error`).

  const failingInbound = () =>
    jsonReq("zapi", { messageId: "m-health", phone: "5511999999999", text: { message: "oi" } });

  await t.step(
    "saúde do canal: inbound processado com sucesso zera webhook_consecutive_failures",
    async () => {
      const state = defaultState();
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-health-ok",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        await flush();
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`inesperado: ${res.status} ${text}`);
        }
        if (state.calls.channelsPatchCalls.length !== 1) {
          throw new Error(
            `esperava 1 UPDATE de saúde do canal, veio ${state.calls.channelsPatchCalls.length}`,
          );
        }
        const { body, search } = state.calls.channelsPatchCalls[0];
        // Estrito: `!== 0` e não truthiness -- remover o campo do UPDATE (undefined)
        // ou trocar por qualquer outro número tem que quebrar aqui.
        if (body.webhook_consecutive_failures !== 0) {
          throw new Error(`esperava webhook_consecutive_failures:0, veio ${JSON.stringify(body)}`);
        }
        if (body.webhook_health !== "ok" || typeof body.webhook_health_checked_at !== "string") {
          throw new Error(`UPDATE de saúde inesperado: ${JSON.stringify(body)}`);
        }
        if (search.get("id") !== "eq.chan-1") {
          throw new Error(`UPDATE deveria mirar o canal resolvido: ${search.toString()}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "teto de falhas: contador EM CIMA do teto (5) ainda responde 503 e não marca o canal quebrado",
    async () => {
      const state = defaultState();
      state.contactInsertError = true;
      state.bumpFailureResult = 5;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(failingInbound());
        const text = await res.text();
        if (res.status !== 503 || text !== "retry") {
          throw new Error(`esperado 503/retry no teto (5), veio ${res.status} ${text}`);
        }
        if (state.calls.bumpFailureCalls.length !== 1) {
          throw new Error(
            `esperava 1 chamada à RPC de bump, veio ${state.calls.bumpFailureCalls.length}`,
          );
        }
        if (state.calls.bumpFailureCalls[0].p_channel_id !== "chan-1") {
          throw new Error(
            `bump no canal errado: ${JSON.stringify(state.calls.bumpFailureCalls[0])}`,
          );
        }
        // Metade que morde: pedir retry E marcar 'broken' ao mesmo tempo passaria
        // sem esta asserção -- e o canal ficaria quebrado na UI ainda dentro da
        // janela em que a falha é tratada como transitória.
        if (state.calls.channelsPatchCalls.some((c) => c.body.webhook_health === "broken")) {
          throw new Error("dentro do teto o canal não pode ser marcado como quebrado");
        }
        const event = state.calls.systemEventsInsertBodies.at(-1);
        const ctx = event?.context as Record<string, unknown> | undefined;
        if (ctx?.consecutive_failures !== 5 || ctx?.asked_retry !== true) {
          throw new Error(`telemetria inesperada: ${JSON.stringify(event)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "teto de falhas: contador ACIMA do teto (6) para de pedir retry (200) e marca o canal quebrado",
    async () => {
      const state = defaultState();
      state.contactInsertError = true;
      state.bumpFailureResult = 6;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(failingInbound());
        const text = await res.text();
        // 200 aqui é deliberado: 5xx infinito faz Meta/Evolution DESABILITAREM a
        // assinatura do webhook e derrubarem o canal inteiro do tenant.
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`esperado 200/ok acima do teto (6), veio ${res.status} ${text}`);
        }
        const brokenPatches = state.calls.channelsPatchCalls.filter(
          (c) => c.body.webhook_health === "broken",
        );
        if (brokenPatches.length !== 1) {
          throw new Error(
            `esperava 1 UPDATE marcando o canal quebrado, veio ${brokenPatches.length}`,
          );
        }
        if (typeof brokenPatches[0].body.webhook_health_checked_at !== "string") {
          throw new Error(
            `UPDATE de 'broken' sem timestamp: ${JSON.stringify(brokenPatches[0].body)}`,
          );
        }
        if (brokenPatches[0].search.get("id") !== "eq.chan-1") {
          throw new Error(
            `UPDATE de 'broken' no canal errado: ${brokenPatches[0].search.toString()}`,
          );
        }
        const event = state.calls.systemEventsInsertBodies.at(-1);
        const ctx = event?.context as Record<string, unknown> | undefined;
        if (ctx?.consecutive_failures !== 6 || ctx?.asked_retry !== false) {
          throw new Error(`telemetria inesperada: ${JSON.stringify(event)}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "teto de falhas: RPC de bump indisponível não pede retry (contador fica 0) nem marca o canal quebrado",
    async () => {
      const state = defaultState();
      state.contactInsertError = true;
      state.bumpFailureResult = null;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(failingInbound());
        const text = await res.text();
        if (res.status !== 200 || text !== "ok") {
          throw new Error(`esperado 200/ok com a RPC falhando, veio ${res.status} ${text}`);
        }
        if (state.calls.bumpFailureCalls.length !== 1) {
          throw new Error("a RPC deveria ter sido tentada mesmo assim");
        }
        if (state.calls.channelsPatchCalls.some((c) => c.body.webhook_health === "broken")) {
          throw new Error("sem contador confiável não dá para declarar o canal quebrado");
        }
        const event = state.calls.systemEventsInsertBodies.at(-1);
        const ctx = event?.context as Record<string, unknown> | undefined;
        if (ctx?.consecutive_failures !== 0 || ctx?.asked_retry !== false) {
          throw new Error(`telemetria inesperada: ${JSON.stringify(event)}`);
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ------- Zappaz: endereçamento por LID -------
// O WhatsApp pode endereçar a conversa por LID: key.remoteJid vem como
// "<id>@lid" (não é telefone) e o número real chega em key.remoteJidAlt.
// Regressão: antes gravávamos o LID como telefone do contato.
Deno.test("messaging-webhook: Zappaz resolve remoteJidAlt quando remoteJid é @lid", async (t) => {
  await t.step("usa o telefone real, não o LID", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "zappaz", status: "active" };
    state.secrets = [{ key: "api_key", value: "zappaz-key" }];
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq(
          "zappaz",
          {
            data: {
              key: {
                id: "3EB03298B9EA00D8BDD774",
                fromMe: false,
                remoteJid: "40420507672778@lid",
                participant: "",
                remoteJidAlt: "554599022026@s.whatsapp.net",
                addressingMode: "lid",
              },
              message: { conversation: "teste1603" },
              pushName: "Felipe Truman",
              messageType: "conversation",
              messageTimestamp: 1784919781,
            },
          },
          undefined,
          { "x-webhook-secret": "zappaz-key" },
        ),
      );
      const contactBody = state.calls.contactsInsertBodies[0];
      if (!contactBody || contactBody.phone !== "+554599022026") {
        throw new Error(`telefone inesperado: ${JSON.stringify(contactBody)}`);
      }
      const msgBody = state.calls.messagesInsertBodies[0];
      if (!msgBody || msgBody.content !== "teste1603") {
        throw new Error(`mensagem inesperada: ${JSON.stringify(msgBody)}`);
      }
    } finally {
      uninstall();
    }
  });

  await t.step("sem JID discável (só LID) não cria contato com número falso", async () => {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "zappaz", status: "active" };
    state.secrets = [{ key: "api_key", value: "zappaz-key" }];
    const uninstall = installFetchMock(router(state));
    try {
      await handler(
        jsonReq(
          "zappaz",
          {
            data: {
              key: { id: "only-lid-1", fromMe: false, remoteJid: "40420507672778@lid" },
              message: { conversation: "oi" },
            },
          },
          undefined,
          { "x-webhook-secret": "zappaz-key" },
        ),
      );
      if (state.calls.contactsInsertBodies.length !== 0) {
        throw new Error(
          `não deveria criar contato: ${JSON.stringify(state.calls.contactsInsertBodies)}`,
        );
      }
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error("não deveria persistir mensagem sem telefone discável");
      }
    } finally {
      uninstall();
    }
  });
  // ------- 05-silent-failures: erro de banco não pode virar decisão de negócio -------
  // supabase-js NÃO lança em erro de banco; devolve { data, error }. Cada um dos
  // pontos abaixo lia `data == null` como "não existe" e tomava a decisão errada.
  // Os testes fixam a DIREÇÃO do fix: sem capturar o `error`, cada step falha.

  await t.step(
    "H1 dedupe: erro na checagem de duplicata não insere mensagem nem dispara IA (503)",
    async () => {
      const state = defaultState();
      state.messageDedupeSelectError = "XX000";
      // Contador abaixo do teto: o catch de topo pede retry, e a reentrega é
      // segura porque claimWebhookEvent reserva o evento.
      state.bumpFailureResult = 1;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-dedupe-err",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        await flush();
        if (res.status !== 503) {
          throw new Error(`erro no dedupe deveria pedir retry (503), veio ${res.status}`);
        }
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error(
            `mensagem duplicada: ${JSON.stringify(state.calls.messagesInsertBodies)}`,
          );
        }
        if (state.calls.aiRespondBodies.length !== 0) {
          throw new Error("IA não pode responder duas vezes a mesma mensagem");
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H2 conversa: erro ao buscar conversa aberta não cria uma segunda conversa (503)",
    async () => {
      const state = defaultState();
      state.existingContact = { id: "contact-1" };
      state.conversationSelectError = true;
      state.bumpFailureResult = 1;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-conv-err",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        await flush();
        if (res.status !== 503) {
          throw new Error(
            `erro na leitura da conversa deveria pedir retry (503), veio ${res.status}`,
          );
        }
        if (state.calls.conversationsInsertBodies.length !== 0) {
          throw new Error(
            `histórico rachado em duas threads: ${
              JSON.stringify(state.calls.conversationsInsertBodies)
            }`,
          );
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H3 auth por canal: erro de banco responde 503, não 401 (401 em série desabilita o webhook)",
    async () => {
      const state = defaultState();
      const channelId = "33333333-3333-3333-3333-333333333333";
      state.channel = {
        id: channelId,
        type: "whatsapp",
        tenant_id: "tenant-1",
        provider_slug: "zapi",
        status: "connected",
      };
      state.channelAuthQueryError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq(channelId, {
            messageId: "m-auth-err",
            phone: "5511999999999",
            text: { message: "oi" },
          }, {
            token: "chan-webhook-tok",
          }),
        );
        await flush();
        if (res.status !== 503) {
          throw new Error(`apagão de banco na auth deveria dar 503, veio ${res.status}`);
        }
      } finally {
        uninstall();
      }
    },
  );

  await t.step(
    "H3 auth legada: erro em tenant_integrations responde 503, não 401",
    async () => {
      const state = defaultState();
      state.tenantIntegrationQueryError = true;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-auth-ti-err",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        await flush();
        if (res.status !== 503) {
          throw new Error(`apagão de banco na auth legada deveria dar 503, veio ${res.status}`);
        }
      } finally {
        uninstall();
      }
    },
  );
  await t.step(
    "H1 dedupe: PGRST116 (duplicata já existe) NÃO pede retry — retry eterno derrubaria o canal",
    async () => {
      const state = defaultState();
      state.messageDedupeSelectError = "PGRST116";
      state.bumpFailureResult = 1;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(
          jsonReq("zapi", {
            messageId: "m-dup-2x",
            phone: "5511999999999",
            text: { message: "oi" },
          }),
        );
        await flush();
        if (res.status !== 200) {
          throw new Error(
            `erro determinístico não pode pedir retry (viraria canal 'broken'), veio ${res.status}`,
          );
        }
        if (state.calls.messagesInsertBodies.length !== 0) {
          throw new Error("não pode inserir: a duplicata existe");
        }
        if (state.calls.bumpFailureCalls.length !== 0) {
          throw new Error("não pode contar como falha do canal");
        }
      } finally {
        uninstall();
      }
    },
  );
});

// ------- Zappaz: áudio, evento de protocolo e eco de saída -------
// Incidente 2026-07-31: cada áudio recebido virava DUAS linhas no inbox — a
// mensagem real e uma linha fantasma "[mensagem não suportada]" vinda do POST
// de protocolo do Baileys que acompanha toda mídia. O áudio em si entrava sem
// content (bolha em branco) e sem disparar a IA.
Deno.test("messaging-webhook: Zappaz áudio e eventos de protocolo", async (t) => {
  function zappazState(): State {
    const state = defaultState();
    state.tenantIntegration = { tenant_id: "tenant-1", slug: "zappaz", status: "active" };
    state.secrets = [{ key: "api_key", value: "zappaz-key" }];
    return state;
  }
  const zappazReq = (body: unknown) =>
    jsonReq("zappaz", body, undefined, { "x-webhook-secret": "zappaz-key" });

  // A telemetria de re-hospedamento tem que dizer a causa CERTA: chave ausente e
  // MIME fora de `audio/` são problemas diferentes, e gravar "sem_media_key"
  // quando a chave veio destrói justamente o valor de diagnóstico do evento.
  await t.step("mídia cifrada com MIME não-áudio registra a causa certa", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      const payload = zappazAudio();
      const data = payload.data as Record<string, unknown>;
      const message = data.message as Record<string, unknown>;
      const audio = message.audioMessage as Record<string, unknown>;
      audio.mimetype = "application/octet-stream";
      const res = await handler(zappazReq(payload));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      const evento = state.calls.systemEventsInsertBodies.find(
        (e) => e.operation === "messaging.whatsapp_media.rehost",
      );
      if (!evento) throw new Error("mídia cifrada fora do re-hospedamento tem que registrar evento");
      const stage = (evento.context as { stage?: string } | undefined)?.stage;
      if (stage !== "mime_nao_audio") {
        throw new Error(`stage mentiroso: ${stage} (a mediaKey veio no payload)`);
      }
      if (state.calls.cdnDownloads !== 0) {
        throw new Error("não pode baixar mídia que não vai re-hospedar");
      }
    } finally {
      uninstall();
    }
  });

  // Antes desta regra, responder não parava nada: a pessoa dizia "já comprei"
  // e continuava recebendo os passos seguintes no cronograma normal.
  await t.step("resposta do contato encerra o acompanhamento automático", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(zappazReq(zappazText("ja comprei, obrigado")));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      if (state.calls.nurtureCancels.length !== 1) {
        throw new Error(
          `esperava 1 cancelamento de acompanhamento, veio ${state.calls.nurtureCancels.length}`,
        );
      }
      const chamada = state.calls.nurtureCancels[0];
      if (chamada.body.status !== "cancelled" || chamada.body.next_send_at !== null) {
        throw new Error(`patch inesperado: ${JSON.stringify(chamada.body)}`);
      }
      // `completed_at` é o que segura a carência do scanner de auto-inscrição:
      // sem ele, a varredura seguinte reinscreve quem pediu para parar.
      if (typeof chamada.body.completed_at !== "string") {
        throw new Error(`cancelamento sem completed_at: ${JSON.stringify(chamada.body)}`);
      }
      // Sem o filtro de tenant, um refactor vazaria cancelamento cross-tenant
      // sem quebrar teste nenhum.
      if (chamada.search.get("tenant_id") !== "eq.tenant-1") {
        throw new Error(
          `cancelamento sem escopo de tenant: ${chamada.search.get("tenant_id")}`,
        );
      }
      // Precisa alcançar também a linha que o worker acabou de reivindicar
      // ('sending'), senão o envio em curso escapa do cancelamento.
      const statusFiltro = chamada.search.get("status") ?? "";
      for (const esperado of ["active", "paused", "sending"]) {
        if (!statusFiltro.includes(esperado)) {
          throw new Error(`filtro de status não cobre '${esperado}': ${statusFiltro}`);
        }
      }
      if (!(chamada.search.get("contact_id") ?? "").length) {
        throw new Error("cancelamento tem que ser escopado ao contato");
      }
    } finally {
      uninstall();
    }
  });

  // Bordas do gate de cancelamento. Sem elas, trocar a condição por algo mais
  // frouxo (ex.: cancelar em qualquer mensagem) passava despercebido.
  await t.step("eco de mensagem nossa (fromMe) não cancela acompanhamento", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(zappazReq(zappazOutboundEcho("mensagem que nós enviamos")));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      if (state.calls.nurtureCancels.length !== 0) {
        throw new Error("mensagem nossa não pode encerrar o acompanhamento do contato");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("contato sem inscrição ativa não gera evento de encerramento", async () => {
    const state = zappazState();
    state.nurtureCancelMode = "vazio";
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(zappazReq(zappazText("oi, tudo bem?")));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      if (state.calls.nurtureCancels.length !== 1) {
        throw new Error("o UPDATE ainda deve ser tentado (é ele quem descobre que não há linha)");
      }
      const info = state.calls.systemEventsInsertBodies.find(
        (e) => e.operation === "nurture.cancel_on_reply" && e.severity === "info",
      );
      if (info) throw new Error("0 linhas encerradas não pode virar evento de encerramento");
    } finally {
      uninstall();
    }
  });

  // A reentrega do provedor é a ÚLTIMA chance de cancelar: a tentativa anterior
  // persistiu a mensagem e morreu antes do enqueue. Sem recuperar o contato
  // junto da mensagem, o gate de cancelamento nunca passava e a sequência
  // seguia inteira.
  await t.step("reentrega recupera o contato e ainda cancela", async () => {
    const state = zappazState();
    // Evento já falhou uma vez => claim devolve "reclaimed".
    state.webhookEvents.set("3EB0ZAPPAZTEXT01", {
      id: "event-reentrega",
      status: "failed",
      attempt: 1,
    });
    // A mensagem já está gravada: o INSERT bate no unique de dedupe.
    state.messageInsertMode = "conflict";
    state.existingMessage = {
      id: "msg-ja-gravada",
      sender: "contact",
      direction: "in",
      conversations: { contact_id: "contact-reentrega" },
    };
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(zappazReq(zappazText("pode parar por favor")));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      if (state.calls.nurtureCancels.length !== 1) {
        throw new Error(
          `reentrega tinha que cancelar 1 vez, cancelou ${state.calls.nurtureCancels.length}`,
        );
      }
      if (state.calls.nurtureCancels[0].search.get("contact_id") !== "eq.contact-reentrega") {
        throw new Error("cancelamento da reentrega foi para o contato errado");
      }
    } finally {
      uninstall();
    }
  });

  // Falha no cancelamento não pode sumir: o evento não é marcado como
  // processado, o provedor reentrega, o dedupe devolve messageId nulo e
  // ninguém retenta. Um blip de rede = contato recebendo a sequência inteira.
  await t.step("erro do PATCH de cancelamento deixa rastro em system_events", async () => {
    for (const modo of ["error", "throw"] as const) {
      const state = zappazState();
      state.nurtureCancelMode = modo;
      const uninstall = installFetchMock(router(state));
      try {
        const res = await handler(zappazReq(zappazText("ja comprei, obrigado")));
        await flush();
        if (res.status !== 200) {
          throw new Error(`webhook não pode cair por falha de cancelamento (${modo}): ${res.status}`);
        }
        const evento = state.calls.systemEventsInsertBodies.find(
          (e) => e.operation === "nurture.cancel_on_reply" && e.severity === "warn",
        );
        if (!evento) {
          throw new Error(`falha de cancelamento (${modo}) não gravou system_event`);
        }
      } finally {
        uninstall();
      }
    }
  });

  await t.step("áudio persiste marcador, media_url e MIME, e dispara a IA", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(zappazReq(zappazAudio()));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      const msg = state.calls.messagesInsertBodies[0];
      if (!msg) throw new Error("áudio não foi persistido");
      if (msg.content !== "[audio recebida — abra no WhatsApp para ver]") {
        throw new Error(`bolha em branco no inbox: ${JSON.stringify(msg.content)}`);
      }
      // O `.enc` da CDN é ciphertext: gravar essa URL é o mesmo que gravar nada,
      // a transcrição recusa. O que tem que sobrar é o objeto já decifrado.
      if (!String(msg.media_url ?? "").includes("/storage/v1/object/sign/")) {
        throw new Error(`media_url tinha que ser o áudio decifrado: ${JSON.stringify(msg)}`);
      }
      if (state.calls.cdnDownloads !== 1) {
        throw new Error(`áudio cifrado precisa ser baixado da CDN: ${state.calls.cdnDownloads}`);
      }
      if (!state.calls.storageUploads[0]?.startsWith("ai-audio/inbound/")) {
        throw new Error(`upload no caminho errado: ${JSON.stringify(state.calls.storageUploads)}`);
      }
      if (msg.media_type !== "audio/ogg; codecs=opus") {
        throw new Error(`MIME inesperado: ${JSON.stringify(msg.media_type)}`);
      }
      if (state.calls.aiRespondBodies.length !== 1) {
        throw new Error("áudio do lead precisa disparar ai-respond");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("evento de protocolo não vira linha nem aciona a IA", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      const res = await handler(zappazReq(zappazProtocolEvent()));
      await flush();
      if (res.status !== 200) throw new Error(`status inesperado: ${res.status}`);
      if (state.calls.messagesInsertBodies.length !== 0) {
        throw new Error(
          `linha fantasma no inbox: ${JSON.stringify(state.calls.messagesInsertBodies)}`,
        );
      }
      if (state.calls.aiRespondBodies.length !== 0) {
        throw new Error("evento de protocolo não pode acionar a IA");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("eco da própria resposta (fromMe) não realimenta a IA", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(zappazReq(zappazOutboundEcho("resposta da Clara")));
      await flush();
      if (state.calls.aiRespondBodies.length !== 0) {
        throw new Error("fromMe acionou a IA — risco de loop infinito de mensagens");
      }
    } finally {
      uninstall();
    }
  });

  await t.step("texto simples continua persistindo e acionando a IA", async () => {
    const state = zappazState();
    const uninstall = installFetchMock(router(state));
    try {
      await handler(zappazReq(zappazText("teste2029")));
      await flush();
      if (state.calls.messagesInsertBodies[0]?.content !== "teste2029") {
        throw new Error(`texto inesperado: ${JSON.stringify(state.calls.messagesInsertBodies)}`);
      }
      if (state.calls.aiRespondBodies.length !== 1) {
        throw new Error("texto do lead precisa disparar ai-respond");
      }
    } finally {
      uninstall();
    }
  });
});

// Regressão 2026-07-31: a Zappaz entrou em loop conflict/replaced (o número
// estava conectado em outro app) e nenhuma mensagem chegava, mas o card seguia
// "Ativo / Webhook ok". `connection.update` era descartado em silêncio.
Deno.test("readZappazConnectionUpdate detecta conflito de sessão", async () => {
  const { readZappazConnectionUpdate } = await import("../messaging-webhook/index.ts");
  const state = readZappazConnectionUpdate({
    event: "connection.update",
    payload: {
      connection: "close",
      lastDisconnect: {
        error: {
          data: { tag: "conflict", attrs: { type: "replaced" } },
          output: { statusCode: 440, payload: { message: "Stream Errored (conflict)" } },
        },
      },
    },
  });
  if (!state || state.status !== "error" || !state.conflict) {
    throw new Error(`esperado conflito, veio ${JSON.stringify(state)}`);
  }
});

Deno.test("readZappazConnectionUpdate mapeia logout e open", async () => {
  const { readZappazConnectionUpdate } = await import("../messaging-webhook/index.ts");
  const loggedOut = readZappazConnectionUpdate({
    event: "connection.update",
    payload: {
      connection: "close",
      lastDisconnect: {
        error: { output: { statusCode: 401, payload: { message: "logged out" } } },
      },
    },
  });
  if (loggedOut?.status !== "disconnected") throw new Error("esperado disconnected");

  const open = readZappazConnectionUpdate({
    event: "connection.update",
    payload: { connection: "open" },
  });
  if (open?.status !== "connected") throw new Error("esperado connected");

  const other = readZappazConnectionUpdate({ event: "inbound-message.upsert", data: {} });
  if (other !== null) throw new Error("evento de mensagem não é connection.update");
});
