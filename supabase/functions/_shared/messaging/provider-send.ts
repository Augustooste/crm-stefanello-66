// provider-send.ts — despacho de mensagem por provider (Z-API, Twilio, Meta
// Cloud API, Resend), extraído de messaging-send/index.ts (Fase 4) para ser
// reaproveitado pelos workers de nurture/broadcast, que rodam sem sessão de
// usuário autenticado (service_role, via cron) e por isso não podem chamar a
// edge function messaging-send (que exige Authorization de usuário).
//
// Extração pura: nenhuma função aqui mudou de comportamento em relação ao
// que já existia em messaging-send/index.ts — mesmas URLs, headers, parsing
// de resposta e mensagens de erro em PT-BR. A única diferença estrutural é
// que a validação de telefone/e-mail ausente, que antes lançava uma
// exceção-sentinela (`__NO_PHONE__`/`__NO_EMAIL__`) capturada pelo try/catch
// de index.ts, agora retorna diretamente um SendResult com `ok: false` — o
// texto de erro e o efeito observável (messages.status='failed' com o mesmo
// send_error, resposta HTTP 200 {ok:false,error:...}) são idênticos, só o
// mecanismo interno (return em vez de throw+catch) muda, porque este módulo
// não deve depender de um try/catch externo específico do handler HTTP.
//
// Duplicação deliberada com supabase/functions/ai-respond/send-adapters.ts
// (mesma decisão documentada no header daquele arquivo): aquele módulo é
// especificamente para o auto-envio da IA e mantém sua própria cópia; este
// aqui é a cópia canônica para envio manual (messaging-send) + workers
// automáticos novos. Unificar os dois exigiria tocar ai-respond, fora do
// escopo desta fase.
import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { sendEvolutionAudio, sendEvolutionMessage } from "./evolution-client.ts";
import { sendZappazText } from "./zappaz-client.ts";
import { manyChatSurfaceForSlug, sendManyChatText } from "./manychat-client.ts";
import { createEvolutionAdapter, createMetaCloudAdapter } from "./channel-adapter.ts";
import { createMultichannelAdapter } from "./multichannel-adapters.ts";
import { redactSecrets } from "../redact-secrets.ts";
import { AI_MEDIA_SEND_TIMEOUT_MS } from "../ai/execution-budget.ts";

// `retryable`: o provedor recusou SEM enviar e pediu para esperar (limite de
// taxa). Só nesse caso é seguro reenfileirar; timeout NÃO entra (a mensagem
// pode ter saído e reenviar arrisca duplicar).
export type SendResult =
  | { ok: true; external_id: string | null }
  | { ok: false; error: string; retryable?: boolean };

export async function loadProviderSecrets(
  admin: SupabaseClient,
  tenantId: string,
  slug: string,
): Promise<Record<string, string>> {
  const { data, error } = await admin
    .from("integration_secrets")
    .select("key, value")
    .eq("tenant_id", tenantId)
    .eq("slug", slug);
  if (error) {
    throw new Error(
      `Falha ao carregar credenciais de ${slug} para o tenant ${tenantId}: ${error.message}`,
    );
  }
  const cred: Record<string, string> = {};
  for (const r of data ?? []) cred[r.key as string] = r.value as string;
  return cred;
}

