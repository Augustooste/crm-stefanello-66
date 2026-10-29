import type { EvolutionInboundPayload } from "./evolution-client.ts";

export interface CanonicalInboundMessage {
  provider: string;
  external_id: string;
  from: string;
  to: string;
  content: string;
  timestamp: string;
  fromMe: boolean;
  senderName?: string;
  /**
   * `key`: mediaKey do WhatsApp nativo (decifra a URL `.enc`).
   * `base64`: arquivo já decifrado, embutido no webhook. Ambos vivem só dentro
   * da requisição — nunca vão para o banco.
   */
  media?: { url: string; type: string; key?: string; base64?: string };
  /**
   * Telefone/e-mail REAIS do contato quando o provider endereça por outra
   * identidade (ManyChat: `from` é o subscriber_id). Servem para casar contato
   * existente e para opt-out por telefone; nunca substituem `from`.
   */
  contactPhone?: string;
  contactEmail?: string;
}

export interface CanonicalDeliveryReceipt {
  provider: string;
  external_id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  error?: string;
}

export function normalizeDeliveryReceipt(
  provider: string,
  payload: Record<string, unknown>,
): CanonicalDeliveryReceipt | null {
  const source = (payload.delivery as Record<string, unknown> | undefined) ??
    payload;
  const external_id = String(
    source.external_id ?? source.message_id ?? source.id ?? "",
  );
  const rawStatus = String(source.status ?? source.state ?? "").toLowerCase();
  const statusMap: Record<string, CanonicalDeliveryReceipt["status"]> = {
    queued: "sent",
    sent: "sent",
    delivered: "delivered",
    read: "read",
    seen: "read",
    failed: "failed",
    error: "failed",
    undelivered: "failed",
  };
  const status = statusMap[rawStatus];
  if (!external_id || !status) return null;
  const rawTimestamp = String(source.timestamp ?? source.created_at ?? "");
  const parsed = Date.parse(rawTimestamp);
  return {
    provider,
    external_id,
    status,
    timestamp: new Date(Number.isFinite(parsed) ? parsed : Date.now())
      .toISOString(),
    error: status === "failed"
      ? String(source.error ?? source.reason ?? "Falha no provider")
      : undefined,
  };
}

export function normalizeWhatsAppAddress(value: unknown): string {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits ? `+${digits}` : "";
}

export function normalizeWhatsAppOutbound(
  destination: unknown,
  content: unknown,
): { destination: string; content: string } | null {
  const normalizedDestination = normalizeWhatsAppAddress(destination);
  if (!normalizedDestination) return null;
  return { destination: normalizedDestination, content: String(content ?? "") };
}

export function normalizeMetaCloudInbound(
  payload: Record<string, unknown>,
): CanonicalInboundMessage | null {
  const entry = (payload.entry as Array<Record<string, unknown>> | undefined)
    ?.[0];
  const change = (entry?.changes as Array<Record<string, unknown>> | undefined)
    ?.[0];
  const value = change?.value as Record<string, unknown> | undefined;
  const msg = (value?.messages as Array<Record<string, unknown>> | undefined)
    ?.[0];
  if (!value || !msg) return null;
  const external_id = String(msg.id ?? "");
  if (!external_id) return null;
  const metadata = value.metadata as
    | { display_phone_number?: string }
    | undefined;
  const contact = (value.contacts as Array<{ profile?: { name?: string } }> | undefined)?.[0];
  const tsSec = Number(msg.timestamp ?? 0);
  const type = String(msg.type ?? "");
  const typedPayload = msg[type] as
    | { id?: unknown; mime_type?: unknown; caption?: unknown }
    | undefined;
  const metaMediaId = String(typedPayload?.id ?? "").trim();
  const rawMime = String(typedPayload?.mime_type ?? "").trim().toLowerCase();
  const media = type === "audio" && metaMediaId
    ? {
      // Persiste o ID estável, não a URL efêmera de 5 minutos. ai-respond
      // resolve uma URL nova e baixa com Authorization antes da transcrição.
      url: `meta-media:${metaMediaId}`,
      type: rawMime.startsWith("audio/") ? rawMime : "audio/ogg",
    }
    : undefined;
  let content = "";
  if (type === "text") {
    content = String((msg.text as { body?: string } | undefined)?.body ?? "");
  } else if (type === "button") {
    content = String((msg.button as { text?: string } | undefined)?.text ?? "");
  } else if (type === "interactive") {
    const interactive = msg.interactive as {
      button_reply?: { title?: string };
      list_reply?: { title?: string };
    } | undefined;
    content = String(
      interactive?.button_reply?.title ?? interactive?.list_reply?.title ?? "",
    );
  }
  if (!content) {
    const caption = String(typedPayload?.caption ?? "");
    content = caption ||
      `[${type || "mensagem"} recebida — abra no WhatsApp para ver]`;
  }
  return {
    provider: "meta-cloud",
    external_id,
    from: normalizeWhatsAppAddress(msg.from),
    to: normalizeWhatsAppAddress(metadata?.display_phone_number),
    content,
    timestamp: new Date(
      Number.isFinite(tsSec) && tsSec > 0 ? tsSec * 1000 : Date.now(),
    ).toISOString(),
    fromMe: false,
    senderName: contact?.profile?.name ?? undefined,
    ...(media ? { media } : {}),
  };
}

