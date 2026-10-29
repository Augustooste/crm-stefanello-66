// Inbound provider webhooks (WhatsApp via Z-API, WhatsApp via Twilio, email via Resend).
// URL: /functions/v1/messaging-webhook/<slug>?token=<webhook_token>
// Fail-closed on missing/invalid token. Never 500 to the provider — log and 200,
// otherwise providers retry and duplicate.
import { createClient, SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
import { normalizeMessagingText } from "../_shared/text-normalize.ts";
import { isPhoneSuppressed, normalizePhone } from "../_shared/messaging/conversation.ts";
import type { EvolutionInboundPayload } from "../_shared/messaging/evolution-client.ts";
import {
  type CanonicalInboundMessage,
  describeEvolutionMessageShape,
  normalizeDeliveryReceipt,
  normalizeEvolutionInbound,
  normalizeMetaCloudInbound,
} from "../_shared/messaging/normalizers.ts";
import { createMultichannelAdapter } from "../_shared/messaging/multichannel-adapters.ts";
import { isManyChatSlug } from "../_shared/messaging/manychat-client.ts";
import {
  MANYCHAT_MAX_BODY_BYTES,
  normalizeManyChatInbound,
} from "../_shared/messaging/manychat-inbound.ts";
import {
  isEncryptedWhatsAppUrl,
  rehostEncryptedWhatsAppAudio,
  storeInboundAudioBase64,
} from "../_shared/messaging/whatsapp-media.ts";

import { timingSafeEqualStrings } from "../_shared/timing-safe-equal.ts";
import { captureEdgeError } from "../_shared/telemetry.ts";
import { recordChannelStatusEvent } from "../_shared/messaging/channel-status.ts";
import {
  type InboundMessage,
  cancelNurtureOnReply,
  persistInbound,
  enqueueAIResponseJob,
  isDurableAIQueueEnabled,
  triggerAiRespond,
  runInBackground,
} from "../_shared/messaging/inbound.ts";

// Janela de tolerância para replay do webhook Svix (recomendação oficial do
// Svix: 5 min de skew de relógio entre remetente e receptor).
const SVIX_TIMESTAMP_TOLERANCE_SEC = 5 * 60;

// Teto de falhas consecutivas por canal antes de parar de pedir reentrega ao
// provider. Abaixo do teto, respondemos 503 para o provider reentregar (a
// idempotência do claim impede duplicata); acima, voltamos a 200 e marcamos o
// canal como 'broken' — porque Meta/Evolution DESABILITAM a assinatura do
// webhook após uma sequência de erros, o que derrubaria o canal inteiro.
const MAX_CONSECUTIVE_WEBHOOK_FAILURES = 5;

// Chaves cujo valor NUNCA pode ir para telemetria. `instanceToken` é o caso real:
// a Evolution manda o 2º fator no CORPO (os outros providers usam header), e
// `system_events` é legível por admin do tenant — o segredo sairia de
// "só service_role" (integration_secrets) para "admin lê via diagnóstico".
// Blocklist por CHAVE do JSON parseado: os regex de _shared/redact-secrets.ts não
// casam `"instanceToken":"x"` (há aspas entre a chave e os dois-pontos).
const TELEMETRY_REDACT_KEYS = new Set([
  // `mediakey` é chave de decifragem da mídia do lead: entra pelo webhook e não
  // pode sair em telemetria de erro, que admin do tenant lê.
  "mediakey",
  "media_key",
  // Áudio embutido do Evolution Go: não é segredo, mas são megabytes de base64
  // que jamais devem inchar a telemetria.
  "base64",

  "instancetoken",
  "apikey",
  "api_key",
  "token",
  "secret",
  "authorization",
  "client-token",
  "client_token",
  "password",
  // Segundo fator do External Request do ManyChat.
  "webhook_secret",
  "x-webhook-secret",
]);

/**
 * Corpo do webhook seguro para telemetria: redige chaves sensíveis em qualquer
 * profundidade e trunca. Corpo não-JSON não é persistido (pode ser form-urlencoded
 * do Twilio com assinatura, ou binário) — só o tamanho.
 */
// ManyChat: o corpo é montado pelo operador e carrega conversa e nome do lead.
// Telemetria de erro fica só com a estrutura (LGPD); o evento reservado em
// messaging_webhook_events já guarda o necessário para reprocessar.
// Só para ManyChat: `phone` é a chave de recuperação do corpo da Z-API e não
// pode sumir da telemetria dos outros providers.
const MANYCHAT_TELEMETRY_REDACT_KEYS = new Set([
  "phone",
  "whatsapp_phone",
  "email",
  "custom_fields",
  "profile_pic",
  "live_chat_url",
  "text",
  "last_input_text",
  "first_name",
  "last_name",
  "full_name",
  "name",
]);

function safeBodyForTelemetry(raw: string, extraKeys?: Set<string>): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { non_json: true, length: raw.length };
  }
  const redact = (v: unknown, depth: number): unknown => {
    if (depth > 6) return "[deep]";
    if (Array.isArray(v)) return v.slice(0, 20).map((x) => redact(x, depth + 1));
    if (v && typeof v === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
        const key = k.toLowerCase();
        out[k] = TELEMETRY_REDACT_KEYS.has(key) || extraKeys?.has(key)
          ? "[REDACTED]"
          : redact(val, depth + 1);
      }
      return out;
    }
    // Mídia da Evolution chega como base64 no corpo — truncar evita despejar
    // foto/áudio do titular (PII) dentro da telemetria.
    if (typeof v === "string" && v.length > 500) return `${v.slice(0, 500)}…[${v.length}]`;
    return v;
  };
  return redact(parsed, 0);
}

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "content-type, authorization, apikey, x-twilio-signature, resend-signature, svix-id, svix-timestamp, svix-signature, x-webhook-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};


// Adapta o shape canônico (`CanonicalInboundMessage`, com `provider: string`)
// ao contrato local `InboundMessage`, estreitando `provider` para a união
// conhecida sem cast (`as`). Os normalizadores canônicos (meta-cloud/evolution)
// e o adaptador multicanal só emitem os providers listados acima; o `default`
// é um guarda fail-closed inalcançável para entradas reais.
function toInboundMessage(canonical: CanonicalInboundMessage | null): InboundMessage | null {
  if (!canonical) return null;
  switch (canonical.provider) {
    case "zapi":
    case "twilio":
    case "resend":
    case "meta-cloud":
    case "evolution":
    case "zappaz":
    case "telegram":
    case "discord":
    case "sms":
    case "email":
    case "push":
    case "manychat-whatsapp":
    case "manychat-instagram":
    case "manychat-messenger":
      return { ...canonical, provider: canonical.provider };
    default:
      return null;
  }
}