function friendlyHttp(provider: string, status: number, body: string): string {
  if (status === 401 || status === 403) {
    if (provider === "zapi")
      return "Credenciais da Z-API não estão mais válidas. Reconecte a integração.";
    if (provider === "twilio")
      return "Credenciais da Twilio não estão mais válidas. Reconecte a integração.";
    if (provider === "resend")
      return "Chave do Resend não está mais válida. Reconecte a integração.";
    if (provider === "meta-cloud")
      return "Access Token da Meta não está mais válido. Reconecte a integração.";
    if (provider === "zappaz")
      return "Credenciais da Zappaz não estão mais válidas. Reconecte a integração.";
  }
  if (status >= 500) return "O provedor está indisponível no momento. Tente de novo em instantes.";
  if (status === 429) return "O provedor pediu para aguardar um pouco antes de enviar de novo.";
  // 400/422 é recusa PERMANENTE do provider (número inexistente no WhatsApp,
  // template não aprovado, janela de 24h expirada, e-mail em suppression
  // list). Dizer "tente novamente" faz o operador retentar para sempre algo
  // que nunca vai passar — o motivo exato sai no console.error de
  // providerHttpError, o texto aqui é o que o operador vê (H12).
  if (status === 400 || status === 422) {
    return "O provedor recusou a mensagem (cadastro do contato, template não aprovado ou janela de 24h expirada). Corrija o cadastro antes de reenviar.";
  }
  // Status desconhecido, fora dos casos já mapeados acima: status e corpo
  // (redigido, truncado) vão para a mensagem devolvida ao caller — sem isso,
  // qualquer 4xx/5xx não mapeado virava a mesma frase genérica e ficava
  // indiagnosticável depois do fato (docs/PLANO-OBSERVABILIDADE-2026-08-04.md).
  const detail = redactSecrets(body).slice(0, 300);
  return `Não foi possível enviar a mensagem — o provedor respondeu HTTP ${status}.${
    detail ? ` Detalhe: ${detail}` : ""
  }`;
}

// O corpo do erro do provider é a ÚNICA pista do motivo real da recusa e era
// descartado nos 4 senders (H12) — nem log, nem send_error. Lê, redige
// segredos (a resposta pode ecoar o token enviado) e loga; o retorno segue o
// mesmo contrato de antes, a mensagem amigável por status. Mesmo formato do
// tratamento que evolution-client.ts já faz no ramo !r.ok.
async function providerHttpError(provider: string, r: Response): Promise<SendResult> {
  const body = await r.text().catch(() => "");
  console.error(
    `[provider-send] ${provider} recusou o envio (HTTP ${r.status})`,
    redactSecrets(body).slice(0, 500),
  );
  const metaCode = provider === "meta-cloud" ? metaErrorCode(body) : null;
  const metaMessage = metaCode === null ? null : (META_ERROR_MESSAGES[metaCode] ?? null);
  const retryable = r.status === 429 || metaCode === META_RATE_LIMIT_CODE;
  return {
    ok: false,
    error: metaMessage ?? friendlyHttp(provider, r.status, body),
    ...(retryable ? { retryable } : {}),
  };
}

// Códigos da Graph API com causa acionável (docs "Códigos de erro do WhatsApp",
// conferidos em 25/09/2026). Os demais caem no texto genérico por status HTTP.
const META_ERROR_MESSAGES: Record<number, string> = {
  131047:
    "A Meta recusou: passaram mais de 24h desde a última mensagem do contato. Use um modelo aprovado.",
  132000:
    "A Meta recusou: o número de variáveis enviado não bate com o modelo aprovado. Confira a lista de variáveis.",
  132001:
    "A Meta recusou: o modelo não existe nesse idioma ou ainda não foi aprovado. Confira nome e idioma.",
  131050: "O contato parou de receber mensagens de marketing desta empresa no WhatsApp.",
  130429: "A Meta limitou a taxa de envio. A mensagem será tentada de novo mais tarde.",
  190: "Access Token da Meta não está mais válido. Reconecte a integração.",
};

const META_RATE_LIMIT_CODE = 130429;

function metaErrorCode(body: string): number | null {
  try {
    const code = (JSON.parse(body) as { error?: { code?: unknown } }).error?.code;
    return typeof code === "number" ? code : null;
  } catch {
    return null;
  }
}

export const NETWORK_MSG =
  "Não conseguimos falar com o provedor agora — tente novamente em instantes.";