/**
 * Chaves de protocolo do WhatsApp (recibo, reação, chave de criptografia,
 * edição...). NÃO são mensagem de ninguém: viram bolha fantasma
 * "[mensagem não suportada]" no inbox se forem persistidas.
 */
const WHATSAPP_PROTOCOL_KEYS = [
  "protocolMessage",
  "senderKeyDistributionMessage",
  "messageContextInfo",
  "reactionMessage",
  "pollUpdateMessage",
  "editedMessage",
  "receiptMessage",
];

/** Envelopes que só embrulham a mensagem real (ver-uma-vez, efêmera, etc.). */
const WHATSAPP_WRAPPER_KEYS = [
  "viewOnceMessage",
  "viewOnceMessageV2",
  "viewOnceMessageV2Extension",
  "ephemeralMessage",
  "documentWithCaptionMessage",
];

type LooseRecord = Record<string, unknown>;

/** Busca uma chave ignorando maiúsculas/minúsculas (Evolution Go varia). */
function pick(rec: LooseRecord, name: string): LooseRecord | undefined {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === target && v && typeof v === "object") {
      return v as LooseRecord;
    }
  }
  return undefined;
}

function pickString(rec: LooseRecord, name: string): string {
  const target = name.toLowerCase();
  for (const [k, v] of Object.entries(rec)) {
    if (k.toLowerCase() === target && typeof v === "string") return v;
  }
  return "";
}

function hasKey(rec: LooseRecord, names: string[]): boolean {
  const keys = Object.keys(rec).map((k) => k.toLowerCase());
  return names.some((n) => keys.includes(n.toLowerCase()));
}

/** Descasca envelopes até chegar na mensagem real (máx. 3 níveis). */
function unwrapWhatsAppMessage(message: LooseRecord): LooseRecord {
  let current = message;
  for (let i = 0; i < 3; i++) {
    const wrapper = WHATSAPP_WRAPPER_KEYS.map((k) => pick(current, k)).find(Boolean);
    if (!wrapper) break;
    const inner = pick(wrapper, "message") ?? wrapper;
    current = inner;
  }
  return current;
}

/**
 * Resumo estrutural (sem conteúdo, sem mediaKey, sem base64) de um payload que
 * não foi reconhecido. É o que permite fechar o caso sem tentativa e erro.
 */
export function describeEvolutionMessageShape(
  payload: EvolutionInboundPayload,
): Record<string, unknown> {
  const info = (payload.data?.Info ?? {}) as LooseRecord;
  const message = (payload.data?.Message ?? {}) as LooseRecord;
  return {
    info_type: String(info.Type ?? ""),
    info_media_type: String(info.MediaType ?? ""),
    from_me: Boolean(info.IsFromMe),
    message_keys: Object.keys(message).slice(0, 30),
    unwrapped_keys: Object.keys(unwrapWhatsAppMessage(message)).slice(0, 30),
  };
}