function toE164(phone: string): string {
  const digits = String(phone ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

function stripWhatsapp(v: string): string {
  return String(v ?? "")
    .replace(/^whatsapp:/i, "")
    .trim();
}

// Garante MIME válido; se o provider não informar, usa fallback do tipo de mídia.
function normalizeMime(mime: string | null | undefined, fallback: string): string {
  const m = String(mime ?? "")
    .trim()
    .toLowerCase();
  return m.includes("/") ? m : fallback;
}

// ------- Z-API normalizer (existing, untouched behavior) -------
function normalizeZapi(payload: Record<string, unknown>): InboundMessage | null {
  const external_id = String(payload.messageId ?? "");
  if (!external_id) return null;
  const phone = String(payload.phone ?? "");
  const fromMe = Boolean(payload.fromMe);
  const momentMs = Number(payload.momment ?? payload.moment ?? Date.now());
  const timestamp = new Date(isFinite(momentMs) ? momentMs : Date.now()).toISOString();
  const connectedPhone = String(payload.connectedPhone ?? "");

  const text = (payload.text as { message?: string } | undefined)?.message;
  const image = payload.image as
    | { imageUrl?: string; caption?: string; mimeType?: string }
    | undefined;
  const audio = payload.audio as { audioUrl?: string; mimeType?: string } | undefined;
  const video = payload.video as
    | { videoUrl?: string; caption?: string; mimeType?: string }
    | undefined;
  const document = payload.document as
    | { documentUrl?: string; caption?: string; mimeType?: string }
    | undefined;

  let content = "";
  let media: InboundMessage["media"] | undefined;

  if (text) content = text ?? "";
  else if (image?.imageUrl) {
    media = { url: image.imageUrl, type: normalizeMime(image.mimeType, "image/jpeg") };
    content = image.caption ?? "";
  } else if (audio?.audioUrl) {
    media = { url: audio.audioUrl, type: normalizeMime(audio.mimeType, "audio/ogg") };
  } else if (video?.videoUrl) {
    media = { url: video.videoUrl, type: normalizeMime(video.mimeType, "video/mp4") };
    content = video.caption ?? "";
  } else if (document?.documentUrl) {
    media = {
      url: document.documentUrl,
      type: normalizeMime(document.mimeType, "application/octet-stream"),
    };
    content = document.caption ?? "";
  } else {
    content = "[mensagem não suportada]";
  }

  return {
    provider: "zapi",
    external_id,
    from: fromMe ? toE164(connectedPhone) : toE164(phone),
    to: fromMe ? toE164(phone) : toE164(connectedPhone),
    content,
    media,
    timestamp,
    fromMe,
    senderName: (payload.senderName as string | undefined) ?? undefined,
  };
}

// ------- Twilio normalizer (WhatsApp) -------
function normalizeTwilio(form: URLSearchParams): InboundMessage | null {
  const external_id = form.get("MessageSid") ?? form.get("SmsSid") ?? "";
  if (!external_id) return null;
  const from = toE164(stripWhatsapp(form.get("From") ?? ""));
  const to = toE164(stripWhatsapp(form.get("To") ?? ""));
  const content = form.get("Body") ?? "";
  const numMedia = Number(form.get("NumMedia") ?? "0");
  let media: InboundMessage["media"] | undefined;
  if (numMedia > 0) {
    const url = form.get("MediaUrl0") ?? "";
    const mime = form.get("MediaContentType0") ?? "";
    if (url) media = { url, type: normalizeMime(mime, "application/octet-stream") };
  }
  return {
    provider: "twilio",
    external_id,
    from,
    to,
    content,
    media,
    timestamp: new Date().toISOString(),
    fromMe: false,
    senderName: form.get("ProfileName") ?? undefined,
  };
}

// Twilio request signature verification (HMAC-SHA1 base64 over URL + sorted params).
async function verifyTwilioSignature(
  authToken: string,
  fullUrl: string,
  form: URLSearchParams,
  signature: string,
): Promise<boolean> {
  if (!signature) return false;
  const params: string[] = [];
  const keys: string[] = [];
  form.forEach((_v, k) => {
    if (!keys.includes(k)) keys.push(k);
  });
  keys.sort();
  for (const k of keys) params.push(k + (form.get(k) ?? ""));
  const data = fullUrl + params.join("");
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(authToken),
    { name: "HMAC", hash: "SHA-1" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(data));
  const b64 = btoa(String.fromCharCode(...new Uint8Array(sig)));
  return timingSafeEqualStrings(b64, signature);
}

// ------- Resend normalizer (inbound email) -------
// Resend inbound events carry an email object; we accept a few shapes.
function normalizeResend(payload: Record<string, unknown>): InboundMessage | null {
  const type = String((payload.type as string) ?? "");
  // Only inbound message events
  if (type && !/inbound|received|email\.received/i.test(type)) return null;
  const data = (payload.data as Record<string, unknown>) ?? payload;
  const external_id = String(
    (data.email_id as string) ?? (data.id as string) ?? (data.message_id as string) ?? "",
  );
  if (!external_id) return null;
  const fromRaw = (Array.isArray(data.from) ? (data.from[0] as string) : (data.from as string)) ??
    "";
  const toRaw = (Array.isArray(data.to) ? (data.to[0] as string) : (data.to as string)) ?? "";
  const from = extractEmail(fromRaw).toLowerCase();
  const to = extractEmail(toRaw).toLowerCase();
  const subject = String(data.subject ?? "") || undefined;
  const text = String((data.text as string) ?? (data.body_plain as string) ?? "");
  const html = String((data.html as string) ?? "");
  const content = text || stripHtml(html) || "[e-mail sem corpo]";
  const attachments = (data.attachments as Array<{ url?: string; content_type?: string }>) ?? [];
  let media: InboundMessage["media"] | undefined;
  if (attachments.length > 0 && attachments[0].url) {
    media = {
      url: attachments[0].url,
      type: normalizeMime(attachments[0].content_type, "application/octet-stream"),
    };
  }
  const createdAt = String((data.created_at as string) ?? "");
  return {
    provider: "resend",
    external_id,
    from,
    to,
    content,
    media,
    subject,
    timestamp: createdAt || new Date().toISOString(),
    fromMe: false,
    senderName: extractName(fromRaw) || undefined,
  };
}

function extractEmail(v: string): string {
  const m = String(v ?? "").match(/<([^>]+)>/);
  return (m ? m[1] : v).trim();
}
function extractName(v: string): string {
  const m = String(v ?? "").match(/^\s*"?([^"<]+?)"?\s*</);
  return m ? m[1].trim() : "";
}
function stripHtml(s: string): string {
  return String(s ?? "")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// ------- Meta Cloud API normalizer (WhatsApp oficial direto) -------
// Só o primeiro message do primeiro entry/change — a Meta envia um por evento na prática.
// ponytail: mídia da Cloud API vem como media id (download exige o access token, URL expira);
// v1 registra placeholder textual. Anexar mídia de verdade = baixar via Graph e subir no storage.
function normalizeMetaCloud(payload: Record<string, unknown>): InboundMessage | null {
  return toInboundMessage(normalizeMetaCloudInbound(payload));
}

// ------- Evolution normalizer (WhatsApp self-hosted via Evolution Go) -------
// Shape real confirmado em evolution-client.ts (EvolutionInboundPayload) --
// porta do medflow-v0 (messaging-webhook-evolution/normalize.ts), adaptado ao
// contrato simples de InboundMessage deste arquivo (sem a complexidade de
// LID/swap-path do medflow-v0, que trata multi-dispositivo WhatsApp -- fora
// de escopo aqui).
//
// ponytail: mídia inbound da Evolution Go chega como base64 no corpo do
// webhook, não como URL -- persistir de verdade exigiria decodificar e subir
// pro Storage (como medflow-v0 faz em uploadWebhookMedia), fora do escopo
// desta fase. v1 registra placeholder textual, mesmo padrão já usado por
// normalizeMetaCloud acima.
function normalizeEvolution(payload: EvolutionInboundPayload): InboundMessage | null {
  return toInboundMessage(normalizeEvolutionInbound(payload));
}

// ------- Zappaz: eventos de conexão da sessão -------
// Medido em 2026-07-31 nos logs de webhook da Zappaz: a sessão entrava em loop
// `open -> close(conflict/replaced 440) -> connecting` várias vezes por segundo.
// Nesse estado o WhatsApp entrega as mensagens para o OUTRO dispositivo que
// roubou a sessão, então nenhum `inbound-message.upsert` chega — o canal parecia
// "Ativo / Webhook ok" porque `GET /session` respondia `status: "open"` no
// milissegundo certo. Passamos a ler `connection.update` e refletir o estado
// real no canal, em vez de descartá-lo em silêncio.
export type ZappazConnectionState = {
  status: "connected" | "connecting" | "disconnected" | "error";
  message: string | null;
  conflict: boolean;
};

export function readZappazConnectionUpdate(
  payload: Record<string, unknown>,
): ZappazConnectionState | null {
  const event = String(payload.event ?? payload.type ?? "");
  if (!/connection[.\-_]?update/i.test(event)) return null;

  const data = (payload.data ?? payload.payload ?? payload) as Record<string, unknown>;
  const connection = String(data.connection ?? "").toLowerCase();
  const last = data.lastDisconnect as Record<string, unknown> | undefined;
  const err = (last?.error ?? {}) as Record<string, unknown>;
  const output = (err.output ?? {}) as Record<string, unknown>;
  const errData = (err.data ?? {}) as Record<string, unknown>;
  const attrs = (errData.attrs ?? {}) as Record<string, unknown>;
  const statusCode = Number(output.statusCode ?? err.statusCode ?? 0);
  const tag = String(errData.tag ?? "").toLowerCase();
  const attrsType = String(attrs.type ?? "").toLowerCase();
  const rawMessage = String(
    (output.payload as Record<string, unknown> | undefined)?.message ?? err.message ?? "",
  );

  if (connection === "open") return { status: "connected", message: null, conflict: false };
  if (connection === "connecting") return { status: "connecting", message: null, conflict: false };
  if (connection !== "close") return null;

  if (tag === "conflict" || attrsType === "replaced" || statusCode === 440) {
    return {
      status: "error",
      conflict: true,
      message:
        "Sessão do WhatsApp substituída (conflict/replaced): este número está conectado em outro aplicativo ou em outra sessão Zappaz, que rouba a conexão a cada segundo. Desconecte os outros dispositivos/sessões e reconecte aqui.",
    };
  }
  if (statusCode === 401 || /logged.?out|logout/i.test(rawMessage)) {
    return {
      status: "disconnected",
      conflict: false,
      message: "Sessão encerrada no WhatsApp (logout). Reconecte a integração lendo o QR Code.",
    };
  }
  // Queda transitória: o Baileys reconecta sozinho. Não vira erro no card.
  return { status: "connecting", message: null, conflict: false };
}

export type ChannelRowLite = { id: string; status?: string | null };

// Janela de "flapping": depois de um conflict, um `open` só volta a marcar o
// canal como conectado se ficar estável por este tempo. Sem isso, o próprio
// loop (close 0,4s depois de open) apagaria o alerta a cada ciclo.
const ZAPPAZ_CONFLICT_COOLDOWN_MS = 3 * 60 * 1000;


function zappazReasonCode(state: ZappazConnectionState): string {
  if (state.conflict) return "conflict_440";
  if (state.status === "disconnected") return "logged_out";
  if (state.status === "connected") return "session_open";
  return "reconnecting";
}

async function applyZappazConnectionState(
  admin: SupabaseClient,
  tenantId: string,
  ch: ChannelRowLite,
  state: ZappazConnectionState,
): Promise<void> {
  try {
    const nowIso = new Date().toISOString();
    const reasonCode = zappazReasonCode(state);

    if (state.conflict) {
      const { data: current } = await admin
        .from("channels")
        .select("config")
        .eq("id", ch.id)
        .maybeSingle();
      const config = (current?.config ?? {}) as Record<string, unknown>;
      const { error } = await admin
        .from("channels")
        .update({
          status: "error",
          status_message: state.message,
          config: { ...config, zappaz_last_conflict_at: nowIso },
        })
        .eq("id", ch.id);
      if (error) throw new Error(error.message);
      await recordChannelStatusEvent(admin, {
        tenantId,
        channelId: ch.id,
        status: "error",
        reasonCode,
        reasonDetail: state.message,
        source: "webhook",
      });
      return;
    }

    if (state.status === "disconnected") {
      if (ch.status === "disconnected") return;
      const { error } = await admin
        .from("channels")
        .update({ status: "disconnected", status_message: state.message })
        .eq("id", ch.id);
      if (error) throw new Error(error.message);
      await recordChannelStatusEvent(admin, {
        tenantId,
        channelId: ch.id,
        status: "disconnected",
        reasonCode,
        reasonDetail: state.message,
        source: "webhook",
      });
      return;
    }

    if (state.status === "connected") {
      if (ch.status === "connected") return;
      const { data: current } = await admin
        .from("channels")
        .select("config")
        .eq("id", ch.id)
        .maybeSingle();
      const config = (current?.config ?? {}) as Record<string, unknown>;
      const lastConflict = Date.parse(String(config.zappaz_last_conflict_at ?? ""));
      if (
        Number.isFinite(lastConflict) &&
        Date.now() - lastConflict < ZAPPAZ_CONFLICT_COOLDOWN_MS
      ) {
        // Ainda dentro do loop de conflito: um `open` isolado não é saúde.
        return;
      }
      const { error } = await admin
        .from("channels")
        .update({
          status: "connected",
          status_message: null,
          last_connected_at: nowIso,
        })
        .eq("id", ch.id);
      if (error) throw new Error(error.message);
      await recordChannelStatusEvent(admin, {
        tenantId,
        channelId: ch.id,
        status: "connected",
        reasonCode,
        reasonDetail: "Sessão da Zappaz aberta e estável.",
        source: "webhook",
      });
    }
    // "connecting": estado transitório, não escrevemos nada (o loop de
    // reconexão da Zappaz emite dezenas por minuto).
  } catch (e) {
    await captureEdgeError(admin, {
      severity: "warn",
      source: "edge",
      operation: "messaging-webhook.zappaz_connection_update",
      tenantId,
      message: e instanceof Error ? e.message : String(e),
      context: { channel_id: ch.id, state: state.status, conflict: state.conflict },
    });
  }
}




// ------- Zappaz normalizer (WhatsApp não-oficial) -------

// Payload segue o shape Baileys-like documentado em docs.zappaz.io:
// eventos "inbound-message.upsert" / "outbound-message.upsert" (e variantes
// "messages.upsert") trazem `data.key.{id,remoteJid,fromMe}`,
// `data.message.{conversation|extendedTextMessage.text|imageMessage,...}`,
// `data.pushName` e `data.messageTimestamp`. Na prática o envelope varia:
// `data` pode vir como array de mensagens, como `{ messages: [...] }` ou
// aninhado em `data.data`. Desembrulhamos todas essas formas antes de
// desistir — senão a mensagem chega (HTTP 200) e some silenciosamente.
// Chaves de `data.message` que representam eventos de PROTOCOLO do Baileys,
// não conteúdo enviado pelo lead. Chegam junto com mídia (um POST extra por
// áudio, por exemplo) e não devem virar mensagem no inbox.
const ZAPPAZ_PROTOCOL_KEYS = [
  "protocolMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "reactionMessage",
  "pollUpdateMessage",
  "editedMessage",
] as const;

function isZappazMessageNode(rec: Record<string, unknown>): boolean {

  const key = rec.key as Record<string, unknown> | undefined;
  if (key && typeof key === "object" && key.id) return true;
  const hasId = rec.id ?? rec.messageId ?? rec.message_id;
  const hasAddr = rec.from ??
    rec.chatId ??
    rec.chat_id ??
    rec.remoteJid ??
    rec.remoteJID ??
    rec.sender ??
    rec.number ??
    rec.phone;
  return Boolean(hasId && hasAddr);
}

function unwrapZappazData(payload: Record<string, unknown>): Record<string, unknown> | null {
  const seen = new Set<unknown>();
  const queue: unknown[] = [
    payload.data,
    payload.payload,
    payload.message,
    payload.messages,
    payload,
  ];
  const nested = ["data", "payload", "message", "messages", "body", "result"];
  let guard = 0;
  while (queue.length && guard++ < 64) {
    const current = queue.shift();
    const node = Array.isArray(current) ? current[0] : current;
    if (!node || typeof node !== "object" || seen.has(node)) continue;
    seen.add(node);
    const rec = node as Record<string, unknown>;
    if (isZappazMessageNode(rec)) {
      const key = (rec.key ?? (rec.message as Record<string, unknown> | undefined)?.key) as
        | Record<string, unknown>
        | undefined;
      return key && !rec.key ? { ...rec, key } : rec;
    }
    for (const k of nested) if (rec[k]) queue.push(rec[k]);
  }
  return null;
}

function normalizeZappaz(payload: Record<string, unknown>): InboundMessage | null {
  const event = String(payload.event ?? payload.type ?? "");
  if (
    event &&
    !/(message|messages)[.-]?upsert$/i.test(event.replace(/^inbound-|^outbound-/i, ""))
  ) {
    return null;
  }
  const data = unwrapZappazData(payload);
  if (!data) {
    console.warn("[zappaz] payload não reconhecido", {
      event,
      topLevelKeys: Object.keys(payload).slice(0, 12),
      payloadKeys:
        payload.payload && typeof payload.payload === "object" && !Array.isArray(payload.payload)
          ? Object.keys(payload.payload as Record<string, unknown>).slice(0, 12)
          : Array.isArray(payload.payload)
          ? ["<array>"]
          : [],
      dataKeys: payload.data && typeof payload.data === "object" && !Array.isArray(payload.data)
        ? Object.keys(payload.data as Record<string, unknown>).slice(0, 12)
        : Array.isArray(payload.data)
        ? ["<array>"]
        : [],
    });
    return null;
  }
  const key = (data.key as Record<string, unknown>) ?? {};
  const external_id = String(key.id ?? data.id ?? data.messageId ?? data.message_id ?? "");
  if (!external_id) return null;
  const fromMe = Boolean(key.fromMe ?? data.fromMe ?? data.from_me);
  // O WhatsApp pode endereçar a conversa por LID (addressingMode "lid"):
  // key.remoteJid vem como "40420507672778@lid", que NÃO é telefone — o
  // número real chega em key.remoteJidAlt ("554599022026@s.whatsapp.net").
  // Preferimos sempre um JID discável; @lid/@g.us nunca viram telefone.
  const isDialable = (v: unknown): v is string =>
    typeof v === "string" && v.length > 0 && !/@(lid|g\.us|broadcast)$/i.test(v);
  const jidCandidates = [
    key.remoteJidAlt,
    (data as Record<string, unknown>).remoteJidAlt,
    key.senderPn,
    key.participantAlt,
    key.participant,
    key.remoteJid,
    key.remoteJID,
    data.remoteJid,
    data.remoteJID,
    data.chatId,
    data.chat_id,
    data.from,
    data.sender,
    data.number,
    data.phone,
  ];
  const jid = String(jidCandidates.find(isDialable) ?? "");
  // JID formato "5511999999999@s.whatsapp.net" — extrai só os dígitos.
  const phone = jid.split("@")[0]?.split(":")[0]?.replace(/\D/g, "") ?? "";
  if (!phone) {
    console.warn("[zappaz] mensagem sem telefone discável (somente LID/grupo)", {
      external_id,
      remoteJid: typeof key.remoteJid === "string" ? key.remoteJid : null,
    });
    return null;
  }

  const message = (
    typeof data.message === "object" && data.message !== null ? data.message : {}
  ) as Record<string, unknown>;
  const plainText = [data.message, data.body, data.text, data.content, data.caption].find(
    (v) => typeof v === "string" && v,
  ) as string | undefined;

  let content = "";
  let media: InboundMessage["media"] | undefined;
  if (typeof message.conversation === "string") {
    content = message.conversation;
  } else if (
    message.extendedTextMessage &&
    typeof (message.extendedTextMessage as Record<string, unknown>).text === "string"
  ) {
    content = String((message.extendedTextMessage as Record<string, unknown>).text ?? "");
  } else if (message.imageMessage) {
    const img = message.imageMessage as Record<string, unknown>;
    content = String(img.caption ?? "");
    const url = String(img.url ?? "");
    if (url) media = { url, type: normalizeMime(String(img.mimetype ?? ""), "image/jpeg") };
  } else if (message.audioMessage) {
    const aud = message.audioMessage as Record<string, unknown>;
    const url = String(aud.url ?? "");
    // `mediaKey` vinha sendo descartada aqui. Sem ela, a URL `.enc` da CDN é só
    // ciphertext e a transcrição recusa o arquivo — foi o que manteve o canal
    // mudo para áudio. Quem consome é o re-hospedamento, logo antes de persistir.
    const key = typeof aud.mediaKey === "string" ? aud.mediaKey : undefined;
    if (url) media = { url, type: normalizeMime(String(aud.mimetype ?? ""), "audio/ogg"), key };
    // Áudio nunca tem legenda: sem este marcador a mensagem entrava com
    // content vazio e o inbox mostrava uma bolha em branco. Mesmo texto já
    // usado pela Meta (normalizers.ts) — a transcrição usa media_url.
    content = "[audio recebida — abra no WhatsApp para ver]";
  } else if (message.videoMessage) {
    const vid = message.videoMessage as Record<string, unknown>;
    content = String(vid.caption ?? "");
    const url = String(vid.url ?? "");
    if (url) media = { url, type: normalizeMime(String(vid.mimetype ?? ""), "video/mp4") };
  } else if (message.documentMessage) {
    const doc = message.documentMessage as Record<string, unknown>;
    content = String(doc.caption ?? doc.fileName ?? "");
    const url = String(doc.url ?? "");
    if (url) {
      media = { url, type: normalizeMime(String(doc.mimetype ?? ""), "application/octet-stream") };
    }
  } else if (plainText) {
    content = plainText;
  } else if (ZAPPAZ_PROTOCOL_KEYS.some((k) => k in message)) {
    // Evento de protocolo do Baileys (chave de criptografia, recibo, reação,
    // edição...): NÃO é mensagem do lead. Antes virava uma linha fantasma
    // "[mensagem não suportada]" no inbox, duplicando cada áudio recebido.
    return null;
  } else {
    content = "[mensagem não suportada]";
  }


  const ts = data.messageTimestamp ?? data.timestamp ?? data.t;
  const tsMs = typeof ts === "number"
    ? ts > 1e12 ? ts : ts * 1000
    : typeof ts === "string" && /^\d+$/.test(ts)
    ? Number(ts) > 1e12 ? Number(ts) : Number(ts) * 1000
    : typeof ts === "string" && Number.isFinite(Date.parse(ts))
    ? Date.parse(ts)
    : Date.now();
  const timestamp = new Date(tsMs).toISOString();
  const pushName = [data.pushName, data.senderName, data.notifyName, data.name].find(
    (v) => typeof v === "string" && v,
  ) as string | undefined;
  return {
    provider: "zappaz",
    external_id,
    from: fromMe ? "" : toE164(phone),
    to: fromMe ? toE164(phone) : "",
    content,
    media,
    timestamp,
    fromMe,
    senderName: pushName,
  };
}


// ------- Opt-out/opt-in por palavra-chave (user story H) -------
// Comparação por IGUALDADE EXATA do texto inteiro normalizado -- nunca
// substring. "parar"/"sair"/"stop" aparecem dentro de frases legítimas
// ("não vou parar de comprar com vocês", "vou sair mais tarde daqui") que
// não são opt-out; só a mensagem INTEIRA reduzida a exatamente uma dessas
// palavras conta. Isso é uma limitação deliberada de v1 (frases como "quero
// parar" não disparam) -- documentado aqui, não um bug.
//
// Pontuação final (! ? . , ; :) é tolerada -- "Sair!" e "sair." devem
// continuar batendo -- mas essa regra fica aqui (não em
// normalizeMessagingText, que é genérica e não deve embutir regra de
// pontuação) via stripTrailingPunctuation.
const OPT_OUT_KEYWORDS = new Set(["parar", "sair", "stop"]);
const OPT_IN_KEYWORDS = new Set(["voltar", "inscrever", "start"]);

function stripTrailingPunctuation(s: string): string {
  return s.replace(/[!?.,;:]+$/, "");
}

function matchesKeyword(rawContent: string, keywords: Set<string>): boolean {
  const key = stripTrailingPunctuation(normalizeMessagingText(rawContent));
  return keywords.has(key);
}

// Aplica opt-out/opt-in por palavra-chave a uma mensagem inbound de WhatsApp
// já persistida (chamar só com channelType === "whatsapp" -- a tabela é
// phone-scoped, e-mail não tem "phone" pra suprimir). Retorna
// suppressedNow=true quando a mensagem bateu com uma palavra de opt-out
// (novo ou repetido) -- o caller usa isso pra decidir se pula a resposta
// automática da IA para esta mensagem específica.
async function applyKeywordOptOutOptIn(
  admin: SupabaseClient,
  tenantId: string,
  contactId: string | null,
  phone: string,
  rawContent: string,
): Promise<{ suppressedNow: boolean }> {
  // Canonicaliza pra E.164 -- write e leitura (isPhoneSuppressed) usam o
  // mesmo helper, evitando opt-out gravado num formato e lido em outro.
  const normalized = normalizePhone(phone);
  if (!normalized) return { suppressedNow: false };

  if (matchesKeyword(rawContent, OPT_OUT_KEYWORDS)) {
    // Upsert incondicional -- equivalente em ESTADO FINAL ao pedido original
    // "ON CONFLICT (tenant_id, phone, scope) DO UPDATE SET reactivated_at =
    // null WHERE reactivated_at IS NOT NULL": o PostgREST não expõe um WHERE
    // parcial no DO UPDATE via .upsert(), então sobrescrevemos
    // incondicionalmente com os mesmos valores-alvo (reason/source fixos e
    // reactivated_at: null). Se a linha já estava suprimida e ativa
    // (reactivated_at já null), o upsert é um no-op efetivo; se tinha sido
    // reativada (opt-in anterior), volta a null. suppressed_at não é
    // enviado no payload, então o PostgREST não o toca em conflito
    // (permanece a data da supressão original).
    const { error } = await admin.from("messaging_phone_suppressions").upsert(
      {
        tenant_id: tenantId,
        contact_id: contactId,
        phone: normalized,
        scope: "phone",
        reason: "Opt-out via mensagem",
        source: "keyword",
        reactivated_at: null,
      },
      { onConflict: "tenant_id,phone,scope" },
    );
    if (error) throw error;
    return { suppressedNow: true };
  }

  if (matchesKeyword(rawContent, OPT_IN_KEYWORDS)) {
    const { error } = await admin
      .from("messaging_phone_suppressions")
      .update({ reactivated_at: new Date().toISOString() })
      .eq("tenant_id", tenantId)
      .eq("phone", normalized)
      .eq("scope", "phone")
      .is("reactivated_at", null);
    if (error) throw error;
    return { suppressedNow: false };
  }

  return { suppressedNow: false };
}

type WebhookClaimState = "claimed" | "reclaimed" | "busy" | "completed";

interface WebhookClaim {
  claimed: boolean;
  eventId: string | null;
  state: WebhookClaimState;
  attempt: number;
}

// Idempotência de transporte com lease. A RPC só devolve claimed/reclaimed
// quando inseriu o evento ou recuperou uma tentativa failed/expirada. busy
// protege concorrência e completed deduplica sucessos definitivos.
async function claimWebhookEvent(
  admin: SupabaseClient,
  tenantId: string,
  channelId: string,
  eventType: string,
  externalEventId: string,
  payload: Record<string, unknown>,
  provider: string,
): Promise<WebhookClaim> {
  const { data, error } = await admin.rpc("claim_messaging_webhook_event", {
    p_tenant_id: tenantId,
    p_channel_id: channelId,
    p_event_type: eventType,
    p_external_event_id: externalEventId || null,
    p_payload: payload,
  });
  if (error) {
    throw new Error(`Falha ao reservar evento de webhook: ${error.message}`);
  }
  const row = (Array.isArray(data) ? data[0] : data) as
    | { event_id?: unknown; claim_state?: unknown; attempt?: unknown }
    | null;
  const state = String(row?.claim_state ?? "") as WebhookClaimState;
  const eventId = typeof row?.event_id === "string" ? row.event_id : null;
  const attempt = Number(row?.attempt ?? 0);
  if (!eventId || !["claimed", "reclaimed", "busy", "completed"].includes(state)) {
    throw new Error("RPC claim_messaging_webhook_event devolveu resposta inválida");
  }
  if (state === "claimed" || state === "reclaimed") {
    const { error: updErr } = await admin
      .from("messaging_webhook_events")
      .update({ provider })
      .eq("id", eventId);
    if (updErr) console.error("messaging_webhook_events.provider update failed", updErr.message);
  }
  return {
    claimed: state === "claimed" || state === "reclaimed",
    eventId,
    state,
    attempt,
  };
}

async function markWebhookEventProcessed(admin: SupabaseClient, eventId: string): Promise<void> {
  const { error } = await admin
    .from("messaging_webhook_events")
    .update({
      processed: true,
      processed_at: new Date().toISOString(),
      status: "completed",
      lease_expires_at: null,
      error: null,
    })
    .eq("id", eventId);
  if (error) throw new Error(`Falha ao concluir evento de webhook: ${error.message}`);
}

async function releaseWebhookEventClaim(
  admin: SupabaseClient,
  eventId: string,
  errorMessage: string,
): Promise<string | null> {
  const { error } = await admin
    .from("messaging_webhook_events")
    .update({
      status: "failed",
      processed: false,
      lease_expires_at: new Date().toISOString(),
      error: errorMessage.slice(0, 2_000),
    })
    .eq("id", eventId)
    .eq("processed", false);
  return error?.message ?? null;
}


// channel_id (rota nova por canal) é sempre um uuid; o slug legado
// (tenant_integrations) nunca é. A escolha de caminho de autenticação é só
// pelo FORMATO do segmento final da URL -- ver bloco de resolução abaixo.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  const url = new URL(req.url);
  const parts = url.pathname.split("/").filter(Boolean);
  const pathSegment = parts[parts.length - 1] ?? "";
  const token = url.searchParams.get("token") ?? "";

  if (!pathSegment || !token) return new Response("Unauthorized", { status: 401 });

  const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
  const SERVICE_ROLE = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
  const admin = createClient(SUPABASE_URL, SERVICE_ROLE, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  // Duas formas de resolver tenant/canal, pelo FORMATO do segmento final da
  // URL:
  // - NOVA (por canal): /<channel_id>?token=<channels.webhook_token> --
  //   channel_id é um uuid, resolve tenant+canal direto por
  //   channels.id+webhook_token, sem depender de tenant_integrations. É o
  //   caminho usado pelo provider Evolution (token por INSTÂNCIA, não por
  //   tenant) e fica disponível a qualquer provider novo.
  // - LEGADA (slug+tenant): /<slug>?token=<tenant_integrations.webhook_token>
  //   -- caminho ORIGINAL, mantido byte-a-byte igual (mesmas queries, mesma
  //   ordem) para não quebrar nenhuma integração já configurada no painel de
  //   um provider externo.
  let tenantId: string;
  let providerSlug: string;
  let ch: { id: string; type: string } | null;

  if (UUID_RE.test(pathSegment)) {
    const { data: chAuth, error: chAuthError } = await admin
      .from("channels")
      .select("id, tenant_id, type, provider_slug, status")
      .eq("id", pathSegment)
      .eq("webhook_token", token)
      .maybeSingle();
    // HIGH (code review 2026-07-24, 05-silent-failures H3): erro de banco aqui
    // devolvia 401. Além de mandar o suporte investigar "token errado" numa
    // instabilidade, era perigoso: Meta e Evolution DESABILITAM a assinatura do
    // webhook depois de uma sequência de 401, então um apagão de banco derrubava
    // os canais de todos os tenants — e reativar é manual, um a um.
    //
    // 503 continua fail-closed (não autoriza nada, não distingue token válido de
    // inválido para quem chama) e é o que o provider entende como "tente de
    // novo". 401 fica reservado para o caso em que a consulta funcionou e não
    // achou linha, que é o único em que sabemos que o token está errado. Revisa
    // a decisão da rodada 3 do PR #124, que só tinha adicionado telemetria.
    if (chAuthError) {
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "messaging-webhook.auth_canal",
        tenantId: null,
        message: chAuthError.message,
        context: { db_code: chAuthError.code ?? "" },
      });
      return new Response("Service Unavailable", { status: 503 });
    }
    if (!chAuth) return new Response("Unauthorized", { status: 401 });
    tenantId = chAuth.tenant_id as string;
    providerSlug = chAuth.provider_slug as string;
    ch = chAuth.status === "connected"
      ? { id: chAuth.id as string, type: chAuth.type as string }
      : null;
  } else {
    // Resolve tenant strictly by webhook token.
    const { data: ti, error: tiError } = await admin
      .from("tenant_integrations")
      .select("tenant_id, slug, status")
      .eq("slug", pathSegment)
      .eq("webhook_token", token)
      .maybeSingle();
    // Mesmo raciocínio do bloco acima: 503 quando a consulta falhou, 401 só
    // quando ela funcionou e o token não bate (ou a integração está inativa).
    if (tiError) {
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "messaging-webhook.auth_tenant",
        tenantId: null,
        message: tiError.message,
        context: { provider_slug: pathSegment, db_code: tiError.code ?? "" },
      });
      return new Response("Service Unavailable", { status: 503 });
    }
    if (!ti || ti.status !== "active") return new Response("Unauthorized", { status: 401 });
    tenantId = ti.tenant_id as string;
    providerSlug = pathSegment;
    ch = null; // resolvido abaixo, depois da checagem de verificação da Meta (comportamento original)
  }

  // Verificação de webhook da Meta (GET com hub.challenge). O token da URL já
  // autenticou o tenant acima; exigimos que o verify token digitado seja o mesmo,
  // comparado em tempo constante (evita side-channel de timing sobre o token).
  if (req.method === "GET" && url.searchParams.get("hub.mode") === "subscribe") {
    const verifyToken = url.searchParams.get("hub.verify_token") ?? "";
    if (!timingSafeEqualStrings(verifyToken, token)) {
      return new Response("Unauthorized", { status: 401 });
    }
    return new Response(url.searchParams.get("hub.challenge") ?? "", {
      status: 200,
      headers: { "content-type": "text/plain" },
    });
  }

  if (!UUID_RE.test(pathSegment)) {
    // MEDIUM (code review): esta query roda DEPOIS da autenticação (o tenant já
    // foi resolvido por webhook_token acima), então um erro real de banco aqui não
    // é caso de 401. Descartá-lo fazia a falha virar "canal não conectado" → 200,
    // e o provider considerava a mensagem entregue: perda silenciosa de inbound.
    // 503 faz o provider reentregar. Só neste ponto — as queries de auth acima
    // continuam fail-closed em 401 de propósito.
    const { data: chRow, error: chRowError } = await admin
      .from("channels")
      .select("id, type")
      .eq("tenant_id", tenantId)
      .eq("provider_slug", providerSlug)
      .eq("status", "connected")
      .maybeSingle();
    // Códigos permanentes: schema/permissão quebrada não se resolve com retry.
    const PERMANENT_DB_CODES = new Set(["42P01", "42703", "42501", "42883"]);
    if (chRowError) {
      await captureEdgeError(admin, {
        severity: "error",
        source: "edge",
        operation: "messaging-webhook.resolver_canal",
        tenantId,
        message: chRowError.message,
        context: { provider_slug: providerSlug, db_code: chRowError.code ?? "" },
      });
      // Default = 503 (transitório: rede caída chega com code ""). 200 só na allowlist,
      // senão um erro permanente vira 5xx infinito e o provider desabilita a assinatura.
      if (!PERMANENT_DB_CODES.has(chRowError.code ?? "")) {
        return new Response("retry", { status: 503, headers: { "content-type": "text/plain" } });
      }
    }
    ch = chRow as { id: string; type: string } | null;
  }

  // Read body once, dispatch by provider.
  const rawBody = await req.text().catch(() => "");

  // Canal não resolvido/não conectado é condição ESPERADA (onboarding Evolution em
  // waiting_qr/connecting, entregas após "esquecer integração"), não exceção — e
  // precisa ser tratada ANTES do try, por segurança: esta checagem roda antes de
  // TODOS os 2º fatores (Client-Token, HMAC, x-webhook-secret, instanceToken).
  // Se caísse no catch, quem tivesse apenas o token da URL — que o próprio arquivo
  // documenta como reusável, e é por isso que o 2º fator existe — conseguiria
  // gravar telemetria com corpo escolhido por ele, sem passar por assinatura
  // nenhuma e sem rate limit. Responde 200 sem persistir nada.
  if (!ch) {
    console.warn("[messaging-webhook] canal não conectado — inbound ignorado", {
      slug: providerSlug,
      tenant: tenantId,
    });
    return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
  }

  let activeWebhookClaimId: string | null = null;
  try {
    let normalized: InboundMessage | null = null;

    if (providerSlug === "zapi") {
      // 2º fator OBRIGATÓRIO (fail-closed, mesmo padrão de meta-cloud/twilio/resend):
      // o Client-Token do webhook Z-API deve existir em integration_secrets e casar,
      // em tempo constante, com o header enviado pela Z-API. O token da URL sozinho é
      // reusável — sem o 2º fator, um request forjado injetaria mensagem e dispararia
      // a IA (custo de LLM) do tenant. A janela antiga (processar só com aviso quando
      // o client_token não estava configurado) fechou: tenant Z-API conectado antes
      // disto precisa cadastrar o Client-Token em Integrações para voltar a receber
      // inbound. Erro real de query também é fail-closed, nunca vira cred vazio.
      const { data: zapiSecrets, error: zapiSecretsError } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", "zapi");
      if (zapiSecretsError) return new Response("Unauthorized", { status: 401 });
      const zapiCred: Record<string, string> = {};
      for (const r of zapiSecrets ?? []) zapiCred[r.key as string] = r.value as string;
      const expectedClientToken = zapiCred.client_token ?? "";
      const providedClientToken = req.headers.get("Client-Token") ??
        req.headers.get("client-token") ?? "";
      if (!expectedClientToken) {
        console.warn(
          "[messaging-webhook] Z-API sem client_token configurado — inbound rejeitado (fail-closed)",
          {
            tenant: tenantId,
          },
        );
        return new Response("Unauthorized", { status: 401 });
      }
      if (
        !providedClientToken ||
        !timingSafeEqualStrings(providedClientToken, expectedClientToken)
      ) {
        return new Response("Unauthorized", { status: 401 });
      }
      const payload = safeJson(rawBody);
      if (payload) normalized = normalizeZapi(payload);
    } else if (providerSlug === "twilio") {
      const form = new URLSearchParams(rawBody);
      const { data: secrets, error: secretsError } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", "twilio");
      // Falha REAL de query (timeout, blip de conexão) não pode virar
      // `cred = {}` silenciosamente, senão uma falha transitória de banco
      // deixaria um webhook forjado passar como legítimo.
      if (secretsError) return new Response("Unauthorized", { status: 401 });
      const cred: Record<string, string> = {};
      for (const r of secrets ?? []) cred[r.key as string] = r.value as string;
      // Assinatura obrigatória (fail-closed, mesmo padrão do branch meta-cloud
      // abaixo): sem auth_token cadastrado ou sem x-twilio-signature válida, o
      // inbound é rejeitado. `auth_token` já é required_secret desde o seed do
      // catálogo, então todo tenant conectado tem o segredo — a janela antiga
      // (aceitar sem verificar quando o segredo faltava) era só brecha.
      const authToken = cred.auth_token ?? "";
      if (!authToken) return new Response("Unauthorized", { status: 401 });
      const sig = req.headers.get("x-twilio-signature") ?? "";
      if (!sig) return new Response("Unauthorized", { status: 401 });
      const ok = await verifyTwilioSignature(authToken, req.url, form, sig);
      if (!ok) return new Response("Unauthorized", { status: 401 });
      normalized = normalizeTwilio(form);
    } else if (providerSlug === "resend") {
      const payload = safeJson(rawBody);
      const { data: secrets, error: secretsError } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", "resend");
      // Mesmo raciocínio do branch twilio acima: erro real de query é
      // fail-closed (401), nunca vira cred={} como se não houvesse signing
      // secret configurado.
      if (secretsError) return new Response("Unauthorized", { status: 401 });
      const cred: Record<string, string> = {};
      for (const r of secrets ?? []) cred[r.key as string] = r.value as string;
      // Assinatura Svix obrigatória (fail-closed, mesmo padrão do meta-cloud):
      // sem webhook_signing_secret cadastrado ou sem headers svix válidos, o
      // inbound é rejeitado. O campo virou required_secret na migration
      // 20260712180000 — tenant conectado antes dela precisa reconectar
      // preenchendo o signing secret para voltar a receber e-mails.
      const signingSecret = cred.webhook_signing_secret ?? "";
      if (!signingSecret) return new Response("Unauthorized", { status: 401 });
      const svixId = req.headers.get("svix-id") ?? "";
      const svixTs = req.headers.get("svix-timestamp") ?? "";
      const svixSig = req.headers.get("svix-signature") ?? "";
      if (!svixId || !svixTs || !svixSig) return new Response("Unauthorized", { status: 401 });
      const ok = await verifySvix(signingSecret, svixId, svixTs, rawBody, svixSig);
      if (!ok) return new Response("Unauthorized", { status: 401 });
      if (payload) normalized = normalizeResend(payload);
    } else if (providerSlug === "meta-cloud") {
      const payload = safeJson(rawBody);
      const { data: secrets } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", "meta-cloud");
      const cred: Record<string, string> = {};
      for (const r of secrets ?? []) cred[r.key as string] = r.value as string;
      // Assinatura obrigatória (fail-closed): sem app_secret cadastrado ou sem
      // x-hub-signature-256 válido, o inbound é rejeitado. Impede que qualquer
      // request forjado no webhook injete mensagem e dispare a IA do tenant.
      const appSecret = cred.app_secret ?? "";
      if (!appSecret) return new Response("Unauthorized", { status: 401 });
      const sig = req.headers.get("x-hub-signature-256") ?? "";
      if (!sig) return new Response("Unauthorized", { status: 401 });
      const ok = await verifyMetaSignature(appSecret, rawBody, sig);
      if (!ok) return new Response("Unauthorized", { status: 401 });
      if (payload) normalized = normalizeMetaCloud(payload);
    } else if (providerSlug === "evolution") {
      const payload = safeJson(rawBody) as EvolutionInboundPayload | null;
      const { data: secrets } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", "evolution");
      const cred: Record<string, string> = {};
      for (const r of secrets ?? []) cred[r.key as string] = r.value as string;
      // Autenticação por token de INSTÂNCIA (não HMAC como Meta/Twilio/Resend):
      // o corpo do webhook Evolution Go traz `instanceToken`, comparado contra
      // `instance_token` (ou `api_key` como fallback, mesma convenção de
      // evolution-client.ts) armazenado em integration_secrets pro canal
      // resolvido. Fail-closed (mesmo padrão do branch meta-cloud acima): sem
      // credencial configurada ou token que não bate, nunca processa.
      const storedToken = cred.instance_token || cred.api_key || "";
      const providedToken = String(payload?.instanceToken ?? "");
      if (!storedToken || !providedToken || !timingSafeEqualStrings(providedToken, storedToken)) {
        return new Response("Unauthorized", { status: 401 });
      }
      if (payload) {
        normalized = normalizeEvolution(payload);
        // Formato não reconhecido vira "[mensagem não suportada]" no inbox e,
        // sem rastro, não há como descobrir qual campo veio. Grava um resumo
        // ESTRUTURAL (só nomes de campos e tipo declarado — sem texto, sem
        // mediaKey, sem base64) para fechar o caso sem tentativa e erro.
        if (normalized && normalized.content === "[mensagem não suportada]") {
          await captureEdgeError(admin, {
            severity: "warn",
            source: "edge",
            operation: "messaging-webhook.evolution_formato_desconhecido",
            tenantId,
            message: "Evolution enviou uma mensagem em formato não reconhecido.",
            context: describeEvolutionMessageShape(payload),
          });
        }
      }
    } else if (providerSlug === "zappaz") {
      // 2º fator obrigatório (fail-closed, mesmo padrão dos outros providers):
      // ao conectar via integration-connect, registramos o webhook Zappaz
      // com o header `x-webhook-secret` = api_key. Aqui exigimos o mesmo
      // header, comparado em tempo constante contra `api_key` armazenado em
      // integration_secrets. Sem credencial ou header ausente/incorreto → 401
      // antes de qualquer efeito (persistência, disparo de IA).
      const { data: secrets, error: secretsError } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", "zappaz");
      if (secretsError) return new Response("Unauthorized", { status: 401 });
      const cred: Record<string, string> = {};
      for (const r of secrets ?? []) cred[r.key as string] = r.value as string;
      const expected = cred.api_key ?? "";
      if (!expected) return new Response("Unauthorized", { status: 401 });
      const provided = req.headers.get("x-webhook-secret") ?? "";
      if (!provided || !timingSafeEqualStrings(provided, expected)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const payload = safeJson(rawBody);
      const connState = payload ? readZappazConnectionUpdate(payload) : null;
      if (connState) {
        await applyZappazConnectionState(admin, tenantId, ch as ChannelRowLite, connState);
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }
      if (payload) normalized = normalizeZappaz(payload);

    } else if (isManyChatSlug(providerSlug)) {
      // External Request do ManyChat. 2º fator obrigatório (fail-closed, mesmo
      // padrão de zappaz/multicanal): header `x-webhook-secret` comparado em
      // tempo constante com o `webhook_secret` que o integration-connect gerou
      // para ESTE slug. Nada é gravado antes disso.
      const { data: mcSecrets, error: mcSecretsError } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", providerSlug);
      if (mcSecretsError) return new Response("Unauthorized", { status: 401 });
      const mcCred: Record<string, string> = {};
      for (const r of mcSecrets ?? []) mcCred[r.key as string] = r.value as string;
      const webhookSecret = mcCred.webhook_secret ?? "";
      const providedSecret = req.headers.get("x-webhook-secret") ?? "";
      if (!webhookSecret || !providedSecret || !timingSafeEqualStrings(providedSecret, webhookSecret)) {
        return new Response("Unauthorized", { status: 401 });
      }
      // Erro de contrato volta 4xx com o motivo: é o que o operador lê na aba
      // Response do "Test Request". O ManyChat não reentrega External Request,
      // então 4xx não vira loop.
      const reject = (status: number, code: string, error: string) =>
        new Response(JSON.stringify({ ok: false, code, error }), {
          status,
          headers: { "content-type": "application/json" },
        });
      if (new TextEncoder().encode(rawBody).byteLength > MANYCHAT_MAX_BODY_BYTES) {
        return reject(413, "payload_too_large", "Corpo acima de 64 KB.");
      }
      const payload = safeJson(rawBody);
      if (!payload) return reject(400, "invalid_json", "Corpo não é JSON válido.");
      const mc = await normalizeManyChatInbound(payload, providerSlug);
      if (!mc.ok) return reject(422, mc.code, mc.error);
      normalized = toInboundMessage(mc.message);
    } else if (["telegram", "discord", "sms", "email", "push"].includes(providerSlug)) {
      // 2º fator obrigatório (fail-closed, mesmo padrão de meta-cloud/twilio/resend):
      // esses canais genéricos usam um segredo compartilhado `webhook_secret` por
      // tenant em integration_secrets, enviado pelo provider no header
      // `x-webhook-secret` e comparado em tempo constante. O token da URL já
      // autenticou o canal acima, mas — como nos outros 5 providers — exigimos um
      // segundo fator antes de tocar o DB (delivery-receipt/ledger de metering) ou
      // disparar `ai-respond` (custo de LLM), senão qualquer request com o token da
      // URL forjaria mensagem. Sem tenant legado nesses canais (introduzidos nesta
      // fase), não há janela de leniência como no zapi: erro real de query, segredo
      // ausente, ou header ausente/incorreto → 401, ANTES de qualquer efeito.
      const { data: mcSecrets, error: mcSecretsError } = await admin
        .from("integration_secrets")
        .select("key, value")
        .eq("tenant_id", tenantId)
        .eq("slug", providerSlug);
      if (mcSecretsError) return new Response("Unauthorized", { status: 401 });
      const mcCred: Record<string, string> = {};
      for (const r of mcSecrets ?? []) mcCred[r.key as string] = r.value as string;
      const webhookSecret = mcCred.webhook_secret ?? "";
      if (!webhookSecret) return new Response("Unauthorized", { status: 401 });
      const providedSecret = req.headers.get("x-webhook-secret") ?? "";
      if (!providedSecret || !timingSafeEqualStrings(providedSecret, webhookSecret)) {
        return new Response("Unauthorized", { status: 401 });
      }
      const payload = safeJson(rawBody);
      if (payload) {
        const receipt = normalizeDeliveryReceipt(providerSlug, payload);
        if (receipt) {
          const patch = receipt.status === "delivered"
            ? {
              status: "delivered",
              delivered_at: receipt.timestamp,
              provider_status_at: receipt.timestamp,
            }
            : receipt.status === "read"
            ? {
              status: "read",
              read_at: receipt.timestamp,
              provider_status_at: receipt.timestamp,
            }
            : receipt.status === "failed"
            ? {
              status: "failed",
              send_error: receipt.error,
              provider_status_at: receipt.timestamp,
            }
            : { status: "sent", provider_status_at: receipt.timestamp };
          const { data: receiptMessage, error: receiptUpdErr } = await admin
            .from("messages")
            .update(patch)
            .eq("tenant_id", tenantId)
            .eq("external_id", receipt.external_id)
            .select("id")
            .maybeSingle();
          if (receiptUpdErr) {
            console.error("[messaging-webhook] delivery-receipt update falhou", {
              tenant: tenantId,
              provider: providerSlug,
              external_id: receipt.external_id,
              err: receiptUpdErr.message,
            });
          }
          const { error: receiptUsageErr } = await admin.from("communication_usage_events").insert({
            tenant_id: tenantId,
            message_id: receiptMessage?.id ?? null,
            provider_slug: providerSlug,
            event_type: `message.${receipt.status}`,
            units: 0,
            estimated_cost_micros: 0,
            idempotency_key: `${providerSlug}:${receipt.external_id}:${receipt.status}`,
            occurred_at: receipt.timestamp,
          });
          // 23505 = índice único de idempotência (reentrega do mesmo receipt):
          // guarda funcionando, não é erro — só logamos falhas reais.
          if (receiptUsageErr && (receiptUsageErr as { code?: string }).code !== "23505") {
            console.error("[messaging-webhook] delivery-receipt ledger falhou", {
              tenant: tenantId,
              provider: providerSlug,
              external_id: receipt.external_id,
              err: receiptUsageErr.message,
            });
          }
        } else {
          normalized = toInboundMessage(
            createMultichannelAdapter(
              providerSlug as "telegram" | "discord" | "sms" | "email" | "push",
              {},
            ).normalizeInbound(payload),
          );
        }
      }
    }

    if (normalized) {
      // Idempotência de webhook: se o provider reentregar o mesmo evento
      // (retry), o claim falha e saímos sem reprocessar — nunca reenviar a
      // mesma mensagem para contact/conversation/AI.
      // O payload do claim é GRAVADO em messaging_webhook_events. `media.key` é
      // a mediaKey do WhatsApp — chave de decifragem da mídia daquele lead — e
      // não pode ir para o banco: o contrato de InboundMessage.media diz que ela
      // vive só dentro desta requisição. Tirar a chave depois do claim não
      // adiantaria, a linha já teria sido escrita com ela.
      const payloadParaClaim = normalized.media
        ? { ...normalized, media: { url: normalized.media.url, type: normalized.media.type } }
        : normalized;
      const claim = await claimWebhookEvent(
        admin,
        tenantId,
        ch.id as string,
        normalized.provider,
        normalized.external_id,
        payloadParaClaim as unknown as Record<string, unknown>,
        normalized.provider,
      );
      if (!claim.claimed) {
        if (claim.state === "busy") {
          return new Response("retry", {
            status: 503,
            headers: { "content-type": "text/plain", "retry-after": "60" },
          });
        }
        return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
      }
      activeWebhookClaimId = claim.eventId;
      if (claim.state === "reclaimed") {
        await captureEdgeError(admin, {
          severity: "warn",
          source: "edge",
          operation: "messaging-webhook.retry_claim",
          tenantId,
          message: "Reentrega recuperou uma tentativa anterior incompleta",
          context: {
            event_id: claim.eventId,
            external_event_id: normalized.external_id,
            attempt: claim.attempt,
            provider: normalized.provider,
          },
        });
      }

      // Áudio cifrado do WhatsApp nativo: decifra com a `mediaKey` do próprio
      // payload e re-hospeda no bucket antes de gravar, para `messages.media_url`
      // já nascer apontando para um OGG que a transcrição consegue ler.
      //
      // Aqui e não em ai-respond porque o link `.enc` da CDN expira e a
      // transcrição roda depois, assíncrona e com retry. Falha devolve null e a
      // URL original fica: a resposta degradada ("me manda por escrito") segue
      // valendo como rede de segurança.
      if (normalized.media?.base64 && normalized.media.type.startsWith("audio/")) {
        // Áudio já decifrado, embutido no webhook (Evolution Go). Só precisa ir
        // para o bucket e virar link assinado antes de persistir.
        const stored = await storeInboundAudioBase64(admin, {
          tenantId,
          externalId: normalized.external_id,
          base64: normalized.media.base64,
          mimetype: normalized.media.type,
        });
        normalized.media = {
          url: stored ?? normalized.media.url,
          type: normalized.media.type,
          ...(stored ? {} : normalized.media.key ? { key: normalized.media.key } : {}),
        };
      }
      if (normalized.media?.key && normalized.media.type.startsWith("audio/")) {

        const rehosted = await rehostEncryptedWhatsAppAudio(admin, {
          tenantId,
          externalId: normalized.external_id,
          url: normalized.media.url,
          mediaKey: normalized.media.key,
          mimetype: normalized.media.type,
        });
        normalized.media = rehosted
          ? { url: rehosted, type: normalized.media.type }
          : { url: normalized.media.url, type: normalized.media.type };
      } else if (normalized.media && isEncryptedWhatsAppUrl(normalized.media.url)) {
        // Mídia cifrada que NÃO entrou no re-hospedamento. Some silenciosamente
        // se não registrarmos — de fora fica igual a "a IA não ouve áudio", que
        // é justamente o caso que esta telemetria existe para separar.
        //
        // Os dois motivos são distintos e o evento precisa dizer qual: gravar
        // "sem_media_key" quando a chave veio e o que faltou foi o MIME seria a
        // telemetria mentindo sobre a própria causa.
        const semChave = !normalized.media.key;
        await captureEdgeError(admin, {
          severity: "warn",
          source: "edge",
          operation: "messaging.whatsapp_media.rehost",
          tenantId,
          message: semChave
            ? "Mídia cifrada chegou sem mediaKey — impossível decifrar."
            : `Mídia cifrada com MIME não-áudio (${normalized.media.type}) — fora do re-hospedamento.`,
          context: {
            stage: semChave ? "sem_media_key" : "mime_nao_audio",
            external_id: normalized.external_id,
            media_type: normalized.media.type,
            provider: normalized.provider,
          },
        });
      }

      const result = await persistInbound(
        admin,
        tenantId,
        ch.id as string,
        ch.type,
        providerSlug,
        normalized,
      );
      // Uma tentativa anterior pode ter persistido a mensagem e falhado antes
      // do enqueue. Reaproveita a mesma mensagem em vez de criar/responder duas.
      if (claim.state === "reclaimed" && !result.messageId) {
        // `conversations(contact_id)` não é enfeite: sem ele o `result.contactId`
        // fica nulo e o gate de cancelamento/opt-out abaixo nunca passa. Esta é
        // justamente a reentrega de quem já falhou uma vez — a única chance
        // restante de cancelar o acompanhamento.
        const { data: recoveredMessage, error: recoveredMessageError } = await admin
          .from("messages")
          .select("id, sender, direction, conversations(contact_id)")
          .eq("tenant_id", tenantId)
          .eq("external_id", normalized.external_id)
          .maybeSingle();
        if (recoveredMessageError) {
          throw new Error(
            `Falha ao recuperar mensagem da reentrega: ${recoveredMessageError.message}`,
          );
        }
        if (recoveredMessage) {
          result.messageId = recoveredMessage.id as string;
          result.isContactInbound = recoveredMessage.sender === "contact" &&
            recoveredMessage.direction === "in";
          const conversa = recoveredMessage.conversations as
            | { contact_id: string | null }
            | { contact_id: string | null }[]
            | null;
          const recoveredContactId = Array.isArray(conversa)
            ? (conversa[0]?.contact_id ?? null)
            : (conversa?.contact_id ?? null);
          if (recoveredContactId) result.contactId = recoveredContactId;
        }
      }

      // Chegou inbound válido por este canal => o webhook do provedor está de
      // fato apontando pra cá. Marca saúde 'ok' para a UI parar de exibir
      // "Aguardando primeira mensagem". Best-effort: falha aqui nunca pode
      // afetar o processamento da mensagem já persistida.
      try {
        // supabase-js NÃO lança em erro do PostgREST: devolve { error }. Sem
        // checar aqui, o try/catch em volta não pega nada e o zeramento do
        // contador some em silêncio — aí um canal saudável que falha 1x vez
        // seguinte já entra como 'broken' e para de pedir retry.
        const { error: healthError } = await admin
          .from("channels")
          .update({
            webhook_health: "ok",
            webhook_health_checked_at: new Date().toISOString(),
            // Inbound processado com sucesso zera o contador de falhas
            // consecutivas — o teto de retry só deve disparar em falha corrida.
            webhook_consecutive_failures: 0,
          })
          .eq("id", ch.id as string);
        if (healthError) {
          await captureEdgeError(admin, {
            severity: "error",
            source: "edge",
            operation: "messaging-webhook.reset_saude_canal",
            tenantId,
            message: healthError.message,
            context: { channel_id: ch.id as string },
          });
        }
      } catch (e) {
        console.error("webhook health update failed", {
          tenant: tenantId,
          channel: ch.id,
          err: e instanceof Error ? e.message : String(e),
        });
      }

      // Resposta do contato encerra o acompanhamento automático. Vale para
      // QUALQUER canal (a sequência pode enviar por e-mail) e para qualquer
      // conteúdo — quem respondeu já está em conversa, não precisa de sequência.
      if (result.messageId && result.isContactInbound && result.contactId) {
        await cancelNurtureOnReply(admin, tenantId, result.contactId);
      }

      // Opt-out/opt-in por palavra-chave (user story H). Isolado em try/catch
      // próprio: uma falha aqui NUNCA pode impedir o fluxo normal do webhook
      // (mensagem já foi persistida acima) nem a resposta da IA em mensagens
      // normais -- em erro, skipAiForOptOut fica false e a IA segue o
      // comportamento de sempre. Só roda para whatsapp (a tabela de
      // supressão é phone-scoped; e-mail não tem "phone" pra suprimir).
      // Roda ANTES da checagem de supressão durável abaixo -- se esta
      // mensagem for um "voltar", o contato já deve estar reativado antes de
      // decidirmos se a IA dispara.
      // Telefone para a supressão (tabela phone-scoped). No ManyChat `from` é
      // subscriber_id: só vale o telefone real, quando veio.
      const optOutPhone = isManyChatSlug(providerSlug) ? (normalized.contactPhone ?? "") : normalized.from;
      let skipAiForOptOut = false;
      if (result.messageId && result.isContactInbound && ch.type === "whatsapp" && optOutPhone) {
        try {
          const outcome = await applyKeywordOptOutOptIn(
            admin,
            tenantId,
            result.contactId,
            optOutPhone,
            normalized.content,
          );
          skipAiForOptOut = outcome.suppressedNow;
        } catch (e) {
          // Antes: só console.error, que morre com o isolate — a supressão não
          // ficava gravada e ninguém ficava sabendo. Agora deixa rastro em
          // system_events (mesmo padrão do bloco gêmeo logo abaixo) e, se a
          // mensagem que falhou ERA um opt-out, pula a IA nesta mensagem.
          // A assimetria com o fail-open de isPhoneSuppressed abaixo é
          // deliberada: lá uma falha de leitura apagaria a IA de TODOS os
          // contatos; aqui sabemos que ESTE contato acabou de escrever "PARAR",
          // e o raio é uma mensagem só. Não fechar seria responder com IA
          // exatamente quem pediu para parar (LGPD).
          const errMsg = e instanceof Error ? e.message : String(e);
          skipAiForOptOut = matchesKeyword(normalized.content, OPT_OUT_KEYWORDS);
          console.error("keyword opt-out/opt-in check failed", {
            tenant: tenantId,
            err: errMsg,
          });
          await captureEdgeError(admin, {
            severity: "error",
            source: "edge",
            operation: "messaging-webhook.opt_out_por_palavra_chave",
            tenantId,
            message: errMsg,
            context: {
              mensagem_id: result.messageId,
              contact_id: result.contactId,
              // true = a supressão NÃO ficou durável; as próximas mensagens
              // deste contato voltam a receber IA até alguém reprocessar.
              supressao_nao_persistida: skipAiForOptOut,
            },
          });
        }
      }

      // Supressão durável: um telefone que já suprimiu (de uma mensagem de
      // opt-out ANTERIOR) não deve receber resposta automática da IA em
      // NENHUMA mensagem futura, não só na própria mensagem de opt-out --
      // diferente do skipAiForOptOut acima. Mesmo helper (`isPhoneSuppressed`)
      // já usado por nurture-runner/template-schedule-runner/weekly-digest-generator.
      // Só roda para whatsapp (tabela phone-scoped) e só quando ainda vale a
      // pena checar (não faz sentido consultar se a IA já não ia disparar).
      // Fail-open deliberado: os outros consumidores de isPhoneSuppressed são
      // cron/queue e podem adiar (retry) sem enviar quando a checagem falha;
      // aqui o disparo da IA é fire-and-forget sem retry, então a escolha é
      // binária no instante do webhook. Fail-closed aqui significaria um
      // apagão de IA em TODOS os contatos (suprimidos ou não) a cada soneca
      // da tabela de supressão; fail-open limita o vazamento à interseção
      // {suprimido E mensagem durante a falha}, que se autocorrige assim que
      // a tabela voltar -- e mantém consistência com o próprio
      // skipAiForOptOut acima, que já é fail-open.
      let alreadySuppressed = false;
      if (
        result.messageId &&
        result.isContactInbound &&
        ch.type === "whatsapp" &&
        optOutPhone &&
        !skipAiForOptOut
      ) {
        try {
          alreadySuppressed = await isPhoneSuppressed(admin, tenantId, optOutPhone);
        } catch (e) {
          // O fail-open acima é decisão consciente, mas até aqui a única
          // evidência dele era um console.error que morre com o isolate — e o
          // caso raro que ele deixa passar (responder quem pediu opt-out) é
          // risco de LGPD. Passa a gravar em system_events para que a escolha
          // seja revisitada com número na mão, não com impressão.
          const errMsg = e instanceof Error ? e.message : String(e);
          console.error("phone suppression check failed", { tenant: tenantId, err: errMsg });
          await captureEdgeError(admin, {
            severity: "error",
            source: "edge",
            operation: "messaging-webhook.checagem_opt_out",
            tenantId,
            message: errMsg,
            context: { fail_open: true, mensagem_id: result.messageId },
          });
        }
      }

      // O job é durável e entra antes de concluir o evento. Se o enqueue
      // falhar, o catch libera a lease e a reentrega recupera a mensagem.
      let aiJob: { jobId: string; shouldDispatch: boolean } | null = null;
      let durableQueueEnabled = false;
      if (result.messageId && result.isContactInbound && !skipAiForOptOut && !alreadySuppressed) {
        aiJob = await enqueueAIResponseJob(admin, tenantId, result.messageId);
        durableQueueEnabled = await isDurableAIQueueEnabled(admin, tenantId);
      }

      if (claim.eventId) await markWebhookEventProcessed(admin, claim.eventId);
      activeWebhookClaimId = null;

      // Dispatch imediato mantém a latência atual; o worker reexecuta jobs que
      // voltarem a pending por falha de rede, lock ou rate limit.
      // Nunca dispara para a própria mensagem de opt-out (skipAiForOptOut) nem
      // para um telefone já suprimido de mensagens anteriores (alreadySuppressed).
      if (result.messageId && aiJob?.shouldDispatch && !durableQueueEnabled) {
        await runInBackground(
          triggerAiRespond(
            admin,
            SUPABASE_URL,
            SERVICE_ROLE,
            tenantId,
            result.messageId,
            aiJob.jobId,
          ),
        );
      }
    }
  } catch (e) {
    // CRITICAL (code review): antes este catch logava e caía no `return 200 "ok"`
    // abaixo. O provider (Meta/Evolution/Z-API/Twilio) marcava como entregue e
    // NUNCA reentregava — a mensagem do cliente desaparecia, e como este arquivo
    // não usava captureEdgeError, o rastro morria no log do isolate.
    //
    // Agora: registra em system_events COM o corpo cru do webhook (mensagem perdida
    // vira reconstruível) e devolve 5xx com TETO de falhas consecutivas por canal.
    //
    // Por que não 200 sempre (comportamento anterior): o provider marcava como
    // entregue e nunca reentregava — a mensagem do cliente sumia.
    // Por que não 5xx sempre: reentrega é segura contra duplicata (o
    // `claimWebhookEvent` reserva via ON CONFLICT DO NOTHING), mas um bug
    // determinístico viraria uma sequência infinita de 5xx e Meta/Evolution
    // DESABILITAM a assinatura do webhook — derrubando o canal inteiro do tenant.
    //
    // Meio-termo: 5xx enquanto a falha parece transitória (contador < teto),
    // 200 + canal marcado 'broken' depois disso. Só conta quando há canal
    // resolvido — falha de resolução de canal (canal inativo/não encontrado) não
    // é transitória e nunca deve pedir retry.
    const errMessage = e instanceof Error ? e.message : String(e);
    console.error("messaging-webhook error", {
      slug: providerSlug,
      tenant: tenantId,
      err: errMessage,
    });

    if (activeWebhookClaimId) {
      const releaseError = await releaseWebhookEventClaim(admin, activeWebhookClaimId, errMessage);
      if (releaseError) {
        await captureEdgeError(admin, {
          severity: "error",
          source: "edge",
          operation: "messaging-webhook.release_claim",
          tenantId,
          message: releaseError,
          context: { event_id: activeWebhookClaimId, original_error: errMessage },
        });
      }
    }

    let consecutiveFailures = 0;
    if (ch?.id) {
      const { data: bumped, error: bumpError } = await admin.rpc("bump_channel_webhook_failure", {
        p_channel_id: ch.id,
      });
      if (bumpError) {
        console.error("bump_channel_webhook_failure failed", {
          channel: ch.id,
          err: bumpError.message,
        });
      } else {
        consecutiveFailures = Number(bumped ?? 0);
      }
    }
    const shouldAskRetry = ch?.id != null &&
      consecutiveFailures > 0 &&
      consecutiveFailures <= MAX_CONSECUTIVE_WEBHOOK_FAILURES;

    await captureEdgeError(admin, {
      severity: "error",
      source: "edge",
      operation: "messaging-webhook.inbound",
      tenantId,
      message: errMessage,
      stack: e instanceof Error ? (e.stack ?? null) : null,
      context: {
        provider_slug: providerSlug,
        // Corpo com segredos redigidos por chave e strings longas truncadas —
        // permite reprocessar a mensagem perdida sem levar credencial de provider
        // nem mídia base64 do titular para uma tabela legível por admin do tenant.
        // Conteúdo controlado pelo remetente: NUNCA renderizar como HTML.
        untrusted_body: safeBodyForTelemetry(
          rawBody,
          isManyChatSlug(providerSlug) ? MANYCHAT_TELEMETRY_REDACT_KEYS : undefined,
        ),
        consecutive_failures: consecutiveFailures,
        asked_retry: shouldAskRetry,
      },
    });
    // Sem .catch() aqui de propósito: captureEdgeError já é try/catch completo e
    // nunca rejeita (_shared/telemetry.ts). Um catch vazio só esconderia um throw
    // futuro introduzido lá dentro.

    if (shouldAskRetry) {
      return new Response("retry", { status: 503, headers: { "content-type": "text/plain" } });
    }
    // Teto estourado: para de pedir retry para não perder a assinatura do webhook,
    // e marca o canal como quebrado para a UI cobrar ação humana.
    if (ch?.id && consecutiveFailures > MAX_CONSECUTIVE_WEBHOOK_FAILURES) {
      // MEDIUM (code review rodada 3): se ESTA escrita falhar em silêncio, o teto
      // estoura, paramos de pedir retry e a UI nunca marca o canal como quebrado —
      // inbound morto sem ninguém ser cobrado a agir.
      const { error: healthError } = await admin
        .from("channels")
        .update({ webhook_health: "broken", webhook_health_checked_at: new Date().toISOString() })
        .eq("id", ch.id as string);
      if (healthError) {
        await captureEdgeError(admin, {
          severity: "error",
          source: "edge",
          operation: "messaging-webhook.marcar_canal_quebrado",
          tenantId,
          message: healthError.message,
          context: { provider_slug: providerSlug, channel_id: ch.id as string },
        });
      }
    }
  }

  return new Response("ok", { status: 200, headers: { "content-type": "text/plain" } });
});