/**
 * Teto de tempo por chamada de provider. Nenhum fetch deste arquivo tinha um --
 * um provider que aceita a conexão e simplesmente não responde segurava o
 * isolate até o wall-clock da plataforma matá-lo.
 *
 * Não é só lentidão: o envio da resposta da IA acontece DENTRO do lock de
 * conversa do ai-respond (finalizeAiReply roda antes do releaseLock), cujo TTL
 * é de 90s, e o claim em ai_processing_log não tem TTL nem delete. Isolate
 * morto = mensagem daquele lead sem resposta para sempre.
 *
 * O contrato público de sendViaProvider já documenta que "falha de rede real
 * (fetch rejeitando) propaga como exceção" -- timeout entra exatamente nessa
 * categoria e todos os callers já tratam esse caso (messaging-send faz retry
 * com backoff, send-dispatch grava send_error).
 *
 * Valores alinhados ao único precedente do repo, evolution-client.ts (15s/20s).
 */
const SEND_TIMEOUT_MS = 15_000;
/**
 * Envio de mídia sobe o ARQUIVO INTEIRO no corpo do POST (base64 na Z-API e na
 * Zappaz, multipart na Meta) -- até MAX_AUDIO_SEND_BYTES. Numa conexão ruim
 * isso não cabe no mesmo teto de um POST de texto de 2 KB. O teto participa do
 * orçamento compartilhado do turno e precisa caber no idle timeout do runtime.
 */

async function sendZapi(
  cred: Record<string, string>,
  phoneDigits: string,
  content: string,
): Promise<SendResult> {
  const { instance_id, instance_token, client_token } = cred;
  if (!instance_id || !instance_token || !client_token) {
    return { ok: false, error: "Integração Z-API não configurada." };
  }
  const url = `https://api.z-api.io/instances/${instance_id}/token/${instance_token}/send-text`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": client_token },
    body: JSON.stringify({ phone: phoneDigits, message: content }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!r.ok) return await providerHttpError("zapi", r);
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const externalId =
    (data.messageId as string | undefined) ??
    (data.zaapId as string | undefined) ??
    (data.id as string | undefined) ??
    null;
  return { ok: true, external_id: externalId };
}

async function sendTwilio(
  cred: Record<string, string>,
  phoneE164: string,
  content: string,
): Promise<SendResult> {
  const { account_sid, auth_token, whatsapp_number } = cred;
  if (!account_sid || !auth_token || !whatsapp_number) {
    return { ok: false, error: "Integração Twilio não configurada." };
  }
  const fromDigits = String(whatsapp_number).replace(/\D/g, "");
  const toDigits = String(phoneE164).replace(/\D/g, "");
  if (!fromDigits || !toDigits) return { ok: false, error: "Número do contato inválido." };
  const url = `https://api.twilio.com/2010-04-01/Accounts/${account_sid}/Messages.json`;
  const form = new URLSearchParams({
    From: `whatsapp:+${fromDigits}`,
    To: `whatsapp:+${toDigits}`,
    Body: content,
  });
  const auth = btoa(`${account_sid}:${auth_token}`);
  const r = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: form.toString(),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!r.ok) return await providerHttpError("twilio", r);
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const sid = (data.sid as string | undefined) ?? null;
  return { ok: true, external_id: sid };
}