export function normalizeEvolutionInbound(
  payload: EvolutionInboundPayload,
): CanonicalInboundMessage | null {
  const info = payload.data?.Info;
  if (!info) return null;
  const external_id = String(info.ID ?? "");
  if (!external_id) return null;
  const fromMe = Boolean(info.IsFromMe);
  const contactPhone = normalizeWhatsAppAddress(
    String(info.Chat ?? "").split("@")[0] ?? "",
  );
  if (!contactPhone) return null;
  const tsMs = Date.parse(String(info.Timestamp ?? ""));

  const rawMessage = (payload.data?.Message ?? {}) as LooseRecord;
  if (hasKey(rawMessage, WHATSAPP_PROTOCOL_KEYS)) return null;
  const message = unwrapWhatsAppMessage(rawMessage);
  if (hasKey(message, WHATSAPP_PROTOCOL_KEYS)) return null;

  const extendedText = pick(message, "extendedTextMessage");
  let content = pickString(message, "conversation") ||
    (extendedText ? pickString(extendedText, "text") : "");

  // Mídia: com `WEBHOOK_FILES=true` (padrão do Evolution Go) o arquivo chega
  // embutido em base64; sem ele vem a URL `.enc` da CDN mais a `mediaKey`.
  // Os dois caminhos são tratados adiante, no webhook.
  const mediaKinds: Array<{ keys: string[]; label: string; fallbackMime: string }> = [
    { keys: ["audioMessage", "pttMessage"], label: "áudio", fallbackMime: "audio/ogg" },
    { keys: ["imageMessage"], label: "imagem", fallbackMime: "image/jpeg" },
    { keys: ["videoMessage"], label: "vídeo", fallbackMime: "video/mp4" },
    {
      keys: ["documentMessage"],
      label: "documento",
      fallbackMime: "application/octet-stream",
    },
  ];

  let media: CanonicalInboundMessage["media"] | undefined;
  let mediaLabel = "";
  for (const kind of mediaKinds) {
    const node = kind.keys.map((k) => pick(message, k)).find(Boolean);
    if (!node) continue;
    mediaLabel = kind.label;
    const mime = pickString(node, "mimetype").trim().toLowerCase();
    const type = mime ? (mime.split(";")[0] as string) : kind.fallbackMime;
    const inlineBase64 = pickString(node, "base64") || pickString(message, "base64") ||
      pickString(rawMessage, "base64");
    const url = pickString(node, "url");
    const mediaKey = pickString(node, "mediaKey");
    if (url || inlineBase64) {
      media = {
        url,
        type,
        ...(mediaKey ? { key: mediaKey } : {}),
        ...(inlineBase64 ? { base64: inlineBase64 } : {}),
      };
    }
    // Legenda existe em imagem/vídeo/documento; áudio nunca tem.
    content = content || pickString(node, "caption") || pickString(node, "fileName");
    break;
  }

  if (!content) {
    const kind = mediaLabel || String(info.MediaType ?? "").trim();
    if (fromMe && kind) {
      // Eco do que o próprio número enviou (inclusive o áudio de diagnóstico):
      // rótulo honesto em vez do genérico "não suportada".
      content = `[${kind} enviado]`;
    } else if (kind) {
      content = `[${kind} recebida — abra no WhatsApp para ver]`;
    } else {
      content = "[mensagem não suportada]";
    }
  }
  return {
    provider: "evolution",
    external_id,
    from: fromMe ? "" : contactPhone,
    to: fromMe ? contactPhone : "",
    content,
    timestamp: new Date(Number.isFinite(tsMs) ? tsMs : Date.now())
      .toISOString(),
    fromMe,
    senderName: info.PushName || undefined,
    ...(media ? { media } : {}),
  };
}