function safeJson(s: string): Record<string, unknown> | null {
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch {
    return null;
  }
}

// Meta Cloud webhook signature (HMAC-SHA256 hex of raw body with app_secret).

async function verifyMetaSignature(
  appSecret: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  const prefix = "sha256=";
  if (!signatureHeader.startsWith(prefix)) return false;
  const provided = signatureHeader.slice(prefix.length).trim().toLowerCase();
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(appSecret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body));
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}

// Svix signature verification (HMAC-SHA256 over `id.timestamp.body`).
// Também valida a janela de svix-timestamp contra o relógio local (±5 min,
// recomendação oficial do Svix) — o HMAC cobre o timestamp, mas sem checar
// se ele está próximo do agora um atacante poderia replayar um webhook
// legítimo antigo cujo corpo ainda é uma assinatura válida.
async function verifySvix(
  signingSecret: string,
  svixId: string,
  svixTs: string,
  body: string,
  signatureHeader: string,
): Promise<boolean> {
  const tsSec = Number(svixTs);
  if (!Number.isFinite(tsSec) || tsSec <= 0) return false;
  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - tsSec) > SVIX_TIMESTAMP_TOLERANCE_SEC) return false;

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
  const expected = `v1,${b64}`;
  return signatureHeader.split(" ").some((s) => timingSafeEqualStrings(s.trim(), expected));
}