async function sendMetaCloud(
  cred: Record<string, string>,
  phoneE164: string,
  content: string,
): Promise<SendResult> {
  const { access_token, phone_number_id } = cred;
  if (!access_token || !phone_number_id) {
    return { ok: false, error: "Integração WhatsApp Oficial (Meta) não configurada." };
  }
  const toDigits = String(phoneE164).replace(/\D/g, "");
  if (!toDigits) return { ok: false, error: "Número do contato inválido." };
  const id = encodeURIComponent(String(phone_number_id).replace(/\D/g, ""));
  const r = await fetch(`https://graph.facebook.com/v23.0/${id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      to: toDigits,
      type: "text",
      text: { body: content },
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!r.ok) return await providerHttpError("meta-cloud", r);
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const externalId = (data.messages as Array<{ id?: string }> | undefined)?.[0]?.id ?? null;
  return { ok: true, external_id: externalId };
}

/**
 * Corpo do `POST /{phone_number_id}/messages` para um modelo aprovado. Contrato
 * conferido na doc oficial em 25/09/2026 (Template fundamentals > Parameter
 * formats): `template.name`, `template.language.code` e, quando o modelo tem
 * variáveis, `components: [{type: "body", parameters: [{type: "text", text}]}]`
 * na ORDEM de {{1}}..{{n}} (formato posicional, o padrão da Meta). Função pura,
 * exportada para teste.
 */
export function buildMetaTemplatePayload(
  toDigits: string,
  message: ProviderTemplateMessage,
): Record<string, unknown> {
  const template: Record<string, unknown> = {
    name: message.name,
    language: { code: message.languageCode },
  };
  if (message.bodyParameters.length > 0) {
    template.components = [
      {
        type: "body",
        parameters: message.bodyParameters.map((text) => ({ type: "text", text })),
      },
    ];
  }
  return { messaging_product: "whatsapp", to: toDigits, type: "template", template };
}

/**
 * Modelo aprovado pela Meta (`type: "template"`) -- único tipo de mensagem que a
 * Meta entrega fora da janela de atendimento de 24h.
 */
async function sendMetaCloudTemplate(
  cred: Record<string, string>,
  phoneE164: string,
  message: ProviderTemplateMessage,
): Promise<SendResult> {
  const { access_token, phone_number_id } = cred;
  if (!access_token || !phone_number_id) {
    return { ok: false, error: "Integração WhatsApp Oficial (Meta) não configurada." };
  }
  const toDigits = String(phoneE164).replace(/\D/g, "");
  if (!toDigits) return { ok: false, error: "Número do contato inválido." };
  const id = encodeURIComponent(String(phone_number_id).replace(/\D/g, ""));
  const r = await fetch(`https://graph.facebook.com/v23.0/${id}/messages`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(buildMetaTemplatePayload(toDigits, message)),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!r.ok) return await providerHttpError("meta-cloud", r);
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const externalId = (data.messages as Array<{ id?: string }> | undefined)?.[0]?.id ?? null;
  return { ok: true, external_id: externalId };
}

async function sendResend(
  cred: Record<string, string>,
  toEmail: string,
  content: string,
  subject: string,
): Promise<SendResult> {
  const { api_key, from_domain } = cred;
  if (!api_key || !from_domain) return { ok: false, error: "Integração Resend não configurada." };
  const from =
    cred.from_email && cred.from_email.includes("@") ? cred.from_email : `contato@${from_domain}`;
  const r = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${api_key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from,
      to: [toEmail],
      subject: subject || "Nova mensagem",
      text: content,
    }),
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!r.ok) return await providerHttpError("resend", r);
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const id = (data.id as string | undefined) ?? null;
  return { ok: true, external_id: id };
}

export type ProviderSlug =
  | "zapi" | "twilio" | "meta-cloud" | "resend" | "evolution" | "zappaz"
  | "telegram" | "discord" | "sms" | "email" | "push"
  | "simulator"
  | "manychat-whatsapp" | "manychat-instagram" | "manychat-messenger";

// Canônico -- extraído de nurture-runner/weekly-digest-generator/
// template-schedule-runner, que tinham 3 cópias (2 idênticas por array +
// 1 por switch equivalente) desta mesma checagem de allowlist (Fase 4,
// review). `channels.provider_slug`/`tenant_integrations.slug` são `text`
// sem CHECK no banco -- todo caller que lê provider de uma tabela precisa
// desta validação em runtime antes de estreitar pro union fechado abaixo.
export const SUPPORTED_PROVIDER_SLUGS: readonly ProviderSlug[] = [
  "zapi",
  "twilio",
  "meta-cloud",
  "resend",
  "evolution",
  "zappaz",
  "telegram",
  "discord",
  "sms",
  "email",
  "push",
  "manychat-whatsapp",
  "manychat-instagram",
  "manychat-messenger",
  "simulator",
];

export function isSupportedProviderSlug(slug: string): slug is ProviderSlug {
  return (SUPPORTED_PROVIDER_SLUGS as readonly string[]).includes(slug);
}

/** Texto livre. Nos canais oficiais só chega dentro da janela de atendimento. */
export interface FreeformMessage {
  kind: "freeform";
  text: string;
}

