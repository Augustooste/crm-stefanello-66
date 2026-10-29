// Integration connect / test / disconnect / forget
// Handles credential storage (locked table), connection testing against
// provider APIs, and channels sync for the inbox.
import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { captureEdgeError } from "../_shared/telemetry.ts";
import {
  checkEvolutionInstanceStatus,
  resolveEvolutionInstanceToken,
  connectEvolutionInstance,
  reconnectEvolutionInstance,
  type EvolutionCredentials,
} from "../_shared/messaging/evolution-client.ts";
import { checkZappazSession, registerZappazWebhook } from "../_shared/messaging/zappaz-client.ts";
import {
  recordChannelStatusEvent,
  newRunId,
} from "../_shared/messaging/channel-status.ts";
import {
  loadProviderSecrets,
  sendViaProvider,
  sendAudioViaProvider,
  providerSupportsAudio,
  isSupportedProviderSlug,
} from "../_shared/messaging/provider-send.ts";
import {
  isElevenLabsActive,
  loadVoiceSynthesisConfiguration,
  synthesizeSpeech,
} from "../_shared/ai/voice.ts";
import { fetchElevenLabsVoices } from "../_shared/ai/voice-catalog.ts";
import { searchAppointments } from "../_shared/feegow/client.ts";
import { FeegowError, FeegowErrorCode } from "../_shared/feegow/errors.ts";
import { normalizeBaseUrl } from "../_shared/agent-platform/client.ts";
import {
  isManyChatSlug,
  validateManyChatCredentials,
} from "../_shared/messaging/manychat-client.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type Action =
  | "connect"
  | "test"
  | "disconnect"
  | "forget"
  | "reconnect"
  | "test_messaging"
  | "list_voices"
  | "rotate_webhook_secret";

interface Body {
  action: Action;
  slug: string;
  values?: Record<string, string>;
  /** Destino do teste de mensageria (action="test_messaging"). */
  phone?: string;
}

/** Resultado de um passo de execução multi-etapas (reconnect / test_messaging). */
interface StepResult {
  step: string;
  state: "ok" | "failed" | "skipped";
  label: string;
  detail?: string | null;
}

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "content-type": "application/json" },
  });
}

/**
 * Loga no console E persiste em public.system_events. O log do isolate some em
 * minutos e não é consultável pelo suporte — sem o sink de telemetria, uma
 * falha de escrita aqui (credencial não apagada no `forget`, canal não criado,
 * status não atualizado) fica sem rastro nenhum depois do fato.
 * Best-effort: captureEdgeError nunca lança (ver _shared/telemetry.ts).
 */
async function reportError(
  admin: SupabaseClient,
  tenantId: string | null,
  operation: string,
  message: string,
  context: Record<string, unknown> = {},
): Promise<void> {
  console.error(`[integration-connect] ${operation}: ${message}`);
  await captureEdgeError(admin, {
    severity: "error",
    source: "edge",
    operation: `integration-connect.${operation}`,
    tenantId,
    message,
    context,
  });
}

const NETWORK_MSG = "Não conseguimos falar com o provedor agora — tente novamente em instantes.";

/**
 * Teste de credencial é interativo — o usuário está olhando o spinner. Mesmo
 * valor dos envios (provider-send.ts, zappaz-client.ts): 15s.
 */
const PROVIDER_TEST_TIMEOUT_MS = 15_000;
const QR_CODE_TTL_MS = 10 * 60 * 1000;

/**
 * Edge Functions executam em UTC. O teste chega ao WhatsApp de uma empresa
 * brasileira, então o fuso precisa ser explícito para não exibir três horas a
 * mais na mensagem.
 */
export function formatBrasiliaTime(date: Date = new Date()): string {
  return new Intl.DateTimeFormat("pt-BR", {
    timeZone: "America/Sao_Paulo",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(date);
}

function isNetworkError(e: unknown): boolean {
  // Deadline estourado chega como DOMException "TimeoutError", mas a mensagem
  // depende do runtime: o `reason` do próprio AbortSignal.timeout é "Signal
  // timed out." (não casa com o substring "timeout" abaixo) e o fetch do Deno
  // 2.9 rejeita com "The operation was aborted due to timeout" (casa). Checar
  // pelo `name` não depende de qual das duas o host produz — sem isso, uma
  // mudança de mensagem volta a reportar provedor lento como credencial ruim.
  if (e instanceof DOMException && e.name === "TimeoutError") return true;
  const m = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return (
    m.includes("timeout") ||
    m.includes("network") ||
    m.includes("failed to fetch") ||
    m.includes("connection") ||
    m.includes("dns") ||
    m.includes("econn")
  );
}

async function testZapi(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const instance_id = (v.instance_id ?? "").trim();
  const instance_token = (v.instance_token ?? "").trim();
  const client_token = (v.client_token ?? "").trim();
  if (!instance_id || !instance_token || !client_token) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  const badCreds =
    "Credenciais inválidas — confira o ID da instância, o token e o Client Token no painel da Z-API.";
  const badClientToken =
    "Client Token da conta inválido — confira em Segurança > Token da conta no painel Z-API.";
  const badInstance =
    "Instance ID ou Instance Token inválido — confira no topo da instância e na aba Segurança do painel Z-API.";
  const badChars =
    "Um dos tokens tem caractere inválido (quebra de linha ou espaço). Copie e cole novamente sem espaços extras.";
  const disconnected =
    "A instância existe mas está desconectada — leia o QR Code no painel da Z-API e tente de novo.";
  try {
    const url = `https://api.z-api.io/instances/${instance_id}/token/${instance_token}/status`;
    const r = await fetch(url, {
      headers: { "Client-Token": client_token },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    const bodyText = await r.text();
    const rawLc = bodyText.toLowerCase();
    console.log(
      JSON.stringify({
        evt: "zapi_test",
        status: r.status,
        instance_id_len: instance_id.length,
        instance_token_len: instance_token.length,
        client_token_len: client_token.length,
        body_preview: bodyText.slice(0, 200),
      }),
    );
    if (r.status === 401 || r.status === 403) return { ok: false, error: badClientToken };
    if (r.status === 404) return { ok: false, error: badInstance };
    if (r.status === 400) return { ok: false, error: badCreds };
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    let data: Record<string, unknown> = {};
    try {
      data = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : {};
    } catch {
      data = {};
    }
    if (rawLc.includes("instance not found")) return { ok: false, error: badInstance };
    if (rawLc.includes("token") && rawLc.includes("invalid")) return { ok: false, error: badCreds };
    const isConnected =
      (data as { connected?: boolean }).connected === true ||
      (data as { smartphoneConnected?: boolean }).smartphoneConnected === true;
    if (
      !isConnected &&
      ((data as { connected?: boolean }).connected === false ||
        rawLc.includes("disconnected") ||
        rawLc.includes("qrcode") ||
        rawLc.includes("qr code"))
    ) {
      return { ok: false, error: disconnected };
    }
    if (!isConnected && (data as { error?: unknown }).error) {
      return { ok: false, error: badCreds };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError) {
      // Header inválido (ex.: \n, \r ou caractere não-ASCII no client_token)
      return { ok: false, error: badChars };
    }
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badCreds };
  }
}

// Erro padrão para header/body inválido por caractere invisível (mesma mensagem
// que testZapi devolve — copiar/colar do painel de qualquer provider tende a
// trazer \n/\r/espaço que quebra o fetch com TypeError antes de chegar no
// provider).
const BAD_CHARS_MSG =
  "Um dos campos tem caractere inválido (quebra de linha ou espaço). Copie e cole novamente sem espaços extras.";

async function testTwilio(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const account_sid = (v.account_sid ?? "").trim();
  const auth_token = (v.auth_token ?? "").trim();
  const whatsapp_number = (v.whatsapp_number ?? "").trim();
  if (!account_sid || !auth_token || !whatsapp_number) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  const badCreds =
    "Credenciais inválidas — confira o Account SID e o Auth Token no console da Twilio.";
  try {
    const auth = btoa(`${account_sid}:${auth_token}`);
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${account_sid}.json`, {
      headers: { Authorization: `Basic ${auth}` },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403 || r.status === 404) {
      return { ok: false, error: badCreds };
    }
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badCreds };
  }
}

// Domínio de e-mail simples: rótulos (a-z0-9 + hífen interno) separados por
// ponto, TLD de 2+ letras. Rejeita "@site.com", "https://site.com", "site.com/".
const DOMAIN_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/i;

async function testResend(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const api_key = (v.api_key ?? "").trim();
  const from_domain = (v.from_domain ?? "").trim();
  const webhook_signing_secret = (v.webhook_signing_secret ?? "").trim();
  if (!api_key || !from_domain) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  if (!DOMAIN_RE.test(from_domain)) {
    return {
      ok: false,
      error:
        "Domínio inválido — informe só o domínio, ex.: minhaempresa.com.br (sem @, sem https:// e sem barra final).",
    };
  }
  const badKey = "API Key inválida — gere uma nova em API Keys no painel do Resend.";
  const notVerified =
    "O domínio informado não está verificado no Resend — verifique-o em Domains e tente de novo.";
  try {
    const r = await fetch("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${api_key}` },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: badKey };
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    const data = await r.json().catch(() => ({}) as Record<string, unknown>);
    const domains: Array<{ name: string; status: string }> =
      (data as { data?: Array<{ name: string; status: string }> })?.data ?? [];
    const target = from_domain.toLowerCase();
    const found = domains.find((d) => d.name?.toLowerCase() === target);
    if (!found || found.status !== "verified") {
      return { ok: false, error: notVerified };
    }
    // webhook_signing_secret é obrigatório desde a migration
    // 20260712180000 — sem ele, messaging-webhook/resend rejeita 401
    // (fail-closed HMAC Svix). Se o catálogo declarou o campo mas o admin
    // não preencheu, falha aqui com mensagem específica em vez de deixar
    // a integração "ativa" mas com inbound morto.
    if ("webhook_signing_secret" in v && !webhook_signing_secret) {
      return {
        ok: false,
        error:
          "Cadastre também o Signing Secret do webhook (começa com whsec_, obtido em resend.com/webhooks). Sem ele, e-mails recebidos são rejeitados.",
      };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badKey };
  }
}

async function testElevenLabs(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const api_key = (v.api_key ?? "").trim();
  if (!api_key) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  // /v1/models exige apenas escopo básico (Text to Speech), presente em qualquer
  // chave utilizável pelo CRM. Evita 401 falso quando a chave é restrita e
  // não tem `user_read` (que /v1/user exigiria).
  const badKey =
    "API Key inválida — gere uma nova em API Keys no painel da ElevenLabs, com permissão de Text to Speech habilitada.";
  try {
    const r = await fetch("https://api.elevenlabs.io/v1/models", {
      headers: { "xi-api-key": api_key },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: badKey };
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badKey };
  }
}

const LLAMACLOUD_BASE_URLS: Record<string, string> = {
  na: "https://api.cloud.llamaindex.ai",
  eu: "https://api.cloud.eu.llamaindex.ai",
};

function llamaCloudBaseUrl(region: string): string | null {
  return LLAMACLOUD_BASE_URLS[region] ?? null;
}

/**
 * Detecta em qual região a API key vive. O LlamaCloud não mostra a região em
 * lugar nenhum da UI dele — o usuário só tem a chave —, então em vez de pedir
 * que ele adivinhe, tentamos NA e depois EU e guardamos a que autenticar.
 * Região explícita (integrações antigas que já gravaram `region`) é
 * respeitada e nunca vira varredura.
 */
async function detectLlamaCloudRegion(
  apiKey: string,
  regions: string[],
): Promise<{ region: string } | { error: string }> {
  let lastError = "API Key inválida ou sem permissão no LlamaCloud.";
  for (const region of regions) {
    const baseUrl = LLAMACLOUD_BASE_URLS[region];
    try {
      const r = await fetch(`${baseUrl}/api/v1/projects`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
      });
      if (r.ok) return { region };
      // 401/403 = chave não é dessa região: segue para a próxima. Qualquer
      // outro status é problema do provedor, não da chave.
      if (r.status !== 401 && r.status !== 403) lastError = NETWORK_MSG;
    } catch (e) {
      if (e instanceof TypeError) return { error: BAD_CHARS_MSG };
      lastError = isNetworkError(e)
        ? NETWORK_MSG
        : "Não foi possível validar a API Key do LlamaCloud.";
    }
  }
  return { error: lastError };
}