/**
 * Modelo aprovado no provedor. Hoje só a Meta Cloud (PROVIDER_TEMPLATE_PROVIDERS).
 * `bodyParameters` segue a ordem de {{1}}..{{n}} do modelo cadastrado na Meta.
 */
export interface ProviderTemplateMessage {
  kind: "provider_template";
  name: string;
  languageCode: string;
  bodyParameters: string[];
}

export type OutboundMessage = FreeformMessage | ProviderTemplateMessage;

/** Canais que sabem enviar modelo aprovado. Os demais recusam explicitamente. */
export const PROVIDER_TEMPLATE_PROVIDERS: readonly ProviderSlug[] = ["meta-cloud"];

export function providerSupportsTemplates(slug: string): boolean {
  return (PROVIDER_TEMPLATE_PROVIDERS as readonly string[]).includes(slug);
}

export interface SendViaProviderParams {
  admin: SupabaseClient;
  providerSlug: ProviderSlug;
  cred: Record<string, string>;
  phone?: string;
  email?: string;
  content: string;
  subject?: string;
  destination?: string;
}

/**
 * Dispatcher único de envio externo: decide qual adaptador chamar
 * (zapi/twilio/meta-cloud/resend/evolution) a partir de `providerSlug` e
 * valida o dado de contato mínimo (telefone/e-mail) por canal, igual ao
 * if/else que antes vivia dentro do Deno.serve de messaging-send/index.ts.
 *
 * `admin` está no params por contrato com os callers futuros (workers de
 * nurture/broadcast), mas não é usado por este dispatcher — nenhum dos
 * adaptadores toca banco, só HTTP externo.
 *
 * Nunca lança: telefone/e-mail ausente e falha do provider viram
 * `{ok: false, error}`; só uma falha de rede real (fetch rejeitando) ainda
 * propaga como exceção, igual ao comportamento original de
 * sendZapi/sendTwilio/sendMetaCloud/sendResend.
 */
export async function sendViaProvider(params: SendViaProviderParams): Promise<SendResult> {
  const { providerSlug, cred, phone, email, content, subject, destination } = params;

  switch (providerSlug) {
    case "simulator":
      // Recibo local: a persistência no inbox é do caller, nunca de um provedor.
      return { ok: true, external_id: `simulator:${crypto.randomUUID()}` };
    case "zapi": {
      const phoneDigits = String(phone ?? "").replace(/\D/g, "");
      if (!phoneDigits) return { ok: false, error: "Contato sem telefone cadastrado." };
      return await sendZapi(cred, phoneDigits, content);
    }
    case "twilio": {
      const phoneRaw = String(phone ?? "");
      if (!phoneRaw) return { ok: false, error: "Contato sem telefone cadastrado." };
      return await sendTwilio(cred, phoneRaw, content);
    }
    case "meta-cloud": {
      const phoneRaw = String(phone ?? "");
      if (!phoneRaw) return { ok: false, error: "Contato sem telefone cadastrado." };
      const adapter = createMetaCloudAdapter((destination, text) =>
        sendMetaCloud(cred, destination, text),
      );
      return await adapter.send({ destination: phoneRaw, content });
    }
    case "resend": {
      const emailTrimmed = String(email ?? "").trim();
      if (!emailTrimmed) return { ok: false, error: "Contato sem e-mail cadastrado." };
      return await sendResend(cred, emailTrimmed, content, subject ?? "");
    }
    case "evolution": {
      const phoneRaw = String(phone ?? "");
      if (!phoneRaw) return { ok: false, error: "Contato sem telefone cadastrado." };
      const { api_url, instance_name, api_key, instance_token } = cred;
      const adapter = createEvolutionAdapter((destination, text) =>
        sendEvolutionMessage(
          {
            api_url: api_url ?? "",
            instance_name: instance_name ?? "",
            api_key: api_key ?? "",
            instance_token,
          },
          destination,
          text,
        ),
      );
      return await adapter.send({ destination: phoneRaw, content });
    }
    case "zappaz": {
      const phoneDigits = String(phone ?? "").replace(/\D/g, "");
      if (!phoneDigits) return { ok: false, error: "Contato sem telefone cadastrado." };
      return await sendZappazText(
        { api_key: cred.api_key ?? "", session_id: cred.session_id ?? "" },
        phoneDigits,
        content,
      );
    }
    case "telegram":
    case "discord":
    case "sms":
    case "email":
    case "push": {
      const resolvedDestination = destination || (providerSlug === "email" ? email : phone) || "";
      return await createMultichannelAdapter(providerSlug, cred).send({
        destination: resolvedDestination,
        content,
      });
    }
    case "manychat-whatsapp":
    case "manychat-instagram":
    case "manychat-messenger":
      // Destino é o subscriber_id (resolveProviderDestination). Nunca o
      // telefone: no ManyChat o telefone não endereça ninguém.
      return await sendManyChatText({
        apiKey: cred.api_key ?? "",
        subscriberId: String(destination ?? "").trim(),
        surface: manyChatSurfaceForSlug(providerSlug),
        text: content,
      });
    default:
      // providerSlug é um union fechado, mas callers como os workers de
      // nurture/broadcast lêem provider_slug do banco (string não validada
      // em compile-time) — guard em runtime evita cair silenciosamente no
      // branch resend para um provider desconhecido.
      return { ok: false, error: "Provedor de envio não suportado." };
  }
}