const MALFORMED_RESPONSE_MSG =
  "O provedor respondeu em formato inesperado. Tente de novo em instantes.";

function classifyProviderTestError(
  e: unknown,
  badCredentials: string,
): { ok: false; error: string } {
  if (isNetworkError(e)) return { ok: false, error: NETWORK_MSG };
  if (e instanceof SyntaxError) return { ok: false, error: MALFORMED_RESPONSE_MSG };
  if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
  return { ok: false, error: badCredentials };
}


async function testAgentPlatform(
  v: Record<string, string>,
): Promise<{ ok: boolean; error?: string }> {
  const api_token = (v.api_token ?? "").trim();
  const workspace_id = (v.workspace_id ?? "").trim();
  if (!api_token || !workspace_id) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  const badToken =
    "Token inválido — gere um novo em Configurações > API no painel do provedor de agentes e cole aqui.";
  try {
    // `GET /v2/workspaces` é a leitura mais barata do contrato e prova as duas
    // coisas de uma vez: token válido E workspace informado pertencendo à conta.
    // Base sem `/v2` no fim: todo path do contrato já começa com `/v2` (ver
    // supabase/functions/_shared/agent-platform/client.ts).
    const base = normalizeBaseUrl(Deno.env.get("AGENT_PLATFORM_API_BASE_URL"));
    const r = await fetch(`${base}/v2/workspaces`, {
      headers: { Authorization: `Bearer ${api_token}`, Accept: "application/json" },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: badToken };
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    const workspaces = (await r.json()) as Array<{ id?: string; name?: string }>;
    if (!Array.isArray(workspaces) || workspaces.length === 0) {
      return {
        ok: false,
        error:
          "O token é válido mas não há workspace acessível nessa conta do provedor de agentes.",
      };
    }
    if (!workspaces.some((w) => w?.id === workspace_id)) {
      const nomes = workspaces
        .map((w) => `${w.name ?? "sem nome"} (${w.id ?? "?"})`)
        .slice(0, 5)
        .join(", ");
      return {
        ok: false,
        error: `O workspace informado não está nessa conta. Disponíveis: ${nomes}.`,
      };
    }
    return { ok: true };
  } catch (e) {
    return classifyProviderTestError(e, badToken);
  }
}

async function testLlamaCloud(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const apiKey = String(v.api_key ?? "").trim();
  if (!apiKey) return { ok: false, error: "Preencha a API Key do LlamaCloud." };
  const explicit = String(v.region ?? "").trim().toLowerCase();
  const regions = explicit in LLAMACLOUD_BASE_URLS ? [explicit] : Object.keys(LLAMACLOUD_BASE_URLS);
  const result = await detectLlamaCloudRegion(apiKey, regions);
  if ("error" in result) return { ok: false, error: result.error };
  // Guarda a região detectada para o metadataForSlug abaixo (mesmo objeto de
  // values que o handler já usa) — evita repetir a varredura no salvamento.
  v.region = result.region;
  return { ok: true };
}

async function testMetaCloud(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const access_token = (v.access_token ?? "").trim();
  const phone_number_id = (v.phone_number_id ?? "").trim();
  const app_secret = (v.app_secret ?? "").trim();
  if (!access_token || !phone_number_id) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  const badCreds =
    "Credenciais inválidas — confira o Access Token e o Phone Number ID no painel do app da Meta.";
  try {
    const id = encodeURIComponent(String(phone_number_id).replace(/\D/g, ""));
    const r = await fetch(`https://graph.facebook.com/v23.0/${id}?fields=id,display_phone_number`, {
      headers: { Authorization: `Bearer ${access_token}` },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (r.status === 400 || r.status === 401 || r.status === 403 || r.status === 404) {
      return { ok: false, error: badCreds };
    }
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    // app_secret é obrigatório desde 20260708230000_meta_require_app_secret
    // (fail-closed HMAC em messaging-webhook/meta-cloud). Mesmo padrão do
    // webhook_signing_secret no Resend acima.
    if ("app_secret" in v && !app_secret) {
      return {
        ok: false,
        error:
          "Cadastre também o App Secret (Configurações > Básico no painel do app da Meta). Sem ele, mensagens recebidas são rejeitadas.",
      };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badCreds };
  }
}

/**
 * Testa credenciais Evolution chamando `GET /instance/status` (mesmo cliente
 * usado pelo watchdog/reconcile — nenhuma lógica de HTTP nova aqui). Passar
 * neste teste só prova que api_url/instance_name/api_key autenticam contra o
 * servidor Evolution; NÃO prova que a sessão WhatsApp já está conectada
 * ("connected" ou "disconnected" são ambos sucesso de autenticação — só
 * "error" é falha real de credenciais/rede). A resolução de status inicial
 * do canal (incluindo QR code se necessário) acontece depois, no bloco de
 * sync de `channels`, não aqui.
 */
async function testEvolution(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const { api_url, instance_name, api_key } = v;
  if (!api_url || !instance_name || !api_key) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  // SSRF guard: api_url é digitada pelo admin e vai virar fetch de dentro
  // da infra de edge functions — precisa ser https e não pode apontar para
  // loopback/IP privado/host de metadata de cloud.
  const { validatePublicHttpsUrl } = await import("../_shared/validate-http-url.ts");
  const urlCheck = await validatePublicHttpsUrl(api_url);
  if (!urlCheck.ok) {
    return { ok: false, error: urlCheck.error ?? "URL do servidor Evolution inválida." };
  }
  const result = await checkEvolutionInstanceStatus({
    api_url,
    instance_name,
    api_key,
    instance_token: v.instance_token,
  });
  if (result.state === "error") {
    return {
      ok: false,
      error:
        result.message ??
        "Não foi possível conectar ao servidor Evolution — confira a URL, o nome da instância e a API key.",
    };
  }
  return { ok: true };
}

/**
 * doutore não tem required_secrets (o webhook_token é minerado pelo sistema
 * no fluxo de connect via mintWebhookToken(), nunca digitado pelo admin) —
 * não há credencial pra validar contra uma API externa, então "conectar"
 * aqui só precisa suceder.
 */
async function testDoutore(_v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  return { ok: true };
}

async function testMetaAds(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const { access_token, app_secret } = v;
  if (!access_token || !app_secret) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  const badCreds = "Credenciais inválidas — confira o Access Token no Meta Business Suite.";
  try {
    const r = await fetch(
      `https://graph.facebook.com/v23.0/me?access_token=${encodeURIComponent(access_token)}`,
      { signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS) },
    );
    if (r.status === 400 || r.status === 401 || r.status === 403) {
      return { ok: false, error: badCreds };
    }
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badCreds };
  }
}

function feegowDateBr(d: Date): string {
  const dd = String(d.getDate()).padStart(2, "0");
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  return `${dd}-${mm}-${d.getFullYear()}`;
}

/**
 * Valida clinic_id+access_token chamando GET /appoints/search com uma janela
 * de 1 dia (hoje) -- mesmo endpoint que feegow-sync/runner.ts usa de
 * verdade, então "conectar com sucesso" aqui já prova que o sync vai
 * funcionar. maxRetries:1 evita o backoff exponencial do client (até ~4s)
 * travando a resposta desta chamada síncrona de connect.
 */
async function testFeegow(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const clinic_id = (v.clinic_id ?? "").trim();
  const access_token = (v.access_token ?? "").trim();
  if (!clinic_id || !access_token) {
    return { ok: false, error: "Preencha todos os campos obrigatórios." };
  }
  const badCreds =
    "Credenciais inválidas — confira o ID da clínica e o Access Token no painel do Feegow.";
  const today = feegowDateBr(new Date());
  try {
    await searchAppointments(
      { clinicId: clinic_id, accessToken: access_token },
      { data_start: today, data_end: today },
      { maxRetries: 1 },
    );
    return { ok: true };
  } catch (e) {
    if (e instanceof FeegowError) {
      if (e.code === FeegowErrorCode.INVALID_TOKEN) return { ok: false, error: badCreds };
      if (e.isRetryable) return { ok: false, error: NETWORK_MSG };
      return { ok: false, error: badCreds };
    }
    if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badCreds };
  }
}