export interface SendMessageViaProviderParams extends Omit<SendViaProviderParams, "content"> {
  message: OutboundMessage;
}

/**
 * Envio tipado: texto livre segue pelo mesmo dispatcher de sempre
 * (sendViaProvider); modelo aprovado só existe na Meta Cloud e, em qualquer
 * outro canal, volta erro controlado -- nunca vira texto livre disfarçado.
 */
export async function sendMessageViaProvider(
  params: SendMessageViaProviderParams,
): Promise<SendResult> {
  const { message, ...rest } = params;
  if (message.kind === "freeform") {
    return await sendViaProvider({ ...rest, content: message.text });
  }
  if (!providerSupportsTemplates(rest.providerSlug)) {
    return {
      ok: false,
      error: `O canal ${rest.providerSlug} não envia modelo aprovado pelo provedor. Use o WhatsApp oficial (Meta).`,
    };
  }
  const phoneRaw = String(rest.phone ?? "");
  if (!phoneRaw) return { ok: false, error: "Contato sem telefone cadastrado." };
  return await sendMetaCloudTemplate(rest.cred, phoneRaw, message);
}

// -------------------- Envio de ÁUDIO (TTS) --------------------
// Contratos conferidos na doc oficial de cada provider em 2026-07-27, não de
// memória. Os três aceitam os BYTES direto — nenhum exige hospedar o arquivo
// antes —, por isso não há bucket nem URL pública no caminho. O que muda entre
// eles é o embrulho, e tratar os três igual quebra dois:
//
//   zapi       data URI COM prefixo  "data:audio/mpeg;base64,...."
//   zappaz     base64 CRU, sem prefixo
//   meta-cloud NEM base64: upload multipart -> media id -> envia por id
//
// Canal fora desta lista devolve erro explícito. Não existe fallback silencioso
// para texto aqui: quem decide o que fazer com a recusa é o caller.

/** Teto da Meta (16 MB); aplicado aos três para não depender do limite alheio. */
const MAX_AUDIO_SEND_BYTES = 16 * 1024 * 1024;

/**
 * btoa em blocos: `String.fromCharCode(...bytes)` com spread estoura o stack
 * em áudios de poucos segundos (limite de argumentos, não de memória).
 */
function toBase64(bytes: ArrayBuffer): string {
  const view = new Uint8Array(bytes);
  const CHUNK = 0x8000;
  let binary = "";
  for (let i = 0; i < view.length; i += CHUNK) {
    binary += String.fromCharCode(...view.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

export interface OutboundAudio {
  bytes: ArrayBuffer;
  /** MIME real dos bytes. Meta rejeita (131053) se não bater com o conteúdo. */
  mime: string;
}

async function sendZapiAudio(
  cred: Record<string, string>,
  phoneDigits: string,
  audio: OutboundAudio,
): Promise<SendResult> {
  const { instance_id, instance_token, client_token } = cred;
  if (!instance_id || !instance_token || !client_token) {
    return { ok: false, error: "Integração Z-API não configurada." };
  }
  const url = `https://api.z-api.io/instances/${instance_id}/token/${instance_token}/send-audio`;
  const r = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Client-Token": client_token },
    body: JSON.stringify({
      phone: phoneDigits,
      // Prefixo obrigatório: o único exemplo de base64 publicado usa data URI.
      // Base64 cru não é documentado.
      audio: `data:${audio.mime};base64,${toBase64(audio.bytes)}`,
      // Defaults não documentados — mandados explícitos de propósito.
      // waveform=true é o que renderiza como nota de voz em vez de anexo.
      viewOnce: false,
      waveform: true,
      // `async` deliberadamente OMITIDO: com async:true a doc não define o
      // corpo da resposta, e o external_id abaixo deixaria de ser confiável.
    }),
    signal: AbortSignal.timeout(AI_MEDIA_SEND_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { ok: false, error: friendlyHttp("zapi", r.status, body) };
  }
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  // Mesmo shape do send-text.
  const externalId =
    (data.messageId as string | undefined) ??
    (data.zaapId as string | undefined) ??
    (data.id as string | undefined) ??
    null;
  return { ok: true, external_id: externalId };
}

async function sendZappazAudio(
  cred: Record<string, string>,
  phoneDigits: string,
  audio: OutboundAudio,
): Promise<SendResult> {
  const { api_key, session_id } = cred;
  if (!api_key || !session_id) {
    return { ok: false, error: "Integração Zappaz não configurada." };
  }
  const r = await fetch(
    `https://api.zappaz.io/api/v1/session/${encodeURIComponent(session_id)}/message/audio`,
    {
      method: "POST",
      // Authorization cru, sem "Bearer" — o securityScheme é apiKey/header.
      headers: { Authorization: api_key, "Content-Type": "application/json" },
      body: JSON.stringify({
        number: phoneDigits,
        // SEM o prefixo `data:` — ao contrário da Z-API.
        source: toBase64(audio.bytes),
      }),
      signal: AbortSignal.timeout(AI_MEDIA_SEND_TIMEOUT_MS),
    },
  );
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { ok: false, error: friendlyHttp("zappaz", r.status, body) };
  }
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const externalId =
    (data.id as string | undefined) ?? (data.messageId as string | undefined) ?? null;
  return { ok: true, external_id: externalId };
}

async function sendMetaCloudAudio(
  cred: Record<string, string>,
  phoneE164: string,
  audio: OutboundAudio,
): Promise<SendResult> {
  const { access_token, phone_number_id } = cred;
  if (!access_token || !phone_number_id) {
    return { ok: false, error: "Integração WhatsApp Oficial (Meta) não configurada." };
  }
  const toDigits = String(phoneE164).replace(/\D/g, "");
  if (!toDigits) return { ok: false, error: "Número do contato inválido." };
  const id = encodeURIComponent(String(phone_number_id).replace(/\D/g, ""));

  // Passo 1 — upload. Meta NÃO aceita base64: ou multipart, ou link público.
  const form = new FormData();
  form.append("messaging_product", "whatsapp");
  form.append("type", audio.mime);
  form.append("file", new Blob([audio.bytes], { type: audio.mime }), "audio.mp3");
  // Content-Type NÃO é setado à mão: o boundary do multipart é gerado pelo
  // FormData e setar o header manualmente quebra o parse do lado da Meta.
  const up = await fetch(`https://graph.facebook.com/v23.0/${id}/media`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}` },
    body: form,
    signal: AbortSignal.timeout(AI_MEDIA_SEND_TIMEOUT_MS),
  });
  if (!up.ok) {
    const body = await up.text().catch(() => "");
    return { ok: false, error: friendlyHttp("meta-cloud", up.status, body) };
  }
  const upData = await up.json().catch(() => ({}) as Record<string, unknown>);
  const mediaId = upData.id as string | undefined;
  if (!mediaId) return { ok: false, error: "Meta não devolveu o id da mídia enviada." };

  // Passo 2 — envio por media id.
  const r = await fetch(`https://graph.facebook.com/v23.0/${id}/messages`, {
    method: "POST",
    headers: { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: toDigits,
      type: "audio",
      audio: { id: mediaId },
    }),
    // Passo 2 não carrega o arquivo, só o media id — teto de POST de texto.
    signal: AbortSignal.timeout(SEND_TIMEOUT_MS),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => "");
    return { ok: false, error: friendlyHttp("meta-cloud", r.status, body) };
  }
  const data = await r.json().catch(() => ({}) as Record<string, unknown>);
  const externalId = (data.messages as Array<{ id?: string }> | undefined)?.[0]?.id ?? null;
  return { ok: true, external_id: externalId };
}