async function testZappaz(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const api_key = String(v.api_key ?? "").trim();
  const session_id = String(v.session_id ?? "").trim();
  if (!api_key) return { ok: false, error: "API Key da Zappaz é obrigatória." };
  if (!session_id) return { ok: false, error: "Session ID da Zappaz é obrigatório." };
  return await checkZappazSession({ api_key, session_id });
}

async function testApify(v: Record<string, string>): Promise<{ ok: boolean; error?: string }> {
  const api_token = String(v.api_token ?? "").trim();
  if (!api_token) return { ok: false, error: "Preencha todos os campos obrigatórios." };
  const badKey =
    "API token inválido — gere um novo em Settings > API & Integrations no Apify Console.";
  try {
    // Token via Authorization: Bearer (não query param) — mantém o segredo fora
    // da URL, que vaza em access log/proxy. A API v2 da Apify aceita ambos.
    const r = await fetch("https://api.apify.com/v2/users/me", {
      headers: { Authorization: `Bearer ${api_token}` },
      signal: AbortSignal.timeout(PROVIDER_TEST_TIMEOUT_MS),
    });
    if (r.status === 401 || r.status === 403) return { ok: false, error: badKey };
    if (!r.ok) return { ok: false, error: NETWORK_MSG };
    const data = ((await r.json()) as { data?: { plan?: { enabledPlatformFeatures?: string[] } } })
      ?.data;
    const features = data?.plan?.enabledPlatformFeatures ?? [];
    // ACTORS_PUBLIC_ALL = permissão de rodar Actors da Store. O Creator plan não a
    // tem (só ACTORS_PUBLIC_DEVELOPER) e falharia em todo enriquecimento — barramos
    // no connect, com orientação, em vez de deixar quebrar em cada run depois.
    if (!features.includes("ACTORS_PUBLIC_ALL")) {
      return {
        ok: false,
        error:
          "Sua conta Apify não pode rodar Actors da Store (provável Creator plan). Use uma conta com acesso completo à Store (plano Free ou Starter) para o enriquecimento funcionar.",
      };
    }
    return { ok: true };
  } catch (e) {
    if (e instanceof TypeError) return { ok: false, error: BAD_CHARS_MSG };
    return { ok: false, error: isNetworkError(e) ? NETWORK_MSG : badKey };
  }
}

type TestResult = { ok: boolean; error?: string; meta?: Record<string, unknown> };

// ManyChat: GET /fb/page/getInfo (read-only). Nome/ID da conta viram metadado
// público do canal; a chave nunca sai do servidor.
async function testManyChat(v: Record<string, string>): Promise<TestResult> {
  const result = await validateManyChatCredentials(String(v.api_key ?? ""));
  if (!result.ok) return { ok: false, error: result.error };
  return {
    ok: true,
    meta: { manychat_page_id: result.page.id, manychat_page_name: result.page.name },
  };
}

async function runTest(slug: string, values: Record<string, string>): Promise<TestResult> {
  if (isManyChatSlug(slug)) return testManyChat(values);
  if (slug === "apify") return testApify(values);
  if (slug === "zapi") return testZapi(values);
  if (slug === "twilio") return testTwilio(values);
  if (slug === "resend") return testResend(values);
  if (slug === "elevenlabs") return testElevenLabs(values);
  if (slug === "llamacloud") return testLlamaCloud(values);
  if (slug === "agent-platform") return testAgentPlatform(values);
  if (slug === "meta-cloud") return testMetaCloud(values);
  if (slug === "evolution") return testEvolution(values);
  if (slug === "zappaz") return testZappaz(values);
  if (slug === "doutore") return testDoutore(values);
  if (slug === "meta-ads") return testMetaAds(values);
  if (slug === "feegow") return testFeegow(values);
  return { ok: false, error: "Integração não suportada." };
}

function metadataForSlug(slug: string, values: Record<string, string>): Record<string, unknown> {
  if (slug === "zapi") return { instance_id: values.instance_id };
  if (slug === "twilio")
    return { whatsapp_number: values.whatsapp_number, account_sid: values.account_sid };
  if (slug === "resend") return { from_domain: values.from_domain };
  if (slug === "meta-cloud") return { phone_number_id: values.phone_number_id };
  if (slug === "evolution") return { api_url: values.api_url, instance_name: values.instance_name };
  if (slug === "zappaz")
    return { session_id: values.session_id, has_api_key: Boolean(values.api_key) };
  if (slug === "feegow") return { clinic_id: values.clinic_id };
  if (slug === "llamacloud") {
    const region = String(values.region ?? "").trim().toLowerCase();
    return { region, base_url: llamaCloudBaseUrl(region) };
  }
  return {};
}

// Provedores de WhatsApp reconhecidos (podem coexistir por tenant — a
// escolha de qual número exibir fica no filtro do inbox).
const WHATSAPP_SLUGS = ["zapi", "twilio", "meta-cloud", "evolution", "zappaz"];

/**
 * Gera um token de webhook opaco (mesmo formato usado por
 * `tenant_integrations.webhook_token` — dois UUIDs v4 concatenados sem
 * hífens, sem significado semântico, só entropia suficiente pra autenticar
 * callbacks de provider).
 */
function mintWebhookToken(): string {
  return crypto.randomUUID().replaceAll("-", "") + crypto.randomUUID().replaceAll("-", "");
}