/** Canais com envio de áudio implementado. Os demais recusam explicitamente. */
export const AUDIO_CAPABLE_PROVIDERS: readonly ProviderSlug[] = [
  "zapi",
  "zappaz",
  "meta-cloud",
  "evolution",
  "simulator",
];

export function providerSupportsAudio(slug: string): boolean {
  return (AUDIO_CAPABLE_PROVIDERS as readonly string[]).includes(slug);
}

export interface SendAudioViaProviderParams {
  providerSlug: string;
  cred: Record<string, string>;
  phone: unknown;
  audio: OutboundAudio;
  /**
   * Link assinado e de vida curta do objeto no bucket `ai-audio`. Só o
   * Evolution Go usa (o servidor busca o arquivo pelo endereço); os demais
   * adaptadores mandam os bytes.
   */
  audioSignedUrl?: string;
}


/**
 * Irmão de sendViaProvider para áudio. Mesmo contrato: nunca lança por erro do
 * provider — devolve `{ok: false, error}`.
 *
 * Canal sem suporte devolve erro nomeando o canal, em vez de cair calado em
 * texto: quem pediu áudio precisa saber que não houve áudio.
 */
export async function sendAudioViaProvider(
  params: SendAudioViaProviderParams,
): Promise<SendResult> {
  const { providerSlug, cred, phone, audio, audioSignedUrl } = params;

  if (!providerSupportsAudio(providerSlug)) {
    return { ok: false, error: `O canal ${providerSlug || "(desconhecido)"} não envia áudio.` };
  }
  if (audio.bytes.byteLength === 0) return { ok: false, error: "Áudio vazio." };
  if (audio.bytes.byteLength > MAX_AUDIO_SEND_BYTES) {
    return { ok: false, error: `Áudio acima do limite de 16 MB (${audio.bytes.byteLength} bytes).` };
  }
  if (providerSlug === "simulator") {
    return { ok: true, external_id: `simulator:${crypto.randomUUID()}` };
  }

  const phoneDigits = String(phone ?? "").replace(/\D/g, "");
  if (!phoneDigits) return { ok: false, error: "Contato sem telefone cadastrado." };

  switch (providerSlug) {
    case "zapi":
      return await sendZapiAudio(cred, phoneDigits, audio);
    case "zappaz":
      return await sendZappazAudio(cred, phoneDigits, audio);
    case "meta-cloud":
      return await sendMetaCloudAudio(cred, String(phone ?? ""), audio);
    case "evolution":
      return await sendEvolutionAudio(
        {
          api_url: cred.api_url ?? "",
          instance_name: cred.instance_name ?? "",
          api_key: cred.api_key ?? "",
          ...(cred.instance_token ? { instance_token: cred.instance_token } : {}),
        },
        phoneDigits,
        { bytes: audio.bytes, mime: audio.mime, ...(audioSignedUrl ? { signedUrl: audioSignedUrl } : {}) },
      );
    default:
      return { ok: false, error: `O canal ${providerSlug} não envia áudio.` };
  }
}