function channelTypeForSlug(
  slug: string,
): "whatsapp" | "email" | "instagram" | "messenger" | null {
  if (WHATSAPP_SLUGS.includes(slug) || slug === "manychat-whatsapp") return "whatsapp";
  if (slug === "manychat-instagram") return "instagram";
  if (slug === "manychat-messenger") return "messenger";
  if (slug === "resend") return "email";
  return null;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });
  if (req.method !== "POST") return json(405, { error: "Method not allowed" });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const ANON = Deno.env.get("SUPABASE_ANON_KEY") ?? Deno.env.get("SUPABASE_PUBLISHABLE_KEY")!;
  const authHeader = req.headers.get("Authorization") ?? "";

  // Identify caller via anon client + user token, then check role via service client.
  const userClient = createClient(SUPABASE_URL, ANON, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: authHeader } },
  });
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return json(401, { error: "Não autenticado." });

  const { data: profile, error: profErr } = await admin
    .from("profiles")
    .select("tenant_id, role")
    .eq("id", userData.user.id)
    .maybeSingle();
  // MEDIUM (code review rodada 3): erro de leitura do perfil não é "perfil não
  // existe" — 403 manda o admin caçar um problema de cadastro inexistente
  // enquanto a causa real é o banco. Mesma separação já feita para o catálogo
  // logo abaixo: infra → 200 {ok:false} com rastro; ausência real → 403.
  if (profErr) {
    await reportError(admin, null, "perfil", `falha ao ler perfil: ${profErr.message}`, {
      user_id: userData.user.id,
    });
    return json(200, {
      ok: false,
      error: "Instabilidade ao verificar suas permissões. Tente de novo em instantes.",
    });
  }
  if (!profile) return json(403, { error: "Perfil não encontrado." });
  if (profile.role !== "admin") return json(403, { error: "Apenas administradores." });

  const tenantId = profile.tenant_id as string;

  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return json(400, { error: "Corpo inválido." });
  }
  const { action, slug } = body;
  if (!action || !slug) return json(400, { error: "action e slug são obrigatórios." });

  // Validate slug against catalog
  // MEDIUM (code review): erro de leitura do catálogo não pode virar
  // "não encontrada" — 404 manda o admin caçar um problema de cadastro que não
  // existe, enquanto a causa real é o banco. Distingue os dois casos.
  const { data: cat, error: catError } = await admin
    .from("integrations")
    .select("slug, available, required_secrets")
    .eq("slug", slug)
    .maybeSingle();
  if (catError) {
    await reportError(
      admin,
      tenantId,
      // `action` ainda não foi validada contra o union aqui — vai no context,
      // nunca interpolada em `operation` (coluna lida por admin na UI de falhas).
      "catalogo",
      `falha ao ler catálogo: ${catError.message}`,
      { slug, action },
    );
    return json(200, {
      ok: false,
      error: "Instabilidade ao consultar o catálogo de integrações. Tente de novo em instantes.",
    });
  }
  if (!cat) return json(404, { error: "Integração não encontrada." });
  if (!cat.available) return json(400, { error: "Integração ainda não disponível." });

  if (action === "connect") {
    const values = body.values ?? {};
    // `optional: true` no catálogo (ex.: instance_token da Evolution) participa
    // do merge/persistência, mas nunca entra no check de campos faltando.
    const catalogFields = (cat.required_secrets as Array<{ key: string; optional?: boolean }>) ?? [];
    const requiredKeys = catalogFields.map((f) => f.key);
    const mandatoryKeys = catalogFields.filter((f) => !f.optional).map((f) => f.key);

    // Merge with existing stored secrets so re-open of modal only requires new/changed values.
    // MEDIUM (code review): erro nesta leitura virava `merged` vazio, ou seja
    // "Preencha: ..." — culpava o admin por uma falha de infra, e ele reenviava
    // campos que já estavam salvos. Fail-closed com mensagem honesta.
    const { data: existingRows, error: existingRowsError } = await admin
      .from("integration_secrets")
      .select("key, value")
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    if (existingRowsError) {
      await reportError(
        admin,
        tenantId,
        "connect.ler_segredos",
        `falha ao ler segredos existentes: ${existingRowsError.message}`,
        { slug },
      );
      return json(200, {
        ok: false,
        error: "Instabilidade ao ler as credenciais já salvas. Tente de novo em instantes.",
      });
    }
    const merged: Record<string, string> = {};
    for (const row of existingRows ?? []) merged[row.key] = row.value as string;
    for (const k of requiredKeys) {
      if (values[k] && values[k].length > 0) merged[k] = values[k];
    }
    const missing = mandatoryKeys.filter((k) => !merged[k]);
    if (missing.length > 0) {
      // 200 + {ok:false}: `functions.invoke` descarta o corpo em não-2xx, então
      // um 400 aqui virava "Edge Function returned a non-2xx status code" na tela
      // e o admin nunca via QUAIS campos faltavam.
      return json(200, { ok: false, error: `Preencha: ${missing.join(", ")}` });
    }

    // Evolution Go: os endpoints por instância (/instance/status, /qr,
    // /reconnect, /send/*) autenticam pelo token DA INSTÂNCIA — a chave global
    // devolve 401. Descobre o token pelo nome digitado (GET /instance/all) e
    // guarda junto dos demais segredos, para o watchdog/reconcile reaproveitar.
    if (slug === "evolution" && !merged.instance_token) {
      const resolved = await resolveEvolutionInstanceToken({
        api_url: merged.api_url,
        instance_name: merged.instance_name,
        api_key: merged.api_key,
      });
      if (!resolved.ok || !resolved.token) {
        return json(200, {
          ok: false,
          error: resolved.error ?? "Não foi possível identificar a instância Evolution.",
        });
      }
      merged.instance_token = resolved.token;
    }

    // Test BEFORE persisting anything new.
    const test = await runTest(slug, merged);
    const now = new Date().toISOString();

    if (!test.ok) {
      // MEDIUM (code review): sem checar, `last_error` nunca era gravado e o card
      // da integração ficava sem o motivo real da falha (a UI lê essa coluna).
      // Só loga: a resposta certa para o admin continua sendo o erro de
      // credencial do teste, não uma mensagem de infra que mascara a causa.
      const { error: errUpsertError } = await admin.from("tenant_integrations").upsert(
        {
          tenant_id: tenantId,
          slug,
          status: "error",
          last_check_at: now,
          last_error: test.error ?? "Falha ao conectar.",
        },
        { onConflict: "tenant_id,slug" },
      );
      if (errUpsertError) {
        await reportError(
          admin,
          tenantId,
          "connect.marcar_erro",
          `falha ao gravar status de erro: ${errUpsertError.message}`,
          { slug, test_error: test.error },
        );
      }
      return json(200, { ok: false, error: test.error });
    }

    // ManyChat: o segredo do header x-webhook-secret é gerado AQUI, nunca
    // digitado. Reconexão preserva o existente (veio em `merged` das linhas
    // salvas) — trocar em silêncio quebraria o External Request já configurado.
    // Só um segredo recém-criado volta na resposta, uma única vez.
    let mintedWebhookSecret: string | null = null;
    if (isManyChatSlug(slug) && !merged.webhook_secret) {
      mintedWebhookSecret = mintWebhookToken();
      merged.webhook_secret = mintedWebhookSecret;
    }
    const persistKeys = isManyChatSlug(slug) ? [...requiredKeys, "webhook_secret"] : requiredKeys;

    // Persist secrets (upsert per key).
    // Campos opcionais vazios não viram linha (value NOT NULL em
    // integration_secrets) — só persiste o que realmente tem valor.
    const rows = persistKeys
      .filter((k) => merged[k] !== undefined && merged[k] !== "")
      .map((k) => ({
        tenant_id: tenantId,
        slug,
        key: k,
        value: merged[k],
      }));
    // CRITICAL (code review): sem checar este upsert, uma falha de persistência
    // (RLS, coluna ausente pós-migration, conflito de índice) deixava a integração
    // marcada "active" logo abaixo — badge verde na UI, envio quebrando depois com
    // erro genérico de credencial. Aborta ANTES de marcar ativo.
    const { error: secretsError } = await admin
      .from("integration_secrets")
      .upsert(rows, { onConflict: "tenant_id,slug,key" });
    if (secretsError) {
      await reportError(
        admin,
        tenantId,
        "connect.gravar_segredos",
        `falha ao gravar segredos: ${secretsError.message}`,
        { slug },
      );
      return json(200, {
        ok: false,
        error: "Não conseguimos salvar as credenciais. Tente de novo em instantes.",
      });
    }

    const config = { ...metadataForSlug(slug, merged), ...(test.meta ?? {}) };

    // Preserve or mint a webhook_token so provider callbacks can be authenticated.
    // HIGH (code review): erro nesta LEITURA não pode virar "não existe token" —
    // isso mintaria um token NOVO e o upsert abaixo gravaria com sucesso, trocando
    // silenciosamente o token que já está cadastrado no painel do provider. Todo o
    // inbound legado passaria a bater 401 e Meta/Evolution acabariam desabilitando
    // a assinatura do webhook. Fail-closed: erro de leitura aborta a reconexão.
    const { data: existing, error: existingError } = await admin
      .from("tenant_integrations")
      .select("webhook_token")
      .eq("tenant_id", tenantId)
      .eq("slug", slug)
      .maybeSingle();
    if (existingError) {
      await reportError(
        admin,
        tenantId,
        "connect.ler_webhook_token",
        `falha ao ler webhook_token: ${existingError.message}`,
        { slug },
      );
      return json(200, {
        ok: false,
        error: "Instabilidade ao acessar a integração. Tente conectar de novo em instantes.",
      });
    }
    let webhookToken = (existing?.webhook_token as string | null) ?? null;
    if (!webhookToken) {
      webhookToken = mintWebhookToken();
    }

    const { error: tiUpsertError } = await admin.from("tenant_integrations").upsert(
      {
        tenant_id: tenantId,
        slug,
        status: "active",
        config,
        connected_at: now,
        last_check_at: now,
        last_error: null,
        webhook_token: webhookToken,
      },
      { onConflict: "tenant_id,slug" },
    );
    // Segredos já foram gravados acima; se marcar "active" falhar, a UI mostraria
    // a integração como desconectada apesar de conectada. Reporta em vez de fingir.
    if (tiUpsertError) {
      await reportError(
        admin,
        tenantId,
        "connect.marcar_ativo",
        `segredos gravados mas falha ao marcar ativo: ${tiUpsertError.message}`,
        { slug },
      );
      return json(200, {
        ok: false,
        error:
          "As credenciais foram salvas, mas não conseguimos ativar a integração. Recarregue a página e tente novamente.",
      });
    }

    // Sync channel row
    const chType = channelTypeForSlug(slug);
    if (chType) {
      // Vários provedores de WhatsApp podem coexistir por tenant. Cada
      // provedor mantém seu próprio canal; o inbox seleciona qual número
      // exibir. Não desativa nada aqui.

      // Passar em testEvolution só prova que as credenciais autenticam --
      // não prova que a sessão WhatsApp já está conectada. Resolve o status
      // real (e, se preciso, gera QR code na hora em vez de esperar o
      // próximo ciclo do watchdog/reconcile) só para o provider evolution;
      // os outros 3 continuam com o "connected" hardcoded de sempre.
      let channelStatus = "connected";
      let channelQrCode: string | null = null;
      if (slug === "evolution") {
        const cred: EvolutionCredentials = {
          api_url: merged.api_url,
          instance_name: merged.instance_name,
          api_key: merged.api_key,
          instance_token: merged.instance_token,
        };
        const statusResult = await checkEvolutionInstanceStatus(cred);
        if (statusResult.state === "connected") {
          channelStatus = "connected";
        } else {
          // Não conectado ainda -- tenta reconectar/gerar QR na hora (mesma
          // lógica usada pelo evolution-watchdog em
          // supabase/functions/evolution-watchdog/runner.ts, processChannel),
          // pra dar feedback imediato no onboarding em vez de esperar o
          // próximo ciclo do cron.
          const reconnect = await reconnectEvolutionInstance(cred);
          if (reconnect.qrCode) {
            channelStatus = "waiting_qr";
            channelQrCode = reconnect.qrCode;
          } else {
            channelStatus = reconnect.ok ? "connecting" : "disconnected";
          }
        }
      }

      // HIGH (code review): erro nesta leitura NÃO pode virar "canal não existe".
      // Não há unique em channels(tenant_id, provider_slug), então o fluxo cairia
      // no INSERT e criaria um canal DUPLICADO. O resolver do webhook usa
      // .maybeSingle() filtrando status='connected' — com 2 linhas connected ele
      // retorna erro, `ch` vira null e TODO o inbound do tenant passa a ser
      // descartado. Fail-closed: erro de leitura aborta a conexão.
      const { data: existingCh, error: existingChError } = await admin
        .from("channels")
        .select("id, webhook_token")
        .eq("tenant_id", tenantId)
        .eq("provider_slug", slug)
        .maybeSingle();
      if (existingChError) {
        await reportError(
          admin,
          tenantId,
          "connect.ler_canal",
          `falha ao ler canal existente: ${existingChError.message}`,
          { slug },
        );
        return json(200, {
          ok: false,
          error: "Instabilidade ao acessar o canal de mensagens. Tente conectar de novo.",
        });
      }

      const finalStatus = slug === "evolution" ? channelStatus : "connected";
      const finalConfig = { ...config };

      let effectiveWebhookToken: string | null = null;
      let effectiveChannelId: string | null = null;
      if (existingCh) {
        const patch: Record<string, unknown> = { status: finalStatus, config: finalConfig };
        if (slug === "evolution") {
          patch.qr_code = channelQrCode;
          patch.qr_code_expires_at = channelQrCode
            ? new Date(Date.now() + QR_CODE_TTL_MS).toISOString()
            : null;
        }
        if (
          (slug === "evolution" || slug === "zappaz" || isManyChatSlug(slug)) &&
          !existingCh.webhook_token
        ) {
          patch.webhook_token = mintWebhookToken();
        }
        // HIGH (code review): sem checar, o canal ficava com status/config antigos
        // enquanto a UI mostrava "conectado" — no Evolution o qr_code nunca chegava
        // à tela. Best-effort com log: os segredos já foram gravados, então não vale
        // abortar a conexão inteira aqui, mas a falha precisa ser visível.
        const { error: chUpdError } = await admin
          .from("channels")
          .update(patch)
          .eq("id", existingCh.id);
        if (chUpdError) {
          await reportError(
            admin,
            tenantId,
            "connect.atualizar_canal",
            `falha ao atualizar canal: ${chUpdError.message}`,
            { slug, channel_id: existingCh.id, status: finalStatus },
          );
        }
        effectiveWebhookToken =
          (patch.webhook_token as string | undefined) ?? existingCh.webhook_token ?? null;
        effectiveChannelId = existingCh.id as string;
      } else {
        const insertRow: Record<string, unknown> = {
          tenant_id: tenantId,
          type: chType,
          provider_slug: slug,
          status: finalStatus,
          config: finalConfig,
        };
        if (slug === "evolution") {
          insertRow.qr_code = channelQrCode;
          insertRow.qr_code_expires_at = channelQrCode
            ? new Date(Date.now() + QR_CODE_TTL_MS).toISOString()
            : null;
        }
        if (slug === "evolution" || slug === "zappaz" || isManyChatSlug(slug)) {
          insertRow.webhook_token = mintWebhookToken();
          effectiveWebhookToken = insertRow.webhook_token as string;
        }
        // HIGH (code review): sem linha de canal, TODO o inbound do tenant morre
        // (o webhook não resolve canal e descarta a mensagem) — e a UI mostrava
        // badge verde. Erro aqui aborta a conexão em vez de fingir sucesso.
        const { data: inserted, error: chInsError } = await admin
          .from("channels")
          .insert(insertRow)
          .select("id")
          .maybeSingle();
        if (chInsError || !inserted?.id) {
          const insMsg = chInsError?.message ?? "sem id retornado";
          await reportError(
            admin,
            tenantId,
            "connect.criar_canal",
            `falha ao criar canal: ${insMsg}`,
            {
              slug,
            },
          );
          // Escrita compensatória: o upsert acima já marcou status='active'. Sem
          // isto, o tenant fica com badge verde permanente (o banco diz ativo) e
          // inbound morto, porque não existe canal para o webhook resolver.
          // HIGH (code review rodada 3): é justamente a escrita que impede o badge
          // verde permanente — se ELA falhar em silêncio, o cenário que ela existe
          // para evitar acontece mesmo assim, e sem rastro nenhum.
          const { error: compError } = await admin
            .from("tenant_integrations")
            .update({ status: "error", last_error: `Falha ao criar canal: ${insMsg}` })
            .eq("tenant_id", tenantId)
            .eq("slug", slug);
          if (compError) {
            await reportError(
              admin,
              tenantId,
              "connect.compensar_status",
              `falha ao marcar integração como erro: ${compError.message}`,
              { slug },
            );
          }
          return json(200, {
            ok: false,
            error:
              "Credenciais salvas, mas não conseguimos criar o canal de mensagens. Tente conectar de novo.",
          });
        }
        effectiveChannelId = inserted.id as string;
      }

      // Zappaz: registra a URL de webhook automaticamente na sessão. O caminho
      // inclui o channel_id (UUID) para bater com o branch UUID_RE do
      // messaging-webhook, que autentica por channels.id+webhook_token. O
      // `x-webhook-secret` setado aqui vira o 2º fator (comparado em tempo
      // constante com integration_secrets.api_key). Best-effort — falha aqui
      // não bloqueia o connect.
      // Evolution Go: `POST /instance/connect` é o único endpoint que aceita
      // configurar o endereço de recebimento (webhookUrl) da instância —
      // documentação oficial docs.evolutionfoundation.com.br/evolution-go.
      // Sem isto o admin teria que colar a URL à mão no painel do servidor.
      // Best-effort: falha aqui não desfaz a conexão, mas fica registrada.
      if (slug === "evolution" && effectiveWebhookToken && effectiveChannelId) {
        const callbackUrl =
          `${SUPABASE_URL}/functions/v1/messaging-webhook/${effectiveChannelId}?token=${effectiveWebhookToken}`;
        const evoConnect = await connectEvolutionInstance(
          {
            api_url: merged.api_url,
            instance_name: merged.instance_name,
            api_key: merged.api_key,
            instance_token: merged.instance_token,
          },
          callbackUrl,
        );
        if (!evoConnect.ok) {
          await reportError(
            admin,
            tenantId,
            "connect.registrar_webhook_evolution",
            `falha ao conectar instância/registrar webhook na Evolution: ${
              evoConnect.error ?? "sem detalhe"
            }`,
            { slug, channel_id: effectiveChannelId },
          );
        } else if (evoConnect.qrCode && channelStatus !== "connected") {
          // A própria conexão pode devolver o QR — reflete na hora para o
          // operador parear sem esperar o watchdog.
          const { error: qrError } = await admin
            .from("channels")
            .update({
              status: "waiting_qr",
              qr_code: evoConnect.qrCode,
              qr_code_expires_at: new Date(Date.now() + QR_CODE_TTL_MS).toISOString(),
            })
            .eq("id", effectiveChannelId);
          if (qrError) {
            await reportError(
              admin,
              tenantId,
              "connect.atualizar_qr_evolution",
              `falha ao gravar QR da Evolution: ${qrError.message}`,
              { slug, channel_id: effectiveChannelId },
            );
          }
        }
      }

      if (slug === "zappaz" && effectiveWebhookToken && effectiveChannelId) {
        const callbackUrl = `${SUPABASE_URL}/functions/v1/messaging-webhook/zappaz/${effectiveChannelId}?token=${effectiveWebhookToken}`;
        // MEDIUM (code review): o retorno era descartado em silêncio. Falhar aqui
        // significa inbound Zappaz que nunca chega, com a UI dizendo "conectado" —
        // e sem nenhum rastro para o suporte descobrir por quê. Continua
        // best-effort (não aborta o connect), mas agora deixa rastro.
        const zappazReg = await registerZappazWebhook(
          { api_key: merged.api_key, session_id: merged.session_id },
          callbackUrl,
          merged.api_key,
        );
        if (!zappazReg.ok) {
          await reportError(
            admin,
            tenantId,
            "connect.registrar_webhook_zappaz",
            `falha ao registrar webhook na Zappaz: ${zappazReg.error ?? "sem detalhe"}`,
            { slug, channel_id: effectiveChannelId },
          );
        }
      }
    }

    return json(200, {
      ok: true,
      ...(mintedWebhookSecret ? { webhook_secret: mintedWebhookSecret } : {}),
    });
  }

  // ---- Novo segredo do webhook (ManyChat) ---------------------------------
  // O segredo só é exibido uma vez. Perdeu? Gera outro e cola de novo no
  // header do External Request — o antigo para de valer na hora.
  if (action === "rotate_webhook_secret") {
    if (!isManyChatSlug(slug)) {
      return json(200, { ok: false, error: "Esta integração não usa segredo de webhook gerado." });
    }
    const secret = mintWebhookToken();
    const { error: rotateError } = await admin
      .from("integration_secrets")
      .upsert(
        [{ tenant_id: tenantId, slug, key: "webhook_secret", value: secret }],
        { onConflict: "tenant_id,slug,key" },
      );
    if (rotateError) {
      await reportError(admin, tenantId, "rotate_webhook_secret", rotateError.message, { slug });
      return json(200, {
        ok: false,
        error: "Não conseguimos gerar um novo segredo agora. Tente de novo em instantes.",
      });
    }
    return json(200, { ok: true, webhook_secret: secret });
  }


  // ---- Reconectar (Zappaz) ----------------------------------------------
  // Revalida a sessão, re-registra o webhook e reflete o resultado no canal.
  // Cada passo vira uma linha em channel_status_events (Realtime) para a UI
  // mostrar progresso ao vivo; o retorno traz o resumo final.
  if (action === "reconnect") {
    if (slug !== "zappaz") {
      return json(200, {
        ok: false,
        error: "Reconexão automática disponível apenas para a integração Zappaz.",
      });
    }

    const runId = newRunId();
    const steps: StepResult[] = [];

    const { data: ch, error: chErr } = await admin
      .from("channels")
      .select("id, webhook_token, status")
      .eq("tenant_id", tenantId)
      .eq("provider_slug", slug)
      .maybeSingle();
    if (chErr) {
      await reportError(admin, tenantId, "reconnect.ler_canal", chErr.message, { slug });
      return json(200, {
        ok: false,
        error: "Instabilidade ao acessar o canal. Tente de novo em instantes.",
      });
    }
    if (!ch) {
      return json(200, {
        ok: false,
        error: "Nenhum canal Zappaz encontrado. Conecte a integração primeiro.",
      });
    }
    const channelId = ch.id as string;

    const log = async (
      step: string,
      stepState: "running" | "ok" | "failed" | "skipped",
      reasonCode: string,
      detail: string | null,
    ) =>
      await recordChannelStatusEvent(admin, {
        tenantId,
        channelId,
        status: ch.status ?? "unknown",
        reasonCode,
        reasonDetail: detail,
        source: "reconnect",
        step,
        stepState,
        runId,
      });

    // Passo 1 — credenciais + sessão
    await log("credenciais", "running", "reconnect_started", "Validando credenciais na Zappaz…");
    let cred: Record<string, string> = {};
    try {
      cred = await loadProviderSecrets(admin, tenantId, slug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log("credenciais", "failed", "secrets_read_failed", msg);
      return json(200, { ok: false, run_id: runId, steps, error: "Não conseguimos ler as credenciais salvas." });
    }
    if (!cred.api_key || !cred.session_id) {
      const detail = "API Key ou Session ID ausentes. Atualize as credenciais.";
      await log("credenciais", "failed", "missing_credentials", detail);
      steps.push({ step: "credenciais", state: "failed", label: "Credenciais", detail });
      return json(200, { ok: false, run_id: runId, steps, error: detail });
    }

    const check = await checkZappazSession({ api_key: cred.api_key, session_id: cred.session_id });
    if (!check.ok) {
      await log("credenciais", "failed", check.code, check.error);
      steps.push({ step: "credenciais", state: "failed", label: "Sessão da Zappaz", detail: check.error });
      const channelStatus = check.code === "network" ? (ch.status ?? "error") : "error";
      await admin
        .from("channels")
        .update({ status: channelStatus, status_message: check.error })
        .eq("id", channelId);
      await recordChannelStatusEvent(admin, {
        tenantId,
        channelId,
        status: channelStatus,
        reasonCode: check.code,
        reasonDetail: check.error,
        source: "reconnect",
        runId,
      });
      return json(200, { ok: false, run_id: runId, steps, error: check.error });
    }
    await log("credenciais", "ok", "session_open", "Sessão respondendo na Zappaz.");
    steps.push({ step: "credenciais", state: "ok", label: "Sessão da Zappaz", detail: "Sessão ativa." });

    // Passo 2 — webhook
    await log("webhook", "running", "webhook_register_started", "Registrando a URL de webhook…");
    let webhookToken = (ch.webhook_token as string | null) ?? null;
    if (!webhookToken) {
      webhookToken = mintWebhookToken();
      // O messaging-webhook autentica por channels.id + webhook_token. Registrar
      // no provedor um token que não foi gravado deixa o canal mudo: a Zappaz
      // posta, nós rejeitamos, e a UI diz "conectado". Falhar aqui é a única
      // saída honesta.
      const { error: tokenErr } = await admin
        .from("channels")
        .update({ webhook_token: webhookToken })
        .eq("id", channelId);
      if (tokenErr) {
        await reportError(
          admin,
          tenantId,
          "reconnect.gravar_webhook_token",
          `falha ao gravar webhook_token: ${tokenErr.message}`,
          { slug, channel_id: channelId },
        );
        await log("webhook", "failed", "webhook_token_persist_failed", "Não foi possível gravar o token do webhook.");
        steps.push({
          step: "webhook",
          state: "failed",
          label: "Webhook",
          detail: "Não foi possível gravar o token do webhook. Tente novamente.",
        });
        return json(200, {
          ok: false,
          run_id: runId,
          steps,
          error: "Não foi possível gravar o token do webhook.",
        });
      }
    }
    const callbackUrl =
      `${SUPABASE_URL}/functions/v1/messaging-webhook/zappaz/${channelId}?token=${webhookToken}`;
    const reg = await registerZappazWebhook(
      { api_key: cred.api_key, session_id: cred.session_id },
      callbackUrl,
      cred.api_key,
    );
    if (reg.ok) {
      await log("webhook", "ok", "webhook_registered", "Webhook registrado na sessão.");
      steps.push({ step: "webhook", state: "ok", label: "Webhook", detail: "Registrado na Zappaz." });
    } else {
      const detail = `Não conseguimos registrar o webhook automaticamente (${reg.error ?? "sem detalhe"}). Cadastre a URL manualmente no painel da Zappaz.`;
      await log("webhook", "failed", "webhook_register_failed", detail);
      steps.push({ step: "webhook", state: "failed", label: "Webhook", detail });
    }

    // Passo 3 — canal
    await log("canal", "running", "channel_update_started", "Atualizando o estado do canal…");
    const nowIso = new Date().toISOString();
    const { data: cur } = await admin
      .from("channels")
      .select("config")
      .eq("id", channelId)
      .maybeSingle();
    const cfg = (cur?.config ?? {}) as Record<string, unknown>;
    // Limpa o marcador de conflito: o operador acabou de reconectar
    // conscientemente, então o cooldown de flapping não deve mais bloquear o
    // próximo `open` vindo do webhook.
    delete cfg.zappaz_last_conflict_at;
    const { error: updErr } = await admin
      .from("channels")
      .update({
        status: "connected",
        status_message: null,
        last_connected_at: nowIso,
        config: cfg,
      })
      .eq("id", channelId);
    if (updErr) {
      await log("canal", "failed", "channel_update_failed", updErr.message);
      steps.push({ step: "canal", state: "failed", label: "Canal", detail: updErr.message });
      return json(200, {
        ok: false,
        run_id: runId,
        steps,
        error: "Sessão validada, mas não conseguimos atualizar o canal. Tente de novo.",
      });
    }
    await admin
      .from("tenant_integrations")
      .update({ status: "active", last_error: null, last_check_at: nowIso })
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    await log("canal", "ok", "channel_connected", "Canal marcado como conectado.");
    steps.push({ step: "canal", state: "ok", label: "Canal", detail: "Conectado." });

    await recordChannelStatusEvent(admin, {
      tenantId,
      channelId,
      status: "connected",
      reasonCode: "reconnect_ok",
      reasonDetail: "Reconexão concluída pelo administrador.",
      source: "reconnect",
      runId,
    });

    return json(200, { ok: true, run_id: runId, steps });
  }

  // ---- Testar mensageria (texto + áudio) ---------------------------------
  if (action === "test_messaging") {
    // ManyChat endereça por subscriber_id, não por telefone: o teste real é
    // responder uma conversa que já chegou pelo External Request.
    if (isManyChatSlug(slug)) {
      return json(200, {
        ok: false,
        error:
          "No ManyChat o envio vai para quem já escreveu. Mande uma mensagem pelo canal e responda no Inbox.",
      });
    }
    const phoneDigits = String(body.phone ?? "").replace(/\D/g, "");
    if (phoneDigits.length < 10) {
      return json(200, {
        ok: false,
        error: "Informe um número de WhatsApp válido com DDI e DDD (ex.: 5511999998888).",
      });
    }
    if (!isSupportedProviderSlug(slug)) {
      return json(200, { ok: false, error: "Integração não suporta teste de mensagem." });
    }

    const runId = newRunId();
    const steps: StepResult[] = [];

    const { data: ch } = await admin
      .from("channels")
      .select("id, status")
      .eq("tenant_id", tenantId)
      .eq("provider_slug", slug)
      .maybeSingle();
    if (!ch) {
      return json(200, {
        ok: false,
        error: "Nenhum canal encontrado para esta integração. Conecte-a primeiro.",
      });
    }
    const channelId = ch.id as string;

    const log = async (
      step: string,
      stepState: "running" | "ok" | "failed" | "skipped",
      reasonCode: string,
      detail: string | null,
    ) =>
      await recordChannelStatusEvent(admin, {
        tenantId,
        channelId,
        status: ch.status ?? "unknown",
        reasonCode,
        reasonDetail: detail,
        source: "test",
        step,
        stepState,
        runId,
      });

    let cred: Record<string, string>;
    try {
      cred = await loadProviderSecrets(admin, tenantId, slug);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      await log("credenciais", "failed", "secrets_read_failed", msg);
      return json(200, { ok: false, run_id: runId, steps, error: "Não conseguimos ler as credenciais salvas." });
    }

    // Passo 1 — texto
    await log("texto", "running", "test_text_started", "Enviando mensagem de teste…");
    const stamp = formatBrasiliaTime();
    let textResult: { ok: boolean; error?: string };
    try {
      const r = await sendViaProvider({
        admin,
        providerSlug: slug,
        cred,
        phone: phoneDigits,
        content: `Teste do AceleraFlow (${stamp}, horário de Brasília): se você recebeu esta mensagem, o envio de texto está funcionando.`,
      });
      textResult = r.ok ? { ok: true } : { ok: false, error: r.error };
    } catch (e) {
      textResult = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
    if (textResult.ok) {
      await log("texto", "ok", "test_text_sent", "Texto aceito pelo provedor.");
      steps.push({ step: "texto", state: "ok", label: "Mensagem de texto", detail: "Enviada." });
    } else {
      await log("texto", "failed", "test_text_failed", textResult.error ?? null);
      steps.push({
        step: "texto",
        state: "failed",
        label: "Mensagem de texto",
        detail: textResult.error ?? "Falha no envio.",
      });
    }

    // Passo 2 — áudio (só onde o provedor suporta E a ElevenLabs está ativa)
    await log("audio", "running", "test_audio_started", "Gerando e enviando áudio de teste…");
    if (!providerSupportsAudio(slug)) {
      const detail = "Este provedor não envia áudio.";
      await log("audio", "skipped", "audio_unsupported", detail);
      steps.push({ step: "audio", state: "skipped", label: "Áudio", detail });
    } else {
      const [voiceConfig, elevenActive] = await Promise.all([
        loadVoiceSynthesisConfiguration(admin, tenantId),
        isElevenLabsActive(admin, tenantId),
      ]);
      let elevenKey = "";
      try {
        elevenKey = (await loadProviderSecrets(admin, tenantId, "elevenlabs")).api_key ?? "";
      } catch {
        elevenKey = "";
      }
      if (!elevenActive || !elevenKey) {
        const detail = "ElevenLabs não está conectada — conecte-a para testar o áudio.";
        await log("audio", "skipped", "voice_not_configured", detail);
        steps.push({ step: "audio", state: "skipped", label: "Áudio", detail });
      } else if (!voiceConfig.voiceId) {
        const detail = "Nenhuma voz foi escolhida — selecione e salve uma voz para testar o áudio.";
        await log("audio", "skipped", "voice_not_selected", detail);
        steps.push({ step: "audio", state: "skipped", label: "Áudio", detail });
      } else {
        try {
          const audio = await synthesizeSpeech(
            elevenKey,
            voiceConfig.voiceId,
            "Este é um áudio de teste do AceleraFlow. Se você está ouvindo esta mensagem, o envio de áudio está funcionando.",
            { timeoutMs: 25_000, modelId: voiceConfig.modelId ?? undefined },
          );
          // Mesmo caminho do envio real: provedores que buscam a mídia por URL
          // (Evolution Go) recebem link assinado curto do bucket privado.
          const signedUrl = await createTestAudioSignedUrl(admin, tenantId, audio);
          const r = await sendAudioViaProvider({
            providerSlug: slug,
            cred,
            phone: phoneDigits,
            audio,
            ...(signedUrl ? { audioSignedUrl: signedUrl } : {}),
          });
          if (r.ok) {
            await log("audio", "ok", "test_audio_sent", "Áudio aceito pelo provedor.");
            steps.push({ step: "audio", state: "ok", label: "Áudio", detail: "Enviado." });
          } else {
            await log("audio", "failed", "test_audio_failed", r.error);
            steps.push({ step: "audio", state: "failed", label: "Áudio", detail: r.error });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          await log("audio", "failed", "test_audio_failed", msg);
          steps.push({ step: "audio", state: "failed", label: "Áudio", detail: msg });
        }
      }
    }

    const anyFailed = steps.some((s) => s.state === "failed");
    if (!anyFailed) {
      // Passou no teste: limpa a mensagem antiga de falha do canal para a
      // tabela de situação não mostrar erro resolvido junto do selo "Ativa".
      await admin
        .from("channels")
        .update({ status_message: null })
        .eq("id", channelId);
    }
    await recordChannelStatusEvent(admin, {
      tenantId,
      channelId,
      status: ch.status ?? "unknown",
      reasonCode: anyFailed ? "test_messaging_failed" : "test_messaging_ok",
      reasonDetail: steps.map((s) => `${s.label}: ${s.state}`).join(" · "),
      source: "test",
      runId,
    });


    return json(200, {
      ok: !anyFailed,
      run_id: runId,
      steps,
      error: anyFailed ? "O teste falhou em pelo menos um passo. Veja os detalhes abaixo." : undefined,
    });
  }

  if (action === "disconnect") {
    // HIGH (code review): gêmeo exato do bug do `forget` — devolvia ok:true
    // incondicional, então uma falha de escrita deixava a UI dizendo
    // "desconectado" com a integração ainda ativa no banco.
    const { error: tiError } = await admin
      .from("tenant_integrations")
      .update({ status: "disabled", last_error: null })
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    const { error: chError } = await admin
      .from("channels")
      .update({ status: "disconnected", qr_code: null, qr_code_expires_at: null })
      .eq("tenant_id", tenantId)
      .eq("provider_slug", slug);
    if (tiError || chError) {
      await reportError(
        admin,
        tenantId,
        "disconnect.atualizar_status",
        `falha ao desconectar: ${tiError?.message ?? ""} ${chError?.message ?? ""}`.trim(),
        { slug },
      );
      return json(200, {
        ok: false,
        error: "Não conseguimos desconectar a integração agora. Tente de novo em instantes.",
      });
    }
    return json(200, { ok: true });
  }

  if (action === "forget") {
    // CRITICAL (code review): este é o fluxo de LGPD/offboarding — "esquecer
    // credenciais". Devolver ok:true sem checar o DELETE fazia a UI confirmar a
    // remoção enquanto o access_token/api_key do provider continuava no banco,
    // sem log e sem forma de detectar depois. O delete do segredo é o passo que
    // NÃO pode falhar em silêncio: se ele falhar, aborta antes de marcar
    // desconectado (estado "disabled" com segredo vivo seria pior ainda).
    const { error: secretsDelError } = await admin
      .from("integration_secrets")
      .delete()
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    if (secretsDelError) {
      // Prioridade máxima de auditoria: "esquecer credenciais" que falha é evento
      // de LGPD. Sem o registro em system_events não há como provar (nem
      // descobrir) depois que o segredo continuou no banco.
      await reportError(
        admin,
        tenantId,
        "forget.apagar_segredos",
        `falha ao apagar segredos (credenciais PERMANECEM no banco): ${secretsDelError.message}`,
        { slug, lgpd: true },
      );
      return json(200, {
        ok: false,
        error:
          "Não conseguimos remover as credenciais. Elas continuam salvas — tente de novo em instantes.",
      });
    }
    const { error: tiError } = await admin
      .from("tenant_integrations")
      // Offboarding LGPD rotaciona segredo, não só desativa: sem zerar o
      // webhook_token, um reconnect futuro reaproveita o MESMO token (o connect
      // só minta quando não existe), devolvendo poder de injeção inbound a quem
      // tivesse o token antigo.
      .update({
        status: "disabled",
        config: {},
        connected_at: null,
        last_error: null,
        webhook_token: null,
      })
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    const { error: chError } = await admin
      .from("channels")
      .update({
        status: "disconnected",
        config: {},
        webhook_token: null,
        qr_code: null,
        qr_code_expires_at: null,
      })
      .eq("tenant_id", tenantId)
      .eq("provider_slug", slug);
    // Segredo já foi apagado (o que importa para LGPD). Falha em marcar o estado
    // é degradação, não perda de dado — reporta sem fingir sucesso total.
    if (tiError || chError) {
      await reportError(
        admin,
        tenantId,
        "forget.atualizar_status",
        `segredos apagados mas estado inconsistente: ${tiError?.message ?? ""} ${chError?.message ?? ""}`.trim(),
        { slug, lgpd: true },
      );
      return json(200, {
        ok: false,
        error:
          "As credenciais foram removidas, mas não conseguimos atualizar o status da integração. Recarregue a página.",
      });
    }
    return json(200, { ok: true });
  }

  if (action === "test") {
    // Revalida credenciais já persistidas SEM reutilizar segredos vindos do
    // cliente. Isso é o que o botão "Testar conexão" na UI dispara: só o
    // slug atravessa a fronteira. Se a integração nunca foi conectada,
    // devolve um erro amigável em vez de tentar rodar contra vazio.
    // Mesmo root-cause do connect: erro aqui virava `values` vazio, ou seja
    // "Nada configurado ainda" — mandava o admin recadastrar credenciais que
    // estão salvas. Distingue falha de infra de "nunca conectou".
    const { data: existingRows, error: existingRowsError } = await admin
      .from("integration_secrets")
      .select("key, value")
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    if (existingRowsError) {
      await reportError(
        admin,
        tenantId,
        "test.ler_segredos",
        `falha ao ler segredos: ${existingRowsError.message}`,
        { slug },
      );
      return json(200, {
        ok: false,
        error: "Instabilidade ao ler as credenciais salvas. Tente de novo em instantes.",
      });
    }
    const values: Record<string, string> = {};
    for (const row of existingRows ?? []) values[row.key] = row.value as string;
    if (Object.keys(values).length === 0) {
      return json(200, {
        ok: false,
        error: "Nada configurado ainda. Abra o wizard e cole as credenciais primeiro.",
      });
    }
    const result = await runTest(slug, values);
    const now = new Date().toISOString();
    // MEDIUM (code review): sem checar, o botão "Testar conexão" respondia ok
    // enquanto o card seguia mostrando status/last_check_at antigos. Quando o
    // teste em si falhou, o erro de credencial continua sendo a resposta certa
    // (não mascarar); só o caso "testou ok mas o estado não gravou" precisa
    // avisar o admin — mesmo padrão do `forget` acima.
    const { error: testUpdError } = await admin
      .from("tenant_integrations")
      .update({
        status: result.ok ? "active" : "error",
        last_check_at: now,
        last_error: result.ok ? null : (result.error ?? "Falha ao testar."),
      })
      .eq("tenant_id", tenantId)
      .eq("slug", slug);
    if (testUpdError) {
      await reportError(
        admin,
        tenantId,
        "test.atualizar_status",
        `falha ao gravar resultado do teste: ${testUpdError.message}`,
        { slug, test_ok: result.ok },
      );
      if (result.ok) {
        return json(200, {
          ok: false,
          error: "Conexão testada, mas não conseguimos atualizar o status. Recarregue a página.",
        });
      }
    }
    // Teste passou: apaga recado de falha antiga no canal, senão o cartão
    // continua exibindo "erro" ao lado do selo "Ativa" (contradição na tela).
    if (result.ok) {
      await admin
        .from("channels")
        .update({ status_message: null })
        .eq("tenant_id", tenantId)
        .eq("provider_slug", slug);
    }
    return json(200, result);

  }

  // ---- Listar vozes da ElevenLabs ----------------------------------------
  // A chave fica no servidor: o frontend só recebe id/nome/gênero/prévia.
  if (action === "list_voices") {
    if (slug !== "elevenlabs") {
      return json(200, { ok: false, error: "Listagem de vozes só existe para a ElevenLabs." });
    }
    let apiKey = "";
    try {
      apiKey = (await loadProviderSecrets(admin, tenantId, "elevenlabs")).api_key ?? "";
    } catch (e) {
      await reportError(
        admin,
        tenantId,
        "list_voices.ler_segredos",
        `falha ao ler credenciais: ${e instanceof Error ? e.message : String(e)}`,
        { slug },
      );
      return json(200, {
        ok: false,
        error: "Instabilidade ao ler as credenciais salvas. Tente de novo em instantes.",
      });
    }
    const result = await fetchElevenLabsVoices(apiKey);
    return json(200, result);
  }

  return json(400, { error: "Ação inválida." });
});

/**
 * Sobe o áudio do teste manual no bucket privado `ai-audio` e devolve link
 * assinado curto (10 min). Nunca lança: sem link, o adaptador envia o áudio
 * embutido em base64.
 */
async function createTestAudioSignedUrl(
  admin: SupabaseClient,
  tenantId: string,
  audio: { bytes: ArrayBuffer; mime: string },
): Promise<string | null> {
  const path = `${tenantId}/diagnostico/${crypto.randomUUID()}.mp3`;
  try {
    const { error: upErr } = await admin.storage
      .from("ai-audio")
      .upload(path, new Uint8Array(audio.bytes), { contentType: audio.mime, upsert: true });
    if (upErr) {
      console.error("[integration-connect] falha ao armazenar áudio de teste:", upErr.message);
      return null;
    }
    const { data, error } = await admin.storage.from("ai-audio").createSignedUrl(path, 600);
    if (error) {
      console.error("[integration-connect] falha ao assinar áudio de teste:", error.message);
      return null;
    }
    return data?.signedUrl ?? null;
  } catch (err) {
    console.error(
      "[integration-connect] erro inesperado ao preparar áudio de teste:",
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

